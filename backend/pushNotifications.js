const webpush = require('web-push');
const { getStateValue, upsertStateValue, listAllRecords, createRecord, deleteRecord } = require('./pocketbase');

let vapidConfigured = false;
let currentVapidKeys = null;

/**
 * Initializes or retrieves existing VAPID keys for Web Push.
 * If none exist in app_state, a new cryptographic pair is generated and persisted.
 */
async function getOrInitVapidKeys(appConfig) {
  if (currentVapidKeys && vapidConfigured) {
    return currentVapidKeys;
  }

  // Load from persisted state if available
  const existing = appConfig?._mockGetState
    ? await appConfig._mockGetState('vapid_keys')
    : await getStateValue(appConfig, 'vapid_keys', null);

  if (existing?.publicKey && existing?.privateKey) {
    currentVapidKeys = existing;
  } else {
    // Generate fresh VAPID keypair
    const generated = webpush.generateVAPIDKeys();
    currentVapidKeys = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      subject: `mailto:${appConfig?.smtp?.user || 'admin@agora.local'}`
    };
    if (appConfig?._mockUpsertState) {
      await appConfig._mockUpsertState('vapid_keys', currentVapidKeys);
    } else {
      await upsertStateValue(appConfig, 'vapid_keys', currentVapidKeys);
    }
    console.log('[WebPush] Generated and persisted new VAPID keypair');
  }

  const subject = currentVapidKeys.subject || `mailto:${appConfig?.smtp?.user || 'admin@agora.local'}`;
  webpush.setVapidDetails(subject, currentVapidKeys.publicKey, currentVapidKeys.privateKey);
  vapidConfigured = true;
  return currentVapidKeys;
}

/**
 * Returns the public VAPID key as a base64 string for frontend subscription.
 */
async function getVapidPublicKey(appConfig) {
  const keys = await getOrInitVapidKeys(appConfig);
  return keys.publicKey;
}

/**
 * Sends a push notification to a single subscription record.
 * Automatically cleans up expired/gone (HTTP 404 / 410) subscriptions.
 */
async function sendPushToSubscription(subscriptionRecord, payload, appConfig) {
  try {
    const pushSub = {
      endpoint: subscriptionRecord.endpoint,
      keys: {
        p256dh: subscriptionRecord.p256dh,
        auth: subscriptionRecord.auth
      }
    };
    await webpush.sendNotification(pushSub, JSON.stringify(payload));
    return { success: true };
  } catch (err) {
    // 404 Not Found or 410 Gone: The subscription has expired or was unsubscribed on device
    if (err.statusCode === 404 || err.statusCode === 410) {
      console.log(`[WebPush] Subscription expired (${err.statusCode}), deleting:`, subscriptionRecord.id);
      try {
        await deleteRecord('push_subscriptions', subscriptionRecord.id, appConfig);
      } catch (delErr) {
        console.warn('[WebPush] Failed to delete expired subscription:', delErr.message);
      }
    } else {
      console.warn('[WebPush] Error sending push notification:', err.message);
    }
    return { error: err.message, statusCode: err.statusCode };
  }
}

/**
 * Sends a push notification to all active devices of a given user.
 */
async function sendPushToUser(appConfig, userId, payload) {
  if (!appConfig || !userId) return;
  try {
    await getOrInitVapidKeys(appConfig);
    const subs = await listAllRecords('push_subscriptions', `user = "${userId}"`, appConfig);
    if (!subs || !subs.length) return;

    const fullPayload = {
      title: payload.title || (appConfig.appName || 'Agora'),
      body: payload.body || '',
      icon: payload.icon || './assets/icon-notification.png',
      badge: payload.badge || './assets/badge-monochrome.png',
      data: payload.data || {},
      tag: payload.tag || 'agora-notification'
    };

    await Promise.all(subs.map(sub => sendPushToSubscription(sub, fullPayload, appConfig)));
  } catch (err) {
    console.warn(`[WebPush] Failed to send push to user ${userId}:`, err.message);
  }
}

/**
 * Sends a push notification to multiple user IDs.
 */
async function sendPushToUsers(appConfig, userIds, payload) {
  if (!Array.isArray(userIds) || !userIds.length) return;
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  await Promise.all(uniqueIds.map(uid => sendPushToUser(appConfig, uid, payload)));
}

/**
 * Sends a push notification to all admins who have notifications enabled.
 */
async function sendPushToAdmins(appConfig, payload) {
  if (!appConfig) return;
  try {
    const { listUserRecords } = require('./pocketbase');
    const allUsers = await listUserRecords(appConfig);
    const adminUserIds = allUsers
      .filter(u => u.admin === true && u.emailNotifications !== false)
      .map(u => u.id);
    await sendPushToUsers(appConfig, adminUserIds, payload);
  } catch (err) {
    console.warn('[WebPush] Failed to send push to admins:', err.message);
  }
}

module.exports = {
  getOrInitVapidKeys,
  getVapidPublicKey,
  sendPushToSubscription,
  sendPushToUser,
  sendPushToUsers,
  sendPushToAdmins
};
