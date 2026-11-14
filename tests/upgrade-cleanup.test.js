// The database upgrade after its switch: from then on the new tables are the only copy, so nothing may ever be undone.
// A cleanup that fails or is interrupted leaves everything as it is and is tried again until it gets through
// (backend/db/upgrade/index.js). And what would stop the cleanup for good is found before anything is changed.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { POCKETBASE_BIN, stop, waitUntilReady } = require('./instance');
const { oldInstance, exited } = require('./upgradeHarness');

const OLD_FINANCE_TABLES = ['people', 'payments', 'status_history', 'expenses', 'requests'];
const status = (backend) => fetch(`${backend.base}/api/status`).then((res) => res.json()).catch(() => null);

/** Waits until /api/status of [backend] says [wanted](status). */
async function untilStatus(backend, wanted, what, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await status(backend);
    if (now && wanted(now)) return now;
    if (backend.process.exitCode !== null) throw new Error(`the server exited (${backend.process.exitCode})\n${backend.process.log.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the status never said: ${what}\n${backend.process.log.join('')}`);
}

/** How many records each old table of the books held before the upgrade. */
async function countsBefore(old) {
  const counts = {};
  for (const name of ['people', 'payments', 'status_history', 'expenses', 'requests', 'groups', 'events', 'songs']) counts[name] = (await old.su.list(name)).length;
  return counts;
}

/** The switch is written and every record is in the new tables: nothing of the attempt was undone. */
async function assertSwitchedAndComplete(old, before) {
  const state = await old.upgradeState();
  assert.equal(state.status, 'done', 'the switch stays written');
  assert.equal(state.attempts, 1, 'no second attempt of the upgrade itself');
  assert.equal(state.report.cleanupPending, true, 'the cleanup is still to be finished');
  const tables = await old.collections();
  // The members include the hidden record that keeps the payments of a member whose record was gone
  for (const [table, expected] of [['finance_payments', before.payments], ['finance_status_periods', before.status_history], ['finance_expenses', before.expenses], ['finance_requests', before.requests], ['user_groups', before.groups], ['community_songs', before.songs]]) {
    assert.ok(tables.has(table), `${table} is still there`);
    assert.equal((await old.su.list(table)).length, expected, `${table} holds every record`);
  }
  assert.ok((await old.su.list('finance_members')).length >= before.people, 'finance_members holds every member');
  const users = await old.su.collections().then((list) => list.find((collection) => collection.name === 'users'));
  assert.ok(users.fields.some((field) => field.name === 'original'), 'what the accounts kept as written is still there');
  return state;
}

async function assertFinished(old, backend) {
  assert.equal((await status(backend)).problem, undefined);
  const state = await old.upgradeState();
  assert.equal(state.status, 'done');
  assert.equal(state.report.cleanupPending, false);
  assert.equal(state.report.cleanupError, undefined, 'the note of the failed cleanup is gone');
  const tables = await old.collections();
  for (const name of [...OLD_FINANCE_TABLES, 'groups', 'songs', 'app_state']) assert.ok(!tables.has(name), `${name} is gone`);
  assert.ok(![...tables].some((name) => name.startsWith('v4_')), 'every new table has its own name');
  assert.deepEqual(await old.sameAnswers(), [], 'every answer is as before the upgrade');
}

