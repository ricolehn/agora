// The database upgrade when it does not get through: the previous version keeps serving the untouched data, and the
// next start begins again (see backend/db/upgrade).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { POCKETBASE_BIN, stop } = require('./instance');
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

  test('the server stops in the middle of the copy: the next start begins again with the same backup', async (t) => {
    const old = await oldInstance();
    t.after(() => old.close());

    const crashing = await old.start({ AGORA_TEST_UPGRADE_FAIL: 'crash:apply' }, { waitReady: false });
    assert.equal(await exited(crashing.process), 70);
    const interrupted = await old.upgradeState();
    assert.equal(interrupted.status, 'running');
    assert.ok((await old.collections()).has('finance_payments'), 'the copy had begun');
    const [backup] = await old.backups();

    const backend = await old.start();
    const state = await old.upgradeState();
    assert.equal(state.status, 'done');
    assert.equal(state.backup, backup, 'the backup of the interrupted attempt is used again');
    assert.deepEqual(await old.backups(), [backup]);
    assert.deepEqual(await old.sameAnswers(), []);
    await stop(backend.process);
  });

});
