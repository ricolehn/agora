// End-to-end over HTTP: the real backend with a real PocketBase on free ports and an empty data directory.
// Needs the PocketBase binary: POCKETBASE_BIN=/path/to/pocketbase (CI downloads it; locally the test is skipped
// without it unless REQUIRE_POCKETBASE=1, which turns a missing binary into a failure).
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT, BACKEND_DIR, assertHas, freePort, waitFor, start, SERVER_ENTRY } = require('./helpers');
const { startFakeNextcloud } = require('./fakeNextcloud');

const POCKETBASE_BIN = process.env.POCKETBASE_BIN || '';
const hasPocketBase = POCKETBASE_BIN !== '' && fs.existsSync(POCKETBASE_BIN);
if (!hasPocketBase && process.env.REQUIRE_POCKETBASE === '1') {
  throw new Error(`REQUIRE_POCKETBASE=1 but no PocketBase binary at POCKETBASE_BIN="${POCKETBASE_BIN}"`);
}

const PASSWORD = 'test-Passwort-1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** A ZIP archive's entries by name ({ name: text }; folders end with "/"), checked against their checksums. */
function unzip(buffer) {
  const zlib = require('zlib');
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of the table of contents');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50, `local header of ${name}`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    assert.equal(zlib.crc32(data) >>> 0, crc, `checksum of ${name}`);
    entries[name] = data.toString('utf8');
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return entries;
}

