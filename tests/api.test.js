// End-to-end over HTTP: the real backend with a real PocketBase on free ports and an empty data directory.
// Needs the PocketBase binary: POCKETBASE_BIN=/path/to/pocketbase (CI downloads it; locally the test is skipped
// without it unless REQUIRE_POCKETBASE=1, which turns a missing binary into a failure).
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { REPO_ROOT, BACKEND_DIR, assertHas } = require('./helpers');
const { startFakeNextcloud } = require('./fakeNextcloud');

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
      NODE_ENV: 'test',
      // Polls are switched off by default; their API is tested here all the same
      AGORA_FEATURE_POLLS: '1'
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
    // The switch for member events is gone (every member creates events); older apps still read the settings
    assert.equal((await ok(call('max', 'GET', '/api/events/settings'))).allowMemberCreation, true);
  });

  test("a group's events reach its members (and only them), also after the group is renamed", async () => {
    const group = await ok(call('owner', 'POST', '/api/admin/groups', { name: 'Jugend', permissions: [] }));
    const jonas = await account('jonas', 'Jonas');
    await account('nora', 'Nora');
    // the account settings store the group by id, the event editor stores target groups by name
    await ok(call('owner', 'PUT', `/api/admin/users/${jonas}/groups`, { groups: [group.id] }));
    const created = await ok(call('owner', 'POST', '/api/events', { title: 'Jugendabend intern', date: '2026-11-20', startTime: '19:00', targetGroups: ['Jugend'] }));
    const id = created.event?.id || created.id;
    const sees = async (who) => {
      const list = await ok(call(who, 'GET', '/api/events'));
      return (Array.isArray(list) ? list : list.events || []).some((e) => e.id === id);
    };
    assert.equal(await sees('jonas'), true, 'the member of the group sees it');
    assert.equal(await sees('nora'), false, 'other members do not');
    await ok(call('owner', 'PUT', `/api/admin/groups/${group.id}`, { name: 'Jugendkreis' }));
    assert.equal(await sees('jonas'), true, 'still there after the rename');
    assert.equal(await sees('nora'), false, 'and still not for everyone');
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
    // a member may not set media folder rights: a fixed, translated error
    const errorFor = async (who, lang) => {
      const headers = { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' };
      if (lang) headers['Accept-Language'] = lang;
      const res = await fetch(`${base}/api/media/rules`, { method: 'PUT', headers, body: '{"path":""}' });
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

  test("registering with an unclaimed account's name never takes over a namesake's finance entry", async () => {
    // Father and son share the name; the treasury added the son without e-mail (an unclaimed account)
    await ok(call('owner', 'POST', '/api/admin/users', { firstName: 'Johann', lastName: 'Gleich', email: 'senior@test.local', password: PASSWORD, pays: true, status: 'vollverdiener', memberSince: '2015-01-01' }));
    await login('senior', 'senior@test.local');
    await ok(call('owner', 'POST', '/api/admin/users', { firstName: 'Johann', lastName: 'Gleich', pays: true, status: 'keinverdiener', memberSince: '2026-09-01' }));
    // The son registers himself and claims his account
    const inviteCode = await read('owner', 'system/inviteCode');
    const junior = await ok(call(null, 'POST', '/api/auth/register', { email: 'junior@test.local', password: PASSWORD, firstName: 'Johann', lastName: 'Gleich', inviteCode }));
    tokens.junior = junior.token;
    const own = async (who) => Object.values(await read(who, 'people')).map((p) => p.memberSince);
    assert.deepEqual(await own('senior'), ['2015-01-01'], "the father keeps his entry");
    assert.deepEqual(await own('junior'), ['2026-09-01'], "the son sees only his own entry, not his father's payments");
  });

  test('two bookings for the same member at the same time: neither one is lost', async () => {
    const key = await account('lea', 'Lea');
    const latest = (who) => ok(call(who, 'GET', `/api/db?path=people/${key}&raw=1`));
    // what runTransaction sends: the record it read plus one payment, with the version it read
    const book = (who, raw, id, amount) => call(who, 'POST', '/api/db/transaction', {
      path: `people/${key}`, currentVersion: raw.version,
      value: { ...raw.value, payments: [...Object.values(raw.value.payments || {}), { id, amount, date: '2026-10-02', description: id }] }
    });
    // Both treasurers opened the record before either one booked
    const [a, b] = [await latest('treasurer'), await latest('owner')];
    assert.ok(a.version, 'person records have a version');
    await ok(book('treasurer', a, 'cash', 50));
    assert.equal((await book('owner', b, 'bank', 75)).status, 409, 'the second booking has to start from the new state');
    await ok(book('owner', await latest('owner'), 'bank', 75));
    // Exactly at the same moment: one is booked, the other one is told to try again (never both "booked")
    const now = await latest('treasurer');
    const results = await Promise.all([book('treasurer', now, 'card', 20), book('owner', now, 'box', 5)]);
    const booked = ['card', 'box'].filter((id, i) => results[i].status === 200);
    assert.equal(booked.length, 1, `statuses ${results.map((r) => r.status)}`);
    const payments = (await read('treasurer', `people/${key}`)).payments.map((p) => p.id).sort();
    assert.deepEqual(payments, ['bank', 'cash', ...booked].sort());
  });

  test('a decided request stays decided: an outdated screen cannot reject a booked request', async () => {
    const id = `r-decided-${Date.now()}`;
    await ok(call('max', 'PUT', '/api/db', { path: `requests/${id}`, value: { id, type: 'payment', userId: uids.max, personName: 'Max Test', data: { amount: 10, date: '2026-10-01' }, timestamp: Date.now() } }));
    await ok(call('treasurer', 'PATCH', '/api/db', { path: `requests/${id}`, value: { status: 'approved' } }));
    // the owner still has the request open on another screen
    await call('owner', 'PATCH', '/api/db', { path: `requests/${id}`, value: { status: 'rejected', rejectionReason: 'Doppelt' } });
    assert.equal((await read('treasurer', `requests/${id}`)).status, 'approved');
    await ok(call('owner', 'PATCH', '/api/db', { path: `requests/${id}`, value: { status: 'approved' } }));
  });

  test('an approval and a rejection at the same moment: exactly one decision is made', async () => {
    const id = `r-race-${Date.now()}`;
    await ok(call('max', 'PUT', '/api/db', { path: `requests/${id}`, value: { id, type: 'payment', userId: uids.max, personName: 'Max Test', data: { amount: 10, date: '2026-10-01' }, timestamp: Date.now() } }));
    const [approve, reject] = await Promise.all([
      call('treasurer', 'PATCH', '/api/db', { path: `requests/${id}`, value: { status: 'approved' } }),
      call('owner', 'PATCH', '/api/db', { path: `requests/${id}`, value: { status: 'rejected', rejectionReason: 'Doppelt' } })
    ]);
    const won = [approve, reject].filter((r) => r.status === 200);
    assert.equal(won.length, 1, `statuses ${approve.status}/${reject.status}`);
    assert.equal((await read('treasurer', `requests/${id}`)).status, approve.status === 200 ? 'approved' : 'rejected');
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

  test('deleting an account also removes its prayer requests, the anonymous ones too', async () => {
    await account('gebet', 'Greta');
    const named = await ok(call('gebet', 'POST', '/api/prayers', { text: 'Bitte betet für meine Operation', duration: 'quarter' }));
    const anonymous = await ok(call('gebet', 'POST', '/api/prayers', { text: 'Bitte betet für meine Familie', anonymous: true, duration: 'week' }));
    const shown = async () => (await ok(call('mia', 'GET', '/api/prayers'))).prayers.map((p) => p.id);
    assert.ok((await shown()).includes(named.id));
    await ok(call('gebet', 'POST', '/api/auth/delete-account', { password: PASSWORD }));
    const left = await shown();
    assert.ok(!left.includes(named.id), 'her name and request are no longer shown to everyone');
    assert.ok(!left.includes(anonymous.id));
  });

  test('deleting a duplicate finance entry keeps the account; deleting the last one removes it', async () => {
    const ben = await account('ben', 'Ben');
    const hasAccount = async () => (await ok(call('owner', 'GET', '/api/admin/users'))).some((u) => u.uid === ben);
    await ok(call('owner', 'PUT', '/api/db', { path: 'people/ben-duplicate', value: {
      id: 'ben-duplicate', uid: ben, name: 'Ben Test', status: 'vollverdiener', memberSince: '2026-05-26', payments: [], statusHistory: []
    } }));
    await ok(call('owner', 'DELETE', '/api/db', { path: 'people/ben-duplicate' }));
    assert.ok(await hasAccount(), 'the account stays: the other entry still uses it');
    assert.equal((await read('owner', `people/${ben}`)).uid, ben);

    await ok(call('owner', 'DELETE', '/api/db', { path: `people/${ben}` }));
    assert.equal(await hasAccount(), false, 'the account goes with its last entry');
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

  test('page addresses: deep paths get the app (with <base href>), files and the API stay what they are', async () => {
    for (const page of ['/events/Jugendfreizeit_2026', '/settings/profile', '/songbook/Gro%C3%9Fer_Gott', '/mentoring/chat/abc']) {
      const res = await fetch(base + page, { headers: { 'X-Forwarded-For': '10.42.9.1' } });
      assert.equal(res.status, 200, page);
      const html = await res.text();
      assert.ok(html.includes('<base href="/">'), `${page} has the base address`);
    }
    const js = await fetch(base + '/assets/app.js');
    assert.match(js.headers.get('content-type') || '', /javascript/);
    const api = await fetch(base + '/api/does-not-exist');
    assert.ok(!(api.headers.get('content-type') || '').includes('text/html') || api.status === 404, 'the API never answers with the app');
  });

  test('prayer requests: anonymous stays anonymous for everyone, only the owner changes it, the owner or a moderator removes it', async () => {
    const shared = await ok(call('max', 'POST', '/api/prayers', { text: 'Bitte betet für meine Oma', anonymous: true, duration: 'week' }));
    assert.equal(shared.isMine, true);
    const seen = (await ok(call('mia', 'GET', '/api/prayers'))).prayers.find((p) => p.id === shared.id);
    assert.ok(seen && seen.author === null && seen.isMine === false);
    // Not even the owner (admin, moderator) can tell who it was
    assert.ok(!JSON.stringify(await ok(call('owner', 'GET', '/api/prayers'))).includes(uids.max));
    assert.equal((await call('mia', 'PATCH', `/api/prayers/${shared.id}`, { extend: 'month' })).status, 403);
    assert.equal((await call('mia', 'DELETE', `/api/prayers/${shared.id}`)).status, 403);
    const extended = await ok(call('max', 'PATCH', `/api/prayers/${shared.id}`, { extend: 'month' }));
    assert.ok(extended.expiresAt > shared.expiresAt);
    // Named requests show their author; moderators (manage_prayers, the owner's Admin group) remove any request
    const named = await ok(call('mia', 'POST', '/api/prayers', { text: 'Für die Freizeit' }));
    assert.equal((await ok(call('max', 'GET', '/api/prayers'))).prayers.find((p) => p.id === named.id).author.uid, uids.mia);
    await ok(call('owner', 'DELETE', `/api/prayers/${named.id}`));
    await ok(call('max', 'DELETE', `/api/prayers/${shared.id}`));
    for (const id of ['__proto__', 'x%22%7C%7C1']) assert.equal((await call('mia', 'DELETE', `/api/prayers/${id}`)).status, 404, id);
  });

  test('order of service: the duty team sees it, the editors of the event plan it, it goes with the event', async () => {
    const created = await ok(call('owner', 'POST', '/api/events', { title: 'Gottesdienst', date: '2026-11-08', startTime: '10:00', endTime: '11:30', eventType: 'termin' }));
    const id = created.id || created.event?.id || created.events?.[0]?.id;
    const song = await ok(call('owner', 'POST', '/api/songs', { title: 'Amazing Grace', key: 'G', content: '[G]Amazing grace' }));
    const items = [{ title: 'Begrüßung', minutes: 5, who: 'Olga' }, { songId: song.id, songKey: 'A', minutes: 4 }];
    assert.equal((await call('max', 'PUT', `/api/events/${id}/program`, { items })).status, 403);
    const saved = await ok(call('owner', 'PUT', `/api/events/${id}/program`, { items }));
    assert.equal(saved.items.length, 2);
    assert.equal((await call('mia', 'GET', `/api/events/${id}/program`)).status, 403, 'not on the duty roster');
    await ok(call('owner', 'POST', `/api/events/${id}/duties`, { roleName: 'Technik', requestedUser: uids.mia }));
    const seen = await ok(call('mia', 'GET', `/api/events/${id}/program`));
    assert.deepEqual(seen.items.map((i) => i.minutes), [5, 4]);
    assert.equal(seen.items[1].songKey, 'A');
    assert.equal(seen.canEdit, false);
    assert.equal((await call('mia', 'PUT', `/api/events/${id}/program`, { items: [] })).status, 403);
    assert.equal((await call('owner', 'PUT', `/api/events/${id}/program`, { items: [{ title: '' }] })).status, 400);
    assert.equal((await call('owner', 'GET', '/api/events/__proto__/program')).status, 404);
    await ok(call('owner', 'DELETE', `/api/events/${id}`));
    assert.equal((await call('owner', 'GET', `/api/events/${id}/program`)).status, 404);
    await ok(call('owner', 'DELETE', `/api/songs/${song.id}`));
  });

  test('event pictures: a removed or replaced picture and the picture of a deleted event leave the disk', async () => {
    const uploadPicture = async () => {
      const form = new FormData();
      form.append('image', new Blob([PNG], { type: 'image/png' }), 'cover.png');
      return (await ok(call('owner', 'POST', '/api/events/upload-image', form, { form: true }))).url;
    };
    const stored = (url) => fs.existsSync(path.join(dataRoot, 'data', 'event-images', url.split('/').pop()));
    const first = await uploadPicture();
    const unsaved = await uploadPicture();
    // A recurring series shares one picture: it stays while one date still shows it
    await ok(call('owner', 'POST', '/api/events', { title: 'Bilderserie', date: '2026-12-01', isRecurring: true, recurringRule: 'weekly', recurringCount: 2, imageUrl: first }));
    const list = await ok(call('owner', 'GET', '/api/events'));
    const [a, b] = (Array.isArray(list) ? list : list.events || []).filter((e) => e.title === 'Bilderserie');
    assert.ok(a && b, 'both dates of the series');
    await ok(call('owner', 'PATCH', `/api/events/${a.id}`, { imageUrl: '' }));
    assert.ok(stored(first), 'the other date still shows it');
    assert.equal((await call(null, 'GET', first)).status, 200);
    const second = await uploadPicture();
    await ok(call('owner', 'PATCH', `/api/events/${b.id}`, { imageUrl: second }));
    assert.ok(!stored(first), 'replaced on the last date: gone');
    assert.equal((await call(null, 'GET', first)).status, 404);
    await ok(call('owner', 'PATCH', `/api/events/${b.id}`, { title: 'Bilderserie neu' }));
    assert.ok(stored(second), 'other changes keep the picture');
    await ok(call('owner', 'DELETE', `/api/events/${b.id}`));
    assert.ok(!stored(second), 'deleted with its event');
    assert.ok(stored(unsaved), 'a fresh upload whose dialog may still be open stays');
    await ok(call('owner', 'DELETE', `/api/events/${a.id}`));
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

  // --- Sharing an event: the switch, the public page and guests without an account ---
  const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const eventBy = async (who, payload) => {
    const created = await ok(call(who, 'POST', '/api/events', payload));
    return created.event?.id || created.id;
  };
  const listed = async (who, id) => (await ok(call(who, 'GET', '/api/events'))).find((e) => e.id === id);
  // People without an account, each from an own address (the sign-up limit per address stays out of the way)
  let visitors = 0;
  async function visitor(method, url, body) {
    visitors += 1;
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.43.${Math.floor(visitors / 250)}.${(visitors % 250) + 1}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* text body */ }
    return { status: res.status, body: parsed, headers: res.headers };
  }
  const guestPlaces = async (...keys) => (await visitor('POST', '/api/public/guests/lookup', { keys })).body.registrations;

  test('sharing: only who may edit the event switches the link on; it shows what, when and where - nothing else', async () => {
    const id = await eventBy('owner', { title: 'Gemeindefest', date: inDays(20), startTime: '15:00', location: 'Gemeindehaus', description: 'Mit Kuchen', requiresRegistration: true, maxParticipants: 2 });
    assert.equal((await call('max', 'PATCH', `/api/events/${id}`, { isPublic: true })).status, 403, 'members who may not edit it');
    assertHas(await listed('mia', id), { isPublic: false, publicToken: '' });
    await ok(call('owner', 'PATCH', `/api/events/${id}`, { isPublic: true }));
    const shared = await listed('mia', id);
    assert.equal(shared.isPublic, true);
    assert.match(shared.publicToken, /^[A-Za-z0-9_-]{22}$/, 'everyone who sees the event can share the link');

    const page = await visitor('GET', `/api/public/events/${shared.publicToken}`);
    assert.equal(page.status, 200);
    assertHas(page.body, { title: 'Gemeindefest', location: 'Gemeindehaus', startTime: '15:00', requiresRegistration: true, maxParticipants: 2, registeredCount: 0, registrationOpen: true });
    const text = JSON.stringify(page.body);
    for (const secret of [id, uids.owner, 'Olga', shared.publicToken]) assert.ok(!text.includes(secret), `no ${secret}`);

    // Off: the link stops working. On again: the links shared before work again
    await ok(call('owner', 'PATCH', `/api/events/${id}`, { isPublic: false }));
    assert.equal((await visitor('GET', `/api/public/events/${shared.publicToken}`)).status, 404);
    assert.equal((await listed('mia', id)).publicToken, '');
    await ok(call('owner', 'PATCH', `/api/events/${id}`, { isPublic: true }));
    assert.equal((await listed('mia', id)).publicToken, shared.publicToken);
    // Whoever created an event may share it too
    const own = await eventBy('max', { title: 'Spieleabend', date: inDays(21) });
    await ok(call('max', 'PATCH', `/api/events/${own}`, { isPublic: true }));
    assert.equal((await listed('max', own)).isPublic, true);
    for (const token of ['nope', '__proto__', 'x'.repeat(22), `${shared.publicToken}" || "1"="1`]) {
      assert.equal((await visitor('GET', `/api/public/events/${encodeURIComponent(token)}`)).status, 404, token);
    }
    await ok(call('owner', 'DELETE', `/api/events/${id}`));
    await ok(call('max', 'DELETE', `/api/events/${own}`));
  });

  test('guests: sign up without an account, share the places with members, wait and move up', async () => {
    const id = await eventBy('owner', { title: 'Grillabend', date: inDays(14), startTime: '18:00', requiresRegistration: true, maxParticipants: 2 });
    await ok(call('owner', 'PATCH', `/api/events/${id}`, { isPublic: true }));
    const token = (await listed('owner', id)).publicToken;
    const signUp = (body) => visitor('POST', `/api/public/events/${token}/register`, body);
    assert.equal((await signUp({ name: 'A', email: 'anna@example.org', age: 34 })).status, 400, 'full name');
    assert.equal((await signUp({ name: 'Anna Gast', email: 'anna@', age: 34 })).status, 400, 'e-mail address');
    assert.equal((await signUp({ name: 'Anna Gast', email: 'anna@example.org', age: 'vierunddreißig' })).status, 400, 'age as a number');
    assert.equal((await signUp({ name: 'Anna Gast', email: 'anna@example.org', age: 34, website: 'https://spam.example' })).status, 400, 'the field only bots fill in');

    const anna = await signUp({ name: 'Anna Gast', email: 'anna@example.org', age: 34 });
    assert.equal(anna.status, 201);
    assertHas(anna.body, { name: 'Anna Gast', status: 'registered' });
    assert.match(anna.body.key, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(anna.body.event.registeredCount, 1);
    assert.equal((await signUp({ name: 'anna  gast', email: 'ANNA@example.org', age: 34 })).status, 409, 'the same person twice');
    await ok(call('max', 'POST', `/api/events/${id}/register`, { action: 'register' }));
    // A parent signs up a child with their own address: full, members and guests share the places
    const ben = await signUp({ name: 'Ben Gast', email: 'anna@example.org', age: 9 });
    assert.equal(ben.body.status, 'waitlist');
    assertHas(await listed('mia', id), { registeredCount: 2, waitlistCount: 1, isFull: true });

    // Everyone sees who comes; how to reach a guest and their age only those who may edit the event
    const seenByMember = await ok(call('mia', 'GET', `/api/events/${id}/attendees`));
    const annaRow = seenByMember.registered.find((p) => p.name === 'Anna Gast');
    assertHas(annaRow, { guest: true, userId: `guest:${annaRow.id}` });
    assert.equal('email' in annaRow || 'age' in annaRow, false);
    assert.deepEqual(seenByMember.waitlist.map((p) => p.name), ['Ben Gast']);
    assertHas((await ok(call('owner', 'GET', `/api/events/${id}/attendees`))).registered.find((p) => p.guest), { email: 'anna@example.org', age: 34 });

    // A member's place frees up: the waiting guest moves up
    await ok(call('max', 'POST', `/api/events/${id}/register`, { action: 'cancel' }));
    assert.deepEqual((await guestPlaces(ben.body.key)).map((r) => r.status), ['registered']);
    const [annasPlace] = await guestPlaces(anna.body.key, 'not-a-key', anna.body.key);
    assertHas(annasPlace, { name: 'Anna Gast', status: 'registered', shareToken: token });
    assert.equal(annasPlace.event.title, 'Grillabend');

    // A guest's place frees up: the waiting member moves up
    assert.equal((await ok(call('mia', 'POST', `/api/events/${id}/register`, { action: 'register' }))).status, 'waitlist');
    assert.equal((await visitor('POST', '/api/public/guests/cancel', { key: anna.body.key })).status, 200);
    assert.equal((await visitor('POST', '/api/public/guests/cancel', { key: anna.body.key })).status, 404, 'cancelled is gone');
    assert.deepEqual(await guestPlaces(anna.body.key), []);
    assert.equal((await listed('mia', id)).myRegistration.status, 'registered');

    // The organisers remove a guest, other members cannot
    const benRow = (await ok(call('owner', 'GET', `/api/events/${id}/attendees`))).registered.find((p) => p.name === 'Ben Gast');
    assert.equal((await call('mia', 'DELETE', `/api/events/${id}/attendees/${benRow.userId}`)).status, 403);
    await ok(call('owner', 'DELETE', `/api/events/${id}/attendees/${benRow.userId}`));
    assert.deepEqual(await guestPlaces(ben.body.key), []);
    for (const odd of ['guest:missing123', 'guest:..%2Fx', 'guest:']) {
      assert.equal((await call('owner', 'DELETE', `/api/events/${id}/attendees/${odd}`)).status, 404, odd);
    }
    await ok(call('owner', 'DELETE', `/api/events/${id}`));
  });

  test('guests: nothing to sign up for, cancelled or over; a switched-off link; more places; a deleted event', async () => {
    const carla = { name: 'Carla Gast', email: 'carla@example.org', age: 51 };
    const open = await eventBy('owner', { title: 'Offener Abend', date: inDays(10) });
    await ok(call('owner', 'PATCH', `/api/events/${open}`, { isPublic: true }));
    const openToken = (await listed('owner', open)).publicToken;
    assertHas((await visitor('GET', `/api/public/events/${openToken}`)).body, { requiresRegistration: false, registrationOpen: false });
    assert.equal((await visitor('POST', `/api/public/events/${openToken}/register`, carla)).status, 400, 'no registration');
    await ok(call('owner', 'PATCH', `/api/events/${open}`, { requiresRegistration: true, status: 'cancelled' }));
    assert.equal((await visitor('GET', `/api/public/events/${openToken}`)).body.status, 'cancelled');
    assert.equal((await visitor('POST', `/api/public/events/${openToken}/register`, carla)).status, 400, 'cancelled');
    await ok(call('owner', 'DELETE', `/api/events/${open}`));

    const past = await eventBy('owner', { title: 'Vorbei', date: inDays(-2), requiresRegistration: true });
    await ok(call('owner', 'PATCH', `/api/events/${past}`, { isPublic: true }));
    const pastToken = (await listed('owner', past)).publicToken;
    assertHas((await visitor('GET', `/api/public/events/${pastToken}`)).body, { isPast: true, registrationOpen: false });
    assert.equal((await visitor('POST', `/api/public/events/${pastToken}/register`, carla)).status, 400, 'over');
    await ok(call('owner', 'DELETE', `/api/events/${past}`));

    // One place: Carla gets it, Dana waits; a second place lets Dana move up
    const small = await eventBy('owner', { title: 'Kleiner Kreis', date: inDays(12), requiresRegistration: true, maxParticipants: 1 });
    await ok(call('owner', 'PATCH', `/api/events/${small}`, { isPublic: true }));
    const smallToken = (await listed('owner', small)).publicToken;
    const first = (await visitor('POST', `/api/public/events/${smallToken}/register`, carla)).body;
    const second = (await visitor('POST', `/api/public/events/${smallToken}/register`, { name: 'Dana Gast', email: 'dana@example.org', age: 23 })).body;
    assert.deepEqual([first.status, second.status], ['registered', 'waitlist']);
    await ok(call('owner', 'PATCH', `/api/events/${small}`, { maxParticipants: 2 }));
    assert.deepEqual((await guestPlaces(second.key)).map((r) => r.status), ['registered'], 'more places: the waiting list moves up');

    // Switched off: no new guests, but Carla still sees her place (without the share link) and can cancel it
    await ok(call('owner', 'PATCH', `/api/events/${small}`, { isPublic: false }));
    assert.equal((await visitor('GET', `/api/public/events/${smallToken}`)).status, 404);
    assert.equal((await visitor('POST', `/api/public/events/${smallToken}/register`, { name: 'Emil Gast', email: 'emil@example.org', age: 30 })).status, 404);
    const [carlasPlace] = await guestPlaces(first.key);
    assertHas(carlasPlace, { status: 'registered', shareToken: '' });
    assert.equal(carlasPlace.event.title, 'Kleiner Kreis');
    // Deleting the event deletes its guests
    await ok(call('owner', 'DELETE', `/api/events/${small}`));
    assert.deepEqual(await guestPlaces(first.key, second.key), []);
    assert.equal((await visitor('POST', '/api/public/guests/cancel', { key: second.key })).status, 404);
  });

  test('guests: one e-mail address signs up a family, not a flood', async () => {
    const id = await eventBy('owner', { title: 'Familientag', date: inDays(16), requiresRegistration: true });
    await ok(call('owner', 'PATCH', `/api/events/${id}`, { isPublic: true }));
    const token = (await listed('owner', id)).publicToken;
    for (let i = 1; i <= 10; i++) {
      const res = await visitor('POST', `/api/public/events/${token}/register`, { name: `Kind Nummer ${i}`, email: 'eltern@example.org', age: i });
      assert.equal(res.status, 201, `child ${i}`);
    }
    const eleventh = await visitor('POST', `/api/public/events/${token}/register`, { name: 'Kind Nummer 11', email: 'ELTERN@example.org', age: 11 });
    assert.equal(eleventh.status, 400);
    assert.equal((await visitor('POST', `/api/public/events/${token}/register`, { name: 'Kind Nummer 11', email: 'a@example.org,b@example.org', age: 11 })).status, 400, 'one recipient per address');
    assert.equal((await listed('owner', id)).registeredCount, 10);
    await ok(call('owner', 'DELETE', `/api/events/${id}`));
  });

  test('share links: the page carries the event for link previews only while it is shared', async () => {
    const id = await eventBy('owner', { title: 'Lobpreis <Nacht>', date: inDays(30), startTime: '19:30', location: 'Kirche' });
    await ok(call('owner', 'PATCH', `/api/events/${id}`, { isPublic: true }));
    const token = (await listed('owner', id)).publicToken;
    const page = async (url) => {
      const res = await fetch(base + url, { headers: { 'X-Forwarded-For': '10.42.9.2' } });
      return { status: res.status, html: await res.text(), robots: res.headers.get('x-robots-tag') || '' };
    };
    const shared = await page(`/events/Lobpreis_Nacht?share=${token}`);
    assert.equal(shared.status, 200);
    assert.ok(shared.html.includes('<base href="/">') && shared.html.includes('app.js'), 'still the app');
    assert.match(shared.html, /<title>Lobpreis &lt;Nacht&gt; · Testgemeinde<\/title>/);
    assert.match(shared.html, /property="og:title" content="Lobpreis &lt;Nacht&gt;"/);
    assert.match(shared.html, /property="og:description" content="[^"]*19:30 · Kirche"/);
    assert.match(shared.robots, /noindex/);
    await ok(call('owner', 'PATCH', `/api/events/${id}`, { isPublic: false }));
    const off = await page(`/events/Lobpreis_Nacht?share=${token}`);
    assert.equal(off.status, 200);
    assert.ok(!off.html.includes('Lobpreis') && !off.html.includes('og:title'), 'switched off: nothing of the event');
    assert.ok(!(await page(`/events/x?share=${'A'.repeat(22)}`)).html.includes('og:title'));
    await ok(call('owner', 'DELETE', `/api/events/${id}`));
  });

  test('signing up without an account is limited per address', async () => {
    const statuses = [];
    for (let i = 0; i < 31; i++) {
      const res = await fetch(`${base}/api/public/events/${'B'.repeat(22)}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.44.0.1' }, body: '{}'
      });
      statuses.push(res.status);
    }
    assert.equal(statuses[0], 404);
    assert.equal(statuses[30], 429);
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

  // --- Media: a Nextcloud folder as a library, rights decided by Agora ---
  describe('media', () => {
    let cloud;
    let jugend;
    const settings = (extra = {}) => ({ enabled: true, url: cloud.url, user: cloud.user, password: cloud.password, root: 'Agora', ...extra });
    const list = (who, folder) => call(who, 'GET', `/api/media/list?path=${encodeURIComponent(folder)}`);
    const names = (entries) => entries.map((entry) => entry.name).sort();
    const rules = (folder, groups) => call('owner', 'PUT', '/api/media/rules', { path: folder, groups });
    const upload = (who, folder, files) => {
      const form = new FormData();
      for (const [name, text, type] of files) form.append('files', new Blob([text], { type }), name);
      return call(who, 'POST', `/api/media/upload?path=${encodeURIComponent(folder)}`, form, { form: true });
    };

    before(async () => {
      cloud = await startFakeNextcloud();
      cloud.addFile('Outside/secret.txt', 'not for Agora', 'text/plain');
      cloud.addFile('Agora/willkommen.pdf', '%PDF-1.4 hello', 'application/pdf');
      cloud.addFile('Agora/Fotos/Sommer.jpg', 'jpeg-bytes-0123456789', 'image/jpeg');
      cloud.addFile('Agora/Fotos/logo.svg', '<svg onload="alert(1)"/>', 'image/svg+xml');
      cloud.addFile('Agora/Fotos/.nomedia', '', 'application/octet-stream');
      cloud.addFile('Agora/Fotos/Privat/geheim.jpg', 'secret', 'image/jpeg');
      cloud.addDir('Agora/Fotos/Jugend');
      cloud.addFile('Agora/Intern/notiz.txt', 'intern', 'text/plain');
      cloud.addFile('Agora/Intern/Leitung/plan.pdf', '%PDF-1.4 plan', 'application/pdf');
      jugend = await ok(call('owner', 'POST', '/api/admin/groups', { name: 'Medien-Jugend', permissions: [] }));
      jugend = jugend.id || jugend.group?.id;
      await account('jule', 'Jule');
      await ok(call('owner', 'PUT', `/api/admin/users/${uids.jule}/groups`, { groups: [jugend] }));
    });
    after(() => cloud?.close());

    test('the connection: only administrators set it up, the password never leaves the server', async () => {
      assert.equal((await call('max', 'GET', '/api/admin/media-config')).status, 403);
      assert.equal((await call('max', 'PUT', '/api/admin/media-config', settings())).status, 403);
      assert.deepEqual(await ok(call('max', 'GET', '/api/media/status')), { enabled: false, canManage: false, hasAccess: false });
      assert.equal((await list('owner', '')).status, 503);

      const wrong = await call('owner', 'POST', '/api/admin/media-config/test', settings({ password: 'falsch' }));
      assert.equal(wrong.status, 502);
      assert.match(wrong.body.error, /login/);
      assert.equal((await call('owner', 'POST', '/api/admin/media-config/test', settings({ root: 'Gibtsnicht' }))).status, 400);
      const tested = await ok(call('owner', 'POST', '/api/admin/media-config/test', settings()));
      assert.deepEqual(tested.folders, ['Fotos', 'Intern']);
      // switched on only with everything filled in
      assert.equal((await call('owner', 'PUT', '/api/admin/media-config', settings({ password: '' }))).status, 400);
      // pasted from the browser: the Files app's address is cut back to the server
      await ok(call('owner', 'PUT', '/api/admin/media-config', settings({ url: `${cloud.url}/index.php/apps/files/`, root: '/Agora/' })));

      const stored = await ok(call('owner', 'GET', '/api/admin/media-config'));
      assert.deepEqual(stored, { enabled: true, url: cloud.url, user: 'bot', password: '***', root: 'Agora' });
      const state = await call('owner', 'GET', '/api/db?path=media');
      assert.ok(!JSON.stringify(state.body).includes(cloud.password), 'not readable in the app state');
      // a new address needs the password again; the stored one keeps working for the same address
      assert.equal((await call('owner', 'PUT', '/api/admin/media-config', settings({ url: 'https://evil.example', password: '***' }))).status, 400);
      await ok(call('owner', 'POST', '/api/admin/media-config/test', settings({ password: '***' })));
      await ok(call('owner', 'PUT', '/api/admin/media-config', settings({ password: '***' })));
    });

    test('without rules nobody sees anything; extended media rights see everything', async () => {
      assert.deepEqual(await ok(call('max', 'GET', '/api/media/status')), { enabled: true, canManage: false, hasAccess: false });
      assert.equal((await list('max', '')).status, 404);
      // the owner's Admin group got the new permission
      assert.deepEqual(await ok(call('owner', 'GET', '/api/media/status')), { enabled: true, canManage: true, hasAccess: true });
      const root = await ok(list('owner', ''));
      assert.equal(root.access, 'write');
      assert.deepEqual(names(root.folders), ['Fotos', 'Intern']);
      assert.deepEqual(names(root.files), ['willkommen.pdf']);
      assert.equal(root.files[0].kind, 'pdf');
      const fotos = await ok(list('owner', 'Fotos'));
      assert.deepEqual(names(fotos.files), ['logo.svg', 'Sommer.jpg'].sort(), 'dot files are left out');
      assert.equal(fotos.files.find((f) => f.name === 'Sommer.jpg').hasPreview, true);
      assert.ok(fotos.files.every((f) => f.path.startsWith('Fotos/') && f.etag));
    });

    test('rules: read, write and hide per group, inherited by the folders below', async () => {
      assert.equal((await call('max', 'GET', '/api/media/rules')).status, 403);
      assert.equal((await rules('Fotos', { '*': 'admin' })).status, 400);
      assert.equal((await rules('Fotos', { nogroup: 'read' })).status, 400);
      assert.equal((await rules('../Outside', { '*': 'read' })).status, 400);
      await ok(rules('Fotos', { '*': 'read' }));
      await ok(rules('Fotos/Privat', { '*': 'hide' }));
      await ok(rules('Fotos/Jugend', { [jugend]: 'write' }));
      await ok(rules('Intern/Leitung', { [jugend]: 'read' }));

      // every member: Fotos and what is in it, not the hidden folder, not Intern
      assert.deepEqual(await ok(call('max', 'GET', '/api/media/status')), { enabled: true, canManage: false, hasAccess: true });
      const root = await ok(list('max', ''));
      assert.equal(root.access, 'none');
      assert.deepEqual(names(root.folders), ['Fotos']);
      assert.deepEqual(root.files, [], 'files of a folder without access stay invisible');
      const fotos = await ok(list('max', 'Fotos'));
      assert.equal(fotos.access, 'read');
      assert.deepEqual(names(fotos.folders), ['Jugend']);
      assert.equal(fotos.folders[0].access, 'read', 'inherited from Fotos');
      for (const hidden of ['Fotos/Privat', 'Intern', 'Intern/Leitung']) assert.equal((await list('max', hidden)).status, 404, hidden);

      // the youth group: writes in its folder, passes through Intern to Leitung without seeing Intern's files
      const jule = await ok(list('jule', ''));
      assert.deepEqual(names(jule.folders), ['Fotos', 'Intern']);
      assert.equal(jule.folders.find((f) => f.name === 'Intern').access, 'none');
      const intern = await ok(list('jule', 'Intern'));
      assert.deepEqual(names(intern.folders), ['Leitung']);
      assert.deepEqual(intern.files, []);
      assert.equal((await ok(list('jule', 'Fotos/Jugend'))).access, 'write');

      // managers see the rules on the folders; the rights dialog shows what comes from above
      const managed = await ok(list('owner', 'Fotos'));
      assert.deepEqual(managed.folders.find((f) => f.name === 'Privat').hiddenFor, ['*']);
      const dialog = await ok(call('owner', 'GET', '/api/media/rules?path=Fotos/Jugend'));
      assert.deepEqual(dialog.folder.own, { [jugend]: 'write' });
      assert.deepEqual(dialog.folder.inherited, { '*': { level: 'read', from: 'Fotos' } });
      assert.ok(dialog.groups.some((g) => g.id === '*') && dialog.groups.some((g) => g.id === jugend));
      assert.equal(dialog.rules.length, 4);
    });

    test('previews and files: only from readable folders, unsafe types only as a download', async () => {
      const preview = await call('max', 'GET', '/api/media/preview?path=Fotos/Sommer.jpg&size=300&crop=1&v=abc');
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get('content-type'), 'image/png');
      assert.match(preview.headers.get('cache-control'), /immutable/);
      const asked = cloud.requests.filter((r) => r.path === '/index.php/core/preview.png').at(-1);
      assert.deepEqual([asked.query.file, asked.query.x, asked.query.a], ['/Agora/Fotos/Sommer.jpg', '512', '0'], 'next fixed size, square');
      assert.equal((await call('max', 'GET', '/api/media/preview?path=Fotos/logo.svg&size=256')).status, 404, 'no preview');
      for (const hidden of ['Fotos/Privat/geheim.jpg', 'Intern/notiz.txt', '../Outside/secret.txt', 'Fotos/../Outside/secret.txt']) {
        const status = (await call('max', 'GET', `/api/media/file?path=${encodeURIComponent(hidden)}`)).status;
        assert.ok(status === 404 || status === 400, `${hidden} -> ${status}`);
      }

      const photo = await call('max', 'GET', '/api/media/file?path=Fotos/Sommer.jpg');
      assert.equal(photo.status, 200);
      assert.equal(photo.body, 'jpeg-bytes-0123456789');
      assert.match(photo.headers.get('content-disposition'), /^inline;/);
      assert.match(photo.headers.get('content-security-policy'), /sandbox/);
      const part = await fetch(`${base}/api/media/file?path=Fotos/Sommer.jpg`, { headers: { Authorization: `Bearer ${tokens.max}`, Range: 'bytes=0-3' } });
      assert.equal(part.status, 206);
      assert.equal(await part.text(), 'jpeg');
      const svg = await call('max', 'GET', '/api/media/file?path=Fotos/logo.svg');
      assert.equal(svg.headers.get('content-type'), 'application/octet-stream');
      assert.match(svg.headers.get('content-disposition'), /^attachment;/);
      const pdf = await call('jule', 'GET', `/api/media/file?path=${encodeURIComponent('Intern/Leitung/plan.pdf')}`);
      assert.equal(pdf.headers.get('content-type'), 'application/pdf');
      assert.equal(pdf.headers.get('content-security-policy'), null, 'the PDF viewers need no sandbox');
      const download = await call('jule', 'GET', `/api/media/file?path=${encodeURIComponent('Intern/Leitung/plan.pdf')}&download=1`);
      assert.match(download.headers.get('content-disposition'), /^attachment; filename="plan.pdf"/);
    });

    test('adding: files and folders where the group may write; nothing is ever replaced or deleted', async () => {
      assert.equal((await upload('max', 'Fotos/Jugend', [['a.jpg', 'x', 'image/jpeg']])).status, 403);
      assert.equal((await upload('max', 'Fotos/Privat', [['a.jpg', 'x', 'image/jpeg']])).status, 404);
      const first = await ok(upload('jule', 'Fotos/Jugend', [['Freizeit.jpg', 'one', 'image/jpeg'], ['Grüße.txt', 'hallo', 'text/plain']]));
      assert.deepEqual(first.files.map((f) => f.path), ['Fotos/Jugend/Freizeit.jpg', 'Fotos/Jugend/Grüße.txt']);
      const second = await ok(upload('jule', 'Fotos/Jugend', [['Freizeit.jpg', 'two', 'image/jpeg']]));
      assert.equal(second.files[0].name, 'Freizeit (2).jpg');
      assert.equal(cloud.nodes.get('Agora/Fotos/Jugend/Freizeit.jpg').data.toString(), 'one', 'the first file is untouched');
      assert.equal((await upload('jule', 'Fotos/Jugend', [['.htaccess', 'x', 'text/plain']])).status, 400);

      assert.equal((await call('max', 'POST', '/api/media/folder', { path: 'Fotos', name: 'Neu' })).status, 403);
      assert.equal((await call('jule', 'POST', '/api/media/folder', { path: 'Fotos/Jugend', name: '../x' })).status, 400);
      await ok(call('jule', 'POST', '/api/media/folder', { path: 'Fotos/Jugend', name: 'Sommer 2026' }));
      assert.equal((await call('jule', 'POST', '/api/media/folder', { path: 'Fotos/Jugend', name: 'Sommer 2026' })).status, 409);
      assert.equal((await ok(list('jule', 'Fotos/Jugend/Sommer 2026'))).access, 'write', 'inherits the rights');
      // there is no way to delete
      assert.equal((await call('owner', 'DELETE', '/api/media/file?path=Fotos/Sommer.jpg')).status, 404);
      assert.ok(!cloud.requests.some((r) => ['DELETE', 'MOVE', 'COPY'].includes(r.method)));
      // nothing outside the base folder was ever asked for
      assert.ok(!cloud.requests.some((r) => r.path.includes('/Outside') || String(r.query.file || '').includes('Outside')));
    });

    test('a deleted group loses its rules; switched off, Media is gone for everyone', async () => {
      const group = await ok(call('owner', 'POST', '/api/admin/groups', { name: 'Kurzzeit', permissions: [] }));
      const id = group.id || group.group?.id;
      await ok(rules('Intern', { [id]: 'read' }));
      await ok(call('owner', 'DELETE', `/api/admin/groups/${id}`));
      assert.ok(!(await ok(call('owner', 'GET', '/api/media/rules'))).rules.some((r) => r.path === 'Intern'));
      await ok(rules('Intern/Leitung', {}));
      assert.equal((await list('jule', 'Intern')).status, 404, 'rule removed');

      await ok(call('owner', 'PUT', '/api/admin/media-config', settings({ enabled: false, password: '***' })));
      assert.deepEqual(await ok(call('jule', 'GET', '/api/media/status')), { enabled: false, canManage: false, hasAccess: false });
      assert.equal((await list('jule', 'Fotos')).status, 503);
      await ok(call('owner', 'PUT', '/api/admin/media-config', settings({ password: '***' })));
    });
  });
});
