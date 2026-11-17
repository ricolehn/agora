// API v2 end-to-end over HTTP (docs/API_V2.md): what it grew to cover everything the apps did through the old API -
// fee accounts, standing orders, status changes, receipts, search, requests decided and booked in one step, the fees
// and fresh starts, the calendar, mentoring, the songbook and media - its answers in the language of the request, and
// lists of the books saved as a whole that keep every record. Its own server and PocketBase (like api.test.js), so
// what it books never meets the other tests. Needs POCKETBASE_BIN (skipped without it, see api.test.js).
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { REPO_ROOT, freePort, waitFor, start, SERVER_ENTRY } = require('./helpers');
const { startFakeNextcloud } = require('./fakeNextcloud');

const POCKETBASE_BIN = process.env.POCKETBASE_BIN || '';
const hasPocketBase = POCKETBASE_BIN !== '' && fs.existsSync(POCKETBASE_BIN);
if (!hasPocketBase && process.env.REQUIRE_POCKETBASE === '1') {
  throw new Error(`REQUIRE_POCKETBASE=1 but no PocketBase binary at POCKETBASE_BIN="${POCKETBASE_BIN}"`);
}

const PASSWORD = 'test-Passwort-1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

/** The day [offset] days from today ('YYYY-MM-DD', UTC as the server's clock runs in the tests). */
const day = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
/** The [dayOfMonth] of the month [months] before this one. */
function inMonth(months, dayOfMonth) {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  return `${date.toISOString().slice(0, 8)}${String(dayOfMonth).padStart(2, '0')}`;
}

