// The upgrade of events, sign-ups, guests, the duty roster and the order of service. The tables keep their names
// (events, event_registrations, event_guests, event_duties) and their record ids - the apps and e-mails address
// events, guests and duties by them; the new ones are built next to the old ones (v4_...) and take the names in the
// cleanup. Links become real links (to accounts, groups, events, songs); what pointed to something that is gone
// stays in `original`, where the older apps read it. The order of service (one JSON value per event in
// event_programs) becomes one record per item (event_program_items) and the time it was saved on the event.
const client = require('../client');
const codecs = require('../codecs/events');
const store = require('../stores/events');
const { fieldKinds } = require('../codec');
const { makeDiffer } = require('./differ');
const { table } = require('../tables');

const KINDS = ['events', 'event_registrations', 'event_guests', 'event_duties'];
const OLD_COLLECTIONS = [...KINDS, 'event_programs'];
const NEW_COLLECTIONS = [...KINDS, 'event_program_items'];
const RECORD_STORES = { events: store.stores.events, event_registrations: store.stores.registrations, event_guests: store.stores.guests, event_duties: store.stores.duties };
const isoColumn = fieldKinds.isoTime('created').toColumn;
const isValidKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(key);

/** A record of an old table without what PocketBase adds to every answer. */
const fieldsOf = (row) => {
  const { collectionId, collectionName, expand, ...fields } = row;
  return fields;
};

/** What the check noticed, by kind: record ids only (no names, no texts) - the report can be shared. */
function newFindings() {
  return {
    linksToMissingAccounts: [], groupsByNameOrGone: [], recordsOfDeletedEvents: [], datesInOtherSpelling: [], timesOfDayInOtherSpelling: [],
    timestampsInOtherSpelling: [], unknownStates: [], duplicatedShareKeys: [], seriesIds: [], valuesKeptAsWritten: [], fieldsOfOlderVersions: [],
    programsOfDeletedEvents: [], programsKeptAsWritten: [], programItemsKeptAsWritten: []
  };
}

const FINDING_OF = {
  createdBy: 'linksToMissingAccounts', user: 'linksToMissingAccounts', assignedUser: 'linksToMissingAccounts', requestedUser: 'linksToMissingAccounts',
  requestedBy: 'linksToMissingAccounts', targetGroups: 'groupsByNameOrGone', assignedGroup: 'groupsByNameOrGone', event: 'recordsOfDeletedEvents',
  date: 'datesInOtherSpelling', endDate: 'datesInOtherSpelling', startTime: 'timesOfDayInOtherSpelling', endTime: 'timesOfDayInOtherSpelling',
  created: 'timestampsInOtherSpelling', updated: 'timestampsInOtherSpelling', status: 'unknownStates', eventType: 'unknownStates',
  publicToken: 'duplicatedShareKeys', seriesId: 'seriesIds'
};

function noteOriginal(findings, where, original) {
  if (!original) return;
  for (const key of Object.keys(original.values || {})) findings[FINDING_OF[key] || 'valuesKeptAsWritten'].push(`${where}.${key}`);
  if (original.keys || original.extra) findings.fieldsOfOlderVersions.push(where);
}

async function readOld(appConfig) {
  const [events, registrations, guests, duties, programs, users, groups, songIds] = await Promise.all([
    ...OLD_COLLECTIONS.map((name) => client.listAllRecords(name, '', appConfig)),
    client.listAllRecords('users', '', appConfig, '', { fields: 'id' }),
    // The groups keep their ids in the new structure (accounts)
    client.listAllRecords('groups', '', appConfig, '', { fields: 'id,name' }).catch(() => []),
    require('./community').songIdsAfter(appConfig)
  ]);
  return { events, registrations, guests, duties, programs, users, groups, songIds };
}

