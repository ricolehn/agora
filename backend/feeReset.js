// CALDERA: a fresh start for all fee accounts on a day the admins choose.
//
// The fee calculation (derivedData.js) counts every month since "member since" against every payment a member ever
// made. A fresh start closes that account on a chosen day and opens a new
// one: whoever was behind starts from zero (the open fees are dropped), whoever had paid ahead takes exactly that
// credit along, and from that day on months and payments are counted anew. Nothing is deleted or rewritten for it -
// payments, the status history, the cash balance and "member since" stay what they are, the calculation just draws
// a line. So the day may lie in the past or in the future (it applies from that day on), a later fresh start draws
// the next line, and one set by mistake can be taken back.
//
// What a month costs is not the fresh start's business: the fees have a history of their own, in which every change
// says from which month it counts (feeSchedule.js). Before that history there was one fee for all time, and a fresh
// start kept the fees that were set when it was confirmed for the time before it (feesBefore). The history of an
// instance from then is read off these kept fees (feePeriods, scheduleFromLegacy), and they are still recorded with
// every fresh start: what the months before it cost when it was set.
//
// The days live in a state value of their own: the fee settings are written as a whole by every admin screen and by
// older apps, which would silently drop a field they do not know. They only change through the confirmed admin calls
// in routes/finance.js. Everything in this file is pure (no database), so the routes, the calculation and the tests
// share one set of rules.
const { toDateStr } = require('./utils/date');

const FEE_RESET_STATE_KEY = 'feeResets';
// Guards against a mistyped year, not limits of the feature
const EARLIEST_RESET_DAY = '2000-01-01';
const MAX_RESET_YEARS_AHEAD = 10;
const MAX_LOG_ENTRIES = 100;

/** [value] as a real calendar day 'YYYY-MM-DD', or null: no other spelling, no 2027-02-30. */
function parseDay(value) {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : null;
}

/** An amount as it is stored (a number, or old text like "1.234,50"); anything else counts as nothing. */
function paymentAmount(value) {
  const amount = Number(String(value || 0).replace(/\.(?=.*,)/g, '').replace(',', '.'));
  return Number.isFinite(amount) ? amount : 0;
}

/**
 * The monthly fees in the fee settings (status → amount): the entries the fee calculation reads, in whole cents (a
 * fee an app worked out can carry a fraction of a cent that nobody entered).
 */
function monthlyFees(settings) {
  const fees = {};
  for (const [status, amount] of Object.entries(settings && typeof settings === 'object' ? settings : {})) {
    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) fees[status] = Math.round(amount * 100) / 100;
  }
  return fees;
}

const text = (value) => (typeof value === 'string' ? value : '');
const moment = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);

