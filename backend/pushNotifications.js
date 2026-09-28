const webpush = require('web-push');
const { getStateValue, upsertStateValue, listAllRecords, deleteRecord } = require('./pocketbase');
const { sendFcmToUser } = require('./fcmNotifications');

let vapidConfigured = false;
let currentVapidKeys = null;

/**
 * Dynamically resolves a valid VAPID subject email for Web Push.
 * Apple APNs requires a valid, publicly reachable mailto: or https: URL as VAPID subject.
 * Prefers the owner's email address, then SMTP user email, falling back to admin or valid domain default.
 */
async function resolveVapidSubject(appConfig) {
  try {
    const { listUserRecords, isPlaceholderEmail } = require('./pocketbase');
    if (appConfig) {
      const allUsers = await listUserRecords(appConfig).catch(() => []);
      const ownerUser = allUsers.find(u => (u.owner === true || u.superAdmin === true) && u.email && !isPlaceholderEmail(u.email));
      if (ownerUser && ownerUser.email && ownerUser.email.includes('@')) {
        const email = ownerUser.email.trim();
        if (!email.endsWith('.local') && !email.endsWith('.internal')) {
          return `mailto:${email}`;
        }
      }

      const smtpUser = appConfig.smtp?.user;
      if (smtpUser && typeof smtpUser === 'string' && smtpUser.includes('@') && !smtpUser.endsWith('.local')) {
        return `mailto:${smtpUser.trim()}`;
      }

      const adminUser = allUsers.find(u => (u.admin === true) && u.email && !isPlaceholderEmail(u.email));
      if (adminUser && adminUser.email && adminUser.email.includes('@') && !adminUser.email.endsWith('.local')) {
        return `mailto:${adminUser.email.trim()}`;
      }

      if (ownerUser?.email) {
        return `mailto:${ownerUser.email.trim()}`;
      }
      if (smtpUser) {
        return `mailto:${smtpUser.trim()}`;
      }
    }
  } catch (err) {
    console.warn('[WebPush] Error resolving VAPID subject:', err.message);
  }
  return 'mailto:admin@agora.app';
}

/**
 * Initializes or retrieves existing VAPID keys for Web Push.
 * If none exist in app_state, a new cryptographic pair is generated and persisted.
 */
async function getOrInitVapidKeys(appConfig) {
  const resolvedSubject = await resolveVapidSubject(appConfig);

  if (currentVapidKeys && vapidConfigured) {
    if (currentVapidKeys.subject !== resolvedSubject) {
      currentVapidKeys.subject = resolvedSubject;
      webpush.setVapidDetails(resolvedSubject, currentVapidKeys.publicKey, currentVapidKeys.privateKey);
      if (appConfig?._mockUpsertState) {
        await appConfig._mockUpsertState('vapid_keys', currentVapidKeys);
      } else {
        await upsertStateValue(appConfig, 'vapid_keys', currentVapidKeys).catch(() => {});
      }
    }
    return currentVapidKeys;
  }

  // Load from persisted state if available
  const existing = appConfig?._mockGetState
    ? await appConfig._mockGetState('vapid_keys')
    : await getStateValue(appConfig, 'vapid_keys', null);

  if (existing?.publicKey && existing?.privateKey) {
    currentVapidKeys = {
      ...existing,
      subject: resolvedSubject
    };
  } else {
    // Generate fresh VAPID keypair
    const generated = webpush.generateVAPIDKeys();
    currentVapidKeys = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      subject: resolvedSubject
    };
    console.log('[WebPush] Generated and persisted new VAPID keypair');
  }

  if (appConfig?._mockUpsertState) {
    await appConfig._mockUpsertState('vapid_keys', currentVapidKeys);
  } else {
    await upsertStateValue(appConfig, 'vapid_keys', currentVapidKeys).catch(() => {});
  }

  webpush.setVapidDetails(resolvedSubject, currentVapidKeys.publicKey, currentVapidKeys.privateKey);
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
 * Sends a Web Push notification to all browser subscriptions of a given user.
 */
async function sendWebPushToUser(appConfig, userId, fullPayload) {
  try {
    await getOrInitVapidKeys(appConfig);
    const subs = await listAllRecords('push_subscriptions', `user = "${userId}"`, appConfig);
    if (!subs || !subs.length) return;

    await Promise.all(subs.map(sub => sendPushToSubscription(sub, fullPayload, appConfig)));
  } catch (err) {
    console.warn(`[WebPush] Failed to send push to user ${userId}:`, err.message);
  }
}

/**
 * Sends a push notification to all active devices of a given user
 * (browsers via Web Push, native Android apps via FCM).
 */
async function sendPushToUser(appConfig, userId, payload = {}) {
  if (!appConfig || !userId) return;
  const fullPayload = {
    title: payload.title || (appConfig.appName || 'Agora'),
    body: payload.body || '',
    icon: payload.icon || './assets/icon-notification.png',
    badge: payload.badge || './assets/badge-monochrome.png',
    data: payload.data || {},
    tag: payload.tag || 'agora-notification'
  };

  await Promise.all([
    sendWebPushToUser(appConfig, userId, fullPayload),
    sendFcmToUser(appConfig, userId, fullPayload)
  ]);
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
      .filter(u => (u.admin === true || u.owner === true || u.superAdmin === true) && (u.notificationSettings?.finances !== false && u.emailNotifications !== false))
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