/** Works out the new records (in the order the old tables hold them) and what the check noticed. */
async function plan(appConfig) {
  const old = await readOld(appConfig);
  const findings = newFindings();
  const ctx = store.linkContextOf({
    users: new Set(old.users.map((user) => user.id)),
    events: new Set(old.events.map((event) => event.id)),
    community_songs: old.songIds
  }, old.groups);

  // The order of service per event: its items, its time - or, in another shape, the value as it was
  const programs = new Map();
  for (const row of old.programs) {
    if (!isValidKey(row.key) || !ctx.exists('events', row.key)) {
      findings.programsOfDeletedEvents.push(`event_programs/${row.id}`);
      continue;
    }
    const records = store.programRecords(row.key, row.data, ctx);
    if (records.asWritten !== undefined) findings.programsKeptAsWritten.push(`event_programs/${row.id}`);
    records.items.forEach((item, index) => { if (item.original) findings.programItemsKeptAsWritten.push(`event_programs/${row.id}.items.${index}`); });
    programs.set(row.key, records);
  }

  const ops = [];
  const tokens = new Set();
  const counts = { old: {}, new: {} };
  for (const kind of KINDS) {
    const kindStore = RECORD_STORES[kind];
    let created = 0;
    for (const row of old[kind === 'events' ? 'events' : kind.replace('event_', '')]) {
      const object = fieldsOf(row);
      // A share key a second event has too stays with the first (the link always opened that one)
      const tokenTaken = (token) => token !== '' && tokens.has(token);
      const { columns, original } = kindStore.codec.encode(object, { ...ctx, tokenTaken, recordId: row.id });
      if (kind === 'events' && columns.publicToken) tokens.add(columns.publicToken);
      const body = { ...columns, original };
      if (store.OWN_CREATED[kind]) body.created = isoColumn(object.created);
      const program = kind === 'events' ? programs.get(row.id) : null;
      if (program) {
        body.programUpdated = program.programUpdated;
        if (program.asWritten !== undefined) body.original = { ...(body.original || {}), program: program.asWritten };
      }
      noteOriginal(findings, `${kind}/${row.id}`, original);
      ops.push({ method: 'POST', collection: table(kind), body: { ...body, id: row.id } });
      created += 1;
    }
    counts.old[kind] = old[kind === 'events' ? 'events' : kind.replace('event_', '')].length;
    counts.new[kind] = created;
  }
  let items = 0;
  for (const [eventId, records] of programs) {
    for (const item of records.items) {
      ops.push({ method: 'POST', collection: table('event_program_items'), body: { ...item, event: eventId } });
      items += 1;
    }
  }
  counts.old.event_programs = old.programs.length;
  counts.new.event_program_items = items;
  return { ops, findings, counts, totals: {} };
}

/** Writes what plan() worked out (events first: everything else links to them). */
async function apply(appConfig, planned) {
  for (let start = 0; start < planned.ops.length; start += client.BATCH_MAX_REQUESTS) {
    await client.batchWrite(appConfig, planned.ops.slice(start, start + client.BATCH_MAX_REQUESTS));
  }
}

/**
 * Checks that the new tables answer exactly like the old ones, through the functions the server uses: every list
 * (in its order), every record read by its id, the share links and guest keys, the order of service of every event,
 * and the lists of one event for a sample of events.
 */
