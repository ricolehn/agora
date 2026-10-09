// End-to-end over HTTP: the real backend with a real PocketBase on free ports and an empty data directory.
// Needs the PocketBase binary: POCKETBASE_BIN=/path/to/pocketbase (CI downloads it; locally the test is skipped
// without it unless REQUIRE_POCKETBASE=1, which turns a missing binary into a failure).
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { REPO_ROOT, BACKEND_DIR } = require('./helpers');

const POCKETBASE_BIN = process.env.POCKETBASE_BIN || '';
const hasPocketBase = POCKETBASE_BIN !== '' && fs.existsSync(POCKETBASE_BIN);
if (!hasPocketBase && process.env.REQUIRE_POCKETBASE === '1') {
  throw new Error(`REQUIRE_POCKETBASE=1 but no PocketBase binary at POCKETBASE_BIN="${POCKETBASE_BIN}"`);
}

const PASSWORD = 'test-Passwort-1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

async function waitFor(url, label, processes) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const crashed = processes.find((p) => p.exitCode !== null);
    if (crashed) throw new Error(`${label}: ${crashed.label} exited early (${crashed.exitCode})\n${crashed.log.join('')}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not come up: ${url}`);
}

function start(label, command, args, env) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.label = label;
  child.log = [];
  // API_TEST_LOG=1 prints the server output (debugging a failing test)
  const keep = (chunk) => {
    child.log.push(chunk.toString());
    if (child.log.length > 200) child.log.shift();
    if (process.env.API_TEST_LOG) process.stderr.write(`[${label}] ${chunk}`);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  return child;
}

