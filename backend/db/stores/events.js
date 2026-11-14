// Events, sign-ups, guests, the duty roster and the order of service in the new structure, behind the functions the
// server has always used for them: every record comes back exactly as the old tables gave it - all fields, the same
// values (codecs/events.js) - so the routes, the places, the reminders and the calendar work unchanged.
//
// Writes keep the old tables' rules: unknown fields are ignored, a value is read the way PocketBase read it for the
// old field's type (a number sent as text is a number), a required field must not be empty. A change reads the
// record, applies the change and writes it back, in the record's own queue: two changes at the same moment never
// overwrite each other.
const client = require('../client');
const codecs = require('../codecs/events');
const { isPlainObject } = require('../codec');
const { table } = require('../tables');
const { queueRecordWrite } = require('../writeQueue');
const links = require('../links');
const { recordStore, linkContextOf, existingIds, without, originalOf, has } = require('./oldTables');

const isValidKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(key);
const now = () => new Date().toISOString();

// --- The old tables: their fields (in their order), types and required fields (what PocketBase checked) -----------

const OLD_FIELDS = {
  events: [['title', 'text', true], ['date', 'text', true], ['startTime', 'text'], ['endTime', 'text'], ['location', 'text'], ['description', 'text'],
    ['isRecurring', 'bool'], ['recurringRule', 'text'], ['seriesId', 'text'], ['status', 'text', true], ['requiresRegistration', 'bool'],
    ['minParticipants', 'number'], ['maxParticipants', 'number'], ['targetGroups', 'json'], ['isPinned', 'bool'], ['endDate', 'text'],
    ['eventType', 'text'], ['imageUrl', 'text'], ['createdBy', 'text', true], ['created', 'text'], ['updated', 'text'], ['isPublic', 'bool'],
    ['publicToken', 'text']],
  event_registrations: [['event', 'text', true], ['user', 'text', true], ['status', 'text', true], ['created', 'text'], ['updated', 'text']],
  event_guests: [['event', 'text', true], ['name', 'text', true], ['email', 'text', true], ['age', 'number'], ['status', 'text', true],
    ['key', 'text', true], ['language', 'text'], ['created', 'text'], ['updated', 'text']],
  event_duties: [['event', 'text', true], ['section', 'text'], ['roleName', 'text', true], ['assignedGroup', 'text'], ['assignedUser', 'text'],
    ['requestedUser', 'text'], ['requestedBy', 'text'], ['notes', 'text'], ['status', 'text', true], ['created', 'text'], ['updated', 'text'],
    ['reminded', 'json']]
};

// Sign-ups and guests: their old "created" is the place in the queue (queuedAt); the record's own time is new
const OWN_CREATED = { event_registrations: true, event_guests: true };

const events = recordStore({ kind: 'events', codec: codecs.event, fields: OLD_FIELDS.events, links: { createdBy: 'users' }, groupLinks: true, keep: ['program'] });
// exact: a sign-up of an account that is gone keeps its id in `original` (../links.js) and is still found by it - the
// organiser takes such an attendee off the list by that id; not found, the place stayed taken, the waiting list did
// not move up and every try added another record
const registrations = recordStore({ kind: 'event_registrations', codec: codecs.registration, fields: OLD_FIELDS.event_registrations, links: { event: 'events', user: 'users' }, columns: { created: 'queuedAt' }, exact: ['user'], ownCreated: true });
const guests = recordStore({ kind: 'event_guests', codec: codecs.guest, fields: OLD_FIELDS.event_guests, links: { event: 'events' }, columns: { created: 'queuedAt' }, ownCreated: true });
const duties = recordStore({ kind: 'event_duties', codec: codecs.duty, fields: OLD_FIELDS.event_duties, links: { event: 'events', assignedUser: 'users', requestedUser: 'users', requestedBy: 'users' }, groupLinks: true });

// --- Events ------------------------------------------------------------------------------------------------------

const listEvents = (appConfig, filter = '', sort = '+date,+startTime') => events.list(appConfig, filter, sort);
const getEventRecord = (appConfig, id) => events.get(appConfig, id);

function createEventRecord(appConfig, data) {
  const at = now();
  return events.create(appConfig, {
    created: at,
    updated: at,
    status: 'scheduled',
    eventType: 'event',
    isPinned: false,
    endDate: '',
    imageUrl: '',
    isRecurring: false,
    requiresRegistration: false,
    minParticipants: 0,
    maxParticipants: 0,
    targetGroups: [],
    ...data
  });
}

const updateEventRecord = (appConfig, id, data) => events.update(appConfig, id, { updated: now(), ...data });

/** Deletes the event; its sign-ups, guests, duties and order of service go with it (one transaction). */
async function deleteEventRecord(appConfig, id) {
  await events.remove(appConfig, id);
}

/** The event a share link names (only token-shaped values get here, see eventGuests.isPublicToken). */
const findEventByPublicToken = (appConfig, publicToken) => events.first(appConfig, client.pbFilterEquals('publicToken', publicToken));

