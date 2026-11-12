// CALDERA: the monthly fees over time - every change of the fees says from which month it counts.
//
// The fee calculation (derivedData.js) used to charge every month at the fees that are set now; only a fresh start
// (feeReset.js) kept the fees of the time before it. So a fee raised in March re-priced every month back to the
// latest fresh start, and members who had paid month by month were behind at once. Now the fees have a history: the
// fees "from the beginning" (base) and the changes, each with the month it counts from. A month costs the fees of
// the latest change at or before it - the months before a change keep the old fees, whenever the change is entered
// and wherever a fresh start lies. A change may count from a month still to come (it applies when the month comes),
// from this month, or from a month in the past (then it reaches back, and the admin is shown what that does before
// anything is saved, routes/finance.js).
//
// The history lives in a state value of its own, like the fresh starts and for the same reason: the fee settings are
// written as a whole by older apps, which would drop a field they do not know. The fee settings keep the fees of the
// current month for those apps to read; a fee they save there has no month and counts from the current one
// (feesFromSettings, feeState.js).
//
// An instance from before the history has none stored. Its history is read off what was charged until now - the
// fees each fresh start kept and the fees that are set - so the update changes the price of no month
// (scheduleFromLegacy). Everything in this file is pure (no database).
const crypto = require('crypto');
const { monthlyFees, monthIndexOf, feePeriods, feesOfMonth, text, moment } = require('./feeReset');

const FEE_SCHEDULE_STATE_KEY = 'feeSchedule';
// The fees an admin sets, in the order of the fee settings ("pausiert" costs nothing and has no field)
const FEE_STATUSES = ['vollverdiener', 'geringverdiener', 'keinverdiener'];
// What an app without the history may have written into the fee settings
const SETTINGS_FEE_KEYS = [...FEE_STATUSES, 'pausiert'];
// Guards against a mistyped year or amount, not limits of the feature
const EARLIEST_MONTH = '2000-01';
const MAX_YEARS_AHEAD = 10;
const MAX_FEE = 100000;
const MAX_CHANGES = 120;
const MAX_LOG_ENTRIES = 100;

const roundCents = (amount) => Math.round(amount * 100) / 100;

/** [value] as a month 'YYYY-MM', or null. */
function parseMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
}

