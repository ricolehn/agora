// The connection to PocketBase: requests as the server's superuser, a read cache, and the record helpers every store
// uses. The apps never talk to PocketBase themselves; everything goes through these functions.
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolvePocketBaseDirectory } = require('../pathConfig');

const execFileAsync = promisify(execFile);

const SUPERUSER_TOKEN_TTL_MS = 300_000; // 5 minutes
let cachedSuperuserToken = null;
let cachedSuperuserTokenExpiry = 0;

function getPocketBaseBaseUrl() {
  return process.env.POCKETBASE_BASE_URL || `http://127.0.0.1:${process.env.POCKETBASE_PORT || '8090'}`;
}

function getPocketBaseBinaryPath() {
  return process.env.POCKETBASE_BIN || path.join(__dirname, '..', '..', 'pocketbase');
}

function getPocketBaseDataDir() {
  return resolvePocketBaseDirectory();
}


function buildPocketBaseError(response, fallback) {
  const details = response?.data && typeof response.data === 'object'
    ? Object.values(response.data)
        .map((entry) => entry?.message)
        .find((message) => typeof message === 'string' && message.trim())
    : null;
  const error = new Error(details || response?.message || fallback || 'PocketBase request failed');
  error.status = response?.status || 500;
  error.response = response || null;
  return error;
}

// --- Read cache ---
// The apps only reach PocketBase through this server, and every request goes through pocketBaseRequest: record
// reads (as superuser) are kept in memory per collection and dropped the moment anything in that collection is
// written. Each collection has a generation: a read that started before a write is not kept. READ_CACHE_TTL_MS
// covers changes made outside the app (PocketBase's admin page). The answer is kept as PocketBase's JSON text and
// parsed for every caller: each gets its own objects (three times faster than copying them).
const READ_CACHE_TTL_MS = 30 * 1000;
const READ_CACHE_MAX_ENTRIES = 400;
const readCache = new Map();
const readGenerations = new Map();
const recordsPath = /^\/api\/collections\/([^/?]+)\/records(?:[/?]|$)/;

function collectionOf(path) {
  return recordsPath.exec(path)?.[1] || null;
}

// Counts every write the server makes (and every forgetting of the cache): results worked out from the data are valid
// as long as it has not changed
let writes = 0;
const writeGeneration = () => writes;

/** Forgets the cached reads of [collection] (all collections without one). */
function invalidateReadCache(collection) {
  writes += 1;
  if (!collection) {
    readCache.clear();
    for (const key of readGenerations.keys()) readGenerations.set(key, (readGenerations.get(key) || 0) + 1);
    return;
  }
  readCache.delete(collection);
  readGenerations.set(collection, (readGenerations.get(collection) || 0) + 1);
}

const parseCached = (text) => (text === null ? null : JSON.parse(text));

async function cachedRead(collection, key, load) {
  let entries = readCache.get(collection);
  const hit = entries?.get(key);
  if (hit && Date.now() - hit.at < READ_CACHE_TTL_MS) return parseCached(await hit.value);
  const generation = readGenerations.get(collection) || 0;
  const value = load();
  if (!entries) readCache.set(collection, (entries = new Map()));
  if (entries.size >= READ_CACHE_MAX_ENTRIES) entries.clear();
  const entry = { at: Date.now(), value };
  entries.set(key, entry);
  try {
    const result = await value;
    // Written meanwhile (or failed): not kept
    if ((readGenerations.get(collection) || 0) !== generation && readCache.get(collection)?.get(key) === entry) readCache.get(collection).delete(key);
    return parseCached(result);
  } catch (err) {
    if (readCache.get(collection)?.get(key) === entry) readCache.get(collection).delete(key);
    throw err;
  }
}

async function pocketBaseRequest(path, options = {}) {
  const method = options.method || 'GET';
  const collection = collectionOf(path);
  if (method === 'GET' && collection && options.token && options.token === cachedSuperuserToken) {
    return cachedRead(collection, `${path}|${options.allow404 ? 1 : 0}`, () => sendPocketBaseRequest(path, { ...options, rawText: true }));
  }
  if (method !== 'GET') {
    // Records of one collection (also its auth actions: a login only touches "users"); schema changes and batches
    // touch everything, and so does a delete: what links to the record is deleted with it or loses the link (an
    // event takes its sign-ups, guests and duties along). Before and after: a read running alongside the write is
    // not kept either way
    const own = /^\/api\/collections\/([^/?]+)\/[^/?]/.exec(path)?.[1];
    const touched = method === 'DELETE' ? undefined
      : collection || own || (path.startsWith('/api/collections') || path.startsWith('/api/batch') ? undefined : null);
    if (touched !== null) invalidateReadCache(touched);
    try {
      return await sendPocketBaseRequest(path, options);
    } finally {
      if (touched !== null) invalidateReadCache(touched);
    }
  }
  return sendPocketBaseRequest(path, options);
}