describe('API v2', { skip: !hasPocketBase && 'set POCKETBASE_BIN to run the HTTP tests' }, () => {
  const processes = [];
  let base;
  let dataRoot;
  const tokens = {};
  const uids = {};

  async function call(who, method, url, body, { form = false, lang = null } = {}) {
    const headers = { 'X-Forwarded-For': `10.43.0.${Object.keys(tokens).indexOf(who) + 2}` };
    if (who && tokens[who]) headers.Authorization = `Bearer ${tokens[who]}`;
    if (lang) headers['Accept-Language'] = lang;
    if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: form ? body : body === undefined ? undefined : JSON.stringify(body) });
    const buffer = Buffer.from(await res.arrayBuffer());
    let parsed = buffer.toString('utf8');
    try { parsed = JSON.parse(parsed); } catch { /* text or a file */ }
    return { status: res.status, body: parsed, headers: res.headers, buffer };
  }
  const v2 = (who, method, url, body, options) => call(who, method, `/api/v2${url}`, body, options);
  const ok = async (promise) => {
    const res = await promise;
    assert.ok(res.status < 300, `expected success, got ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
    return res.body;
  };
  const refused = async (promise, status, code) => {
    const res = await promise;
    assert.equal(res.status, status, JSON.stringify(res.body).slice(0, 300));
    assert.equal(res.body?.error?.code, code);
    return res.body.error;
  };
  const login = async (who, email) => {
    tokens[who] = (await ok(call(null, 'POST', '/api/auth/login', { email, password: PASSWORD }))).token;
    uids[who] = (await ok(call(who, 'GET', '/api/auth/me'))).user.uid;
  };
  const account = async (who, firstName, extra = {}) => {
    await ok(call('owner', 'POST', '/api/admin/users', {
      firstName, lastName: 'Test', email: `${who}@test.local`, password: PASSWORD, pays: true, admin: false, status: 'vollverdiener', memberSince: '2025-01-01', ...extra
    }));
    await login(who, `${who}@test.local`);
    return uids[who];
  };
  /** The member record of the account [uid], as v2 lists it for the treasurer. */
  const memberOf = async (uid) => (await ok(v2('treasurer', 'GET', '/members?limit=500'))).items.find((member) => member.userId === uid);
  const upload = (who, url, field, name, bytes, type) => {
    const form = new FormData();
    form.append(field, new Blob([bytes], { type }), name);
    return call(who, 'POST', url, form, { form: true });
  };

  before(async () => {
    const [port, pbPort] = await Promise.all([freePort(), freePort()]);
    dataRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agora-api-v2-'));
    const pbDir = path.join(dataRoot, 'pb');
    base = `http://127.0.0.1:${port}`;
    processes.push(start('pocketbase', POCKETBASE_BIN, ['serve', '--dir', pbDir, '--automigrate=false', '--http', `127.0.0.1:${pbPort}`], {}));
    await waitFor(`http://127.0.0.1:${pbPort}/api/health`, 'PocketBase', processes);
    processes.push(start('backend', process.execPath, [SERVER_ENTRY], {
      PORT: String(port), POCKETBASE_PORT: String(pbPort), POCKETBASE_BIN, POCKETBASE_DIR: pbDir, DATA_DIR: path.join(dataRoot, 'data'), FRONTEND_DIR: REPO_ROOT, NODE_ENV: 'test'
    }));
    await waitFor(`${base}/api/status`, 'backend', processes);
    const setup = await ok(call(null, 'POST', '/api/setup', {
      appName: 'Testgemeinde', adminUser: { firstName: 'Olga', lastName: 'Owner', email: 'owner@test.local', password: PASSWORD }
    }));
    tokens.owner = setup.token;
    uids.owner = setup.user.id || setup.user.uid;
    const group = await ok(call('owner', 'POST', '/api/admin/groups', { name: 'Kasse', permissions: ['manage_finances'] }));
    await account('treasurer', 'Theo');
    await account('max', 'Max');
    await account('mia', 'Mia');
    await ok(call('owner', 'PUT', `/api/admin/users/${uids.treasurer}/groups`, { groups: [group.id || group.group?.id] }));
  });

  after(() => {
    for (const child of processes.reverse()) if (child.exitCode === null) child.kill();
    if (dataRoot) fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  // --- Lists saved as a whole keep every record ------------------------------------------------------------------

  test('donations an older version kept as a map keep their records when an app saves them as a list - nothing is written anew', async () => {
    // An older instance: the donations as a map by key, as the first versions kept them - one with an id of its own,
    // one without
    const map = {
      '-NaltEins': { id: 'alt-1', amount: 11, name: 'Alt Eins', date: '2024-01-01', description: 'Karte' },
      '-NaltZwei': { amount: 12, name: 'Alt Zwei', date: '2024-01-02', description: 'ohne eigene ID' },
      '-NaltDrei': { id: 'alt-3', amount: 13, name: 'Alt Drei', date: '2024-01-03', description: '' }
    };
    await ok(call('treasurer', 'PUT', '/api/db', { path: 'donations', value: map }));
    const asMap = await ok(call('treasurer', 'GET', '/api/db?path=donations&raw=1'));
    assert.ok(!Array.isArray(asMap.value), 'kept as a map');
    const records = async () => (await ok(v2('treasurer', 'GET', '/donations?limit=500'))).items;
    const changes = async () => (await ok(v2('treasurer', 'GET', '/finance/changes?area=donation&limit=500'))).items;
    const idsBefore = (await records()).map((donation) => donation.id).sort();
    const logBefore = new Set((await changes()).map((change) => change.id));

    // The web app (and the apps) read the map and save a list, with one donation more: every donation keeps its
    // record, and the change log has the one that was added - it had every donation removed and added anew
    const added = { id: 'neu-1', amount: 5, name: 'Neu', date: '2026-01-05', description: '' };
    await ok(call('treasurer', 'POST', '/api/db/transaction', { path: 'donations', currentVersion: asMap.version, value: [...Object.values(asMap.value), added] }));
    const afterList = await records();
    assert.deepEqual(afterList.filter((donation) => donation.clientId !== 'neu-1').map((donation) => donation.id).sort(), idsBefore, 'the same records');
    const logged = (await changes()).filter((change) => !logBefore.has(change.id));
    assert.deepEqual(logged.map((change) => change.action), ['create'], 'only the new donation is in the change log');

    // Moved in the list: no change of any donation, the same records
    const asList = await ok(call('treasurer', 'GET', '/api/db?path=donations&raw=1'));
    assert.ok(Array.isArray(asList.value));
    await ok(call('treasurer', 'POST', '/api/db/transaction', { path: 'donations', currentVersion: asList.version, value: [...asList.value].reverse() }));
    assert.deepEqual((await records()).map((donation) => donation.id).sort(), afterList.map((donation) => donation.id).sort());
    assert.equal((await changes()).filter((change) => !logBefore.has(change.id)).length, 1);

    // Through v2: an entry an older app wrote without an id keeps its record when it is changed (it gets an id)
    const plain = (await records()).find((donation) => donation.donorName === 'Alt Zwei');
    assert.equal(plain.clientId, null);
    const list = await ok(v2('treasurer', 'GET', '/donations'));
    const changed = await ok(v2('treasurer', 'PATCH', `/donations/${plain.id}`, { listVersion: list.listVersion, amountCents: 1250 }));
    assert.deepEqual([changed.id, changed.amountCents], [plain.id, 1250]);
    assert.ok(typeof changed.clientId === 'string' && changed.clientId);
  });

  test('expenses of an older app without ids keep their records when an entry is added above them', async () => {
    const records = async () => (await ok(v2('treasurer', 'GET', '/expenses?limit=500'))).items;
    const plain = [
      { amount: 7, description: 'Briefmarken', issuer: 'Theo Test', date: '2024-02-01' },
      { amount: 8, description: 'Kaffee', issuer: 'Theo Test', date: '2024-02-02' }
    ];
    const current = await ok(call('treasurer', 'GET', '/api/db?path=expenses&raw=1'));
    await ok(call('treasurer', 'POST', '/api/db/transaction', { path: 'expenses', currentVersion: current.version, value: [...Object.values(current.value || {}), ...plain] }));
    const before = (await records()).filter((expense) => ['Briefmarken', 'Kaffee'].includes(expense.description));
    assert.equal(before.length, 2);
    // A new entry first: the two below it moved, nothing else
    const now = await ok(call('treasurer', 'GET', '/api/db?path=expenses&raw=1'));
    const others = Object.values(now.value || {});
    await ok(call('treasurer', 'POST', '/api/db/transaction', { path: 'expenses', currentVersion: now.version, value: [{ amount: 9, description: 'Blumen', issuer: 'Theo Test', date: '2024-02-03' }, ...others] }));
    const after = (await records()).filter((expense) => ['Briefmarken', 'Kaffee'].includes(expense.description));
    assert.deepEqual(after.map((expense) => expense.id).sort(), before.map((expense) => expense.id).sort());
  });

  // --- Languages -------------------------------------------------------------------------------------------------

  test('errors come in the language of the request - the app\'s, else the person\'s - and the code stays what a client acts on', async () => {
    const english = await refused(v2('max', 'GET', '/nothing-here', undefined, { lang: 'en' }), 404, 'not_found');
    assert.equal(english.message, 'There is no such resource in API v2.');
    const german = await refused(v2('max', 'GET', '/nothing-here', undefined, { lang: 'de-DE,de;q=0.9' }), 404, 'not_found');
    assert.notEqual(german.message, english.message);
    // Given before a route of v2 runs: no sign-in
    const unsigned = await fetch(`${base}/api/v2/members`, { headers: { 'X-Forwarded-For': '10.43.9.1', 'Accept-Language': 'de' } });
    const unsignedError = (await unsigned.json()).error;
    assert.equal(unsignedError.code, 'unauthorized');
    assert.notEqual(unsignedError.message, 'Unauthorized');
    // A value that does not fit names its field, in every language
    const mia = await memberOf(uids.mia);
    const wrong = { memberId: mia.id, memberVersion: mia.version, amountCents: 100, date: '2026-02-31' };
    const inEnglish = await refused(v2('treasurer', 'POST', '/payments', wrong, { lang: 'en' }), 400, 'invalid');
    const inGerman = await refused(v2('treasurer', 'POST', '/payments', wrong, { lang: 'de' }), 400, 'invalid');
    assert.deepEqual([inEnglish.field, inGerman.field], ['date', 'date']);
    assert.equal(inEnglish.message, 'date must be a day of the calendar, YYYY-MM-DD.');
    assert.notEqual(inGerman.message, inEnglish.message);
    assert.match(inGerman.message, /^date /, 'the field keeps its name');
    // Without a language of the app (fetch sends "*"): the person's own language
    const noMember = async () => (await refused(v2('max', 'GET', '/members/nobody'), 404, 'not_found')).message;
    const ownEnglish = await noMember();
    assert.equal(ownEnglish, 'There is no such member.');
    await ok(call('max', 'PATCH', '/api/db', { path: `users/${uids.max}`, value: { language: 'de' } }));
    assert.notEqual(await noMember(), ownEnglish);
    await ok(call('max', 'PATCH', '/api/db', { path: `users/${uids.max}`, value: { language: 'en' } }));
    assert.equal(await noMember(), ownEnglish);
  });

  // --- The books ---------------------------------------------------------------------------------------------------

  test('a member\'s fee account as the apps show it: overdue, paid by a standing order, due soon - as v1 works it out', async () => {
    const uid = await account('konto', 'Konto');
    let member = await memberOf(uid);
    for (const key of ['currentStatus', 'feeState', 'isDueSoon', 'hasActiveStandingOrder', 'anticipatedCents', 'freshStart']) assert.ok(key in member, key);
    assert.deepEqual([member.feeState, member.isOverdue, member.hasActiveStandingOrder, member.currentStatus], ['overdue', true, false, 'vollverdiener']);
    // Paid well ahead, with a standing order that runs: "standing order running"
    await ok(v2('treasurer', 'POST', '/payments', { memberId: member.id, memberVersion: member.version, amountCents: 1000000, date: '2026-01-02', description: 'Vorauszahlung' }));
    member = await memberOf(uid);
    await ok(v2('treasurer', 'POST', '/standing-orders', { memberId: member.id, memberVersion: member.version, amountCents: 5000, startDate: day(0), note: 'Beitrag' }));
    member = await memberOf(uid);
    assert.deepEqual([member.feeState, member.isOverdue, member.hasActiveStandingOrder], ['standingOrder', false, true]);
    // The same as v1 works out for the apps
    const old = await ok(call('treasurer', 'GET', `/api/db?path=people/${uid}`));
    assert.equal(old._statusMeta.text, 'Dauerauftrag läuft');
    assert.equal(member.isDueSoon, old._statusMeta.isSoonDue === true);
    assert.equal(member.anticipatedCents, Math.round(old._anticipatedPayment * 100));
    assert.equal(member.freshStart, null);
    // One member answers as the list has it
    const alone = await ok(v2('treasurer', 'GET', `/members/${member.id}`));
    for (const key of ['feeState', 'isDueSoon', 'hasActiveStandingOrder', 'anticipatedCents', 'freshStart', 'currentStatus']) assert.deepEqual(alone[key], member[key], key);
    // ?q= finds members by name, accents and case aside
    assert.ok((await ok(v2('treasurer', 'GET', '/members?q=KONTO'))).items.some((entry) => entry.id === member.id));
    assert.equal((await ok(v2('treasurer', 'GET', '/members?q=gibtsnicht'))).items.length, 0);
  });

  test('a record that never said whether its member pays counts as paying, as the web app and the fee calculation count it', async () => {
    // As older versions of the apps wrote member records: no "pays" at all - and one that says the member pays nothing
    const record = (id, name, extra = {}) => ({ id, name, status: 'vollverdiener', memberSince: '2025-01-01', originalMemberSince: '2025-01-01', payments: [], statusHistory: [{ status: 'vollverdiener', startDate: '2025-01-01' }], standingOrders: [], ...extra });
    await ok(call('treasurer', 'PUT', '/api/db', { path: 'people/ohne-angabe', value: record('ohne-angabe', 'Olaf Ohneangabe') }));
    await ok(call('treasurer', 'PUT', '/api/db', { path: 'people/zahlt-nicht', value: record('zahlt-nicht', 'Zora Zahltnicht', { pays: false }) }));
    const [unsaid] = (await ok(v2('treasurer', 'GET', '/members?q=ohneangabe'))).items;
    const [notPaying] = (await ok(v2('treasurer', 'GET', '/members?q=zahltnicht'))).items;
    assert.deepEqual([unsaid.pays, notPaying.pays], [true, false]);
    assert.equal((await ok(v2('treasurer', 'GET', `/members/${unsaid.id}`))).pays, true);
    assert.equal((await ok(v2('treasurer', 'GET', `/members/${notPaying.id}`))).pays, false);
  });

  test('member records and accounts: a member sees the record that bears their name and links it; administrators link any account', async () => {
    const uid = await account('claire', 'Claire');
    // A record of the books nobody's account is linked to, with Claire's name (as the treasury made it before she had an account)
    await ok(call('treasurer', 'PUT', '/api/db', { path: 'people/claire-alt', value: { id: 'claire-alt', name: 'Claire Test', status: 'vollverdiener', memberSince: '2024-01-01', originalMemberSince: '2024-01-01', pays: true, payments: [], statusHistory: [{ status: 'vollverdiener', startDate: '2024-01-01' }], standingOrders: [] } }));
    const own = (await ok(v2('claire', 'GET', '/members'))).items;
    const unclaimed = own.find((member) => member.userId === null);
    assert.ok(unclaimed && own.some((member) => member.userId === uid), 'her own record and the one to claim');
    assert.equal((await ok(v2('max', 'GET', '/members'))).items.some((member) => member.id === unclaimed.id), false, 'not for anyone else');
    // Linking an account that is not her own is for the treasury
    await refused(v2('claire', 'PUT', `/members/${unclaimed.id}/account`, { userId: uids.max }), 403, 'forbidden');
    await refused(v2('claire', 'PUT', `/members/${unclaimed.id}/account`, { userId: 'nobody12345' }), 404, 'not_found');
    const linked = await ok(v2('claire', 'PUT', `/members/${unclaimed.id}/account`, { userId: uid }));
    assert.equal(linked.userId, uid);
    // The accounts and their records: for administrators
    await refused(v2('treasurer', 'GET', '/accounts'), 403, 'forbidden');
    const accounts = (await ok(v2('owner', 'GET', '/accounts?q=claire'))).items;
    assert.deepEqual(accounts.map((entry) => entry.id), [uid]);
    assert.ok(accounts[0].memberId);
    assert.ok((await ok(v2('owner', 'GET', '/accounts?unlinked=1&limit=500'))).items.every((entry) => entry.memberId === null));
    // The treasury links any account to a record of the books
    await ok(call('treasurer', 'PUT', '/api/db', { path: 'people/claire-zwei', value: { id: 'claire-zwei', name: 'Clara Zweitname', status: 'vollverdiener', memberSince: '2025-01-01', originalMemberSince: '2025-01-01', pays: true, payments: [], statusHistory: [{ status: 'vollverdiener', startDate: '2025-01-01' }], standingOrders: [] } }));
    const second = (await ok(v2('treasurer', 'GET', '/members?q=zweitname'))).items[0];
    assert.equal(second.userId, null);
    await refused(v2('claire', 'PUT', `/members/${second.id}/account`, { userId: uid }), 403, 'forbidden');
    assert.equal((await ok(v2('treasurer', 'PUT', `/members/${second.id}/account`, { userId: uid }))).userId, uid);
  });

  test('standing orders: what they owe is booked at once, an end takes back what was booked after it, a removal keeps the payments', async () => {
    const uid = await account('dauer', 'Dauer');
    let member = await memberOf(uid);
    const startDate = inMonth(3, 3);
    // Twice for the same request: one standing order
    const asked = { memberId: member.id, memberVersion: member.version, amountCents: 2500, startDate, note: 'Monatsbeitrag', requestId: 'so-request-1' };
    const created = await v2('treasurer', 'POST', '/standing-orders', asked);
    assert.equal(created.status, 201);
    const order = created.body;
    assert.deepEqual([order.memberId, order.amountCents, order.startDate, order.note, order.clientId], [member.id, 2500, startDate, 'Monatsbeitrag', 'req_so-request-1']);
    const again = await v2('treasurer', 'POST', '/standing-orders', { ...asked, memberVersion: order.memberVersion });
    assert.deepEqual([again.status, again.body.id], [200, order.id]);
    // The months since its start are booked (as the web app and the daily run book them)
    const autoPayments = async () => (await ok(v2('treasurer', 'GET', `/payments?member=${member.id}&limit=500`))).items.filter((payment) => payment.standingOrderId === order.id);
    const booked = await autoPayments();
    assert.ok(booked.length >= 3, `${booked.length} payments booked`);
    assert.ok(booked.every((payment) => payment.source === 'standingOrder' && payment.amountCents === 2500));
    assert.ok(order.lastBookedOn >= startDate);
    // Listed with the member's version; a member sees their own
    const listed = (await ok(v2('treasurer', 'GET', `/standing-orders?member=${member.id}`))).items;
    assert.deepEqual(listed.map((entry) => entry.id), [order.id]);
    assert.deepEqual((await ok(v2('dauer', 'GET', '/standing-orders'))).items.map((entry) => entry.id), [order.id]);
    assert.equal((await ok(v2('max', 'GET', '/standing-orders'))).items.length, 0);
    await refused(v2('max', 'POST', '/standing-orders', { ...asked, requestId: undefined, memberVersion: listed[0].memberVersion }), 403, 'forbidden');

    // Ended a day before its second month: what it booked after that goes, the first payment stays
    member = await memberOf(uid);
    await refused(v2('treasurer', 'PATCH', `/standing-orders/${order.id}`, { memberVersion: 'old', endDate: inMonth(2, 2) }), 409, 'conflict');
    const ended = await ok(v2('treasurer', 'PATCH', `/standing-orders/${order.id}`, { memberVersion: member.version, endDate: inMonth(2, 2) }));
    assert.deepEqual([ended.id, ended.endDate], [order.id, inMonth(2, 2)]);
    assert.equal((await autoPayments()).length, 1);
    await refused(v2('treasurer', 'PATCH', `/standing-orders/${order.id}`, { memberVersion: ended.memberVersion, endDate: '2020-01-01' }), 400, 'invalid');
    // Removed: the order goes, its payment stays in the books
    assert.equal((await v2('treasurer', 'DELETE', `/standing-orders/${order.id}?memberVersion=${encodeURIComponent(ended.memberVersion)}`)).status, 204);
    assert.equal((await ok(v2('treasurer', 'GET', `/standing-orders?member=${member.id}`))).items.length, 0);
    assert.equal((await ok(v2('treasurer', 'GET', `/payments?member=${member.id}`))).items.filter((payment) => payment.source === 'standingOrder').length, 1);
  });

  test('a status change from a day on rewrites the history as the web app does; before the membership it is refused', async () => {
    const { applyStatusChangeToHistory } = await import(pathToFileURL(path.join(REPO_ROOT, 'assets', 'finance.js')).href);
    const uid = await account('status', 'Stella');
    const member = await memberOf(uid);
    const before = await ok(call('treasurer', 'GET', `/api/db?path=people/${uid}`));
    const changed = await ok(v2('treasurer', 'POST', '/status-changes', { memberId: member.id, memberVersion: member.version, status: 'geringverdiener', date: '2026-03-01' }));
    assert.equal(changed.status, 'geringverdiener');
    assert.deepEqual(changed.statusPeriods.map(({ status, startDate, endDate }) => [status, startDate, endDate]).sort(), [['geringverdiener', '2026-03-01', null], ['vollverdiener', '2025-01-01', '2026-03-01']]);
    // The web app's own rule gives the same history
    const after = await ok(call('treasurer', 'GET', `/api/db?path=people/${uid}`));
    const strip = (history) => history.map(({ status, startDate, endDate }) => ({ status, startDate, ...(endDate ? { endDate } : {}) }));
    assert.deepEqual(strip(after.statusHistory), strip(applyStatusChangeToHistory(before, 'geringverdiener', '2026-03-01').statusHistory));
    assert.equal((await refused(v2('treasurer', 'POST', '/status-changes', { memberId: member.id, memberVersion: changed.version, status: 'pausiert', date: '2024-06-01' }), 400, 'invalid')).field, 'date');
    assert.equal((await refused(v2('treasurer', 'POST', '/status-changes', { memberId: member.id, memberVersion: changed.version, status: 'reich', date: '2026-06-01' }), 400, 'invalid')).field, 'status');
    await refused(v2('max', 'POST', '/status-changes', { memberId: member.id, memberVersion: changed.version, status: 'pausiert', date: '2026-06-01' }), 403, 'forbidden');
  });

  test('receipts: pictures and PDFs, uploaded and read through v2, a list of them with every entry - for the finances and whoever uploaded them', async () => {
    const picture = await upload('max', '/api/v2/receipts', 'receipt', 'beleg.png', PNG, 'image/png');
    assert.equal(picture.status, 201);
    const pdf = await upload('max', '/api/v2/receipts', 'receipt', 'rechnung.pdf', PDF, 'application/pdf');
    assert.equal(pdf.status, 201, JSON.stringify(pdf.body));
    assert.match(pdf.body.name, /\.pdf$/);
    const html = await upload('max', '/api/v2/receipts', 'receipt', 'seite.html', Buffer.from('<script>1</script>'), 'text/html');
    assert.equal(html.status, 400);
    assert.equal(html.body.error.code, 'invalid');
    // Read: the treasurer and the uploader, nobody else
    const read = await v2('treasurer', 'GET', `/receipts/${picture.body.name}`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.buffer, PNG);
    assert.equal((await v2('max', 'GET', `/receipts/${pdf.body.name}`)).status, 200);
    await refused(v2('mia', 'GET', `/receipts/${picture.body.name}`), 403, 'forbidden');
    // An expense with both: the list, and the field as the web app writes it
    const expenses = await ok(v2('treasurer', 'GET', '/expenses'));
    const expense = await ok(v2('treasurer', 'POST', '/expenses', { listVersion: expenses.listVersion, amountCents: 1999, date: '2026-04-01', issuer: 'Max Test', description: 'Druckerpapier', receipts: [picture.body.name, pdf.body.name] }));
    assert.deepEqual(expense.receipts, [picture.body.name, pdf.body.name]);
    assert.equal(expense.receipt, JSON.stringify([picture.body.name, pdf.body.name]));
    const v1 = Object.values(await ok(call('treasurer', 'GET', '/api/db?path=expenses')));
    assert.equal(v1.find((entry) => entry.id === expense.clientId).receipt, expense.receipt);
    // An older field (names with commas) reads as a list, too; [] takes them away
    const cleared = await ok(v2('treasurer', 'PATCH', `/expenses/${expense.id}`, { listVersion: expense.listVersion, receipts: [] }));
    assert.deepEqual([cleared.receipts, cleared.receipt], [[], null]);
  });

  test('search: payments, donations, expenses and all bookings by name, text, day and amount', async () => {
    const uid = await account('suche', 'Susanne');
    const member = await memberOf(uid);
    await ok(v2('treasurer', 'POST', '/payments', { memberId: member.id, memberVersion: member.version, amountCents: 4321, date: '2026-05-05', description: 'Gemeindefreizeit Anzahlung' }));
    const donations = await ok(v2('treasurer', 'GET', '/donations'));
    await ok(v2('treasurer', 'POST', '/donations', { listVersion: donations.listVersion, amountCents: 7777, date: '2026-05-06', donorName: 'Familie Übermut', description: 'Orgel' }));
    const ids = async (url) => (await ok(v2('treasurer', 'GET', url))).items;
    assert.equal((await ids('/payments?q=susanne')).length, 1, 'by the member\'s name');
    assert.equal((await ids('/payments?q=freizeit anzahlung')).length, 1, 'every word');
    assert.equal((await ids('/payments?q=05.05.2026')).length, 1, 'by the day as people write it');
    assert.equal((await ids('/payments?q=43,21')).length, 1, 'by the amount');
    assert.equal((await ids('/payments?q=freizeit orgel')).length, 0);
    assert.equal((await ids('/donations?q=ubermut')).length, 1, 'accents aside');
    const ledger = await ids('/finance/ledger?q=2026-05');
    assert.deepEqual(ledger.map((entry) => entry.kind).sort(), ['donation', 'memberPayment']);
    assert.ok(ledger.every((entry, index) => index === 0 || ledger[index - 1].date >= entry.date), 'newest first');
    assert.deepEqual((await ids('/finance/ledger?kind=donation&q=orgel')).map((entry) => [entry.who, entry.amountCents]), [['Familie Übermut', 7777]]);
    await refused(v2('treasurer', 'GET', '/finance/ledger?kind=gift'), 400, 'invalid');
    await refused(v2('max', 'GET', '/finance/ledger'), 403, 'forbidden');
  });

  test('requests decided and booked in one step: once, however often it is sent - a payment, an expense, a standing order, a status change', async () => {
    const uid = await account('antrag', 'Anton');
    const member = await memberOf(uid);
    const file = async (type, details) => ok(v2('antrag', 'POST', '/requests', { type, details, notify: true }));
    const decide = (id, body = { status: 'approved', book: true }) => v2('treasurer', 'POST', `/requests/${id}/decision`, body);
    // A payment: booked as the web app books it, with the request in its id
    const payment = await file('payment', { amount: '12.5', date: '2026-05-09', note: 'Fest' });
    const decided = await ok(decide(payment.id));
    assert.equal(decided.status, 'approved');
    const bookedPayments = async () => (await ok(v2('treasurer', 'GET', `/payments?member=${member.id}&limit=500`))).items.filter((entry) => entry.clientId === `req_${payment.id}`);
    assert.deepEqual((await bookedPayments()).map((entry) => [entry.amountCents, entry.description, entry.source]), [[1250, 'Fest', 'request']]);
    await refused(decide(payment.id), 409, 'conflict');
    assert.equal((await bookedPayments()).length, 1, 'not booked twice');
    // A client that booked first (with requestId) and decides with book: no second booking
    const first = await file('payment', { amount: '3', date: '2026-05-10', note: 'Vorher gebucht' });
    const now = await memberOf(uid);
    await ok(v2('treasurer', 'POST', '/payments', { memberId: now.id, memberVersion: now.version, amountCents: 300, date: '2026-05-10', description: 'Vorher gebucht', requestId: first.id }));
    await ok(decide(first.id));
    assert.equal((await ok(v2('treasurer', 'GET', `/payments?member=${member.id}&limit=500`))).items.filter((entry) => entry.clientId === `req_${first.id}`).length, 1);
    // An expense, its receipt with it; the requester is the issuer
    const receipt = (await upload('antrag', '/api/v2/receipts', 'receipt', 'kerzen.png', PNG, 'image/png')).body.name;
    const expense = await file('expense', { amount: '20', description: 'Kerzen', date: '2026-05-11', receipt: JSON.stringify([receipt]) });
    assert.deepEqual(expense.receipts, [receipt]);
    await ok(decide(expense.id));
    const bookedExpense = (await ok(v2('treasurer', 'GET', '/expenses?limit=500'))).items.find((entry) => entry.clientId === `req_${expense.id}`);
    assert.deepEqual([bookedExpense.amountCents, bookedExpense.issuer, bookedExpense.receipts], [2000, member.name, [receipt]]);
    // A standing order and a status change
    const order = await file('standing_order', { amount: '15', date: day(20), note: '' });
    await ok(decide(order.id));
    const orders = (await ok(v2('treasurer', 'GET', `/standing-orders?member=${member.id}`))).items;
    assert.deepEqual(orders.map((entry) => [entry.clientId, entry.amountCents, entry.note]), [[`req_${order.id}`, 1500, 'Dauerauftrag (Genehmigt)']]);
    const status = await file('status', { newStatus: 'geringverdiener', date: '2026-02-01' });
    await ok(decide(status.id));
    assert.equal((await ok(v2('treasurer', 'GET', `/members/${member.id}`))).status, 'geringverdiener');
    // book goes with an approval only; a rejection without a reason says none
    const other = await file('payment', { amount: '1', date: '2026-05-12', note: '' });
    await refused(decide(other.id, { status: 'rejected', book: true }), 400, 'invalid');
    const rejected = await ok(decide(other.id, { status: 'rejected' }));
    assert.deepEqual([rejected.status, rejected.rejectionReason], ['rejected', null]);
    // What cannot be booked as it is (an amount "12,50" was booked as 12.00) stays pending, for the treasury to book by hand
    const comma = await file('payment', { amount: '12,50', date: '2026-05-14', note: '' });
    assert.equal((await refused(decide(comma.id), 400, 'invalid')).field, 'details.amount');
    assert.equal((await ok(v2('treasurer', 'GET', '/requests?status=pending&limit=500'))).items.some((request) => request.id === comma.id), true);
    // A note as long as a booking takes it, no longer
    const long = await v2('antrag', 'POST', '/requests', { type: 'payment', details: { amount: '1', date: '2026-05-13', note: 'x'.repeat(5001) } });
    assert.deepEqual([long.status, long.body.error.field], [400, 'details.note']);
  });

  test('the fees over time and the fresh starts through v2: in cents, who set them only for the finances, changed by system admins as checked', async () => {
    // A change from the next month: checked first, saved as checked, taken back
    const next = new Date();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const fromMonth = next.toISOString().slice(0, 7);
    const change = { fromMonth, feesCents: { vollverdiener: 6100, geringverdiener: 3100, keinverdiener: 1100 } };
    await refused(v2('treasurer', 'POST', '/fees/preview', change), 403, 'forbidden');
    const preview = await ok(v2('owner', 'POST', '/fees/preview', change));
    assert.equal(preview.fromMonth, fromMonth);
    assert.equal(preview.inEffect, false);
    assert.equal(preview.stretches[0].afterCents.vollverdiener, 6100);
    await refused(v2('owner', 'POST', '/fees', change), 400, 'invalid');
    const saved = await ok(v2('owner', 'POST', '/fees', { ...change, version: preview.version }));
    assert.equal(saved.next.fromMonth, fromMonth);
    assert.equal(saved.next.feesCents.vollverdiener, 6100);
    assert.ok(saved.feeChanges.some((entry) => entry.fromMonth === fromMonth && entry.state === 'planned' && entry.setByName === 'Olga Owner'));
    assert.ok(saved.log.some((entry) => entry.fromMonth === fromMonth && entry.feesCents.vollverdiener === 6100));
    // Who set the fees: for those who see the finances (v1 kept it from the members; v2 showed it to everyone)
    const forMember = await ok(v2('max', 'GET', '/fees'));
    assert.ok(forMember.feeChanges.some((entry) => entry.fromMonth === fromMonth));
    assert.ok(forMember.feeChanges.every((entry) => entry.setByName === '' && entry.setAt === null));
    assert.ok(!('version' in forMember) && !('log' in forMember));
    assert.ok(Number.isInteger(forMember.currentCents.vollverdiener));
    assert.ok((await ok(v2('treasurer', 'GET', '/fees'))).feeChanges.some((entry) => entry.setByName === 'Olga Owner'));
    await refused(v2('owner', 'POST', '/fees', { ...change, version: preview.version }), 409, 'conflict');
    const removed = await ok(v2('owner', 'POST', '/fees/remove', { fromMonth, version: saved.version }));
    assert.equal(removed.feeChanges.some((entry) => entry.fromMonth === fromMonth), false);

    // A fresh start a week ahead: the numbers first, then the day twice and the password
    const freshDay = day(7);
    const impact = await ok(v2('owner', 'GET', `/fresh-starts/preview?day=${freshDay}`));
    assert.equal(impact.day, freshDay);
    assert.ok(Number.isInteger(impact.behind.totalCents) && Number.isInteger(impact.ahead.count));
    await refused(v2('owner', 'POST', '/fresh-starts', { day: freshDay, confirmDay: freshDay, password: 'falsch' }), 403, 'forbidden');
    await refused(v2('owner', 'POST', '/fresh-starts', { day: freshDay, confirmDay: day(8), password: PASSWORD }), 400, 'invalid');
    await refused(v2('treasurer', 'POST', '/fresh-starts', { day: freshDay, confirmDay: freshDay, password: PASSWORD }), 403, 'forbidden');
    const set = await ok(v2('owner', 'POST', '/fresh-starts', { day: freshDay, confirmDay: freshDay, password: PASSWORD }));
    assert.deepEqual(set.items.find((entry) => entry.day === freshDay)?.state, 'scheduled');
    assert.ok((await ok(v2('max', 'GET', '/fresh-starts'))).items.every((entry) => !('setByName' in entry)));
    const back = await ok(v2('owner', 'POST', '/fresh-starts/remove', { day: freshDay, confirmDay: freshDay, password: PASSWORD }));
    assert.equal(back.items.some((entry) => entry.day === freshDay), false);
  });

  // --- The calendar ------------------------------------------------------------------------------------------------

  test('events through v2: made, changed and deleted by whoever may; places and the waiting list; the duty roster and its requests', async () => {
    await account('ella', 'Ella');
    const created = await ok(v2('max', 'POST', '/events', { title: 'Grillabend', date: day(30), startTime: '18:00', location: 'Garten', requiresRegistration: true, maxParticipants: 1 }));
    assert.deepEqual([created.title, created.startTime, created.canEdit, created.seriesCount], ['Grillabend', '18:00', true, 1]);
    // Appointments and pinned events are for those who manage events; times and days are checked
    await refused(v2('max', 'POST', '/events', { title: 'Termin', date: day(31), kind: 'termin' }), 403, 'forbidden');
    assert.equal((await refused(v2('max', 'POST', '/events', { title: 'Zeit', date: day(31), startTime: '25:00' }), 400, 'invalid')).field, 'startTime');
    assert.equal((await refused(v2('max', 'POST', '/events', { title: 'Plätze', date: day(31), minParticipants: 5, maxParticipants: 2 }), 400, 'invalid')).code, 'invalid');
    // The duties an event starts with
    const withDuties = await ok(v2('max', 'POST', '/events', { title: 'Putztag', date: day(32), duties: [{ roleName: 'Aufbau', section: 'Vorher' }, { roleName: 'Abbau' }] }));
    assert.deepEqual(withDuties.duties.map((entry) => [entry.roleName, entry.status]), [['Aufbau', 'open'], ['Abbau', 'open']]);
    assert.equal((await refused(v2('max', 'POST', '/events', { title: 'Ohne', date: day(32), duties: [{ roleName: ' ' }] }), 400, 'invalid')).field, 'duties.0.roleName');
    assert.equal((await v2('max', 'DELETE', `/events/${withDuties.id}`)).status, 204);
    const changed = await ok(v2('max', 'PATCH', `/events/${created.id}`, { title: 'Grillfest' }));
    assert.equal(changed.title, 'Grillfest');
    await refused(v2('mia', 'PATCH', `/events/${created.id}`, { title: 'Meins' }), 403, 'forbidden');

    // One place: Mia gets it, Ella waits - and moves up when Mia cancels
    assert.equal((await ok(v2('mia', 'PUT', `/events/${created.id}/registration`))).myRegistration.status, 'registered');
    assert.equal((await ok(v2('ella', 'PUT', `/events/${created.id}/registration`))).myRegistration.status, 'waitlist');
    const participants = (await ok(v2('max', 'GET', `/events/${created.id}/participants`))).items;
    assert.deepEqual(participants.map((person) => [person.userId, person.status]), [[uids.mia, 'registered'], [uids.ella, 'waitlist']]);
    assert.equal((await ok(v2('mia', 'DELETE', `/events/${created.id}/registration`))).myRegistration, null);
    assert.equal((await ok(v2('ella', 'GET', `/events/${created.id}`))).myRegistration.status, 'registered');

    // A duty asked of Mia: she sees the request, accepts it, gives it back; Ella takes it
    const duty = await ok(v2('max', 'POST', `/events/${created.id}/duties`, { roleName: 'Grill', section: 'Essen', requestedUserId: uids.mia, sendEmail: false }));
    assert.deepEqual([duty.status, duty.requestedUserId, duty.eventId], ['requested', uids.mia, created.id]);
    // The list carries who made it, whether it is full and the roster with the names, as the event alone does - the
    // roster only for those who see it
    const names = { max: (await ok(v2('max', 'GET', '/me'))).name, mia: (await ok(v2('mia', 'GET', '/me'))).name };
    const listed = async (who) => (await ok(v2(who, 'GET', `/events?from=${day(30)}&to=${day(30)}`))).items.find((event) => event.id === created.id);
    const forMax = await listed('max');
    assert.deepEqual([forMax.createdByName, forMax.canEdit, forMax.isFull, forMax.shareToken], [names.max, true, true, null]);
    const listedDuty = forMax.duties.find((entry) => entry.id === duty.id);
    assert.deepEqual([listedDuty.requestedUserName, listedDuty.requestedByName, listedDuty.assignedUserName], [names.mia, names.max, '']);
    assert.deepEqual([duty.requestedUserName, duty.requestedByName], [names.mia, names.max], 'a duty answers with the names, too');
    assert.equal((await listed('ella')).duties, null, 'Ella has no duty and does not organise it');
    assert.equal((await listed('mia')).duties.length, 1, 'Mia was asked');
    // Shared with people without an account: the key of the link while it is shared
    const shared = await ok(v2('max', 'PATCH', `/events/${created.id}`, { isPublic: true }));
    assert.match(String(shared.shareToken), /^[A-Za-z0-9_-]{8,}$/);
    assert.equal((await listed('mia')).shareToken, shared.shareToken);
    assert.equal((await ok(v2('max', 'PATCH', `/events/${created.id}`, { isPublic: false }))).shareToken, null);
    assert.ok((await ok(v2('mia', 'GET', '/duty-requests'))).items.some((request) => request.dutyId === duty.id));
    await refused(v2('ella', 'POST', `/duties/${duty.id}/answer`, { answer: 'accept' }), 403, 'forbidden');
    const accepted = await ok(v2('mia', 'POST', `/duties/${duty.id}/answer`, { answer: 'accept' }));
    assert.deepEqual([accepted.status, accepted.assignedUserId], ['confirmed', uids.mia]);
    assert.equal((await ok(v2('mia', 'DELETE', `/duties/${duty.id}/claim`))).status, 'open');
    assert.deepEqual(Object.values(await ok(v2('ella', 'PUT', `/duties/${duty.id}/claim`))).length > 0, true);
    assert.equal((await ok(v2('max', 'GET', `/events/${created.id}`))).duties.find((entry) => entry.id === duty.id).assignedUserId, uids.ella);
    // The order of service, checked and never cut
    const program = await ok(v2('max', 'PUT', `/events/${created.id}/program`, { items: [{ title: 'Begrüßung', minutes: 5 }, { title: 'Essen', minutes: 60, who: 'Alle' }] }));
    assert.deepEqual(program.items.map((item) => [item.title, item.minutes]), [['Begrüßung', 5], ['Essen', 60]]);
    await refused(v2('max', 'PUT', `/events/${created.id}/program`, { items: [{ title: 'x'.repeat(121) }] }), 400, 'invalid');
    // The people a duty can go to; the calendar feed
    assert.ok((await ok(v2('max', 'GET', '/people?q=mia'))).items.some((person) => person.id === uids.mia));
    assert.match((await ok(v2('mia', 'GET', '/calendar-feed'))).feedUrl, /calendar\.ics\?user=/);
    const ics = await v2('mia', 'GET', `/events/${created.id}/calendar.ics`);
    assert.equal(ics.status, 200);
    assert.match(String(ics.body), /BEGIN:VCALENDAR/);
    // Gone for everyone
    await refused(v2('mia', 'DELETE', `/events/${created.id}`), 403, 'forbidden');
    assert.equal((await v2('max', 'DELETE', `/events/${created.id}`)).status, 204);
    await refused(v2('max', 'GET', `/events/${created.id}`), 404, 'not_found');
  });

  test('who changes an event: those who manage events every event, everyone their own - its kind and pinning only those who manage events', async () => {
    await account('lena', 'Lena');
    const lead = await ok(call('owner', 'POST', '/api/admin/groups', { name: 'Leitung', permissions: ['manage_events'] }));
    await ok(call('owner', 'PUT', `/api/admin/users/${uids.lena}/groups`, { groups: [lead.id || lead.group?.id] }));
    // Everyone creates events; appointments only those who manage events
    const own = await ok(v2('max', 'POST', '/events', { title: 'Spieleabend', date: day(33) }));
    await refused(v2('max', 'POST', '/events', { title: 'Gottesdienst', date: day(33), kind: 'termin' }), 403, 'forbidden');
    // Lena makes Max's event an appointment and pins it
    const pinned = await ok(v2('lena', 'PATCH', `/events/${own.id}`, { kind: 'termin', isPinned: true, location: 'Saal' }));
    assert.deepEqual([pinned.kind, pinned.isPinned, pinned.location, pinned.canEdit], ['termin', true, 'Saal', true]);
    // Max still changes his own event - also when he sends its kind and pinning as they are, as an app sends the whole
    // event back - but changes neither of them
    const changed = await ok(v2('max', 'PATCH', `/events/${own.id}`, { title: 'Großer Spieleabend', kind: 'termin', isPinned: true }));
    assert.deepEqual([changed.title, changed.kind, changed.isPinned, changed.canEdit], ['Großer Spieleabend', 'termin', true, true]);
    await refused(v2('max', 'PATCH', `/events/${own.id}`, { isPinned: false }), 403, 'forbidden');
    await refused(v2('max', 'PATCH', `/events/${own.id}`, { kind: 'event' }), 403, 'forbidden');
    assert.equal((await ok(v2('max', 'GET', `/events/${own.id}`))).isPinned, true);
    // Someone else's event: only those who manage events - every event and appointment
    await refused(v2('mia', 'PATCH', `/events/${own.id}`, { title: 'Meins' }), 403, 'forbidden');
    const appointment = await ok(v2('lena', 'POST', '/events', { title: 'Gottesdienst', date: day(34), kind: 'termin' }));
    await refused(v2('max', 'PATCH', `/events/${appointment.id}`, { title: 'Meins' }), 403, 'forbidden');
    assert.equal((await ok(v2('lena', 'PATCH', `/events/${own.id}`, { title: 'Spieleabend für alle' }))).title, 'Spieleabend für alle');
    assert.equal((await v2('lena', 'DELETE', `/events/${own.id}`)).status, 204);
    assert.equal((await v2('lena', 'DELETE', `/events/${appointment.id}`)).status, 204);
  });

  // --- Community -------------------------------------------------------------------------------------------------

  test('mentoring through v2: apply, approved by those who manage it, a conversation with unread messages, read and closed', async () => {
    await account('paula', 'Paula');
    await account('pius', 'Pius');
    const applied = await ok(v2('paula', 'POST', '/mentoring/application', { bio: 'Ich höre zu.', maxMentees: 2 }));
    assert.equal(applied.profile.status, 'pending');
    await refused(v2('pius', 'POST', `/mentoring/mentors/${applied.profile.id}/status`, { status: 'approved' }), 403, 'forbidden');
    await refused(v2('pius', 'GET', '/mentoring/mentors?status=pending'), 403, 'forbidden');
    assert.ok((await ok(v2('owner', 'GET', '/mentoring/mentors?status=pending'))).items.some((mentor) => mentor.id === applied.profile.id));
    await ok(v2('owner', 'POST', `/mentoring/mentors/${applied.profile.id}/status`, { status: 'approved' }));
    const mentor = (await ok(v2('pius', 'GET', '/mentoring/mentors'))).items.find((entry) => entry.id === applied.profile.id);
    assert.deepEqual([mentor.userId, mentor.isFull, mentor.activeMentees], [uids.paula, false, 0]);
    assert.ok(!('email' in mentor), 'e-mail addresses only for those who manage mentoring');

    const thread = await ok(v2('pius', 'POST', '/mentoring/threads', { mentorUserId: uids.paula, message: 'Hallo Paula' }));
    assert.deepEqual([thread.role, thread.title, thread.isClosed], ['mentee', mentor.name, false]);
    const forMentor = (await ok(v2('paula', 'GET', '/mentoring/threads'))).items.find((entry) => entry.id === thread.id);
    assert.deepEqual([forMentor.role, forMentor.unreadCount, forMentor.lastMessage], ['mentor', 1, 'Hallo Paula']);
    assert.equal((await ok(v2('paula', 'POST', `/mentoring/threads/${thread.id}/read`))).unreadCount, 0);
    const reply = await ok(v2('paula', 'POST', `/mentoring/threads/${thread.id}/messages`, { text: 'Hallo Pius' }));
    assert.deepEqual([reply.from, reply.text], ['mentor', 'Hallo Pius']);
    await refused(v2('max', 'POST', `/mentoring/threads/${thread.id}/messages`, { text: 'Ich auch' }), 403, 'forbidden');
    await refused(v2('pius', 'POST', `/mentoring/threads/${thread.id}/messages`, { text: '   ' }), 400, 'invalid');
    const closed = await ok(v2('pius', 'PATCH', `/mentoring/threads/${thread.id}`, { status: 'closed' }));
    assert.equal(closed.isClosed, true);
    await refused(v2('pius', 'POST', `/mentoring/threads/${thread.id}/messages`, { text: 'Noch was' }), 400, 'invalid');
  });

  test('the songbook through v2: written by whoever may, changed field by field, found by title or words', async () => {
    const song = await ok(v2('owner', 'POST', '/songs', { title: 'Morgenstern', content: '[G]Morgen[D]stern', artist: 'Anna' }));
    assert.deepEqual([song.title, song.artist, song.key], ['Morgenstern', 'Anna', null]);
    const keyed = await ok(v2('owner', 'PATCH', `/songs/${song.id}`, { key: 'G', capo: 2 }));
    assert.deepEqual([keyed.key, keyed.capo, keyed.content, keyed.artist], ['G', 2, '[G]Morgen[D]stern', 'Anna']);
    await refused(v2('max', 'PATCH', `/songs/${song.id}`, { key: 'A' }), 403, 'forbidden');
    assert.equal((await refused(v2('owner', 'PATCH', `/songs/${song.id}`, { title: 'x'.repeat(121) }), 400, 'invalid')).field, 'title');
    assert.deepEqual((await ok(v2('max', 'GET', '/songs?q=morgenstern'))).items.map((entry) => entry.id), [song.id]);
    assert.equal((await ok(v2('max', 'GET', `/songs/${song.id}`))).title, 'Morgenstern');
    assert.equal((await v2('owner', 'DELETE', `/songs/${song.id}`)).status, 204);
    await refused(v2('max', 'GET', `/songs/${song.id}`), 404, 'not_found');
  });

  test('prayer requests through v2: shared with the name or anonymously - then nobody sees who -, extended by their owner, removed', async () => {
    const named = await ok(v2('mia', 'POST', '/prayers', { text: 'Für die Kranken in der Gemeinde', duration: 'week' }));
    assert.deepEqual([named.isAnonymous, named.authorUserId, named.isMine], [false, uids.mia, true]);
    const hidden = await ok(v2('mia', 'POST', '/prayers', { text: 'Für eine schwere Entscheidung', anonymous: true }));
    assert.deepEqual([hidden.isAnonymous, hidden.authorUserId, hidden.authorName], [true, null, null]);
    const forOthers = (await ok(v2('max', 'GET', '/prayers'))).items.find((prayer) => prayer.id === hidden.id);
    assert.deepEqual([forOthers.authorUserId, forOthers.isMine, forOthers.canDelete], [null, false, false]);
    const ownerView = (await ok(v2('owner', 'GET', '/prayers'))).items.find((prayer) => prayer.id === hidden.id);
    assert.equal(ownerView.authorUserId, null, 'anonymous even for the leaders');
    await refused(v2('mia', 'POST', '/prayers', { text: 'x', duration: 'year' }), 400, 'invalid');
    const extended = await ok(v2('mia', 'PATCH', `/prayers/${named.id}`, { extend: 'month' }));
    assert.ok(extended.expiresAt > named.expiresAt);
    await refused(v2('max', 'PATCH', `/prayers/${named.id}`, { extend: 'month' }), 403, 'forbidden');
    await refused(v2('max', 'DELETE', `/prayers/${hidden.id}`), 403, 'forbidden');
    assert.equal((await v2('mia', 'DELETE', `/prayers/${hidden.id}`)).status, 204);
    assert.equal((await ok(v2('max', 'GET', '/prayers'))).items.some((prayer) => prayer.id === hidden.id), false);
  });

  test('media through v2: the library of a Nextcloud folder with the rights Agora decides - read, add, download, delete', async (t) => {
    const status = await ok(v2('max', 'GET', '/media'));
    assert.deepEqual(status, { enabled: false, canManage: false, hasAccess: false });
    await refused(v2('max', 'GET', '/media/items'), 503, 'unavailable');
    await refused(v2('max', 'GET', '/media/rules'), 403, 'forbidden');

    const cloud = await startFakeNextcloud();
    t.after(() => cloud.close());
    cloud.addFile('Agora/willkommen.pdf', '%PDF-1.4 hello', 'application/pdf');
    cloud.addFile('Agora/Fotos/Sommer.jpg', 'jpeg-bytes-0123456789', 'image/jpeg');
    // Set up by an administrator (the instance's settings stay with v1); the rights through v2: everyone reads
    await ok(call('owner', 'PUT', '/api/admin/media-config', { enabled: true, url: cloud.url, user: cloud.user, password: cloud.password, root: 'Agora' }));
    const rights = await ok(v2('owner', 'PUT', '/media/rules', { path: '', groups: { '*': 'read', [`user:${uids.owner}`]: 'write' } }));
    assert.equal(rights.folder.path, '');
    assert.deepEqual(await ok(v2('max', 'GET', '/media')), { enabled: true, canManage: false, hasAccess: true });
    const root = await ok(v2('max', 'GET', '/media/items'));
    assert.deepEqual([root.folder.access, root.folder.path], ['read', '']);
    assert.deepEqual(root.items.map((item) => [item.name, item.isFolder]), [['Fotos', true], ['willkommen.pdf', false]], 'folders first, then files');
    const file = await v2('max', 'GET', '/media/file?path=willkommen.pdf');
    assert.deepEqual([file.status, file.buffer.toString()], [200, '%PDF-1.4 hello']);
    assert.equal((await v2('max', 'GET', '/media/preview?path=Fotos/Sommer.jpg&size=256')).status, 200);
    await refused(v2('max', 'GET', '/media/file?path=../Outside/secret.txt'), 400, 'invalid');
    // Adding: only with write access
    await refused(v2('max', 'POST', '/media/folders', { path: '', name: 'Meins' }), 403, 'forbidden');
    assert.deepEqual(await ok(v2('owner', 'POST', '/media/folders', { path: '', name: 'Neu' })), { name: 'Neu', path: 'Neu' });
    const form = new FormData();
    form.append('files', new Blob(['hallo'], { type: 'text/plain' }), 'gruss.txt');
    const stored = await call('owner', 'POST', '/api/v2/media/files?path=Neu', form, { form: true });
    assert.equal(stored.status, 201);
    assert.deepEqual(stored.body.files, [{ name: 'gruss.txt', path: 'Neu/gruss.txt' }]);
    // Downloaded as one archive, for whoever asked; deleted
    const ticket = await ok(v2('max', 'POST', '/media/downloads', { path: 'Neu', names: ['gruss.txt'] }));
    assert.equal(ticket.files, 1);
    const archive = await call('max', 'GET', ticket.url);
    assert.equal(archive.status, 200);
    assert.equal(archive.buffer.readUInt32LE(0), 0x04034b50, 'a ZIP archive');
    await refused(call('mia', 'GET', ticket.url), 404, 'not_found');
    await refused(v2('max', 'POST', '/media/delete', { path: 'Neu', names: ['gruss.txt'] }), 403, 'forbidden');
    assert.deepEqual(await ok(v2('owner', 'POST', '/media/delete', { path: 'Neu', names: ['gruss.txt'] })), { deleted: ['gruss.txt'], failed: [] });
    await ok(v2('owner', 'PUT', '/media/rules', { path: '', groups: {} }));
    assert.equal((await ok(v2('max', 'GET', '/media'))).hasAccess, false);
    const index = await ok(v2('max', 'GET', ''));
    for (const resource of ['members', 'standing-orders', 'status-changes', 'receipts', 'finance/ledger', 'fresh-starts', 'events', 'duties', 'mentoring/threads', 'songs', 'media/items']) {
      assert.ok(index.resources.includes(resource), resource);
    }
    // /me says what the person may do
    const me = await ok(v2('treasurer', 'GET', '/me'));
    assert.deepEqual([me.can.manageFinances, me.can.viewFinances, me.can.manageEvents], [true, true, false]);
  });

  // --- Who is signed in --------------------------------------------------------------------------------------------

  test('the own account through v2: notifications, time zone and language; the registration code; profile pictures; reports', async () => {
    await account('rita', 'Rita');
    const before = await ok(v2('rita', 'GET', '/me'));
    assert.deepEqual(before.notificationSettings.channels, { push: true, email: false });
    assert.equal(before.can.manageRegistrationCode, false);

    // What a change does not name stays as it was; every value is checked
    const changed = await ok(v2('rita', 'PATCH', '/me', { notificationSettings: { channels: { email: true }, email: { finances: false } }, timeZone: 'Europe/Berlin', language: 'de' }));
    assert.deepEqual(changed.notificationSettings.channels, { push: true, email: true });
    assert.deepEqual([changed.notificationSettings.email.finances, changed.notificationSettings.email.duties, changed.notificationSettings.push.finances], [false, true, true]);
    assert.deepEqual([changed.timeZone, changed.language], ['Europe/Berlin', 'de']);
    const again = await ok(v2('rita', 'GET', '/me'));
    assert.deepEqual([again.notificationSettings.email.finances, again.notificationSettings.channels.email, again.timeZone], [false, true, 'Europe/Berlin']);
    // The old API reads the same choice (the flat keys are the push choice for older apps)
    const v1User = (await ok(call('rita', 'GET', '/api/auth/me'))).user;
    assert.deepEqual([v1User.notificationSettings.channels.email, v1User.notificationSettings.email.finances, v1User.timeZone], [true, false, 'Europe/Berlin']);
    assert.equal((await refused(v2('rita', 'PATCH', '/me', { timeZone: 'Mars/Olympus' }), 400, 'invalid')).field, 'timeZone');
    assert.equal((await refused(v2('rita', 'PATCH', '/me', { notificationSettings: { push: { duties: 'yes' } } }), 400, 'invalid')).field, 'notificationSettings.push.duties');
    await refused(v2('rita', 'PATCH', '/me', { language: 'tlh' }), 400, 'invalid');

    // The registration code: for those who manage it - a new one made by the server replaces the one before
    await refused(v2('rita', 'GET', '/registration-code'), 403, 'forbidden');
    const desk = await ok(call('owner', 'POST', '/api/admin/groups', { name: 'Empfang', permissions: ['manage_registration_code'] }));
    await ok(call('owner', 'PUT', `/api/admin/users/${uids.rita}/groups`, { groups: [desk.id || desk.group?.id] }));
    assert.equal((await ok(v2('rita', 'GET', '/me'))).can.manageRegistrationCode, true);
    const made = await ok(v2('rita', 'POST', '/registration-code'));
    assert.match(made.code, /^\d{6}$/);
    assert.equal((await ok(v2('rita', 'GET', '/registration-code'))).code, made.code);
    assert.equal(await ok(call('rita', 'GET', `/api/db?path=${encodeURIComponent('system/inviteCode')}`)), made.code, 'the code the old API reads');

    // A profile picture: listed with its version, given under its address; only JPEG
    const form = (bytes, type) => {
      const data = new FormData();
      data.append('picture', new Blob([bytes], { type }), 'ich.jpg');
      return data;
    };
    const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
    const uploaded = await ok(call('rita', 'PUT', '/api/v2/me/picture', form(jpeg, 'image/jpeg'), { form: true }));
    assert.equal(uploaded.userId, uids.rita);
    assert.ok(Number.isFinite(uploaded.version));
    const pictures = (await ok(v2('max', 'GET', '/pictures?limit=500'))).items;
    assert.ok(pictures.some((entry) => entry.userId === uids.rita && Number.isFinite(entry.version)));
    const picture = await v2('max', 'GET', `/pictures/${uids.rita}?v=${uploaded.version}`);
    assert.equal(picture.status, 200);
    assert.deepEqual(picture.buffer, jpeg);
    assert.equal((await v2('max', 'GET', `/pictures/${uids.max}`)).status, 204, 'no picture');
    await refused(call('rita', 'PUT', '/api/v2/me/picture', form(PNG, 'image/png'), { form: true }), 400, 'invalid');

    // A report reaches the admins; what it reports is checked, not cut
    assert.equal((await v2('rita', 'POST', '/reports', { type: 'ai', content: 'Eine seltsame Antwort', reason: 'Falsch', prompt: 'Frage' })).status, 204);
    assert.ok((await ok(call('owner', 'GET', '/api/admin/reports'))).reports.some((report) => report.content === 'Eine seltsame Antwort' && report.reportedBy === uids.rita));
    await refused(v2('rita', 'POST', '/reports', { type: 'ai', content: 'x'.repeat(4001) }), 400, 'invalid');
    await refused(v2('rita', 'POST', '/reports', { type: 'spam', content: 'x' }), 400, 'invalid');
    const index = await ok(v2('rita', 'GET', ''));
    for (const resource of ['registration-code', 'pictures', 'me/picture', 'reports']) assert.ok(index.resources.includes(resource), resource);
  });
});

