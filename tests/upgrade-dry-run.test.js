// The dry run (backend/db/dryRun.js): the whole upgrade tried on a copy of a backup - the report says it would go
// through and names no person, and the instance the backup came from is not touched.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { POCKETBASE_BIN } = require('./instance');
const { BACKEND_DIR } = require('./helpers');
const { oldInstance } = require('./upgradeHarness');

const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(BACKEND_DIR, 'db', 'dryRun.js'), ...args], { env: { ...process.env, POCKETBASE_BIN }, timeout: 240000 }, (error, stdout, stderr) => {
    resolve({ code: error ? error.code : 0, stdout, stderr });
  });
});

describe('the dry run', { skip: !POCKETBASE_BIN && 'set POCKETBASE_BIN to run the upgrade tests' }, () => {
  test('tries the upgrade on a backup: it would go through, the report names no person, the instance is untouched', async (t) => {
    const old = await oldInstance();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-dry-run-out-'));
    t.after(async () => {
      await old.close();
      fs.rmSync(out, { recursive: true, force: true });
    });
    await old.su.request('POST', '/api/backups', { name: 'before-dry-run.zip' });
    const backup = path.join(old.root, 'pb', 'backups', 'before-dry-run.zip');
    assert.ok(fs.existsSync(backup), 'PocketBase made the backup');
    const collectionsBefore = [...(await old.collections())].sort();

    const result = await run([backup, '--data', path.join(old.root, 'data'), '--out', out]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /would go through/);

    const report = JSON.parse(fs.readFileSync(path.join(out, 'upgrade-dry-run-report.json'), 'utf8'));
    assert.equal(report.status, 'dry-run');
    assert.deepEqual(report.differences, []);
    assert.ok(report.areas.finance.counts.new.finance_payments > 0);
    assert.ok(report.areas.events.counts.new.events > 0);
    const text = JSON.stringify(report);
    for (const name of ['Paul', 'Papier', 'Erna', 'Mia', 'Muster', 'owner@test.local', 'Familie Gut']) assert.ok(!text.includes(name), `the report names no person (${name})`);
    assert.ok(fs.existsSync(path.join(out, 'upgrade-dry-run-details.json')));

    // The instance itself: the same tables (no upgrade was started on it)
    assert.deepEqual([...(await old.collections())].sort(), collectionsBefore);
    assert.ok(!collectionsBefore.includes('system_migrations'));
  });
});
