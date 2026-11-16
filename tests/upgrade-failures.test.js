// The database upgrade when it does not get through: the previous version keeps serving the untouched data, and the
// next start begins again (see backend/db/upgrade).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BACKEND_DIR } = require('./helpers');
const {
  POCKETBASE_BIN, PASSWORD, LEGACY_SERVER, CURRENT_SERVER, makeRoot, startPocketBase, startBackend, httpClient, superuser, faultyProxy, stop
} = require('./instance');
const { oldInstance, exited, OLD_TABLES } = require('./upgradeHarness');

describe('an upgrade that does not get through', { skip: !POCKETBASE_BIN && 'set POCKETBASE_BIN to run the upgrade tests' }, () => {
  test('a failed comparison: the previous version serves the untouched data, the next start upgrades', async (t) => {
    const old = await oldInstance();
    t.after(() => old.close());

    let backend = await old.start({ AGORA_TEST_UPGRADE_FAIL: 'compare' });
    const status = await (await fetch(`${backend.base}/api/status`)).json();
    assert.equal(status.ready, true);
    assert.equal(status.upgrade?.state, 'failed');
    assert.match(status.upgrade.reason, /made to fail/);
    assert.deepEqual(await old.sameAnswers(), [], 'the previous version answers as before');
    const tables = await old.collections();
    for (const name of OLD_TABLES) assert.ok(tables.has(name), `${name} is still there`);
    assert.ok(![...tables].some((name) => name.startsWith('finance_')), 'the new tables of the failed attempt are gone');
    const failed = await old.upgradeState();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 1);
    assert.equal((await old.backups()).length, 1, 'the backup was made before anything else');
    await stop(backend.process);

    backend = await old.start();
    const upgraded = await old.upgradeState();
    assert.equal(upgraded.status, 'done');
    assert.equal(upgraded.attempts, 2);
    assert.equal((await (await fetch(`${backend.base}/api/status`)).json()).upgrade, undefined);
    assert.deepEqual(await old.sameAnswers(), []);
    const after = await old.collections();
    for (const name of OLD_TABLES) assert.ok(!after.has(name), `${name} is gone after the switch`);
    // The previous version served in between: its data may have changed, so a new backup was made
    assert.equal((await old.backups()).length, 2);
    await stop(backend.process);
  });

  test('the server stops in the middle of the copy, three times in a row: each start begins again with the same backup, and only every third stop counts as a failed attempt', async (t) => {
    const old = await oldInstance();
    t.after(() => old.close());

    // A restart or a power cut is no failed attempt: three of them made the instance wait for AGORA_UPGRADE_RETRY=1
    // although nothing had failed. Every third one in a row counts (a server that dies in every attempt still ends up
    // served by the previous version)
    for (let stopped = 1; stopped <= 3; stopped += 1) {
      const crashing = await old.start({ AGORA_TEST_UPGRADE_FAIL: 'crash:apply' }, { waitReady: false });
      assert.equal(await exited(crashing.process), 70);
      const interrupted = await old.upgradeState();
      assert.equal(interrupted.status, 'running');
      assert.equal(interrupted.attempts, 1, `stopped ${stopped} time(s): still the first attempt`);
      assert.ok((await old.collections()).has('finance_payments'), 'the copy had begun');
    }
    const [backup] = await old.backups();

    const backend = await old.start();
    t.after(() => stop(backend.process));
    const state = await old.upgradeState();
    assert.equal(state.status, 'done');
    assert.equal(state.attempts, 2, 'the third stop in a row counted, the other two did not');
    assert.equal(state.backup, backup, 'the backup of the interrupted attempt is used again');
    assert.deepEqual(await old.backups(), [backup]);
    assert.deepEqual(await old.sameAnswers(), []);
    await stop(backend.process);
  });

  test('the copy writes at most 1000 records at a time: a large instance stays within PocketBase\'s time for one batch', async (t) => {
    // 5000 writes in one batch took up to 2.4 s on a fast server against PocketBase's limit of 30 s - on slow storage a
    // large instance failed every attempt the same way. A stand-in in front of PocketBase refuses larger batches
    const root = makeRoot('agora-batches-');
    const pocketbase = await startPocketBase(root);
    let backend = await startBackend(root, pocketbase.port, { entry: LEGACY_SERVER, label: 'old backend' });
    t.after(async () => {
      await stop(backend.process);
      await stop(pocketbase.process);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
    const client = httpClient(backend.base);
    await client.ok(client.call(null, 'POST', '/api/setup', {
      appName: 'Groß', adminUser: { firstName: 'Olga', lastName: 'Owner', email: 'owner@test.local', password: PASSWORD, memberSince: '2000-01-01' }
    }));
    // Three members who paid 400 times each, written the way the previous version keeps them
    const su = await superuser(root, pocketbase.port);
    await su.request('PATCH', '/api/settings', { batch: { enabled: true, maxRequests: 1000, timeout: 120, maxBodySize: 0 } });
    const legacyStore = require(path.join(BACKEND_DIR, 'legacy', 'pocketbase.js'));
    const writes = [];
    for (const key of ['viel-1', 'viel-2', 'viel-3']) {
      const payments = Array.from({ length: 400 }, (_, n) => ({ id: `${key}-${n}`, amount: 5, date: '2020-01-01', description: 'Beitrag' }));
      const person = { id: key, name: `Vera ${key}`, status: 'vollverdiener', memberSince: '2000-01-01', originalMemberSince: '2000-01-01', pays: true, standingOrders: [], payments };
      writes.push({ method: 'POST', url: '/api/collections/people/records', body: legacyStore.buildPersonRecordPayload(key, person) });
      payments.forEach((payment, n) => writes.push({ method: 'POST', url: '/api/collections/payments/records', body: legacyStore.buildPaymentRecordPayload(key, payment, n) }));
    }
    for (let start = 0; start < writes.length; start += 1000) await su.request('POST', '/api/batch', { requests: writes.slice(start, start + 1000) });
    await stop(backend.process);

    let largest = 0;
    const proxy = await faultyProxy(pocketbase.port, (req, body) => {
      if (req.method !== 'POST' || !req.url.startsWith('/api/batch')) return false;
      largest = Math.max(largest, JSON.parse(body).requests.length);
      return JSON.parse(body).requests.length > 1000;
    });
    t.after(() => {
      proxy.closeAllConnections();
      proxy.close();
    });
    backend = await startBackend(root, pocketbase.port, { entry: CURRENT_SERVER, port: backend.port, label: 'new backend', env: { POCKETBASE_PORT: String(proxy.address().port) } });
    const status = await (await fetch(`${backend.base}/api/status`)).json();
    assert.equal(status.upgrade, undefined, `the upgrade got through: ${status.upgrade?.reason || ''}`);
    assert.equal(largest, 1000, 'the largest batch');
    assert.equal((await su.list('finance_payments')).length, 1200);
  });

  test('in the layout of the Docker image (no DATA_DIR): every conversation reads as before - in the previous version while the upgrade waits, and after it', async (t) => {
    const old = await oldInstance();
    t.after(() => old.close());

    // The image keeps backend/ next to data/ and names no folder: each copy of the backend finds them relative to
    // itself - the one in backend/legacy, too, which used to look for the key of the mentoring texts in backend/data
    const entry = backendInLayout(old.root);
    // Stopped after the test also when it fails (a server left running keeps the test file from ending)
    const started = [];
    t.after(() => Promise.all(started.map(stop)));
    const inImage = async (env = {}) => {
      const backend = await startBackend(old.root, old.pocketbase.port, { entry, port: old.port, label: 'new backend', env: { DATA_DIR: undefined, ...env } });
      started.push(backend.process);
      return backend;
    };

    // An upgrade that does not get through: the previous version serves every conversation as before (it used to keep
    // the wrong key of the comparison and showed every message as "decryption failed")
    let backend = await inImage({ AGORA_TEST_UPGRADE_FAIL: 'compare' });
    assert.equal((await (await fetch(`${backend.base}/api/status`)).json()).upgrade?.state, 'failed');
    assert.deepEqual(await old.sameAnswers(), [], 'the previous version reads every conversation as before');
    await stop(backend.process);

    backend = await inImage();
    assert.equal((await (await fetch(`${backend.base}/api/status`)).json()).upgrade, undefined, 'the upgrade got through');
    assert.equal((await old.upgradeState()).status, 'done');
    assert.deepEqual(await old.sameAnswers(), [], 'every conversation reads as before');
    assert.equal(fs.existsSync(path.join(old.root, 'backend', 'data')), false, 'no second key next to the code');
    await stop(backend.process);
  });
});

/** A copy of the backend in [root]/backend, next to the instance's data/ as in the image (with the installed packages). */
function backendInLayout(root) {
  const target = path.join(root, 'backend');
  fs.cpSync(BACKEND_DIR, target, { recursive: true, filter: (source) => path.basename(source) !== 'node_modules' });
  fs.symlinkSync(path.join(BACKEND_DIR, 'node_modules'), path.join(target, 'node_modules'), 'dir');
  return path.join(target, 'server.js');
}

describe('the log of a comparison that differs', () => {
  test('names where the new tables answered differently, never the values: a log is shown around when asking for help', () => {
    const { logDifferences } = require(path.join(BACKEND_DIR, 'db', 'upgrade'));
    const lines = [];
    const original = console.error;
    console.error = (...parts) => lines.push(parts.join(' '));
    try {
      logDifferences(Array.from({ length: 23 }, (_, i) => ({ what: `member -Nkey${i}`, path: `.payments.${i}.amount`, before: `Paula Privat ${i}`, after: 4711 + i })));
    } finally {
      console.error = original;
    }
    assert.equal(lines.length, 21, 'the first twenty places, then how many more');
    assert.ok(lines[0].includes('member -Nkey0') && lines[0].includes('.payments.0.amount'), lines[0]);
    assert.match(lines[20], /3 more/);
    assert.ok(!/Paula|4711/.test(lines.join('\n')), 'no value of a record is in the log');
  });
});
