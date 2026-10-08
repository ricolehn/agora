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
  const keep = (chunk) => { child.log.push(chunk.toString()); if (child.log.length > 200) child.log.shift(); };
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
  });
});
