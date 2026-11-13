// An instance from before the database upgrade, filled the way years of use leave it: most of it through the old
// server's API (the frozen backend in backend/legacy), the rest written straight into PocketBase in the shapes older
// app versions and server versions left behind - amounts as text, entries without ids, groups named instead of
// linked, dates in other spellings, links to accounts that are gone, fields nobody knows any more.
const crypto = require('crypto');
const path = require('path');
const { BACKEND_DIR } = require('./helpers');
const { PASSWORD } = require('./instance');

const legacyStore = require(path.join(BACKEND_DIR, 'legacy', 'pocketbase.js'));

const PEOPLE = [
  // who, first, last, status, memberSince, extra for /api/admin/users
  ['treasurer', 'Theo', 'Kasse', 'vollverdiener', '2019-03-01'],
  ['viewer', 'Vera', 'Einsicht', 'geringverdiener', '2020-07-15'],
  ['max', 'Max', 'Muster', 'vollverdiener', '2021-01-01'],
  ['mia', 'Mia', 'Muster', 'keinverdiener', '2022-09-01'],
  ['mentor', 'Martin', 'Mentor', 'vollverdiener', '2018-01-01'],
  ['mentee', 'Mona', 'Mentee', 'pausiert', '2023-02-01'],
  ['ada', 'Ada', 'Admin', 'vollverdiener', '2017-05-01', { admin: true }]
];

/** The day [days] from today (local), 'YYYY-MM-DD': events people sign up for must lie ahead. */
const future = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const months = (from, to) => {
  const list = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    list.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return list;
};

/**
 * Fills the instance behind [http] (a client of the frozen backend, not set up yet). [su]: superuser access to its
 * PocketBase. Returns what the recording needs to know (ids of people, events, threads, ...).
 */
