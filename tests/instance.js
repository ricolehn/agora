// A whole instance for the tests: PocketBase on a data folder, a backend (the current one or the frozen one in
// backend/legacy) on top of it, an HTTP client that signs in as several people, and the superuser's direct access to
// PocketBase (to write data the way older versions left it).
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { REPO_ROOT, BACKEND_DIR, freePort, waitFor, start, stop, FRONTEND_FIXTURE } = require('./helpers');

const POCKETBASE_BIN = process.env.POCKETBASE_BIN || '';
// Without the binary the HTTP tests are skipped; in CI (REQUIRE_POCKETBASE=1) a missing one is a failure instead
const hasPocketBase = POCKETBASE_BIN !== '' && fs.existsSync(POCKETBASE_BIN);
if (!hasPocketBase && process.env.REQUIRE_POCKETBASE === '1') {
  throw new Error(`REQUIRE_POCKETBASE=1 but no PocketBase binary at POCKETBASE_BIN="${POCKETBASE_BIN}"`);
}
const PASSWORD = 'test-Passwort-1';
const LEGACY_SERVER = path.join(BACKEND_DIR, 'legacy', 'server.js');
const CURRENT_SERVER = path.join(BACKEND_DIR, 'server.js');

/** A fresh data root: <root>/pb (PocketBase), <root>/data (configuration, uploads). */
function makeRoot(prefix = 'agora-instance-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startPocketBase(root, port) {
  const pbPort = port || await freePort();
  const pocketbase = start('pocketbase', POCKETBASE_BIN, ['serve', '--dir', path.join(root, 'pb'), '--automigrate=false', '--http', `127.0.0.1:${pbPort}`], {});
  await waitFor(`http://127.0.0.1:${pbPort}/api/health`, 'PocketBase', [pocketbase], 100);
  return { process: pocketbase, port: pbPort };
}

/**
 * Starts [entry] (a server.js) on the instance, with [nodeArgs] for node itself (e.g. a clock: tests/clock.js); waits
 * until it is ready (or set up for the first time).
 */
async function startBackend(root, pbPort, { entry = CURRENT_SERVER, port, env = {}, nodeArgs = [], waitReady = true, label = 'backend' } = {}) {
  const httpPort = port || await freePort();
  const backend = start(label, process.execPath, [...nodeArgs, entry], {
    PORT: String(httpPort),
    POCKETBASE_PORT: String(pbPort),
    POCKETBASE_BIN,
    POCKETBASE_DIR: path.join(root, 'pb'),
    DATA_DIR: path.join(root, 'data'),
    FRONTEND_DIR: FRONTEND_FIXTURE,
    AGORA_FEATURE_POLLS: '1',
    ...env
  });
  const base = `http://127.0.0.1:${httpPort}`;
  await waitFor(`${base}/api/status`, label, [backend], 100);
  if (waitReady && fs.existsSync(path.join(root, 'data', 'config.json'))) await waitUntilReady(base, backend);
  return { process: backend, base, port: httpPort };
}

async function waitUntilReady(base, backend, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await fetch(`${base}/api/status`).then((res) => res.json()).catch(() => null);
    if (status?.ready === true) return status;
    if (backend?.exitCode !== null && backend?.exitCode !== undefined) throw new Error(`the backend exited (${backend.exitCode})\n${backend.log.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the backend did not get ready\n${backend?.log?.join('') || ''}`);
}

/**
 * An HTTP client: call(who, method, url, body, { form, lang }) as the person signed in under [who] (null: nobody), in
 * the language [lang] (Accept-Language) if given; answers { status, body (JSON, else text), headers, buffer }. Every call
 * comes from its own address, so the rate limits of the server never get in the way of a big seed. [base] may be set
 * later (client.base), once the server runs.
 */