/** The month 'YYYY-MM' of a month counted as one number (year * 12 + month, as monthIndexOf counts a day's). */
const monthOf = (index) => `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;

/** [month] ('YYYY-MM', or a day in it) with [count] months added. */
const addMonths = (month, count) => monthOf(monthIndexOf(month) + count);

const sameFees = (a, b) => [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].every((status) => ((a || {})[status] || 0) === ((b || {})[status] || 0));

/**
 * The history without changes that change nothing (one whose fees are those that count before it anyway). Only for a
 * history that is read off older data: what an admin entered stays until it is taken back, also while another
 * change makes it say nothing - edited back, that one must not have swallowed it.
 */
function withoutEmptyChanges(schedule) {
  const changes = [];
  let fees = schedule.base;
  for (const change of schedule.changes) {
    if (sameFees(change.fees, fees)) continue;
    changes.push(change);
    fees = change.fees;
  }
  return { base: schedule.base, changes };
}

/**
 * The stored history as a clean one: { base, changes } with real months only, each month once (the entry stored
 * last counts), the earliest first. null when nothing that is one is stored.
 */
function normalizeFeeSchedule(value) {
  if (!value || typeof value !== 'object' || !value.base || typeof value.base !== 'object') return null;
  const byMonth = new Map();
  for (const entry of Array.isArray(value.changes) ? value.changes : []) {
    const from = parseMonth(entry?.from);
    if (!from) continue;
    byMonth.set(from, { from, fees: monthlyFees(entry.fees), setAt: moment(entry.setAt), setBy: text(entry.setBy), setByName: text(entry.setByName) });
  }
  return { base: monthlyFees(value.base), changes: [...byMonth.values()].sort((a, b) => a.from.localeCompare(b.from)) };
}

/** Who set or took back which fees when (the newest last); what is not a log entry is left out. */
function normalizeFeeScheduleLog(value) {
  return (Array.isArray(value?.log) ? value.log : [])
    .filter((entry) => entry && ['set', 'removed'].includes(entry.action) && (entry.from === null || parseMonth(entry.from)))
    .map((entry) => ({
      action: entry.action,
      from: entry.from,
      fees: entry.fees && typeof entry.fees === 'object' ? monthlyFees(entry.fees) : null,
      movedFrom: parseMonth(entry.movedFrom),
      at: moment(entry.at),
      by: text(entry.by),
      byName: text(entry.byName)
    }))
    .slice(-MAX_LOG_ENTRIES);
}

/** The log with one more entry (only the newest are kept). */
function withFeeLogEntry(log, entry) {
  return [...log, entry].slice(-MAX_LOG_ENTRIES);
}

/**
 * The history of an instance that has none stored, read off what the calculation charged until now: the fees each
 * fresh start kept for the time before it ([resets], feeReset.js) and the fees set now ([settings]) for the time
 * from the latest one on. Every month costs in it exactly what it cost.
 */
function scheduleFromLegacy(resets, settings) {
  const periods = feePeriods(resets, settings);
  const changes = new Map();
  for (let i = 1; i < periods.length; i += 1) {
    // two fresh starts in one month: the fees after the later one count from that month
    const from = monthOf(periods[i - 1].beforeMonth);
    changes.set(from, { from, fees: periods[i].fees, setAt: null, setBy: '', setByName: '' });
  }
  return withoutEmptyChanges({ base: periods[0].fees, changes: [...changes.values()] });
}

/**
 * What each month costs, as the periods the fee calculation reads (feesOfMonth in feeReset.js): { beforeMonth, fees }
 * holds for the months below beforeMonth, the earliest first.
 */
function schedulePeriods(schedule) {
  const periods = [];
  let fees = schedule.base;
  for (const change of schedule.changes) {
    periods.push({ beforeMonth: monthIndexOf(change.from), fees });
    fees = change.fees;
  }
  periods.push({ beforeMonth: Infinity, fees });
  return periods;
}

/** The monthly fees of [month] ('YYYY-MM', a day in it, or the month as one number). */
function feesInMonth(schedule, month) {
  return feesOfMonth(schedulePeriods(schedule), typeof month === 'number' ? month : monthIndexOf(month));
}

/** Changes whenever a month costs something else: what a preview was worked out for must still be there when it is confirmed. */
function feeScheduleVersion(schedule) {
  const table = (fees) => Object.keys(fees).sort().map((status) => [status, fees[status]]);
  const content = JSON.stringify([table(schedule.base), schedule.changes.map((change) => [change.from, table(change.fees)])]);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * The history with the fees [fees] counting from [from] ('YYYY-MM'; null: from the beginning). With [replaces] the
 * change of that month is the one that is edited or moved. Statuses [fees] does not name keep what they cost.
 * Fees from a month that are the fees counting before it anyway say nothing and are not kept (a change set back to
 * what it changed is gone); every other change stays as it was entered.
 */
function withFeeChange(schedule, { from, fees, replaces = null, setAt = null, setBy = '', setByName = '' }) {
  if (from === null) return { base: { ...schedule.base, ...fees }, changes: schedule.changes };
  const edited = schedule.changes.find((change) => change.from === (replaces || from));
  const others = { base: schedule.base, changes: schedule.changes.filter((change) => change.from !== from && change.from !== replaces) };
  const table = { ...(edited ? edited.fees : feesInMonth(others, from)), ...fees };
  if (sameFees(table, feesInMonth(others, monthIndexOf(from) - 1))) return others;
  return { base: schedule.base, changes: [...others.changes, { from, fees: table, setAt, setBy, setByName }].sort((a, b) => a.from.localeCompare(b.from)) };
}

/** The history without the change of [from]: from that month on the fees before it count again. */
function withoutFeeChange(schedule, from) {
  return { base: schedule.base, changes: schedule.changes.filter((change) => change.from !== from) };
}

/**
 * Checks the fees an admin wants to count from a month. [input]: { from, fees, replaces } - from null means from the
 * beginning, replaces the month of the change that is edited or moved. Returns { change }, or { status, error }
 * with an English text (translated with the answer, see i18n.js).
 */
function checkFeeChange(schedule, input, today) {
  const fromStart = input?.from === null;
  const from = fromStart ? null : parseMonth(input?.from);
  if (!fromStart && !from) return { status: 400, error: 'Please choose the month the fees count from.' };
  if (from && (from < EARLIEST_MONTH || from > `${Number(today.slice(0, 4)) + MAX_YEARS_AHEAD}${today.slice(4, 7)}`)) {
    return { status: 400, error: 'This month is too far in the past or in the future. Please check the year.' };
  }
  const fees = {};
  for (const status of FEE_STATUSES) {
    const amount = input?.fees?.[status];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return { status: 400, error: 'Please enter a fee of 0 or more for every status.' };
    if (amount > MAX_FEE) return { status: 400, error: 'This fee is too high. Please check the amount.' };
    fees[status] = roundCents(amount);
  }
  let replaces = null;
  if (input?.replaces !== undefined && input.replaces !== null) {
    replaces = parseMonth(input.replaces);
    if (!replaces || !schedule.changes.some((change) => change.from === replaces)) return { status: 404, error: 'There is no change of the fees from this month.' };
    // the fees from the beginning are edited as such, a change always has its month
    if (fromStart) return { status: 400, error: 'Please choose the month the fees count from.' };
    if (replaces !== from && schedule.changes.some((change) => change.from === from)) return { status: 409, error: 'There already is a change of the fees from this month.' };
  }
  const next = withFeeChange(schedule, { from, fees, replaces });
  if (!changedFees(schedule, next).length) return { status: 409, error: 'These are the fees that already count for this time.' };
  if (next.changes.length > MAX_CHANGES) return { status: 400, error: 'There are too many changes of the fees. Please take back one that is no longer needed.' };
  return { change: { from, fees, replaces } };
}

/** Checks that there is a change from [value] to take back. Returns { from }, or { status, error }. */
function checkFeeRemoval(schedule, value) {
  const from = parseMonth(value);
  if (!from || !schedule.changes.some((change) => change.from === from)) return { status: 404, error: 'There is no change of the fees from this month.' };
  return { from };
}

/**
 * The months that cost something else in [after] than in [before], as stretches with the same fees before and
 * after, the earliest first: { first, last, before, after } - first null: from the beginning, last null: open end.
 */
function changedFees(before, after) {
  const bounds = [...new Set([...before.changes, ...after.changes].map((change) => monthIndexOf(change.from)))].sort((a, b) => a - b);
  const stretches = [];
  for (let i = -1; i < bounds.length; i += 1) {
    const [first, next] = [i < 0 ? null : bounds[i], i + 1 < bounds.length ? bounds[i + 1] : null];
    // any month of the stretch says what all of them cost
    const probe = first === null ? (next === null ? 0 : next - 1) : first;
    const [was, is] = [feesInMonth(before, probe), feesInMonth(after, probe)];
    if (sameFees(was, is)) continue;
    const previous = stretches[stretches.length - 1];
    if (previous && previous.until === first && sameFees(previous.before, was) && sameFees(previous.after, is)) {
      previous.until = next;
    } else {
      stretches.push({ from: first, until: next, before: was, after: is });
    }
  }
  return stretches.map(({ from, until, before: was, after: is }) => ({
    first: from === null ? null : monthOf(from),
    last: until === null ? null : monthOf(until - 1),
    before: was,
    after: is
  }));
}

/**
 * The history as it reads on [today]: the fees of this month and since which month they have counted (null: from the
 * beginning), the next month from which other fees will count, and every entry (the fees from the beginning first)
 * with what it is - 'current' (counts this month), 'planned' (its month is still to come) or 'past'. An entry that
 * changes nothing at the moment is neither "since" nor "next".
 */
function describeFeeSchedule(schedule, today, { withDetails = false } = {}) {
  const month = today.slice(0, 7);
  const current = schedule.changes.filter((change) => change.from <= month).pop() || null;
  const changesSomething = (change) => !sameFees(change.fees, feesInMonth(schedule, monthIndexOf(change.from) - 1));
  const since = schedule.changes.filter((change) => change.from <= month && changesSomething(change)).pop() || null;
  const next = schedule.changes.find((change) => change.from > month && changesSomething(change)) || null;
  const state = (from) => (from !== null && from > month ? 'planned' : from === (current ? current.from : null) ? 'current' : 'past');
  return {
    month,
    current: current ? current.fees : schedule.base,
    since: since ? since.from : null,
    next: next ? { from: next.from, fees: next.fees } : null,
    entries: [
      { from: null, fees: schedule.base, state: state(null) },
      ...schedule.changes.map((change) => ({
        from: change.from,
        fees: change.fees,
        state: state(change.from),
        ...(withDetails ? { setAt: change.setAt, setByName: change.setByName } : {})
      }))
    ]
  };
}

/**
 * What an app without the history means when it saves the fee settings [value] in [month]: the fees in it that are
 * not those of this month, to count from this month on - or null when it changes no fee. Only real amounts are
 * taken: anything else in a fee's place keeps what the fee is.
 */
function feesFromSettings(schedule, value, month) {
  const current = feesInMonth(schedule, month);
  const fees = {};
  for (const status of SETTINGS_FEE_KEYS) {
    const amount = value?.[status];
    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= MAX_FEE) fees[status] = roundCents(amount);
  }
  return Object.keys(fees).some((status) => fees[status] !== (current[status] || 0)) ? fees : null;
}

module.exports = {
  FEE_SCHEDULE_STATE_KEY,
  FEE_STATUSES,
  parseMonth,
  monthOf,
  addMonths,
  sameFees,
  normalizeFeeSchedule,
  normalizeFeeScheduleLog,
  withFeeLogEntry,
  scheduleFromLegacy,
  schedulePeriods,
  feesInMonth,
  feeScheduleVersion,
  withFeeChange,
  withoutFeeChange,
  checkFeeChange,
  checkFeeRemoval,
  changedFees,
  describeFeeSchedule,
  feesFromSettings
};
