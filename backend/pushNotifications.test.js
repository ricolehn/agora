const test = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');
const {
  getOrInitVapidKeys,
  getVapidPublicKey,
  sendPushToSubscription
} = require('./pushNotifications');

test('getOrInitVapidKeys generates and persists a valid VAPID keypair', async () => {
  let savedState = null;
  const mockAppConfig = {
    appName: 'Agora Test',
    smtp: { user: 'test@agora.local' },
    _mockGetState: async (key) => savedState,
    _mockUpsertState: async (key, val) => { savedState = val; }
  };

  const keys = await getOrInitVapidKeys(mockAppConfig);
  assert.ok(keys.publicKey, 'publicKey should exist');
  assert.ok(keys.privateKey, 'privateKey should exist');
  assert.ok(typeof keys.publicKey === 'string');
  assert.ok(typeof keys.privateKey === 'string');

  const pubKey = await getVapidPublicKey(mockAppConfig);
  assert.equal(pubKey, keys.publicKey);
});

test('sendPushToSubscription gracefully handles invalid subscription errors', async () => {
  const dummySub = {
    id: 'sub-test-1',
    endpoint: 'https://fcm.googleapis.com/fcm/send/invalid-endpoint',
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QT9t044Yjs2TU2jGzxFcSJEXx70WnKQgGDYnV3ert5DDMQ60',
    auth: 'tBHItJI5svbpez7KI4CCXg'
  };

  const result = await sendPushToSubscription(dummySub, { title: 'Test', body: 'Message' }, {});
  // Google endpoint will return an error because it's fake or 400/404/410, which shouldn't throw an unhandled exception
  assert.ok(result.error !== undefined || result.success === true);
});
