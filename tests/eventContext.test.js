// The AI sees events like the asking person: own and target-group events only, duty roster and order of
// service only where the person may see them, no attendee names.
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
  { id: 'ev4', title: 'Jugend', eventType: 'termin', date: day(8), createdBy: 'olga', targetGroups: [] }
];
const duties = [
  { id: 'd1', event: 'ev1', roleName: 'Grill', assignedUser: 'max', status: 'assigned' },
  { id: 'd2', event: 'ev1', roleName: 'Technik', assignedUser: 'mia', status: 'assigned' },
  { id: 'd3', event: 'ev4', roleName: 'Musik', assignedUser: 'mia', status: 'assigned' }
];
const registrations = [
  { event: 'ev1', user: 'max', status: 'registered' },
  { event: 'ev1', user: 'mia', status: 'registered' }
];
const programs = { ev1: { items: [{ title: '', songId: 's1', songKey: 'G', minutes: 5, who: 'Band' }, { title: 'Begrüßung', minutes: 3 }] }, ev4: { items: [{ title: 'Andacht', minutes: 10 }] } };

stub('pocketbase', {
  listEvents: async () => events,
  listEventRegistrations: async () => registrations,
  listEventDuties: async () => duties,
  listUserRecords: async () => [{ id: 'olga', name: 'Olga Owner' }, { id: 'max', name: 'Max Mitglied' }, { id: 'mia', name: 'Mia Mentorin' }],
  listGroupRecords: async () => [{ id: 'lead', name: 'Leitung' }]
});
stub('context', {
  userMatchesTargetGroups: (user, groups = []) => !groups.length || groups.some(g => (user.groups || []).includes(g)),
  canUserAccessEventDutyPlan: (user, ev, evDuties) => ev.createdBy === user.uid || evDuties.some(d => d.assignedUser === user.uid)
});
stub('itemStore', {
  createItemStore: name => ({
    get: async (_cfg, key) => (name === 'event_programs' ? programs[key] || null : null),
    list: async () => (name === 'songs' ? [{ id: 's1', title: 'Amazing Grace' }] : [])
  })
});

const { buildEventContext } = require(path.join(backend, 'eventContext'));

test('a member sees open events, their own registration and duty, the roster only where they serve', async () => {
  const list = await buildEventContext({}, { uid: 'max', groups: [] });
  assert.deepEqual(list.map(e => e.title), ['Sommerfest', 'Jugend'], 'no group event, nothing older than two weeks');
  const fest = list[0];
  assert.equal(fest.location, 'Stadtpark');
  assert.equal(fest.description, 'Grillen & Spiele');
  assert.equal(fest.organizer, 'Olga Owner');
  assert.deepEqual(fest.registration, { registered: 2, maxParticipants: 2, full: true, waitlist: 0, me: 'registered' });
  assert.deepEqual(fest.myDuty, { role: 'Grill', status: 'assigned' });
  assert.equal(fest.dutyRoster.length, 2);
  assert.deepEqual(fest.orderOfService[0], { item: 'Amazing Grace', song: true, key: 'G', minutes: 5, who: 'Band' });
  const jugend = list[1];
  assert.equal(jugend.dutyRoster, undefined, 'no roster where the member has no duty');
  assert.equal(jugend.orderOfService, undefined);
});

test('group events show up for group members; attendee names never do', async () => {
  const list = await buildEventContext({}, { uid: 'mia', groups: ['lead'] });
  assert.ok(list.some(e => e.title === 'Leitungsrunde' && e.forGroups[0] === 'Leitung'));
  const fest = list.find(e => e.title === 'Sommerfest');
  assert.equal(JSON.stringify(fest.registration).includes('Max'), false);
});

test('without a user there is nothing', async () => {
  assert.deepEqual(await buildEventContext({}, null), []);
});