// --- Sign-ups ----------------------------------------------------------------------------------------------------

const listEventRegistrations = (appConfig, filter = '') => registrations.list(appConfig, filter, '+created');

async function getEventRegistration(appConfig, eventId, userId) {
  const filter = `${client.pbFilterEquals('event', eventId)} && ${client.pbFilterEquals('user', userId)}`;
  return (await registrations.list(appConfig, filter))[0] || null;
}

async function upsertEventRegistration(appConfig, eventId, userId, status) {
  const existing = await getEventRegistration(appConfig, eventId, userId);
  const at = now();
  if (existing) {
    // Signing up again after cancelling starts at the end of the waiting list: "created" is the place in the queue
    const rejoins = !['registered', 'waitlist'].includes(existing.status) && ['registered', 'waitlist'].includes(status);
    return registrations.update(appConfig, existing.id, { status, updated: at, ...(rejoins ? { created: at } : {}) });
  }
  return registrations.create(appConfig, { event: eventId, user: userId, status, created: at, updated: at });
}

const deleteEventRegistration = (appConfig, id) => registrations.remove(appConfig, id);

// --- Guests ------------------------------------------------------------------------------------------------------

const listEventGuests = (appConfig, filter = '') => guests.list(appConfig, filter, '+created');
const getEventGuest = (appConfig, id) => guests.get(appConfig, id);
const findEventGuestByKey = (appConfig, key) => guests.first(appConfig, client.pbFilterEquals('key', key));

function createEventGuest(appConfig, data) {
  const at = now();
  return guests.create(appConfig, { created: at, updated: at, ...data });
}

const updateEventGuest = (appConfig, id, data) => guests.update(appConfig, id, { updated: now(), ...data });
const deleteEventGuest = (appConfig, id) => guests.remove(appConfig, id);

// --- Duties ------------------------------------------------------------------------------------------------------

const listEventDuties = (appConfig, filter = '') => duties.list(appConfig, filter, '+created');
const getEventDuty = (appConfig, id) => duties.get(appConfig, id);

function createEventDuty(appConfig, data) {
  const at = now();
  return duties.create(appConfig, { created: at, updated: at, status: 'open', notes: '', ...data });
}

const updateEventDuty = (appConfig, id, data) => duties.update(appConfig, id, { updated: now(), ...data });
/** Who was reminded of a duty: no change of the duty for the others (its "updated" stays). */
const saveDutyReminded = (appConfig, id, reminded) => duties.update(appConfig, id, { reminded });
const deleteEventDuty = (appConfig, id) => duties.remove(appConfig, id);

// --- The order of service: one record per item, the time it was saved on the event --------------------------------

const PROGRAM_ITEMS = 'event_program_items';
const PROGRAM_KEYS = ['eventId', 'items', 'updatedAt'];
const validMillis = (value) => Number.isFinite(value) && value > 0 && value <= 8.64e15;
const millisOf = (stored) => (stored ? new Date(String(stored).replace(' ', 'T')).getTime() : null);

/** True when [program] has exactly the shape the server writes (it then needs nothing in `original`). */
function isCanonicalProgram(eventId, program) {
  if (!isPlainObject(program)) return false;
  const keys = Object.keys(program);
  return keys.length === PROGRAM_KEYS.length && PROGRAM_KEYS.every((key) => has(program, key)) && program.eventId === eventId
    && Array.isArray(program.items) && program.items.length > 0 && program.items.every(isPlainObject) && validMillis(program.updatedAt);
}

/** The order of service of the event [eventRow] with its item records (null: none). */
function programOf(eventRow, itemRows) {
  const original = originalOf(eventRow);
  if (has(original, 'program')) return original.program;
  if (!eventRow.programUpdated && !itemRows.length) return null;
  const items = [...itemRows].sort((a, b) => (a.position || 0) - (b.position || 0)).map((row) => codecs.programItem.decode(row));
  return { eventId: eventRow.id, items, updatedAt: millisOf(eventRow.programUpdated) };
}

/** The records of [program] for the event [eventId]: its items, its time, and itself when it has another shape. */
function programRecords(eventId, program, ctx) {
  const items = (isPlainObject(program) && Array.isArray(program.items) ? program.items : []).filter(isPlainObject);
  return {
    items: items.map((item, position) => {
      const { columns, original } = codecs.programItem.encode(item, ctx);
      return { event: eventId, position, ...columns, original };
    }),
    programUpdated: isPlainObject(program) && validMillis(program.updatedAt) ? new Date(program.updatedAt).toISOString() : '',
    asWritten: isCanonicalProgram(eventId, program) ? undefined : program
  };
}

async function songContext(appConfig, program) {
  const songIds = (isPlainObject(program) && Array.isArray(program.items) ? program.items : []).map((item) => item?.songId);
  const songs = await existingIds(appConfig, 'community_songs', songIds);
  return linkContextOf({ community_songs: songs });
}