async function seedOldInstance({ http, su: getSu }) {
  const { call, ok, login, tokens, uids } = http;
  const facts = { people: {}, groups: {}, events: [], threads: [], polls: [], songs: [], requests: [] };

  // --- Setup, groups, accounts (through the API) ---
  const setup = await ok(call(null, 'POST', '/api/setup', {
    appName: 'Gemeinde vor dem Umbau',
    adminUser: { firstName: 'Olga', lastName: 'Owner', email: 'owner@test.local', password: PASSWORD, memberSince: '2016-01-01' }
  }));
  tokens.owner = setup.token;
  uids.owner = setup.user.id || setup.user.uid;
  const su = await getSu();

  const group = async (name, permissions) => {
    const created = await ok(call('owner', 'POST', '/api/admin/groups', { name, permissions }));
    facts.groups[name] = created.id || created.group?.id;
    return facts.groups[name];
  };
  await group('Kasse', ['manage_finances']);
  await group('Einsicht', ['view_finances']);
  await group('Technik', ['manage_events']);
  await group('Jugend', []);
  await group('Lobpreis', ['manage_songbook', 'manage_prayers']);
  await group('Altgruppe', []);

  for (const [who, firstName, lastName, status, memberSince, extra = {}] of PEOPLE) {
    await ok(call('owner', 'POST', '/api/admin/users', {
      firstName, lastName, email: `${who}@test.local`, password: PASSWORD, pays: true, admin: false, status, memberSince, ...extra
    }));
    await login(who, `${who}@test.local`);
    facts.people[who] = uids[who];
  }
  // An account nobody has claimed yet (a member in the books without a login of their own)
  await ok(call('owner', 'POST', '/api/admin/users', { firstName: 'Paul', lastName: 'Papier', pays: true, status: 'geringverdiener', memberSince: '2015-05-01' }));
  const setGroups = (who, names) => ok(call('owner', 'PUT', `/api/admin/users/${uids[who]}/groups`, { groups: names.map((name) => facts.groups[name]) }));
  await setGroups('treasurer', ['Kasse']);
  await setGroups('viewer', ['Einsicht', 'Jugend']);
  await setGroups('max', ['Jugend', 'Technik']);
  await setGroups('mia', ['Jugend', 'Lobpreis']);
  await setGroups('mentor', ['Altgruppe']);
  // The group is deleted later: events and duties still name it (see below)
  await ok(call('owner', 'PUT', `/api/admin/users/${uids.mentee}/member-since`, { memberSince: '2023-03-15' })).catch(() => {});

  // --- The books (through the API, like the web app writes them) ---
  const person = async (key) => (await ok(call('treasurer', 'GET', `/api/db?path=people/${key}&raw=1`)));
  const mutate = async (key, change) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await person(key);
      const res = await call('treasurer', 'POST', '/api/db/transaction', { path: `people/${key}`, currentVersion: current.version, value: change(current.value) });
      if (res.status === 200) return res.body;
      if (res.status !== 409) throw new Error(`transaction ${key}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    throw new Error(`transaction ${key} kept conflicting`);
  };
  let payId = 1700000000000;
  const pay = (amount, date, description = 'Beitrag') => ({ amount, date, description, id: (payId += 7919) });
  await mutate(uids.max, (p) => ({ ...p, payments: [...(p.payments || []), ...months('2021-01', '2026-06').map((m) => pay(50, `${m}-03`))] }));
  await mutate(uids.mia, (p) => ({ ...p, payments: [...(p.payments || []), pay(120, '2023-01-10', 'Jahresbeitrag'), pay(119.99, '2024-01-12', 'Jahresbeitrag'), pay(0.1, '2024-02-01', 'Cent-Test'), pay(0.2, '2024-02-02', 'Cent-Test')] }));
  await mutate(uids.viewer, (p) => ({ ...p, payments: [...(p.payments || []), ...months('2024-01', '2025-12').map((m, i) => pay(i % 5 === 0 ? 75 : 25, `${m}-15`, i % 5 === 0 ? 'Nachzahlung' : 'Beitrag'))] }));
  await mutate(uids.treasurer, (p) => ({
    ...p,
    payments: [...(p.payments || []), pay(600, '2025-01-02', 'Jahr 2025'), pay(-50, '2025-02-01', 'Korrektur')],
    standingOrders: [{ id: 'so-treasurer', amount: 50, startDate: '2026-01-01', note: 'Dauerauftrag', lastAutoPayment: null }]
  }));
  // Ids as the web app makes them for standing orders (and other clients for entries): the time as text, "1771345242762".
  // PocketBase reads such a string in a json field as a number - the new tables have to give back the text
  await mutate(uids.mia, (p) => ({
    ...p,
    payments: [...(p.payments || []), { amount: 20, date: '2025-05-05', description: 'Beitrag', id: '1746403200000' }],
    standingOrders: [{ id: '1771345242762', amount: 25, startDate: '2026-02-01', note: 'Dauerauftrag', lastAutoPayment: null }]
  }));
  await mutate(uids.mentor, (p) => ({
    ...p,
    status: 'geringverdiener',
    statusHistory: [{ status: 'vollverdiener', startDate: '2018-01-01', endDate: '2024-06-01' }, { status: 'geringverdiener', startDate: '2024-06-01' }],
    payments: [...(p.payments || []), ...months('2023-01', '2026-03').map((m) => pay(m < '2024-06' ? 50 : 25, `${m}-28`))]
  }));

  // Donations and expenses as whole lists (the web app writes them like this)
  await ok(call('treasurer', 'PUT', '/api/db', { path: 'expenses', value: [
    { id: 1710000000001, amount: 89.9, description: 'Beamer-Lampe', issuer: 'Theo Kasse', date: '2024-03-04' },
    { id: 1710000000002, amount: 12.5, description: 'Kerzen', issuer: 'Mia Muster', date: '2025-12-01', receipt: 'beleg-kerzen.png' },
    { id: '1760090000000', amount: 7.2, description: 'Briefmarken', issuer: 'Theo Kasse', date: '2025-10-10' }
  ] }));

  // Requests from members, one decided each way
  const request = async (who, type, data, status) => {
    const id = crypto.randomUUID();
    const value = { id, type, userId: uids[who], personId: uids[who], personName: who, data, status: 'pending', timestamp: Date.now() - 86400000 };
    await ok(call(who, 'PUT', '/api/db', { path: `requests/${id}`, value }));
    if (status !== 'pending') await ok(call('treasurer', 'PATCH', '/api/db', { path: `requests/${id}`, value: { ...value, status } }));
    facts.requests.push(id);
    return id;
  };
  await request('max', 'payment', { amount: '30', date: '2026-07-01', note: 'Bar gegeben' }, 'pending');
  await request('mia', 'expense', { amount: '45.5', description: 'Bastelmaterial', date: '2026-06-20' }, 'approved');
  await request('viewer', 'status', { newStatus: 'keinverdiener', date: '2026-08-01' }, 'rejected');
  await request('max', 'standing_order', { amount: '50', date: '2026-09-01', note: 'Ab September' }, 'pending');

  // The fees over time: a change from a month in the past, one to come, a fresh start - and an older app saving fees
  const fee = async (from, fees) => {
    const preview = await ok(call('owner', 'POST', '/api/admin/fees/preview', { from, fees }));
    await ok(call('owner', 'POST', '/api/admin/fees', { from, fees, version: preview.version }));
  };
  await fee('2024-01', { vollverdiener: 55, geringverdiener: 25, keinverdiener: 10 });
  await fee('2027-01', { vollverdiener: 60, geringverdiener: 30, keinverdiener: 10 });
  await ok(call('owner', 'POST', '/api/admin/fee-reset', { date: '2025-01-01', confirmDate: '2025-01-01', password: PASSWORD }));
  const settings = await ok(call('owner', 'GET', '/api/db?path=settings'));
  await ok(call('owner', 'PUT', '/api/db', { path: 'settings', value: { ...settings, reportStartDate: '2025-01-01', waehrung: 'EUR' } }));

  // --- Events (through the API) ---
  const event = async (who, body) => {
    const created = await ok(call(who, 'POST', '/api/events', body));
    const id = created.id || created.event?.id || created.events?.[0]?.id;
    facts.events.push(id);
    return id;
  };
  const youth = await event('owner', {
    title: 'Jugendabend', date: future(7), startTime: '19:00', endTime: '21:30', location: 'Saal', description: '<p>Mit <b>Pizza</b></p>',
    targetGroups: ['Jugend'], requiresRegistration: true, maxParticipants: 2,
    duties: [
      { roleName: 'Technik', section: 'Ablauf', assignedGroup: facts.groups.Technik },
      { roleName: 'Kasse', assignedUser: uids.treasurer },
      { roleName: 'Musik', requestedUser: uids.mia },
      { roleName: 'Aufräumen' }
    ]
  });
  await event('owner', { title: 'Gottesdienst', date: future(9), startTime: '10:00', isRecurring: true, recurringRule: 'weekly', recurringCount: 3, eventType: 'termin', isPinned: true });
  const open = await event('max', { title: 'Grillen', date: future(30), endDate: future(31), location: 'Garten', requiresRegistration: true });
  for (const who of ['max', 'mia', 'viewer']) await ok(call(who, 'POST', `/api/events/${youth}/register`, { action: 'register' }));
  await ok(call('viewer', 'POST', `/api/events/${youth}/register`, { action: 'cancel' }));
  await ok(call('mia', 'POST', `/api/events/${open}/register`, { action: 'register' }));
  const shared = await ok(call('owner', 'PATCH', `/api/events/${youth}`, { isPublic: true }));
  const token = shared.publicToken || shared.event?.publicToken || (await ok(call('owner', 'GET', '/api/events'))).events?.find?.((e) => e.id === youth)?.publicToken;
  facts.publicToken = token;
  if (token) await ok(call(null, 'POST', `/api/public/events/${token}/register`, { name: 'Gina Gast', email: 'gina@example.org', age: 17, language: 'de' }));

  // --- Songbook, order of service, prayers, polls (through the API) ---
  const song = await ok(call('mia', 'POST', '/api/songs', { title: 'Amazing Grace', artist: 'John Newton', key: 'G', capo: 2, tempo: 72, ccli: '22025', copyright: 'Public Domain', content: '{title: Amazing Grace}\n[G]Amazing [C]grace' }));
  const songId = song.id || song.song?.id;
  facts.songs.push(songId);
  const song2 = await ok(call('mia', 'POST', '/api/songs', { title: 'Ohne Tempo', key: '', content: 'Text ohne Akkorde', capo: 0 }));
  facts.songs.push(song2.id || song2.song?.id);
  await ok(call('owner', 'PUT', `/api/events/${youth}/program`, { items: [
    { title: 'Begrüßung', minutes: 5, who: 'Olga' },
    { title: '', songId, songKey: 'A', minutes: 0 },
    { title: 'Andacht', minutes: null, note: 'Thema: Mut' }
  ] }));
  await ok(call('max', 'POST', '/api/prayers', { text: 'Bitte betet für die Prüfung', duration: 'week' }));
  await ok(call('mia', 'POST', '/api/prayers', { text: 'Für meine Familie', anonymous: true, duration: 'quarter' }));
  const poll = await ok(call('max', 'POST', '/api/polls', { title: 'Ausflugsziel?', options: ['Berge', 'See', 'Stadt'], endsAt: Date.now() + 10 * 86400000 }));
  const pollId = poll.id || poll.poll?.id;
  facts.polls.push(pollId);
  const pollNow = await ok(call('max', 'GET', '/api/polls'));
  const options = (Array.isArray(pollNow) ? pollNow : pollNow.polls || []).find((p) => p.id === pollId)?.options || [];
  for (const [who, i] of [['max', 0], ['mia', 1], ['viewer', 0]]) if (options[i]) await ok(call(who, 'POST', `/api/polls/${pollId}/vote`, { optionIds: [options[i].id] }));
  // A poll ended early with too few votes: its tallies are gone for good (null)
  const sealed = await ok(call('mia', 'POST', '/api/polls', { title: 'Schon vorbei?', options: ['Ja', 'Nein'], multiple: true, endsAt: Date.now() + 3600000 }));
  await ok(call('mia', 'POST', `/api/polls/${sealed.id || sealed.poll?.id}/close`));
  facts.polls.push(sealed.id || sealed.poll?.id);

  // --- Mentoring (through the API) ---
  const profile = await ok(call('mentor', 'POST', '/api/mentoring/apply', { bio: 'Ich höre zu.', maxMentees: 2 }));
  const mentorRecordId = profile.id || profile.profile?.id || profile.mentor?.id;
  if (mentorRecordId) await ok(call('owner', 'POST', `/api/mentoring/manage/${mentorRecordId}/status`, { status: 'approved' }));
  const thread = await ok(call('mentee', 'POST', '/api/mentoring/threads', { mentorId: uids.mentor, initialMessage: 'Hallo, ich hätte eine Frage.' }));
  const threadId = thread.threadId || thread.id || thread.thread?.id;
  facts.threads.push(threadId);
  if (threadId) {
    await ok(call('mentor', 'POST', `/api/mentoring/threads/${threadId}/messages`, { text: 'Gern, was beschäftigt dich?' }));
    await ok(call('mentee', 'POST', `/api/mentoring/threads/${threadId}/messages`, { text: 'Es geht um meine Arbeit.' }));
  }
  facts.mentorRecordId = mentorRecordId;

  // --- Push devices, reports, AI, media, calendar (through the API) ---
  await ok(call('max', 'POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/max-phone', keys: { p256dh: 'BMaxPublicKey', auth: 'maxAuth' } }, installed: true, userAgent: 'Phone' }));
  await ok(call('mia', 'POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/mia-tab', keys: { p256dh: 'BMiaPublicKey', auth: 'miaAuth' } }, installed: false, userAgent: 'Tab' }));
  await ok(call('mia', 'POST', '/api/push/fcm/subscribe', { token: 'fcm-token-mia', platform: 'android' }));
  await ok(call('max', 'POST', '/api/reports', { type: 'ai', content: 'Eine falsche Antwort', reason: 'stimmt nicht', prompt: 'Wer zahlt?' }));
  if (threadId) await ok(call('mentee', 'POST', '/api/reports', { type: 'chat', content: 'Unfreundlich', reason: 'Ton', threadId }));
  await ok(call('owner', 'PUT', '/api/admin/ai-config', { enabled: false, baseUrl: 'https://ai.example/v1', apiKey: 'sk-test-geheim', model: 'klein' }));
  await call('owner', 'PUT', '/api/admin/media-config', { enabled: true, url: 'https://cloud.example.org', user: 'agora-bot', password: 'media-geheim', root: 'Gemeinde/Medien' });
  await ok(call('max', 'GET', '/api/user/calendar-feed'));
  await ok(call('owner', 'GET', '/api/push/vapid-public-key')).catch(() => {});

  // --- Written straight into PocketBase, the way older versions left it ---
  const paymentsOf = async (key) => su.list('payments', `personKey = "${key}"`);
  // Payments in every spelling the server ever read: text amounts, an unreadable one, a fraction of a cent, no id,
  // ids as text, dates as timestamps or in another spelling, no date at all
  const oddPayments = [
    { amount: '50,00', date: '2020-02-03', description: 'als Text', id: 'pay-text-1' },
    { amount: '1.234,50', date: '2020-03-03', description: 'mit Tausenderpunkt', id: 'pay-text-2' },
    { amount: 'fünfzig', date: '2020-04-03', description: 'unlesbar', id: 'pay-text-3' },
    { amount: 33.333, date: '2020-05-03', description: 'Bruchteil eines Cents' },
    { amount: '70', date: '2020-06-03T00:00:00.000Z', description: 'Zeitstempel' },
    { amount: 25, date: '07/15/2020', description: 'andere Schreibweise', id: 1594771200000 },
    { amount: 10, description: 'ohne Datum', id: 'pay-ohne-datum' },
    { amount: 5, date: '2020-08-01', isAuto: false, receipt: 'alt.pdf', id: 'pay-mit-beleg' }
  ];
  const paulKey = (await su.list('people', 'name = "Paul Papier"'))[0]?.personKey;
  const existingPaul = paulKey ? await paymentsOf(paulKey) : [];
  for (const [index, payment] of oddPayments.entries()) {
    await su.create('payments', legacyStore.buildPaymentRecordPayload(paulKey, payment, existingPaul.length + index));
  }
  // Status history entries as an old app wrote them back: no ids, the server's month numbers stored along, a status
  // nobody knows
  await su.create('status_history', legacyStore.buildStatusHistoryRecordPayload(paulKey, { status: 'geringverdiener', startDate: '2015-05-01', endDate: '2020-01-01', startTotal: 24184, endTotal: 24240 }, 0));
  await su.create('status_history', legacyStore.buildStatusHistoryRecordPayload(paulKey, { status: 'student', startDate: '2020-01-01' }, 1));
  // The member record itself: the list columns and the record's own copy disagree, an app left its computed fields
  // and fields of its own in it
  const paul = (await su.list('people', `personKey = "${paulKey}"`))[0];
  await su.update('people', paul.id, {
    name: 'Paul Papier (alt)',
    data: {
      ...paul.data,
      name: 'Paul Papier',
      notes: 'Zahlt bar',
      telefon: '0123 456',
      _paidUntil: '2019-01-31T00:00:00.000Z',
      _statusMeta: { text: 'Zahlung überfällig', isOverdue: true },
      _eigenesFeld: 'bleibt',
      standingOrders: [{ id: 1600000000000, amount: '25,50', startDate: '2026-02-01', note: 'Alt-Dauerauftrag' }]
    }
  });
  // A member from long ago without pays / originalMemberSince, and a deleted one
  await su.create('people', legacyStore.buildPersonRecordPayload('-NalteMitgliedXY', { id: '-NalteMitgliedXY', name: 'Erna Früher', status: 'vollverdiener', memberSince: '2012-04-01', standingOrders: [] }));
  await su.create('payments', legacyStore.buildPaymentRecordPayload('-NalteMitgliedXY', { amount: 40, date: '2013-01-01', description: 'Bar', id: 1357000000000 }, 0));
  // Her list column says another name than her record (an older app edited one of them): nothing rewrites her record
  // when the old server starts (no standing order), so the upgrade meets the disagreement
  const erna = (await su.list('people', 'personKey = "-NalteMitgliedXY"'))[0];
  await su.update('people', erna.id, { name: 'Erna F.', status: 'geringverdiener' });
  // Payments of a member whose record is gone (an old deletion): never shown, kept by the upgrade
  await su.create('payments', legacyStore.buildPaymentRecordPayload('verschwunden-1', { amount: 12, date: '2014-06-01', description: 'Ohne Mitglied', id: 'orphan-pay' }, 0));
  await su.create('people', { personKey: 'geloescht-1', uid: '', name: 'Gerd Gelöscht', status: '', memberSince: '', originalMemberSince: '', totalPaid: 15, data: { id: 'geloescht-1', name: 'Gerd Gelöscht', isDeleted: true } });
  await su.create('payments', legacyStore.buildPaymentRecordPayload('geloescht-1', { amount: 15, date: '2019-01-01', description: 'Spende als Beitrag', id: 'gerd-pay' }, 0));

  // Donations as the very first versions kept them: a map by id, amounts as text
  const donations = (await su.list('app_state', 'key = "donations"'))[0];
  await su.update('app_state', donations.id, { value: {
    '-Nspende1': { id: '-Nspende1', amount: '100,00', name: 'Anonym', date: '2019-12-24', description: 'Weihnachten' },
    '-Nspende2': { amount: 250, name: 'Familie Gut', date: '2024-05-01' },
    '-Nspende3': { id: 3, amount: 20.5, name: 'Kollekte', date: '2026-01-06', description: '', zweck: 'Orgel' }
  } });
  // An expense without an id and with a text amount (its key was worked out from its content)
  await su.create('expenses', legacyStore.buildExpenseRecordPayload({ amount: '19,99', description: 'Porto', issuer: 'Vera Einsicht', date: '2021-02-02' }, 7));
  // A request from an older app: amount as typed, a kind of request this version does not know
  const oldRequestValue = { id: 'old-request-1', type: 'refund', userId: uids.mia, personId: uids.mia, personName: 'Mia Muster', status: 'pending', timestamp: 1600000000000, data: { amount: '1.234,50', date: '2020-09-13', grund: 'Fahrt' } };
  await su.create('requests', { requestKey: 'old-request-1', userId: uids.mia, personId: uids.mia, personName: 'Mia Muster', type: 'refund', status: 'pending', timestamp: 1600000000000, data: oldRequestValue });

  // Songbook and prayer requests as older versions or hand edits left them: a song of an older app (capo and a time
  // as text, a field of its own, no CCLI fields), one under a key that is no id (never reachable, still listed), a
  // record without data, a prayer request of an account that is gone
  await su.create('songs', { key: 'alt-lied-1', data: { id: 'alt-lied-1', title: 'Großer Gott', artist: '', key: 'F', capo: '2', tempo: null, content: '[F]Großer Gott, wir loben dich', createdAt: '2019-05-01T10:00:00.000Z', updatedAt: 1556704800000, tonart: 'F-Dur' } });
  await su.create('songs', { key: 'kein gültiger Schlüssel', data: { id: 'unerreichbar', title: 'Unerreichbar', content: 'Nur in der Liste' } });
  await su.create('songs', { key: 'leer-1', data: null });
  await su.create('prayers', { key: 'alt-gebet-1', data: { id: 'alt-gebet-1', text: 'Für die Gemeinde', anonymous: false, authorUid: 'deadbeefdeadbee', authorName: 'Ehemalig', owner: 'f'.repeat(64), createdAt: Date.now() - 86400000, expiresAt: Date.now() + 20 * 86400000 } });

  // Accounts: groups by name and as objects, notification settings of an older app, a display name that went stale
  const userRecord = async (who) => (await su.list('users', `id = "${uids[who]}"`))[0];
  await su.update('users', uids.max, { groups: ['Jugend', facts.groups.Technik] });
  await su.update('users', uids.mia, { groups: [{ id: facts.groups.Jugend, name: 'Jugend' }, facts.groups.Lobpreis] });
  await su.update('users', uids.viewer, { notificationSettings: { duties: true, events: false, messages: true, push: true } });
  await su.update('users', uids.mentee, { notificationSettings: null, emailNotifications: false, name: 'Mona M. (alt)' });
  facts.staleUser = (await userRecord('mentee')).id;

  // Events: a group that was deleted since (its name stays), an organiser whose account is gone, a series id, a kind
  // of event this version does not know, a time without milliseconds
  const oldEvent = await su.create('events', {
    title: 'Altes Treffen', date: '2025-03-01', startTime: '18:00', status: 'cancelled', eventType: 'gottesdienst', targetGroups: ['Altgruppe', 'Unbekannt'],
    createdBy: 'deadbeefdeadbee', created: '2025-01-01T10:00:00Z', updated: '2025-01-02T11:00:00Z', seriesId: 'series-1', isRecurring: true, recurringRule: 'monthly'
  });
  facts.events.push(oldEvent.id);
  await su.create('event_duties', { event: oldEvent.id, roleName: 'Ordner', section: '', assignedGroup: 'Technik', status: 'assigned', created: '2025-01-01T10:00:00.000Z', updated: '2025-01-01T10:00:00.000Z', reminded: { [uids.max]: '2025-03-01 18:00' } });
  await su.create('event_registrations', { event: oldEvent.id, user: uids.mia, status: 'cancelled', created: '2025-01-05T09:00:00.000Z', updated: '2025-01-06T09:00:00.000Z' });
  // A conversation from before conversations named the mentor's account: it names the mentor record
  if (mentorRecordId && threadId) {
    await su.create('mentoring_threads', { mentor: mentorRecordId, mentee: uids.max, mentee_alias: 'Suchender #7', status: 'closed', last_message: '', created: '2024-01-01T00:00:00.000Z', updated: '2024-02-01T00:00:00.000Z' });
  }
  // Reports by an account that is gone, folder rights for a group and an account that are gone
  const reports = (await su.list('app_state', 'key = "content_reports"'))[0];
  if (reports) await su.update('app_state', reports.id, { value: [...reports.value, { id: crypto.randomUUID(), type: 'ai', content: 'Alt', reason: '', prompt: 'Frage', threadId: '', reportedBy: 'deadbeefdeadbee', reporterName: 'Ehemalig', created: 1600000000000, status: 'resolved', resolved: 1600000500000 }] });
  await su.create('app_state', { key: 'media_rules', value: { rules: { '': { '*': 'read' }, Fotos: { [facts.groups.Jugend]: 'write', [`user:${uids.max}`]: 'hide', deadgroupdeadgr: 'read' } } } })
    .catch(async () => {
      const rules = (await su.list('app_state', 'key = "media_rules"'))[0];
      await su.update('app_state', rules.id, { value: { rules: { '': { '*': 'read' }, Fotos: { [facts.groups.Jugend]: 'write', [`user:${uids.max}`]: 'hide', deadgroupdeadgr: 'read' } } } });
    });
  // Leftovers: the event settings of an older version, the old place of the expenses
  await su.create('app_state', { key: 'event_settings', value: { allowMemberCreation: true, defaultDuties: ['Technik', 'Kasse'] } });
  const push = (await su.list('push_subscriptions', `user = "${uids.mia}"`))[0];
  if (push) await su.update('push_subscriptions', push.id, { created: '2024-01-01T00:00:00.000Z' });

  // The group is deleted: its events and duties keep naming it, the way an older version left them
  await ok(call('owner', 'DELETE', `/api/admin/groups/${facts.groups.Altgruppe}`));
  facts.paulKey = paulKey;
  return facts;
}

module.exports = { seedOldInstance, PEOPLE };
