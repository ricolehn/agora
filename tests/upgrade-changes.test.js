// Changes after the upgrade behave as before it. Two copies of the same old instance: one stays on the frozen backend,
// the other is upgraded; both get the same changes through the API - deleting a group that events and duties name,
// a song an order of service uses, a member with an account, an account (by an admin); members, donations and
// expenses saved without a version, as older apps and the server's own admin routes do - and afterwards every read
// of the old API answers the same on both.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { POCKETBASE_BIN, LEGACY_SERVER, CURRENT_SERVER, startPocketBase, startBackend, httpClient, stop } = require('./instance');
const { oldInstance, recordAll, firstDifference } = require('./upgradeHarness');
const { BACKEND_DIR } = require('./helpers');

/**
 * Two copies of the same old instance ([prepare](old) may add to it first): [before] is served by the frozen backend,
 * [after] was upgraded and is served by the current one. compare() lists the reads of the old API that differ.
 */
async function twins(t, prepare = async () => {}) {
  const old = await oldInstance();
  await prepare(old);
  // The twin: the same database and data folder, copied while PocketBase is stopped
  await stop(old.pocketbase.process);
  const twinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-twin-'));
  fs.cpSync(old.root, twinRoot, { recursive: true });
  const pbBefore = await startPocketBase(old.root);
  const pbAfter = await startPocketBase(twinRoot);
  const servers = [];
  t.after(async () => {
    for (const server of servers) await stop(server.process);
    await stop(pbBefore.process);
    await stop(pbAfter.process);
    for (const root of [old.root, twinRoot]) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  servers.push(await startBackend(old.root, pbBefore.port, { entry: LEGACY_SERVER, label: 'old backend' }));
  servers.push(await startBackend(twinRoot, pbAfter.port, { entry: CURRENT_SERVER, label: 'new backend' }));
  const [before, after] = servers.map((server) => {
    const http = httpClient(server.base);
    Object.assign(http.tokens, old.http.tokens);
    Object.assign(http.uids, old.http.uids);
    return http;
  });
  const status = await (await fetch(`${servers[1].base}/api/status`)).json();
  assert.equal(status.upgrade, undefined, 'the twin was upgraded');
  const compare = async () => {
    const reads = old.reads;
    const [answersBefore, answersAfter] = [await recordAll(before, reads), await recordAll(after, reads)];
    return reads.map(([who, url], index) => [who, url, firstDifference(answersBefore[index], answersAfter[index])])
      .filter(([, , difference]) => difference).map(([who, url, difference]) => `${who || 'nobody'} GET ${url}\n    ${difference}`);
  };
  return { old, before, after, sides: [['before', before], ['after', after]], compare, reads: old.reads };
}

describe('changes after the upgrade', { skip: !POCKETBASE_BIN && 'set POCKETBASE_BIN to run the upgrade tests' }, () => {
  test('deleting a group, a song, a member and an account works as it did before the upgrade', async (t) => {
    const { old, sides, compare, reads } = await twins(t);
    const { facts } = old;
    const songInProgram = facts.songs[0];
    const member = Object.entries(facts.people).find(([who]) => who === 'viewer')?.[1];
    const day = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    for (const [side, http] of sides) {
      const step = async (label, who, method, url, body) => {
        const res = await http.call(who, method, url, body);
        assert.ok(res.status < 300, `${side}: ${label} answered ${res.status} ${JSON.stringify(res.body)}`);
        return res.body;
      };
      // An event with one place: the member who is deleted below holds it, another one waits
      const oneSeat = (await step('an event with one place', 'owner', 'POST', '/api/events', { title: 'Ein Platz', date: day, requiresRegistration: true, maxParticipants: 1 })).event.id;
      await step('the member takes the place', 'viewer', 'POST', `/api/events/${oneSeat}/register`, { action: 'register' });
      await step('another one waits', 'max', 'POST', `/api/events/${oneSeat}/register`, { action: 'register' });
      // A group events and duties name, a song the order of service uses
      await step('deleting the group Jugend', 'owner', 'DELETE', `/api/admin/groups/${facts.groups.Jugend}`);
      await step('deleting the group Technik', 'owner', 'DELETE', `/api/admin/groups/${facts.groups.Technik}`);
      await step('deleting a song', 'mia', 'DELETE', `/api/songs/${songInProgram}`);
      // A member with an account (the account goes with it), an account deleted by an admin
      await step('deleting a member', 'owner', 'DELETE', '/api/db', { path: `people/${member}` });
      await step('deleting an account', 'ada', 'DELETE', `/api/admin/users/${http.uids.mentee}`);
      // The sign-up of the deleted member is still on the list (its account is gone): the organiser takes it off, and
      // whoever waited gets the place - the sign-up has to be found by the id of the account that is gone
      await step('taking the deleted member off the list', 'owner', 'DELETE', `/api/events/${oneSeat}/attendees/${member}`);
      const attendees = await step('reading who comes', 'owner', 'GET', `/api/events/${oneSeat}/attendees`);
      assert.deepEqual([attendees.registered.map((person) => person.userId), attendees.waitlist.map((person) => person.userId)], [[http.uids.max], []], `${side}: the place went to who waited`);
      // (the event has another id on each side: it goes again before every read is compared)
      await step('deleting the event', 'owner', 'DELETE', `/api/events/${oneSeat}`);
    }
    const differences = await compare();
    assert.deepEqual(differences, [], `${differences.length} of ${reads.length} answers differ:\n${differences.slice(0, 30).join('\n')}`);
  });

  test('the books change as before the upgrade when they are saved without a version: what is deleted goes, nothing is there twice', async (t) => {
    const legacyStore = require(path.join(BACKEND_DIR, 'legacy', 'pocketbase.js'));
    const erna = '-NalteMitgliedXY';
    const { old, sides, compare, reads } = await twins(t, async (instance) => {
      // Old data: a payment without an id that an app appended back-dated - the key it was stored under holds its
      // place in the list then (1), not the place it has when the list is sorted by date (0)
      await instance.su.create('payments', legacyStore.buildPaymentRecordPayload(erna, { amount: 40, date: '2012-06-01', description: 'Bar, nachgetragen' }, 1));
    });
    const { uids } = old.http;
    const totals = {};
    for (const [side, http] of sides) {
      const send = async (label, who, method, url, body) => {
        const res = await http.call(who, method, url, body);
        assert.ok(res.status < 300, `${side}: ${label} answered ${res.status} ${JSON.stringify(res.body)}`);
        return res.body;
      };
      const person = (key) => send(`reading ${key}`, 'treasurer', 'GET', `/api/db?path=people/${key}`);
      // An app without versions (a plain PUT of the whole member, as older apps send it)
      const put = async (label, key, change) => send(label, 'treasurer', 'PUT', '/api/db', { path: `people/${key}`, value: change(await person(key)) });

      // A payment booked by mistake and taken out again: the newest entry of the member
      await put('booking a payment by mistake', uids.max, (p) => ({ ...p, payments: [...p.payments, { id: 1799000000001, amount: 999, date: '2026-11-02', description: 'Irrtum' }] }));
      await put('taking it out again', uids.max, (p) => ({ ...p, payments: p.payments.filter((payment) => payment.id !== 1799000000001) }));
      assert.ok(!(await person(uids.max)).payments.some((payment) => payment.id === 1799000000001), `${side}: the payment taken out is gone`);
      // Payments without ids, one of them back-dated, and the member saved again as it was read
      await put('a payment without an id', uids.max, (p) => ({ ...p, payments: [...p.payments, { amount: 10, date: '2026-03-01', description: 'ohne id' }] }));
      await put('a back-dated payment without an id', uids.max, (p) => ({ ...p, payments: [...p.payments, { amount: 20, date: '2026-01-01', description: 'ohne id, nachgetragen' }] }));
      await put('saved again as read', uids.max, (p) => p);
      await put('saved again as read, once more', uids.max, (p) => p);
      // Every payment of a member taken out at once
      await put('taking out every payment', uids.mia, (p) => ({ ...p, payments: [] }));
      assert.equal((await person(uids.mia)).payments.length, 0, `${side}: every payment is gone`);
      // What the web app's admin pages do to a member (the server reads the member and writes it back, without a
      // version): a new "member since" moves the first status period, linking an account adds the uid
      await send('member since, moved', 'owner', 'PUT', `/api/admin/users/${uids.max}/member-since`, { memberSince: '2020-06-01' });
      await send('member since, moved again', 'owner', 'PUT', `/api/admin/users/${uids.max}/member-since`, { memberSince: '2019-06-01' });
      await send('linking an account', 'owner', 'PATCH', '/api/db', { path: `people/${erna}`, value: { uid: uids.mentee } });
      await send('linking it again', 'owner', 'PATCH', '/api/db', { path: `people/${erna}`, value: { uid: uids.mentee } });
      // Donations and expenses as older apps save them: the whole list, no version
      for (const root of ['donations', 'expenses']) {
        const list = async () => Object.values(await send(`reading the ${root}`, 'treasurer', 'GET', `/api/db?path=${root}`));
        const mistake = root === 'donations'
          ? { id: 1799000000002, amount: 777, name: 'Irrtum', date: '2026-11-03', description: '' }
          : { id: 1799000000002, amount: 777, description: 'Irrtum', issuer: 'Theo', date: '2026-11-03' };
        await send(`${root}: one too many`, 'treasurer', 'PUT', '/api/db', { path: root, value: [...await list(), mistake] });
        await send(`${root}: taken out again`, 'treasurer', 'PUT', '/api/db', { path: root, value: (await list()).filter((entry) => entry.id !== mistake.id) });
        assert.ok(!(await list()).some((entry) => entry.id === mistake.id), `${side}: the entry taken out of the ${root} is gone`);
      }
      const [max, old1] = [await person(uids.max), await person(erna)];
      totals[side] = { max: [max.payments.length, max.totalPaid, max.statusHistory.length], erna: [old1.payments.length, old1.totalPaid] };
    }
    // Nothing twice: Erna's two payments stay two, Max has one status period and his 66 payments plus the two added
    assert.deepEqual(totals.after, totals.before);
    assert.deepEqual(totals.after, { max: [68, 3330, 1], erna: [2, 80] });
    const differences = await compare();
    assert.deepEqual(differences, [], `${differences.length} of ${reads.length} answers differ:\n${differences.slice(0, 30).join('\n')}`);
  });
});