describe('api', { skip: !hasPocketBase && 'set POCKETBASE_BIN to run the HTTP tests' }, () => {
  const processes = [];
  let base;
  let dataRoot;
  let preSetupLogin;
  const tokens = {};
  const uids = {};

  // One small client: JSON in, { status, body, headers } out; never throws on HTTP errors
  async function call(who, method, url, body, { form = false } = {}) {
    const headers = { 'X-Forwarded-For': `10.42.0.${Object.keys(tokens).indexOf(who) + 2}` };
    if (who && tokens[who]) headers.Authorization = `Bearer ${tokens[who]}`;
    if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: form ? body : body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* text body */ }
    return { status: res.status, body: parsed, headers: res.headers };
  }
  const ok = async (promise) => {
    const res = await promise;
    assert.ok(res.status < 300, `expected success, got ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    return res.body;
  };
  const read = async (who, dbPath) => (await ok(call(who, 'GET', `/api/db?path=${dbPath}`))) || {};
  const login = async (who, email) => {
    tokens[who] = (await ok(call(null, 'POST', '/api/auth/login', { email, password: PASSWORD }))).token;
    uids[who] = (await ok(call(who, 'GET', '/api/auth/me'))).user.uid;
  };
  // A fresh account for one test (keeps the tests independent of each other)
  const account = async (who, firstName, extra = {}) => {
    const email = `${who}@test.local`;
    await ok(call('owner', 'POST', '/api/admin/users', {
      firstName, lastName: 'Test', email, password: PASSWORD, pays: true, admin: false, status: 'vollverdiener', memberSince: '2025-01-01', ...extra
    }));
    await login(who, email);
    return uids[who];
  };
  const uploadReceipt = (who, name) => {
    const form = new FormData();
    form.append('name', name);
    form.append('date', '2026-10-01');
    form.append('receipt', new Blob([PNG], { type: 'image/png' }), 'beleg.png');
    return call(who, 'POST', '/api/upload', form, { form: true });
  };

  before(async () => {
    const [port, pbPort] = await Promise.all([freePort(), freePort()]);
    dataRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agora-api-'));
    const pbDir = path.join(dataRoot, 'pb');
    base = `http://127.0.0.1:${port}`;

    processes.push(start('pocketbase', POCKETBASE_BIN, ['serve', '--dir', pbDir, '--http', `127.0.0.1:${pbPort}`], {}));
    await waitFor(`http://127.0.0.1:${pbPort}/api/health`, 'PocketBase', processes);

    processes.push(start('backend', process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
      PORT: String(port),
      POCKETBASE_PORT: String(pbPort),
      POCKETBASE_BIN,
      POCKETBASE_DIR: pbDir,
      DATA_DIR: path.join(dataRoot, 'data'),
      FRONTEND_DIR: REPO_ROOT,
      NODE_ENV: 'test'
    }));
    await waitFor(`${base}/api/status`, 'backend', processes);

    preSetupLogin = await call(null, 'POST', '/api/auth/login', { email: 'owner@test.local', password: PASSWORD });
    const setup = await ok(call(null, 'POST', '/api/setup', {
      appName: 'Testgemeinde',
      adminUser: { firstName: 'Olga', lastName: 'Owner', email: 'owner@test.local', password: PASSWORD }
    }));
    tokens.owner = setup.token;
    uids.owner = setup.user.id || setup.user.uid;

    // Treasurer (group with manage_finances) and two plain members
    const group = await ok(call('owner', 'POST', '/api/admin/groups', { name: 'Kasse', permissions: ['manage_finances'] }));
    const member = (firstName, email) => ok(call('owner', 'POST', '/api/admin/users', {
      firstName, lastName: 'Test', email, password: PASSWORD, pays: true, admin: false, status: 'vollverdiener', memberSince: '2025-01-01'
    }));
    await member('Theo', 'treasurer@test.local');
    await member('Max', 'max@test.local');
    await member('Mia', 'mia@test.local');
    await login('treasurer', 'treasurer@test.local');
    await login('max', 'max@test.local');
    await login('mia', 'mia@test.local');
    await ok(call('owner', 'PUT', `/api/admin/users/${uids.treasurer}/groups`, { groups: [group.id || group.group?.id] }));
  });

  after(() => {
    for (const child of processes.reverse()) if (child.exitCode === null) child.kill();
    if (dataRoot) fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('setup mode blocks the API until the first setup, which only runs once', async () => {
    assert.equal(preSetupLogin.status, 503);
    assert.equal((await call(null, 'GET', '/api/status')).body.setupMode, false);
    const again = await call(null, 'POST', '/api/setup', { appName: 'X', adminUser: { firstName: 'A', lastName: 'B', email: 'x@test.local', password: PASSWORD } });
    assert.equal(again.status, 403);
  });

  test('login and session: wrong password, missing token, own account', async () => {
    assert.equal((await call(null, 'POST', '/api/auth/login', { email: 'max@test.local', password: 'falsch' })).status, 401);
    assert.equal((await call(null, 'GET', '/api/db?path=people')).status, 401);
    const me = (await ok(call('owner', 'GET', '/api/auth/me'))).user;
    assert.equal(me.owner, true);
    assert.equal(me.admin, true);
    const max = (await ok(call('max', 'GET', '/api/auth/me'))).user;
    assert.equal(max.admin, false);
    assert.equal(max.canViewFinances, false);
  });

  test('admin routes are closed for members', async () => {
    assert.equal((await call('max', 'GET', '/api/admin/users')).status, 403);
    assert.equal((await call('max', 'POST', '/api/admin/groups', { name: 'Hack', permissions: ['manage_finances'] })).status, 403);
    assert.equal((await call('max', 'GET', '/api/admin/system-config')).status, 403);
    assert.ok(Array.isArray(await ok(call('owner', 'GET', '/api/admin/users'))));
  });

  test('a member cannot give themselves rights or rename themselves', async () => {
    await call('max', 'PUT', '/api/db', { path: `users/${uids.max}`, value: { admin: true, owner: true, groups: ['x'], firstName: 'Boss' } });
    const me = (await ok(call('max', 'GET', '/api/auth/me'))).user;
    assert.equal(me.admin, false);
    assert.equal(me.owner, false);
    assert.equal(me.firstName, 'Max');
  });

  test('finance data: treasurers read and write, members only see themselves', async () => {
    assert.equal((await call('max', 'GET', '/api/db?path=expenses')).status, 403);
    assert.equal((await call('max', 'PUT', '/api/db', { path: 'donations', value: { 1: { amount: 5 } } })).status, 403);
    await ok(call('treasurer', 'PUT', '/api/db', { path: 'donations', value: { 1: { id: 1, amount: 25, name: 'Spende', date: '2026-10-01' } } }));
    assert.equal((await read('treasurer', 'donations'))[1].amount, 25);

    const people = Object.values(await read('max', 'people'));
    assert.ok(people.length >= 1, 'own person record is visible');
    assert.ok(people.every((p) => p.uid === uids.max || /^Max\b/.test(p.name || '')), 'only the own record');
    const all = Object.values(await read('treasurer', 'people'));
    assert.ok(all.length >= 4, 'treasurer sees everyone');
  });

  test('requests: a member files one, the treasurer sees it, other members do not', async () => {
    const id = `req-${Date.now()}`;
    const request = { id, type: 'payment', userId: uids.max, personId: uids.max, personName: 'Max Test', data: { amount: 30, date: '2026-10-01' }, status: 'pending', timestamp: Date.now() };
    await ok(call('max', 'PUT', '/api/db', { path: `requests/${id}`, value: request }));
    const forTreasurer = Object.values(await read('treasurer', 'requests'));
    assert.ok(forTreasurer.some((r) => r.id === id));
    const forMia = Object.values(await read('mia', 'requests'));
    assert.ok(!forMia.some((r) => r.id === id));
    assert.equal((await call('mia', 'GET', `/api/db?path=requests/${id}`)).status, 403);
  });

  test('receipts: uploader and treasurers may open them, other members and traversal may not', async () => {
    const { filename } = await ok(uploadReceipt('max', 'Max Test'));
    assert.ok(filename && !filename.includes('/'), 'plain stored file name');
    const open = (who, name) => call(who, 'GET', `/api/receipts/${encodeURIComponent(name)}`);
    assert.equal((await open('max', filename)).status, 200);
    assert.equal((await open('treasurer', filename)).status, 200);
    assert.equal((await open('mia', filename)).status, 403);
    assert.notEqual((await open('owner', '../config.json')).status, 200);
    assert.notEqual((await open('owner', '..%2Fconfig.json')).status, 200);
  });

  test('events: members create plain events, appointments / pinned need the permission (also for admins)', async () => {
    const event = { title: 'Jugendabend', date: '2026-11-07', startTime: '19:00', endTime: '21:00', location: 'Saal', description: 'Test' };
    const typeOf = async (who, payload) => {
      const created = await ok(call(who, 'POST', '/api/events', payload));
      const id = created.id || created.event?.id || created.events?.[0]?.id;
      assert.ok(id, 'created event has an id');
      const list = await ok(call('mia', 'GET', '/api/events'));
      return (Array.isArray(list) ? list : list.events || []).find((e) => e.id === id);
    };
    // Members may add events (setting on by default) but cannot make appointments or pin them
    const byMember = await typeOf('max', { ...event, eventType: 'termin', isPinned: true });
    assert.equal(byMember.eventType, 'event');
    assert.ok(!byMember.isPinned);
    // Admins without manage_events are treated like members (v3.0.0); the owner's Admin group has the permission
    await ok(call('owner', 'POST', '/api/admin/users', { firstName: 'Ada', lastName: 'Admin', email: 'ada@test.local', password: PASSWORD, pays: true, admin: true, status: 'vollverdiener', memberSince: '2025-01-01' }));
    await login('ada', 'ada@test.local');
    assert.equal((await typeOf('ada', { ...event, eventType: 'termin' })).eventType, 'event');
    assert.equal((await typeOf('owner', { ...event, eventType: 'termin' })).eventType, 'termin');
    // Leadership can close event creation for members
    await ok(call('owner', 'PATCH', '/api/events/settings', { allowMemberCreation: false }));
    assert.equal((await call('max', 'POST', '/api/events', event)).status, 403);
    await ok(call('owner', 'PATCH', '/api/events/settings', { allowMemberCreation: true }));
  });

  test('web app: page, security headers and the configured app name', async () => {
    const page = await call(null, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(String(page.body), /<script[^>]+app\.js/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const config = await call(null, 'GET', '/assets/config.js');
    assert.equal(config.status, 200);
    assert.match(String(config.body), /Testgemeinde/, 'custom app name, not the static default');
    // An uploaded logo opened directly must not be able to run anything
    const logo = await call(null, 'GET', '/assets/church-logo.svg');
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get('content-security-policy') || '', /sandbox/);
  });

  test('languages: answers follow the app, then the user, then the instance default; English is the base', async () => {
    const reader = await account('lena', 'Lena');
    // a member may not change the event settings: a fixed, translated error
    const errorFor = async (who, lang) => {
      const headers = { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' };
      if (lang) headers['Accept-Language'] = lang;
      const res = await fetch(`${base}/api/events/settings`, { method: 'PATCH', headers, body: '{}' });
      assert.equal(res.status, 403);
      return (await res.json()).error;
    };
    const english = await errorFor('lena', 'en');
    assert.match(english, /^[ -~]+$/, 'English text');
    assert.notEqual(await errorFor('lena', 'de-DE,de;q=0.9'), english, 'German when the app asks for German');
    assert.equal(await errorFor('lena', 'fr'), english, 'unsupported languages get English');

    // the instance default (English after this setup) applies to users without an own language
    const config = await ok(call('owner', 'GET', '/api/admin/system-config'));
    assert.equal(config.defaultLanguage, 'en');
    assert.ok(config.supportedLanguages.includes('de'));
    assert.equal(await errorFor('lena'), english);

    // the app reports the user's language; unsupported values are ignored
    await ok(call('lena', 'PATCH', '/api/db', { path: `users/${reader}`, value: { language: 'de' } }));
    assert.equal((await ok(call('lena', 'GET', '/api/auth/me'))).user.language, 'de');
    assert.notEqual(await errorFor('lena'), english, 'German from the stored language');
    await call('lena', 'PATCH', '/api/db', { path: `users/${reader}`, value: { language: 'klingonisch' } });
    assert.equal((await ok(call('lena', 'GET', '/api/auth/me'))).user.language, 'de');

    // changing the instance default reaches everyone without an own language
    const sameConfig = { appName: config.appName, publicUrl: config.publicUrl, smtp: null };
    assert.equal((await call('owner', 'PUT', '/api/admin/system-config', { ...sameConfig, defaultLanguage: 'xx' })).status, 400);
    await ok(call('owner', 'PUT', '/api/admin/system-config', { ...sameConfig, defaultLanguage: 'de' }));
    assert.notEqual(await errorFor('max'), english, 'German for members without an own language');
    await ok(call('owner', 'PUT', '/api/admin/system-config', { ...sameConfig, defaultLanguage: 'en' }));
    assert.equal(await errorFor('max'), english);
  });

  // --- Edge cases: things that must never work, whatever the feature around them looks like ---

  test('broken, forged or misplaced tokens are rejected', async () => {
    const asToken = (token) => fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
    assert.equal(await asToken('kein-token'), 401);
    assert.equal(await asToken('a.b.c'), 401);
    const [head, payload, signature] = tokens.max.split('.');
    // same header and payload, different signature
    assert.equal(await asToken(`${head}.${payload}.${signature.slice(0, -4)}AAAA`), 401);
    // claims of another user with the old signature
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, id: uids.owner })).toString('base64url');
    assert.equal(await asToken(`${head}.${forged}.${signature}`), 401);
    // without "Bearer " or in the query string (only the live stream may use ?token=)
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Authorization: tokens.max } })).status, 401);
    assert.equal((await fetch(`${base}/api/auth/me?token=${tokens.max}`)).status, 401);
  });

  test("members cannot read or change other members' accounts and person records", async () => {
    const people = await read('treasurer', 'people');
    const miasRecord = Object.entries(people).find(([, p]) => p.uid === uids.mia);
    assert.ok(miasRecord, "the treasurer sees Mia's person record");
    const [miasKey] = miasRecord;
    assert.equal((await call('max', 'GET', `/api/db?path=users/${uids.mia}`)).status, 403);
    assert.equal((await call('max', 'PUT', '/api/db', { path: `users/${uids.mia}`, value: { firstName: 'Gehackt' } })).status, 403);
    assert.equal((await call('max', 'GET', `/api/db?path=people/${miasKey}`)).status, 403);
    assert.equal((await call('max', 'PATCH', '/api/db', { path: `people/${miasKey}`, value: { totalPaid: 99999 } })).status, 403);
    assert.equal((await call('max', 'PATCH', '/api/db', { path: `people/${miasKey}`, value: { uid: uids.max } })).status, 403, 'cannot take over a record');
    assert.equal((await call('max', 'GET', '/api/db?path=system')).status, 403);
    assert.equal((await call('max', 'GET', '/api/transactions')).status, 403);
    const mia = (await ok(call('mia', 'GET', '/api/auth/me'))).user;
    assert.equal(mia.firstName, 'Mia');
  });

  test('requests: no filing in another name, no self-approval, only known kinds', async () => {
    const base = { type: 'payment', personName: 'Max Test', data: { amount: 10, date: '2026-10-01' }, timestamp: Date.now() };
    const put = (who, id, value) => call(who, 'PUT', '/api/db', { path: `requests/${id}`, value: { id, ...value } });
    assert.equal((await put('max', 'r-spoof', { ...base, userId: uids.mia })).status, 403, 'in the name of someone else');
    assert.equal((await put('max', 'r-kind', { ...base, userId: uids.max, type: 'gehalt' })).status, 400, 'unknown kind');

    await ok(put('max', 'r-self', { ...base, userId: uids.max, status: 'approved', decidedAt: Date.now() }));
    const stored = await read('treasurer', 'requests/r-self');
    assert.equal(stored.status, 'pending', 'members cannot approve their own request');
    assert.ok(!stored.decidedAt);
    assert.equal((await call('max', 'PATCH', '/api/db', { path: 'requests/r-self', value: { status: 'approved' } })).status, 403);
    assert.equal((await put('mia', 'r-self', { ...base, userId: uids.mia })).status, 403, "cannot overwrite someone else's request");

    // The treasurer decides; the request stays the member's own (the pre-v3 author bug)
    await ok(call('treasurer', 'PATCH', '/api/db', { path: 'requests/r-self', value: { status: 'approved' } }));
    const approved = await read('treasurer', 'requests/r-self');
    assert.equal(approved.status, 'approved');
    assert.equal(approved.userId, uids.max);
    assert.ok(Object.values(await read('max', 'requests')).some((r) => r.id === 'r-self'), 'still in the member\'s own list');
  });

  test('uploads: only signed-in users and only pictures', async () => {
    const send = (who, filename, type, bytes = PNG) => {
      const form = new FormData();
      form.append('name', 'Max Test');
      form.append('date', '2026-10-01');
      form.append('receipt', new Blob([bytes], { type }), filename);
      return call(who, 'POST', '/api/upload', form, { form: true });
    };
    assert.equal((await send(null, 'beleg.png', 'image/png')).status, 401);
    assert.equal((await send('max', 'seite.html', 'text/html', Buffer.from('<script>alert(1)</script>'))).status, 400);
    assert.equal((await send('max', 'bild.svg', 'image/svg+xml', Buffer.from('<svg onload="alert(1)"/>'))).status, 400);
    assert.equal((await send('max', 'beleg.png.html', 'image/png')).status, 400, 'picture type with another extension');
    const { filename } = await ok(send('max', 'Beleg ../../x.PNG', 'image/png'));
    assert.match(filename, /^[0-9a-f-]{36}\.png$/, 'random stored name, nothing of the upload name');
    assert.equal((await call(null, 'GET', `/api/receipts/${filename}`)).status, 401);
  });

  test('the owner account is protected against other admins', async () => {
    await account('ida', 'Ida', { admin: true });
    const owner = uids.owner;
    for (const [method, url, body] of [
      ['PUT', `/api/admin/users/${owner}/admin`, { admin: false }],
      ['PUT', `/api/admin/users/${owner}/groups`, { groups: [] }],
      ['PUT', `/api/admin/users/${owner}/pays`, { pays: false }],
      ['PUT', `/api/admin/users/${owner}/password`, { password: 'uebernommen-123' }],
      ['DELETE', `/api/admin/users/${owner}`, undefined]
    ]) {
      const res = await call('ida', method, url, body);
      assert.ok(res.status >= 400 && res.status < 500, `${method} ${url} -> ${res.status}`);
    }
    // the generic data route must not offer a way around it (refused or ignored, the owner stays owner)
    await call('ida', 'PUT', '/api/db', { path: `users/${owner}`, value: { admin: false, owner: false } });
    const me = (await ok(call('owner', 'GET', '/api/auth/me'))).user;
    assert.equal(me.owner, true);
    assert.equal(me.admin, true);
    // the password is unchanged: the owner can still log in with it
    await ok(call(null, 'POST', '/api/auth/login', { email: 'owner@test.local', password: PASSWORD }));
  });

  test('registration needs the current invite code, never grants rights and the code is single-use', async () => {
    const code = await read('owner', 'system/inviteCode');
    const register = (email, inviteCode, extra = {}) => call(null, 'POST', '/api/auth/register', {
      email, password: PASSWORD, firstName: 'Neu', lastName: email.split('@')[0], inviteCode, ...extra
    });
    assert.equal((await register('falsch@test.local', 'nicht-der-code')).status, 403);
    assert.equal((await register('leer@test.local', '')).status, 403);
    const joined = await ok(register('neu@test.local', String(code), { admin: true, owner: true, groups: ['Admin'] }));
    tokens.neu = joined.token;
    const me = (await ok(call('neu', 'GET', '/api/auth/me'))).user;
    assert.equal(me.admin, false);
    assert.equal(me.owner, false);
    assert.equal(me.canViewFinances, false);
    assert.equal((await register('zweiter@test.local', String(code))).status, 403, 'the used code no longer works');
  });

  test('deleting an account: only with the own password, never the owner', async () => {
    await account('weg', 'Wilma');
    assert.ok((await call('owner', 'POST', '/api/auth/delete-account', { password: PASSWORD })).status >= 400, 'owner cannot delete itself');
    assert.equal((await call('weg', 'POST', '/api/auth/delete-account', { password: 'falsch' })).status, 403);
    assert.equal((await call('weg', 'POST', '/api/auth/delete-account', {})).status, 400);
    await ok(call('weg', 'POST', '/api/auth/delete-account', { password: PASSWORD }));
    assert.equal((await call(null, 'POST', '/api/auth/login', { email: 'weg@test.local', password: PASSWORD })).status, 401);
  });

  test('mentoring conversations are only readable by mentor and mentee, not even by admins', async () => {
    const mentor = await account('mentor', 'Martha');
    const mentee = await account('mentee', 'Moritz');
    const profile = await ok(call('mentor', 'POST', '/api/mentoring/apply', { bio: 'Ich höre zu', maxMentees: 2 }));
    await ok(call('owner', 'POST', `/api/mentoring/manage/${profile.mentor.id}/status`, { status: 'approved' }));
    assert.ok((await call('mentor', 'POST', '/api/mentoring/threads', { mentorId: mentor })).status >= 400, 'no conversation with oneself');

    const { threadId } = await ok(call('mentee', 'POST', '/api/mentoring/threads', { mentorId: mentor }));
    await ok(call('mentee', 'POST', `/api/mentoring/threads/${threadId}/messages`, { text: 'Streng vertraulich' }));
    const messages = (who) => call(who, 'GET', `/api/mentoring/threads/${threadId}/messages`);
    assert.match(JSON.stringify((await ok(messages('mentor')))), /Streng vertraulich/);
    for (const outsider of ['owner', 'treasurer', 'max']) {
      const res = await messages(outsider);
      assert.equal(res.status, 403, `${outsider} must not read the conversation`);
      assert.doesNotMatch(JSON.stringify(res.body), /Streng vertraulich/);
    }
    assert.equal((await call('max', 'POST', `/api/mentoring/threads/${threadId}/messages`, { text: 'Hallo?' })).status, 403);
    assert.ok(mentee);
  });

  test('songbook: only the songbook permission edits, every member reads', async () => {
    const song = { title: 'Amazing Grace', content: '[G]Amazing [C]grace, how [G]sweet the sound' };
    assert.equal((await call('max', 'POST', '/api/songs', song)).status, 403);
    const created = await ok(call('owner', 'POST', '/api/songs', song));
    assert.ok(created.id);
    assert.equal((await call('max', 'PUT', `/api/songs/${created.id}`, { ...song, title: 'Hack' })).status, 403);
    assert.equal((await call('max', 'DELETE', `/api/songs/${created.id}`)).status, 403);
    const list = await ok(call('max', 'GET', '/api/songs'));
    assert.ok(list.songs.some((s) => s.id === created.id && s.title === 'Amazing Grace'));
    assert.equal((await call('owner', 'POST', '/api/songs', { title: '', content: 'x' })).status, 400);
    await ok(call('owner', 'DELETE', `/api/songs/${created.id}`));
  });

  test('polls: one vote per person, nobody sees who voted what, only the creator (or an admin) ends it', async () => {
    const poll = await ok(call('max', 'POST', '/api/polls', { title: 'Favourite day?', options: ['Saturday', 'Sunday'], endsAt: Date.now() + 86400000 }));
    assert.ok(poll.id && poll.isMine);
    const [first] = poll.options;
    await ok(call('mia', 'POST', `/api/polls/${poll.id}/vote`, { optionIds: [first.id] }));
    assert.equal((await call('mia', 'POST', `/api/polls/${poll.id}/vote`, { optionIds: [first.id] })).status, 409);
    const listed = await ok(call('treasurer', 'GET', '/api/polls'));
    const text = JSON.stringify(listed);
    for (const who of ['max', 'mia']) assert.ok(!text.includes(uids[who]), `${who} is not visible`);
    assert.equal((await call('mia', 'POST', `/api/polls/${poll.id}/close`)).status, 403);
    assert.equal((await call('mia', 'DELETE', `/api/polls/${poll.id}`)).status, 403);
    await ok(call('max', 'POST', `/api/polls/${poll.id}/close`));
    await ok(call('owner', 'DELETE', `/api/polls/${poll.id}`));
  });

  test('polls and songs: object names and odd ids are just "not found", and nothing lives in the readable app state', async () => {
    for (const id of ['__proto__', 'constructor', 'toString', 'x%22%7C%7C1%3D1']) {
      assert.equal((await call('mia', 'POST', `/api/polls/${id}/vote`, { optionIds: ['o1'] })).status, 404, `vote ${id}`);
      assert.equal((await call('owner', 'POST', `/api/polls/${id}/close`)).status, 404, `close ${id}`);
      assert.equal((await call('owner', 'PUT', `/api/songs/${id}`, { title: 'x', content: 'y' })).status, 404, `song ${id}`);
    }
    // The list still works for everyone afterwards
    await ok(call('mia', 'GET', '/api/polls'));
    // Votes and songs are not in app_state (which admins can read): polls are only reachable through the API
    const poll = await ok(call('max', 'POST', '/api/polls', { title: 'Where to meet?', options: ['Hall', 'Garden'], endsAt: Date.now() + 86400000 }));
    for (const key of ['polls', 'songs']) {
      const response = await call('owner', 'GET', `/api/db?path=${key}`);
      const body = response.status === 200 ? await response.text() : '';
      assert.ok(!body.includes(poll.id), `${key} is not readable through /api/db`);
    }
    await ok(call('max', 'DELETE', `/api/polls/${poll.id}`));
  });

  test('malformed input gets a client error, never a crash', async () => {
    const raw = (method, url, body, type = 'application/json') => fetch(base + url, {
      method, body, headers: { 'Content-Type': type, Authorization: `Bearer ${tokens.max}` }
    }).then((r) => r.status);
    assert.equal(await raw('PUT', '/api/db', '{"path": "requests/x", "value": '), 400, 'broken JSON');
    assert.equal(await raw('PUT', '/api/db', JSON.stringify({ path: 'requests/x', value: 'x'.repeat(3 * 1024 * 1024) })), 413, 'too large');
    for (const path of ['', '../../config', '__proto__', 'people/../users', 'requests/%00']) {
      const status = (await call('max', 'GET', `/api/db?path=${encodeURIComponent(path)}`)).status;
      assert.ok(status < 500, `path "${path}" -> ${status}`);
    }
    assert.ok((await call('max', 'PUT', '/api/db', { path: 'requests/y', value: null })).status < 500);
    assert.ok((await call('max', 'POST', '/api/events', { title: '' })).status < 500);
    assert.equal((await call(null, 'POST', '/api/auth/login', {})).status >= 400, true);
    // the server is still alive after all of that
    assert.equal((await call(null, 'GET', '/api/status')).status, 200);
  });
});
