// Years of a community, lived through - and every number compared with a second set of books (feeBooks.js).
//
// The fee tests elsewhere ask single questions on single days. Here everything that can happen happens, in an order
// nobody planned: members join (also after the fact, or for a day still to come), change their status, pay early,
// late, twice, ahead or never, have standing orders booked, get payments corrected or deleted, leave. The admins set
// fees for months to come and for months past, edit, move and take back what they set, correct the fees from the
// beginning, start the accounts afresh and take that back - and an older app saves a fee without a month. On every
// day of twelve years the numbers the apps show for every member (the balance, what is open, "paid until", the fee
// of the month, what a fresh start dropped or carried over) and what the fees page shows must be what the second
// books say; what an admin is shown before saving must be what then happens; and on a day on which nothing happened
// to a member, nothing of theirs may have moved.
//
// Which community is lived through is decided by a number (the seed): the same number, the same years. Two run with
// every test run: one with amounts in whole euros, and one that comes from before the fees had a history and counts
// to the cent. More - for a long look - with YEARS_SEEDS: "YEARS_SEEDS=1-200" lives through the communities 1 to
// 200, "YEARS_SEEDS=17,23" through these two; YEARS_LENGTH sets the years (12).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const books = require('./feeBooks');
const { preprocessPersonServerSide, feeChangeImpact, feeResetImpact } = require('../backend/derivedData');
const feeReset = require('../backend/feeReset');
const feeSchedule = require('../backend/feeSchedule');
const feeState = require('../backend/feeState');
const { checkAndExecuteStandingOrders } = require('../backend/standingOrders');

const webApp = () => import(pathToFileURL(path.join(__dirname, '..', 'assets', 'finance.js')).href);
const { cents, monthOf, addMonths, addDays } = books;

const SEEDS = !process.env.YEARS_SEEDS ? [1, 6] : process.env.YEARS_SEEDS.split(',').flatMap((part) => {
  const [first, last = first] = part.split('-').map(Number);
  return Number.isInteger(first) && Number.isInteger(last) ? Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i) : [];
});
const YEARS = Number(process.env.YEARS_LENGTH) || 12;
const FIRST_DAY = '2026-11-01';
const STATUSES = ['vollverdiener', 'geringverdiener', 'keinverdiener', 'pausiert'];
const FEE_STATUSES = ['vollverdiener', 'geringverdiener', 'keinverdiener'];
// The months a look at the fees goes through: well before the first member and well after the last day
const MONTHS_TO_LOOK_AT = [];
for (let month = '2015-01'; month <= '2045-12'; month = addMonths(month, 1)) MONTHS_TO_LOOK_AT.push(month);

/** The same numbers for the same seed. */
function dice(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const int = (low, high) => low + Math.floor(next() * (high - low + 1));
  return { chance: (p) => next() < p, int, pick: (list) => list[int(0, list.length - 1)] };
}

// Comparisons whose message is only put together when they fail (the messages quote what happened lately, and there
// are a hundred thousand comparisons a run)
function same(actual, expected, message) {
  try {
    assert.deepEqual(actual, expected);
  } catch (error) {
    error.message = `${message()}\n${error.message}`;
    throw error;
  }
}
const must = (holds, message) => { if (!holds) assert.fail(message()); };

/** "Now" is noon on the day the test says, until the test is over. */
function ownClock(t) {
  const RealDate = global.Date;
  let now = RealDate.now();
  class DateOfTheDay extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  global.Date = DateOfTheDay;
  t.after(() => { global.Date = RealDate; });
  return { set(day) { now = new RealDate(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 12).getTime(); } };
}

/**
 * Lives through [years] years of the community [seed] and compares, day by day, what the server works out with the
 * second books. Returns what happened how often. [watch], when given, is called at the end of every day with what
 * is stored and what is in the books - for whoever wants to look at the same days through something else.
 */