describe('the upgrade after its switch', { skip: !POCKETBASE_BIN && 'set POCKETBASE_BIN to run the upgrade tests' }, () => {
  test('a cleanup that fails undoes nothing: the same server tries again and finishes it', async (t) => {
    const old = await oldInstance();
    t.after(() => old.close());
    const before = await countsBefore(old);

    // The cleanup fails once, in its middle: the old tables of the books are gone already, the others are not
    const backend = await old.start({ AGORA_TEST_UPGRADE_FAIL: 'once:cleanup' }, { waitReady: false });
    t.after(() => stop(backend.process));
    const waiting = await untilStatus(backend, (now) => now.problem, 'why the start is tried again');
    assert.equal(waiting.ready, false);
    assert.equal(waiting.upgrade, undefined, 'the previous version did not take over');
    assert.match(waiting.problem, /Nothing was undone/);
    const tables = await old.collections();
    for (const name of OLD_FINANCE_TABLES) assert.ok(!tables.has(name), `${name} was removed before the cleanup failed`);
    const state = await assertSwitchedAndComplete(old, before);
    assert.match(state.report.cleanupError, /made to fail/);
    const answer = await old.http.call('owner', 'GET', '/api/db?path=people');
    assert.equal(answer.status, 503, 'the apps are asked to wait');

    // Tried again by the same server (a start that failed is, after ten seconds) - with a new sign-in at PocketBase:
    // the token of the first try ended when the superuser was renewed
    await waitUntilReady(backend.base, backend.process, 60000);
    await assertFinished(old, backend);
    assert.equal((await old.backups()).length, 1);
  });

  test('the server stops in the middle of the cleanup, and a cleanup that keeps failing: every start goes on where it stopped', async (t) => {
    const old = await oldInstance();
    t.after(() => old.close());
    const before = await countsBefore(old);

    const crashing = await old.start({ AGORA_TEST_UPGRADE_FAIL: 'crash:cleanup' }, { waitReady: false });
    assert.equal(await exited(crashing.process), 70);
    await assertSwitchedAndComplete(old, before);

    // The next start cannot finish it either: still nothing is undone, and the previous version does not take over
    // (it would find its tables gone)
    let backend = await old.start({ AGORA_TEST_UPGRADE_FAIL: 'cleanup' }, { waitReady: false });
    await untilStatus(backend, (now) => now.problem, 'why the start is tried again');
    await assertSwitchedAndComplete(old, before);
    await stop(backend.process);

    backend = await old.start();
    t.after(() => stop(backend.process));
    await assertFinished(old, backend);
  });

  test('what is not part of Agora and depends on an old table is found before anything changes', async (t) => {
    const old = await oldInstance();
    t.after(() => old.close());
    // Made on PocketBase's admin page: a table that links to the songs and a view over the payments. PocketBase
    // refuses to delete a table something links to or a view reads - the cleanup could never get through
    const collections = await old.su.collections();
    const songs = collections.find((collection) => collection.name === 'songs');
    await old.su.request('POST', '/api/collections', { name: 'my_notes', type: 'base', fields: [{ name: 'about', type: 'relation', collectionId: songs.id, maxSelect: 1, cascadeDelete: false }] });
    await old.su.request('POST', '/api/collections', { name: 'my_report', type: 'view', viewQuery: 'SELECT id, personKey, amount FROM payments' });
    // An index of one's own over a field of users that the upgrade removes: the field could not be removed
    const users = collections.find((collection) => collection.name === 'users');
    await old.su.request('PATCH', `/api/collections/${users.id}`, { indexes: [...users.indexes, 'CREATE INDEX idx_my_users_name ON users (name)'] });
    // A table of one's own that depends on nothing of Agora's is nobody's business
    await old.su.request('POST', '/api/collections', { name: 'my_list', type: 'base', fields: [{ name: 'note', type: 'text' }] });

    let backend = await old.start();
    const refused = await status(backend);
    assert.equal(refused.upgrade?.state, 'failed');
    assert.match(refused.upgrade.reason, /my_notes\.about links to the table songs/);
    assert.match(refused.upgrade.reason, /the view my_report reads the table payments/);
    assert.match(refused.upgrade.reason, /the index idx_my_users_name of users uses the field name/);
    assert.doesNotMatch(refused.upgrade.reason, /my_list/);
    assert.deepEqual(await old.sameAnswers(), [], 'the previous version serves the untouched data');
    assert.deepEqual(await old.backups(), [], 'found by the check: not even the backup was needed');
    const tables = await old.collections();
    assert.ok(![...tables].some((name) => name.startsWith('finance_')), 'nothing new was built');
    await stop(backend.process);

    await old.su.request('DELETE', '/api/collections/my_notes');
    await old.su.request('DELETE', '/api/collections/my_report');
    await old.su.request('PATCH', `/api/collections/${users.id}`, { indexes: users.indexes });
    backend = await old.start();
    t.after(() => stop(backend.process));
    assert.equal((await old.upgradeState()).status, 'done');
    assert.deepEqual(await old.sameAnswers(), []);
    assert.ok((await old.collections()).has('my_list'), 'the table of one\'s own is left alone');
  });

  test('a database an earlier revision left half switched is not touched again: the admin is told to restore the backup', async (t) => {
    const old = await oldInstance();
    t.after(() => old.close());
    let backend = await old.start();
    const [backup] = await old.backups();
    await stop(backend.process);
    // What revisions 1-3 left when their cleanup failed: the upgrade marked failed although the cleanup had begun
    // (users links its groups already), and the previous version made its tables anew, empty
    const payments = (await old.su.list('finance_payments')).length;
    await old.su.update('system_migrations', 'v4-structure', { status: 'failed', attempts: 3, report: { revision: 3 } });
    await old.su.request('POST', '/api/collections', { name: 'people', type: 'base', fields: [{ name: 'personKey', type: 'text' }] });

    backend = await old.start();
    t.after(() => stop(backend.process));
    const now = await status(backend);
    assert.equal(now.upgrade?.state, 'failed', 'the corrected revision looks again on its own');
    assert.match(now.upgrade.reason, new RegExp(`Restore the backup ${backup.replace(/[.]/g, '\\.')}`));
    // Nothing more was removed from it
    assert.equal((await old.su.list('finance_payments')).length, payments);
    const users = (await old.su.collections()).find((collection) => collection.name === 'users');
    assert.ok(users.fields.some((field) => field.name === 'original'));
    assert.equal((await old.backups()).length, 1, 'and no backup of the incomplete database pushed the good one out');
  });

  test('two accounts with the same calendar address do not stop the upgrade', async (t) => {
    const old = await oldInstance();
    t.after(() => old.close());
    // Never made by the app (the addresses are random); a record edited by hand can have it. The new structure wants
    // the addresses unique - an index that cannot be made must not stop the cleanup, after the switch
    const [first, second] = [old.http.uids.treasurer, old.http.uids.viewer];
    await old.su.update('users', first, { calendarToken: 'the-same-calendar-address-twice-0123456789' });
    await old.su.update('users', second, { calendarToken: 'the-same-calendar-address-twice-0123456789' });

    const backend = await old.start();
    t.after(() => stop(backend.process));
    assert.equal((await status(backend)).ready, true);
    const state = await old.upgradeState();
    assert.equal(state.status, 'done');
    assert.equal(state.report.cleanupPending, false);
    assert.ok(backend.process.log.join('').includes('several accounts share one calendar address'), 'the log says so');
    const differences = (await old.sameAnswers()).filter((line) => !line.includes('calendarToken'));
    assert.deepEqual(differences, [], 'everything but the two addresses set here is as before');
  });
});