/** The stored fresh starts as a clean list: real days only, each day once, the earliest first. */
function normalizeFeeResets(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.resets) ? value.resets : [];
  const byDay = new Map();
  for (const entry of list) {
    const date = parseDay(typeof entry === 'string' ? entry : entry?.date);
    if (!date || byDay.has(date)) continue;
    const fees = monthlyFees(entry?.feesBefore);
    byDay.set(date, {
      date,
      feesBefore: Object.keys(fees).length ? fees : null,
      setAt: moment(entry?.setAt),
      setBy: text(entry?.setBy),
      setByName: text(entry?.setByName)
    });
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Who set or took back which fresh start when (the newest last); what is not a log entry is left out. */
function normalizeFeeResetLog(value) {
  return (Array.isArray(value?.log) ? value.log : [])
    .filter((entry) => entry && ['set', 'removed'].includes(entry.action) && parseDay(entry.date))
    .map((entry) => ({ action: entry.action, date: entry.date, at: moment(entry.at), by: text(entry.by), byName: text(entry.byName) }))
    .slice(-MAX_LOG_ENTRIES);
}

/** A day's month as one number (year * 12 + month), the way the fee calculation counts months. */
const monthIndexOf = (day) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;

/**
 * What each month cost before the fees had a history (feeSchedule.js): the months before the month of a fresh
 * start - a planned one too - keep the monthly fees confirmed with it, the months from the latest one on cost what
 * is set now ([settings]). Returned as periods, the earliest first: { beforeMonth, fees } holds for the months below
 * beforeMonth. A fresh start without fees of its own takes those of the time after it.
 */
function feePeriods(resets, settings) {
  const periods = [{ beforeMonth: Infinity, fees: monthlyFees(settings) }];
  const all = normalizeFeeResets(resets);
  for (let i = all.length - 1; i >= 0; i -= 1) {
    periods.unshift({ beforeMonth: monthIndexOf(all[i].date), fees: all[i].feesBefore || periods[0].fees });
  }
  return periods;
}

/** The monthly fees of the month [month] (year * 12 + month) in [periods]; without a month (a record without a start) those set now. */
function feesOfMonth(periods, month) {
  return (periods.find((period) => month < period.beforeMonth) || periods[periods.length - 1]).fees;
}

/** The days on [today] that have come, the earliest first: on each of them the fee accounts were settled. */
function settledFeeResets(resets, today) {
  return normalizeFeeResets(resets).map((reset) => reset.date).filter((date) => date <= today);
}

/**
 * The monthly fees a fresh start on [date] keeps for the time before it, on data from before the fees had a history:
 * what the month before its month costs as things are stored now - setting a fresh start changes the price of no
 * month.
 */
function feesBeforeDay(resets, settings, date) {
  const others = normalizeFeeResets(resets).filter((reset) => reset.date !== date);
  return feesOfMonth(feePeriods(others, settings), monthIndexOf(date) - 1);
}

/** The day the fee accounts count from on [today]: the latest fresh start whose day has come, or null. */
function activeFeeReset(resets, today) {
  let active = null;
  for (const reset of Array.isArray(resets) ? resets : []) {
    const date = parseDay(typeof reset === 'string' ? reset : reset?.date);
    if (date && date <= today && (active === null || date > active)) active = date;
  }
  return active;
}

/** Start of the membership as a day, or null when the record has none that can be read. */
function memberStartDay(person) {
  const since = person?.originalMemberSince || person?.memberSince;
  return since && !Number.isNaN(new Date(since).getTime()) ? toDateStr(since) : null;
}

/** Each fresh start with what it is on [today]: 'active' (counted from), 'scheduled' (still to come) or 'replaced'. */
function describeFeeResets(resets, today, { withDetails = false } = {}) {
  const active = activeFeeReset(resets, today);
  return resets.map((reset) => ({
    date: reset.date,
    state: reset.date > today ? 'scheduled' : reset.date === active ? 'active' : 'replaced',
    ...(withDetails ? { feesBefore: reset.feesBefore, setAt: reset.setAt, setByName: reset.setByName } : {})
  }));
}

/**
 * Checks the day an admin wants the fresh start on. Returns { date }, or { status, error } with an English text
 * (translated with the answer, see i18n.js).
 */
function checkNewFeeReset(resets, value, today) {
  const date = parseDay(value);
  if (!date) return { status: 400, error: 'Please choose a valid day for the fresh start.' };
  const latest = `${Number(today.slice(0, 4)) + MAX_RESET_YEARS_AHEAD}${today.slice(4)}`;
  if (date < EARLIEST_RESET_DAY || date > latest) {
    return { status: 400, error: 'This day is too far in the past or in the future. Please check the year.' };
  }
  if (resets.some((reset) => reset.date === date)) return { status: 409, error: 'There already is a fresh start on this day.' };
  return { date };
}

/** The log with one more entry (only the newest are kept). */
function withLogEntry(log, entry) {
  return [...log, entry].slice(-MAX_LOG_ENTRIES);
}

module.exports = {
  FEE_RESET_STATE_KEY,
  parseDay,
  paymentAmount,
  monthlyFees,
  normalizeFeeResets,
  normalizeFeeResetLog,
  monthIndexOf,
  feePeriods,
  feesOfMonth,
  settledFeeResets,
  feesBeforeDay,
  activeFeeReset,
  memberStartDay,
  describeFeeResets,
  checkNewFeeReset,
  withLogEntry,
  text,
  moment
};