async function liveThrough(t, seed, years, watch = null) {
  const { applyApprovedRequest, applyStatusChangeToHistory } = await webApp();
  const { chance, int, pick } = dice(seed);
  const clock = ownClock(t);
  const happened = {};
  const count = (what) => { happened[what] = (happened[what] || 0) + 1; };
  // For the message of a failed comparison: what happened lately, to everyone and to the member
  const diary = [];
  const write = (day, who, what) => { diary.push(`${day} ${who}: ${what}`); if (diary.length > 4000) diary.shift(); };
  const lately = (who) => diary.filter((line) => line.includes(` ${who}: `) || line.includes(' admin: ')).slice(-14).join('\n  ');

  // --- What is stored: a plain map in the place of the database, written by the server's own rules (feeState.js) ---
  const map = new Map();
  let written = true;
  const store = { get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : null), set: async (key, value) => { map.set(key, structuredClone(value)); written = true; } };
  const admin = { by: 'u-admin', byName: 'Olga Owner' };
  // Amounts as the community has them: whole euros, halves, or - in every third community - to the cent
  const step = seed % 3 === 0 ? 0.01 : pick([1, 1, 0.5]);
  const amount = (low, high) => Math.round(int(Math.round(low / step), Math.round(high / step)) * step * 100) / 100;
  const firstFees = { vollverdiener: amount(30, 70), geringverdiener: amount(15, 30), keinverdiener: pick([0, amount(5, 12)]), pausiert: 0 };
  const paper = books.openBooks(firstFees);
  if (seed % 2 === 0) {
    // An instance from before the fees had a history: a fresh start in July 2026 kept the fees of the time before it,
    // other fees were set since. Its history is read off that, and written down with the first change
    const since = { ...firstFees, vollverdiener: Math.round((firstFees.vollverdiener + amount(3, 10)) * 100) / 100 };
    // where the community counts to the cent, the fee was worked out by an app and carries a fraction of a cent
    // nobody entered (58.769999999999996): it is still 58.77
    for (let i = 0; step === 0.01 && i < 50 && since.vollverdiener === Math.round(since.vollverdiener * 100) / 100; i += 1) since.vollverdiener = ((since.vollverdiener + 0.01) * 1.1) / 1.1;
    map.set('settings', { ...since, reportStartDate: null });
    map.set('feeResets', { resets: [{ date: '2026-07-01', feesBefore: firstFees, setAt: 1, setBy: admin.by, setByName: admin.byName }], log: [] });
    books.noteFeesFrom(paper, '2026-07', since);
    books.noteFreshStart(paper, '2026-07-01');
  } else {
    map.set('settings', { ...firstFees, reportStartDate: null });
  }
  let state = await feeState.readFeeState(store);
  assert.equal(state.stored, false, 'the history is only written down with the first change');

  // --- The members: the record as the apps write it, and the plain facts on paper ---
  const records = {};
  const habits = {};
  const stored = {};
  let touched = new Set();
  let newKey = 0;
  const touch = (id) => { touched.add(id); delete stored[id]; };
  // As the server reads a record: the payments in the order of their days, what was paid added up from them
  const asStored = (id) => {
    if (!stored[id]) {
      const payments = [...records[id].payments].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
      stored[id] = { ...structuredClone(records[id]), payments, totalPaid: payments.reduce((sum, payment) => sum + Number(payment.amount), 0) };
    }
    return stored[id];
  };
  const everyone = () => Object.keys(records);
  const members = () => everyone().filter((id) => !paper.members[id].gone);
  const feeOf = (id, day) => books.feeFor(paper, id, monthOf(day)) / 100;

  function join(day, since, status, habit, extra = {}) {
    const id = `m${everyone().length + 1}`;
    records[id] = { id, uid: `u-${id}`, name: `Member ${id}`, status, memberSince: since, originalMemberSince: since, statusHistory: [{ status, startDate: since }], payments: [], standingOrders: [], totalPaid: 0, ...extra };
    habits[id] = { kind: habit, dayOfMonth: int(1, 28) };
    books.noteMember(paper, id, since, status);
    if (extra.pays === false) paper.members[id].free = true;
    touch(id);
    count('a member joins');
    write(day, id, `joins, member since ${since} as ${status}, pays ${habit}`);
    return id;
  }

  function pay(day, id, sum, dated = day, how = 'booked') {
    const key = `k${newKey += 1}`;
    if (how === 'request') {
      // a member's request, approved by the treasury: booked by the web app's own code
      records[id] = applyApprovedRequest(records[id], { id: key, type: 'payment', data: { amount: String(sum), date: dated } }, 'Beitrag');
      books.notePayment(paper, id, `req_${key}`, dated, sum);
    } else {
      records[id].payments.push({ id: key, amount: sum, date: dated, description: 'Beitrag' });
      books.notePayment(paper, id, key, dated, sum);
    }
    touch(id);
    count(dated < day ? 'a payment is booked for a day past' : dated > day ? 'a payment is booked for a day to come' : 'a payment is booked');
    write(day, id, `pays ${sum} dated ${dated}`);
  }

  function changeStatus(day, id, status, from) {
    records[id] = applyStatusChangeToHistory(records[id], status, from);
    books.noteStatus(paper, id, from, status);
    touch(id);
    count(from < day ? 'a status changes after the fact' : from > day ? 'a status changes for a day to come' : 'a status changes');
    write(day, id, `is ${status} from ${from}`);
  }

  // --- The beginning: eight members with their years so far ---
  for (const habit of ['punctual', 'punctual', 'late', 'order', 'yearly', 'sporadic', 'never', 'catching up']) {
    const since = `${int(2019, 2026)}-${String(int(1, 9)).padStart(2, '0')}-${String(int(2, 28)).padStart(2, '0')}`;
    const id = join(FIRST_DAY, since, pick(['vollverdiener', 'vollverdiener', 'vollverdiener', 'geringverdiener', 'keinverdiener']), habit);
    // what they paid so far: some every month, some most months, some little
    const diligence = { punctual: 1, late: 1, order: 1, yearly: 1, sporadic: 0.5, never: 0, 'catching up': 0.25 }[habit];
    for (let month = monthOf(since); month < monthOf(FIRST_DAY); month = addMonths(month, 1)) {
      if (chance(diligence)) pay(FIRST_DAY, id, feeOf(id, `${month}-28`), `${month}-${String(int(1, 28)).padStart(2, '0')}`);
    }
    if (habit === 'order') {
      const last = addMonths(monthOf(FIRST_DAY), -1);
      records[id].standingOrders.push({ id: `so-${id}`, amount: feeOf(id, FIRST_DAY), startDate: `${monthOf(since)}-${String(habits[id].dayOfMonth).padStart(2, '0')}`, note: 'Dauerauftrag', lastAutoPayment: `${last}-${String(habits[id].dayOfMonth).padStart(2, '0')}` });
    }
  }
  join(FIRST_DAY, '2024-03-15', 'vollverdiener', 'never', { pays: false });

  // --- What the admins do: checked and saved by the rules the routes use, and noted on paper ---
  const people = () => everyone().map((id) => asStored(id));
  const paying = () => everyone().filter((id) => !paper.members[id].gone && !paper.members[id].free);
  /** By how much each paying member owes more or less on [day] in the books [now] than in [was]. */
  const sides = (was, now, day) => {
    const more = { count: 0, total: 0 };
    const less = { count: 0, total: 0 };
    for (const id of paying()) {
      const difference = books.accountOf(now, id, day).balance - books.accountOf(was, id, day).balance;
      if (difference < 0) { more.count += 1; more.total += -difference; }
      if (difference > 0) { less.count += 1; less.total += difference; }
    }
    return { more: { count: more.count, total: more.total / 100 }, less: { count: less.count, total: less.total / 100 } };
  };
  const pricesDiffer = (a, b) => MONTHS_TO_LOOK_AT.some((month) => !books.sameFees(books.feesIn(a, month), books.feesIn(b, month)));

  /** A change of the fees ([body] as the route takes it), with what it does noted by [note]. Returns why it was refused, or null. */
  async function changeFees(day, body, note, what) {
    state = await feeState.readFeeState(store);
    const before = state.schedule;
    const was = structuredClone(paper);
    const now = structuredClone(paper);
    note(now);
    let after;
    let line;
    if (body.remove) {
      const check = feeSchedule.checkFeeRemoval(before, body.from);
      assert.ok(!check.error, `seed ${seed}, ${day}: ${what}: ${check.error}`);
      after = feeSchedule.withoutFeeChange(before, check.from);
      line = { action: 'removed', from: check.from, fees: null, movedFrom: null };
    } else {
      const check = feeSchedule.checkFeeChange(before, body, day);
      if (check.error) {
        // refused: because no month would cost anything else, or because the month is taken or out of reach
        if (check.error.startsWith('These are the fees')) assert.equal(pricesDiffer(was, now), false, `seed ${seed}, ${day}: ${what} was refused as changing nothing, but the books say it changes a price`);
        else assert.ok([400, 409].includes(check.status), `seed ${seed}, ${day}: ${what} was refused: ${check.error}`);
        count('a change of the fees is refused');
        return check.error;
      }
      assert.equal(pricesDiffer(was, now), true, `seed ${seed}, ${day}: ${what} was accepted, but the books say no month costs anything else`);
      after = feeSchedule.withFeeChange(before, { ...check.change, setAt: 1, setBy: admin.by, setByName: admin.byName });
      line = { action: 'set', from: check.change.from, fees: null, movedFrom: null };
    }
    // what the admin is shown before saving ...
    const shown = feeChangeImpact(people(), state.resets, before, after, day);
    await feeState.changeFeeSchedule(store, (current) => ({ schedule: after, log: feeSchedule.withFeeLogEntry(current.log, { ...line, at: 1, ...admin }) }), day);
    note(paper);
    // ... is what the books say happens: who owes how much more or less today, and which months cost something else
    const where = `seed ${seed}, ${day}: ${what}`;
    same([shown.more, shown.less, shown.members], [...Object.values(sides(was, paper, day)), paying().length], () => `${where}: the numbers shown before saving\n  ${lately('nobody')}`);
    for (const month of MONTHS_TO_LOOK_AT) {
      const [wasFees, isFees] = [books.feesIn(was, month), books.feesIn(paper, month)];
      const stretch = shown.stretches.find((s) => (s.first === null || s.first <= month) && (s.last === null || month <= s.last));
      if (books.sameFees(wasFees, isFees)) must(stretch === undefined, () => `${where}: ${month} is shown as costing something else (${JSON.stringify(stretch)}), in the books it costs ${JSON.stringify(isFees)} as before\n  the changes before: ${JSON.stringify(was.fees.changes)}\n  ${lately('nobody')}`);
      else must(stretch && books.sameFees(stretch.before, wasFees) && books.sameFees(stretch.after, isFees), () => `${where}: ${month} costs something else, shown: ${JSON.stringify(stretch)}`);
    }
    assert.equal(shown.inEffect, shown.stretches.some((s) => s.first === null || s.first <= monthOf(day)), `${where}: in effect`);
    if (!shown.inEffect) assert.deepEqual([shown.more.count, shown.less.count], [0, 0], `${where}: still to come, it moves no account today`);
    // (a change that says nothing at the moment can be taken back: then no month costs anything else)
    const first = shown.stretches.length ? shown.stretches[0].first : undefined;
    const reached = first === undefined ? null : paper.freshStarts.filter((line2) => line2 <= day && (first === null || monthOf(line2) > first)).sort().pop() || null;
    assert.equal(shown.freshStart, reached, `${where}: the fresh start it reaches back before`);
    everyone().forEach(touch);
    count(what.split(':')[0]);
    write(day, 'admin', what);
    return null;
  }

  async function freshStart(day, date, remove) {
    state = await feeState.readFeeState(store);
    const what = remove ? `the fresh start of ${date} is taken back` : `a fresh start is set for ${date}`;
    if (!remove && feeReset.checkNewFeeReset(state.resets, date, day).error) return;
    const was = structuredClone(paper);
    const shown = feeResetImpact(people(), state.settings, state.resets, date, day, state.schedule);
    await feeState.changeFeeResets(store, (current, schedule) => (remove
      ? { resets: current.resets.filter((reset) => reset.date !== date), log: current.log }
      : { resets: feeReset.normalizeFeeResets([...current.resets, { date, feesBefore: feeSchedule.feesInMonth(schedule, feeReset.monthIndexOf(date) - 1), setAt: 1, setBy: admin.by, setByName: admin.byName }]), log: current.log }), day);
    if (remove) books.noteFreshStartTakenBack(paper, date);
    else books.noteFreshStart(paper, date);
    // shown before confirming: whose open fees it drops (or, taken back, who owes them again), whose credit is
    // carried over on its day - and that it changes the price of no month
    const [withIt, without] = remove ? [was, paper] : [paper, was];
    const shows = remove || date <= day ? day : date;
    const dropped = sides(withIt, without, shows).more;
    const ahead = paying().map((id) => books.accountOf(withIt, id, date).carriedOver).filter((credit) => credit > 0);
    const where = `seed ${seed}, ${day}: ${what}`;
    same([shown.behind, shown.ahead, shown.owesMore, shown.repriced, shown.inEffect],
      [dropped, { count: ahead.length, total: ahead.reduce((sum, credit) => sum + credit, 0) / 100 }, { count: 0, total: 0 }, false, date <= day], () => `${where}: the numbers shown before confirming\n  ${lately('nobody')}`);
    everyone().forEach(touch);
    count(remove ? 'a fresh start is taken back' : date > day ? 'a fresh start is planned' : 'a fresh start is set for a day that has come');
    write(day, 'admin', what);
  }

  const otherFees = (table) => {
    const fees = {};
    for (const status of FEE_STATUSES) fees[status] = chance(status === 'vollverdiener' ? 0.9 : 0.4) ? Math.max(0, Math.round((table[status] + amount(-8, 12)) * 100) / 100) : table[status];
    return fees;
  };

  async function adminsDay(day) {
    const month = monthOf(day);
    const changes = () => Object.keys(paper.fees.changes).sort();
    // In the instance from before the history, the first thing the admins do is take the fresh start of July back -
    // and set it again a week later: no month may cost anything else for it, although the fees were only read off
    // that fresh start so far
    if (seed % 2 === 0 && day === addDays(FIRST_DAY, 9)) await freshStart(day, '2026-07-01', true);
    if (seed % 2 === 0 && day === addDays(FIRST_DAY, 16)) await freshStart(day, '2026-07-01', false);
    if (chance(0.009)) {
      const kind = pick(['new', 'new', 'new', 'new', 'new', 'edit', 'edit', 'move', 'move', 'take back', 'take back', 'set back', 'like the next', 'like the next', 'beginning', 'app', 'app', 'nonsense']);
      const three = (table) => Object.fromEntries(FEE_STATUSES.map((status) => [status, table[status] || 0]));
      if (kind === 'new') {
        // from next month (most often), this month, a month to come or a month past
        const from = addMonths(month, pick([1, 1, 1, 1, 0, 0, int(2, 14), int(2, 14), -int(1, 30), -int(1, 6)]));
        const fees = otherFees(books.feesIn(paper, from));
        await changeFees(day, { from, fees }, (b) => books.noteFeesFrom(b, from, fees), `fees are set from a month ${from > month ? 'to come' : from === month ? 'that has begun' : 'past'}: ${from} ${JSON.stringify(fees)}`);
      } else if (kind === 'edit' && changes().length) {
        const from = pick(changes());
        const [fees, back] = [otherFees(paper.fees.changes[from]), three(paper.fees.changes[from])];
        const refused = await changeFees(day, { from, fees, replaces: from }, (b) => books.noteFeesFrom(b, from, fees), `a change of the fees is edited: ${from} ${JSON.stringify(fees)}`);
        // edited back and edited again: what else was entered is still there both times
        if (!refused && paper.fees.changes[from] && chance(0.5)) {
          await changeFees(day, { from, fees: back, replaces: from }, (b) => books.noteFeesFrom(b, from, back), `a change of the fees is edited back: ${from}`);
          // (one that said nothing before it was edited says nothing again, and is gone)
          if (paper.fees.changes[from]) await changeFees(day, { from, fees, replaces: from }, (b) => books.noteFeesFrom(b, from, fees), `a change of the fees is edited again: ${from}`);
        }
      } else if (kind === 'move' && changes().length) {
        const from = pick(changes());
        const to = addMonths(from, pick([-1, 1, int(2, 8), -int(2, 8)]));
        const fees = chance(0.5) ? otherFees(paper.fees.changes[from]) : three(paper.fees.changes[from]);
        if (changes().includes(to)) {
          // another change counts from that month: refused, nothing is lost
          assert.equal(feeSchedule.checkFeeChange((await feeState.readFeeState(store)).schedule, { from: to, fees, replaces: from }, day).status, 409);
          count('a change of the fees is refused');
        } else {
          await changeFees(day, { from: to, fees, replaces: from }, (b) => books.noteFeesMoved(b, from, to, fees), `a change of the fees is moved: ${from} to ${to}`);
        }
      } else if (kind === 'set back' && changes().length) {
        // a change is edited to the fees that count before it: it says nothing any more and is gone
        const from = pick(changes());
        const fees = three(books.feesIn(paper, addMonths(from, -1)));
        await changeFees(day, { from, fees, replaces: from }, (b) => books.noteFeesFrom(b, from, fees), `a change of the fees is set back to what it changed: ${from}`);
      } else if (kind === 'like the next' && changes().length > 1) {
        // a change is edited to the fees of the one after it: that one says nothing for now, but it stays - and
        // counts again when the earlier one is edited back
        const all = changes();
        const i = int(0, all.length - 2);
        const [from, fees, back] = [all[i], three(paper.fees.changes[all[i + 1]]), three(paper.fees.changes[all[i]])];
        const refused = await changeFees(day, { from, fees, replaces: from }, (b) => books.noteFeesFrom(b, from, fees), `a change of the fees is edited to the fees of the next one: ${from}`);
        // (where the next one's fees are those that count before this one anyway, it says nothing itself and is gone)
        if (!refused && paper.fees.changes[from] && chance(0.5)) await changeFees(day, { from, fees: back, replaces: from }, (b) => books.noteFeesFrom(b, from, back), `a change of the fees is edited back: ${from}`);
      } else if (kind === 'take back' && changes().length) {
        const from = pick(changes());
        await changeFees(day, { from, remove: true }, (b) => books.noteFeesTakenBack(b, from), `a change of the fees is taken back: ${from}`);
      } else if (kind === 'beginning') {
        const fees = otherFees(paper.fees.start);
        await changeFees(day, { from: null, fees }, (b) => books.noteFeesFromTheBeginning(b, fees), `the fees from the beginning are corrected: ${JSON.stringify(fees)}`);
      } else if (kind === 'app') {
        // an app without the history saves the fee settings as it read them, with one fee changed: from this month on
        state = await feeState.readFeeState(store);
        const read = feeState.settingsOn(state, day);
        // (the first time it is the fee of paused members, which no screen has a field for: every later change has
        // to take it along)
        const status = happened['an older app saves a fee'] ? pick(FEE_STATUSES) : 'pausiert';
        const fee = Math.max(0, Math.round((read[status] + amount(1, 9)) * 100) / 100);
        const saved = await feeState.saveFeeSettings(store, { ...read, [status]: fee }, admin, day, 1);
        assert.equal(saved.feesChangedFrom, month);
        books.noteFeesFrom(paper, month, { [status]: fee });
        everyone().forEach(touch);
        count('an older app saves a fee');
        write(day, 'admin', `an older app saves ${status} ${fee}`);
        // saved once more as it reads now (the older screens save every field): nothing changes
        state = await feeState.readFeeState(store);
        assert.equal((await feeState.saveFeeSettings(store, feeState.settingsOn(state, day), admin, day, 1)).feesChangedFrom, null);
      } else if (kind === 'nonsense') {
        // a month that is none, an amount that is none, a change that is not there: refused, nothing is saved
        state = await feeState.readFeeState(store);
        const fees = otherFees(books.feesIn(paper, month));
        for (const body of [{ from: `${month.slice(0, 4)}-13`, fees }, { from: '1026-01', fees }, { from: addMonths(month, 121), fees }, { from: month, fees: { ...fees, vollverdiener: -1 } }, { from: month, fees: { ...fees, keinverdiener: '10' } }, { from: month, fees, replaces: '2001-01' }]) {
          assert.ok([400, 404].includes(feeSchedule.checkFeeChange(state.schedule, body, day).status), JSON.stringify(body));
        }
        assert.equal(feeSchedule.checkFeeRemoval(state.schedule, '2001-01').status, 404);
        count('a change of the fees is refused');
      }
    }
    if (chance(0.0007)) {
      // a fresh start: for the 1st of next month (most often), for today, for a day past or one in the middle of a month to come
      const date = pick([`${addMonths(month, 1)}-01`, `${addMonths(month, 1)}-01`, `${addMonths(month, int(2, 5))}-01`, day, addDays(day, -int(1, 300)), addDays(day, int(3, 80))]);
      if (!paper.freshStarts.includes(date)) await freshStart(day, date, false);
    }
    if (paper.freshStarts.length && chance(0.0004)) await freshStart(day, pick(paper.freshStarts), true);
  }

  function membersDay(day) {
    const month = monthOf(day);
    const dayOfMonth = Number(day.slice(8));
    // the daily job books the standing orders that are due (the server's own code)
    for (const id of members()) {
      const booked = checkAndExecuteStandingOrders(records[id]);
      if (!booked) continue;
      const known = new Set(records[id].payments.map((payment) => payment.id));
      for (const payment of booked.payments.filter((entry) => !known.has(entry.id))) {
        books.notePayment(paper, id, payment.id, payment.date, payment.amount);
        count('a standing order is booked');
        write(day, id, `standing order books ${payment.amount} dated ${payment.date}`);
      }
      records[id] = booked;
      touch(id);
    }
    for (const id of members()) {
      const habit = habits[id];
      const joined = paper.members[id].since <= day;
      if (joined && habit.dayOfMonth === dayOfMonth) {
        if (habit.kind === 'punctual' && feeOf(id, day) > 0) pay(day, id, feeOf(id, day), day, chance(0.2) ? 'request' : 'booked');
        if (habit.kind === 'late' && feeOf(id, addDays(`${month}-01`, -1)) > 0) pay(day, id, feeOf(id, addDays(`${month}-01`, -1)));
        if (habit.kind === 'yearly' && month.endsWith('-01') && feeOf(id, day) > 0) pay(day, id, Math.round(12 * feeOf(id, day) * 100) / 100);
        if (habit.kind === 'catching up' && chance(0.06)) pay(day, id, amount(100, 900));
      }
      if (joined && habit.kind === 'sporadic' && chance(0.015)) pay(day, id, amount(10, 300));
      // what happens to anyone now and then
      if (chance(0.0015)) pay(day, id, amount(5, 250), addDays(day, -int(5, 500)));
      if (chance(0.0005)) pay(day, id, amount(5, 250), addDays(day, int(1, 45)));
      if (chance(0.0002)) pay(day, id, -amount(5, 50));
      const own = records[id].payments.filter((payment) => !payment.isAuto);
      if (own.length && chance(0.001)) {
        // a payment is corrected: another amount, another day
        const payment = pick(own);
        payment.amount = amount(5, 250);
        if (chance(0.5)) payment.date = addDays(payment.date, int(-40, 40));
        books.notePayment(paper, id, String(payment.id), payment.date, payment.amount);
        touch(id);
        count('a payment is corrected');
        write(day, id, `payment ${payment.id} corrected to ${payment.amount} on ${payment.date}`);
      }
      if (own.length && chance(0.0005)) {
        const payment = pick(own);
        records[id].payments = records[id].payments.filter((entry) => entry !== payment);
        books.notePaymentGone(paper, id, String(payment.id));
        touch(id);
        count('a payment is deleted');
        write(day, id, `payment ${payment.id} deleted`);
      }
      if (chance(0.0008)) {
        const since = paper.members[id].since;
        const from = pick([day, day, addDays(day, -int(1, 400)), addDays(day, -int(1, 60)), addDays(day, int(1, 60))]);
        changeStatus(day, id, pick(STATUSES), from < since ? since : from);
      }
      if (chance(0.0002) && paper.members[id].status.length === 1) {
        // "member since" is corrected, as the admin screen does it
        const since = addDays(paper.members[id].since, int(-200, 200));
        Object.assign(records[id], { memberSince: since, originalMemberSince: since });
        records[id].statusHistory[0].startDate = since;
        books.noteMemberSince(paper, id, since);
        touch(id);
        count('"member since" is corrected');
        write(day, id, `member since corrected to ${since}`);
      }
      if (habit.kind === 'order' && chance(0.002)) {
        // the standing order is brought up to the fee of the month: the old one ends, a new one starts
        const orders = records[id].standingOrders;
        if (orders.length && orders[orders.length - 1].amount !== feeOf(id, day) && feeOf(id, day) > 0) {
          orders[orders.length - 1].endDate = day;
          orders.push({ id: `so-${id}-${day}`, amount: feeOf(id, day), startDate: addDays(day, 1), note: 'Dauerauftrag', lastAutoPayment: null });
          touch(id);
          count('a standing order is changed');
          write(day, id, `standing order now ${feeOf(id, day)}`);
        }
      }
      if (chance(0.00008) && members().length > 6) {
        // the member is deleted: only the name and the payments stay, as the server leaves it
        records[id] = { id, name: records[id].name, isDeleted: true, payments: records[id].payments, totalPaid: records[id].totalPaid };
        paper.members[id].gone = true;
        touch(id);
        count('a member is deleted');
        write(day, id, 'is deleted');
      }
    }
    if (everyone().length < 16 && chance(0.003)) {
      const since = pick([day, day, day, addDays(day, -int(1, 200)), addDays(day, int(1, 60))]);
      join(day, since, pick(['vollverdiener', 'vollverdiener', 'geringverdiener', 'keinverdiener', 'pausiert']), pick(['punctual', 'punctual', 'late', 'sporadic', 'never', 'yearly']));
    }
  }

  // --- Day by day ---
  const lastDay = addDays(`${Number(FIRST_DAY.slice(0, 4)) + years}${FIRST_DAY.slice(4)}`, -1);
  // which quiet days are looked at is drawn apart from what happens: looking closer changes no community
  const look = dice(seed + 7919);
  const lastShown = {};
  let compared = 0;
  let looked = 0;
  for (let day = FIRST_DAY; day <= lastDay; day = addDays(day, 1)) {
    clock.set(day);
    touched = new Set();
    membersDay(day);
    await adminsDay(day);
    // what is stored about the fees, read again whenever it was written
    if (written) state = await feeState.readFeeState(store);
    written = false;

    // the fees page and what older apps read: the fees of this month, since when, and what is still to come
    const page = feeSchedule.describeFeeSchedule(state.schedule, day);
    const onPaper = books.feesPageOf(paper, day);
    must(books.sameFees(page.current, onPaper.current), () => `seed ${seed}, ${day}: the fees of the month ${JSON.stringify(page.current)}, in the books ${JSON.stringify(onPaper.current)}`);
    same([page.since, page.next ? page.next.from : null], [onPaper.since, onPaper.next], () => `seed ${seed}, ${day}: since when the fees count, and from when others\n  ${lately('nobody')}`);
    must(books.sameFees(Object.fromEntries(STATUSES.map((status) => [status, feeState.settingsOn(state, day)[status] || 0])), onPaper.current), () => `seed ${seed}, ${day}: the fees older apps read`);
    same(state.schedule.changes.map((change) => change.from), Object.keys(paper.fees.changes).sort(), () => `seed ${seed}, ${day}: the changes that are kept`);
    same(state.resets.map((reset) => reset.date), [...paper.freshStarts].sort(), () => `seed ${seed}, ${day}: the fresh starts`);

    // Every member, as the apps are served them. On a day on which something can have moved - the 1st, the day of a
    // fresh start, a day on which something happened to the member or to the fees - the numbers must be those of the
    // books. On the other days (three in ten are looked at) they must be what they were
    const quietDay = !day.endsWith('-01') && !paper.freshStarts.includes(day);
    for (const id of everyone()) {
      const quiet = quietDay && !touched.has(id) && lastShown[id] !== undefined;
      if (quiet && !look.chance(0.3)) continue;
      const served = preprocessPersonServerSide(asStored(id), state.settings, state.resets, state.schedule);
      const where = () => `seed ${seed}, ${id} on ${day}`;
      if (paper.members[id].gone) {
        same([served._statusMeta.isOverdue, served._overdueAmount, served._feeReset], [false, 0, null], () => `${where()}: deleted, nothing is owed`);
        lastShown[id] = null;
        continue;
      }
      const paidUntil = new Date(served._paidUntil);
      const shown = {
        balance: cents(served._currentBalance),
        paidUntil: `${paidUntil.getFullYear()}-${String(paidUntil.getMonth() + 1).padStart(2, '0')}`,
        countsFrom: served._feeReset,
        carriedOver: cents(served._feeCarriedOver),
        dropped: cents(served._feeWrittenOff),
        feeThisMonth: cents(served._monthlyFee)
      };
      // every amount is an amount in whole cents, not a sum that drifted
      for (const field of ['_currentBalance', '_overdueAmount', '_overpayment', '_feeCarriedOver', '_feeWrittenOff', '_monthlyFee']) {
        must(Object.is(served[field], Math.round(served[field] * 100) / 100), () => `${where()}: ${field} is ${served[field]}`);
      }
      // what is open is what is owed, less a standing order that is still due this month - never more, never less
      const open = Math.max(0, -(shown.balance + cents(served._anticipatedPayment)));
      same([cents(served._overdueAmount), served._statusMeta.isOverdue, cents(served._overpayment)], [open, open > 0, Math.max(0, shown.balance)], () => `${where()}: what is open\n  ${lately(id)}`);
      if (quiet) same(shown, lastShown[id], () => `${where()}: moved on a day on which nothing happened\n  ${lately(id)}`);
      if (!quiet || look.chance(0.1)) {
        const { open: openOnPaper, ...account } = books.accountOf(paper, id, day);
        same(shown, account, () => `${where()}: served ${JSON.stringify(shown)}, in the books ${JSON.stringify(account)}\n  ${lately(id)}`);
        if (!served._anticipatedPayment) same(cents(served._overdueAmount), openOnPaper, () => `${where()}: open`);
        compared += 1;
      }
      lastShown[id] = shown;
      looked += 1;
    }
    if (watch) await watch({ day, records, stored: map, paper, state });
  }
  return { happened, compared, looked, members: everyone().length };
}

