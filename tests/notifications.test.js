const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const { backendRequire, withEnv } = require('./helpers');

describe('pushNotifications', () => {
  const webpush = backendRequire('web-push');
  const {
    getOrInitVapidKeys,
    getVapidPublicKey,
    sendPushToSubscription
  } = require('../backend/pushNotifications');

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
});

describe('fcmNotifications', () => {
  const {
    loadServiceAccount,
    loadClientConfig,
    buildServiceAccountJwt,
    getAccessToken,
    buildFcmMessage,
    isStaleTokenError,
    sendFcmToToken,
    resetFcmState
  } = require('../backend/fcmNotifications');
  const { sendPushToUser, sendPushToAdmins } = require('../backend/pushNotifications');

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });

  const serviceAccountJson = JSON.stringify({
    type: 'service_account',
    project_id: 'agora-test',
    client_email: 'fcm@agora-test.iam.gserviceaccount.com',
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token'
  });

  const googleServicesJson = JSON.stringify({
    project_info: { project_number: '123456', project_id: 'agora-test' },
    client: [{ client_info: { mobilesdk_app_id: '1:123456:android:agora', android_client_info: { package_name: 'org.agora.app' } }, api_key: [{ current_key: 'AIzaTest' }] }]
  });

  const mockAppConfig = {
    appName: 'Agora Test',
    pocketbase: { adminEmail: 'admin@local.invalid', adminPassword: 'secret' },
    _mockGetState: async () => null,
    _mockUpsertState: async () => {}
  };

  function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  /**
   * Installs a fetch mock that answers Google OAuth, FCM and PocketBase requests.
   * fcmResponder(token) decides the FCM response per registration token.
   */
  function installFetchMock(t, { users = [], fcmTokens = [], fcmResponder = () => jsonResponse(200, { name: 'ok' }) } = {}) {
    const calls = { tokenRequests: 0, fcmSends: [], deleted: [] };
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      const href = String(url);
      const method = options.method || 'GET';
      if (href === 'https://oauth2.googleapis.com/token') {
        calls.tokenRequests += 1;
        return jsonResponse(200, { access_token: 'ya29.test', expires_in: 3599, token_type: 'Bearer' });
      }
      if (href.startsWith('https://fcm.googleapis.com/')) {
        const body = JSON.parse(options.body);
        calls.fcmSends.push(body.message);
        return fcmResponder(body.message.token);
      }
      if (href.includes('/api/collections/_superusers/auth-with-password')) {
        return jsonResponse(200, { token: 'pb-superuser' });
      }
      if (href.includes('/api/collections/fcm_tokens/records/') && method === 'DELETE') {
        calls.deleted.push(href.split('/').pop());
        return new Response(null, { status: 204 });
      }
      if (href.includes('/api/collections/fcm_tokens/records?')) {
        const filter = new URL(href).searchParams.get('filter') || '';
        const items = fcmTokens.filter(rec => filter.includes(JSON.stringify(rec.user)));
        return jsonResponse(200, { items, totalPages: 1 });
      }
      if (href.includes('/api/collections/users/records?')) {
        return jsonResponse(200, { items: users, totalPages: 1 });
      }
      return jsonResponse(200, { items: [], totalPages: 1 });
    };
    withEnv(t, {
      FCM_SERVICE_ACCOUNT_FILE: undefined,
      FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson,
      FCM_GOOGLE_SERVICES_JSON: googleServicesJson
    });
    resetFcmState();
    t.after(() => {
      global.fetch = originalFetch;
      resetFcmState();
    });
    return calls;
  }

  test('loadServiceAccount prefers the file env, then raw JSON, then the data directory fallback', () => {
    const files = {
      [path.resolve('/secrets/sa.json')]: serviceAccountJson,
      [path.join(path.resolve('/data'), 'firebase-service-account.json')]: serviceAccountJson.replace('agora-test', 'agora-fallback')
    };
    const readFileSync = (file) => {
      if (!(file in files)) throw new Error(`ENOENT ${file}`);
      return files[file];
    };
    const existsSync = (file) => file in files;

    const fromFile = loadServiceAccount({ env: { FCM_SERVICE_ACCOUNT_FILE: '/secrets/sa.json' }, readFileSync, existsSync });
    assert.equal(fromFile.projectId, 'agora-test');
    assert.equal(fromFile.clientEmail, 'fcm@agora-test.iam.gserviceaccount.com');

    const fromJson = loadServiceAccount({ env: { FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson }, readFileSync, existsSync });
    assert.equal(fromJson.projectId, 'agora-test');

    const fromDataDir = loadServiceAccount({ env: { DATA_DIR: '/data' }, readFileSync, existsSync });
    assert.equal(fromDataDir.projectId, 'agora-fallback');

    assert.equal(loadServiceAccount({ env: { DATA_DIR: '/empty' }, readFileSync, existsSync }), null);
    assert.equal(loadServiceAccount({ env: { FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"x"}' }, readFileSync, existsSync }), null);
    assert.equal(loadServiceAccount({ env: { FCM_SERVICE_ACCOUNT_JSON: 'not json' }, readFileSync, existsSync }), null);
  });

  test('loadClientConfig extracts the public Firebase config of the org.agora.app client', () => {
    const googleServices = JSON.stringify({
      project_info: { project_number: '123456', project_id: 'agora-test', storage_bucket: 'agora-test.firebasestorage.app' },
      client: [
        { client_info: { mobilesdk_app_id: '1:123456:android:other', android_client_info: { package_name: 'com.example.other' } }, api_key: [{ current_key: 'other-key' }] },
        { client_info: { mobilesdk_app_id: '1:123456:android:agora', android_client_info: { package_name: 'org.agora.app' } }, api_key: [{ current_key: 'AIzaTest' }] }
      ]
    });
    const dataFile = path.join(path.resolve('/data'), 'google-services.json');
    const readFileSync = (file) => {
      if (file !== dataFile) throw new Error(`ENOENT ${file}`);
      return googleServices;
    };

    assert.deepEqual(loadClientConfig({ env: { DATA_DIR: '/data' }, readFileSync, existsSync: (file) => file === dataFile }), {
      projectId: 'agora-test',
      senderId: '123456',
      appId: '1:123456:android:agora',
      apiKey: 'AIzaTest',
      storageBucket: 'agora-test.firebasestorage.app'
    });
    assert.equal(loadClientConfig({ env: { FCM_GOOGLE_SERVICES_JSON: googleServices } }).appId, '1:123456:android:agora');
    // Missing file, or no Android app registered for org.agora.app
    assert.equal(loadClientConfig({ env: { DATA_DIR: '/data' }, existsSync: () => false }), null);
    assert.equal(loadClientConfig({ env: { FCM_GOOGLE_SERVICES_JSON: googleServices.replace('org.agora.app', 'com.agora.app') } }), null);
  });

  test('buildServiceAccountJwt creates a verifiable RS256 assertion with the FCM scope', () => {
    const account = loadServiceAccount({ env: { FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson } });
    const jwt = buildServiceAccountJwt(account, 1_700_000_000);
    const [header, claims, signature] = jwt.split('.');

    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), {
      iss: 'fcm@agora-test.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600
    });

    const valid = crypto.createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url'));
    assert.equal(valid, true);
  });

  test('getAccessToken caches the Google access token', async (t) => {
    const calls = installFetchMock(t);
    assert.equal(await getAccessToken(), 'ya29.test');
    assert.equal(await getAccessToken(), 'ya29.test');
    assert.equal(calls.tokenRequests, 1);
  });

  test('buildFcmMessage creates a data-only high priority message with string values', () => {
    const message = buildFcmMessage('device-token', {
      title: 'Neues Event',
      body: 'Hallo',
      tag: 'agora-event-42',
      icon: './assets/icon-notification.png',
      data: { url: '/#events', eventId: 42 }
    });
    assert.deepEqual(message, {
      message: {
        token: 'device-token',
        data: { title: 'Neues Event', body: 'Hallo', url: '/#events', tag: 'agora-event-42', eventId: '42' },
        android: { priority: 'HIGH', ttl: '86400s' }
      }
    });
    assert.equal('notification' in message.message, false);

    const minimal = buildFcmMessage('device-token', { title: 'Test', body: '', data: {} });
    assert.deepEqual(minimal.message.data, { title: 'Test' });
  });

  test('isStaleTokenError detects unregistered and invalid tokens only', () => {
    const fcmError = (errorCode) => [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }];
    assert.equal(isStaleTokenError(404, { status: 'NOT_FOUND', details: fcmError('UNREGISTERED') }), true);
    assert.equal(isStaleTokenError(404, {}), true);
    assert.equal(isStaleTokenError(400, {
      status: 'INVALID_ARGUMENT',
      message: 'The registration token is not a valid FCM registration token',
      details: fcmError('INVALID_ARGUMENT')
    }), true);
    assert.equal(isStaleTokenError(400, {
      status: 'INVALID_ARGUMENT',
      message: 'Invalid value',
      details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.token' }] }]
    }), true);
    assert.equal(isStaleTokenError(400, { status: 'INVALID_ARGUMENT', message: 'Invalid android.ttl' }), false);
    assert.equal(isStaleTokenError(500, { status: 'INTERNAL' }), false);
    assert.equal(isStaleTokenError(429, { status: 'RESOURCE_EXHAUSTED', details: fcmError('QUOTA_EXCEEDED') }), false);
  });

  test('sendFcmToToken deletes tokens reported as UNREGISTERED and keeps them on other errors', async (t) => {
    const calls = installFetchMock(t, {
      fcmResponder: (token) => token === 'dead-token'
        ? jsonResponse(404, { error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } })
        : jsonResponse(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'Try again later' } })
    });

    const dead = await sendFcmToToken({ id: 'rec-dead', token: 'dead-token' }, { title: 'Hi' }, mockAppConfig);
    assert.equal(dead.deleted, true);
    assert.deepEqual(calls.deleted, ['rec-dead']);

    const busy = await sendFcmToToken({ id: 'rec-busy', token: 'busy-token' }, { title: 'Hi' }, mockAppConfig);
    assert.equal(busy.statusCode, 503);
    assert.equal(busy.deleted, undefined);
    assert.deepEqual(calls.deleted, ['rec-dead']);
  });

  test('sendPushToUser delivers via FCM when the user has no Web Push subscription', async (t) => {
    const calls = installFetchMock(t, {
      fcmTokens: [
        { id: 'rec-1', user: 'user-1', token: 'token-1' },
        { id: 'rec-2', user: 'user-2', token: 'token-2' }
      ]
    });

    await sendPushToUser(mockAppConfig, 'user-1', {
      title: 'Dienstanfrage',
      body: 'Bitte bestätigen',
      data: { url: '/#events' }
    });

    assert.equal(calls.fcmSends.length, 1);
    assert.equal(calls.fcmSends[0].token, 'token-1');
    assert.deepEqual(calls.fcmSends[0].data, {
      title: 'Dienstanfrage',
      body: 'Bitte bestätigen',
      url: '/#events',
      tag: 'agora-notification'
    });
  });

  test('sendPushToAdmins only reaches FCM devices of admins with finance notifications enabled', async (t) => {
    const calls = installFetchMock(t, {
      users: [
        { id: 'admin-on', admin: true, notificationSettings: { finances: true } },
        { id: 'admin-off', admin: true, notificationSettings: { finances: false } },
        { id: 'owner-muted', owner: true, emailNotifications: false },
        { id: 'member', admin: false }
      ],
      fcmTokens: [
        { id: 'rec-a', user: 'admin-on', token: 'token-admin-on' },
        { id: 'rec-b', user: 'admin-off', token: 'token-admin-off' },
        { id: 'rec-c', user: 'owner-muted', token: 'token-owner-muted' },
        { id: 'rec-d', user: 'member', token: 'token-member' }
      ]
    });

    await sendPushToAdmins(mockAppConfig, { title: 'Neue Ausgabe', body: '10 €' });

    assert.deepEqual(calls.fcmSends.map(m => m.token), ['token-admin-on']);
  });
});