/** The writes that make the event [eventRow] have [program] (null: none) - one transaction. */
function programWrites(eventRow, itemRows, records) {
  const ops = itemRows.map((row) => ({ method: 'DELETE', collection: table(PROGRAM_ITEMS), id: row.id }));
  for (const item of records?.items || []) ops.push({ method: 'POST', collection: table(PROGRAM_ITEMS), body: item });
  const { program, ...kept } = originalOf(eventRow);
  const original = { ...kept, ...(records && records.asWritten !== undefined ? { program: records.asWritten } : {}) };
  ops.push({ method: 'PATCH', collection: table('events'), id: eventRow.id, body: { programUpdated: records?.programUpdated || '', original: Object.keys(original).length ? original : null } });
  return ops;
}

const programQueue = (eventId, work) => queueRecordWrite(`event_programs:${eventId}`, work);
const itemRowsOf = (appConfig, eventId) => client.listAllRecords(table(PROGRAM_ITEMS), client.pbFilterEquals('event', eventId), appConfig, '+position');

/** The order of service of every event, with the interface of the item stores (itemStore.js; the key is the event id). */
const programStore = {
  isValidKey,

  async get(appConfig, eventId) {
    if (!isValidKey(eventId)) return null;
    const eventRow = await client.getRecord(table('events'), eventId, appConfig);
    if (!eventRow) return null;
    return programOf(eventRow, await itemRowsOf(appConfig, eventId)) || null;
  },

  async list(appConfig) {
    const [eventRows, itemRows] = await Promise.all([
      client.listAllRecords(table('events'), '', appConfig),
      client.listAllRecords(table(PROGRAM_ITEMS), '', appConfig)
    ]);
    const byEvent = new Map();
    for (const row of itemRows) byEvent.set(row.event, [...(byEvent.get(row.event) || []), row]);
    return eventRows.map((row) => programOf(row, byEvent.get(row.id) || [])).filter((program) => program && typeof program === 'object');
  },

  async count(appConfig) {
    return (await this.list(appConfig)).length;
  },

  /** Reads the order of service of [eventId], lets [change] decide ({ save: program } or { remove: true }) and stores it. */
  update(appConfig, eventId, change) {
    return programQueue(eventId, async () => {
      const eventRow = isValidKey(eventId) ? await client.getRecord(table('events'), eventId, appConfig) : null;
      const itemRows = eventRow ? await itemRowsOf(appConfig, eventId) : [];
      const result = (await change(eventRow ? programOf(eventRow, itemRows) || null : null)) || {};
      // Without its event an order of service could never be read again: nothing is kept
      if (!eventRow) return result;
      if (result.save) {
        const records = programRecords(eventRow.id, result.save, await songContext(appConfig, result.save));
        await client.batchWrite(appConfig, programWrites(eventRow, itemRows, records));
      } else if (result.remove) {
        await client.batchWrite(appConfig, programWrites(eventRow, itemRows, null));
      }
      return result;
    });
  }
};

// --- Links to something that is about to be deleted (see ../links.js) ----------------------------------------------

links.holdLinks('users', async (appConfig, uid) => {
  const is = (field) => client.pbFilterEquals(field, uid);
  await events.letGo(appConfig, is('createdBy'), 'users', uid);
  await registrations.letGo(appConfig, is('user'), 'users', uid);
  await duties.letGo(appConfig, `${is('assignedUser')} || ${is('requestedUser')} || ${is('requestedBy')}`, 'users', uid);
});

links.holdLinks('user_groups', async (appConfig, groupId) => {
  const group = await client.getRecord(table('user_groups'), groupId, appConfig);
  await events.letGo(appConfig, `targetGroups ?= ${JSON.stringify(groupId)}`, 'user_groups', groupId, group?.name);
  await duties.letGo(appConfig, client.pbFilterEquals('assignedGroup', groupId), 'user_groups', groupId, group?.name);
});

links.holdLinks('community_songs', async (appConfig, songId) => {
  const rows = await client.listAllRecords(table(PROGRAM_ITEMS), client.pbFilterEquals('song', songId), appConfig);
  const ctx = without(linkContextOf({ community_songs: new Set([songId]) }), 'community_songs', songId);
  for (const row of rows) {
    const { columns, original } = codecs.programItem.encode(codecs.programItem.decode(row), ctx);
    await client.updateRecord(table(PROGRAM_ITEMS), row.id, { ...columns, original }, appConfig);
  }
});

module.exports = {
  OLD_FIELDS,
  OWN_CREATED,
  linkContextOf,
  stores: { events, registrations, guests, duties },
  programOf,
  programRecords,
  listEvents,
  getEventRecord,
  createEventRecord,
  updateEventRecord,
  deleteEventRecord,
  findEventByPublicToken,
  listEventRegistrations,
  getEventRegistration,
  upsertEventRegistration,
  deleteEventRegistration,
  listEventGuests,
  getEventGuest,
  findEventGuestByKey,
  createEventGuest,
  updateEventGuest,
  deleteEventGuest,
  listEventDuties,
  getEventDuty,
  createEventDuty,
  updateEventDuty,
  saveDutyReminded,
  deleteEventDuty,
  programStore
};