describe('years of a community against a second set of books', () => {
  const everything = {};
  for (const seed of SEEDS) {
    test(`community ${seed}: ${YEARS} years, day by day`, async (t) => {
      const { happened, compared, looked } = await liveThrough(t, seed, YEARS);
      assert.ok(compared > YEARS * 100 && looked > compared, 'the books were opened on many days');
      for (const [what, times] of Object.entries(happened)) everything[what] = (everything[what] || 0) + times;
      if (process.env.YEARS_SEEDS) t.diagnostic(`${looked} looks at a member, ${compared} of them compared with the books; ${Object.entries(happened).map(([what, times]) => `${what} ${times}x`).join(', ')}`);
    });
  }

  test('in these years everything happened that can happen', { skip: Boolean(process.env.YEARS_SEEDS || process.env.YEARS_LENGTH) && 'only with the communities and years of every test run' }, () => {
    for (const what of [
      'a member joins', 'a member is deleted', 'a payment is booked', 'a payment is booked for a day past', 'a payment is booked for a day to come', 'a payment is corrected', 'a payment is deleted',
      'a standing order is booked', 'a standing order is changed', 'a status changes', 'a status changes after the fact', 'a status changes for a day to come', '"member since" is corrected',
      'fees are set from a month to come', 'fees are set from a month that has begun', 'fees are set from a month past', 'a change of the fees is edited', 'a change of the fees is edited back',
      'a change of the fees is moved', 'a change of the fees is taken back', 'a change of the fees is set back to what it changed', 'a change of the fees is edited to the fees of the next one',
      'the fees from the beginning are corrected', 'an older app saves a fee', 'a change of the fees is refused',
      'a fresh start is planned', 'a fresh start is set for a day that has come', 'a fresh start is taken back'
    ]) {
      assert.ok(everything[what] > 0, `never happened: ${what} (${JSON.stringify(everything)})`);
    }
  });
});