async function sendPocketBaseRequest(path, options = {}) {
  const {
    method = 'GET',
    token,
    body,
    allow404 = false,
    headers = {}
  } = options;

  const requestHeaders = { ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined && !requestHeaders['Content-Type']) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${getPocketBaseBaseUrl()}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  // The read cache keeps the text itself (see cachedRead)
  if (options.rawText && response.ok) return text || 'null';
  if (options.rawText && allow404 && response.status === 404) return null;
  const payload = text ? (() => {
    try {
      return JSON.parse(text);
    } catch {
      return { message: text, status: response.status };
    }
  })() : null;

  if (!response.ok) {
    if (allow404 && response.status === 404) return null;
    throw buildPocketBaseError(payload, `PocketBase ${method} ${path} failed`);
  }

  return payload;
}

async function authenticateSuperuser(appConfig) {
  if (!appConfig?.pocketbase?.adminEmail || !appConfig?.pocketbase?.adminPassword) {
    throw new Error('PocketBase superuser credentials are missing.');
  }

  const now = Date.now();
  if (cachedSuperuserToken && now < cachedSuperuserTokenExpiry) {
    return cachedSuperuserToken;
  }

  const auth = await pocketBaseRequest('/api/collections/_superusers/auth-with-password', {
    method: 'POST',
    body: {
      identity: appConfig.pocketbase.adminEmail,
      password: appConfig.pocketbase.adminPassword
    }
  });

  cachedSuperuserToken = auth.token;
  cachedSuperuserTokenExpiry = now + SUPERUSER_TOKEN_TTL_MS;
  return auth.token;
}

function clearSuperuserTokenCache() {
  cachedSuperuserToken = null;
  cachedSuperuserTokenExpiry = 0;
}

async function ensurePocketBaseSuperuser(appConfig) {
  if (!appConfig?.pocketbase?.adminEmail || !appConfig?.pocketbase?.adminPassword) {
    throw new Error('PocketBase superuser credentials are missing.');
  }

  const binary = getPocketBaseBinaryPath();
  const dir = getPocketBaseDataDir();
  const args = [
    '--dir',
    dir,
    'superuser',
    'upsert',
    '--', // e-mail and password are values even when they start with "-"
    appConfig.pocketbase.adminEmail,
    appConfig.pocketbase.adminPassword
  ];

  console.log(`[PocketBase] Running superuser upsert with binary: ${binary}, dir: ${dir}, email: ${appConfig.pocketbase.adminEmail}`);
  try {
    const { stdout, stderr } = await execFileAsync(binary, args);
    console.log(`[PocketBase] Superuser upsert stdout: ${stdout.trim()}`);
    if (stderr.trim()) {
      console.warn(`[PocketBase] Superuser upsert stderr: ${stderr.trim()}`);
    }
  } catch (error) {
    console.error(`[PocketBase] Superuser upsert failed! Error:`, error);
    throw error;
  }
}


async function listAllRecords(collectionName, filter, appConfig, sort = '', { fields = '' } = {}) {
  const token = await authenticateSuperuser(appConfig);
  // PocketBase's largest page. The first page counts the records (one COUNT), the others come in parallel
  // without counting - they used to be 200 at a time, one after another, each with its own COUNT
  const perPage = 1000;
  const pageUrl = (page, count) => {
    const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
    if (!count) params.set('skipTotal', '1');
    if (filter) params.set('filter', filter);
    if (fields) params.set('fields', fields);
    // Pages fetched side by side need a fixed order: without a sort it is PocketBase's own (insertion) order, named
    params.set('sort', sort || '@rowid');
    return `/api/collections/${collectionName}/records?${params.toString()}`;
  };
  const first = await pocketBaseRequest(pageUrl(1, true), { token });
  const items = [...(first.items || [])];
  const pages = Number(first.totalPages) || 1;
  if (pages > 1) {
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => pocketBaseRequest(pageUrl(i + 2, false), { token })));
    for (const result of rest) items.push(...(result.items || []));
  }
  return items;
}

