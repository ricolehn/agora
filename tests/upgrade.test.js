// The database upgrade, end to end: an instance from before it (filled by the frozen backend, see upgradeFixture.js)
// is answered by the current backend after the upgrade exactly as before - every answer of the old API, for every
// role, byte for byte apart from a few documented internal values.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  POCKETBASE_BIN, LEGACY_SERVER, CURRENT_SERVER, makeRoot, startPocketBase, startBackend, httpClient, superuser, stop
} = require('./instance');
const { seedOldInstance } = require('./upgradeFixture');
const { readsOf, recordAll, firstDifference, oldInstance, OLD_TABLES } = require('./upgradeHarness');

describe('the database upgrade', { skip: !POCKETBASE_BIN && 'set POCKETBASE_BIN to run the upgrade tests' }, () => {
  let root;
  let pocketbase;
  let backend;
  let http;
  let facts;
  let reads;
  let before_;

  before(async () => {
    root = makeRoot('agora-upgrade-');
    pocketbase = await startPocketBase(root);
    backend = await startBackend(root, pocketbase.port, { entry: LEGACY_SERVER, label: 'old backend' });
    http = httpClient(backend.base);
    facts = await seedOldInstance({ http, su: () => superuser(root, pocketbase.port) });
    const feed = await http.ok(http.call('max', 'GET', '/api/user/calendar-feed'));
    const calendarFeed = (feed.url || '').replace(/^https?:\/\/[^/]+/, '');

    // The old server is restarted once: what it does when it starts (standing orders, tidying up) has happened
    await stop(backend.process);
    backend = await startBackend(root, pocketbase.port, { entry: LEGACY_SERVER, port: backend.port, label: 'old backend' });
    reads = readsOf(facts, { calendarFeed });
    // Reads that change something (marking messages read, removing what ran out) have happened before the recording
    await recordAll(http, reads);
    before_ = await recordAll(http, reads);

    await stop(backend.process);
    backend = await startBackend(root, pocketbase.port, { entry: CURRENT_SERVER, port: backend.port, label: 'new backend' });
  });

  after(async () => {
    await stop(backend?.process);
    await stop(pocketbase?.process);
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('every answer of the old API is the same after the upgrade', async () => {
    // The answers come from the new tables: the previous version, serving when the upgrade does not get through, would
    // give the same ones
    const status = await (await fetch(`${backend.base}/api/status`)).json();
    assert.equal(status.upgrade, undefined, `the upgrade got through: ${status.upgrade?.reason || ''}`);
    const after_ = await recordAll(http, reads);
    const differences = [];
    reads.forEach(([who, url], index) => {
      const difference = firstDifference(before_[index], after_[index]);
      if (difference) differences.push(`${who || 'nobody'} GET ${url}\n    ${difference}`);
    });
    assert.ok(reads.length > 500, `the recording covers the API (${reads.length} reads)`);
    assert.deepEqual(differences, [], `${differences.length} of ${reads.length} answers changed:\n${differences.slice(0, 40).join('\n')}`);
  });
});

describe('after the upgrade', { skip: !POCKETBASE_BIN && 'set POCKETBASE_BIN to run the upgrade tests' }, () => {
  test('after the upgrade: a second start changes nothing, the report names no person', async (t) => {
    const old = await oldInstance();
    t.after(() => old.close());

    let backend = await old.start();
    const done = await old.upgradeState();
    await stop(backend.process);
    backend = await old.start();
    assert.deepEqual(await old.upgradeState(), done, 'nothing ran again');
    assert.equal((await old.backups()).length, 1);
    assert.deepEqual(await old.sameAnswers(), []);

    // The duty the old server gave a group as "confirmed" is "assigned" now - repaired once, on the first start
    const repair = (await old.su.list('system_migrations')).find((record) => record.id === 'duty-statuses');
    assert.equal(repair.status, 'done');
    assert.ok(repair.report.repaired >= 1, `repaired ${repair.report.repaired}`);
    assert.equal(repair.attempts, 1, 'once');
    const duties = await old.su.list('event_duties');
    assert.ok(duties.some((duty) => duty.assignedGroup), 'there are group duties');
    for (const duty of duties) {
      const expected = duty.assignedUser ? 'confirmed' : duty.assignedGroup ? 'assigned' : duty.requestedUser ? ['requested', 'declined'] : 'open';
      if (Array.isArray(expected)) assert.ok(expected.includes(duty.status), `${duty.roleName}: ${duty.status}`);
      else assert.equal(duty.status, expected, duty.roleName);
    }

    const findings = done.report.areas.finance.findings;
    assert.ok(findings.amountsAsText.count >= 3, 'amounts written as text are listed');
    assert.ok(findings.amountsUnreadable.count >= 1);
    assert.ok(findings.amountsWithFractionOfCent.count >= 1);
    assert.ok(findings.datesInOtherSpelling.count >= 2);
    assert.ok(findings.listColumnsDisagreeWithRecord.count >= 1);
    const text = JSON.stringify(done.report);
    for (const personal of ['Paul', 'Papier', 'Gelöscht', '@test.local', 'Familie Gut', '1.234,50']) assert.ok(!text.includes(personal), `the report holds no "${personal}"`);
    await stop(backend.process);
  });
});

describe('a new instance', { skip: !POCKETBASE_BIN && 'set POCKETBASE_BIN to run the upgrade tests' }, () => {
  test('gets the new structure directly: nothing to upgrade, no backup', async (t) => {
    const root = makeRoot('agora-fresh-');
    const pocketbase = await startPocketBase(root);
    t.after(async () => {
      await stop(pocketbase.process);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
    const backend = await startBackend(root, pocketbase.port, { entry: CURRENT_SERVER });
    t.after(() => stop(backend.process));
    const http = httpClient(backend.base);
    await http.ok(http.call(null, 'POST', '/api/setup', { appName: 'Neu', adminUser: { firstName: 'N', lastName: 'Eu', email: 'neu@test.local', password: 'test-Passwort-1' } }));
    const su = await superuser(root, pocketbase.port);
    const names = new Set((await su.collections()).map((collection) => collection.name));
    for (const name of OLD_TABLES) assert.ok(!names.has(name), `no ${name}`);
    for (const name of ['finance_members', 'finance_payments', 'finance_ledger', 'finance_monthly_totals', 'system_migrations']) assert.ok(names.has(name), name);
    const state = (await su.list('system_migrations'))[0];
    assert.equal(state.status, 'done');
    assert.equal(state.report.fresh, true);
    assert.deepEqual(await su.request('GET', '/api/backups'), []);
  });
});
