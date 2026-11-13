// Events, sign-ups, guests, the duty roster and the order of service: the records exactly as the server has always
// handled them (the records of the old tables, every field), and as the new tables keep them (see ../codec.js).
const { createCodec, fieldKinds: f } = require('../codec');
const { REGISTRATION_STATES, GUEST_STATES, DUTY_STATES, EVENT_TYPES } = require('../schema/events');

const recordId = { column: 'id', toColumn: (value, source, ctx) => ctx.recordId ?? String(value ?? ''), fromColumn: (stored) => stored };
/** A field the new structure does not keep: what the apps wrote there was always empty (anything else stays in `original`). */
const dropped = (empty) => f.computed(() => empty);
const asText = (value) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : String(value));

/** A link to a group, named by its id or by its name (an older app); anything else stays in `original`. */
const groupLink = (column) => ({
  column,
  toColumn: (value, source, ctx) => (typeof value === 'string' && value ? ctx?.groupId?.(value) || '' : ''),
  fromColumn: (stored) => stored || ''
});

/**
 * Target groups: the groups that exist (named by id or by name) are linked, in order; the rest (names of no group,
 * groups that are gone) is kept in unmatchedTargetGroups - it still hides the event from everyone else.
 */
function splitGroups(value, ctx) {
  const linked = [];
  const rest = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const id = typeof entry === 'string' && entry ? ctx?.groupId?.(entry) || null : null;
    if (!id) rest.push(entry);
    else if (!linked.includes(id)) linked.push(id);
  }
  return { linked, rest };
}
// Writes the second column of the target groups; never a key of an event (see codec.js: a field only for columns)
const REST_OF_GROUPS = '\u0000unmatchedTargetGroups';

const EVENT_KEYS = [
  'id', 'title', 'date', 'startTime', 'endTime', 'location', 'description', 'isRecurring', 'recurringRule', 'seriesId', 'status',
  'requiresRegistration', 'minParticipants', 'maxParticipants', 'targetGroups', 'isPinned', 'endDate', 'eventType', 'imageUrl',
  'createdBy', 'created', 'updated', 'isPublic', 'publicToken'
];
const event = createCodec({
  fields: {
    id: recordId,
    title: f.text('title'),
    date: f.day('date'),
    startTime: f.timeOfDay('startTime'),
    endTime: f.timeOfDay('endTime'),
    location: f.text('location'),
    description: f.text('description'),
    isRecurring: f.bool('isRecurring'),
    recurringRule: f.text('recurringRule'),
    // Series of events were never written by this version: the field is gone (an old value stays in `original`)
    seriesId: dropped(''),
    status: f.text('status'),
    requiresRegistration: f.bool('requiresRegistration'),
    minParticipants: f.number('minParticipants'),
    maxParticipants: f.number('maxParticipants'),
    targetGroups: {
      column: 'targetGroups',
      toColumn: (value, source, ctx) => splitGroups(value, ctx).linked,
      fromColumn: (stored, row) => [...(Array.isArray(stored) ? stored : []), ...(Array.isArray(row?.unmatchedTargetGroups) ? row.unmatchedTargetGroups : [])]
    },
    [REST_OF_GROUPS]: { column: 'unmatchedTargetGroups', toColumn: (value, source, ctx) => splitGroups(source.targetGroups, ctx).rest, fromColumn: () => undefined },
    isPinned: f.bool('isPinned'),
    endDate: f.day('endDate'),
    eventType: f.select('eventType', EVENT_TYPES),
    imageUrl: f.text('imageUrl'),
    createdBy: f.link('createdBy', 'users'),
    created: f.isoTime('created'),
    updated: f.isoTime('updated'),
    isPublic: f.bool('isPublic'),
    // A share key is unique; a second event with the same key (only possible in old data) keeps it in `original` -
    // the link always opened the first one
    publicToken: { ...f.text('publicToken'), toColumn: (value, source, ctx) => (ctx?.tokenTaken?.(asText(value)) ? '' : asText(value)) }
  },
  canonicalKeys: () => EVENT_KEYS
});

const REGISTRATION_KEYS = ['id', 'event', 'user', 'status', 'created', 'updated'];
const registration = createCodec({
  fields: {
    id: recordId,
    event: f.link('event', 'events'),
    user: f.link('user', 'users'),
    status: f.select('status', REGISTRATION_STATES),
    // "created" was the place in the queue (signing up again after cancelling moved it to the end)
    created: f.isoTime('queuedAt'),
    updated: f.isoTime('updated')
  },
  canonicalKeys: () => REGISTRATION_KEYS
});

const GUEST_KEYS = ['id', 'event', 'name', 'email', 'age', 'status', 'key', 'language', 'created', 'updated'];
const guest = createCodec({
  fields: {
    id: recordId,
    event: f.link('event', 'events'),
    name: f.text('name'),
    email: f.text('email'),
    age: f.number('age'),
    status: f.select('status', GUEST_STATES),
    key: f.text('key'),
    language: f.text('language'),
    created: f.isoTime('queuedAt'),
    updated: f.isoTime('updated')
  },
  canonicalKeys: () => GUEST_KEYS
});

const DUTY_KEYS = ['id', 'event', 'section', 'roleName', 'assignedGroup', 'assignedUser', 'requestedUser', 'requestedBy', 'notes', 'status', 'created', 'updated', 'reminded'];
const duty = createCodec({
  fields: {
    id: recordId,
    event: f.link('event', 'events'),
    section: f.text('section'),
    roleName: f.text('roleName'),
    assignedGroup: groupLink('assignedGroup'),
    assignedUser: f.link('assignedUser', 'users'),
    requestedUser: f.link('requestedUser', 'users'),
    requestedBy: f.link('requestedBy', 'users'),
    notes: f.text('notes'),
    status: f.select('status', DUTY_STATES),
    created: f.isoTime('created'),
    updated: f.isoTime('updated'),
    reminded: f.json('reminded')
  },
  canonicalKeys: () => DUTY_KEYS
});

/** An item of the order of service: { id, title, minutes, who, note, songId, songKey } (id: the item's own id). */
const PROGRAM_ITEM_KEYS = ['id', 'title', 'minutes', 'who', 'note', 'songId', 'songKey'];
const programItem = createCodec({
  fields: {
    id: f.text('itemId'),
    title: f.text('title'),
    // 0 is "none given" in the column; an item of 0 minutes on purpose keeps the 0 in `original`
    minutes: f.number('minutes', { empty: null }),
    who: f.text('who'),
    note: f.text('note'),
    songId: f.link('song', 'community_songs'),
    songKey: f.text('songKey')
  },
  canonicalKeys: () => PROGRAM_ITEM_KEYS
});

module.exports = {
  event, registration, guest, duty, programItem, splitGroups,
  EVENT_KEYS, REGISTRATION_KEYS, GUEST_KEYS, DUTY_KEYS, PROGRAM_ITEM_KEYS
};
