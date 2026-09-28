const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveDataDirectory } = require('./pathConfig');
const { listAllRecords, deleteRecord, pbFilterEquals } = require('./pocketbase');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SERVICE_ACCOUNT_FILENAME = 'firebase-service-account.json';
const CLIENT_CONFIG_FILENAME = 'google-services.json';
const ANDROID_PACKAGE = 'org.agora.app';
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

let serviceAccountLoaded = false;
let cachedServiceAccount = null;
let clientConfigLoaded = false;
let cachedClientConfig = null;
let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;
let pendingAccessToken = null;

/**
 * Reads the Firebase service account from FCM_SERVICE_ACCOUNT_FILE, FCM_SERVICE_ACCOUNT_JSON
 * or <DATA_DIR>/firebase-service-account.json. Returns null if none is configured or it is invalid.
 */
function loadServiceAccount({ env = process.env, readFileSync = fs.readFileSync, existsSync = fs.existsSync } = {}) {
  let raw = null;
  let source = null;
  try {
    if (env.FCM_SERVICE_ACCOUNT_FILE) {
      source = env.FCM_SERVICE_ACCOUNT_FILE;
      raw = readFileSync(path.resolve(env.FCM_SERVICE_ACCOUNT_FILE), 'utf8');
    } else if (env.FCM_SERVICE_ACCOUNT_JSON) {
      source = 'FCM_SERVICE_ACCOUNT_JSON';
      raw = env.FCM_SERVICE_ACCOUNT_JSON;
    } else {
      const fallbackFile = path.join(resolveDataDirectory({ env }), SERVICE_ACCOUNT_FILENAME);
      if (!existsSync(fallbackFile)) return null;
      source = fallbackFile;
      raw = readFileSync(fallbackFile, 'utf8');
    }

    const account = JSON.parse(raw);
    if (!account?.project_id || !account?.client_email || !account?.private_key) {
      console.warn(`[FCM] Service account from ${source} is missing project_id, client_email or private_key`);
      return null;
    }
    return {
      projectId: String(account.project_id),
      clientEmail: String(account.client_email),
      // Tolerate keys whose newlines were escaped once more when pasted into an env variable
      privateKey: String(account.private_key).replace(/\\n/g, '\n'),
      tokenUri: account.token_uri || GOOGLE_TOKEN_URL
    };
  } catch (err) {
    console.warn(`[FCM] Failed to load service account from ${source}:`, err.message);
    return null;
  }
}

/**
 * Returns the configured service account (loaded once per process).
 */
function getServiceAccount() {
  if (!serviceAccountLoaded) {
    cachedServiceAccount = loadServiceAccount();
    serviceAccountLoaded = true;
    if (cachedServiceAccount) {
      console.log(`[FCM] Enabled for Firebase project ${cachedServiceAccount.projectId}`);
    }
  }
  return cachedServiceAccount;
}

/**
 * Reads the public Firebase client config of the Android app from FCM_GOOGLE_SERVICES_FILE,
 * FCM_GOOGLE_SERVICES_JSON or <DATA_DIR>/google-services.json (the file downloaded from the Firebase console).
 * The app initialises Firebase with it at runtime, so every Agora instance can use its own Firebase project.
 * Returns null if none is configured, it is invalid or it has no Android app with the package org.agora.app.
 */
function loadClientConfig({ env = process.env, readFileSync = fs.readFileSync, existsSync = fs.existsSync } = {}) {
  let raw = null;
  let source = null;
  try {
    if (env.FCM_GOOGLE_SERVICES_FILE) {
      source = env.FCM_GOOGLE_SERVICES_FILE;
      raw = readFileSync(path.resolve(env.FCM_GOOGLE_SERVICES_FILE), 'utf8');
    } else if (env.FCM_GOOGLE_SERVICES_JSON) {
      source = 'FCM_GOOGLE_SERVICES_JSON';
      raw = env.FCM_GOOGLE_SERVICES_JSON;
    } else {
      const fallbackFile = path.join(resolveDataDirectory({ env }), CLIENT_CONFIG_FILENAME);
      if (!existsSync(fallbackFile)) return null;
      source = fallbackFile;
      raw = readFileSync(fallbackFile, 'utf8');
    }

    const file = JSON.parse(raw);
    const client = (Array.isArray(file?.client) ? file.client : [])
      .find(c => c?.client_info?.android_client_info?.package_name === ANDROID_PACKAGE);
    const config = {
      projectId: file?.project_info?.project_id,
      senderId: file?.project_info?.project_number,
      appId: client?.client_info?.mobilesdk_app_id,
      apiKey: client?.api_key?.[0]?.current_key
    };
    if (!config.projectId || !config.senderId || !config.appId || !config.apiKey) {
      console.warn(`[FCM] ${source} has no complete Android app entry for ${ANDROID_PACKAGE}`);
      return null;
    }
    if (file.project_info.storage_bucket) config.storageBucket = file.project_info.storage_bucket;
    return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, String(value)]));
  } catch (err) {
    console.warn(`[FCM] Failed to load Firebase client config from ${source}:`, err.message);
    return null;
  }
}

/**
 * Returns the Firebase client config for the Android app (loaded once per process).
 */
function getClientConfig() {
  if (!clientConfigLoaded) {
    cachedClientConfig = loadClientConfig();
    clientConfigLoaded = true;
    const account = getServiceAccount();
    if (cachedClientConfig && account && cachedClientConfig.projectId !== account.projectId) {
      console.warn(`[FCM] google-services.json (${cachedClientConfig.projectId}) and service account (${account.projectId}) belong to different Firebase projects`);
    }
  }
  return cachedClientConfig;
}

/**
 * FCM is usable when the server can send (service account) and the app can register (client config).
 */
