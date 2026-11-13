// A whole instance for the tests: PocketBase on a data folder, a backend (the current one or the frozen one in
// backend/legacy) on top of it, an HTTP client that signs in as several people, and the superuser's direct access to
// PocketBase (to write data the way older versions left it).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { REPO_ROOT, BACKEND_DIR, freePort, waitFor, start, stop } = require('./helpers');

const POCKETBASE_BIN = process.env.POCKETBASE_BIN || '';
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

/** Starts [entry] (a server.js) on the instance; waits until it is ready (or set up for the first time). */
async function startBackend(root, pbPort, { entry = CURRENT_SERVER, port, env = {}, waitReady = true, label = 'backend' } = {}) {
  const httpPort = port || await freePort();
  const backend = start(label, process.execPath, [entry], {
    PORT: String(httpPort),
    POCKETBASE_PORT: String(pbPort),
    POCKETBASE_BIN,
    POCKETBASE_DIR: path.join(root, 'pb'),
    DATA_DIR: path.join(root, 'data'),
    FRONTEND_DIR: REPO_ROOT,
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
 * An HTTP client: call(who, method, url, body) as the person signed in under [who] (null: nobody). Every call comes
 * from its own address, so the rate limits of the server never get in the way of a big seed.
 */
function httpClient(base) {
  const tokens = {};
  const uids = {};
  let counter = 0;
  async function call(who, method, url, body, { form = false, raw = false } = {}) {
    counter += 1;
    const headers = { 'X-Forwarded-For': `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter & 255}` };
    if (who && tokens[who]) headers.Authorization = `Bearer ${tokens[who]}`;
    if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
    const res = await fetch(client.base + url, { method, headers, body: form ? body : body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (raw) return { status: res.status, text, headers: res.headers };
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* text answer */ }
    return { status: res.status, body: parsed, headers: res.headers };
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
  const client = { base, call, ok, login, tokens, uids };
  return client;
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

module.exports = {
  POCKETBASE_BIN,
  PASSWORD,
  LEGACY_SERVER,
  CURRENT_SERVER,
  makeRoot,
  startPocketBase,
  startBackend,
  waitUntilReady,
  httpClient,
  superuser,
  stop
};
