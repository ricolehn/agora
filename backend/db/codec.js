// Exact round trips between an object as an app wrote it and a record of the new structure.
//
// The apps write plain JSON objects (a payment, a donation, a member). The database keeps their values in typed
// columns - amounts in whole cents, days as 'YYYY-MM-DD', links to other records - and whatever the columns cannot
// show exactly goes into the record's `original` field: a key the app left out or added, a value written another way
// ("50,00" for 50, a date in another spelling, an id that was a number). decode(encode(x)) gives back x exactly - same
// keys, same values, same types - so the old API answers every older app exactly as before, while everything new
// reads the columns. For the records the current apps write, `original` stays empty.
//
// A codec is made of fields: { [key]: { column, toColumn(value, source, ctx), fromColumn(columnValue, row) } }.
// column null makes a field that is only computed from other columns (fromColumn gets the whole row). canonicalKeys(row)
// lists the keys a decoded object has when `original` says nothing - the shape the current apps write.
const { isDeepStrictEqual } = require('util');
const { toDateStr } = require('../utils/date');

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
// An own key also when it is named "__proto__" (a plain assignment would set the prototype instead)
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function createCodec({ fields, canonicalKeys }) {
  const fieldKeys = Object.keys(fields);

  /**
   * { columns, original } for [source]; [ctx] tells fields what exists (links) and what record it is. [outer]: columns
   * of the record [source] is part of (a request's data needs its kind).
   */
  function encode(source, ctx = {}, outer = {}) {
    const object = isPlainObject(source) ? source : {};
    const columns = {};
    for (const key of fieldKeys) {
      const field = fields[key];
      if (field.column === null) continue;
      columns[field.column] = field.toColumn(has(object, key) ? object[key] : undefined, object, ctx);
    }
    const values = {};
    const extra = {};
    for (const [key, value] of Object.entries(object)) {
      if (!has(fields, key)) {
        put(extra, key, value);
        continue;
      }
      const field = fields[key];
      const back = field.fromColumn(field.column === null ? undefined : columns[field.column], { ...outer, ...columns });
      if (!isDeepStrictEqual(back, value)) put(values, key, value);
    }
    const expected = new Set([...canonicalKeys({ ...outer, ...columns }), ...Object.keys(extra)]);
    const actual = Object.keys(object);
    const sameKeys = actual.length === expected.size && actual.every((key) => expected.has(key));
    const original = {};
    if (!sameKeys) original.keys = actual;
    if (Object.keys(values).length) original.values = values;
    if (Object.keys(extra).length) original.extra = extra;
    return { columns, original: Object.keys(original).length ? original : null };
  }

  /** The object as the app wrote it, from a record ([row]: its columns and `original`). */
  function decode(row) {
    // The shape the current apps write (no `original`, almost every record): every value from its column
    if (!isPlainObject(row?.original)) {
      const keys = canonicalKeys(row || {});
      const object = {};
      for (let index = 0; index < keys.length; index += 1) {
        const field = fields[keys[index]];
        if (field) object[keys[index]] = field.fromColumn(field.column === null ? undefined : row[field.column], row);
      }
      return object;
    }
    const original = row.original;
    const values = isPlainObject(original.values) ? original.values : {};
    const extra = isPlainObject(original.extra) ? original.extra : {};
    const keys = Array.isArray(original.keys) ? original.keys : [...canonicalKeys(row), ...Object.keys(extra)];
    const entries = [];
    for (const key of keys) {
      if (has(values, key)) entries.push([key, values[key]]);
      else if (has(fields, key)) entries.push([key, fields[key].fromColumn(fields[key].column === null ? undefined : row[fields[key].column], row)]);
      else if (has(extra, key)) entries.push([key, extra[key]]);
    }
    // fromEntries: a key like "__proto__" stays an own key
    return Object.fromEntries(entries);
  }

  return { encode, decode, fields };
}

// --- Money -------------------------------------------------------------------------------------------------------

/**
 * An amount the way the server has always read it (feeReset.paymentAmount, calculateTotalPaid): a number, or text
 * like "1.234,50" or "50,00"; anything else counts as 0.
 */
function amountValue(value) {
  const amount = Number(String(value || 0).replace(/\.(?=.*,)/g, '').replace(',', '.'));
  return Number.isFinite(amount) ? amount : 0;
}

/**
 * [amount] (a number) in whole cents, worked out from its decimal digits - not by multiplying, which turns 1.005 into
 * 100.49999999999999. exact: false for a fraction of a cent (rounded half away from zero, by the digits) or a number in
 * exponent form.
 */
function toCents(amount) {
  const text = String(amount);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return { cents: Math.round(amount * 100), exact: false };
  const [, sign, whole, fraction = ''] = match;
  let cents = Number(whole) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'));
  const exact = fraction.length <= 2;
  if (!exact && Number(fraction[2]) >= 5) cents += 1;
  return { cents: sign && cents ? -cents : cents, exact };
}

