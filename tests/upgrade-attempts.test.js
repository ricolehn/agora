// The database upgrade when it does not get through: the previous version keeps serving the untouched data, and the
// next start begins again (see backend/db/upgrade).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { POCKETBASE_BIN, stop } = require('./instance');
const { oldInstance } = require('./upgradeHarness');

describe('an upgrade that keeps failing', { skip: !POCKETBASE_BIN && 'set POCKETBASE_BIN to run the upgrade tests' }, () => {
  test('three failures in a row: no more attempts until AGORA_UPGRADE_RETRY=1, at most three backups', async (t) => {
    const old = await oldInstance();
    t.after(() => old.close());

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const backend = await old.start({ AGORA_TEST_UPGRADE_FAIL: 'compare' });
      assert.equal((await old.upgradeState()).attempts, attempt);
      await stop(backend.process);
    }
    let backend = await old.start();
    const status = await (await fetch(`${backend.base}/api/status`)).json();
    assert.equal(status.upgrade?.state, 'waiting');
    assert.match(status.upgrade.reason, /AGORA_UPGRADE_RETRY=1/);
    assert.equal((await old.upgradeState()).attempts, 3, 'no fourth attempt');
    assert.deepEqual(await old.sameAnswers(), []);
    assert.ok((await old.backups()).length <= 3);
    await stop(backend.process);

    backend = await old.start({ AGORA_UPGRADE_RETRY: '1' });
    assert.equal((await old.upgradeState()).status, 'done');
    assert.deepEqual(await old.sameAnswers(), []);
    assert.ok((await old.backups()).length <= 3, 'only the newest three backups of the upgrade are kept');
    await stop(backend.process);
  });

});