function isFcmEnabled() {
  return Boolean(getServiceAccount() && getClientConfig());
}

/**
 * Builds the RS256-signed JWT assertion for the Google OAuth2 JWT bearer flow.
 */
function buildServiceAccountJwt(serviceAccount, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: serviceAccount.clientEmail,
    scope: FCM_SCOPE,
    aud: serviceAccount.tokenUri || GOOGLE_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  };
  const unsigned = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.privateKey, 'base64url');
  return `${unsigned}.${signature}`;
}

/**
 * Exchanges the signed JWT for an OAuth2 access token. The token is cached until shortly before it expires.
 */
async function getAccessToken(serviceAccount = getServiceAccount()) {
  if (!serviceAccount) throw new Error('FCM is not configured');
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry) {
    return cachedAccessToken;
  }
  if (pendingAccessToken) return pendingAccessToken;

  pendingAccessToken = (async () => {
    const response = await fetch(serviceAccount.tokenUri || GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: buildServiceAccountJwt(serviceAccount)
      }).toString()
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.access_token) {
      throw new Error(`Google token request failed (${response.status}): ${result.error_description || result.error || 'unknown error'}`);
    }
    const expiresInMs = (Number(result.expires_in) || 3600) * 1000;
    cachedAccessToken = result.access_token;
    cachedAccessTokenExpiry = Date.now() + Math.max(expiresInMs - ACCESS_TOKEN_REFRESH_MARGIN_MS, 0);
    return cachedAccessToken;
  })();

  try {
    return await pendingAccessToken;
  } finally {
    pendingAccessToken = null;
  }
}

/**
 * Builds a data-only FCM v1 message so the Android app renders the notification itself.
 * Uses the same fields as the Web Push payload ({ title, body, tag, data: { url, eventId } }).
 */
function buildFcmMessage(token, payload = {}) {
  const fields = {
    title: payload.title,
    body: payload.body,
    url: payload.data?.url,
    tag: payload.tag,
    eventId: payload.data?.eventId
  };
  const data = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') {
      data[key] = String(value);
    }
  }
  return {
    message: {
      token,
      data,
      android: { priority: 'HIGH', ttl: '86400s' }
    }
  };
}

/**
 * True if the FCM error means the registration token is dead and should be removed.
 */
function isStaleTokenError(statusCode, error = {}) {
  const details = Array.isArray(error.details) ? error.details : [];
  const errorCodes = details.map(d => d?.errorCode).filter(Boolean);
  if (statusCode === 404 || errorCodes.includes('UNREGISTERED')) return true;

  const isInvalidArgument = error.status === 'INVALID_ARGUMENT' || errorCodes.includes('INVALID_ARGUMENT');
  if (!isInvalidArgument) return false;
  const tokenFieldViolation = details.some(d => Array.isArray(d?.fieldViolations)
    && d.fieldViolations.some(v => String(v?.field || '').includes('token')));
  return tokenFieldViolation || /registration token|message\.token/i.test(String(error.message || ''));
}

/**
 * Sends a data-only message to a single FCM token record.
 * Automatically deletes tokens that FCM reports as unregistered or invalid.
 */
async function sendFcmToToken(tokenRecord, payload, appConfig) {
  const serviceAccount = getServiceAccount();
  if (!serviceAccount) return { error: 'FCM is not configured' };
  try {
    const accessToken = await getAccessToken(serviceAccount);
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(serviceAccount.projectId)}/messages:send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildFcmMessage(tokenRecord.token, payload))
    });
    if (response.ok) return { success: true };

    const result = await response.json().catch(() => ({}));
    const error = result.error || {};
    if (response.status === 401) {
      // Access token was rejected; fetch a fresh one on the next send
      cachedAccessToken = null;
      cachedAccessTokenExpiry = 0;
    }
    if (isStaleTokenError(response.status, error)) {
      console.log(`[FCM] Token no longer valid (${response.status} ${error.status || ''}), deleting:`, tokenRecord.id);
      try {
        await deleteRecord('fcm_tokens', tokenRecord.id, appConfig);
      } catch (delErr) {
        console.warn('[FCM] Failed to delete invalid token:', delErr.message);
      }
      return { error: error.message || 'Invalid token', statusCode: response.status, deleted: true };
    }
    console.warn(`[FCM] Error sending message (${response.status}):`, error.message || 'unknown error');
    return { error: error.message || 'FCM request failed', statusCode: response.status };
  } catch (err) {
    console.warn('[FCM] Error sending message:', err.message);
    return { error: err.message };
  }
}

/**
 * Sends a data-only message to all registered Android devices of a given user.
 */
async function sendFcmToUser(appConfig, userId, payload) {
  if (!appConfig || !userId || !isFcmEnabled()) return;
  try {
    const tokens = await listAllRecords('fcm_tokens', pbFilterEquals('user', userId), appConfig);
    if (!tokens || !tokens.length) return;
    await Promise.all(tokens.map(record => sendFcmToToken(record, payload, appConfig)));
  } catch (err) {
    console.warn(`[FCM] Failed to send message to user ${userId}:`, err.message);
  }
}

/**
 * Drops the cached service account and access token (used by tests and after credential changes).
 */
function resetFcmState() {
  serviceAccountLoaded = false;
  cachedServiceAccount = null;
  clientConfigLoaded = false;
  cachedClientConfig = null;
  cachedAccessToken = null;
  cachedAccessTokenExpiry = 0;
  pendingAccessToken = null;
}

module.exports = {
  loadServiceAccount,
  loadClientConfig,
  getClientConfig,
  isFcmEnabled,
  buildServiceAccountJwt,
  getAccessToken,
  buildFcmMessage,
  isStaleTokenError,
  sendFcmToToken,
  sendFcmToUser,
  resetFcmState
};
