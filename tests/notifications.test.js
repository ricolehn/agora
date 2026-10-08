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

  test('buildEmail writes greeting, button and footer in the recipient language (English by default)', () => {
    const en = buildEmail({ appName: 'Agora', recipientName: 'Ada', heading: 'Hi', url: 'https://x.example' });
    assert.match(en.text, /^Hello Ada,/);
    assert.match(en.html, /Open in the app/);
    const de = buildEmail({ appName: 'Agora', recipientName: 'Ada', heading: 'Hi', url: 'https://x.example', lang: 'de' });
    assert.match(de.text, /^Hallo Ada,/);
    assert.match(de.html, /In der App öffnen/);
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

  test('buildGroupDutyPush names group, duty, event and time in the recipient language', () => {
    const input = {
      groupName: 'Technik',
      event: { id: 'e1', title: 'Gottesdienst', date: '2026-09-30', startTime: '10:00' },
      duty: { id: 'd1', roleName: 'Ton' }
    };
    for (const [lang, word] of [['en', 'Duty'], ['de', 'Dienst']]) {
      const push = buildGroupDutyPush(input, lang);
      assert.ok(push.title.includes(word) && push.title.includes('Technik') && push.title.includes('Ton'), `${lang} title: ${push.title}`);
      for (const part of ['Technik', 'Gottesdienst', 'Ton', '10:00', '2026']) assert.ok(push.body.includes(part), `${lang} body has ${part}: ${push.body}`);
      assert.deepEqual(push.data, { url: '/#events', eventId: 'e1' });
      assert.equal(push.tag, 'agora-duty-d1');
    }
    assert.ok(buildGroupDutyPush(input).title.startsWith('Duty'), 'English without a language');
  });
});

