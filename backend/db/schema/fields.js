// Building blocks for the collection definitions. Every field carries a help text: PocketBase shows it in its admin
// page next to the field, and docs/DATABASE.md is generated from the same text (backend/db/docs.js).
//
// House rules (checked by tests/database.test.js):
//   - collection names: <area>_<things> in snake_case (users and events are the main tables of their areas)
//   - field names: camelCase; a link to another table is named after what it points to (member, event, user)
//   - money: whole cents in a field ending in "Cents" (number, onlyInt)
//   - a calendar day: text 'YYYY-MM-DD'; a month: text 'YYYY-MM'; a moment in time: a date field
//   - fixed choices: select fields
//   - every collection has created and updated
const DAY_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
const MONTH_PATTERN = '^\\d{4}-(0[1-9]|1[0-2])$';
const TIME_PATTERN = '^([01]\\d|2[0-3]):[0-5]\\d$';
// Ids kept from before the upgrade: PocketBase's own ids are 15 lowercase letters and digits; older apps made ids
// like "550e8400-e29b-41d4-a716-446655440000" or "-NabcDEF_123". New records get PocketBase's kind.
const KEPT_ID_PATTERN = '^[A-Za-z0-9_-]+$';

// Free text gets a generous limit (PocketBase's own is 5000 characters): the server checks what the apps send, and an
// older value that is longer must never stop the upgrade
const TEXT_MAX = 100000;
const text = (name, help, options = {}) => ({ name, type: 'text', max: TEXT_MAX, help, ...options });
const day = (name, help, options = {}) => text(name, help, { pattern: DAY_PATTERN, ...options });
const month = (name, help, options = {}) => text(name, help, { pattern: MONTH_PATTERN, ...options });
const timeOfDay = (name, help, options = {}) => text(name, help, { pattern: TIME_PATTERN, ...options });
const cents = (name, help, options = {}) => ({ name, type: 'number', onlyInt: true, help, ...options });
const integer = (name, help, options = {}) => ({ name, type: 'number', onlyInt: true, help, ...options });
const bool = (name, help, options = {}) => ({ name, type: 'bool', help, ...options });
const moment = (name, help, options = {}) => ({ name, type: 'date', help, ...options });
// JSON as large as the old records could hold (one record's data was up to 5 MB)
const JSON_MAX = 5000000;
const json = (name, help, options = {}) => ({ name, type: 'json', maxSize: JSON_MAX, help, ...options });
const select = (name, values, help, options = {}) => ({ name, type: 'select', values, maxSelect: 1, help, ...options });
const multiSelect = (name, values, help, options = {}) => ({ name, type: 'select', values, maxSelect: values.length, help, ...options });

/** A link to one record of [target] (a collection name; the id is filled in when the schema is applied). */
const link = (name, target, help, options = {}) => ({ name, type: 'relation', target, maxSelect: 1, cascadeDelete: false, help, ...options });
/** Links to several records of [target], in the order they were given. */
const links = (name, target, help, options = {}) => ({ name, type: 'relation', target, maxSelect: 999, cascadeDelete: false, help, ...options });

/** created / updated, set by PocketBase on every write. */
const automaticTimes = () => [
  { name: 'created', type: 'autodate', onCreate: true, onUpdate: false, help: 'When the record was created (set by the database).' },
  { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true, help: 'When the record was last changed (set by the database).' }
];

/** created / updated, set by the server; the upgrade keeps the times records had before (PocketBase cannot set its own). */
const keptTimes = () => [
  moment('created', 'When the record was created (kept from before the upgrade for older records).'),
  moment('updated', 'When the record was last changed (kept from before the upgrade for older records).')
];

/** An id field that also takes the ids older apps made (see KEPT_ID_PATTERN). */
const keptId = () => ({
  name: 'id',
  type: 'text',
  system: true,
  primaryKey: true,
  required: true,
  min: 1,
  max: 64,
  pattern: KEPT_ID_PATTERN,
  autogeneratePattern: '[a-z0-9]{15}',
  help: 'The record id. Records from before the upgrade keep the id the apps gave them.'
});

/**
 * How an app wrote a record when the columns cannot show it exactly: an amount written as text ("50,00"), a field it
 * left out, a field the server does not know. Older apps get their records back exactly as they wrote them; the
 * columns are what everything else reads. Empty for almost every record.
 */
const original = () => json('original', 'Exactly how an older app wrote this record where the columns cannot show it (e.g. an amount typed as "50,00", a field it left out). Only for older apps; empty for almost every record. Do not edit.');

/** A table of the server alone (see SERVER_ONLY_RULES in pocketbase.js). */
const SERVER_ONLY_RULES = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };

module.exports = {
  DAY_PATTERN,
  MONTH_PATTERN,
  TIME_PATTERN,
  KEPT_ID_PATTERN,
  SERVER_ONLY_RULES,
  text,
  day,
  month,
  timeOfDay,
  cents,
  integer,
  bool,
  moment,
  json,
  select,
  multiSelect,
  link,
  links,
  automaticTimes,
  keptTimes,
  keptId,
  original
};