// The same question to the real server with the real database (needs the PocketBase binary, like api.test.js): five
// years of a small community over HTTP. Time passes while the server is down - it is stopped and started again on a
// later day (tests/clock.js), as it is after a night, an update or a long while. Every time it wakes up, what was
// planned must have come into effect, the standing orders must have been booked, and every number it serves - to
// the treasury, to the member, on the fees page, to an older app - must be that of the second books.
const fs = require('fs');
const { REPO_ROOT, BACKEND_DIR, freePort, waitFor, start, stop, SERVER_ENTRY } = require('./helpers');

const POCKETBASE_BIN = process.env.POCKETBASE_BIN || '';
const hasPocketBase = POCKETBASE_BIN !== '' && fs.existsSync(POCKETBASE_BIN);
const PASSWORD = 'test-Passwort-1';

describe('years with the real server and database', { skip: !hasPocketBase && 'set POCKETBASE_BIN to run the HTTP tests' }, () => {
  const { before, after } = require('node:test');
  const processes = [];
  const tokens = {};
  // The keys of the member records of the owner and the treasurer (they are members too)
  const staff = {};
  let base;
  let dataRoot;
  let backendEnv;
  let backend = null;
  let isSetUp = false;

  async function call(who, method, url, body) {
    const headers = { 'X-Forwarded-For': `10.43.0.${Object.keys(tokens).indexOf(who) + 2}` };
    if (who && tokens[who]) headers.Authorization = `Bearer ${tokens[who]}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* text body */ }
    return { status: res.status, body: parsed };
  }
  const ok = async (promise) => {
    const res = await promise;
    assert.ok(res.status < 300, `expected success, got ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    return res.body;
  };
  const read = async (who, dbPath) => (await ok(call(who, 'GET', `/api/db?path=${dbPath}`))) || {};

  /** The server is stopped and wakes up at noon on [day]. */
  async function visit(day) {
    await stop(backend);
    backend = start('backend', process.execPath, ['--require', path.join(__dirname, 'clock.js'), SERVER_ENTRY], { ...backendEnv, AGORA_TEST_NOW: `${day}T12:00:00` });
    processes.push(backend);
    await waitFor(`${base}/api/status`, `the server on ${day}`, [processes[0], backend], 50);
    // An instance that is set up starts its runtime first (status: ready); until then it asks the apps to try again
    for (let i = 0; isSetUp; i += 1) {
      const status = await fetch(`${base}/api/status`).then((res) => res.json()).catch(() => null);
      if (status?.ready === true) break;
      assert.ok(i < 600 && backend.exitCode === null, `the server on ${day} did not get ready\n${backend.log.join('')}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** A new account with its member record; returns the key of the record. [name] signs in with call(name, …). */
  async function addMember(name, since, status) {
    const email = `${name}@test.local`;
    await ok(call('owner', 'POST', '/api/admin/users', { firstName: name[0].toUpperCase() + name.slice(1), lastName: 'Test', email, password: PASSWORD, pays: true, admin: false, status, memberSince: since }));
    tokens[name] = (await ok(call(null, 'POST', '/api/auth/login', { email, password: PASSWORD }))).token;
    return (await ok(call(name, 'GET', '/api/auth/me'))).user.uid;
  }

  before(async () => {
    const [port, pbPort] = await Promise.all([freePort(), freePort()]);
    dataRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agora-years-'));
    const pbDir = path.join(dataRoot, 'pb');
    base = `http://127.0.0.1:${port}`;
    backendEnv = { PORT: String(port), POCKETBASE_PORT: String(pbPort), POCKETBASE_BIN, POCKETBASE_DIR: pbDir, DATA_DIR: path.join(dataRoot, 'data'), FRONTEND_DIR: REPO_ROOT, NODE_ENV: 'test' };
    processes.push(start('pocketbase', POCKETBASE_BIN, ['serve', '--dir', pbDir, '--automigrate=false', '--http', `127.0.0.1:${pbPort}`], {}));
    await waitFor(`http://127.0.0.1:${pbPort}/api/health`, 'PocketBase', processes);

    // The first day: the instance is set up, with a treasurer (a group with manage_finances)
    await visit('2026-11-15');
    const setup = await ok(call(null, 'POST', '/api/setup', { appName: 'Testgemeinde', adminUser: { firstName: 'Olga', lastName: 'Owner', email: 'owner@test.local', password: PASSWORD, memberSince: '2026-11-15' } }));
    tokens.owner = setup.token;
    isSetUp = true;
    staff.owner = setup.user.id || setup.user.uid;
    const group = await ok(call('owner', 'POST', '/api/admin/groups', { name: 'Kasse', permissions: ['manage_finances'] }));
    staff.treasurer = await addMember('treasurer', '2026-11-15', 'pausiert');
    await ok(call('owner', 'PUT', `/api/admin/users/${staff.treasurer}/groups`, { groups: [group.id || group.group?.id] }));
  });

  after(() => {
    for (const child of processes.reverse()) if (child.exitCode === null) child.kill();
    if (dataRoot) fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('five years: the server wakes up on another day, and every number is that of the books', async () => {
    const { applyStatusChangeToHistory } = await webApp();
    const paper = books.openBooks({ vollverdiener: 50, geringverdiener: 25, keinverdiener: 10, pausiert: 0 });
    // The owner and the treasurer are members since the day of the setup: the owner at the full fee (and never
    // pays), the treasurer paused
    const keys = { ...staff };
    books.noteMember(paper, 'owner', '2026-11-15', 'vollverdiener');
    books.noteMember(paper, 'treasurer', '2026-11-15', 'pausiert');
    const nobody = { count: 0, total: 0 };
    // The three fees a change is saved with: those of [month] in the books ('start': those from the beginning),
    // with the full fee at [full]
    const withFull = (month, full) => {
      const table = month === 'start' ? paper.fees.start : books.feesIn(paper, month);
      return { vollverdiener: full, geringverdiener: table.geringverdiener, keinverdiener: table.keinverdiener };
    };
    let today = '2026-11-15';
    const wakeUp = async (day) => { await visit(day); today = day; };

    // --- What happens, done through the API as the apps do it, and noted on paper ---
    const join = async (name, since, status) => { keys[name] = await addMember(name, since, status); books.noteMember(paper, name, since, status); };
    const record = (name) => ok(call('treasurer', 'GET', `/api/db?path=people/${keys[name]}&raw=1`));
    // the treasury changes a member's record, as the web app writes it
    const write = async (name, change) => {
      const raw = await record(name);
      await ok(call('treasurer', 'POST', '/api/db/transaction', { path: `people/${keys[name]}`, currentVersion: raw.version, value: change(raw.value) }));
    };
    const pay = async (name, ...entries) => {
      const payments = entries.map(([amount, date]) => ({ id: `${name}-${date}-${amount}`, amount, date, description: 'Beitrag' }));
      await write(name, (person) => ({ ...person, payments: [...person.payments, ...payments] }));
      for (const payment of payments) books.notePayment(paper, name, payment.id, payment.date, payment.amount);
    };
    const everyMonth = (first, last, amount, dayOfMonth) => {
      const entries = [];
      for (let month = first; month <= last; month = addMonths(month, 1)) entries.push([amount, `${month}-${dayOfMonth}`]);
      return entries;
    };
    // By how much each member owes more or less today in the books [now] than in [was] - as a dialog shows it
    const sides = (was, now, day = today) => {
      const [more, less] = [{ count: 0, total: 0 }, { count: 0, total: 0 }];
      for (const name of Object.keys(keys)) {
        const difference = books.accountOf(now, name, day).balance - books.accountOf(was, name, day).balance;
        if (difference < 0) { more.count += 1; more.total += -difference / 100; }
        if (difference > 0) { less.count += 1; less.total += difference / 100; }
      }
      return { more, less };
    };
    // A change of the fees: checked first - what is shown must be what the books say - then saved as it was checked
    const changeFees = async (body, note) => {
      const [was, now] = [structuredClone(paper), structuredClone(paper)];
      note(now);
      const shown = await ok(call('owner', 'POST', '/api/admin/fees/preview', body));
      assert.deepEqual([shown.more, shown.less], Object.values(sides(was, now)), `${today}: the numbers shown before saving ${JSON.stringify(body)}`);
      for (const stretch of shown.stretches) {
        for (const month of [stretch.first || '2015-01', stretch.last || '2040-12']) {
          assert.ok(books.sameFees(stretch.before, books.feesIn(was, month)) && books.sameFees(stretch.after, books.feesIn(now, month)), `${today}: ${month} as shown ${JSON.stringify(stretch)}`);
        }
      }
      const saved = await ok(call('owner', 'POST', body.remove ? '/api/admin/fees/remove' : '/api/admin/fees', { ...body, version: shown.version }));
      note(paper);
      return { shown, saved };
    };
    // A fresh start, set or taken back with the day twice and the password: what is shown is what the books say
    const freshStart = async (date, remove = false) => {
      const was = structuredClone(paper);
      const shown = await ok(call('owner', 'GET', `/api/admin/fee-reset/preview?date=${date}${remove ? '&remove=1' : ''}`));
      await ok(call('owner', 'POST', remove ? '/api/admin/fee-reset/remove' : '/api/admin/fee-reset', { date, confirmDate: date, password: PASSWORD }));
      if (remove) books.noteFreshStartTakenBack(paper, date);
      else books.noteFreshStart(paper, date);
      const [withIt, without] = remove ? [was, paper] : [paper, was];
      const ahead = Object.keys(keys).map((name) => books.accountOf(withIt, name, date).carriedOver / 100).filter((credit) => credit > 0);
      assert.deepEqual([shown.behind, shown.ahead, shown.owesMore, shown.repriced],
        [sides(withIt, without, remove || date <= today ? today : date).more, { count: ahead.length, total: ahead.reduce((sum, credit) => sum + credit, 0) }, nobody, false], `${today}: the numbers shown for the fresh start of ${date}`);
      return shown;
    };
    // The standing order of [name]: the server books what is due when it starts. Waits for it and notes the bookings
    const standingOrder = async (name, months, amount) => {
      let booked = [];
      for (let i = 0; i < 150 && booked.length < months; i += 1) {
        if (i) await new Promise((resolve) => setTimeout(resolve, 100));
        booked = (await record(name)).value.payments.filter((payment) => payment.isAuto);
      }
      assert.deepEqual([booked.length, new Set(booked.map((payment) => monthOf(payment.date))).size, booked.every((payment) => payment.amount === amount)], [months, months, true], `${today}: one booking of ${amount} a month for ${name}`);
      for (const payment of booked) books.notePayment(paper, name, payment.id, payment.date, payment.amount);
    };

    // --- What the server serves, against the books ---
    const look = async (what) => {
      const served = Object.values(await read('treasurer', 'people'));
      let paidInAll = 0;
      for (const name of Object.keys(keys)) {
        const person = served.find((entry) => entry.id === keys[name]);
        const paidUntil = new Date(person._paidUntil);
        const shown = {
          balance: cents(person._currentBalance),
          open: cents(person._overdueAmount + person._anticipatedPayment),
          paidUntil: `${paidUntil.getFullYear()}-${String(paidUntil.getMonth() + 1).padStart(2, '0')}`,
          countsFrom: person._feeReset,
          carriedOver: cents(person._feeCarriedOver),
          dropped: cents(person._feeWrittenOff),
          feeThisMonth: cents(person._monthlyFee)
        };
        const account = books.accountOf(paper, name, today);
        // (a standing order still due this month stands against what is open)
        if (person._anticipatedPayment) account.open = Math.max(account.open, shown.open);
        assert.deepEqual(shown, account, `${today}, ${what}: ${name} as served ${JSON.stringify(shown)}, in the books ${JSON.stringify(account)}`);
        assert.equal(person._statusMeta.isOverdue, person._overdueAmount > 0, `${today}: ${name} overdue`);
        // the facts stay what was entered
        assert.deepEqual([person.memberSince, person.payments.length], [paper.members[name].since, Object.keys(paper.members[name].payments).length], `${today}: ${name}'s record`);
        paidInAll += Object.values(paper.members[name].payments).reduce((sum, payment) => sum + cents(payment.amount), 0);
      }
      // a member is served the same numbers as the treasury sees
      assert.deepEqual(Object.values(await read('anna', 'people')), [served.find((entry) => entry.id === keys.anna)], `${today}: Anna's own view`);
      // the fees page, and what an older app reads
      const page = await ok(call('treasurer', 'GET', '/api/fees'));
      const onPaper = books.feesPageOf(paper, today);
      assert.deepEqual([page.today, page.month, page.since, page.next ? page.next.from : null], [today, monthOf(today), onPaper.since, onPaper.next], `${today}, ${what}: the fees page`);
      assert.ok(books.sameFees(page.current, onPaper.current), `${today}: the fees of the month ${JSON.stringify(page.current)}`);
      const settings = await read('anna', 'settings');
      assert.ok(books.sameFees({ vollverdiener: settings.vollverdiener, geringverdiener: settings.geringverdiener, keinverdiener: settings.keinverdiener, pausiert: settings.pausiert }, onPaper.current), `${today}: the fees an older app reads`);
      assert.deepEqual(page.entries.filter((entry) => entry.from).map((entry) => [entry.from, entry.state]),
        Object.keys(paper.fees.changes).sort().map((from, i, all) => [from, from > monthOf(today) ? 'planned' : all[i + 1] && all[i + 1] <= monthOf(today) ? 'past' : 'current']), `${today}: the changes and what they are`);
      // the fresh starts and what they are today
      const lines = [...paper.freshStarts].sort();
      const active = lines.filter((line) => line <= today).pop();
      assert.deepEqual((await ok(call('anna', 'GET', '/api/fee-reset'))).resets, lines.map((date) => ({ date, state: date > today ? 'scheduled' : date === active ? 'active' : 'replaced' })), `${today}: the fresh starts`);
      // and the cash balance is what was paid, whatever was dropped, carried over or re-priced
      assert.equal(cents((await ok(call('treasurer', 'GET', '/api/stats'))).totalBalance), paidInAll, `${today}: the cash balance`);
    };

    // 15 November 2026. Five members with their years so far: one who pays every month, one far behind, one far
    // ahead, one at the lower fee with a standing order from now on, one who never paid
    await join('anna', '2024-01-15', 'vollverdiener');
    await join('ben', '2024-01-15', 'vollverdiener');
    await join('cara', '2024-01-15', 'vollverdiener');
    await join('dan', '2024-06-10', 'geringverdiener');
    await join('eva', '2025-03-20', 'keinverdiener');
    await pay('anna', ...everyMonth('2024-01', '2026-11', 50, '03'));
    await pay('ben', [1000, '2024-06-10']);
    await pay('cara', [2500, '2024-02-01']);
    await pay('dan', ...everyMonth('2024-06', '2026-10', 25, '10'));
    await write('dan', (person) => ({ ...person, standingOrders: [{ id: 'so-dan', amount: 25, startDate: '2026-11-05', note: 'Dauerauftrag', lastAutoPayment: null }] }));
    await look('the beginning');
    assert.deepEqual(['anna', 'ben', 'cara', 'dan', 'eva'].map((name) => books.accountOf(paper, name, today).balance / 100), [0, -750, 750, -25, -210]);
    // the admins plan ahead: 60 for full earners from January, and a fresh start on 1 January
    const planned = await changeFees({ from: '2027-01', fees: withFull('2027-01', 60) }, (b) => books.noteFeesFrom(b, '2027-01', { vollverdiener: 60 }));
    assert.deepEqual([planned.shown.inEffect, planned.shown.more, planned.shown.less], [false, nobody, nobody]);
    assert.equal((await freshStart('2027-01-01')).inEffect, false);
    await look('planned, nothing has moved');

    // 20 December 2026. The standing order was booked for November and December; Anna pays December
    await wakeUp('2026-12-20');
    await standingOrder('dan', 2, 25);
    await pay('anna', [50, '2026-12-20']);
    await look('December');
    assert.deepEqual([books.accountOf(paper, 'ben', today).balance / 100, books.feesPageOf(paper, today).next], [-800, '2027-01']);

    // 1 January 2027, the day itself: the fresh start has come, and a month costs 60
    await wakeUp('2027-01-01');
    await standingOrder('dan', 2, 25);
    await look('the day of the fresh start');
    assert.deepEqual(['anna', 'ben', 'cara', 'dan', 'eva'].map((name) => { const { balance, dropped, carriedOver } = books.accountOf(paper, name, today); return [balance / 100, dropped / 100, carriedOver / 100]; }),
      [[-60, 0, 0], [-60, 800, 0], [640, 0, 700], [-25, 0, 0], [-10, 220, 0]]);

    // 20 January 2027. A payment of Ben's from December is booked late (it belongs to the time before), Anna pays,
    // Eva is a low earner from February, an older app saves the lower fee at 30 - and Finn will join in March
    await wakeUp('2027-01-20');
    await standingOrder('dan', 3, 25);
    await pay('ben', [100, '2026-12-20']);
    await pay('anna', [60, '2027-01-20']);
    await write('eva', (person) => applyStatusChangeToHistory(person, 'geringverdiener', '2027-02-01'));
    books.noteStatus(paper, 'eva', '2027-02-01', 'geringverdiener');
    const settings = await read('owner', 'settings');
    await ok(call('owner', 'PUT', '/api/db', { path: 'settings', value: { ...settings, geringverdiener: 30 } }));
    books.noteFeesFrom(paper, '2027-01', { geringverdiener: 30 });
    await join('finn', '2027-03-10', 'vollverdiener');
    await look('January');
    assert.deepEqual([books.accountOf(paper, 'ben', today).dropped / 100, books.accountOf(paper, 'dan', today).balance / 100, books.accountOf(paper, 'finn', today).balance / 100], [700, -5, 0]);

    // 15 July 2027. The full fee is 65 from May, entered now: it reaches back three months - then it is moved to
    // June. And Finn's "member since" is corrected to February
    await wakeUp('2027-07-15');
    await standingOrder('dan', 9, 25);
    const reach = await changeFees({ from: '2027-05', fees: withFull('2027-05', 65) }, (b) => books.noteFeesFrom(b, '2027-05', { vollverdiener: 65 }));
    // (Anna, Ben, Cara, Finn and the owner pay the full fee: three months at 5 more for each)
    assert.deepEqual([reach.shown.inEffect, reach.shown.more, reach.shown.freshStart], [true, { count: 5, total: 75 }, null]);
    const moved = await changeFees({ from: '2027-06', replaces: '2027-05', fees: withFull('2027-05', 65) }, (b) => books.noteFeesMoved(b, '2027-05', '2027-06', { vollverdiener: 65 }));
    assert.deepEqual([moved.shown.less, moved.shown.stretches.map((stretch) => [stretch.first, stretch.last])], [{ count: 5, total: 25 }, [['2027-05', '2027-05']]]);
    await ok(call('owner', 'PUT', `/api/admin/users/${keys.finn}/member-since`, { memberSince: '2027-02-10' }));
    books.noteMemberSince(paper, 'finn', '2027-02-10');
    await look('July');

    // 29 February 2028. A second fresh start, for today - and the first one is taken back
    await wakeUp('2028-02-29');
    await standingOrder('dan', 16, 25);
    assert.equal((await freshStart('2028-02-29')).inEffect, true);
    await look('the second fresh start');
    await freshStart('2027-01-01', true);
    await look('the first fresh start taken back');

    // 15 June 2030, more than two years later: 28 standing orders are booked at once. The fees from the beginning
    // are corrected to 45 - that reaches back before the fresh start, and the admin is told - and the change of
    // June 2027 is taken back
    await wakeUp('2030-06-15');
    await standingOrder('dan', 44, 25);
    await look('after two years');
    const corrected = await changeFees({ from: null, fees: withFull('start', 45) }, (b) => books.noteFeesFromTheBeginning(b, { vollverdiener: 45 }));
    assert.deepEqual([corrected.shown.freshStart, corrected.shown.stretches.map((stretch) => [stretch.first, stretch.last])], ['2028-02-29', [[null, '2026-12']]]);
    await look('the fees from the beginning corrected');
    await changeFees({ from: '2027-06', remove: true }, (b) => books.noteFeesTakenBack(b, '2027-06'));
    await look('a change taken back');

    // 31 December 2031: the last look
    await wakeUp('2031-12-31');
    await standingOrder('dan', 62, 25);
    await look('the end');
  });
});