describe('api', { skip: !hasPocketBase && 'set POCKETBASE_BIN to run the HTTP tests' }, () => {
  const processes = [];
  let base;
  let pocketbaseUrl;
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
  // The database snapshot the AI gets with a question of [who] (a stand-in provider takes the prompt)
  async function aiSnapshot(who) {
    const http = require('http');
    let prompt = '';
    const provider = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (part) => { raw += part; });
      req.on('end', () => {
        prompt = JSON.parse(raw).messages.find((m) => m.role === 'system').content;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    try {
      const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
      await ok(call('owner', 'PUT', '/api/admin/ai-config', { enabled: true, baseUrl, apiKey: 'test-key', model: 'm' }));
      await ok(call(who, 'POST', '/api/ai/chat', { messages: [{ role: 'user', content: 'Wer ist überfällig?' }] }));
      return JSON.parse(prompt.slice(prompt.indexOf('{')));
    } finally {
      provider.close();
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  }
  const uploadReceipt = (who, name) => {
    const form = new FormData();
    form.append('name', name);
    form.append('date', '2026-10-01');
    form.append('receipt', new Blob([PNG], { type: 'image/png' }), 'beleg.png');
    return call(who, 'POST', '/api/upload', form, { form: true });
  };

  // Stand-ins for Anthropic's, OpenAI's and Google's own interfaces: the server is pointed at them (AGORA_AI_URL_*),
  // each test says what they answer ([hubAnswer](request) with { path, headers, body }) and reads what they got
  let hubAnswer = null;
  const hubRequests = [];
  let hub;
  let hubBase;

  before(async () => {
    hub = require('http').createServer((req, res) => {
      let raw = '';
      req.on('data', (part) => { raw += part; });
      req.on('end', async () => {
        const request = { path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
        hubRequests.push(request);
        try {
          if (!hubAnswer) throw new Error('no answer set');
          await hubAnswer(request, res);
        } catch (err) {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `stand-in: ${err.message}` } }));
        }
      });
    });
    await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
    hubBase = `http://127.0.0.1:${hub.address().port}`;
    const [port, pbPort] = await Promise.all([freePort(), freePort()]);
    dataRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agora-api-'));
    const pbDir = path.join(dataRoot, 'pb');
    base = `http://127.0.0.1:${port}`;
    pocketbaseUrl = `http://127.0.0.1:${pbPort}`;

    processes.push(start('pocketbase', POCKETBASE_BIN, ['serve', '--dir', pbDir, '--automigrate=false', '--http', `127.0.0.1:${pbPort}`], {}));
    await waitFor(`http://127.0.0.1:${pbPort}/api/health`, 'PocketBase', processes);

    processes.push(start('backend', process.execPath, [SERVER_ENTRY], {
      PORT: String(port),
      POCKETBASE_PORT: String(pbPort),
      POCKETBASE_BIN,
      POCKETBASE_DIR: pbDir,
      DATA_DIR: path.join(dataRoot, 'data'),
      FRONTEND_DIR: REPO_ROOT,
      NODE_ENV: 'test',
      // Polls are switched off by default; their API is tested here all the same
      AGORA_FEATURE_POLLS: '1',
      AGORA_AI_URL_ANTHROPIC: `${hubBase}/anthropic`,
      AGORA_AI_URL_OPENAI: `${hubBase}/openai/v1`,
      AGORA_AI_URL_GEMINI: `${hubBase}/gemini`
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
    hub?.close();
    for (const child of processes.reverse()) if (child.exitCode === null) child.kill();
    if (dataRoot) fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('setup mode blocks the API until the first setup, which only runs once', async () => {
    assert.equal(preSetupLogin.status, 503);
    assert.equal((await call(null, 'GET', '/api/status')).body.setupMode, false);
    const again = await call(null, 'POST', '/api/setup', { appName: 'X', adminUser: { firstName: 'A', lastName: 'B', email: 'x@test.local', password: PASSWORD } });
    assert.equal(again.status, 403);
  });

  test('a session token can do nothing in PocketBase directly: it reads its own account and that is all', async () => {
    // The session token is a PocketBase token: wherever PocketBase's port is reachable (another container, the admin
    // page on 8090) it must not open anything the server would not
    const pb = async (token, method, url, body) => (await fetch(`${pocketbaseUrl}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    })).status;

    assert.equal(await pb(tokens.max, 'GET', `/api/collections/users/records/${uids.max}`), 200, 'the sign-in check reads the own record');
    assert.ok(await pb(tokens.max, 'PATCH', `/api/collections/users/records/${uids.max}`, { admin: true, owner: true, groups: ['x'] }) >= 400);
    assert.equal((await ok(call('max', 'GET', '/api/auth/me'))).user.admin, false);
    assert.ok(await pb(tokens.max, 'GET', `/api/collections/users/records/${uids.owner}`) >= 400);
    assert.ok(await pb(tokens.max, 'GET', '/api/collections/users/records') >= 400);
    assert.ok(await pb(null, 'POST', '/api/collections/users/records', { email: 'sneak@test.local', password: PASSWORD, passwordConfirm: PASSWORD }) >= 400);
    const { allCollections } = require(path.join(BACKEND_DIR, 'db', 'schema'));
    for (const collection of [...allCollections().map((spec) => spec.name), 'finance_ledger', 'finance_monthly_totals']) {
      // Not even the owner's token: the secrets in app_state and every member's data are the server's alone
      assert.ok(await pb(tokens.owner, 'GET', `/api/collections/${collection}/records`) >= 400, collection);
      assert.ok(await pb(tokens.owner, 'POST', `/api/collections/${collection}/records`, {}) >= 400, collection);
    }
  });

  test('ids as the web app makes them ("1771345242762", the time as text) come back as text, not as numbers', async () => {
    // PocketBase reads a string in a json field as JSON when it is JSON - such an id came back as a number
    const key = await account('ines', 'Ines');
    const current = await ok(call('treasurer', 'GET', `/api/db?path=people/${key}&raw=1`));
    const standingOrder = { id: '1771345242762', amount: 25, startDate: '2099-01-01', note: 'Dauerauftrag', lastAutoPayment: null };
    const payment = { amount: 10, date: '2026-03-05', description: 'Beitrag', id: '1771345242763' };
    await ok(call('treasurer', 'POST', '/api/db/transaction', { path: `people/${key}`, currentVersion: current.version, value: { ...current.value, payments: [...(current.value.payments || []), payment], standingOrders: [standingOrder] } }));
    const saved = await ok(call('treasurer', 'GET', `/api/db?path=people/${key}`));
    assert.strictEqual(saved.standingOrders[0].id, standingOrder.id);
    assert.ok(saved.payments.some((entry) => entry.id === payment.id), 'the payment keeps its id as text');

    const expenses = await ok(call('treasurer', 'GET', '/api/db?path=expenses'));
    const expense = { id: '1771345242764', amount: 3.5, description: 'Porto', issuer: 'Theo Test', date: '2026-03-06' };
    await ok(call('treasurer', 'PUT', '/api/db', { path: 'expenses', value: [...(Array.isArray(expenses) ? expenses : Object.values(expenses || {})), expense] }));
    const after = await ok(call('treasurer', 'GET', '/api/db?path=expenses'));
    assert.ok((Array.isArray(after) ? after : Object.values(after || {})).some((entry) => entry.id === expense.id), 'the expense keeps its id as text');
  });

  test('the finance change log: who changed which booking, before and after; a deleted member keeps no status details', async () => {
    const { superuser } = require('./instance');
    const su = await superuser(dataRoot, new URL(pocketbaseUrl).port);
    const changes = async (filter) => su.list('finance_changes', filter);
    const key = uids.mia;
    const write = async (change) => {
      const current = await ok(call('treasurer', 'GET', `/api/db?path=people/${key}&raw=1`));
      await ok(call('treasurer', 'POST', '/api/db/transaction', { path: `people/${key}`, currentVersion: current.version, value: change(current.value) }));
    };
    const before = (await changes('')).length;
    await write((p) => ({ ...p, payments: [...(p.payments || []), { id: 1790000000001, amount: 25.5, date: '2026-03-03', description: 'Beitrag März' }] }));
    await write((p) => ({ ...p, payments: p.payments.map((payment) => (payment.id === 1790000000001 ? { ...payment, amount: 30 } : payment)) }));
    await write((p) => ({ ...p, payments: p.payments.filter((payment) => payment.id !== 1790000000001), status: 'geringverdiener', statusHistory: [{ status: 'geringverdiener', startDate: '2026-01-01' }] }));
    const rows = (await changes('')).slice(before);
    const payments = rows.filter((row) => row.area === 'payment');
    assert.deepEqual(payments.map((row) => row.action), ['create', 'update', 'delete']);
    assert.ok(payments.every((row) => row.by === uids.treasurer && row.byName === 'Theo Test' && row.at), 'who and when');
    assert.equal(payments[0].details.after.amount, 25.5);
    assert.deepEqual([payments[1].details.before.amount, payments[1].details.after.amount], [25.5, 30]);
    assert.equal(payments[2].details.before.amount, 30);
    assert.ok(rows.some((row) => row.area === 'member' && row.action === 'update' && row.details.after.status === 'geringverdiener'));
    assert.ok(rows.some((row) => row.area === 'statusPeriod' && row.details.after?.status === 'geringverdiener'));

    // Donations and expenses saved as a whole: only what changed is logged
    const donations = await ok(call('treasurer', 'GET', '/api/db?path=donations'));
    const list = Array.isArray(donations) ? donations : Object.values(donations || {});
    await ok(call('treasurer', 'PUT', '/api/db', { path: 'donations', value: [...list, { id: 1790000000002, amount: 40, name: 'Anonym', date: '2026-03-04' }] }));
    const donationRows = (await changes('area = "donation"')).filter((row) => row.details.after?.id === 1790000000002);
    assert.equal(donationRows.length, 1);
    assert.equal(donationRows[0].action, 'create');

    // A member is deleted: the log keeps that the status changed, not to what
    await account('logged', 'Lotte');
    const lotte = uids.logged;
    const current = await ok(call('owner', 'GET', `/api/db?path=people/${lotte}&raw=1`));
    await ok(call('owner', 'POST', '/api/db/transaction', { path: `people/${lotte}`, currentVersion: current.version, value: { ...current.value, statusHistory: [{ status: 'keinverdiener', startDate: '2026-02-01' }] } }));
    const memberId = (await su.list('finance_members', `user = "${lotte}"`))[0].id;
    assert.ok((await changes(`member = "${memberId}" && area = "statusPeriod"`)).some((row) => row.details.after?.status === 'keinverdiener'));
    await ok(call('owner', 'DELETE', '/api/db', { path: `people/${lotte}` }));
    const statusRows = await changes(`member = "${memberId}" && area = "statusPeriod"`);
    assert.ok(statusRows.length >= 2);
    assert.ok(statusRows.every((row) => !JSON.stringify(row.details).includes('keinverdiener')), 'no status left in the log');
    assert.ok((await changes(`member = "${memberId}" && area = "member" && action = "delete"`)).length === 1);

    // Kept for the bookkeeping years; the fee history stays
    const store = require(path.join(BACKEND_DIR, 'db', 'stores', 'finance'));
    const all = (await changes('')).length;
    const appConfig = { pocketbase: { adminEmail: su.config.pocketbase.adminEmail, adminPassword: su.config.pocketbase.adminPassword } };
    process.env.POCKETBASE_PORT = new URL(pocketbaseUrl).port;
    assert.equal(await store.pruneChangeLog(appConfig, { years: 10 }), 0, 'nothing is ten years old');
    const removed = await store.pruneChangeLog(appConfig, { years: 1, now: Date.now() + 2 * 365 * 86400000 });
    assert.ok(removed > 0);
    const left = await changes('');
    assert.equal(left.length, all - removed);
    assert.ok(left.every((row) => ['fees', 'freshStart'].includes(row.area)), 'only the fee history is left');
  });

  test('donations and expenses: a save with the version it read is refused when the list changed meanwhile', async () => {
    for (const root of ['donations', 'expenses']) {
      const read = async () => ok(call('treasurer', 'GET', `/api/db?path=${root}&raw=1`));
      const first = await read();
      assert.ok(typeof first.version === 'string' && first.version, `${root} has a version`);
      const list = (value) => (Array.isArray(value) ? value : Object.values(value || {}));
      const entry = (n) => (root === 'donations'
        ? { id: 1795000000000 + n, amount: 10 + n, name: 'Versioniert', date: '2026-04-01', description: '' }
        : { id: 1795000000000 + n, amount: 10 + n, description: 'Versioniert', issuer: 'Theo', date: '2026-04-01' });
      // Saved with the version read: the answer carries the new list and its version
      const saved = await ok(call('treasurer', 'POST', '/api/db/transaction', { path: root, currentVersion: first.version, value: [...list(first.value), entry(1)] }));
      assert.notEqual(saved.version, first.version);
      assert.ok(list(saved.value).some((item) => item.id === 1795000000001));
      // A second app still holding the old version: refused, nothing lost
      const stale = await call('treasurer', 'POST', '/api/db/transaction', { path: root, currentVersion: first.version, value: [...list(first.value), entry(2)] });
      assert.equal(stale.status, 409);
      const stalePut = await call('treasurer', 'PUT', '/api/db', { path: root, value: [...list(first.value), entry(2)], version: first.version });
      assert.equal(stalePut.status, 409);
      const now = await read();
      assert.equal(now.version, saved.version);
      assert.ok(list(now.value).some((item) => item.id === 1795000000001) && !list(now.value).some((item) => item.id === 1795000000002));
      // Older apps send no version: their save goes through as before - the list as they sent it, also what it
      // takes out (a list never says what its sender had seen: keeping what "it could not have seen" kept the entry
      // a treasurer had just deleted). What a stale list takes along is in the change log, with its values
      await ok(call('treasurer', 'PUT', '/api/db', { path: root, value: [...list(first.value), entry(3)] }));
      const after = list((await read()).value);
      assert.ok(after.some((item) => item.id === 1795000000003) && !after.some((item) => item.id === 1795000000001));
      const area = root === 'donations' ? 'donation' : 'expense';
      const log = await ok(call('treasurer', 'GET', `/api/v2/finance/changes?area=${area}`));
      const logged = (log.items || log).filter((row) => row.action === 'delete').map((row) => JSON.stringify(row.details?.before));
      assert.ok(logged.some((before) => before && before.includes('1795000000001')), `the change log keeps what went from the ${root}`);
      // Taking out the newest entry works without a version, too
      await ok(call('treasurer', 'PUT', '/api/db', { path: root, value: after.filter((item) => item.id !== 1795000000003) }));
      assert.ok(!list((await read()).value).some((item) => item.id === 1795000000003));
      // Only who manages the finances saves
      assert.equal((await call('max', 'POST', '/api/db/transaction', { path: root, currentVersion: now.version, value: [] })).status, 403);
    }
  });

  test('a password change checks the old password and goes through the server', async () => {
    await account('pwchange', 'Paula');
    const email = 'pwchange@test.local';
    const wrong = await call('pwchange', 'POST', '/api/auth/password', { oldPassword: 'not-the-password', password: 'neues-Passwort-2' });
    assert.equal(wrong.status, 400);
    assert.equal((await call(null, 'POST', '/api/auth/login', { email, password: PASSWORD })).status, 200, 'unchanged after a wrong old password');

    assert.deepEqual(await ok(call('pwchange', 'POST', '/api/auth/password', { oldPassword: PASSWORD, password: 'neues-Passwort-2' })), { success: true, loggedOut: true });
    assert.equal((await call(null, 'POST', '/api/auth/login', { email, password: PASSWORD })).status, 401);
    assert.equal((await call(null, 'POST', '/api/auth/login', { email, password: 'neues-Passwort-2' })).status, 200);
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

  test('a member files requests only for themselves: whose record and which name come from their own record', async () => {
    const people = Object.values(await read('treasurer', 'people'));
    const [max, mia] = [uids.max, uids.mia].map((uid) => people.find((p) => p.uid === uid));
    const id = `req-other-${Date.now()}`;
    // Max names Mia's record and her name: approved, that used to change Mia's status - under her name
    await ok(call('max', 'PUT', '/api/db', { path: `requests/${id}`, value: {
      id, type: 'status', userId: uids.max, personId: mia.id, personName: mia.name, data: { status: 'pausiert', date: '2026-10-01' }, status: 'pending', timestamp: Date.now()
    } }));
    assertHas(await read('treasurer', `requests/${id}`), { personId: String(max.id), personName: max.name, userId: uids.max });
    assert.ok(!Object.values(await read('mia', 'requests')).some((r) => r.id === id), 'not among Mia\'s requests');
    // a treasurer still files and decides for anyone
    const booked = `req-treasury-${Date.now()}`;
    await ok(call('treasurer', 'PUT', '/api/db', { path: `requests/${booked}`, value: {
      id: booked, type: 'payment', userId: uids.mia, personId: mia.id, personName: mia.name, data: { amount: 5, date: '2026-10-01' }, status: 'pending', timestamp: Date.now()
    } }));
    assertHas(await read('treasurer', `requests/${booked}`), { personId: String(mia.id), personName: mia.name });
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
    assert.match(String(code), /^\d{6}$/);
    assert.notEqual(String(code), '123456', 'never the old fixed code');
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

    // Sent by three people at the same moment, the code still lets exactly one in
    const next = String(await read('owner', 'system/inviteCode'));
    const answers = await Promise.all(['gleich1', 'gleich2', 'gleich3'].map((name) => register(`${name}@test.local`, next)));
    assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 403, 403]);
    assert.notEqual(String(await read('owner', 'system/inviteCode')), next, 'and a new code is set');
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

  test('a deleted person is no member any more: only the payments stay, nobody sees them as overdue', async () => {
    const key = 'gerda-deleted';
    await ok(call('owner', 'PUT', '/api/db', { path: `people/${key}`, value: {
      id: key, uid: '', name: 'Gerda Test', status: 'vollverdiener', memberSince: '2020-01-01', notes: 'Hauptstraße 1',
      statusHistory: [{ status: 'vollverdiener', startDate: '2020-01-01' }],
      payments: [{ id: 'gerda-pay', amount: 15, date: '2020-02-01', description: 'Beitrag' }]
    } }));
    assert.equal((await read('owner', `people/${key}`))._statusMeta.isOverdue, true, 'years without paying');
    await ok(call('owner', 'DELETE', '/api/db', { path: `people/${key}` }));

    const left = await read('owner', `people/${key}`);
    assertHas(left, { name: 'Gerda Test', isDeleted: true, memberSince: '', status: '', statusHistory: [], _overdueAmount: 0 });
    assert.equal(left._statusMeta.isOverdue, false);
    assert.equal(left.notes, undefined, 'the rest of the entry is gone');
    assert.deepEqual(left.payments.map((p) => p.id), ['gerda-pay'], 'the payment stays');
    const ledger = await ok(call('treasurer', 'GET', '/api/transactions?search=Gerda'));
    assert.deepEqual(ledger.items.map((t) => [t.who, t.amount]), [['Gerda Test', 15]], 'still in the books under her name');

    // A new member with the same name neither sees the deleted entry nor takes it over
    const namesake = await account('gerda', 'Gerda');
    assert.deepEqual(Object.keys(await read('gerda', 'people')), [namesake]);
    assert.equal((await call('gerda', 'GET', `/api/db?path=people/${key}`)).status, 403);
    assert.equal((await call('gerda', 'PATCH', '/api/db', { path: `people/${key}`, value: { uid: namesake } })).status, 403);

    // The AI gets her payment for the books, but not her as a member
    const snapshot = await aiSnapshot('owner');
    assert.ok(!snapshot.members.some((m) => m.id === key), 'not in the member list');
    assert.deepEqual(snapshot.paymentsOfDeletedMembers.filter((p) => p.name === 'Gerda Test'),
      [{ name: 'Gerda Test', amount: 15, date: '2020-02-01', description: 'Beitrag' }]);
  });

  // --- CALDERA: a fresh start for all fee accounts on a chosen day (backend/feeReset.js) ---
  const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const freshStart = (who, date, extra = {}) => call(who, 'POST', '/api/admin/fee-reset', { date, confirmDate: date, password: PASSWORD, ...extra });
  const takeBack = (who, date, extra = {}) => call(who, 'POST', '/api/admin/fee-reset/remove', { date, confirmDate: date, password: PASSWORD, ...extra });
  const freshStarts = async (who = 'owner') => (await ok(call(who, 'GET', '/api/fee-reset'))).resets;
  // ... and the monthly fees over time (backend/feeSchedule.js)
  const monthsFrom = (month, count) => {
    const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + count;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
  };
  const feesNow = (who = 'owner') => ok(call(who, 'GET', '/api/fees'));
  const feePreview = (who, body) => call(who, 'POST', '/api/admin/fees/preview', body);
  // A change of the fees ([body]: { from, fees, replaces } or { from, remove: true }), checked and saved as it was checked
  const setFees = async (who, body) => {
    const preview = await ok(feePreview(who, body));
    return ok(call(who, 'POST', body.remove ? '/api/admin/fees/remove' : '/api/admin/fees', { ...body, version: preview.version }));
  };
  const withoutFeeChanges = async () => {
    for (const entry of (await feesNow()).entries) if (entry.from) await setFees('owner', { from: entry.from, remove: true });
  };

  test('a fresh start of the fee accounts is for system admins only, with the day twice and their own password', async () => {
    const day = `${new Date().getFullYear()}-01-01`;
    await account('admina', 'Adele', { admin: true });
    // treasurers book payments and decide requests, but they do not draw this line; members and strangers even less
    for (const who of ['treasurer', 'max', null]) {
      for (const res of [await freshStart(who, day), await takeBack(who, day), await call(who, 'GET', `/api/admin/fee-reset/preview?date=${day}`)]) {
        assert.ok([401, 403].includes(res.status), `${who}: ${res.status}`);
      }
    }
    // an admin, but not confirmed: a single field, a wrong password or a day that is none starts nothing
    for (const [why, body] of [
      ['no password', { date: day, confirmDate: day }],
      ['a wrong password', { date: day, confirmDate: day, password: 'falsch' }],
      ['a password that is no text', { date: day, confirmDate: day, password: { $ne: '' } }],
      ['the day not repeated', { date: day, password: PASSWORD }],
      ['another day repeated', { date: day, confirmDate: `${new Date().getFullYear()}-01-02`, password: PASSWORD }],
      ['no day', { confirmDate: day, password: PASSWORD }],
      ['a day that does not exist', { date: '2026-02-30', confirmDate: '2026-02-30', password: PASSWORD }],
      ['a mistyped year', { date: '1026-01-01', confirmDate: '1026-01-01', password: PASSWORD }],
      ['a list of days', { date: [day], confirmDate: [day], password: PASSWORD }]
    ]) {
      const res = await call('owner', 'POST', '/api/admin/fee-reset', body);
      assert.ok(res.status >= 400 && res.status < 500, `${why}: ${res.status}`);
    }
    const nothingSet = async (how) => {
      assert.deepEqual(await freshStarts(), [], `${how}: nothing was set`);
      assertHas(await read('owner', `people/${uids.max}`), { _feeReset: null, _feeCarriedOver: 0, _feeWrittenOff: 0 }, how);
    };
    await nothingSet('refused calls');
    // the general data route offers no way around the confirmation ...
    const settings = await read('owner', 'settings');
    await call('owner', 'PUT', '/api/db', { path: 'feeResets', value: { resets: [{ date: day }] } });
    await nothingSet('written as a value of its own');
    try {
      await call('owner', 'PUT', '/api/db', { path: 'settings', value: { ...settings, feeResets: [{ date: day }], resets: [{ date: day }] } });
      await nothingSet('written into the fee settings');
    } finally {
      await ok(call('owner', 'PUT', '/api/db', { path: 'settings', value: settings }));
    }
    // ... and what the server works out cannot be written into a record
    await call('treasurer', 'PATCH', '/api/db', { path: `people/${uids.max}`, value: { _feeReset: day, _feeCarriedOver: 9999 } });
    await nothingSet('written into a record');

    // a system admin who does not see the finances can check a day: the numbers name nobody
    const preview = await ok(call('admina', 'GET', `/api/admin/fee-reset/preview?date=${day}`));
    assert.ok(preview.members >= 4, 'counts the paying members');
    assert.doesNotMatch(JSON.stringify(preview), /Max|Mia|Test/);
    assert.deepEqual(await freshStarts(), [], 'checking sets nothing');
  });

  test('a fresh start drops open fees and carries credit over; payments, the cash balance and "member since" stay', async () => {
    const now = new Date();
    // The first of this month: a day that has come
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const settings = await read('owner', 'settings');
    const fee = settings.vollverdiener;
    const behind = await account('rueck', 'Rudi');
    const ahead = await account('voraus', 'Vera');
    const joiner = await account('frisch', 'Frieda', { memberSince: localDay() });
    await account('zweit', 'Zora', { admin: true });
    const person = (key) => read('treasurer', `people/${key}`);
    const book = async (key, payment) => {
      const raw = await ok(call('treasurer', 'GET', `/api/db?path=people/${key}&raw=1`));
      await ok(call('treasurer', 'POST', '/api/db/transaction', { path: `people/${key}`, currentVersion: raw.version, value: { ...raw.value, payments: [...raw.value.payments, payment] } }));
    };
    const cash = async () => (await ok(call('treasurer', 'GET', '/api/stats'))).totalBalance;
    // Everyone who pays fees, as the treasury sees them - and by how much each balance rose from one reading to the next
    const payers = async () => Object.values(await read('treasurer', 'people')).filter((p) => !p.isDeleted && p.pays !== false);
    const cents = (amount) => Math.round(amount * 100) / 100;
    const side = (amounts) => ({ count: amounts.length, total: cents(amounts.reduce((sum, amount) => sum + amount, 0)) });
    const rises = (from, to) => to.map((p) => cents(p._currentBalance - from.find((was) => was.id === p.id)._currentBalance)).filter((rise) => rise > 0);
    // What the months before this one cost a member since January 2025, as the server counts them
    const owedBefore = -(await person(behind))._currentBalance - fee;
    assert.ok(owedBefore > 100, 'more than a year of fees');
    await book(behind, { id: 'old-100', amount: 100, date: '2025-03-01', description: 'Beitrag' });
    await book(ahead, { id: 'old-big', amount: owedBefore + 300, date: '2025-03-01', description: 'Vorauszahlung' });
    const before = { behind: await person(behind), ahead: await person(ahead), joiner: await person(joiner), cash: await cash() };
    assertHas(before.behind, { _feeReset: null, _currentBalance: 100 - owedBefore - fee });
    assertHas(before.ahead, { _feeReset: null, _currentBalance: 300 - fee });

    try {
      // the admin first sees what the day changes; checking sets nothing
      const preview = await ok(call('owner', 'GET', `/api/admin/fee-reset/preview?date=${day}`));
      assertHas(preview, { date: day, inEffect: true, owesMore: { count: 0, total: 0 }, repriced: false });
      assert.equal(preview.feesBefore.vollverdiener, fee);
      assert.deepEqual(await freshStarts(), []);
      const asItWas = await payers();

      const set = await ok(freshStart('owner', day));
      assertHas(set.resets.find((reset) => reset.date === day), { state: 'active', setByName: 'Olga Owner' });
      // the numbers that were shown are what the accounts then do: who owes less and by how much, whose credit goes along
      const afresh = await payers();
      assert.equal(preview.members, afresh.length);
      assert.deepEqual(preview.behind, side(rises(asItWas, afresh)), 'the open fees that are dropped');
      assert.ok(rises(asItWas, afresh).includes(owedBefore - 100), 'those of the member who was behind among them');
      assert.deepEqual(preview.ahead, side(afresh.filter((p) => p._feeCarriedOver > 0).map((p) => p._feeCarriedOver)), 'the credit that is carried over');
      assert.ok(preview.ahead.total >= 300);

      // behind: the open fees are dropped, this month is owed
      assertHas(await person(behind), { _feeReset: day, _feeWrittenOff: owedBefore - 100, _feeCarriedOver: 0, _currentBalance: -fee, _overdueAmount: fee });
      // ahead: nothing that was paid is cut - the credit, the balance and "paid until" are what they were
      assertHas(await person(ahead), { _feeReset: day, _feeCarriedOver: 300, _feeWrittenOff: 0, _currentBalance: before.ahead._currentBalance, _paidUntil: before.ahead._paidUntil });
      // joined on the day or later: the account counts from the own start as always
      assert.deepEqual(await person(joiner), before.joiner);

      // nothing that is booked changed: "member since", the payments, the ledger and the cash balance
      for (const [key, was] of [[behind, before.behind], [ahead, before.ahead]]) {
        const is = await person(key);
        for (const field of ['memberSince', 'originalMemberSince', 'payments', 'totalPaid', 'status', 'statusHistory']) assert.deepEqual(is[field], was[field], field);
        assert.equal(is.memberSince, '2025-01-01');
      }
      assert.equal(await cash(), before.cash);
      assert.deepEqual((await ok(call('treasurer', 'GET', '/api/transactions?search=Rudi'))).items.map((entry) => entry.amount), [100]);

      // every member may read the day (their own record says what happened to their account); who set it and the
      // fees of the time before are for the treasury
      assert.deepEqual(await freshStarts('rueck'), [{ date: day, state: 'active' }]);
      assertHas(Object.values(await read('rueck', 'people'))[0], { _feeReset: day, _feeWrittenOff: owedBefore - 100 });
      const forTreasury = await ok(call('treasurer', 'GET', '/api/fee-reset'));
      assert.equal(forTreasury.resets[0].feesBefore.vollverdiener, fee);
      assert.ok(forTreasury.log.some((entry) => entry.action === 'set' && entry.date === day && entry.byName === 'Olga Owner'));

      // a fee an older app saves into the fee settings counts from this month on - here the month of the fresh start:
      // it neither shrinks the credit nor brings dropped fees back
      await ok(call('owner', 'PUT', '/api/db', { path: 'settings', value: { ...settings, vollverdiener: fee + 10 } }));
      assertHas(await person(ahead), { _feeCarriedOver: 300, _currentBalance: 300 - (fee + 10) });
      assertHas(await person(behind), { _feeWrittenOff: owedBefore - 100, _currentBalance: -(fee + 10) });
      // taking the fresh start back now changes the price of no month (it used to charge the time before at the
      // fee set now): exactly the dropped fees would be owed again
      const dearer = await ok(call('owner', 'GET', `/api/admin/fee-reset/preview?date=${day}&remove=1`));
      assertHas(dearer, { inEffect: true, repriced: false, behind: preview.behind, owesMore: { count: 0, total: 0 } });
      assert.deepEqual([dearer.feesBefore.vollverdiener, dearer.feesWithout.vollverdiener], [fee, fee]);
      await ok(call('owner', 'PUT', '/api/db', { path: 'settings', value: settings }));
      assert.deepEqual((await feesNow()).entries.map((entry) => entry.from), [null], 'set back in the same month, the change is gone');

      // a payment booked late for the time before first makes up for what was open then; one from the day on is credit
      await book(behind, { id: 'late-50', amount: 50, date: '2025-04-01', description: 'Nachtrag' });
      assertHas(await person(behind), { _feeWrittenOff: owedBefore - 150, _currentBalance: -fee });
      await book(behind, { id: 'new-fee', amount: fee, date: localDay(), description: 'Beitrag' });
      assertHas(await person(behind), { _currentBalance: 0, _overdueAmount: 0 });

      // the AI is told the same numbers instead of adding up months and payments itself
      const snapshot = await aiSnapshot('owner');
      assertHas(snapshot.feeResets.find((reset) => reset.date === day), { state: 'active' });
      assertHas(snapshot.members.find((m) => m.id === ahead).feeAccount, { startedAfreshOn: day, creditCarriedOverEur: 300, isOverdue: false });
      assertHas(snapshot.members.find((m) => m.id === behind).feeAccount, { startedAfreshOn: day, openFeesDroppedEur: owedBefore - 150, overdueEur: 0 });

      // one fresh start per day - also when two admins confirm at the same moment
      assert.equal((await freshStart('owner', day)).status, 409);
      const next = `${now.getFullYear() + 1}-01-01`;
      const both = await Promise.all([freshStart('owner', next), freshStart('zweit', next)]);
      assert.deepEqual(both.map((res) => res.status).sort(), [200, 409]);
      // that one lies in the future: planned, and until its day everything is calculated as it is
      assertHas((await freshStarts()).find((reset) => reset.date === next), { state: 'scheduled' });
      assertHas(await person(ahead), { _feeReset: day, _feeCarriedOver: 300, _currentBalance: before.ahead._currentBalance });
      // fees for the time from then on are set with their month: no month before it costs anything else
      const fromNext = { from: next.slice(0, 7), fees: { vollverdiener: fee + 10, geringverdiener: settings.geringverdiener, keinverdiener: settings.keinverdiener } };
      assertHas(await setFees('owner', fromNext), { next: { from: fromNext.from, fees: { ...(await feesNow()).current, vollverdiener: fee + 10 } } });
      assertHas(await person(ahead), { _currentBalance: before.ahead._currentBalance, _monthlyFee: fee });
      assertHas(await person(joiner), { _currentBalance: before.joiner._currentBalance, _monthlyFee: fee });
      await setFees('owner', { from: fromNext.from, remove: true });

      // taking one back needs the same confirmation - and then everything is calculated as before again
      assert.equal((await takeBack('owner', day, { password: 'falsch' })).status, 403);
      assert.equal((await takeBack('owner', day, { confirmDate: next })).status, 400);
      assert.equal((await takeBack('owner', '2001-01-01')).status, 404);
      assert.equal((await call('owner', 'GET', '/api/admin/fee-reset/preview?date=2001-01-01&remove=1')).status, 404);
      // the planned one has dropped nothing so far: taking it back changes no account
      const nobody = { count: 0, total: 0 };
      assertHas(await ok(call('owner', 'GET', `/api/admin/fee-reset/preview?date=${next}&remove=1`)), { inEffect: false, behind: nobody, owesMore: nobody, repriced: false });
      const undo = await ok(call('owner', 'GET', `/api/admin/fee-reset/preview?date=${day}&remove=1`));
      const withIt = await payers();
      await ok(takeBack('owner', next));
      assert.deepEqual((await payers()).map((p) => p._currentBalance), withIt.map((p) => p._currentBalance));
      await ok(takeBack('owner', day));
      // again the numbers that were shown are what happens: who owes more, and how much
      assertHas(undo, { inEffect: true, behind: side(rises(await payers(), withIt)), owesMore: nobody, repriced: false });
      assert.ok(rises(await payers(), withIt).includes(owedBefore - 150), 'the fees that were dropped for the member who was behind');
      assert.deepEqual(await freshStarts(), []);
      assertHas(await person(ahead), { _feeReset: null, _feeCarriedOver: 0, _currentBalance: before.ahead._currentBalance });
      assertHas(await person(behind), { _feeReset: null, _feeWrittenOff: 0, _currentBalance: before.behind._currentBalance + 50 + fee });
      assert.ok((await ok(call('owner', 'GET', '/api/fee-reset'))).log.some((entry) => entry.action === 'removed' && entry.date === day), 'who took it back is kept');
    } finally {
      // the other tests calculate without a fresh start and at the usual fees
      for (const reset of await freshStarts()) await takeBack('owner', reset.date);
      await call('owner', 'PUT', '/api/db', { path: 'settings', value: settings });
      await withoutFeeChanges();
    }
  });

  // --- CALDERA: the monthly fees over time (backend/feeSchedule.js) ---
  test('the fees have a history: a change counts from its month, and only system admins save it as it was checked', async () => {
    const month = localDay().slice(0, 7);
    const [last, next] = [monthsFrom(month, -1), monthsFrom(month, 1)];
    const start = await feesNow();
    const fee = start.current.vollverdiener;
    const table = (full) => ({ vollverdiener: full, geringverdiener: start.current.geringverdiener, keinverdiener: start.current.keinverdiener });
    await account('feeadmin', 'Ferdi', { admin: true });
    const monthly = await account('monatlich', 'Mona');
    const person = (key) => read('treasurer', `people/${key}`);
    // Everyone who pays fees, as the treasury sees them - and by how much each balance fell from one reading to the next
    const payers = async () => Object.values(await read('treasurer', 'people')).filter((p) => !p.isDeleted && p.pays !== false);
    const cents = (amount) => Math.round(amount * 100) / 100;
    const side = (amounts) => ({ count: amounts.length, total: cents(amounts.reduce((sum, amount) => sum + amount, 0)) });
    const falls = (from, to) => to.map((p) => cents(from.find((was) => was.id === p.id)._currentBalance - p._currentBalance)).filter((fall) => fall > 0);
    const nobody = { count: 0, total: 0 };

    try {
      // everyone signed in reads what a month costs; who set it, the log and the version are for the treasury
      assertHas(start, { month, since: null, next: null });
      assert.deepEqual(start.entries.map((entry) => [entry.from, entry.state]), [[null, 'current']]);
      const forMember = await feesNow('max');
      assert.deepEqual([forMember.current, forMember.entries], [start.current, [{ from: null, fees: start.current, state: 'current' }]]);
      assert.ok(!('log' in forMember) && !('version' in forMember));
      assert.equal((await call(null, 'GET', '/api/fees')).status, 401);

      // treasurers book the money, but they do not set what a month costs; members and strangers even less
      const dearer = { from: next, fees: table(fee + 10) };
      for (const who of ['treasurer', 'max', null]) {
        for (const res of [await feePreview(who, dearer), await call(who, 'POST', '/api/admin/fees', { ...dearer, version: start.version }), await call(who, 'POST', '/api/admin/fees/remove', { from: next, version: start.version })]) {
          assert.ok([401, 403].includes(res.status), `${who}: ${res.status}`);
        }
      }
      // an admin, but not as it was checked - or with a month or an amount that is none: nothing is saved
      for (const [why, body, status] of [
        ['no version', dearer, 400],
        ['another version', { ...dearer, version: 'x'.repeat(16) }, 409],
        ['a version that is no text', { ...dearer, version: { $ne: '' } }, 400],
        ['no month', { fees: table(fee + 10), version: start.version }, 400],
        ['a month that does not exist', { ...dearer, from: `${next.slice(0, 4)}-13`, version: start.version }, 400],
        ['a mistyped year', { ...dearer, from: '1026-01', version: start.version }, 400],
        ['a list of months', { ...dearer, from: [next], version: start.version }, 400],
        ['an amount typed as text', { from: next, fees: table('60'), version: start.version }, 400],
        ['a negative amount', { from: next, fees: table(-1), version: start.version }, 400],
        ['a status without an amount', { from: next, fees: { vollverdiener: fee + 10 }, version: start.version }, 400],
        ['the fees that count anyway', { from: next, fees: table(fee), version: start.version }, 409],
        ['a change that is not there', { ...dearer, replaces: last, version: start.version }, 404]
      ]) {
        assert.equal((await call('owner', 'POST', '/api/admin/fees', body)).status, status, why);
      }
      assert.equal((await call('owner', 'POST', '/api/admin/fees/remove', { from: next, version: start.version })).status, 404);
      for (const body of [undefined, {}, { from: next }, { from: 'next month', fees: table(fee + 10) }]) assert.equal((await feePreview('owner', body)).status, 400);
      // the general data route offers no way around it: the history is no value of its own there, and what is
      // written into the fee settings next to the fees is no history
      await call('owner', 'PUT', '/api/db', { path: 'feeSchedule', value: { base: table(1), changes: [] } });
      const settings = await read('owner', 'settings');
      await ok(call('owner', 'PUT', '/api/db', { path: 'settings', value: { ...settings, feeSchedule: { base: table(1), changes: [] }, base: table(1), changes: [{ from: last, fees: table(1) }] } }));
      await ok(call('owner', 'PUT', '/api/db', { path: 'settings', value: settings }));
      assert.deepEqual(await feesNow(), start, 'nothing was set');

      // a higher fee from next month on. The admin first sees what it does - today it moves no account - and the
      // numbers name nobody
      const planned = await ok(feePreview('feeadmin', dearer));
      assertHas(planned, { from: next, remove: false, movedFrom: null, inEffect: false, more: nobody, less: nobody, freshStart: null, version: start.version });
      assert.deepEqual(planned.stretches, [{ first: next, last: null, before: start.current, after: { ...start.current, vollverdiener: fee + 10 } }]);
      assert.ok(planned.members >= 4, 'counts the paying members');
      assert.doesNotMatch(JSON.stringify(planned), /Max|Mia|Mona|Test/);
      assert.deepEqual(await feesNow(), start, 'checking sets nothing');
      const asItWas = await payers();
      const was = await person(monthly);

      // saved as it was checked: planned, with who set it
      const saved = await ok(call('feeadmin', 'POST', '/api/admin/fees', { ...dearer, version: planned.version }));
      assertHas(saved, { since: null, current: start.current, next: { from: next, fees: { ...start.current, vollverdiener: fee + 10 } } });
      assert.deepEqual(saved.entries.map((entry) => [entry.from, entry.state]), [[null, 'current'], [next, 'planned']]);
      assert.match(saved.entries[1].setByName, /Ferdi/);
      assert.ok(saved.log.some((entry) => entry.action === 'set' && entry.from === next && /Ferdi/.test(entry.byName)));
      // until its month comes every account stands where it stood, and the apps read the fees of this month
      assert.deepEqual((await payers()).map((p) => [p.id, p._currentBalance, p._monthlyFee]), asItWas.map((p) => [p.id, p._currentBalance, p._monthlyFee]));
      assert.equal((await read('max', 'settings')).vollverdiener, fee);
      // what was checked before is no longer what is there: saving on top of it is refused
      assert.equal((await call('owner', 'POST', '/api/admin/fees', { from: monthsFrom(next, 1), fees: table(fee + 20), version: planned.version })).status, 409);
      // two admins at the same moment: one change is saved, the other admin is told to check again
      const both = await Promise.all([
        call('owner', 'POST', '/api/admin/fees', { from: monthsFrom(next, 2), fees: table(fee + 20), version: saved.version }),
        call('feeadmin', 'POST', '/api/admin/fees', { from: monthsFrom(next, 3), fees: table(fee + 30), version: saved.version })
      ]);
      assert.deepEqual(both.map((res) => res.status).sort(), [200, 409]);
      const [second, ...more] = (await feesNow()).entries.filter((entry) => entry.from > next);
      assert.deepEqual(more, []);
      await setFees('owner', { from: second.from, remove: true });

      // moved to last month, it reaches back - the numbers that are shown are what the accounts then do: last
      // month and this one cost 10 more
      const move = { from: last, replaces: next, fees: table(fee + 10) };
      const reach = await ok(feePreview('owner', move));
      assertHas(reach, { from: last, movedFrom: next, inEffect: true, less: nobody, freshStart: null });
      assert.deepEqual(reach.stretches.map((stretch) => [stretch.first, stretch.last, stretch.before.vollverdiener, stretch.after.vollverdiener]), [[last, month, fee, fee + 10]]);
      const moved = await ok(call('owner', 'POST', '/api/admin/fees', { ...move, version: reach.version }));
      assert.deepEqual(moved.entries.map((entry) => [entry.from, entry.state]), [[null, 'past'], [last, 'current']]);
      assertHas(moved, { since: last, next: null });
      assert.deepEqual(reach.more, side(falls(asItWas, await payers())), 'who owes more, and how much');
      assertHas(await person(monthly), { _currentBalance: was._currentBalance - 20, _monthlyFee: fee + 10 });
      assert.equal((await read('max', 'settings')).vollverdiener, fee + 10);
      assert.ok(moved.log.some((entry) => entry.action === 'set' && entry.from === last && entry.movedFrom === next));

      // an app without the history saves the fee settings with another fee: it has no month, so it counts from this
      // month on - last month keeps its 10 more
      const appSettings = await read('owner', 'settings');
      assert.equal((await call('treasurer', 'PUT', '/api/db', { path: 'settings', value: { ...appSettings, vollverdiener: 1 } })).status, 403);
      await ok(call('owner', 'PUT', '/api/db', { path: 'settings', value: { ...appSettings, vollverdiener: fee + 15 } }));
      const byApp = await feesNow();
      assert.deepEqual(byApp.entries.map((entry) => [entry.from, entry.fees.vollverdiener, entry.state]), [[null, fee, 'past'], [last, fee + 10, 'past'], [month, fee + 15, 'current']]);
      assert.ok(byApp.log.some((entry) => entry.action === 'set' && entry.from === month && entry.byName === 'Olga Owner'));
      assertHas(await person(monthly), { _currentBalance: was._currentBalance - 25, _monthlyFee: fee + 15 });

      // the AI is told what a month costs now, and over time
      const snapshot = await aiSnapshot('owner');
      assert.equal(snapshot.contributionRates.vollverdiener, fee + 15);
      assert.deepEqual(snapshot.contributionRatesOverTime.map((entry) => [entry.from, entry.fees.vollverdiener, entry.state]), [[null, fee, 'past'], [last, fee + 10, 'past'], [month, fee + 15, 'current']]);

      // the fees from the beginning count for every month before the first change (checked here, not saved)
      const corrected = await ok(feePreview('owner', { from: null, fees: table(fee - 5) }));
      assert.deepEqual(corrected.stretches.map((stretch) => [stretch.first, stretch.last]), [[null, monthsFrom(last, -1)]]);
      assert.ok(corrected.less.count >= 1 && corrected.more.count === 0);

      // taken back one after the other, everything is calculated as before again
      const undo = await ok(feePreview('owner', { from: month, remove: true }));
      assertHas(undo, { from: month, remove: true, inEffect: true, more: nobody });
      assert.deepEqual(undo.stretches.map((stretch) => [stretch.first, stretch.last, stretch.before.vollverdiener, stretch.after.vollverdiener]), [[month, null, fee + 15, fee + 10]]);
      for (const from of [month, last]) await setFees('owner', { from, remove: true });
      const end = await feesNow();
      assert.deepEqual([end.entries, end.version], [start.entries, start.version]);
      assert.deepEqual((await payers()).map((p) => [p.id, p._currentBalance]), asItWas.map((p) => [p.id, p._currentBalance]));
      assert.ok(end.log.some((entry) => entry.action === 'removed' && entry.from === last), 'who took it back is kept');
    } finally {
      // the other tests calculate at the usual fees
      await withoutFeeChanges();
    }
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

  test('taking over a duty: open or declined ones, never one asked of someone else', async () => {
    const created = await ok(call('owner', 'POST', '/api/events', { title: 'Putzaktion', date: '2026-11-21', startTime: '09:00', eventType: 'termin' }));
    const id = created.id || created.event?.id || created.events?.[0]?.id;
    const duty = async (body) => (await ok(call('owner', 'POST', `/api/events/${id}/duties`, { sendEmail: false, ...body }))).duty;
    const claim = (who, dutyId) => call(who, 'POST', `/api/events/duties/${dutyId}/claim`, {});

    const open = await duty({ roleName: 'Fenster' });
    assert.equal((await ok(claim('max', open.id))).duty.assignedUser, uids.max);
    assert.equal((await claim('mia', open.id)).status, 409, 'taken is taken');

    const askedOfMia = await duty({ roleName: 'Küche', requestedUser: uids.mia });
    assert.equal((await claim('max', askedOfMia.id)).status, 409, "someone else's request");
    await ok(call('mia', 'POST', `/api/events/duties/${askedOfMia.id}/respond`, { action: 'decline' }));
    // Declined, the duty is free again: for others and for the one who declined and changed their mind
    assert.equal((await ok(claim('mia', askedOfMia.id))).duty.assignedUser, uids.mia);

    const declinedByMia = await duty({ roleName: 'Boden', requestedUser: uids.mia });
    await ok(call('mia', 'POST', `/api/events/duties/${declinedByMia.id}/respond`, { action: 'decline' }));
    const taken = (await ok(claim('max', declinedByMia.id))).duty;
    assert.equal(taken.assignedUser, uids.max);
    assert.equal(taken.status, 'confirmed');
    await ok(call('owner', 'DELETE', `/api/events/${id}`));
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

  test('the calendar feed, open without a session, is limited per address', async () => {
    // Every call looks the token up in the database: without a limit anyone could keep it busy
    const res = await fetch(`${base}/api/events/calendar.ics?user=nobody&token=wrong`, { headers: { 'X-Forwarded-For': '10.45.0.1' } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('ratelimit-limit'), '240');
  });

  test('the least and the most participants fit together; the event says whether the minimum is reached', async () => {
    const tooMany = await call('owner', 'POST', '/api/events', { title: 'Zu viele', date: inDays(27), requiresRegistration: true, minParticipants: 10, maxParticipants: 5 });
    assert.equal(tooMany.status, 400);
    assert.equal((await call('owner', 'POST', '/api/events', { title: 'Halbe', date: inDays(27), minParticipants: 2.5 })).status, 400);
    const created = await ok(call('owner', 'POST', '/api/events', { title: 'Mindestens zwei', date: inDays(27), requiresRegistration: true, minParticipants: 2, maxParticipants: 4 }));
    const eventId = created.event?.id || created.id;
    // Fewer places than the minimum: refused; nothing changed
    assert.equal((await call('owner', 'PATCH', `/api/events/${eventId}`, { maxParticipants: 1 })).status, 400);
    assert.equal((await call('owner', 'PATCH', `/api/events/${eventId}`, { minParticipants: 5 })).status, 400);
    const v2 = async () => (await ok(call('max', 'GET', '/api/v2/events?limit=500'))).items.find((event) => event.id === eventId);
    assert.deepEqual([(await v2()).maxParticipants, (await v2()).minimumReached], [4, false]);
    await ok(call('max', 'POST', `/api/events/${eventId}/register`, { action: 'register' }));
    await ok(call('mia', 'POST', `/api/events/${eventId}/register`, { action: 'register' }));
    assert.equal((await v2()).minimumReached, true);
    // Without a minimum: no answer to the question
    await ok(call('owner', 'PATCH', `/api/events/${eventId}`, { minParticipants: 0 }));
    assert.equal((await v2()).minimumReached, null);
    await ok(call('owner', 'DELETE', `/api/events/${eventId}`));
  });

  test('a reported chat message: the admins read it, the database keeps it encrypted like the conversation', async () => {
    const { superuser } = require('./instance');
    const su = await superuser(dataRoot, new URL(pocketbaseUrl).port);
    await ok(call('max', 'POST', '/api/reports', { type: 'chat', content: 'Eine sehr private Nachricht', threadId: 'thread-gemeldet' }));
    const [stored] = await su.list('system_content_reports', `reportedBy = "${uids.max}" && type = "chat"`);
    assert.match(stored.content, /^enc:v1:/, 'encrypted in the database');
    assert.ok(!JSON.stringify(stored).includes('private'), 'nowhere in the record in plain text');
    const listed = (await ok(call('owner', 'GET', '/api/admin/reports'))).reports.find((report) => report.threadId === 'thread-gemeldet');
    assert.equal(listed.content, 'Eine sehr private Nachricht', 'the admins read it as before');
    const resolved = await ok(call('owner', 'POST', `/api/admin/reports/${listed.id}/resolve`));
    assert.equal((resolved.report || resolved).content, 'Eine sehr private Nachricht');
  });

  test('nobody can switch off another person\'s push notifications', async () => {
    const { superuser } = require('./instance');
    const su = await superuser(dataRoot, new URL(pocketbaseUrl).port);
    const endpoint = 'https://push.example/maxs-phone';
    await ok(call('max', 'POST', '/api/push/subscribe', { subscription: { endpoint, keys: { p256dh: 'BKey', auth: 'secret' } }, installed: true }));
    const devices = async () => su.list('system_push_devices', `endpoint = ${JSON.stringify(endpoint)}`);
    assert.equal((await devices()).length, 1);
    // Mia knows the address (or guesses it): the answer is the same, the subscription stays
    assert.equal((await call('mia', 'POST', '/api/push/unsubscribe', { endpoint })).status, 200);
    assert.equal((await devices()).length, 1, 'Max still gets his notifications');
    await ok(call('max', 'POST', '/api/push/unsubscribe', { endpoint }));
    assert.equal((await devices()).length, 0, 'his own unsubscribe works');
  });

  test('a duty\'s status follows who has it: a group "assigned", a person "confirmed", nobody "open"', async () => {
    const groups = await ok(call('owner', 'GET', '/api/admin/groups'));
    const groupId = (groups.groups || groups).find((group) => group.name === 'Kasse').id;
    const created = await ok(call('owner', 'POST', '/api/events', {
      title: 'Dienstplan-Test', date: inDays(25),
      duties: [{ roleName: 'Gruppe', assignedGroup: groupId }, { roleName: 'Person', assignedUser: uids.max }, { roleName: 'Frei' }]
    }));
    const eventId = created.event?.id || created.id;
    const duties = async () => (await ok(call('owner', 'GET', '/api/events'))).find((event) => event.id === eventId).duties;
    const byName = async () => Object.fromEntries((await duties()).map((duty) => [duty.roleName, duty]));
    let now = await byName();
    // Made by the owner (whose Admin group manages events): official, it used to say otherwise for everyone
    assert.equal((await ok(call('owner', 'GET', '/api/events'))).find((event) => event.id === eventId).createdByManager, true);
    const byMember = await ok(call('max', 'POST', '/api/events', { title: 'Von einem Mitglied', date: inDays(26) }));
    const memberEventId = byMember.event?.id || byMember.id;
    assert.equal((await ok(call('owner', 'GET', '/api/events'))).find((event) => event.id === memberEventId).createdByManager, false);
    await ok(call('max', 'DELETE', `/api/events/${memberEventId}`));
    // The group's duty used to be stored as "confirmed": the app then showed "Person" and the group never saw it
    assert.deepEqual([now.Gruppe.status, now.Person.status, now.Frei.status], ['assigned', 'confirmed', 'open']);

    // Edited with the event: the person's duty goes to the group, the open one to a person
    await ok(call('owner', 'PATCH', `/api/events/${eventId}`, { duties: [
      { id: now.Gruppe.id, roleName: 'Gruppe', assignedGroup: groupId },
      { id: now.Person.id, roleName: 'Person', assignedGroup: groupId },
      { id: now.Frei.id, roleName: 'Frei', assignedUser: uids.mia }
    ] }));
    now = await byName();
    assert.deepEqual([now.Gruppe.status, now.Person.status, now.Frei.status], ['assigned', 'assigned', 'confirmed']);

    // Edited alone: an unknown status is refused, "open" frees the duty, a status never contradicts who has it
    assert.equal((await call('owner', 'PATCH', `/api/events/duties/${now.Frei.id}`, { status: 'erledigt' })).status, 400);
    await ok(call('owner', 'PATCH', `/api/events/duties/${now.Frei.id}`, { status: 'open' }));
    await ok(call('owner', 'PATCH', `/api/events/duties/${now.Gruppe.id}`, { status: 'confirmed' }));
    now = await byName();
    assert.deepEqual([now.Frei.status, now.Frei.assignedUser, now.Gruppe.status], ['open', '', 'assigned']);
    await ok(call('owner', 'DELETE', `/api/events/${eventId}`));
  });

  test('API v2: the books in cents with versions, the same data as v1, the same permissions', async () => {
    const v2 = (who, method, url, body) => call(who, method, `/api/v2${url}`, body);
    // Who am I; nothing but errors in the shape of v2
    const me = await ok(v2('treasurer', 'GET', '/me'));
    assert.equal(me.id, uids.treasurer);
    assert.ok(me.permissions.includes('manage_finances'));
    assert.deepEqual((await v2('max', 'GET', '/nothing-here')).body, { error: { code: 'not_found', message: 'There is no such resource in API v2.' } });
    assert.equal((await v2(null, 'GET', '/members')).status, 401);

    // Members: the treasurer sees all, a member only their own
    const all = await ok(v2('treasurer', 'GET', '/members?limit=500'));
    const mia = all.items.find((member) => member.userId === uids.mia);
    assert.ok(mia && Number.isInteger(mia.totalPaidCents) && Number.isInteger(mia.balanceCents) && mia.version);
    const own = await ok(v2('max', 'GET', '/members'));
    assert.deepEqual(own.items.map((member) => member.userId), [uids.max]);
    assert.equal((await v2('max', 'GET', `/members/${mia.id}`)).status, 403);

    // A payment written through v2 is the same payment for v1 (amount, date) and is in the change log
    const created = await ok(v2('treasurer', 'POST', '/payments', { memberId: mia.id, memberVersion: mia.version, amountCents: 2550, date: '2026-05-05', description: 'Über v2' }));
    assert.equal(created.amountCents, 2550);
    const v1 = await ok(call('treasurer', 'GET', `/api/db?path=people/${uids.mia}`));
    assert.ok(v1.payments.some((payment) => payment.amount === 25.5 && payment.date === '2026-05-05' && payment.description === 'Über v2'));
    // A change based on an old version is refused; with the current one it goes through
    const stale = await v2('treasurer', 'PATCH', `/payments/${created.id}`, { memberVersion: mia.version, amountCents: 3000 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'conflict');
    const changed = await ok(v2('treasurer', 'PATCH', `/payments/${created.id}`, { memberVersion: created.memberVersion, amountCents: 3000 }));
    assert.equal(changed.amountCents, 3000);
    assert.equal(changed.id, created.id, 'the payment keeps its id');
    assert.ok((await ok(call('treasurer', 'GET', `/api/db?path=people/${uids.mia}`))).payments.some((payment) => payment.amount === 30 && payment.description === 'Über v2'));
    // Booked for a request: once, however often it is sent
    const forRequest = { memberId: mia.id, memberVersion: changed.memberVersion, amountCents: 1000, date: '2026-05-06', description: 'Antrag', requestId: 'v2-test-request' };
    const booked = await ok(v2('treasurer', 'POST', '/payments', forRequest));
    assert.equal((await v2('treasurer', 'POST', '/payments', { ...forRequest, memberVersion: booked.memberVersion })).status, 409);
    // Pages: the next one starts after the last item of the one before
    const page1 = await ok(v2('treasurer', 'GET', `/payments?member=${mia.id}&limit=1`));
    assert.equal(page1.items.length, 1);
    assert.ok(page1.nextCursor);
    const page2 = await ok(v2('treasurer', 'GET', `/payments?member=${mia.id}&limit=500&cursor=${page1.nextCursor}`));
    assert.equal(page2.items.length, 1);
    assert.notEqual(page2.items[0].id, page1.items[0].id);
    assert.equal(page2.nextCursor, null);
    const removed = await v2('treasurer', 'DELETE', `/payments/${booked.id}?memberVersion=${encodeURIComponent(booked.memberVersion)}`);
    assert.equal(removed.status, 204);
    assert.equal((await v2('max', 'POST', '/payments', { memberId: mia.id, memberVersion: changed.memberVersion, amountCents: 1, date: '2026-05-07' })).status, 403);
    const logged = await ok(v2('treasurer', 'GET', `/finance/changes?area=payment&member=${mia.id}&limit=500`));
    assert.ok(logged.items.some((change) => change.action === 'update' && change.by === uids.treasurer && change.details.after.amount === 30));

    // Donations: the list's version
    const donations = await ok(v2('treasurer', 'GET', '/donations'));
    const donation = await ok(v2('treasurer', 'POST', '/donations', { listVersion: donations.listVersion, amountCents: 4200, date: '2026-05-08', donorName: 'Über v2' }));
    assert.equal(donation.amountCents, 4200);
    assert.equal((await v2('treasurer', 'PATCH', `/donations/${donation.id}`, { listVersion: donations.listVersion, amountCents: 1 })).status, 409);
    const donationNow = await ok(v2('treasurer', 'PATCH', `/donations/${donation.id}`, { listVersion: donation.listVersion, amountCents: 4300 }));
    assert.equal(donationNow.amountCents, 4300);
    const v1Donations = await ok(call('treasurer', 'GET', '/api/db?path=donations'));
    assert.ok((Array.isArray(v1Donations) ? v1Donations : Object.values(v1Donations)).some((entry) => entry.amount === 43 && entry.name === 'Über v2'));
    assert.equal((await v2('treasurer', 'DELETE', `/donations/${donation.id}?listVersion=${encodeURIComponent(donationNow.listVersion)}`)).status, 204);
    assert.equal((await v2('max', 'GET', '/donations')).status, 403);

    // Requests: a member asks, the treasurer decides once
    const asked = await ok(v2('max', 'POST', '/requests', { type: 'payment', details: { amount: '12.5', date: '2026-05-09', note: 'v2' } }));
    assert.equal(asked.status, 'pending');
    assert.equal(asked.amountCents, 1250);
    assert.ok((await ok(v2('max', 'GET', '/requests'))).items.every((request) => request.userId === uids.max));
    const decided = await ok(v2('treasurer', 'POST', `/requests/${asked.id}/decision`, { status: 'rejected', rejectionReason: 'Doppelt' }));
    assert.deepEqual([decided.status, decided.rejectionReason], ['rejected', 'Doppelt']);
    assert.equal((await v2('treasurer', 'POST', `/requests/${asked.id}/decision`, { status: 'approved' })).status, 409);

    // The summary sums the cents per month; an event as everyone who may see it sees it
    const summary = await ok(v2('treasurer', 'GET', '/finance/summary'));
    assert.ok(Number.isInteger(summary.totalsCents.memberPayments) && summary.months.length > 0);
    const eventId = await eventBy('owner', { title: 'v2-Abend', date: inDays(20), startTime: '19:00', requiresRegistration: true });
    await ok(call('max', 'POST', `/api/events/${eventId}/register`, { action: 'register' }));
    const event = (await ok(v2('max', 'GET', '/events?limit=500'))).items.find((item) => item.id === eventId);
    assert.deepEqual([event.title, event.startTime, event.registeredCount, event.myRegistration.status], ['v2-Abend', '19:00', 1, 'registered']);
    assert.equal((await ok(v2('max', 'GET', `/events/${eventId}`))).id, eventId);
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
      cloud.addFile('Agora/Fotos/Clip.mp4', 'mp4-bytes-0123456789', 'video/mp4');
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
      // the rules hold for managers too: without any, they see the folders (to set their rights), no files
      const bare = await ok(list('owner', ''));
      assert.equal(bare.access, 'none');
      assert.deepEqual(names(bare.folders), ['Fotos', 'Intern']);
      assert.deepEqual(bare.files, []);
      await ok(rules('', { [`user:${uids.owner}`]: 'write' }));
      const root = await ok(list('owner', ''));
      assert.equal(root.access, 'write');
      assert.deepEqual(names(root.folders), ['Fotos', 'Intern']);
      assert.deepEqual(names(root.files), ['willkommen.pdf']);
      assert.equal(root.files[0].kind, 'pdf');
      const fotos = await ok(list('owner', 'Fotos'));
      assert.deepEqual(names(fotos.files), ['Clip.mp4', 'logo.svg', 'Sommer.jpg'].sort(), 'dot files are left out');
      assert.equal(fotos.files.find((f) => f.name === 'Clip.mp4').kind, 'video');
      assert.equal(fotos.files.find((f) => f.name === 'Sommer.jpg').hasPreview, true);
      assert.ok(fotos.files.every((f) => f.path.startsWith('Fotos/') && f.etag));
      await ok(rules('', {}));
    });

    test('rules: read, write and no access per group, inherited by the folders below', async () => {
      assert.equal((await call('max', 'GET', '/api/media/rules')).status, 403);
      assert.equal((await rules('Fotos', { '*': 'admin' })).status, 400);
      assert.equal((await rules('Fotos', { nogroup: 'read' })).status, 400);
      assert.equal((await rules('../Outside', { '*': 'read' })).status, 400);
      await ok(rules('Fotos', { '*': 'read' }));
      await ok(rules('Fotos/Privat', { '*': 'hide' }));
      await ok(rules('Fotos/Jugend', { [jugend]: 'write' }));
      await ok(rules('Intern/Leitung', { [jugend]: 'read' }));

      // no access to the base folder: no media library at all, although Fotos may be read
      assert.deepEqual(await ok(call('max', 'GET', '/api/media/status')), { enabled: true, canManage: false, hasAccess: false });
      assert.equal((await list('max', 'Fotos')).status, 404);
      assert.equal((await call('max', 'GET', '/api/media/file?path=Fotos/Sommer.jpg')).status, 404);
      await ok(rules('', { '*': 'read' }));
      await ok(rules('Intern', { '*': 'hide' }));

      // every member: the base folder and Fotos, not the hidden folders
      assert.deepEqual(await ok(call('max', 'GET', '/api/media/status')), { enabled: true, canManage: false, hasAccess: true });
      const root = await ok(list('max', ''));
      assert.equal(root.access, 'read');
      assert.deepEqual(names(root.folders), ['Fotos']);
      assert.deepEqual(names(root.files), ['willkommen.pdf']);
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

      // "no access" for a group holds although all members may read: the group rule is the more specific one
      await ok(rules('Fotos', { '*': 'read', [jugend]: 'hide' }));
      const kept = await ok(list('jule', 'Fotos'));
      assert.equal(kept.access, 'none');
      assert.deepEqual(names(kept.folders), ['Jugend'], 'only the way to their own folder');
      assert.deepEqual(kept.files, []);
      assert.equal((await call('jule', 'GET', '/api/media/file?path=Fotos/Sommer.jpg')).status, 404);
      assert.equal((await ok(list('max', 'Fotos'))).access, 'read');
      await ok(rules('Fotos', { '*': 'read' }));

      // no access to the base folder for the group: the library is gone for them, their write folder too
      await ok(rules('', { '*': 'read', [jugend]: 'hide' }));
      assert.equal((await ok(call('jule', 'GET', '/api/media/status'))).hasAccess, false);
      assert.equal((await list('jule', 'Fotos/Jugend')).status, 404);
      assert.equal((await upload('jule', 'Fotos/Jugend', [['x.jpg', 'x', 'image/jpeg']])).status, 404);
      assert.equal((await ok(call('max', 'GET', '/api/media/status'))).hasAccess, true);
      await ok(rules('', { '*': 'read' }));

      // managers see the rules on the folders; the rights dialog shows what comes from above
      const managed = await ok(list('owner', 'Fotos'));
      assert.deepEqual(managed.folders.find((f) => f.name === 'Privat').hiddenFor, ['*']);
      const dialog = await ok(call('owner', 'GET', '/api/media/rules?path=Fotos/Jugend'));
      assert.deepEqual(dialog.folder.own, { [jugend]: 'write' });
      assert.deepEqual(dialog.folder.inherited, { '*': { level: 'read', from: 'Fotos' } });
      assert.ok(dialog.choices.some((c) => c.id === '*') && dialog.choices.some((c) => c.id === jugend && c.kind === 'group'));
      assert.ok(dialog.choices.some((c) => c.id === `user:${uids.max}` && c.kind === 'person' && c.name === 'Max Test'), 'people can be picked too');
      assert.equal(dialog.rules.length, 6);

      // the rules hold for managers too: they see the hidden folders (to set their rights), not what is in them
      assert.ok(names((await ok(list('owner', ''))).folders).includes('Intern'));
      const hiddenFromManager = await ok(list('owner', 'Fotos/Privat'));
      assert.equal(hiddenFromManager.access, 'none');
      assert.deepEqual(hiddenFromManager.files, []);
      assert.equal((await call('owner', 'GET', '/api/media/file?path=Fotos/Privat/geheim.jpg')).status, 404);
      const refused = await upload('owner', 'Fotos/Privat', [['a.jpg', 'x', 'image/jpeg']]);
      assert.equal(refused.status, 403);
      assert.equal(cloud.nodes.has('Agora/Fotos/Privat/a.jpg'), false);
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
      // video and music play in the app: their own type, ranges for seeking
      const clip = await fetch(`${base}/api/media/file?path=Fotos/Clip.mp4`, { headers: { Authorization: `Bearer ${tokens.max}`, Range: 'bytes=4-9' } });
      assert.equal(clip.status, 206);
      assert.equal(clip.headers.get('content-type'), 'video/mp4');
      assert.match(clip.headers.get('content-disposition'), /^inline;/);
      assert.equal(await clip.text(), 'bytes-');
      const svg = await call('max', 'GET', '/api/media/file?path=Fotos/logo.svg');
      assert.equal(svg.headers.get('content-type'), 'application/octet-stream');
      assert.match(svg.headers.get('content-disposition'), /^attachment;/);
      const pdf = await call('jule', 'GET', `/api/media/file?path=${encodeURIComponent('Intern/Leitung/plan.pdf')}`);
      assert.equal(pdf.headers.get('content-type'), 'application/pdf');
      assert.equal(pdf.headers.get('content-security-policy'), null, 'the PDF viewers need no sandbox');
      const download = await call('jule', 'GET', `/api/media/file?path=${encodeURIComponent('Intern/Leitung/plan.pdf')}&download=1`);
      assert.match(download.headers.get('content-disposition'), /^attachment; filename="plan.pdf"/);
    });

    test('adding: files and folders where the group may write; nothing is ever replaced', async () => {
      assert.equal((await upload('max', 'Fotos/Jugend', [['a.jpg', 'x', 'image/jpeg']])).status, 403);
      assert.equal((await upload('max', 'Fotos/Privat', [['a.jpg', 'x', 'image/jpeg']])).status, 404);
      const first = await ok(upload('jule', 'Fotos/Jugend', [['Freizeit.jpg', 'one', 'image/jpeg'], ['Grüße.txt', 'hallo', 'text/plain']]));
      assert.deepEqual(first.files.map((f) => f.path), ['Fotos/Jugend/Freizeit.jpg', 'Fotos/Jugend/Grüße.txt']);
      const second = await ok(upload('jule', 'Fotos/Jugend', [['Freizeit.jpg', 'two', 'image/jpeg']]));
      assert.equal(second.files[0].name, 'Freizeit (2).jpg');
      assert.equal(cloud.nodes.get('Agora/Fotos/Jugend/Freizeit.jpg').data.toString(), 'one', 'the first file is untouched');
      assert.equal((await upload('jule', 'Fotos/Jugend', [['.htaccess', 'x', 'text/plain']])).status, 400);
      // A bad name further down refuses the whole upload before anything is stored
      assert.equal((await upload('jule', 'Fotos/Jugend', [['Vorher.jpg', 'x', 'image/jpeg'], ['.DS_Store', 'x', 'application/octet-stream']])).status, 400);
      assert.ok(!cloud.nodes.has('Agora/Fotos/Jugend/Vorher.jpg'), 'nothing of a refused upload is stored');

      assert.equal((await call('max', 'POST', '/api/media/folder', { path: 'Fotos', name: 'Neu' })).status, 403);
      assert.equal((await call('jule', 'POST', '/api/media/folder', { path: 'Fotos/Jugend', name: '../x' })).status, 400);
      await ok(call('jule', 'POST', '/api/media/folder', { path: 'Fotos/Jugend', name: 'Sommer 2026' }));
      assert.equal((await call('jule', 'POST', '/api/media/folder', { path: 'Fotos/Jugend', name: 'Sommer 2026' })).status, 409);
      assert.equal((await ok(list('jule', 'Fotos/Jugend/Sommer 2026'))).access, 'write', 'inherits the rights');
      // adding never deletes, moves or copies anything
      assert.equal((await call('owner', 'DELETE', '/api/media/file?path=Fotos/Sommer.jpg')).status, 404);
      assert.ok(!cloud.requests.some((r) => ['DELETE', 'MOVE', 'COPY'].includes(r.method)));
      // nothing outside the base folder was ever asked for
      assert.ok(!cloud.requests.some((r) => r.path.includes('/Outside') || String(r.query.file || '').includes('Outside')));
    });

    test('single people: a right of their own goes before their groups', async () => {
      // Max gets Intern without any group; Jule (Jugend writes in Fotos/Jugend) is kept out of it
      await ok(rules('Intern', { '*': 'hide', [`user:${uids.max}`]: 'read' }));
      await ok(rules('Fotos/Jugend', { [jugend]: 'write', [`user:${uids.jule}`]: 'hide' }));
      assert.equal((await ok(list('max', 'Intern'))).access, 'read');
      assert.equal((await ok(list('jule', 'Intern'))).access, 'none', 'Jule only passes through (to Intern/Leitung)');
      assert.equal((await list('jule', 'Fotos/Jugend')).status, 404, 'hidden for her alone');
      assert.ok(!(await ok(list('jule', 'Fotos'))).folders.some((f) => f.name === 'Jugend'));
      assert.equal((await rules('Intern', { 'user:nobody': 'read' })).status, 400);
      // back to how the tests before left it
      await ok(rules('Intern', { '*': 'hide' }));
      await ok(rules('Fotos/Jugend', { [jugend]: 'write' }));
      assert.equal((await ok(list('jule', 'Fotos/Jugend'))).access, 'write');
    });

    test('several at once: download as one archive, delete where the member may write everywhere in it', async () => {
      const remove = (who, folder, entries) => call(who, 'POST', '/api/media/delete', { path: folder, names: entries });
      cloud.addFile('Agora/Fotos/Jugend/Sommer 2026/Bild 1.jpg', 'bild-eins', 'image/jpeg');
      cloud.addFile('Agora/Fotos/Jugend/Sommer 2026/Leiter/liste.txt', 'nur lesen', 'text/plain');
      cloud.addFile('Agora/Fotos/Jugend/Sommer 2026/Versteckt/x.txt', 'nicht für Jule', 'text/plain');
      await ok(rules('Fotos/Jugend/Sommer 2026/Leiter', { [jugend]: 'read' }));
      await ok(rules('Fotos/Jugend/Sommer 2026/Versteckt', { [jugend]: 'hide' }));

      // read only: nothing to delete; nothing outside the folder or the base folder itself
      assert.equal((await remove('max', 'Fotos', ['Sommer.jpg'])).status, 403);
      assert.equal((await remove('jule', 'Fotos/Jugend', ['../Sommer.jpg'])).status, 400);
      assert.equal((await remove('jule', 'Fotos/Jugend', [])).status, 400);
      assert.equal((await remove('owner', '', [''])).status, 400);
      assert.ok(cloud.nodes.has('Agora/Fotos/Sommer.jpg'));

      // the listing says which folders can go: not one with a folder below that the member may only read
      const before = await ok(list('jule', 'Fotos/Jugend'));
      assert.equal(before.folders.find((f) => f.name === 'Sommer 2026').canDelete, false);
      assert.equal((await ok(list('owner', 'Fotos/Jugend'))).folders.find((f) => f.name === 'Sommer 2026').canDelete, false, 'managers too');

      // one archive: the folder with what Jule may see in it (not the hidden folder) and a file next to it
      const asked = await ok(call('jule', 'POST', '/api/media/download', { path: 'Fotos/Jugend', names: ['Sommer 2026', 'Freizeit.jpg'] }));
      assert.equal(asked.files, 3);
      assert.equal((await call('max', 'GET', asked.url)).status, 404, 'only for the member who asked');
      const zipped = await fetch(`${base}${asked.url}`, { headers: { Authorization: `Bearer ${tokens.jule}` } });
      assert.equal(zipped.status, 200);
      assert.equal(zipped.headers.get('content-type'), 'application/zip');
      assert.match(zipped.headers.get('content-disposition'), /^attachment; filename="Jugend.zip"/);
      const archive = unzip(Buffer.from(await zipped.arrayBuffer()));
      assert.deepEqual(Object.keys(archive).sort(), ['Freizeit.jpg', 'Sommer 2026/', 'Sommer 2026/Bild 1.jpg', 'Sommer 2026/Leiter/', 'Sommer 2026/Leiter/liste.txt']);
      assert.equal(archive['Sommer 2026/Bild 1.jpg'], 'bild-eins');
      assert.equal(archive['Freizeit.jpg'], 'one');
      assert.equal((await call('max', 'POST', '/api/media/download', { path: 'Intern', names: ['notiz.txt'] })).status, 404);

      // delete: files where Jule may write; the folder only once she may write everywhere in it
      const done = await ok(remove('jule', 'Fotos/Jugend', ['Freizeit (2).jpg', 'Sommer 2026']));
      assert.deepEqual(done.deleted, ['Freizeit (2).jpg']);
      assert.equal(done.failed[0].name, 'Sommer 2026');
      assert.ok(!cloud.nodes.has('Agora/Fotos/Jugend/Freizeit (2).jpg'));
      assert.ok(cloud.nodes.has('Agora/Fotos/Jugend/Sommer 2026/Leiter/liste.txt'));
      assert.equal((await remove('jule', 'Fotos/Jugend', ['Sommer 2026'])).status, 403);
      await ok(rules('Fotos/Jugend/Sommer 2026/Leiter', { [jugend]: 'write' }));
      await ok(rules('Fotos/Jugend/Sommer 2026/Versteckt', {}));
      assert.deepEqual((await ok(remove('jule', 'Fotos/Jugend', ['Sommer 2026']))).deleted, ['Sommer 2026']);
      assert.ok(![...cloud.nodes.keys()].some((key) => key.startsWith('Agora/Fotos/Jugend/Sommer 2026')));
      // its rights went with it
      assert.ok(!(await ok(call('owner', 'GET', '/api/media/rules'))).rules.some((r) => r.path.startsWith('Fotos/Jugend/Sommer 2026')));
      // already gone (another device was quicker): done all the same
      assert.deepEqual((await ok(remove('jule', 'Fotos/Jugend', ['Sommer 2026']))).deleted, ['Sommer 2026']);
    });

    test('a deleted account loses its rules', async () => {
      const id = await account('kurz', 'Kurz');
      await ok(rules('Dokumente', { [`user:${id}`]: 'read' }));
      await ok(call('owner', 'DELETE', `/api/admin/users/${id}`));
      assert.ok(!(await ok(call('owner', 'GET', '/api/media/rules'))).rules.some((r) => r.path === 'Dokumente'));
    });

    test('a deleted group loses its rules; switched off, Media is gone for everyone', async () => {
      const group = await ok(call('owner', 'POST', '/api/admin/groups', { name: 'Kurzzeit', permissions: [] }));
      const id = group.id || group.group?.id;
      await ok(rules('Intern', { '*': 'hide', [id]: 'read' }));
      await ok(call('owner', 'DELETE', `/api/admin/groups/${id}`));
      const intern = (await ok(call('owner', 'GET', '/api/media/rules'))).rules.find((r) => r.path === 'Intern');
      assert.deepEqual(intern.groups, { '*': 'hide' });
      await ok(rules('Intern/Leitung', {}));
      assert.equal((await list('jule', 'Intern')).status, 404, 'rule removed');

      await ok(call('owner', 'PUT', '/api/admin/media-config', settings({ enabled: false, password: '***' })));
      assert.deepEqual(await ok(call('jule', 'GET', '/api/media/status')), { enabled: false, canManage: false, hasAccess: false });
      assert.equal((await list('jule', 'Fotos')).status, 503);
      await ok(call('owner', 'PUT', '/api/admin/media-config', settings({ password: '***' })));
    });
  });
  test('AI chat: thoughts and answer stream through, provider errors arrive as an event', async () => {
    // A small OpenAI-compatible provider: "thinker" thinks first (OpenRouter style "reasoning"), then answers;
    // "broken" fails
    const http = require('http');
    const provider = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (part) => { raw += part; });
      req.on('end', async () => {
        const { model, stream } = JSON.parse(raw);
        assert.equal(stream, true);
        if (model === 'broken') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'model overloaded' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
        res.write(': OPENROUTER PROCESSING\n\n');
        send({ role: 'assistant', content: '', reasoning: 'Ich ' });
        send({ content: '', reasoning: 'überlege.' });
        await new Promise((resolve) => setTimeout(resolve, 150));
        send({ content: 'Hallo', reasoning: null });
        send({ content: ' Max!' });
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    try {
      const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
      const chat = async (model) => {
        await ok(call('owner', 'PUT', '/api/admin/ai-config', { enabled: true, baseUrl, apiKey: 'test-key', model }));
        const res = await call('owner', 'POST', '/api/ai/chat', { messages: [{ role: 'user', content: 'Hallo?' }] });
        assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
        assert.match(res.headers.get('content-type'), /text\/event-stream/);
        return String(res.body).split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
          .map((data) => (data === '[DONE]' ? data : JSON.parse(data)));
      };

      const events = await chat('thinker');
      assert.deepEqual(events, [{ reasoning: 'Ich ' }, { reasoning: 'überlege.' }, { content: 'Hallo' }, { content: ' Max!' }, '[DONE]']);

      const failed = await chat('broken');
      assert.deepEqual(failed, [{ error: 'model overloaded' }]);
    } finally {
      provider.close();
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  });

  // --- AI lookups: the model may look up the full history (backend/aiTools.js, routes/ai.js) --------------------------

  // A stand-in AI provider (OpenAI-compatible): [answer](body, n) decides every answer - { status, message } for an
  // error, otherwise the deltas to stream ({ content }, { reasoning }, { tool_calls }). It keeps every request.
  async function standInProvider(answer) {
    const http = require('http');
    const requests = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (part) => { raw += part; });
      req.on('end', async () => {
        const body = JSON.parse(raw);
        requests.push(body);
        const reply = await answer(body, requests.length - 1);
        if (!Array.isArray(reply)) {
          res.writeHead(reply.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: reply.message } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const delta of reply) res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
  }
  // The AI settings with the stand-in provider (effort: as stored, unless named)
  const useProvider = (provider, extra = {}) => ok(call('owner', 'PUT', '/api/admin/ai-config', { enabled: true, provider: 'custom', baseUrl: provider.baseUrl, apiKey: 'test-key', model: 'stand-in', ...extra }));
  // Asks the AI as [who]: what the server streams back (lookups, thoughts, text, '[DONE]')
  async function askAi(who, content) {
    const res = await call(who, 'POST', '/api/ai/chat', { messages: [{ role: 'user', content }] });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    return String(res.body).split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
      .map((data) => (data === '[DONE]' ? data : JSON.parse(data)));
  }
  // A tool call as OpenAI streams it: the name first, then the arguments in pieces
  const toolCall = (index, name, args) => {
    const text = JSON.stringify(args);
    return [
      { tool_calls: [{ index, id: `call_${name}_${index}`, type: 'function', function: { name, arguments: '' } }] },
      { tool_calls: [{ index, function: { arguments: text.slice(0, Math.ceil(text.length / 2)) } }] },
      { tool_calls: [{ index, function: { arguments: text.slice(Math.ceil(text.length / 2)) } }] }
    ];
  };
  const toolResults = (body) => body.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));
  const questionOf = (body) => body.messages.filter((message) => message.role === 'user').pop().content;
  const systemOf = (body) => body.messages[0].content;
  const lookupsIn = (events) => events.filter((event) => event.lookup).map((event) => event.lookup);
  const textOf = (events) => events.filter((event) => typeof event.content === 'string').map((event) => event.content).join('');
  // Accounts that may use the assistant: with the finances, or without
  let aiGroups = null;
  async function aiAccount(who, firstName, withFinances) {
    if (!aiGroups) {
      aiGroups = {
        finance: await ok(call('owner', 'POST', '/api/admin/groups', { name: 'KI mit Kasse', permissions: ['access_ai', 'view_finances'] })),
        plain: await ok(call('owner', 'POST', '/api/admin/groups', { name: 'KI', permissions: ['access_ai'] }))
      };
    }
    const uid = await account(who, firstName);
    const group = withFinances ? aiGroups.finance : aiGroups.plain;
    await ok(call('owner', 'PUT', `/api/admin/users/${uid}/groups`, { groups: [group.id || group.group?.id] }));
    return uid;
  }
  // Appends entries to the donations or expenses (as the web app saves them)
  async function addToList(root, entries) {
    const current = await ok(call('treasurer', 'GET', `/api/db?path=${root}`));
    const list = Array.isArray(current) ? current : Object.values(current || {});
    await ok(call('treasurer', 'PUT', '/api/db', { path: root, value: [...list, ...entries] }));
  }
  const ALL_LOOKUPS = ['events', 'finance_changes', 'members', 'money', 'money_totals'];

  test('AI settings: the effort level is medium until one is chosen, and only low, medium, high, xhigh or max are taken', async () => {
    const provider = await standInProvider(() => [{ content: 'OK' }]);
    try {
      await useProvider(provider);
      const settings = await ok(call('owner', 'GET', '/api/admin/ai-config'));
      assert.deepEqual(settings, { enabled: true, provider: 'custom', baseUrl: provider.baseUrl, apiKey: '***', model: 'stand-in', effort: 'medium' });
      await useProvider(provider, { effort: 'high' });
      assert.equal((await ok(call('owner', 'GET', '/api/admin/ai-config'))).effort, 'high');
      // A save without one (an older app) keeps it
      await useProvider(provider);
      assert.equal((await ok(call('owner', 'GET', '/api/admin/ai-config'))).effort, 'high');
      for (const level of ['xhigh', 'max']) {
        await useProvider(provider, { effort: level });
        assert.equal((await ok(call('owner', 'GET', '/api/admin/ai-config'))).effort, level);
      }
      await useProvider(provider, { effort: 'high' });
      for (const wrong of ['extreme', 5, 'HIGH', '__proto__']) {
        assert.equal((await call('owner', 'PUT', '/api/admin/ai-config', { effort: wrong })).status, 400, String(wrong));
      }
      assert.equal((await ok(call('owner', 'GET', '/api/admin/ai-config'))).effort, 'high');
      // Only the owner's settings page sees and sets it
      assert.equal((await call('treasurer', 'PUT', '/api/admin/ai-config', { effort: 'low' })).status, 403);
      await useProvider(provider, { effort: 'medium' });
    } finally {
      provider.close();
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  });

  test('AI lookups: only when the model asks - the result has the exact amounts, the chat sees what is looked up', async () => {
    await aiAccount('kira', 'Kira', true);
    await addToList('expenses', [
      { id: 1796000000001, amount: 45.5, description: 'Christvesper Blumen', issuer: 'Theo', date: '2016-12-20' },
      { id: 1796000000002, amount: '12,35', description: 'Heiligabend Kerzen', issuer: 'Theo', date: '2018-12-22' },
      { id: 1796000000003, amount: 300, description: 'Saalmiete', issuer: 'Theo', date: '2018-01-05' },
      { id: 1796000000004, amount: 99, description: 'Christvesper Technik', issuer: 'Theo', date: '2015-12-24' }
    ]);
    const provider = await standInProvider((body) => {
      if (questionOf(body) === 'Hallo?') return [{ content: 'Hallo!' }];
      const results = toolResults(body);
      if (!results.length) return [{ content: 'Ich schaue nach.' }, ...toolCall(0, 'money', { step: 'Suche die Weihnachtskosten', kind: 'expenses', from: '2016', to: '2018', search: ['christvesper', 'Heiligabend'], groupBy: ['year'] })];
      return [{ content: `Zusammen ${results[0].total.eur} EUR: ${results[0].descriptions.join('; ')}` }];
    });
    try {
      await useProvider(provider, { effort: 'medium' });
      // An ordinary question: one request, the lookups offered but not used - the answer as it always came
      assert.deepEqual(await askAi('kira', 'Hallo?'), [{ content: 'Hallo!' }, '[DONE]']);
      assert.equal(provider.requests.length, 1);
      assert.deepEqual(provider.requests[0].tools.map((entry) => entry.function.name).sort(), ALL_LOOKUPS);
      // Every lookup asks the model to say what it does (the chat shows it, also for models that keep their thoughts)
      assert.ok(provider.requests[0].tools.every((entry) => entry.function.parameters.required.includes('step')));
      assert.match(systemOf(provider.requests[0]), /Lookups: the context below is a summary/);
      assert.ok(!('reasoning_effort' in provider.requests[0]) && !('tool_choice' in provider.requests[0]));

      // A question that needs older entries: the model looks them up, gets them, answers
      const events = await askAi('kira', 'Was hat Weihnachten 2016 bis 2018 gekostet?');
      assert.equal(provider.requests.length, 3);
      const second = provider.requests[2];
      const asked = second.messages.find((message) => message.role === 'assistant');
      assert.deepEqual(asked.tool_calls, [{ id: 'call_money_0', type: 'function', function: { name: 'money', arguments: JSON.stringify({ step: 'Suche die Weihnachtskosten', kind: 'expenses', from: '2016', to: '2018', search: ['christvesper', 'Heiligabend'], groupBy: ['year'] }) } }]);
      assert.equal(asked.content, 'Ich schaue nach.');
      assert.equal(second.messages.find((message) => message.role === 'tool').tool_call_id, 'call_money_0');
      // Exact amounts (summed in cents), the newest year first, and the descriptions it counted (2015 is outside)
      assert.deepEqual(toolResults(second)[0], {
        kind: 'expenses',
        total: { entries: 2, eur: 57.85 },
        descriptions: ['Christvesper Blumen (1×, 45.5)', 'Heiligabend Kerzen (1×, 12.35)'],
        columns: ['year', 'eur', 'entries'],
        rows: [['2018', 12.35, 1], ['2016', 45.5, 1]]
      });
      assert.deepEqual(events, [
        { content: 'Ich schaue nach.' },
        { lookup: { id: 1, tool: 'expenses', step: 'Suche die Weihnachtskosten', from: '2016', to: '2018', about: 'christvesper, Heiligabend' } },
        { lookupDone: { id: 1, count: 2, unit: 'entries', eur: 57.85 } },
        { content: '\n\n' },
        { content: 'Zusammen 57.85 EUR: Christvesper Blumen (1×, 45.5); Heiligabend Kerzen (1×, 12.35)' },
        '[DONE]'
      ]);
    } finally {
      provider.close();
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  });

  test('AI lookups: the effort level limits them - none on low (the request as before), 4 on medium, 10 and more thinking on high', async () => {
    let parallel = 1;
    let obeys = true;
    const provider = await standInProvider((body) => {
      // Looks up for as long as it may (or longer, when it does not obey tool_choice)
      if (!body.tools || (body.tool_choice === 'none' && obeys)) return [{ content: `Fertig nach ${toolResults(body).length}` }];
      return Array.from({ length: parallel }, (_, index) => toolCall(index, 'money_totals', { per: 'year' })).flat();
    });
    try {
      // Low: the compact context only - the request is exactly the one it always was
      await useProvider(provider, { effort: 'low' });
      const low = await askAi('kira', 'Wie steht die Kasse?');
      assert.deepEqual(low, [{ content: 'Fertig nach 0' }, '[DONE]']);
      assert.equal(provider.requests.length, 1);
      assert.deepEqual(Object.keys(provider.requests[0]).sort(), ['messages', 'model', 'stream']);
      assert.ok(!systemOf(provider.requests[0]).includes('Lookups:'));

      // Medium: 4 lookups, then the model has to answer (tool_choice "none")
      await useProvider(provider, { effort: 'medium' });
      provider.requests.length = 0;
      const medium = await askAi('kira', 'Wie steht die Kasse?');
      assert.equal(lookupsIn(medium).length, 4);
      assert.equal(provider.requests.length, 5);
      assert.deepEqual(provider.requests.map((body) => body.tool_choice ?? null), [null, null, null, null, 'none']);
      assert.ok(provider.requests.every((body) => !('reasoning_effort' in body)));
      assert.equal(textOf(medium).trim(), 'Fertig nach 4');

      // Several at once: the first ones run, the rest are told there are no lookups left
      parallel = 3;
      provider.requests.length = 0;
      const several = await askAi('kira', 'Wie steht die Kasse?');
      assert.equal(lookupsIn(several).length, 4);
      assert.equal(provider.requests.length, 3);
      const told = toolResults(provider.requests[2]);
      assert.equal(told.length, 6);
      assert.equal(told.filter((result) => result.error?.startsWith('No more lookups')).length, 2);

      // High: 10 lookups, and every request asks for more thinking
      parallel = 1;
      await useProvider(provider, { effort: 'high' });
      provider.requests.length = 0;
      const high = await askAi('kira', 'Wie steht die Kasse?');
      assert.equal(lookupsIn(high).length, 10);
      assert.equal(provider.requests.length, 11);
      assert.ok(provider.requests.every((body) => body.reasoning_effort === 'high'));

      // A provider that ignores tool_choice: one last request with the results as text and without tools
      obeys = false;
      await useProvider(provider, { effort: 'medium' });
      provider.requests.length = 0;
      const stubborn = await askAi('kira', 'Wie steht die Kasse?');
      assert.equal(lookupsIn(stubborn).length, 4);
      assert.equal(provider.requests.length, 6);
      const last = provider.requests[5];
      assert.ok(!('tools' in last));
      assert.match(questionOf(last), /^Wie steht die Kasse\?\n\nLookups already made for this question, with their results:\nmoney_totals \{"per":"year"\}: \{/);
      assert.equal(stubborn[stubborn.length - 1], '[DONE]');
      assert.match(textOf(stubborn), /Fertig nach 0$/);
    } finally {
      provider.close();
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  });

  test('AI lookups: every lookup checks the asking person\'s permissions - finances, calendar, duty roster', async () => {
    const karl = await aiAccount('karl', 'Karl', false);
    await ok(call('owner', 'POST', '/api/admin/groups', { name: 'KI-Leitung', permissions: [] }));
    // An event for everyone with a duty roster Karl may not see, and one only for a group Karl is not in
    const open = await ok(call('owner', 'POST', '/api/events', {
      title: 'KI-Gemeindeabend', date: '2027-03-05', startTime: '19:00', requiresRegistration: true, maxParticipants: 20,
      duties: [{ roleName: 'Technik', assignedUser: uids.treasurer }]
    }));
    await ok(call('owner', 'POST', '/api/events', { title: 'KI-Gemeindeabend Leitung', date: '2027-03-06', targetGroups: ['KI-Leitung'] }));
    await ok(call('mia', 'POST', `/api/events/${open.event.id}/register`, {}));
    let beforeLookup = null;
    const provider = await standInProvider(async (body) => {
      const results = toolResults(body);
      if (results.length) return [{ content: 'Fertig.' }];
      if (beforeLookup) await beforeLookup();
      return [
        ...toolCall(0, 'money', { kind: 'payments', groupBy: ['year'] }),
        ...toolCall(1, 'events', { title: ['KI-Gemeindeabend'] }),
        ...toolCall(2, 'members', {}),
        ...toolCall(3, 'money_totals', {}),
        ...toolCall(4, 'finance_changes', {})
      ];
    });
    try {
      await useProvider(provider, { effort: 'high' });
      // Karl may not see the finances: only the events lookup is offered, and every finance lookup is refused all the same
      const karlEvents = await askAi('karl', 'Was war los?');
      assert.deepEqual(provider.requests[0].tools.map((entry) => entry.function.name), ['events']);
      // The chat hears what was refused: the four finance lookups, the events were found
      assert.deepEqual(karlEvents.filter((event) => event.lookupDone).map((event) => event.lookupDone.error || event.lookupDone.unit), ['forbidden', 'events', 'forbidden', 'forbidden', 'forbidden']);
      assert.match(systemOf(provider.requests[0]), /Lookups: the events list below covers/);
      assert.ok(!systemOf(provider.requests[0]).includes('Lookups: the context below'));
      const [payments, events, ...finance] = toolResults(provider.requests[1]);
      for (const refused of [payments, ...finance]) assert.match(refused.error, /may not see this/);
      assert.equal(finance.length, 3);
      // Only what Karl sees in the calendar; sign-ups as numbers, no roster for him
      assert.deepEqual(events.columns, ['date', 'time', 'title', 'place', 'status', 'registered', 'waitlist', 'places', 'duties', 'about']);
      assert.deepEqual(events.rows, [['2027-03-05', '19:00', 'KI-Gemeindeabend', '', '', 1, 0, 20, null, '']]);
      assert.ok(!JSON.stringify(events).includes('Mia'), 'no names of who signed up');

      // The owner created both events: both, with the roster and its names
      provider.requests.length = 0;
      await askAi('owner', 'Was war los?');
      const [, ownerEvents] = toolResults(provider.requests[1]);
      assert.deepEqual(ownerEvents.rows.map((entry) => [entry[2], entry[8]]), [['KI-Gemeindeabend Leitung', ''], ['KI-Gemeindeabend', 'Technik: Theo Test']]);

      // With the finances: every lookup, the payments are there
      await aiAccount('kai', 'Kai', true);
      provider.requests.length = 0;
      await askAi('kai', 'Was war los?');
      assert.deepEqual(provider.requests[0].tools.map((entry) => entry.function.name).sort(), ALL_LOOKUPS);
      const [kaiPayments] = toolResults(provider.requests[1]);
      assert.ok(Array.isArray(kaiPayments.rows) && kaiPayments.rows.length > 0, 'with finance rights the payments are there');

      // Permissions taken away while a question runs: the next lookup is refused
      const financeGroup = aiGroups.finance.id || aiGroups.finance.group?.id;
      beforeLookup = async () => {
        await ok(call('owner', 'PUT', `/api/admin/groups/${financeGroup}`, { permissions: ['access_ai'] }));
        beforeLookup = null;
      };
      provider.requests.length = 0;
      await askAi('kai', 'Was war los?');
      assert.ok(provider.requests[0].tools.some((entry) => entry.function.name === 'money'), 'offered when the question came');
      assert.match(toolResults(provider.requests[1])[0].error, /may not see this/);
      await ok(call('owner', 'PUT', `/api/admin/groups/${financeGroup}`, { permissions: ['access_ai', 'view_finances'] }));

      // The assistant taken away while a question runs: no lookups at all
      beforeLookup = async () => {
        await ok(call('owner', 'PUT', `/api/admin/users/${karl}/groups`, { groups: [] }));
        beforeLookup = null;
      };
      provider.requests.length = 0;
      await askAi('karl', 'Was war los?');
      assert.ok(toolResults(provider.requests[1]).every((result) => /no longer use the assistant/.test(result.error)));
    } finally {
      provider.close();
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  });

  test('AI lookups: results stay within the caps of the effort level and say when they were cut', async () => {
    await addToList('donations', Array.from({ length: 130 }, (_, index) => ({
      id: 1797000000000 + index, amount: 5 + (index % 7) / 4, name: 'Kappenspender', date: `2017-${String((index % 12) + 1).padStart(2, '0')}-1${index % 9}`, description: `Kappensammlung ${index} für die Jugendfreizeit im Sommer`
    })));
    const expected = Math.round(Array.from({ length: 130 }, (_, index) => Math.round((5 + (index % 7) / 4) * 100)).reduce((a, b) => a + b, 0)) / 100;
    let calls = 1;
    const provider = await standInProvider((body) => {
      if (toolResults(body).length || body.tool_choice === 'none') return [{ content: 'Fertig.' }];
      return Array.from({ length: calls }, (_, index) => toolCall(index, 'money', { kind: 'donations', search: ['Kappenspender'] })).flat();
    });
    try {
      await useProvider(provider, { effort: 'medium' });
      await askAi('kira', 'Wer hat gespendet?');
      const [medium] = toolResults(provider.requests[1]);
      const mediumText = provider.requests[1].messages.find((message) => message.role === 'tool').content;
      assert.deepEqual(medium.total, { entries: 130, eur: expected }, 'the total counts everything');
      assert.ok(medium.rows.length > 0 && medium.rows.length <= 50, `${medium.rows.length} rows`);
      assert.ok(mediumText.length <= 8000, `${mediumText.length} characters`);
      assert.equal(medium.cut, `only ${medium.rows.length} of 130 rows (newest first): narrow the filters or sum up with groupBy for the rest`);

      // All lookups of one question together stay within the total: the last one gets what is left
      calls = 4;
      provider.requests.length = 0;
      await askAi('kira', 'Wer hat gespendet?');
      const texts = provider.requests[1].messages.filter((message) => message.role === 'tool').map((message) => message.content);
      assert.equal(texts.length, 4);
      assert.ok(texts.reduce((total, text) => total + text.length, 0) <= 24000, `${texts.map((text) => text.length)}`);
      const fourth = JSON.parse(texts[3]);
      assert.ok(fourth.rows.length < medium.rows.length && fourth.cut.startsWith(`only ${fourth.rows.length} of 130 rows`));

      // High: larger results - all 130 rows
      calls = 1;
      await useProvider(provider, { effort: 'high' });
      provider.requests.length = 0;
      await askAi('kira', 'Wer hat gespendet?');
      const [high] = toolResults(provider.requests[1]);
      assert.equal(high.rows.length, 130);
      assert.ok(!('cut' in high));
    } finally {
      provider.close();
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  });

  test('AI lookups: categories come from the descriptions (and the issuer), and the result names every description counted', async () => {
    await addToList('expenses', [
      { id: 1798000000001, amount: 25, description: 'Blumen Erntedank', issuer: 'Theo', date: '2019-10-01' },
      { id: 1798000000002, amount: 40, description: 'Blumenschmuck Ostern', issuer: 'Theo', date: '2020-04-01' },
      { id: 1798000000003, amount: 18, description: 'Deko', issuer: 'Blumen Müller', date: '2020-05-01' },
      { id: 1798000000004, amount: 300, description: 'Saalmiete Januar', issuer: 'Theo', date: '2020-01-10' },
      { id: 1798000000005, amount: 300, description: 'Raummiete Februar', issuer: 'Theo', date: '2020-02-10' },
      { id: 1798000000006, amount: 120, description: 'Beamer Reparatur', issuer: 'Theo', date: '2020-03-01' },
      { id: 1798000000007, amount: 15, description: 'Kaffee', issuer: 'Theo', date: '2020-03-02' }
    ]);
    const categories = [{ name: 'Blumen', words: ['blume'] }, { name: 'Miete', words: ['miete'] }, { name: 'Technik', words: ['beamer', 'mikrofon'] }];
    const provider = await standInProvider((body) => {
      const [result] = toolResults(body);
      if (!result) return toolCall(0, 'money', { kind: 'expenses', from: '2019', to: '2020', categories, groupBy: ['category', 'year'] });
      return [{ content: result.categories.map((category) => `${category.name}: ${category.eur} EUR (gezählt: ${category.descriptions.join(', ')})`).join('\n') }];
    });
    try {
      await useProvider(provider, { effort: 'medium' });
      const events = await askAi('kira', 'Was haben wir für Blumen, Miete und Technik ausgegeben?');
      const [result] = toolResults(provider.requests[1]);
      assert.deepEqual(result.categories, [
        { name: 'Blumen', entries: 3, eur: 83, descriptions: ['Blumenschmuck Ostern (1×, 40)', 'Blumen Erntedank (1×, 25)', 'Deko · Blumen Müller (1×, 18)'] },
        { name: 'Miete', entries: 2, eur: 600, descriptions: ['Raummiete Februar (1×, 300)', 'Saalmiete Januar (1×, 300)'] },
        { name: 'Technik', entries: 1, eur: 120, descriptions: ['Beamer Reparatur (1×, 120)'] },
        { name: 'other', entries: 1, eur: 15, descriptions: ['Kaffee (1×, 15)'] }
      ]);
      assert.deepEqual(result.columns, ['category', 'year', 'eur', 'entries']);
      assert.deepEqual(result.rows, [['Miete', '2020', 600, 2], ['Technik', '2020', 120, 1], ['Blumen', '2019', 25, 1], ['Blumen', '2020', 58, 2], ['other', '2020', 15, 1]]);
      // The answer names what it counted (the prompt asks for it, the result has it)
      assert.match(systemOf(provider.requests[0]), /always say which descriptions you counted/);
      const answer = textOf(events);
      for (const description of ['Blumen Erntedank', 'Blumenschmuck Ostern', 'Deko · Blumen Müller', 'Saalmiete Januar', 'Raummiete Februar', 'Beamer Reparatur']) assert.ok(answer.includes(description), description);
    } finally {
      provider.close();
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  });

  test('AI lookups: members, events, totals and the change log read what API v2 reads', async () => {
    await ok(call('owner', 'POST', '/api/events', { title: 'KI-Jugendabend', date: '2027-01-08', startTime: '19:00', isRecurring: true, recurringRule: 'weekly', recurringCount: 3 }));
    const provider = await standInProvider((body) => {
      if (toolResults(body).length) return [{ content: 'Fertig.' }];
      return [
        ...toolCall(0, 'members', { names: ['Mia'], from: '2025', sort: 'gap' }),
        ...toolCall(1, 'events', { title: ['KI-Jugendabend'], groupBy: ['title'] }),
        ...toolCall(2, 'money_totals', { per: 'year' }),
        ...toolCall(3, 'finance_changes', { area: 'donation', groupBy: ['by'] })
      ];
    });
    try {
      await useProvider(provider, { effort: 'high' });
      const events = await askAi('kira', 'Überblick bitte');
      assert.deepEqual(lookupsIn(events), [
        { id: 1, tool: 'members', from: '2025', about: 'Mia' },
        { id: 2, tool: 'events', about: 'KI-Jugendabend' },
        { id: 3, tool: 'money_totals' },
        { id: 4, tool: 'finance_changes' }
      ]);
      // What each found, for the chat
      const found = events.filter((event) => event.lookupDone).map((event) => event.lookupDone);
      assert.deepEqual(found.slice(0, 2), [{ id: 1, count: 1, unit: 'members' }, { id: 2, count: 3, unit: 'events' }]);
      assert.deepEqual(found.slice(2).map((entry) => [entry.id, entry.unit]), [[3, 'periods'], [4, 'changes']]);
      const [members, recurring, totals, changes] = toolResults(provider.requests[1]);
      // Mia as API v2 has her
      const mia = (await ok(call('treasurer', 'GET', '/api/v2/members?limit=500'))).items.find((member) => member.name === 'Mia Test');
      const row = Object.fromEntries(members.columns.map((column, index) => [column, members.rows[0][index]]));
      assert.equal(members.rows.length, 1);
      assert.equal(row.name, 'Mia Test');
      assert.equal(row.status, mia.status);
      assert.equal(row.balanceEur, mia.balanceCents / 100);
      assert.equal(row.overdueEur, mia.overdueCents / 100);
      assert.equal(typeof row.longestGapMonths, 'number');
      // The recurring event: three dates under one title
      assert.deepEqual(recurring.rows.map((entry) => entry.slice(0, 3)), [['KI-Jugendabend', 3, 0]]);
      assert.deepEqual(recurring.rows[0].slice(7, 9), ['2027-01-08', '2027-01-22']);
      // The cash balance at the end of the newest year is everything API v2 sums up
      const summary = await ok(call('treasurer', 'GET', '/api/v2/finance/summary'));
      const balance = (summary.totalsCents.memberPayments + summary.totalsCents.donations - summary.totalsCents.expenses) / 100;
      assert.equal(totals.columns[5], 'cashBalanceAtEndEur');
      assert.equal(totals.rows[0][5], balance);
      // The change log: the donations the treasurer changed
      assert.deepEqual(changes.columns, ['by', 'changes']);
      assert.ok(changes.rows.some(([by, count]) => by === 'Theo Test' && count > 0));
    } finally {
      provider.close();
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  });

  test('AI lookups: a provider without tool calls gets the question again without them, remembered until the settings are saved', async () => {
    // A second account: the chat takes 20 questions a minute from one address
    await aiAccount('kora', 'Kora', true);
    let refuse = 'tools';
    const provider = await standInProvider((body) => {
      if (refuse === 'tools' && body.tools) return { status: 400, message: 'registry.ollama.ai/library/gemma:2b does not support tools' };
      if (refuse === 'reasoning' && body.reasoning_effort) return { status: 400, message: 'Unrecognized request argument supplied: reasoning_effort' };
      if (refuse === 'length') return { status: 400, message: 'This model\'s maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens (129000 in the messages, 1000 in the functions).' };
      if (refuse === 'toolChoice') {
        if (body.tool_choice === 'none') return { status: 400, message: 'tool_choice "none" is not supported' };
        if (body.tools) return toolCall(0, 'money_totals', { per: 'year' });
        return [{ content: 'Antwort aus den Ergebnissen.' }];
      }
      return [{ content: 'Antwort.' }];
    });
    try {
      await useProvider(provider, { effort: 'medium' });
      assert.deepEqual(await askAi('kora', 'Hallo?'), [{ content: 'Antwort.' }, '[DONE]']);
      assert.equal(provider.requests.length, 2);
      assert.ok(provider.requests[0].tools && !provider.requests[1].tools);
      // Without lookups the prompt says nothing about them
      assert.ok(!systemOf(provider.requests[1]).includes('Lookups:'));
      // Remembered: the next question goes without tools right away
      await askAi('kora', 'Hallo?');
      assert.equal(provider.requests.length, 3);
      assert.ok(!provider.requests[2].tools);
      // ... and not shown in the settings
      assert.deepEqual(Object.keys(await ok(call('owner', 'GET', '/api/admin/ai-config'))).sort(), ['apiKey', 'baseUrl', 'effort', 'enabled', 'model', 'provider']);
      // Saving the settings tries again
      await useProvider(provider);
      await askAi('kora', 'Hallo?');
      assert.equal(provider.requests.length, 5);
      assert.ok(provider.requests[3].tools && !provider.requests[4].tools);

      // A model without reasoning_effort: asked again without it (the lookups stay), and remembered
      refuse = 'reasoning';
      await useProvider(provider, { effort: 'high' });
      provider.requests.length = 0;
      assert.deepEqual(await askAi('kora', 'Hallo?'), [{ content: 'Antwort.' }, '[DONE]']);
      assert.deepEqual(provider.requests.map((body) => [body.reasoning_effort ?? null, Boolean(body.tools)]), [['high', true], [null, true]]);
      await askAi('kora', 'Hallo?');
      assert.deepEqual(provider.requests.slice(2).map((body) => [body.reasoning_effort ?? null, Boolean(body.tools)]), [[null, true]]);

      // A question that is too long is no refusal of the tools: the error is shown, nothing is remembered
      refuse = 'length';
      await useProvider(provider, { effort: 'medium' });
      provider.requests.length = 0;
      assert.deepEqual(await askAi('kora', 'Hallo?'), [{ error: 'This model\'s maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens (129000 in the messages, 1000 in the functions).' }]);
      assert.equal(provider.requests.length, 1);
      refuse = null;
      await askAi('kora', 'Hallo?');
      assert.ok(provider.requests[1].tools, 'the lookups are still offered');

      // A provider that takes tool calls but refuses what follows them (here tool_choice "none" once the lookups are
      // used up): the results go to it once more as text, without tools
      refuse = 'toolChoice';
      provider.requests.length = 0;
      const answered = await askAi('kora', 'Wie steht die Kasse?');
      assert.equal(lookupsIn(answered).length, 4);
      assert.deepEqual(answered.slice(-2), [{ content: 'Antwort aus den Ergebnissen.' }, '[DONE]']);
      assert.equal(provider.requests.length, 6);
      assert.ok(!('tools' in provider.requests[5]) && questionOf(provider.requests[5]).includes('Lookups already made for this question'));
      assert.ok(provider.requests[0].tools, 'not taken for a provider without tools: nothing remembered');
      provider.requests.length = 0;
      await askAi('kora', 'Hallo?');
      assert.ok(provider.requests[0].tools);
    } finally {
      provider.close();
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  });

  // --- AI services: Anthropic, Google and OpenAI through their own interfaces (backend/aiProviders) ------------------

  // What Anthropic's Messages API streams for [blocks] (thinking, text, tool_use), ending with [stopReason]
  function anthropicAnswer(res, blocks, stopReason) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    blocks.forEach((block, index) => {
      if (block.type === 'thinking') {
        send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: block.thinking } });
        send('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } });
      } else if (block.type === 'text') {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
      } else {
        send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
        const json = JSON.stringify(block.input);
        send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 12) } });
        send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(12) } });
      }
      send('content_block_stop', { index });
    });
    send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
    send('message_stop', {});
    res.end();
  }
  const anthropicError = (res, message) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }));
  };
  // What OpenAI's Responses API streams: a reasoning summary, text and function calls
  function responsesAnswer(res, { reasoning, text, calls = [] }) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const output = [];
    if (reasoning) {
      send('response.reasoning_summary_part.added', { item_id: 'rs_1', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } });
      send('response.reasoning_summary_text.delta', { item_id: 'rs_1', output_index: 0, summary_index: 0, delta: reasoning });
      output.push({ id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }], encrypted_content: 'enc-1' });
    }
    if (text) {
      send('response.output_text.delta', { item_id: 'msg_1', output_index: output.length, content_index: 0, delta: text });
      output.push({ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
    }
    for (const call of calls) output.push({ id: `fc_${call.id}`, type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) });
    send('response.completed', { response: { id: 'resp_1', status: 'completed', output } });
    res.end();
  }
  const jsonError = (res, status, message) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message } }));
  };
  // What the Gemini API streams: one chunk per list of parts
  function geminiAnswer(res, chunks) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const parts of chunks) res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, index: 0 }] })}\r\n\r\n`);
    res.end();
  }
  const usePreset = (provider, extra = {}) => ok(call('owner', 'PUT', '/api/admin/ai-config', { enabled: true, provider, apiKey: `${provider}-key`, model: '', ...extra }));
  const MONEY_STEP = 'Suche die Kosten des Lichterfests';

  test('AI services: chosen in the settings - the big three at their own address, and a new address needs the key again', async () => {
    const provider = await standInProvider(() => [{ content: 'OK' }]);
    try {
      await useProvider(provider, { effort: 'medium' });
      assert.equal((await ok(call('owner', 'GET', '/api/admin/ai-config'))).provider, 'custom');
      // Another service is another address: its key, please
      const keyAgain = await call('owner', 'PUT', '/api/admin/ai-config', { provider: 'anthropic' });
      assert.equal(keyAgain.status, 400);
      assert.match(keyAgain.body.error, /API key again/);
      assert.equal((await call('owner', 'PUT', '/api/admin/ai-config', { provider: 'mistral', apiKey: 'x' })).status, 400);
      for (const name of ['anthropic', 'gemini', 'openai']) {
        // Saving answers with what was stored: the settings page checks the chosen service against it (a server of an
        // earlier version - the previous backend while the database upgrade waits - answers without one)
        assert.deepEqual(await usePreset(name), { success: true, enabled: true, provider: name, baseUrl: provider.baseUrl, apiKey: '***', model: '', effort: 'medium' });
        const settings = await ok(call('owner', 'GET', '/api/admin/ai-config'));
        // The address entered for the OpenAI-compatible service stays for when it is chosen again
        assert.deepEqual(settings, { enabled: true, provider: name, baseUrl: provider.baseUrl, apiKey: '***', model: '', effort: 'medium' });
      }
      // The same service again keeps its key
      await ok(call('owner', 'PUT', '/api/admin/ai-config', { provider: 'openai', model: 'gpt-5' }));
      await useProvider(provider);
      assert.equal((await ok(call('owner', 'GET', '/api/admin/ai-config'))).provider, 'custom');
    } finally {
      provider.close();
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  });

  test('AI services: Claude through Anthropic\'s own interface - its thinking, effort up to max, caching and fallbacks; its turn goes back unchanged', async () => {
    await aiAccount('klara', 'Klara', true);
    await addToList('expenses', [
      { id: 1799000000001, amount: 30, description: 'Lichterfest Blumen', issuer: 'Theo', date: '2015-12-20' },
      { id: 1799000000002, amount: 12.5, description: 'Lichterfest Kerzen', issuer: 'Theo', date: '2015-12-22' }
    ]);
    const call1 = { step: MONEY_STEP, kind: 'expenses', search: ['lichterfest'] };
    hubRequests.length = 0;
    hubAnswer = ({ body }, res) => {
      if (!body.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result'))) {
        return anthropicAnswer(res, [
          { type: 'thinking', thinking: '**Lese die Frage**\n\nDie Zusammenfassung reicht nicht.', signature: 'sig-1' },
          { type: 'text', text: 'Ich schaue nach.' },
          { type: 'tool_use', id: 'toolu_1', name: 'money', input: call1 }
        ], 'tool_use');
      }
      return anthropicAnswer(res, [{ type: 'thinking', thinking: 'Zwei Einträge.', signature: 'sig-2' }, { type: 'text', text: 'Zusammen 42,50 €.' }], 'end_turn');
    };
    try {
      await usePreset('anthropic', { effort: 'max' });
      const events = await askAi('klara', 'Was hat das Lichterfest gekostet?');
      assert.deepEqual(events, [
        { reasoning: '**Lese die Frage**\n\nDie Zusammenfassung reicht nicht.' },
        { content: 'Ich schaue nach.' },
        { lookup: { id: 1, tool: 'expenses', step: MONEY_STEP, about: 'lichterfest' } },
        { lookupDone: { id: 1, count: 2, unit: 'entries', eur: 42.5 } },
        { reasoning: '\n\n' }, { reasoning: 'Zwei Einträge.' },
        { content: '\n\n' }, { content: 'Zusammen 42,50 €.' },
        '[DONE]'
      ]);
      assert.equal(hubRequests.length, 2);
      const [first, second] = hubRequests;
      assert.equal(first.path, '/anthropic/v1/messages');
      // Anthropic's SDK sends the key and its API version
      assert.equal(first.headers.authorization, 'Bearer anthropic-key');
      assert.ok(first.headers['anthropic-version']);
      // Claude Opus 5.5 (no model entered): a declined question goes to Anthropic's fallback
      assert.match(first.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
      assert.equal(first.body.fallbacks, 'default');
      assert.equal(first.body.model, 'claude-opus-5-5');
      assert.equal(first.body.stream, true);
      assert.deepEqual(first.body.thinking, { type: 'adaptive', display: 'summarized' });
      assert.deepEqual(first.body.output_config, { effort: 'max' });
      assert.deepEqual(first.body.cache_control, { type: 'ephemeral' });
      assert.match(first.body.system, /Lookups: the context below is a summary/);
      assert.deepEqual(first.body.messages, [{ role: 'user', content: 'Was hat das Lichterfest gekostet?' }]);
      assert.deepEqual(first.body.tools.map((tool) => tool.name).sort(), ALL_LOOKUPS);
      assert.ok(first.body.tools.every((tool) => tool.input_schema.type === 'object' && tool.eager_input_streaming === true));
      assert.deepEqual(first.body.tool_choice, { type: 'auto' });
      // The second turn: Claude's turn as it came (its thinking with the signature), then the result
      const [, assistant, results] = second.body.messages;
      assert.equal(assistant.role, 'assistant');
      assert.deepEqual(assistant.content.map((block) => block.type), ['thinking', 'text', 'tool_use']);
      assert.equal(assistant.content[0].signature, 'sig-1');
      assert.equal(assistant.content[0].thinking, '**Lese die Frage**\n\nDie Zusammenfassung reicht nicht.');
      assert.deepEqual([assistant.content[2].id, assistant.content[2].input], ['toolu_1', call1]);
      assert.equal(results.role, 'user');
      assert.equal(results.content[0].type, 'tool_result');
      assert.equal(results.content[0].tool_use_id, 'toolu_1');
      assert.deepEqual(JSON.parse(results.content[0].content).total, { entries: 2, eur: 42.5 });

      // A model without "max" or "xhigh" gets the next level down (not remembered: the next model may have it); one
      // without fallbacks gets none
      hubRequests.length = 0;
      hubAnswer = ({ body }, res) => (['max', 'xhigh'].includes(body.output_config?.effort)
        ? anthropicError(res, `output_config.effort: "${body.output_config.effort}" is not supported by this model`)
        : anthropicAnswer(res, [{ type: 'text', text: 'Antwort.' }], 'end_turn'));
      await usePreset('anthropic', { model: 'claude-opus-4-6', effort: 'max' });
      assert.deepEqual(await askAi('klara', 'Hallo?'), [{ content: 'Antwort.' }, '[DONE]']);
      assert.deepEqual(hubRequests.map((request) => request.body.output_config.effort), ['max', 'xhigh', 'high']);
      assert.ok(hubRequests.every((request) => request.body.fallbacks === undefined && !request.headers['anthropic-beta']));

      // A model that takes neither effort nor adaptive thinking: both left out, and remembered
      hubRequests.length = 0;
      hubAnswer = ({ body }, res) => {
        if (body.output_config) return anthropicError(res, 'output_config.effort: Extra inputs are not permitted');
        if (body.thinking) return anthropicError(res, 'thinking.type: adaptive thinking is not supported on this model');
        return anthropicAnswer(res, [{ type: 'text', text: 'Antwort.' }], 'end_turn');
      };
      await usePreset('anthropic', { model: 'claude-haiku-4-5', effort: 'medium' });
      assert.deepEqual(await askAi('klara', 'Hallo?'), [{ content: 'Antwort.' }, '[DONE]']);
      assert.equal(hubRequests.length, 3);
      await askAi('klara', 'Hallo?');
      assert.equal(hubRequests.length, 4);
      assert.ok(!('output_config' in hubRequests[3].body) && !('thinking' in hubRequests[3].body));

      // Declined, also by the fallback: an error, not the partial text
      hubAnswer = (request, res) => anthropicAnswer(res, [{ type: 'text', text: 'Teil' }], 'refusal');
      await usePreset('anthropic', { effort: 'medium' });
      const declined = await askAi('klara', 'Hallo?');
      assert.deepEqual(declined[declined.length - 1], { error: 'The AI declined to answer this question.' });
    } finally {
      hubAnswer = null;
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  });

  test('AI services: ChatGPT through OpenAI\'s own interface - reasoning summaries and effort, the encrypted reasoning goes back', async () => {
    await aiAccount('konrad', 'Konrad', true);
    const call1 = { step: MONEY_STEP, kind: 'expenses', search: ['lichterfest'] };
    hubRequests.length = 0;
    hubAnswer = ({ body }, res) => (body.input.some((item) => item.type === 'function_call_output')
      ? responsesAnswer(res, { text: 'Zusammen 42,50 €.' })
      : responsesAnswer(res, { reasoning: '**Prüfe die Ausgaben**', calls: [{ id: 'call_a', name: 'money', args: call1 }] }));
    try {
      await usePreset('openai', { effort: 'xhigh' });
      const events = await askAi('konrad', 'Was hat das Lichterfest gekostet?');
      assert.deepEqual(events, [
        { reasoning: '**Prüfe die Ausgaben**' },
        { lookup: { id: 1, tool: 'expenses', step: MONEY_STEP, about: 'lichterfest' } },
        { lookupDone: { id: 1, count: 2, unit: 'entries', eur: 42.5 } },
        { content: 'Zusammen 42,50 €.' },
        '[DONE]'
      ]);
      const [first, second] = hubRequests;
      assert.equal(first.path, '/openai/v1/responses');
      assert.equal(first.headers.authorization, 'Bearer openai-key');
      assert.equal(first.body.model, 'gpt-5-mini');
      assert.match(first.body.instructions, /Lookups: the context below is a summary/);
      assert.deepEqual(first.body.input, [{ role: 'user', content: 'Was hat das Lichterfest gekostet?' }]);
      assert.deepEqual(first.body.reasoning, { effort: 'xhigh', summary: 'auto' });
      assert.deepEqual(first.body.include, ['reasoning.encrypted_content']);
      assert.equal(first.body.store, false);
      assert.equal(first.body.tool_choice, 'auto');
      assert.ok(first.body.tools.every((tool) => tool.type === 'function' && tool.name && tool.parameters.type === 'object'));
      // The reasoning (encrypted) and the call go back as they came, then the result
      const [, reasoning, functionCall, output] = second.body.input;
      assert.deepEqual([reasoning.type, reasoning.encrypted_content], ['reasoning', 'enc-1']);
      assert.deepEqual([functionCall.type, functionCall.call_id, functionCall.name], ['function_call', 'call_a', 'money']);
      assert.deepEqual([output.type, output.call_id], ['function_call_output', 'call_a']);
      assert.deepEqual(JSON.parse(output.output).total, { entries: 2, eur: 42.5 });

      // A model without "xhigh": one level lower, not remembered
      hubRequests.length = 0;
      hubAnswer = ({ body }, res) => (body.reasoning?.effort === 'xhigh'
        ? jsonError(res, 400, 'Unsupported value: \'reasoning.effort\' does not support \'xhigh\' with this model. Supported values are: \'low\', \'medium\', and \'high\'.')
        : responsesAnswer(res, { text: 'Antwort.' }));
      assert.deepEqual(await askAi('konrad', 'Hallo?'), [{ content: 'Antwort.' }, '[DONE]']);
      assert.deepEqual(hubRequests.map((request) => request.body.reasoning.effort), ['xhigh', 'high']);

      // A model without reasoning: the reasoning parts are left out, and remembered
      hubRequests.length = 0;
      hubAnswer = ({ body }, res) => (body.reasoning || body.include
        ? jsonError(res, 400, 'Unsupported parameter: \'reasoning.effort\' is not supported with this model.')
        : responsesAnswer(res, { text: 'Antwort.' }));
      await usePreset('openai', { model: 'gpt-4.1', effort: 'medium' });
      assert.deepEqual(await askAi('konrad', 'Hallo?'), [{ content: 'Antwort.' }, '[DONE]']);
      await askAi('konrad', 'Hallo?');
      assert.equal(hubRequests.length, 3);
      assert.ok(!('reasoning' in hubRequests[2].body) && !('include' in hubRequests[2].body));
    } finally {
      hubAnswer = null;
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  });

  test('AI services: Gemini through Google\'s own interface - its thoughts, and its turn with the thought signature goes back', async () => {
    await aiAccount('kuno', 'Kuno', true);
    const call1 = { step: MONEY_STEP, kind: 'expenses', search: ['lichterfest'] };
    const signed = { functionCall: { name: 'money', args: call1 }, thoughtSignature: 'gsig-1' };
    hubRequests.length = 0;
    hubAnswer = ({ body }, res) => (body.contents.some((content) => content.parts.some((part) => part.functionResponse))
      ? geminiAnswer(res, [[{ text: 'Zusammen ' }], [{ text: '42,50 €.' }]])
      : geminiAnswer(res, [[{ text: '**Denke über die Kosten nach**', thought: true }], [signed]]));
    try {
      await usePreset('gemini', { effort: 'high' });
      const events = await askAi('kuno', 'Was hat das Lichterfest gekostet?');
      assert.deepEqual(events, [
        { reasoning: '**Denke über die Kosten nach**' },
        { lookup: { id: 1, tool: 'expenses', step: MONEY_STEP, about: 'lichterfest' } },
        { lookupDone: { id: 1, count: 2, unit: 'entries', eur: 42.5 } },
        { content: 'Zusammen ' }, { content: '42,50 €.' },
        '[DONE]'
      ]);
      const [first, second] = hubRequests;
      assert.equal(first.path, '/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
      assert.equal(first.headers['x-goog-api-key'], 'gemini-key');
      assert.match(first.body.systemInstruction.parts[0].text, /Lookups: the context below is a summary/);
      assert.deepEqual(first.body.contents, [{ role: 'user', parts: [{ text: 'Was hat das Lichterfest gekostet?' }] }]);
      assert.deepEqual(first.body.tools[0].functionDeclarations.map((tool) => tool.name).sort(), ALL_LOOKUPS);
      assert.deepEqual(first.body.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
      assert.deepEqual(first.body.generationConfig, { thinkingConfig: { includeThoughts: true } });
      // Gemini's turn as it came (the thought signature included), then the result as a function response
      const [, model, results] = second.body.contents;
      assert.deepEqual(model, { role: 'model', parts: [{ text: '**Denke über die Kosten nach**', thought: true }, signed] });
      assert.equal(results.role, 'user');
      assert.equal(results.parts[0].functionResponse.name, 'money');
      assert.deepEqual(results.parts[0].functionResponse.response.total, { entries: 2, eur: 42.5 });

      // A model that does not think: its thoughts are not asked for again
      hubRequests.length = 0;
      hubAnswer = ({ body }, res) => (body.generationConfig
        ? jsonError(res, 400, 'Thinking is not supported for this model.')
        : geminiAnswer(res, [[{ text: 'Antwort.' }]]));
      await usePreset('gemini', { model: 'gemini-2.0-flash' });
      assert.deepEqual(await askAi('kuno', 'Hallo?'), [{ content: 'Antwort.' }, '[DONE]']);
      await askAi('kuno', 'Hallo?');
      assert.equal(hubRequests.length, 3);
      assert.ok(!('generationConfig' in hubRequests[2].body));
    } finally {
      hubAnswer = null;
      await call('owner', 'PUT', '/api/admin/ai-config', { enabled: false });
    }
  });
});