describe('dutyReminders', () => {
  const { validTimeZone, zonedTime, reminderWindow, dutyRecipients, communityTimeZone, buildDutyReminderPush, sendDueDutyReminders } = require('../backend/dutyReminders');
  const at = (iso) => Date.parse(iso);

  test('validTimeZone accepts IANA names only', () => {
    assert.equal(validTimeZone('Europe/Berlin'), 'Europe/Berlin');
    for (const bad of ['', 'Mars/Olympus', 'x'.repeat(80), null, '../etc']) assert.equal(validTimeZone(bad), '');
  });

  test('zonedTime reads wall-clock times in the zone, also across daylight saving', () => {
    assert.equal(zonedTime('2026-07-01', 18, 0, 'Europe/Berlin'), at('2026-07-01T16:00:00Z'));
    assert.equal(zonedTime('2026-12-01', 18, 0, 'Europe/Berlin'), at('2026-12-01T17:00:00Z'));
    assert.equal(zonedTime('2026-03-29', 10, 0, 'Europe/Berlin'), at('2026-03-29T08:00:00Z'));
    assert.equal(zonedTime('2026-10-25', 10, 0, 'Europe/Berlin'), at('2026-10-25T09:00:00Z'));
    assert.ok(Number.isNaN(zonedTime('', 10, 0, 'UTC')));
  });

  test('reminderWindow: 3 hours before the start, 8:00 for events without a time', () => {
    const timed = reminderWindow({ date: '2026-07-01', startTime: '18:30' }, 'Europe/Berlin');
    assert.equal(timed.at, at('2026-07-01T13:30:00Z'));
    assert.equal(timed.until, at('2026-07-01T16:30:00Z'));
    assert.equal(timed.time, '18:30');
    const allDay = reminderWindow({ date: '2026-07-01' }, 'Europe/Berlin');
    assert.equal(allDay.at, at('2026-07-01T06:00:00Z'));
    assert.equal(allDay.time, '');
    assert.notEqual(timed.key, allDay.key);
    assert.equal(reminderWindow({ date: 'soon' }, 'UTC'), null);
    assert.equal(reminderWindow({ date: '2026-07-01', startTime: '25:00' }, 'UTC').time, '', 'invalid times count as no time');
  });

  test('dutyRecipients: the person who took it, else the group; open or requested duties nobody', () => {
    const users = [{ id: 'a', groups: ['g1'] }, { id: 'b', groups: ['Technik'] }, { id: 'c', groups: [] }];
    const groups = [{ id: 'g1', name: 'Technik' }];
    assert.deepEqual(dutyRecipients({ status: 'confirmed', assignedUser: 'c', assignedGroup: 'g1' }, users, groups).map((u) => u.id), ['c']);
    assert.deepEqual(dutyRecipients({ status: 'assigned', assignedGroup: 'g1' }, users, groups).map((u) => u.id), ['a', 'b']);
    for (const status of ['open', 'requested', 'declined', 'cancelled']) {
      assert.deepEqual(dutyRecipients({ status, assignedUser: 'c' }, users, groups), [], status);
    }
  });

  test('communityTimeZone: the server TZ, unless UTC; then the zone most members report', (t) => {
    const members = [{ timeZone: 'Europe/Berlin' }, { timeZone: 'Europe/Berlin' }, { timeZone: 'America/New_York' }, { timeZone: 'bogus' }];
    withEnv(t, { TZ: 'America/New_York' });
    assert.equal(communityTimeZone(members), 'America/New_York', 'a configured TZ wins');
    for (const utc of ['UTC', 'Etc/UTC', 'GMT']) {
      process.env.TZ = utc;
      assert.equal(communityTimeZone(members), 'Europe/Berlin', `${utc} (Docker default) does not count`);
    }
    process.env.TZ = 'UTC';
    assert.equal(communityTimeZone([]), 'UTC', 'UTC when nothing else is known');
  });

  test('buildDutyReminderPush names duty, event, time and place in the recipient language', () => {
    const input = { event: { id: 'e1', title: 'Gottesdienst', location: 'Saal' }, duty: { id: 'd1', roleName: 'Ton' }, time: '10:00' };
    for (const [lang, word] of [['en', 'Reminder'], ['de', 'Erinnerung']]) {
      const push = buildDutyReminderPush(input, lang);
      assert.ok(push.title.startsWith(word) && push.title.includes('Ton'), `${lang} title: ${push.title}`);
      for (const part of ['Gottesdienst', 'Ton', '10:00', 'Saal']) assert.ok(push.body.includes(part), `${lang} body has ${part}: ${push.body}`);
      assert.equal(push.tag, 'agora-duty-reminder-d1');
    }
  });

  test('sendDueDutyReminders: 3 hours before for everyone (also members abroad), once per start', async (t) => {
    withEnv(t, { TZ: 'UTC' });
    const event = { id: 'e1', title: 'Gottesdienst', date: '2026-07-01', startTime: '18:00' };
    const duty = { id: 'd1', event: 'e1', roleName: 'Ton', status: 'assigned', assignedGroup: 'g1' };
    // b is travelling: the community (and the event) stays in Berlin
    const users = [{ id: 'a', groups: ['g1'], timeZone: 'Europe/Berlin' }, { id: 'b', groups: ['g1'], timeZone: 'America/New_York' },
      { id: 'd', groups: ['g1'], timeZone: 'Europe/Berlin' }, { id: 'c', groups: [] }];
    const sent = [];
    const deps = {
      listEvents: async () => [event],
      listDuties: async () => [duty],
      listUsers: async () => users,
      listGroups: async () => [{ id: 'g1', name: 'Technik' }],
      saveReminded: async (d, reminded) => { duty.reminded = reminded; },
      notify: async (recipients) => { sent.push(...recipients.map((u) => u.id)); }
    };
    assert.equal(await sendDueDutyReminders({}, at('2026-07-01T12:59:00Z'), deps), 0, 'too early');
    // 15:00 in Berlin = 18:00 - 3h: everyone on the duty at the same moment, wherever they are
    assert.equal(await sendDueDutyReminders({}, at('2026-07-01T13:00:00Z'), deps), 3);
    assert.deepEqual(sent.sort(), ['a', 'b', 'd']);
    assert.equal(await sendDueDutyReminders({}, at('2026-07-01T13:35:00Z'), deps), 0, 'no second reminder');
    users.push({ id: 'e', groups: ['g1'] });
    assert.equal(await sendDueDutyReminders({}, at('2026-07-01T13:40:00Z'), deps), 1, 'a new group member still gets one');
    event.startTime = '19:00';
    assert.equal(await sendDueDutyReminders({}, at('2026-07-01T14:30:00Z'), deps), 4, 'moved event reminds again');
    assert.equal(await sendDueDutyReminders({}, at('2026-07-01T17:01:00Z'), deps), 0, 'not after the start');
    duty.status = 'open';
    assert.equal(await sendDueDutyReminders({}, at('2026-07-01T20:00:00Z'), deps), 0, 'open duties are nobody\'s');
  });
});
