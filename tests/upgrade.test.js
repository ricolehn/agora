// The database upgrade, end to end: an instance from before it (filled by the frozen backend, see upgradeFixture.js)
// is answered by the current backend after the upgrade exactly as before - every answer of the old API, for every
// role, byte for byte apart from a few documented internal values.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  POCKETBASE_BIN, PASSWORD, LEGACY_SERVER, CURRENT_SERVER, makeRoot, startPocketBase, startBackend, httpClient, superuser, stop
} = require('./instance');
const { seedOldInstance } = require('./upgradeFixture');
const { readsOf, recordAll, answerDifference, oldInstance, OLD_TABLES } = require('./upgradeHarness');

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
      const difference = answerDifference(url, before_[index], after_[index]);
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

describe('older data the previous version kept as it was', { skip: !POCKETBASE_BIN && 'set POCKETBASE_BIN to run the upgrade tests' }, () => {
  // The comparison demanded the old answers exactly, the old server's own failures and text sorting included: each of
  // these records alone made every attempt fail, and the instance stayed on the previous version for good
  test('holes and bare numbers in the donations list, times and days written as text, a sign-up written another way or of a deleted event: the upgrade goes through', async (t) => {
    const root = makeRoot('agora-older-');
    const pocketbase = await startPocketBase(root);
    let backend = await startBackend(root, pocketbase.port, { entry: LEGACY_SERVER, label: 'old backend' });
    t.after(async () => {
      await stop(backend.process);
      await stop(pocketbase.process);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
    const http = httpClient(backend.base);
    const setup = await http.ok(http.call(null, 'POST', '/api/setup', {
      appName: 'Ältere Daten', adminUser: { firstName: 'Olga', lastName: 'Owner', email: 'owner@test.local', password: PASSWORD, memberSince: '2020-01-01' }
    }));
    http.tokens.owner = setup.token;
    const owner = setup.user.id || setup.user.uid;
    const su = await superuser(root, pocketbase.port);
    const state = async (key) => (await su.list('app_state')).find((record) => record.key === key);

    // A hole (`delete list[i]` left null) and an entry that is no donation, next to two donations
    await su.update('app_state', (await state('donations')).id, { value: [
      { id: 1, amount: 10, name: 'Anna', date: '2024-01-07', description: 'Kollekte' }, null, 5, { id: 2, amount: 20, name: 'Ben', date: '2024-02-04', description: 'Spende' }
    ] });
    // What older versions left in app_state.expenses (the expenses have their own table since long ago)
    const olderExpenses = [{ id: 9, amount: 12.5, description: 'Kerzen', issuer: 'Olga Owner', date: '2019-12-01' }];
    await su.update('app_state', (await state('expenses')).id, { value: olderExpenses });
    // Two events of one day at "9:00" and "10:00", one tomorrow written "DD.MM.YYYY", a sign-up whose time has a
    // space instead of the "T", and a sign-up of an event that was deleted without it
    const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    const [y, m, d] = day(1).split('-');
    const event = (fields) => su.create('events', {
      location: '', description: '', isRecurring: false, recurringRule: '', seriesId: '', status: 'scheduled', requiresRegistration: true, minParticipants: 0,
      maxParticipants: 0, targetGroups: [], isPinned: false, endDate: '', eventType: 'event', imageUrl: '', createdBy: owner, isPublic: false, publicToken: '',
      endTime: '', created: '2026-01-01T10:00:00.000Z', updated: '2026-01-01T10:00:00.000Z', ...fields
    });
    const morning = await event({ title: 'Morgens', date: day(10), startTime: '9:00' });
    await event({ title: 'Vormittags', date: day(10), startTime: '10:00' });
    await event({ title: 'Morgen', date: `${d}.${m}.${y}`, startTime: '18:00' });
    await su.create('event_registrations', { event: morning.id, user: owner, status: 'registered', created: '2026-11-01 10:00:00.000Z', updated: '2026-11-01T10:00:00.000Z' });
    await su.create('event_registrations', { event: 'goneeventgoneev', user: owner, status: 'registered', created: '2026-01-01T10:00:00.000Z', updated: '2026-01-01T10:00:00.000Z' });

    await stop(backend.process);
    backend = await startBackend(root, pocketbase.port, { entry: LEGACY_SERVER, port: backend.port, label: 'old backend' });
    const listOf = (answer) => (Array.isArray(answer) ? answer : answer.events || []);
    const donationsBefore = await http.ok(http.call('owner', 'GET', '/api/db?path=donations'));
    const eventsBefore = listOf(await http.ok(http.call('owner', 'GET', '/api/events')));

    await stop(backend.process);
    backend = await startBackend(root, pocketbase.port, { entry: CURRENT_SERVER, port: backend.port, label: 'new backend' });
    const status = await (await fetch(`${backend.base}/api/status`)).json();
    assert.equal(status.upgrade, undefined, `the upgrade got through: ${status.upgrade?.reason || ''}`);

    // The donations as before - the hole is removed once after the switch, the entry that is no donation stays
    assert.deepEqual(await http.ok(http.call('owner', 'GET', '/api/db?path=donations')), donationsBefore.filter((entry) => entry !== null));
    const repair = (await su.list('system_migrations')).find((record) => record.id === 'donations-without-holes');
    assert.equal(repair?.report?.removed, 1);
    // ... and the statistics and the bookings, which failed on the hole, count them
    const stats = await http.ok(http.call('owner', 'GET', '/api/stats'));
    assert.equal(stats.totalBalance, 30);
    const bookings = await http.ok(http.call('owner', 'GET', '/api/transactions?page=1&perPage=50'));
    assert.deepEqual(bookings.items.filter((item) => item.type === 'don' && item.amount).map((item) => item.amount).sort(), [10, 20]);
    // API v2 lists the donations only; the entry that is no donation is the old API's alone - v2 does not touch it
    const v2 = await http.ok(http.call('owner', 'GET', '/api/v2/donations'));
    assert.deepEqual(v2.items.map((item) => item.amountCents).sort(), [1000, 2000]);
    const kept = (await su.list('finance_donations')).find((row) => row.original && Object.hasOwn(row.original, 'entry'));
    assert.equal((await http.call('owner', 'DELETE', `/api/v2/donations/${kept.id}?listVersion=${encodeURIComponent(v2.listVersion)}`)).status, 404);
    assert.equal((await http.call('owner', 'PATCH', `/api/v2/donations/${kept.id}`, { listVersion: v2.listVersion, amountCents: 1 })).status, 404);

    // Every event as before; those of one day in the order of their times
    const events = listOf(await http.ok(http.call('owner', 'GET', '/api/events')));
    assert.deepEqual(events.map((entry) => entry.id).sort(), eventsBefore.map((entry) => entry.id).sort());
    const titles = events.map((entry) => entry.title);
    assert.ok(titles.indexOf('Morgens') < titles.indexOf('Vormittags'), `9:00 before 10:00: ${titles.join(', ')}`);
    const attendees = await http.ok(http.call('owner', 'GET', `/api/events/${morning.id}/attendees`));
    assert.ok(JSON.stringify(attendees).includes(owner), 'the sign-up written another way is still there');

    // What app_state.expenses held is kept with the values of older versions
    const legacyValues = (await su.list('system_settings')).find((row) => row.area === 'legacy');
    assert.deepEqual(legacyValues?.value?.expenses, olderExpenses);
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