describe('notify', () => {
  const { normalizePublicUrl, originOf, buildEmail } = require('../backend/notify');

  const fakeReq = (host, proto = 'https') => ({ get: (h) => (h === 'host' ? host : undefined), headers: { 'x-forwarded-proto': proto }, protocol: 'http' });

  test('normalizePublicUrl accepts http(s) only and strips the trailing slash', () => {
    assert.equal(normalizePublicUrl('https://beta.example.org/'), 'https://beta.example.org');
    assert.equal(normalizePublicUrl(' https://example.org/app/ '), 'https://example.org/app');
    assert.equal(normalizePublicUrl(''), '');
    assert.equal(normalizePublicUrl('javascript:alert(1)'), null);
    assert.equal(normalizePublicUrl('https://user:pw@example.org'), null);
    assert.equal(normalizePublicUrl('not a url'), null);
  });

  test('originOf uses a plain request host and refuses forged ones', () => {
    assert.equal(originOf(fakeReq('agora.example.org')), 'https://agora.example.org');
    assert.equal(originOf(fakeReq('localhost:4001', 'http')), 'http://localhost:4001');
    assert.equal(originOf(fakeReq('evil.tld/phish?x=')), '');
    assert.equal(originOf(fakeReq('a b')), '');
    assert.equal(originOf(fakeReq('host', 'javascript')), 'http://host');
  });

  test('buildEmail escapes the content', () => {
    const { html, text } = buildEmail({ appName: 'Agora', recipientName: 'Max', heading: '<b>Hi</b>', lines: ['x < y'], rows: [['Von', '<script>']], url: 'https://a.org/#x' });
    assert.ok(!html.includes('<b>Hi</b>'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(text.includes('https://a.org/#x'));
  });
});

describe('notificationPrefs', () => {
  const { readNotificationSettings, mergeNotificationSettings, wantsNotification } = require('../backend/notificationPrefs');

  test('default: push with every kind, e-mail off', () => {
    const user = { id: 'u1' };
    assert.equal(wantsNotification(user, 'duties', 'push'), true);
    assert.equal(wantsNotification(user, 'requests', 'push'), true);
    assert.equal(wantsNotification(user, 'duties', 'email'), false);
  });

  test('old records: flat keys are the push choice, emailNotifications=false without settings means nothing', () => {
    assert.equal(wantsNotification({ notificationSettings: { events: false } }, 'events', 'push'), false);
    assert.equal(wantsNotification({ notificationSettings: { events: false } }, 'duties', 'push'), true);
    assert.equal(wantsNotification({ emailNotifications: false }, 'duties', 'push'), false);
  });

  test('e-mail channel with its own kinds', () => {
    const user = { notificationSettings: { channels: { push: false, email: true }, email: { events: false } } };
    assert.equal(wantsNotification(user, 'duties', 'push'), false);
    assert.equal(wantsNotification(user, 'duties', 'email'), true);
    assert.equal(wantsNotification(user, 'events', 'email'), false);
  });

  test('a write with only flat keys (older app) keeps channels and e-mail kinds', () => {
    const existing = { notificationSettings: { channels: { push: true, email: true }, push: { messages: true }, email: { events: false } } };
    const merged = mergeNotificationSettings(existing, { duties: true, events: true, messages: false, finances: true });
    assert.deepEqual(merged.channels, { push: true, email: true });
    assert.equal(merged.push.messages, false);
    assert.equal(merged.messages, false);
    assert.equal(merged.email.events, false);
  });

  test('a full write replaces channels and both maps', () => {
    const merged = mergeNotificationSettings({}, { channels: { push: false, email: true }, push: { duties: false }, email: { reports: false } });
    assert.deepEqual(merged.channels, { push: false, email: true });
    assert.equal(merged.push.duties, false);
    assert.equal(merged.email.reports, false);
    assert.equal(readNotificationSettings({ notificationSettings: merged }).email.duties, true);
  });
});

describe('dutyGroupNotifications', () => {
  const { isGroupMember, groupDutyRecipients, buildGroupDutyPush } = require('../backend/dutyGroupNotifications');

  test('isGroupMember matches group ids, names and {id, name} objects', () => {
    assert.equal(isGroupMember({ groups: ['g1'] }, 'g1', 'Technik'), true);
    assert.equal(isGroupMember({ groups: ['Technik'] }, 'g1', 'Technik'), true);
    assert.equal(isGroupMember({ groups: [{ id: 'g1', name: 'Technik' }] }, 'g1', 'Technik'), true);
    assert.equal(isGroupMember({ groups: ['g2'] }, 'g1', 'Technik'), false);
    assert.equal(isGroupMember({}, 'g1', 'Technik'), false);
  });

  test('groupDutyRecipients: members only (admins are not implied), without the assigner and opt-outs', () => {
    const users = [
      { id: 'a', groups: ['g1'] },
      { id: 'b', groups: ['Technik'], notificationSettings: { duties: false } },
      { id: 'c', groups: ['g1'], emailNotifications: false, notificationSettings: { duties: true } },
      { id: 'boss', owner: true, groups: [] },
      { id: 'me', groups: ['g1'] },
      { id: 'd', groups: ['g2'] }
    ];
    assert.deepEqual(groupDutyRecipients(users, 'g1', 'Technik', 'me'), ['a', 'c']);
  });

  test('buildGroupDutyPush names group, duty, event and date', () => {
    const push = buildGroupDutyPush({
      groupName: 'Technik',
      event: { id: 'e1', title: 'Gottesdienst', date: '2026-09-30', startTime: '10:00' },
      duty: { id: 'd1', roleName: 'Ton' }
    });
    assert.equal(push.title, 'Dienst für Technik: Ton');
    assert.equal(push.body, 'Deine Gruppe „Technik“ ist bei „Gottesdienst“ am 30.09. um 10:00 Uhr für „Ton“ eingeteilt.');
    assert.deepEqual(push.data, { url: '/#events', eventId: 'e1' });
    assert.equal(push.tag, 'agora-duty-d1');
  });
});