function httpClient(base = '') {
  const tokens = {};
  const uids = {};
  let counter = 0;
  async function call(who, method, url, body, { form = false, lang = null } = {}) {
    counter += 1;
    const headers = { 'X-Forwarded-For': `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter & 255}` };
    if (who && tokens[who]) headers.Authorization = `Bearer ${tokens[who]}`;
    if (lang) headers['Accept-Language'] = lang;
    if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
    const res = await fetch(client.base + url, { method, headers, body: form ? body : body === undefined ? undefined : JSON.stringify(body) });
    const buffer = Buffer.from(await res.arrayBuffer());
    let parsed = buffer.toString('utf8');
    try { parsed = JSON.parse(parsed); } catch { /* a text or a file */ }
    return { status: res.status, body: parsed, headers: res.headers, buffer };
  }
  async function ok(promise) {
    const res = await promise;
    if (res.status >= 300) throw new Error(`expected success, got ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
    return res.body;
  }
  async function login(who, email, password = PASSWORD) {
    tokens[who] = (await ok(call(null, 'POST', '/api/auth/login', { email, password }))).token;
    uids[who] = (await ok(call(who, 'GET', '/api/auth/me'))).user.uid;
    return uids[who];
  }
  /** A new paying member with an account (<who>@test.local), made by the owner and signed in; returns its uid. */
  async function account(who, firstName, extra = {}) {
    await ok(call('owner', 'POST', '/api/admin/users', {
      firstName, lastName: 'Test', email: `${who}@test.local`, password: PASSWORD, pays: true, admin: false, status: 'vollverdiener', memberSince: '2025-01-01', ...extra
    }));
    return login(who, `${who}@test.local`);
  }
  const client = { base, call, ok, login, account, tokens, uids };
  return client;
}

/** "Testgemeinde" set up by Olga Owner (her account with [owner] added, e.g. memberSince), signed in as 'owner'. */
async function setUpOwner(http, owner = {}) {
  const setup = await http.ok(http.call(null, 'POST', '/api/setup', {
    appName: 'Testgemeinde', adminUser: { firstName: 'Olga', lastName: 'Owner', email: 'owner@test.local', password: PASSWORD, ...owner }
  }));
  http.tokens.owner = setup.token;
  http.uids.owner = setup.user.id || setup.user.uid;
  return http.uids.owner;
}

/** The treasurer Theo ('treasurer', [extra] for the account), in the group "Kasse" with manage_finances. */
async function addTreasurer(http, extra = {}) {
  const group = await http.ok(http.call('owner', 'POST', '/api/admin/groups', { name: 'Kasse', permissions: ['manage_finances'] }));
  const uid = await http.account('treasurer', 'Theo', extra);
  await http.ok(http.call('owner', 'PUT', `/api/admin/users/${uid}/groups`, { groups: [group.id || group.group?.id] }));
  return uid;
}

/** The community most HTTP tests start from: the owner, the treasurer and the members Max and Mia, signed in on [http]. */
async function setUpCommunity(http) {
  await setUpOwner(http);
  await addTreasurer(http);
  await http.account('max', 'Max');
  await http.account('mia', 'Mia');
}

/**
 * A fresh instance for a suite of HTTP tests: PocketBase and the backend (with [env]) on their own data folder under
 * the temp directory ([prefix]). close() stops both and removes the folder.
 */
async function startInstance(prefix, env = {}) {
  const root = makeRoot(prefix);
  const pocketbase = await startPocketBase(root);
  const backend = await startBackend(root, pocketbase.port, { env });
  async function close() {
    await stop(backend.process);
    await stop(pocketbase.process);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return { root, base: backend.base, pocketbaseUrl: `http://127.0.0.1:${pocketbase.port}`, pocketbase, backend, close };
}

/** The superuser's own access to PocketBase (credentials from the instance's config.json). */
async function superuser(root, pbPort) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'data', 'config.json'), 'utf8'));
  const base = `http://127.0.0.1:${pbPort}`;
  let token = '';
  const signIn = async () => {
    token = (await (await fetch(`${base}/api/collections/_superusers/auth-with-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: config.pocketbase.adminEmail, password: config.pocketbase.adminPassword })
    })).json()).token;
  };
  await signIn();
  async function request(method, url, body, retried = false) {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: token }, body: body === undefined ? undefined : JSON.stringify(body) });
    // Every start of a backend renews the superuser (its old tokens end): sign in again once
    if ((res.status === 401 || res.status === 403) && !retried) {
      await signIn();
      return request(method, url, body, true);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`PocketBase ${method} ${url}: ${res.status} ${text.slice(0, 400)}`);
    return data;
  }
  async function list(collection, filter = '') {
    const items = [];
    for (let page = 1; ; page += 1) {
      const params = new URLSearchParams({ page: String(page), perPage: '500', sort: '@rowid' });
      if (filter) params.set('filter', filter);
      const result = await request('GET', `/api/collections/${collection}/records?${params}`);
      items.push(...result.items);
      if (page >= result.totalPages) return items;
    }
  }
  return {
    request,
    list,
    create: (collection, body) => request('POST', `/api/collections/${collection}/records`, body),
    update: (collection, id, body) => request('PATCH', `/api/collections/${collection}/records/${id}`, body),
    remove: (collection, id) => request('DELETE', `/api/collections/${collection}/records/${id}`),
    collections: async () => (await request('GET', '/api/collections?perPage=500')).items,
    config
  };
}

/**
 * PocketBase at [port] behind a stand-in that passes every request on, but answers 503 itself (as a busy PocketBase
 * does) where [refuse](request, body text) says so. A backend uses it with POCKETBASE_PORT set to its port.
 */
function faultyProxy(port, refuse) {
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (part) => parts.push(part));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      if (refuse(req, body.toString('utf8'))) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 503, message: 'Not available (test).', data: {} }));
        return;
      }
      const upstream = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      });
      upstream.on('error', () => res.writeHead(502).end());
      upstream.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

module.exports = {
  POCKETBASE_BIN,
  hasPocketBase,
  PASSWORD,
  LEGACY_SERVER,
  CURRENT_SERVER,
  makeRoot,
  startPocketBase,
  startBackend,
  waitUntilReady,
  httpClient,
  setUpOwner,
  addTreasurer,
  setUpCommunity,
  startInstance,
  superuser,
  faultyProxy,
  stop
};