function pbFilterEquals(field, value) {
  return `${field} = ${JSON.stringify(String(value))}`;
}

async function getFirstRecord(collectionName, filter, appConfig, sort = '') {
  const token = await authenticateSuperuser(appConfig);
  const params = new URLSearchParams({ page: '1', perPage: '1', skipTotal: '1', filter });
  if (sort) params.set('sort', sort);
  const result = await pocketBaseRequest(`/api/collections/${collectionName}/records?${params.toString()}`, { token });
  return result.items?.[0] || null;
}

// --- Values of json fields ---
// PocketBase reads a string written to a json field as JSON when it is JSON: "1771345242762" comes back as the number
// 1771345242762, "true" as true, "[1]" as a list. The web app gives standing orders ids like "1771345242762": they came
// back from the new tables as numbers, and the upgrade's comparison failed on every member with a standing order. In
// the tables of the new structure a string therefore goes to PocketBase as its JSON text, which PocketBase reads back
// as exactly that string. (users keeps PocketBase's reading: it is the old table, shared with the previous backend.)
let jsonFields = null;

/** The json fields of the table stored as [collection] (also under the name an upgrade builds it under). */
function jsonFieldsOf(collection) {
  if (!jsonFields) {
    const { allCollections } = require('./schema');
    const { buildingName } = require('./schemaApply');
    jsonFields = new Map();
    for (const spec of allCollections()) {
      const names = (spec.fields || []).filter((field) => field.type === 'json').map((field) => field.name);
      if (names.length) for (const stored of [spec.name, buildingName(spec.name)]) jsonFields.set(stored, names);
    }
  }
  return jsonFields.get(collection) || [];
}

/** [body] of a record of [collection] as PocketBase has to get it: a string in a json field as its JSON text. */
function forPocketBase(collection, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body instanceof FormData) return body;
  let sent = body;
  for (const field of jsonFieldsOf(collection)) {
    if (typeof body[field] !== 'string') continue;
    if (sent === body) sent = { ...body };
    sent[field] = JSON.stringify(body[field]);
  }
  return sent;
}

async function createRecord(collectionName, body, appConfig) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${collectionName}/records`, {
    method: 'POST',
    token,
    body: forPocketBase(collectionName, body)
  });
}

async function updateRecord(collectionName, recordId, body, appConfig) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${collectionName}/records/${encodeURIComponent(recordId)}`, {
    method: 'PATCH',
    token,
    body: forPocketBase(collectionName, body)
  });
}

async function deleteRecord(collectionName, recordId, appConfig) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${collectionName}/records/${encodeURIComponent(recordId)}`, {
    method: 'DELETE',
    token
  });
}

/** The record [id] of [collectionName], or null. */
async function getRecord(collectionName, id, appConfig) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${collectionName}/records/${encodeURIComponent(id)}`, { token, allow404: true });
}

/** A new PocketBase record id (15 lowercase letters and digits), made here so records of one batch can link each other. */
function newRecordId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(15), (byte) => alphabet[byte % alphabet.length]).join('');
}

/** A filter that matches any of [values] for [field] (false for none: nothing matches). */
function pbFilterIn(field, values) {
  const list = [...new Set((values || []).map(String))];
  return list.length ? `(${list.map((value) => pbFilterEquals(field, value)).join(' || ')})` : 'id = "" && id != ""';
}

// --- Batches: several writes as one transaction (all or nothing) ---
// PocketBase runs a batch in one database transaction: when one request fails, none of them is kept. The setting is
// off by default; ensureBatchSettings switches it on (with room for a member's whole history in one batch).
// One member's save (payments, status periods, standing orders and their change log rows) must be one transaction:
// even importing hundreds of payments at once stays far below this
const BATCH_MAX_REQUESTS = 5000;

async function ensureBatchSettings(appConfig) {
  const token = await authenticateSuperuser(appConfig);
  const settings = await pocketBaseRequest('/api/settings', { token });
  const batch = settings?.batch || {};
  if (batch.enabled === true && Number(batch.maxRequests) >= BATCH_MAX_REQUESTS && Number(batch.timeout) >= 30) return;
  await pocketBaseRequest('/api/settings', {
    method: 'PATCH',
    token,
    body: { batch: { ...batch, enabled: true, maxRequests: BATCH_MAX_REQUESTS, timeout: 30, maxBodySize: batch.maxBodySize || 0 } }
  });
}