/** Cents back to the amount as a number (4999 → 49.99). */
const fromCents = (cents) => (Number(cents) || 0) / 100;

// --- Field kinds ---------------------------------------------------------------------------------------------------

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const asText = (value) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value));

const fieldKinds = {
  /** Text column ('' for nothing). */
  text: (column) => ({ column, toColumn: (value) => asText(value), fromColumn: (stored) => (stored === undefined || stored === null ? '' : String(stored)) }),
  /**
   * A calendar day 'YYYY-MM-DD' (read like the server always read days: utils/date.toDateStr). What does not come out
   * as such a day (a year typed with three or five digits, a number of days from a spreadsheet) leaves the column
   * empty and stays in `original` as it was written - the database refuses anything else in a day column, and one
   * such date in one old payment stopped the whole upgrade.
   */
  day: (column, { empty = '' } = {}) => ({
    column,
    toColumn: (value) => {
      if (value === undefined || value === null || value === '') return '';
      const day = toDateStr(value);
      return DAY.test(day) ? day : '';
    },
    fromColumn: (stored) => (stored ? String(stored) : empty)
  }),
  /** An amount in whole cents; it decodes to a number (or, with asString, to text like "12.5", as requests keep it). */
  money: (column, { asString = false } = {}) => ({
    column,
    // An amount beyond what whole cents can hold exactly (1e21) leaves the column at 0 and stays in `original`
    toColumn: (value) => {
      if (value === undefined || value === null || value === '') return 0;
      const { cents } = toCents(amountValue(value));
      return Number.isSafeInteger(cents) ? cents : 0;
    },
    fromColumn: (stored) => (asString ? String(fromCents(stored)) : fromCents(stored))
  }),
  bool: (column) => ({ column, toColumn: (value) => value === true, fromColumn: (stored) => stored === true }),
  /** Any JSON value as it is. */
  json: (column, { empty = null } = {}) => ({ column, toColumn: (value) => (value === undefined ? empty : value), fromColumn: (stored) => (stored === undefined ? empty : stored) }),
  /** One of [values] ('' for anything else - the value then stays in `original`). */
  select: (column, values) => ({ column, toColumn: (value) => (values.includes(value) ? value : ''), fromColumn: (stored) => stored || '' }),
  /** A time of day 'HH:mm' ('' for nothing; "9:00" or "09:00:00" read as 09:00 - the value as written stays in `original`). */
  timeOfDay: (column) => ({
    column,
    toColumn: (value) => {
      const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(typeof value === 'string' ? value.trim() : '');
      if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return '';
      return `${match[1].padStart(2, '0')}:${match[2]}`;
    },
    fromColumn: (stored) => (stored ? String(stored) : '')
  }),
  /** A whole number (0 for nothing). */
  number: (column, { empty = 0 } = {}) => ({
    column,
    toColumn: (value) => (typeof value === 'number' && Number.isInteger(value) ? value : 0),
    fromColumn: (stored) => (stored === undefined || stored === null || stored === 0 ? empty : stored)
  }),
  /** A moment (date field) that the app keeps as milliseconds. */
  millis: (column, { empty = null } = {}) => ({
    column,
    // Only moments a date can hold (an absurd number stays in `original` instead of breaking the upgrade)
    toColumn: (value) => (Number.isFinite(value) && value > 0 && value <= 8.64e15 ? new Date(value).toISOString() : ''),
    fromColumn: (stored) => (stored ? new Date(String(stored).replace(' ', 'T')).getTime() : empty)
  }),
  /** A moment (date field) that the app keeps as an ISO text ("2026-11-13T08:29:40.088Z"). */
  isoTime: (column, { empty = '' } = {}) => ({
    column,
    toColumn: (value) => {
      if (typeof value !== 'string' || !value) return '';
      const time = new Date(value);
      return Number.isNaN(time.getTime()) ? '' : time.toISOString();
    },
    fromColumn: (stored) => (stored ? new Date(String(stored).replace(' ', 'T')).toISOString() : empty)
  }),
  /** A link to one record of [collection] (an id that does not exist stays in `original`; ctx.exists decides). */
  link: (column, collection) => ({
    column,
    toColumn: (value, source, ctx) => {
      if (typeof value !== 'string' || !value) return '';
      return !ctx?.exists || ctx.exists(collection, value) ? value : '';
    },
    fromColumn: (stored) => stored || ''
  }),
  /** Only computed from other columns. */
  computed: (fromRow) => ({ column: null, toColumn: () => undefined, fromColumn: (stored, row) => fromRow(row || {}) })
};

/** True when a decoded record would come out with every value from its columns (nothing in `original`). */
const isCanonical = (encoded) => encoded.original === null;

module.exports = {
  createCodec,
  fieldKinds,
  amountValue,
  toCents,
  fromCents,
  isCanonical,
  isPlainObject
};
