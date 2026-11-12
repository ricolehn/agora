// CALDERA: what is stored about the fees, and the three ways it changes.
//
// Three state values belong together: the fees over time (feeSchedule.js), the fresh starts (feeReset.js) and the fee
// settings, which older apps read and write as a whole. This file reads them as one and changes them in the right
// order. It only knows a store ({ get(key), set(key, value) }), so the rules run against the database
// (pocketbase.js, one change at a time) and against a plain map in the tests.
//
//   - The fees over time are the truth about what a month costs. An instance from before them has none stored: its
//     history is read off the fresh starts and the fee settings every time (stored: false) and written down with the
//     first change of any of the three - before that change, so it never moves a price by the way.
//   - A fresh start, set or taken back, changes the price of no month.
//   - The fee settings keep the fees of the current month, for older apps and servers to read. They are written with
//     every change; reading them, the server gives the fees of the month it is then (a change may have come into
//     effect since). An app that saves them with other fees means: from this month on.
const { FEE_RESET_STATE_KEY, normalizeFeeResets, normalizeFeeResetLog } = require('./feeReset');
const {
  FEE_SCHEDULE_STATE_KEY,
  normalizeFeeSchedule,
  normalizeFeeScheduleLog,
  scheduleFromLegacy,
  feesInMonth,
  feesFromSettings,
  withFeeChange,
  withFeeLogEntry
} = require('./feeSchedule');

const SETTINGS_STATE_KEY = 'settings';
const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** Everything stored about the fees: { settings, resets, resetLog, schedule, log, stored }. */
async function readFeeState(store) {
  const [scheduleValue, resetValue, settingsValue] = await Promise.all([
    store.get(FEE_SCHEDULE_STATE_KEY),
    store.get(FEE_RESET_STATE_KEY),
    store.get(SETTINGS_STATE_KEY)
  ]);
  const settings = asObject(settingsValue);
  const resets = normalizeFeeResets(resetValue);
  const schedule = normalizeFeeSchedule(scheduleValue);
  return {
    settings,
    resets,
    resetLog: normalizeFeeResetLog(resetValue),
    schedule: schedule || scheduleFromLegacy(resets, settings),
    log: schedule ? normalizeFeeScheduleLog(scheduleValue) : [],
    stored: Boolean(schedule)
  };
}

/** The fee settings as an app reads them on [today]: what is stored, with the fees of this month. */
function settingsOn(state, today) {
  return { ...state.settings, ...feesInMonth(state.schedule, today) };
}

async function storeSchedule(store, state, today) {
  await store.set(FEE_SCHEDULE_STATE_KEY, { base: state.schedule.base, changes: state.schedule.changes, log: state.log });
  await store.set(SETTINGS_STATE_KEY, settingsOn(state, today));
}

/**
 * Changes the fees over time: [change] gets the state and returns the next { schedule, log } (or throws to refuse).
 * Returns the state after it.
 */
async function changeFeeSchedule(store, change, today) {
  const state = await readFeeState(store);
  const next = { ...state, ...(await change(state)), stored: true };
  await storeSchedule(store, next, today);
  return next;
}

/**
 * Changes the fresh starts: [change] gets { resets, log } and the fees over time and returns the next
 * { resets, log } (or throws to refuse). A history that was still read off the fresh starts is written down first.
 */
async function changeFeeResets(store, change, today) {
  const state = await readFeeState(store);
  if (!state.stored) await storeSchedule(store, state, today);
  const next = await change({ resets: state.resets, log: state.resetLog }, state.schedule);
  await store.set(FEE_RESET_STATE_KEY, { resets: next.resets, log: next.log });
  return next;
}

/**
 * An app saves the fee settings [value] as a whole. Fees in it that are not those of this month are a change of the
 * fees from this month on, by [actor] ({ by, byName }) at the moment [at]; everything else in it is stored as it
 * comes. Returns the state after it, with feesChangedFrom: the month, when it changed a fee (else null).
 */
async function saveFeeSettings(store, value, actor, today, at) {
  const state = await readFeeState(store);
  const from = today.slice(0, 7);
  const fees = feesFromSettings(state.schedule, value, from);
  const next = { ...state, settings: asObject(value), stored: true, feesChangedFrom: fees ? from : null };
  if (fees) {
    next.schedule = withFeeChange(state.schedule, { from, fees, replaces: null, setAt: at, setBy: actor.by, setByName: actor.byName });
    next.log = withFeeLogEntry(state.log, { action: 'set', from, fees: feesInMonth(next.schedule, from), movedFrom: null, at, by: actor.by, byName: actor.byName });
  }
  await storeSchedule(store, next, today);
  return next;
}

module.exports = {
  readFeeState,
  settingsOn,
  changeFeeSchedule,
  changeFeeResets,
  saveFeeSettings
};