/**
 * Runs [requests] ({ method, collection, id?, body? }) as one transaction and returns PocketBase's results (one per
 * request, in order). More than BATCH_MAX_REQUESTS are refused: a caller that writes that much splits it on purpose.
 */
async function batchWrite(appConfig, requests) {
  if (!requests.length) return [];
  if (requests.length > BATCH_MAX_REQUESTS) throw new Error(`A batch holds at most ${BATCH_MAX_REQUESTS} requests (${requests.length} given).`);
  const token = await authenticateSuperuser(appConfig);
  const body = {
    requests: requests.map(({ method, collection, id, body: recordBody }) => ({
      method,
      url: `/api/collections/${collection}/records${id ? `/${encodeURIComponent(id)}` : ''}`,
      ...(recordBody !== undefined ? { body: forPocketBase(collection, recordBody) } : {})
    }))
  };
  let results;
  try {
    results = await pocketBaseRequest('/api/batch', { method: 'POST', token, body });
  } catch (error) {
    // PocketBase names the request that failed and why (by its place in the batch)
    const failed = error.response?.data?.requests || {};
    const first = Object.entries(failed)[0];
    if (first) {
      const [index, detail] = first;
      const request = requests[Number(index)] || {};
      error.message = `${error.message} Request ${index} (${request.method} ${request.collection}${request.id ? `/${request.id}` : ''}): ${detail?.response?.message || detail?.message || ''} ${JSON.stringify(detail?.response?.data || detail?.data || {}).slice(0, 500)}`;
    }
    throw error;
  }
  return (Array.isArray(results) ? results : []).map((result) => result?.body ?? null);
}

// --- Collections, settings and backups (the schema and the upgrade) ---

async function getCollection(appConfig, nameOrId) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${encodeURIComponent(nameOrId)}`, { token, allow404: true });
}

async function listCollections(appConfig) {
  const token = await authenticateSuperuser(appConfig);
  const items = [];
  for (let page = 1; ; page += 1) {
    const result = await pocketBaseRequest(`/api/collections?page=${page}&perPage=200&sort=name`, { token });
    items.push(...(result.items || []));
    if (page >= (Number(result.totalPages) || 1)) break;
  }
  return items;
}

async function createCollection(appConfig, body) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest('/api/collections', { method: 'POST', token, body });
}

async function updateCollection(appConfig, nameOrId, body) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${encodeURIComponent(nameOrId)}`, { method: 'PATCH', token, body });
}

async function deleteCollection(appConfig, nameOrId) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${encodeURIComponent(nameOrId)}`, { method: 'DELETE', token, allow404: true });
}

/** Counts the records of [collectionName] that match [filter] (one COUNT, no records). */
async function countRecords(collectionName, filter, appConfig) {
  const token = await authenticateSuperuser(appConfig);
  const params = new URLSearchParams({ page: '1', perPage: '1', fields: 'id' });
  if (filter) params.set('filter', filter);
  const result = await pocketBaseRequest(`/api/collections/${collectionName}/records?${params.toString()}`, { token });
  return Number(result.totalItems) || 0;
}

/** Makes a full backup (PocketBase's zip of the data folder, kept in <data folder>/backups) named [name]. */
async function createBackup(appConfig, name) {
  const token = await authenticateSuperuser(appConfig);
  await pocketBaseRequest('/api/backups', { method: 'POST', token, body: { name } });
}

async function listBackups(appConfig) {
  const token = await authenticateSuperuser(appConfig);
  return (await pocketBaseRequest('/api/backups', { token })) || [];
}

async function deleteBackup(appConfig, key) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/backups/${encodeURIComponent(key)}`, { method: 'DELETE', token, allow404: true });
}

module.exports = {
  getPocketBaseBaseUrl,
  getPocketBaseBinaryPath,
  getPocketBaseDataDir,
  buildPocketBaseError,
  invalidateReadCache,
  writeGeneration,
  pocketBaseRequest,
  authenticateSuperuser,
  clearSuperuserTokenCache,
  ensurePocketBaseSuperuser,
  listAllRecords,
  pbFilterEquals,
  pbFilterIn,
  getFirstRecord,
  getRecord,
  newRecordId,
  createRecord,
  updateRecord,
  deleteRecord,
  countRecords,
  ensureBatchSettings,
  batchWrite,
  BATCH_MAX_REQUESTS,
  getCollection,
  listCollections,
  createCollection,
  updateCollection,
  deleteCollection,
  createBackup,
  listBackups,
  deleteBackup
};
