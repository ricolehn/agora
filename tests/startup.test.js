// The server's start. A configured instance never opens the setup again - not while it starts, not after a start that
// failed, not with a configuration file it cannot read: a setup would write a new configuration over it and make
// whoever sent it the owner of the existing data. A fresh instance is set up exactly once.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPO_ROOT, BACKEND_DIR, tempDir, freePort, start, stop, waitFor, SERVER_ENTRY } = require('./helpers');

const POCKETBASE_BIN = process.env.POCKETBASE_BIN;
const config = { appName: 'Gemeinde', defaultLanguage: 'de', pocketbase: { adminEmail: 'superuser@agora.local', adminPassword: 'p'.repeat(24) } };
const setupBody = (email) => ({
  appName: 'Übernahme',
  adminUser: { firstName: 'Eve', lastName: 'Intruder', email, password: 'test-Passwort-1' }
});

/** Starts the backend on a data folder with [config] (an object, raw text, or none). Without PocketBase by default. */
async function boot(t, { configText, pocketbaseBin = '/nonexistent', pocketbasePort, pocketbaseDir } = {}) {
  const root = tempDir(t, 'agora-start-');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  if (configText !== undefined) fs.writeFileSync(path.join(dataDir, 'config.json'), configText);
  const port = await freePort();
  const server = start('backend', process.execPath, [SERVER_ENTRY], {
    PORT: String(port),
    DATA_DIR: dataDir,
    FRONTEND_DIR: REPO_ROOT,
    POCKETBASE_BIN: pocketbaseBin,
    POCKETBASE_DIR: pocketbaseDir || path.join(root, 'pb'),
    POCKETBASE_PORT: String(pocketbasePort || await freePort())
  });
  t.after(() => stop(server));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/status`, 'backend', [server]);
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const status = async () => (await fetch(`${base}/api/status`)).json();
  return { base, dataDir, configFile: path.join(dataDir, 'config.json'), post, status, server };
}

describe('starting the server', () => {
  test('a configured instance that cannot start keeps the setup closed and asks the apps to try again', async (t) => {
    const text = JSON.stringify(config);
    const { base, configFile, post, status } = await boot(t, { configText: text });

    assert.deepEqual(await status(), { setupMode: false, ready: false, updating: false, apiVersions: [1, 2] });
    assert.equal((await post('/api/setup', setupBody('eve@test.local'))).status, 403);

    // The app's page loads as always - never the setup page
    const page = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(page.status, 200);
    assert.equal((await fetch(`${base}/setup.html`, { redirect: 'manual' })).status, 200, 'the setup page itself only redirects in the browser');

    // Calls are asked to come back; signing in waits for the start and is never answered 401 (the apps keep their session)
    const events = await fetch(`${base}/api/events`);
    assert.equal(events.status, 503);
    assert.equal(events.headers.get('retry-after'), '5');
    assert.equal((await events.json()).starting, true);
    assert.equal((await post('/api/auth/login', { email: 'someone@test.local', password: 'whatever-123' })).status, 503);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Authorization: 'Bearer abc.def.ghi' } })).status, 503);

    assert.equal(fs.readFileSync(configFile, 'utf8'), text, 'the configuration is untouched');
  });

  test('a configuration file that cannot be read keeps the setup closed', async (t) => {
    for (const text of ['{"appName": "Gemeinde",', JSON.stringify({ appName: 'Gemeinde' })]) {
      const { configFile, post, status } = await boot(t, { configText: text });
      const now = await status();
      assert.equal(now.setupMode, false);
      assert.equal(now.ready, false);
      assert.equal((await post('/api/setup', setupBody('eve@test.local'))).status, 403);
      assert.equal(fs.readFileSync(configFile, 'utf8'), text);
    }
  });

  test('a first setup that fails before the owner exists is undone and can be sent again', async (t) => {
    const { configFile, post, status } = await boot(t);
    assert.equal((await status()).setupMode, true);

    // Without PocketBase the runtime cannot start: the setup fails and leaves no configuration behind
    const first = await post('/api/setup', setupBody('owner@test.local'));
    assert.equal(first.status, 400);
    assert.equal(fs.existsSync(configFile), false);
    assert.equal((await status()).setupMode, true);
    assert.equal((await post('/api/setup', setupBody('owner@test.local'))).status, 400, 'not refused as "already set up"');
  });

  test('two setups sent at the same moment: exactly one sets the instance up', { skip: !POCKETBASE_BIN && 'POCKETBASE_BIN not set' }, async (t) => {
    const root = tempDir(t, 'agora-start-pb-');
    const pocketbaseDir = path.join(root, 'pb');
    const pocketbasePort = await freePort();
    const pocketbase = start('pocketbase', POCKETBASE_BIN, ['serve', '--dir', pocketbaseDir, '--automigrate=false', '--http', `127.0.0.1:${pocketbasePort}`], {});
    t.after(() => stop(pocketbase));
    await waitFor(`http://127.0.0.1:${pocketbasePort}/api/health`, 'PocketBase', [pocketbase]);

    const { configFile, post, status } = await boot(t, { pocketbaseBin: POCKETBASE_BIN, pocketbasePort, pocketbaseDir });
    const answers = await Promise.all([post('/api/setup', setupBody('first@test.local')), post('/api/setup', setupBody('second@test.local'))]);
    assert.deepEqual(answers.map((res) => res.status).sort(), [200, 403]);

    const winner = (await answers.find((res) => res.status === 200).json()).user.email;
    assert.ok(['first@test.local', 'second@test.local'].includes(winner));
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).appName, 'Übernahme');
    assert.deepEqual(await status(), { setupMode: false, ready: true, updating: false, apiVersions: [1, 2] });
    assert.equal((await post('/api/setup', setupBody('late@test.local'))).status, 403);
  });
});
