// The AI sees events like the asking person: own and target-group events only, duty roster and order of
// service only where the person may see them, no attendee names. Only the data layer is stubbed - the
// permission rules are the real ones (eventAccess.js, shared with the events routes).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backend = path.join(__dirname, '..', 'backend');
const stub = (name, exports) => {
  const file = require.resolve(path.join(backend, name));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const day = offset => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const events = [
  { id: 'ev1', title: 'Sommerfest', eventType: 'event', date: day(3), startTime: '15:00', endTime: '18:00', location: 'Stadtpark', createdBy: 'olga', targetGroups: [], description: '<p>Grillen &amp; Spiele</p>', requiresRegistration: true, maxParticipants: 2 },
  { id: 'ev2', title: 'Leitungsrunde', eventType: 'termin', date: day(5), startTime: '19:00', createdBy: 'olga', targetGroups: ['lead'] },
  { id: 'ev3', title: 'Altes Treffen', eventType: 'termin', date: day(-40), createdBy: 'olga', targetGroups: [] },
  { id: 'ev4', title: 'Jugend', eventType: 'termin', date: day(8), createdBy: 'olga', targetGroups: [] },
  { id: 'ev5', title: 'Lobpreisabend', eventType: 'event', date: day(10), createdBy: 'olga', targetGroups: [] }
];
const duties = [
  { id: 'd1', event: 'ev1', roleName: 'Grill', assignedUser: 'max', status: 'assigned' },
  { id: 'd2', event: 'ev1', roleName: 'Technik', assignedUser: 'mia', status: 'assigned' },
  { id: 'd3', event: 'ev4', roleName: 'Musik', assignedUser: 'mia', status: 'assigned' },
  { id: 'd4', event: 'ev5', roleName: 'Band', assignedGroup: 'band', status: 'assigned' },
  { id: 'd5', event: 'ev4', roleName: 'Kuchen', requestedUser: 'tom', status: 'open' }
];
const registrations = [
  { event: 'ev1', user: 'max', status: 'registered' },
  { event: 'ev1', user: 'mia', status: 'registered' }
];
// Signed up without an account through the event's share link
const guests = [{ event: 'ev1', name: 'Gina Gast', email: 'gina@example.org', age: 41, status: 'waitlist' }];
const programs = {
  ev1: { items: [{ title: '', songId: 's1', songKey: 'G', minutes: 5, who: 'Band' }, { title: 'Begrüßung', minutes: 3 }] },
  ev4: { items: [{ title: 'Andacht', minutes: 10 }] },
  ev5: { items: [{ title: 'Lobpreis', minutes: 30 }] }
};

stub('pocketbase', {
  listEvents: async () => events,
  listEventRegistrations: async () => registrations,
  listEventGuests: async () => guests,
  listEventDuties: async () => duties,
  listUserRecords: async () => [{ id: 'olga', name: 'Olga Owner' }, { id: 'max', name: 'Max Mitglied' }, { id: 'mia', name: 'Mia Mentorin' }],
  listGroupRecords: async () => [{ id: 'lead', name: 'Leitung' }, { id: 'band', name: 'Band' }]
});
stub('itemStore', {
  createItemStore: name => ({
    get: async (_cfg, key) => (name === 'event_programs' ? programs[key] || null : null),
    list: async () => (name === 'songs' ? [{ id: 's1', title: 'Amazing Grace' }] : [])
  })
});

const { buildEventContext } = require(path.join(backend, 'eventContext'));
const titles = list => list.map(e => e.title);
const byTitle = (list, title) => list.find(e => e.title === title);

test('a member gets open upcoming events with their own registration and duty', async () => {
  const list = await buildEventContext({}, { uid: 'max', groups: [] });
  assert.ok(titles(list).includes('Sommerfest'));
  assert.ok(titles(list).includes('Jugend'));
  const fest = byTitle(list, 'Sommerfest');
  assert.equal(fest.location, 'Stadtpark');
  assert.equal(fest.description, 'Grillen & Spiele', 'plain text, no markup');
  assert.equal(fest.organizer, 'Olga Owner');
  assert.equal(fest.registration.me, 'registered');
  assert.equal(fest.registration.full, true);
  assert.equal(fest.registration.waitlist, 1, 'guests without an account wait in line too');
  assert.equal(fest.myDuty.role, 'Grill');
});

test('the AI never tells a member about an event of a group they are not in, or about old events', async () => {
  const list = await buildEventContext({}, { uid: 'max', groups: [] });
  assert.equal(titles(list).includes('Leitungsrunde'), false);
  assert.equal(titles(list).includes('Altes Treffen'), false, 'nothing older than two weeks');
  const lead = await buildEventContext({}, { uid: 'mia', groups: ['lead'] });
  assert.equal(byTitle(lead, 'Leitungsrunde').forGroups[0], 'Leitung', 'group members do get it, with the group name');
});

test('the AI never shows a duty roster or order of service the member may not see', async () => {
  const list = await buildEventContext({}, { uid: 'max', groups: [] });
  const fest = byTitle(list, 'Sommerfest');
  assert.ok(fest.dutyRoster.length > 0, 'serving at the event: the roster is there');
  assert.equal(fest.orderOfService[0].item, 'Amazing Grace', 'songs by their title');
  for (const title of ['Jugend', 'Lobpreisabend']) {
    const ev = byTitle(list, title);
    assert.equal(ev.dutyRoster, undefined, `no roster for ${title}`);
    assert.equal(ev.orderOfService, undefined, `no order of service for ${title}`);
  }
});

test('the roster follows the real access rules: asked people, assigned groups and event managers see it', async () => {
  const asked = byTitle(await buildEventContext({}, { uid: 'tom', groups: [] }), 'Jugend');
  assert.ok(asked.dutyRoster, 'asked for a duty');
  const band = byTitle(await buildEventContext({}, { uid: 'ben', groups: ['band'] }), 'Lobpreisabend');
  assert.ok(band.dutyRoster && band.orderOfService, 'member of the assigned group');
  const manager = await buildEventContext({}, { uid: 'eva', groups: [], canManageEvents: true });
  assert.ok(titles(manager).includes('Leitungsrunde'), 'managers see group events');
  assert.ok(byTitle(manager, 'Jugend').dutyRoster, 'and every roster');
});

test('attendee names never reach the AI', async () => {
  for (const user of [{ uid: 'max', groups: [] }, { uid: 'eva', groups: [], canManageEvents: true }]) {
    const fest = byTitle(await buildEventContext({}, user), 'Sommerfest');
    const text = JSON.stringify(fest.registration);
    assert.equal(text.includes('Max') || text.includes('Mia'), false);
    assert.equal(/Gina|gina@|41/.test(JSON.stringify(fest)), false, 'nor who a guest is');
  }
});

test('without a user there is nothing', async () => {
  assert.deepEqual(await buildEventContext({}, null), []);
});