async function compare(appConfig, { legacy }) {
  const { differences, differ } = makeDiffer();
  const plain = (record) => {
    if (!record || typeof record !== 'object') return record;
    const { collectionId, ...rest } = record;
    return rest;
  };
  // PocketBase's internal id of the table differs (a new table); everything else must be the same
  const all = (value) => (Array.isArray(value) ? value.map(plain) : plain(value));
  const both = async (what, before, after) => differ(what, all(await before().catch((err) => `failed: ${err.message}`)), all(await after().catch((err) => `failed: ${err.message}`)));
  const inChunks = async (list, work) => {
    for (let start = 0; start < list.length; start += 20) await Promise.all(list.slice(start, start + 20).map(work));
  };
  const old = legacy.store;

  await both('the events (in their order)', () => old.listEvents(appConfig), () => store.listEvents(appConfig));
  await both('the sign-ups', () => old.listEventRegistrations(appConfig), () => store.listEventRegistrations(appConfig));
  await both('the guests', () => old.listEventGuests(appConfig), () => store.listEventGuests(appConfig));
  await both('the duties', () => old.listEventDuties(appConfig), () => store.listEventDuties(appConfig));
  // The window of the duty reminders
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const window = `date >= ${JSON.stringify(day(-1))} && date <= ${JSON.stringify(day(2))}`;
  await both('the events of the reminder window', () => old.listEvents(appConfig, window), () => store.listEvents(appConfig, window));

  const [events, registrations, guests, duties] = await Promise.all(KINDS.map((name) => client.listAllRecords(name, '', appConfig)));
  await inChunks(events, async (event) => {
    await both(`event ${event.id}`, () => old.getEventRecord(appConfig, event.id), () => store.getEventRecord(appConfig, event.id));
    const programs = legacy.itemStore.createItemStore('event_programs');
    await both(`the order of service of event ${event.id}`, () => programs.get(appConfig, event.id), () => store.programStore.get(appConfig, event.id));
    if (event.publicToken) await both(`the share link of event ${event.id}`, () => old.findEventByPublicToken(appConfig, event.publicToken), () => store.findEventByPublicToken(appConfig, event.publicToken));
  });
  await inChunks(guests, async (guest) => {
    await both(`guest ${guest.id}`, () => old.getEventGuest(appConfig, guest.id), () => store.getEventGuest(appConfig, guest.id));
    if (guest.key) await both(`the key of guest ${guest.id}`, () => old.findEventGuestByKey(appConfig, guest.key), () => store.findEventGuestByKey(appConfig, guest.key));
  });
  await inChunks(duties, (duty) => both(`duty ${duty.id}`, () => old.getEventDuty(appConfig, duty.id), () => store.getEventDuty(appConfig, duty.id)));
  await inChunks(registrations.slice(-500), (registration) => both(`sign-up ${registration.id}`,
    () => old.getEventRegistration(appConfig, registration.event, registration.user), () => store.getEventRegistration(appConfig, registration.event, registration.user)));
  // What one event lists, for the events that have something (the newest 300)
  const withChildren = [...new Set([...registrations, ...guests, ...duties].map((row) => row.event))].filter((id) => events.some((event) => event.id === id)).slice(-300);
  await inChunks(withChildren, async (eventId) => {
    const is = client.pbFilterEquals('event', eventId);
    await both(`the sign-ups of event ${eventId}`, () => old.listEventRegistrations(appConfig, is), () => store.listEventRegistrations(appConfig, is));
    await both(`the guests of event ${eventId}`, () => old.listEventGuests(appConfig, is), () => store.listEventGuests(appConfig, is));
    await both(`the duties of event ${eventId}`, () => old.listEventDuties(appConfig, is), () => store.listEventDuties(appConfig, is));
  });
  return differences;
}

/** After the switch: the old tables go (the backup taken before keeps them); the new ones then take their names. */
async function cleanup(appConfig) {
  for (const name of OLD_COLLECTIONS) {
    const collection = await client.getCollection(appConfig, name).catch(() => null);
    // Only an old table: once the new one has the name, it is no longer old
    if (collection && !isNewShape(collection)) await client.deleteCollection(appConfig, name).catch((err) => { if (err.status !== 404) throw err; });
  }
}

/** True for a table of the new structure (it has `original`; the old ones did not). */
const isNewShape = (collection) => (collection.fields || []).some((field) => field.name === 'original');

module.exports = { key: 'events', OLD_COLLECTIONS, NEW_COLLECTIONS, plan, apply, compare, cleanup, isNewShape };
