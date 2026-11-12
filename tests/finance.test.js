const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('standingOrders', () => {
  const { checkAndExecuteStandingOrders } = require('../backend/standingOrders');
  const { freezeTime } = require('./helpers');

  // Runs the daily check "on" the given day (noon UTC)
  const runOn = (t, day, person) => {
    const restore = freezeTime(t, `${day}T12:00:00Z`);
    try { return checkAndExecuteStandingOrders(person); } finally { restore(); }
  };
  const order = (fields) => ({ id: 'p1', payments: [], standingOrders: [{ id: 'so', amount: 50, note: 'Beitrag', ...fields }] });
  const bookings = (result) => (result?.payments || []).map((p) => `${p.id.replace('auto_so_', '')}>${p.date}`);

  test('a standing order due on a Saturday is booked on Monday', (t) => {
    const person = order({ startDate: '2026-03-07' });
    assert.equal(runOn(t, '2026-03-07', person), null, 'not on Saturday');
    const monday = runOn(t, '2026-03-09', person);
    assert.deepEqual(bookings(monday), ['2026-03-07>2026-03-09']);
    assert.equal(monday.payments[0].id, 'auto_so_2026-03-07');
  });

  test('an end date on the weekend still lets the last booking happen on Monday', (t) => {
    for (const day of ['2026-03-07', '2026-03-08']) {
      const person = order({ startDate: day, endDate: day });
      assert.equal(runOn(t, day, person), null, `not on ${day}`);
      assert.deepEqual(bookings(runOn(t, '2026-03-09', person)), [`${day}>2026-03-09`]);
    }
  });

  test('missed months are caught up once each and the order remembers the last one', (t) => {
    const result = runOn(t, '2026-04-20', order({ startDate: '2026-01-15' }));
    assert.deepEqual(bookings(result), ['2026-01-15>2026-01-15', '2026-02-15>2026-02-16', '2026-03-15>2026-03-16', '2026-04-15>2026-04-15']);
    assert.equal(result.standingOrders[0].lastAutoPayment, '2026-04-15');
    assert.ok(result.payments.every((p) => p.isAuto === true && p.amount === 50));
  });

  test('running again on the same or the next day books nothing twice', (t) => {
    const first = runOn(t, '2026-04-20', order({ startDate: '2026-01-15' }));
    assert.equal(runOn(t, '2026-04-20', first), null);
    assert.equal(runOn(t, '2026-04-21', first), null);
    // the next month adds exactly one booking
    assert.equal(runOn(t, '2026-05-15', first).payments.length, first.payments.length + 1);
  });

  test('a day that a month does not have falls on its last day, the next month uses the day again', (t) => {
    const result = runOn(t, '2026-03-31', order({ startDate: '2026-01-31' }));
    assert.deepEqual(bookings(result), ['2026-01-31>2026-02-02', '2026-02-28>2026-03-02', '2026-03-31>2026-03-31']);
  });

  test('nothing is booked after the end date or before the start', (t) => {
    const ended = runOn(t, '2026-05-01', order({ startDate: '2026-01-10', endDate: '2026-02-20' }));
    assert.deepEqual(bookings(ended), ['2026-01-10>2026-01-12', '2026-02-10>2026-02-10']);
    assert.equal(runOn(t, '2026-05-01', order({ startDate: '2026-06-01' })), null, 'starts in the future');
    assert.equal(runOn(t, '2026-05-01', { id: 'p1', payments: [] }), null, 'no standing orders');
  });

  test('amounts in German notation are booked as numbers', (t) => {
    const person = { id: 'p1', payments: [], standingOrders: [
      { id: 'a', amount: '1.234,50', startDate: '2026-04-15' },
      { id: 'b', amount: '12,50', startDate: '2026-04-15' },
      { id: 'c', amount: 30, startDate: '2026-04-15' }
    ] };
    assert.deepEqual(runOn(t, '2026-04-15', person).payments.map((p) => p.amount), [1234.5, 12.5, 30]);
  });
});

describe('requestRetention', () => {
  const { withDecisionTimestamp, isExpiredRequest, DECIDED_REQUEST_RETENTION_DAYS } = require('../backend/requestRetention');

  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 8, 29);

  test('withDecisionTimestamp stamps approve/reject once and leaves pending requests alone', () => {
    assert.deepEqual(withDecisionTimestamp({ status: 'pending' }, { status: 'pending', amount: 5 }, NOW), { status: 'pending', amount: 5 });
    assert.equal(withDecisionTimestamp({ status: 'pending' }, { status: 'approved' }, NOW).decidedAt, NOW);
    assert.equal(withDecisionTimestamp(null, { status: 'rejected', rejectionReason: 'Doppelt' }, NOW).decidedAt, NOW);
    // A later edit keeps the original decision time
    assert.equal(withDecisionTimestamp({ status: 'approved', decidedAt: NOW - DAY }, { status: 'approved', note: 'x' }, NOW).decidedAt, NOW - DAY);
    assert.equal(withDecisionTimestamp({ status: 'pending' }, { status: 'approved', decidedAt: 123 }, NOW).decidedAt, 123);
  });

  test('isExpiredRequest only drops decided requests older than the retention period', () => {
    const decided = (status, age) => ({ status, data: { status, decidedAt: NOW - age } });
    assert.equal(DECIDED_REQUEST_RETENTION_DAYS, 30);
    assert.equal(isExpiredRequest(decided('approved', 29 * DAY), NOW), false);
    assert.equal(isExpiredRequest(decided('approved', 31 * DAY), NOW), true);
    assert.equal(isExpiredRequest(decided('rejected', 31 * DAY), NOW), true);
    assert.equal(isExpiredRequest({ status: 'pending', data: { status: 'pending', timestamp: NOW - 400 * DAY } }, NOW), false);
    // Decided before decidedAt existed: kept until the cleanup dates it
    assert.equal(isExpiredRequest({ status: 'approved', data: { status: 'approved', timestamp: NOW - 400 * DAY } }, NOW), false);
  });
});

describe('derivedData', () => {
  const { preprocessPersonServerSide } = require('../backend/derivedData');
  const { freezeTime } = require('./helpers');

  // A fixed weekday in mid-month: "tomorrow" then exists in the previous month too (the real date broke these
  // tests at the end of a month, e.g. Oct 30: "Sep 31" rolled over to Oct 1)
  const TODAY = '2026-03-11T12:00:00Z';

  function isoDate(year, monthIndex, day) {
    const month = String(monthIndex + 1).padStart(2, '0');
    const date = String(day).padStart(2, '0');
    return `${year}-${month}-${date}`;
  }

  function makeBasePerson(overrides = {}) {
    return {
      id: 'person-1',
      uid: 'user-1',
      name: 'Test',
      status: 'vollverdiener',
      memberSince: '2026-01-01',
      originalMemberSince: '2026-01-01',
      payments: [],
      standingOrders: [],
      statusHistory: [],
      totalPaid: 0,
      ...overrides
    };
  }

  test('marks member behind when past arrears exist even if current-month standing order already paid', (t) => {
    freezeTime(t, TODAY);
    const now = new Date();
    const settings = { vollverdiener: 10 };

    const start = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const thisMonth = isoDate(now.getFullYear(), now.getMonth(), 5);
    const firstMonth = isoDate(start.getFullYear(), start.getMonth(), 5);

    const person = makeBasePerson({
      memberSince: isoDate(start.getFullYear(), start.getMonth(), 1),
      originalMemberSince: isoDate(start.getFullYear(), start.getMonth(), 1),
      totalPaid: 20,
      payments: [
        { id: 'p1', amount: 10, date: firstMonth, description: 'Manual' },
        { id: 'auto_so-1_' + thisMonth, amount: 10, date: thisMonth, description: 'Dauerauftrag (Auto)', isAuto: true }
      ],
      standingOrders: [
        { id: 'so-1', amount: 10, startDate: isoDate(start.getFullYear(), start.getMonth(), 25) }
      ]
    });

    const result = preprocessPersonServerSide(person, settings);
    assert.equal(result._statusMeta.isOverdue, true);
    assert.equal(result._overdueAmount, 20);
    assert.equal(result._anticipatedPayment, 0);
    assert.equal(result._overpayment, 0);
  });

  test('applies grace period for unexecuted current-month standing order to keep member current', (t) => {
    freezeTime(t, TODAY);
    const now = new Date();
    const settings = { vollverdiener: 10 };

    const dueDay = Math.min(
      now.getDate() + 1,
      new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    );

    const soStart = new Date(now.getFullYear(), now.getMonth() - 1, dueDay);
    const memberSince = new Date(now.getFullYear(), now.getMonth(), 1);

    const person = makeBasePerson({
      memberSince: isoDate(memberSince.getFullYear(), memberSince.getMonth(), 1),
      originalMemberSince: isoDate(memberSince.getFullYear(), memberSince.getMonth(), 1),
      totalPaid: 0,
      payments: [],
      standingOrders: [
        { id: 'so-2', amount: 10, startDate: isoDate(soStart.getFullYear(), soStart.getMonth(), soStart.getDate()) }
      ]
    });

    const result = preprocessPersonServerSide(person, settings);
    assert.equal(result._statusMeta.isOverdue, false);
    assert.equal(result._statusMeta.isSoonDue, true);
    assert.equal(result._anticipatedPayment, 10);
    assert.equal(result._overdueAmount, 0);
    assert.equal(result._overpayment, 0);
  });

  test('overpayment uses only current balance and excludes anticipated standing order amount', (t) => {
    freezeTime(t, TODAY);
    const now = new Date();
    const settings = { vollverdiener: 10 };

    const memberSince = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const dueDay = Math.min(
      now.getDate() + 1,
      new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    );

    const person = makeBasePerson({
      memberSince: isoDate(memberSince.getFullYear(), memberSince.getMonth(), 1),
      originalMemberSince: isoDate(memberSince.getFullYear(), memberSince.getMonth(), 1),
      totalPaid: 25,
      payments: [
        { id: 'p1', amount: 25, date: isoDate(memberSince.getFullYear(), memberSince.getMonth(), 10), description: 'Manual' }
      ],
      standingOrders: [
        { id: 'so-3', amount: 10, startDate: isoDate(memberSince.getFullYear(), memberSince.getMonth(), dueDay) }
      ]
    });

    const result = preprocessPersonServerSide(person, settings);
    assert.equal(result._currentBalance, 5);
    assert.equal(result._anticipatedPayment, 10);
    assert.equal(result._overpayment, 5);
    assert.equal(result._statusMeta.isOverdue, false);
  });

  test('returns Alles in Ordnung for up-to-date member without standing order', (t) => {
    freezeTime(t, TODAY);
    const now = new Date();
    const settings = { vollverdiener: 10 };

    const memberSince = new Date(now.getFullYear(), now.getMonth(), 1);

    const person = makeBasePerson({
      memberSince: isoDate(memberSince.getFullYear(), memberSince.getMonth(), 1),
      originalMemberSince: isoDate(memberSince.getFullYear(), memberSince.getMonth(), 1),
      totalPaid: 10,
      payments: [
        { id: 'p1', amount: 10, date: isoDate(memberSince.getFullYear(), memberSince.getMonth(), 1), description: 'Manual' }
      ],
      standingOrders: []
    });

    const result = preprocessPersonServerSide(person, settings);
    assert.equal(result._statusMeta.isOverdue, false);
    assert.equal(result._statusMeta.isActiveStandingOrder, false);
    assert.equal(result._statusMeta.text, 'Alles in Ordnung');
  });

  test('returns Dauerauftrag läuft for up-to-date member with active standing order', (t) => {
    freezeTime(t, TODAY);
    const now = new Date();
    const settings = { vollverdiener: 10 };

    const memberSince = new Date(now.getFullYear(), now.getMonth(), 1);

    const person = makeBasePerson({
      memberSince: isoDate(memberSince.getFullYear(), memberSince.getMonth(), 1),
      originalMemberSince: isoDate(memberSince.getFullYear(), memberSince.getMonth(), 1),
      totalPaid: 10,
      payments: [
        { id: 'p1', amount: 10, date: isoDate(memberSince.getFullYear(), memberSince.getMonth(), 1), description: 'Manual' }
      ],
      standingOrders: [
        { id: 'so-1', amount: 10, startDate: isoDate(memberSince.getFullYear(), memberSince.getMonth(), 1) }
      ]
    });

    const result = preprocessPersonServerSide(person, settings);
    assert.equal(result._statusMeta.isOverdue, false);
    assert.equal(result._statusMeta.isActiveStandingOrder, true);
    assert.equal(result._statusMeta.text, 'Dauerauftrag läuft');
  });
});

// CALDERA: on a day the admins choose every fee account is settled and started afresh - whoever is behind starts from
// zero, whoever has paid ahead takes that credit along, and nothing that is booked changes (backend/feeReset.js)
describe('fresh start of the fee accounts', () => {
  const path = require('path');
  const { pathToFileURL } = require('url');
  const { preprocessPersonServerSide, feeResetImpact } = require('../backend/derivedData');
  const feeReset = require('../backend/feeReset');
  const feeSchedule = require('../backend/feeSchedule');
  const { freezeTime, assertHas } = require('./helpers');
  const webApp = () => import(pathToFileURL(path.join(__dirname, '..', 'assets', 'finance.js')).href);

  // These tests give the calculation one fee for all time and the fees each fresh start kept: the data of an
  // instance from before the fees had a history (backend/feeSchedule.js), which it must go on reading as it did
  const FEES = { vollverdiener: 50, geringverdiener: 25, keinverdiener: 10, pausiert: 0 };
  // The fresh start of the examples: 1 January 2027, the time before keeps the fees it had
  const DAY = '2027-01-01';
  const FRESH = [{ date: DAY, feesBefore: FEES }];
  // A member since January 2025 (the 24 months up to the fresh start cost 1200) with payments as [amount, day].
  const member = (payments = [], extra = {}) => ({
    id: 'p1', uid: 'u1', name: 'Paula', status: 'vollverdiener', memberSince: '2025-01-15', originalMemberSince: '2025-01-15',
    standingOrders: [], statusHistory: [{ status: 'vollverdiener', startDate: '2025-01-15' }],
    payments: payments.map(([amount, date], i) => ({ id: `pay${i}`, amount, date })),
    totalPaid: payments.reduce((sum, [amount]) => sum + amount, 0),
    ...extra
  });
  const behind = member([[900, '2025-06-10']]);
  const settled = member([[1200, '2025-06-10']]);
  const ahead = member([[1500, '2025-06-10']]);
  // The record as the server serves it on that day: at noon there, in whatever time zone the tests run
  const noon = (day) => new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 12).toISOString();
  const on = (t, day, person, resets = FRESH, fees = FEES, schedule = null) => {
    const restore = freezeTime(t, noon(day));
    try { return preprocessPersonServerSide(structuredClone(person), fees, resets, schedule); } finally { restore(); }
  };
  const paidUpTo = (served) => { const date = new Date(served._paidUntil); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; };

  test('whoever is behind starts from zero: the open fees are dropped, only the months since then are owed', (t) => {
    assertHas(on(t, '2027-02-15', behind, []), { _currentBalance: -400, _overdueAmount: 400 }, 'without a fresh start');
    const fresh = on(t, '2027-02-15', behind);
    assertHas(fresh, { _feeReset: DAY, _feeWrittenOff: 300, _feeCarriedOver: 0, _currentBalance: -100, _overdueAmount: 100 });
    assert.equal(paidUpTo(fresh), '2026-12', 'paid up to the month before the fresh start');
    assert.equal(fresh._statusMeta.isOverdue, true, 'the months since then are owed as always');
  });

  test('whoever has paid ahead takes exactly that credit along: nothing that was paid is cut', (t) => {
    for (const day of ['2027-01-01', '2027-02-15', '2027-06-30', '2027-09-01']) {
      const [before, fresh] = [on(t, day, ahead, []), on(t, day, ahead)];
      assertHas(fresh, { _feeReset: DAY, _feeCarriedOver: 300, _feeWrittenOff: 0 }, day);
      // at the fees of before, the account stands exactly where it stood
      assert.equal(fresh._currentBalance, before._currentBalance, `balance on ${day}`);
      assert.equal(fresh._paidUntil, before._paidUntil, `paid until on ${day}`);
      assert.deepEqual(fresh._statusMeta, before._statusMeta, `state on ${day}`);
    }
    assert.equal(paidUpTo(on(t, '2027-02-15', ahead)), '2027-06');
  });

  test('whoever is paid up exactly simply goes on', (t) => {
    const [before, fresh] = [on(t, '2027-02-15', settled, []), on(t, '2027-02-15', settled)];
    assertHas(fresh, { _feeReset: DAY, _feeCarriedOver: 0, _feeWrittenOff: 0, _currentBalance: -100 });
    assert.equal(fresh._currentBalance, before._currentBalance);
    assert.equal(fresh._paidUntil, before._paidUntil);
  });

  test('new fees only count from the fresh start on: they neither shrink a credit nor bring dropped fees back', (t) => {
    for (const [full, owedSince] of [[60, 120], [40, 80]]) {
      const fees = { ...FEES, vollverdiener: full };
      assertHas(on(t, '2027-02-15', ahead, FRESH, fees), { _feeCarriedOver: 300, _currentBalance: 300 - owedSince }, `fee ${full}`);
      assertHas(on(t, '2027-02-15', behind, FRESH, fees), { _feeWrittenOff: 300, _currentBalance: -owedSince }, `fee ${full}`);
    }
    // without the fees kept, the higher fee would have re-priced two paid years: 1500 - 24 x 60 leaves 60 of the 300
    assert.equal(on(t, '2027-02-15', ahead, [{ date: DAY }], { ...FEES, vollverdiener: 60 })._feeCarriedOver, 60);
  });

  test('a planned fresh start already keeps the fees of the time before it: fees entered early count from its month on', (t) => {
    // planned in November 2026 for January, and the new fee of 60 is entered right away
    const newFees = { ...FEES, vollverdiener: 60 };
    for (const person of [behind, settled, ahead]) {
      const [asItWas, early] = [on(t, '2026-12-15', person, []), on(t, '2026-12-15', person, FRESH, newFees)];
      // December still costs what it cost: nobody's account moves before the day
      for (const field of ['_currentBalance', '_overdueAmount', '_statusMeta', '_feeReset']) assert.deepEqual(early[field], asItWas[field], field);
      assert.equal(early._monthlyFee, 50, 'this month is still charged at the fee of its time');
    }
    // on the day the accounts are settled at the old fees, and from January the new fee is owed
    assertHas(on(t, '2027-02-15', ahead, FRESH, newFees), { _feeCarriedOver: 300, _currentBalance: 300 - 120, _monthlyFee: 60 });
    assertHas(on(t, '2027-02-15', behind, FRESH, newFees), { _feeWrittenOff: 300, _currentBalance: -120 });
    // paid until: the credit is used up at the fees of each month (1500 pay the 24 months at 50, then five at 60)
    assert.equal(paidUpTo(on(t, '2026-12-15', ahead, FRESH, newFees)), '2027-05');
    // without a fresh start the fee set now is the fee of every month, as always
    assertHas(on(t, '2026-12-15', ahead, [], newFees), { _monthlyFee: 60, _currentBalance: 1500 - 24 * 60 });
    // a member who is still to join is shown the fee of the status they start with
    const nextSummer = member([], { memberSince: '2027-06-15', originalMemberSince: '2027-06-15', statusHistory: [{ status: 'vollverdiener', startDate: '2027-06-15' }] });
    assertHas(on(t, '2026-12-15', nextSummer, FRESH, newFees), { _currentStatus: null, _monthlyFee: 50, _currentBalance: 0 });
    assertHas(on(t, '2027-02-15', nextSummer, FRESH, newFees), { _currentStatus: null, _monthlyFee: 60, _feeReset: null });
    assertHas(on(t, '2027-02-15', nextSummer, [], FEES), { _monthlyFee: 50 });
  });

  test('a fresh start in the future changes nothing until its day comes', (t) => {
    for (const person of [behind, settled, ahead]) {
      assert.deepEqual(on(t, '2026-12-31', person), on(t, '2026-12-31', person, []), 'the day before');
    }
    assertHas(on(t, '2026-12-31', behind), { _feeReset: null, _currentBalance: -300, _overdueAmount: 300 });
    assertHas(on(t, DAY, behind), { _feeReset: DAY, _feeWrittenOff: 300, _currentBalance: -50 }, 'from the day itself on');
    assertHas(on(t, DAY, ahead), { _feeReset: DAY, _feeCarriedOver: 300, _currentBalance: 250 });
  });

  test('a payment dated before the fresh start belongs to the time before it, one on the day to the new account', (t) => {
    // paid up, plus a payment in December that was booked late: it was ahead, so it is credit
    assertHas(on(t, '2027-02-15', member([[1200, '2025-06-10'], [100, '2026-12-20']])), { _feeCarriedOver: 100, _currentBalance: 0 });
    // behind: the same payment first makes up for the open fees of that time (which are dropped anyway)
    assertHas(on(t, '2027-02-15', member([[900, '2025-06-10'], [50, '2026-12-20']])), { _feeWrittenOff: 250, _feeCarriedOver: 0, _currentBalance: -100 });
    // dated on the day of the fresh start, it is paid into the new account
    assertHas(on(t, '2027-02-15', member([[900, '2025-06-10'], [50, DAY]])), { _feeWrittenOff: 300, _currentBalance: -50 });
  });

  test('a fresh start in the middle of a month: what was paid earlier that month is credit for it', (t) => {
    const paidJanuary = member([[1200, '2025-06-10'], [50, '2027-01-05']]);
    const fresh = on(t, '2027-01-20', paidJanuary, [{ date: '2027-01-10', feesBefore: FEES }]);
    assertHas(fresh, { _feeReset: '2027-01-10', _feeCarriedOver: 50, _currentBalance: 0, _overdueAmount: 0 });
    assert.equal(fresh._statusMeta.isOverdue, false, 'January is not owed a second time');
  });

  test('members who join on the day or later count from their own start, advance payments included', (t) => {
    const since = (day) => ({ memberSince: day, originalMemberSince: day, statusHistory: [{ status: 'vollverdiener', startDate: day }] });
    const joiner = member([[50, '2026-12-28']], since('2027-02-15'));
    assert.deepEqual(on(t, '2027-03-15', joiner), on(t, '2027-03-15', joiner, []));
    assertHas(on(t, '2027-03-15', joiner), { _feeReset: null, _feeCarriedOver: 0, _currentBalance: -50 });
    // joined on the very day of a fresh start (here the 10th): not before it
    const tenth = [{ date: '2027-01-10', feesBefore: FEES }];
    assertHas(on(t, '2027-03-15', member([], since('2027-01-10')), tenth), { _feeReset: null, _currentBalance: -150 });
    assertHas(on(t, '2027-03-15', member([], since('2027-01-09')), tenth), { _feeReset: '2027-01-10', _currentBalance: -150 });
  });

  test('"member since", the payments and the status history stay exactly as they are', (t) => {
    for (const person of [behind, ahead]) {
      const [before, fresh] = [on(t, '2027-02-15', person, []), on(t, '2027-02-15', person)];
      for (const field of ['memberSince', 'originalMemberSince', 'payments', 'totalPaid', 'statusHistory', 'status', 'standingOrders', '_currentStatus']) {
        assert.deepEqual(fresh[field], before[field], field);
      }
      assert.equal(fresh.memberSince, '2025-01-15');
    }
  });

  test('every month before the fresh start costs the fee of the status the member had then', (t) => {
    const lowerFee2026 = member([[1000, '2025-06-10']], {
      status: 'geringverdiener',
      statusHistory: [{ status: 'vollverdiener', startDate: '2025-01-01', endDate: '2026-01-01' }, { status: 'geringverdiener', startDate: '2026-01-01' }]
    });
    // 12 x 50 and 12 x 25 were owed: 100 of the 1000 are credit, and the two months since cost 25 each
    assertHas(on(t, '2027-02-15', lowerFee2026), { _feeCarriedOver: 100, _currentBalance: 50 });
  });

  test('a later fresh start draws the next line; until its day the earlier one counts', (t) => {
    const twice = [...FRESH, { date: '2030-01-01', feesBefore: FEES }];
    assertHas(on(t, '2029-06-15', ahead, twice), { _feeReset: DAY, _feeCarriedOver: 300, _currentBalance: -1200 });
    // by 2030 the 300 are used up and 1500 are open: dropped again, January 2030 is owed
    assertHas(on(t, '2030-01-15', ahead, twice), { _feeReset: '2030-01-01', _feeCarriedOver: 0, _feeWrittenOff: 1500, _currentBalance: -50 });
    // a credit goes through both: 10000 - 1200 - 1800 are left, less January 2030
    assertHas(on(t, '2030-01-15', member([[10000, '2025-06-10']]), twice), { _feeCarriedOver: 7000, _currentBalance: 6950 });
  });

  test('taking a fresh start back leaves no trace: everything is calculated as it was', (t) => {
    for (const person of [behind, settled, ahead]) {
      const restore = freezeTime(t, noon('2027-02-15'));
      const asBefore = preprocessPersonServerSide(structuredClone(person), FEES);
      restore();
      assert.deepEqual(on(t, '2027-02-15', person, []), asBefore);
      assertHas(asBefore, { _feeReset: null, _feeCarriedOver: 0, _feeWrittenOff: 0 });
    }
  });

  test('a standing order still due this month keeps the member up to date in the new account', (t) => {
    const withOrder = { ...behind, standingOrders: [{ id: 'so', amount: 50, startDate: '2026-06-20' }] };
    const fresh = on(t, '2027-01-05', withOrder);
    assertHas(fresh, { _feeWrittenOff: 300, _currentBalance: -50, _anticipatedPayment: 50, _overdueAmount: 0 });
    assertHas(fresh._statusMeta, { text: 'Dauerauftrag läuft', isOverdue: false, isSoonDue: true });
  });

  test('deleted people and records without a start are left alone', (t) => {
    const deleted = { id: 'd', name: 'Gone', isDeleted: true, memberSince: '', originalMemberSince: '', statusHistory: [], standingOrders: [], payments: [{ id: 'q', amount: 15, date: '2020-02-01' }], totalPaid: 15 };
    const noStart = member([[100, '2025-06-10']], { memberSince: '', originalMemberSince: '' });
    for (const person of [deleted, noStart]) {
      assert.deepEqual(on(t, '2027-02-15', person), on(t, '2027-02-15', person, []));
      assert.equal(on(t, '2027-02-15', person)._feeReset, null);
    }
    assert.equal(on(t, '2027-02-15', deleted)._statusMeta.isOverdue, false);
  });

  test('old amounts stored as text and payments without a day count for the time before', (t) => {
    const asText = { ...member(), payments: [{ id: 'a', amount: '1.250,00', date: '2025-06-10' }], totalPaid: 1250 };
    assert.equal(on(t, '2027-02-15', asText)._feeCarriedOver, 50);
    const noDay = { ...member(), payments: [{ id: 'b', amount: 1300 }], totalPaid: 1300 };
    assert.equal(on(t, '2027-02-15', noDay)._feeCarriedOver, 100);
  });

  test('before it is confirmed, the admin sees in numbers what the day changes', () => {
    const joiner = member([[50, '2026-12-28']], { id: 'p4', memberSince: '2027-02-15', originalMemberSince: '2027-02-15' });
    const people = [behind, settled, ahead, joiner, { ...behind, id: 'p5', pays: false }, { id: 'p6', name: 'Gone', isDeleted: true, payments: [] }];
    const untouched = structuredClone(people);
    const nobody = { count: 0, total: 0 };
    // set in November 2026 for January: as things are booked, one is behind by then and one ahead
    const impact = feeResetImpact(people, FEES, [], DAY, '2026-11-10');
    assertHas(impact, { date: DAY, inEffect: false, firstMonth: '2027-01', members: 4, behind: { count: 1, total: 300 }, ahead: { count: 1, total: 300 }, owesMore: nobody, feesBefore: FEES, feesWithout: FEES, repriced: false });
    assert.deepEqual(people, untouched, 'the records are only read');
    // a day that has come applies right away; by 1 November only 22 months were owed
    assertHas(feeResetImpact(people, FEES, [], '2026-11-01', '2026-11-10'), { inEffect: true, behind: { count: 1, total: 200 }, ahead: { count: 2, total: 500 }, owesMore: nobody });
    // a total that was not kept with the record changes nothing: what was paid is added up from the payments
    const bare = people.map(({ totalPaid, ...person }) => person);
    assert.deepEqual(feeResetImpact(bare, FEES, [], DAY, '2026-11-10'), impact);
    // setting a day changes the price of no month, also at fees that were changed since an earlier fresh start
    const dearer = { ...FEES, vollverdiener: 60 };
    assertHas(feeResetImpact(people, dearer, FRESH, '2026-06-01', '2027-03-01'), { feesBefore: FEES, feesWithout: FEES, repriced: false, owesMore: nobody });
    assertHas(feeResetImpact(people, dearer, FRESH, '2027-03-01', '2027-03-01'), { feesBefore: dearer, feesWithout: dearer, repriced: false, owesMore: nobody });
  });

  test('the numbers are what really changes: fees another fresh start drops anyway are not counted twice', (t) => {
    // three members who were 200 behind in January 2026; by November one is 700 behind, one 100, one 100 ahead
    const people = [member([[400, '2025-06-10']]), member([[400, '2025-06-10'], [600, '2026-03-10']]), member([[400, '2025-06-10'], [800, '2026-03-10']])];
    const november = [{ date: '2026-11-01', feesBefore: FEES }];
    // on its own, a fresh start in January 2026 drops 200 for each of them
    assertHas(feeResetImpact(people, FEES, [], '2026-01-15', '2026-11-10'), { members: 3, behind: { count: 3, total: 600 }, ahead: { count: 0, total: 0 } });
    // with the one of November in effect, the first owes nothing less (it was dropped then anyway), the second 100
    // less (the other 100 were dropped anyway), the third the full 200. Ahead on that day in January was nobody -
    // the credit two of them have since November is not that of this day
    const added = feeResetImpact(people, FEES, november, '2026-01-15', '2026-11-10');
    assertHas(added, { inEffect: true, members: 3, behind: { count: 2, total: 300 }, ahead: { count: 0, total: 0 }, owesMore: { count: 0, total: 0 }, repriced: false });
    // and that is exactly what the served balances do
    const balances = (resets) => people.map((person) => on(t, '2026-11-10', person, resets)._currentBalance);
    const both = [{ date: '2026-01-15', feesBefore: FEES }, ...november];
    assert.deepEqual(balances(november), [-50, -50, 50]);
    assert.deepEqual(balances(both), [-50, 50, 250]);
    // taking the earlier one back again: the same members owe the same amounts more
    assertHas(feeResetImpact(people, FEES, both, '2026-01-15', '2026-11-10'), { behind: { count: 2, total: 300 }, owesMore: { count: 0, total: 0 }, repriced: false });
    // taking the later one back while the earlier one stays: what it dropped comes back (500 and 0 and 0)
    assertHas(feeResetImpact(people, FEES, both, '2026-11-01', '2026-11-10'), { behind: { count: 1, total: 500 }, ahead: { count: 2, total: 400 } });
  });

  test('taking a fresh start back says who owes more again - and what other fees do to the time before it', () => {
    const joiner = member([[50, '2026-12-28']], { id: 'p4', memberSince: '2027-02-15', originalMemberSince: '2027-02-15' });
    const people = [behind, settled, ahead, joiner];
    const nobody = { count: 0, total: 0 };
    // at the fees it was set with: the 300 that were dropped are owed again, the credit of 300 stays
    assertHas(feeResetImpact(people, FEES, FRESH, DAY, '2027-03-01'), { inEffect: true, members: 4, behind: { count: 1, total: 300 }, ahead: { count: 1, total: 300 }, owesMore: nobody, repriced: false });
    // the fee was raised to 60 since: taken back, the 24 months before it cost 60 as well - 240 more for each of the
    // three, on top of the 300 that come back
    const dearer = { ...FEES, vollverdiener: 60 };
    assertHas(feeResetImpact(people, dearer, FRESH, DAY, '2027-03-01'), { behind: { count: 3, total: 1020 }, owesMore: nobody, feesBefore: FEES, feesWithout: dearer, repriced: true });
    // the fee was lowered to 40 since: 240 less for each; whoever was behind still owes 60 more
    const cheaper = { ...FEES, vollverdiener: 40 };
    assertHas(feeResetImpact(people, cheaper, FRESH, DAY, '2027-03-01'), { behind: { count: 1, total: 60 }, owesMore: { count: 2, total: 480 }, feesBefore: FEES, feesWithout: cheaper, repriced: true });
    // a planned one that is taken back before its day: nothing was dropped, so nothing comes back ...
    assertHas(feeResetImpact(people, FEES, FRESH, DAY, '2026-11-10'), { inEffect: false, behind: nobody, owesMore: nobody, repriced: false });
    // ... unless the new fee was entered early: then the 23 months so far cost it too
    assertHas(feeResetImpact(people, dearer, FRESH, DAY, '2026-11-10'), { inEffect: false, behind: { count: 3, total: 690 }, owesMore: nobody, repriced: true });
  });

  test('lived through day by day for four years, every account only moves by what happens that day', (t) => {
    // The books kept by hand, one balance per member: on the 1st the fee of the month is owed, a payment counts when
    // it is booked, and on the day of a fresh start what is open is dropped and credit stays. The server must serve
    // exactly that balance on every day from October 2026 to December 2030 - through a fresh start planned in
    // November for 1 January, a fee entered in December that counts from January, a fee entered late that reaches
    // back three months, a second fresh start in the middle of a month and a fee raised for the month after.
    const month = (day) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
    const dayAfter = (day) => { const next = new Date(`${day}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1); return next.toISOString().slice(0, 10); };
    // 50 on the same day of every month, from the month of [first] to that of [last]
    const monthly = (first, last, dayOfMonth) => Array.from({ length: month(last) - month(first) + 1 }, (_, i) => month(first) + i)
      .map((m) => [50, `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-${dayOfMonth}`]);
    // By the end of September 2026 a member since January 2025 owed 21 months, the last of them (charged) at 50.
    // closing: how the account stood on the day of its fresh start (credit that is carried over, or less than
    // nothing: the fees that were dropped)
    const kept = (record) => {
      const months = record.memberSince < '2026-10-01' ? 21 : 0;
      return { record, balance: record.totalPaid - months * 50, closing: 0, from: null, charged: months ? 50 : 0, last: 0 };
    };
    const world = {
      punctual: kept(member(monthly('2025-01-01', '2026-09-01', '03'))), // pays the fee of the month on the 3rd
      late: kept(member(monthly('2025-02-01', '2026-09-01', '10'))), // pays the fee of the month before on the 10th
      behind: kept(member([[450, '2025-06-10']])), // nothing more until April 2027, then every month on the 10th
      never: kept(member()), // one single payment, on the day of the second fresh start
      ahead: kept(member([[2000, '2025-02-01']])),
      lower: kept(member(monthly('2025-01-01', '2026-09-01', '03'))), // the lower fee from July 2027 on
      joiner: kept(member([], { memberSince: '2027-03-10', originalMemberSince: '2027-03-10', statusHistory: [{ status: 'vollverdiener', startDate: '2027-03-10' }] }))
    };
    // as the admin calls change them: the fees over time, each change with the month it counts from, and the days
    // of the fresh starts
    let schedule = feeSchedule.scheduleFromLegacy([], FEES);
    let resets = [];
    const feesFrom = (from, fees) => { schedule = feeSchedule.withFeeChange(schedule, { from, fees }); };
    const freshStart = (date) => { resets = feeReset.normalizeFeeResets([...resets, { date }]); };
    const closings = () => Object.values(world).map((m) => m.closing);

    for (let day = '2026-10-01'; day <= '2030-12-31'; day = dayAfter(day)) {
      const [first, dayOfMonth] = [day.endsWith('-01'), day.slice(8)];
      // what the admins do
      if (day === '2026-11-11') freshStart('2027-01-01'); // planned: nothing moves before its day
      if (day === '2026-12-01') feesFrom('2027-01', { vollverdiener: 60 }); // entered early: December still costs 50
      if (day === '2028-05-20') feesFrom('2028-03', { geringverdiener: 30 }); // entered late: reaches back to March
      if (day === '2029-06-15') freshStart('2029-07-15');
      if (day === '2030-03-15') feesFrom('2030-04', { vollverdiener: 65 }); // for the month after: nobody is behind for it
      if (day === '2027-07-01') Object.assign(world.lower.record, { status: 'geringverdiener', statusHistory: [{ status: 'vollverdiener', startDate: '2025-01-15', endDate: day }, { status: 'geringverdiener', startDate: day }] });

      for (const m of Object.values(world)) {
        if (first) [m.last, m.charged] = [m.charged, 0];
        // a fresh start today, for whoever had joined before: what is open is dropped, credit stays - and the month
        // of the fresh start is owed in the new account
        if (resets.some((reset) => reset.date === day) && m.record.memberSince < day) {
          m.closing = m.balance + m.charged;
          m.balance = Math.max(0, m.closing) - m.charged;
          m.from = day;
        }
        // a new month, from the month of "member since" on. The full fee: 50, 60 from January 2027, 65 from April
        // 2030. The lower fee: 25, and 30 once that was entered
        if (first && month(day) >= month(m.record.memberSince)) {
          m.charged = m.record.status === 'geringverdiener' ? (day < '2028-05-20' ? 25 : 30) : day < '2027-01-01' ? 50 : day < '2030-04-01' ? 60 : 65;
          m.balance -= m.charged;
        }
        // the lower fee of 30 counts from March 2028 but was entered on 20 May: March, April and May cost 5 more
        if (day === '2028-05-20' && m.record.status === 'geringverdiener') m.balance -= 3 * 5;
      }

      // what is booked today: who, how much, dated when
      const booked = [];
      if (dayOfMonth === '03') booked.push(['punctual', world.punctual.charged, day], ['lower', world.lower.charged, day]);
      if (dayOfMonth === '10') booked.push(['late', world.late.last, day]);
      if (dayOfMonth === '10' && day >= '2027-04-01') booked.push(['behind', world.behind.charged, day]);
      if (dayOfMonth === '12' && day >= '2027-03-12') booked.push(['joiner', world.joiner.charged, day]);
      if (day === '2026-12-28') booked.push(['joiner', 50, day]); // a first fee, paid before joining
      if (day === '2027-01-11') booked.push(['behind', 100, '2026-12-20']); // booked late, for the time before the fresh start
      if (day === '2029-07-15') booked.push(['never', 60, day]); // paid on the day of a fresh start: into the new account
      for (const [who, amount, dated] of booked) {
        const m = world[who];
        m.record.payments.push({ id: `${who}-${day}`, amount, date: dated });
        m.record.totalPaid += amount;
        if (m.from && dated < m.from) {
          // it belongs to the time before the fresh start: it first makes up for what was dropped then
          const credit = Math.max(0, m.closing);
          m.closing += amount;
          m.balance += Math.max(0, m.closing) - credit;
        } else m.balance += amount;
      }

      for (const [who, m] of Object.entries(world)) {
        const served = on(t, day, m.record, resets, FEES, schedule);
        for (const [what, is, byHand] of [['balance', served._currentBalance, m.balance], ['open', served._overdueAmount, Math.max(0, -m.balance)],
          ['carried over', served._feeCarriedOver, Math.max(0, m.closing)], ['dropped', served._feeWrittenOff, Math.max(0, -m.closing)]]) {
          assert.ok(Math.abs(is - byHand) < 0.005, `${who} on ${day}: ${what} ${is}, by hand ${byHand}`);
        }
        assert.equal(served._feeReset, m.from, `${who} on ${day}: counts from`);
        assert.equal(served._statusMeta.isOverdue, m.balance < 0, `${who} on ${day}: overdue`);
      }
      // 1 January 2027: December open (late), 1200 owed and 450 paid (behind), 2000 paid (ahead); the joiner is not
      // a member yet
      if (day === '2027-01-01') assert.deepEqual(closings(), [0, -50, -750, -1200, 800, 0, 0]);
      // 15 July 2029, at 60 a month since 2027: what was paid before the 15th belongs to the time before - credit
      // for July where nothing was open (60, with the 50 the late payer and the joiner have had since; of the 30 at
      // the lower fee, 15 make up for the months that cost more after the fact), and where months were open it
      // makes up for those first (behind: 180 open, 60 paid on the 10th)
      if (day === '2029-07-15') assert.deepEqual(closings(), [60, 50, -120, -1800, -1000, 15, 110]);
    }
    // December 2030. The raise to 65 counts from April 2030 and moved no month before it: whoever pays the fee of
    // the month is where they were (paid up, the July of 2029 behind, 50 ahead; the late payer one month of 65
    // behind, less their 50). Only the fee entered late left its 15. Who pays nothing owes July 2029 to March 2030
    // at 60 and the nine months since at 65 - less the 60 one of them paid on the day of the fresh start
    assert.deepEqual(Object.values(world).map((m) => m.balance), [0, -15, -60, -1065, -1125, -15, 50]);
  });

  test('only real days are days, and only days within reach can be set', () => {
    for (const day of ['2027-01-01', '2028-02-29']) assert.equal(feeReset.parseDay(day), day);
    for (const junk of ['2027-02-30', '2027-13-01', '27-01-01', '01.01.2027', '2027-1-1', ' 2027-01-01', '', null, undefined, 20270101, {}]) {
      assert.equal(feeReset.parseDay(junk), null, String(junk));
    }
    const check = (day, resets = []) => feeReset.checkNewFeeReset(resets, day, '2026-11-10');
    // in the past or in the future - both are fine
    for (const day of ['2026-10-01', '2026-11-10', '2027-01-01', '2036-11-10']) assert.deepEqual(check(day), { date: day });
    // a mistyped year is refused instead of quietly starting (or never starting) something
    for (const day of ['2027-02-30', 'tomorrow', '', undefined, '1026-11-01', '1999-12-31', '2036-11-11', '2207-01-01']) assert.equal(check(day).status, 400, String(day));
    assert.equal(check(DAY, FRESH).status, 409, 'one fresh start per day');
  });

  test('the stored days are read as a clean list, and each says what it is today', () => {
    const stored = { resets: [{ date: '2030-01-01' }, '2026-01-01', { date: '2026-01-01', setByName: 'twice' }, { date: 'nonsense' }, null,
      { date: DAY, feesBefore: { vollverdiener: 50, geringverdiener: '25', keinverdiener: -1, note: 'x' }, setAt: 5, setBy: 'u1', setByName: 'Olga' }] };
    const resets = feeReset.normalizeFeeResets(stored);
    assert.deepEqual(resets.map((reset) => reset.date), ['2026-01-01', DAY, '2030-01-01']);
    assertHas(resets[1], { feesBefore: { vollverdiener: 50 }, setAt: 5, setBy: 'u1', setByName: 'Olga' });
    assert.equal(resets[0].feesBefore, null);
    assert.deepEqual(feeReset.normalizeFeeResets(undefined), []);

    assert.deepEqual(feeReset.describeFeeResets(resets, '2027-06-01').map((reset) => reset.state), ['replaced', 'active', 'scheduled']);
    assert.equal(feeReset.activeFeeReset(resets, '2025-12-31'), null);
    assert.equal(feeReset.activeFeeReset(resets, DAY), DAY, 'from the day itself on');
    // members get the days; the fees and who set them are for those who see the finances
    assert.deepEqual(Object.keys(feeReset.describeFeeResets(resets, '2027-06-01')[1]), ['date', 'state']);
    assertHas(feeReset.describeFeeResets(resets, '2027-06-01', { withDetails: true })[1], { feesBefore: { vollverdiener: 50 }, setByName: 'Olga' });
  });

  test('a fresh start keeps the fees of its time; one without them takes those of the time after it', () => {
    const now = { vollverdiener: 60, geringverdiener: 30, keinverdiener: 10, pausiert: 0, reportStartDate: null };
    const feesNow = { vollverdiener: 60, geringverdiener: 30, keinverdiener: 10, pausiert: 0 };
    // a new day keeps the fees that are set now - the fees only, no other setting
    assert.deepEqual(feeReset.feesBeforeDay([], now, DAY), feesNow);
    assert.deepEqual(feeReset.feesBeforeDay(FRESH, now, '2028-01-01'), feesNow);
    // a day before an existing fresh start lies in the time that one kept the fees of
    assert.deepEqual(feeReset.feesBeforeDay(FRESH, now, '2026-07-01'), FEES);
    // every month costs the fees of its time: before the fresh start the kept ones, from its month on those of now
    const month = (year, monthOfYear) => year * 12 + monthOfYear - 1;
    const feeOf = (resets, ...when) => feeReset.feesOfMonth(feeReset.feePeriods(resets, now), month(...when)).vollverdiener;
    assert.deepEqual([feeOf(FRESH, 2025, 1), feeOf(FRESH, 2026, 12), feeOf(FRESH, 2027, 1), feeOf(FRESH, 2031, 6)], [50, 50, 60, 60]);
    assert.equal(feeOf([], 2025, 1), 60, 'no fresh start: one fee for all time, as always');
    // one without kept fees takes those of the time after it
    assert.deepEqual([feeOf([{ date: '2026-01-01' }, ...FRESH], 2025, 6), feeOf([{ date: DAY }], 2025, 6)], [50, 60]);
    // only fresh starts whose day has come settle the accounts
    assert.deepEqual(feeReset.settledFeeResets([...FRESH, { date: '2030-01-01' }], '2029-01-01'), [DAY]);
    assert.deepEqual(feeReset.settledFeeResets(FRESH, '2026-12-31'), []);
  });

  test('the web app works out "paid until" like the server when the server sent none', async (t) => {
    const { calculatePaidUntil } = await webApp();
    const month = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    for (const person of [behind, settled, ahead, member([[1000, '2025-06-10'], [70, '2027-01-08']])]) {
      for (const resets of [[], FRESH]) {
        const served = on(t, '2027-02-15', person, resets);
        assert.equal(month(calculatePaidUntil(served, FEES)), paidUpTo(served), `${person.totalPaid} paid, ${resets.length} fresh start(s)`);
      }
    }
  });

  test('the web app says when a payment dated before the fresh start first makes up for dropped fees', async (t) => {
    const { droppedFeesBefore } = await webApp();
    const served = on(t, '2027-02-15', behind);
    assert.equal(droppedFeesBefore(served, '2026-12-20'), 300);
    assert.equal(droppedFeesBefore(served, DAY), 0, 'from the day on a payment is credit');
    assert.equal(droppedFeesBefore(on(t, '2027-02-15', ahead), '2026-12-20'), 0, 'nothing was dropped');
    assert.equal(droppedFeesBefore(on(t, '2027-02-15', behind, []), '2026-12-20'), 0, 'no fresh start');
    assert.equal(droppedFeesBefore(served, ''), 0);
    assert.equal(droppedFeesBefore(null, '2026-12-20'), 0);
  });

  test('confirming needs the very day typed again - as shown, never another one', async () => {
    const { typedDayMatches } = await webApp();
    for (const typed of ['01.01.2027', '1.1.2027', '01/01/2027', ' 01.01.2027 ', '1. 1. 2027', '2027-01-01']) assert.equal(typedDayMatches(typed, DAY), true, typed);
    for (const typed of ['', '01.01.2026', '02.01.2027', '01.02.2027', '1.1.27', '2027-1-1', '01012027', '2027-01-01x', 'ja', null, undefined]) {
      assert.equal(typedDayMatches(typed, DAY), false, String(typed));
    }
    // the day comes first, as the dialog shows it: 3 November is not 11 March
    assert.equal(typedDayMatches('03.11.2026', '2026-11-03'), true);
    assert.equal(typedDayMatches('11.03.2026', '2026-11-03'), false);
    assert.equal(typedDayMatches('01.01.2027', 'nonsense'), false);
  });

  test('the member card names a fresh start as a notice: from its day on, for 60 days', async () => {
    const { feeResetIsNews } = await webApp();
    assert.equal(feeResetIsNews('2026-11-01', '2026-11-01'), true, 'on its day');
    assert.equal(feeResetIsNews('2026-11-01', '2026-12-30'), true, 'day 59');
    assert.equal(feeResetIsNews('2026-11-01', '2026-12-31'), false, 'after 60 days it is old news');
    assert.equal(feeResetIsNews('2026-11-01', '2027-06-01'), false);
    // the server sends the day once it has come: a device whose clock is behind still shows it
    assert.equal(feeResetIsNews('2026-11-01', '2026-10-31'), true);
    for (const day of [null, undefined, '', 'nonsense', '2026-11']) assert.equal(feeResetIsNews(day, '2026-11-01'), false, String(day));
    assert.equal(feeResetIsNews('2026-11-01', ''), false);
  });
});

// CALDERA: the monthly fees over time - every change of the fees says from which month it counts, and the months
// before keep the old fees (backend/feeSchedule.js). What is stored about the fees changes by the rules of
// backend/feeState.js
describe('the monthly fees over time', () => {
  const { preprocessPersonServerSide, feeResetImpact, feeChangeImpact } = require('../backend/derivedData');
  const feeReset = require('../backend/feeReset');
  const fees = require('../backend/feeSchedule');
  const feeState = require('../backend/feeState');
  const { freezeTime, assertHas } = require('./helpers');

  const FEES = { vollverdiener: 50, geringverdiener: 25, keinverdiener: 10, pausiert: 0 };
  // A history is the fees from the beginning and the changes, each with the month it counts from
  const flat = (base = FEES) => ({ base, changes: [] });
  const from = (schedule, month, table, replaces) => fees.withFeeChange(schedule, { from: month, fees: table, replaces });
  // The history of the examples: 50 from the beginning, 60 from January 2027
  const RAISED = from(flat(), '2027-01', { vollverdiener: 60 });
  const full = (schedule, month) => fees.feesInMonth(schedule, month).vollverdiener;
  // A member since January 2025 with payments as [amount, day]
  const member = (payments = [], extra = {}) => ({
    id: 'p1', uid: 'u1', name: 'Paula', status: 'vollverdiener', memberSince: '2025-01-15', originalMemberSince: '2025-01-15',
    standingOrders: [], statusHistory: [{ status: 'vollverdiener', startDate: '2025-01-15' }],
    payments: payments.map(([amount, date], i) => ({ id: `pay${i}`, amount, date })),
    totalPaid: payments.reduce((sum, [amount]) => sum + amount, 0),
    ...extra
  });
  // [amount] on the 3rd of every month from [first] to [last] ('YYYY-MM')
  const monthly = (first, last, amount) => {
    const paid = [];
    for (let month = first; month <= last; month = fees.addMonths(month, 1)) paid.push([amount, `${month}-03`]);
    return paid;
  };
  // paid 50 every month, January 2025 to March 2028: always on time
  const punctual = member(monthly('2025-01', '2028-03', 50));
  const noon = (day) => new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 12).toISOString();
  const on = (t, day, person, schedule, resets = []) => {
    const restore = freezeTime(t, noon(day));
    try { return preprocessPersonServerSide(structuredClone(person), {}, resets, schedule); } finally { restore(); }
  };
  const paidUpTo = (served) => { const date = new Date(served._paidUntil); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; };
  const nobody = { count: 0, total: 0 };

  test('a change of the fees counts from its month: the months before keep the old fees', (t) => {
    assertHas(on(t, '2028-03-15', punctual, flat()), { _currentBalance: 0, _overdueAmount: 0, _monthlyFee: 50 });
    // 60 from April 2028, entered in March: no month before April costs anything else, nobody is behind
    const raised = from(flat(), '2028-04', { vollverdiener: 60 });
    assert.deepEqual(on(t, '2028-03-15', punctual, raised), on(t, '2028-03-15', punctual, flat()));
    assert.deepEqual(['2025-01', '2028-03', '2028-04', '2031-12'].map((month) => full(raised, month)), [50, 50, 60, 60]);
    // from April on a month costs 60
    assertHas(on(t, '2028-04-15', punctual, raised), { _currentBalance: -60, _overdueAmount: 60, _monthlyFee: 60 });
    // the statuses the change does not name keep what they cost
    assert.deepEqual(fees.feesInMonth(raised, '2028-04'), { ...FEES, vollverdiener: 60 });
    // with one fee for all time - as it was - the same 60 cost every month since 2025: 39 months at 10 more
    assertHas(on(t, '2028-03-15', punctual, flat({ ...FEES, vollverdiener: 60 })), { _currentBalance: -390, _overdueAmount: 390 });
    // paid until: what was paid is used up at the fees of each month - 2000 pay the 39 months at 50, and the 50
    // that are left do not pay an April at 60
    const paidAhead = member([[2000, '2025-02-01']]);
    assert.deepEqual([paidUpTo(on(t, '2028-03-15', paidAhead, flat())), paidUpTo(on(t, '2028-03-15', paidAhead, raised))], ['2028-04', '2028-03']);
  });

  test('fees and payments with cents: who paid every month exactly is paid up to this month', async (t) => {
    const { calculatePaidUntil } = await import(require('url').pathToFileURL(require('path').join(__dirname, '..', 'assets', 'finance.js')).href);
    // added up as they are, amounts like 49.99 drift by a fraction of a cent: "paid until" used to show the month
    // before for one in five of these members
    for (const fee of [49.99, 33.33, 9.99, 19.9, 15.55, 66.67, 8.33, 0.1, 12.5, 50]) {
      for (const count of [1, 2, 3, 5, 7, 12, 24, 36, 47]) {
        const last = fees.addMonths('2025-01', count - 1);
        const exact = member(monthly('2025-01', last, fee));
        const served = on(t, `${last}-20`, exact, flat({ ...FEES, vollverdiener: fee }));
        assert.equal(paidUpTo(served), last, `${count} months at ${fee}`);
        assert.ok(Math.abs(served._currentBalance) < 0.005 && served._overdueAmount === 0 && !served._statusMeta.isOverdue, `${count} months at ${fee}: paid up`);
        // the web app's own "paid until" (when the server sent none) counts the same way
        const shown = calculatePaidUntil({ ...served, _paidUntil: null }, { ...FEES, vollverdiener: fee });
        assert.equal(`${shown.getFullYear()}-${String(shown.getMonth() + 1).padStart(2, '0')}`, last, `${count} months at ${fee}, in the web app`);
        // one cent short is one month short, one cent more is not one month more
        const short = member([...monthly('2025-01', last, fee), [-0.01, `${last}-04`]]);
        assert.equal(paidUpTo(on(t, `${last}-20`, short, flat({ ...FEES, vollverdiener: fee }))), fees.addMonths(last, -1), `${count} months at ${fee}, a cent short`);
        const more = member([...monthly('2025-01', last, fee), [0.01, `${last}-04`]]);
        assert.equal(paidUpTo(on(t, `${last}-20`, more, flat({ ...FEES, vollverdiener: fee }))), last, `${count} months at ${fee}, a cent more`);
      }
    }
  });

  test('who joined on a 1st owes from that month on, wherever the server stands', async (t) => {
    const { calculatePaidUntil } = await import(require('url').pathToFileURL(require('path').join(__dirname, '..', 'assets', 'finance.js')).href);
    // read as a date, "2025-03-01" is midnight in Greenwich: still February west of it, where the member was charged
    // one month too many (and a fresh start dropped it as open fees)
    const sinceTheFirst = (payments) => member(payments, { memberSince: '2025-03-01', originalMemberSince: '2025-03-01', statusHistory: [{ status: 'vollverdiener', startDate: '2025-03-01' }] });
    const [had, home] = [process.env.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
    t.after(() => { process.env.TZ = home; if (had === undefined) delete process.env.TZ; });
    for (const zone of ['Pacific/Honolulu', 'America/Los_Angeles', 'America/New_York', 'UTC', 'Europe/Berlin', 'Asia/Kolkata', 'Pacific/Auckland']) {
      process.env.TZ = zone;
      // 50 every month from March 2025 to February 2026: paid up, to the month
      const served = on(t, '2026-02-20', sinceTheFirst(monthly('2025-03', '2026-02', 50)), flat());
      assertHas(served, { _currentBalance: 0, _overdueAmount: 0 }, zone);
      assert.equal(paidUpTo(served), '2026-02', zone);
      assert.equal(paidUpTo(on(t, '2026-02-20', sinceTheFirst([]), flat())), '2025-02', `${zone}: nothing paid, the month before the first`);
      // a status counts from the month of its day, also on a 1st
      const reduced = sinceTheFirst(monthly('2025-03', '2026-02', 50));
      reduced.statusHistory = [{ status: 'vollverdiener', startDate: '2025-03-01', endDate: '2025-12-01' }, { status: 'geringverdiener', startDate: '2025-12-01' }];
      assertHas(on(t, '2026-02-20', { ...reduced, status: 'geringverdiener' }, flat()), { _currentBalance: 75, _monthlyFee: 25 }, `${zone}: 25 from December`);
      // a fresh start on 1 January 2026 finds the ten months of 2025 paid: nothing to drop, nothing to carry over
      const fresh = on(t, '2026-02-20', sinceTheFirst(monthly('2025-03', '2026-02', 50)), flat(), ['2026-01-01']);
      assertHas(fresh, { _feeReset: '2026-01-01', _feeWrittenOff: 0, _feeCarriedOver: 0, _currentBalance: 0 }, `${zone}, after a fresh start`);
      // the web app's own "paid until" (when the server sent none), in a browser in that zone
      for (const account of [served, fresh]) {
        const shown = calculatePaidUntil({ ...account, _paidUntil: null }, FEES);
        assert.equal(`${shown.getFullYear()}-${String(shown.getMonth() + 1).padStart(2, '0')}`, '2026-02', `${zone}, in the web app`);
      }
    }
  });

  test('a change may count from a month still to come, from this month or from a month in the past', (t) => {
    // still to come: nothing moves until the month comes
    const planned = from(flat(), '2028-07', { vollverdiener: 60 });
    assert.deepEqual(on(t, '2028-03-15', punctual, planned), on(t, '2028-03-15', punctual, flat()));
    assert.deepEqual(['2028-06-30', '2028-07-01'].map((day) => on(t, day, punctual, planned)._monthlyFee), [50, 60]);
    // from this month: March costs 10 more
    assertHas(on(t, '2028-03-15', punctual, from(flat(), '2028-03', { vollverdiener: 60 })), { _currentBalance: -10, _monthlyFee: 60 });
    // from a month in the past, it reaches back: January, February and March cost 10 more
    assertHas(on(t, '2028-03-15', punctual, from(flat(), '2028-01', { vollverdiener: 60 })), { _currentBalance: -30, _overdueAmount: 30 });
    // a member who is still to join is shown the fee of this month
    const nextYear = member([], { memberSince: '2029-06-15', originalMemberSince: '2029-06-15', statusHistory: [{ status: 'vollverdiener', startDate: '2029-06-15' }] });
    assertHas(on(t, '2028-03-15', nextYear, planned), { _currentStatus: null, _monthlyFee: 50, _currentBalance: 0 });
  });

  test('the fees from the beginning can be corrected, a change can be edited, moved and taken back', () => {
    const months = (schedule) => ['2026-12', '2027-01', '2027-02', '2027-03'].map((month) => full(schedule, month));
    assert.deepEqual(months(RAISED), [50, 60, 60, 60]);
    // the fees from the beginning count for the time before the first change
    assert.deepEqual(months(from(RAISED, null, { vollverdiener: 45 })), [45, 60, 60, 60]);
    // edited: another amount from the same month
    assert.deepEqual(months(from(RAISED, '2027-01', { vollverdiener: 65 }, '2027-01')), [50, 65, 65, 65]);
    // moved to March: January and February cost the fees before it again
    const moved = from(RAISED, '2027-03', { vollverdiener: 60 }, '2027-01');
    assert.deepEqual([months(moved), moved.changes.map((change) => change.from)], [[50, 50, 50, 60], ['2027-03']]);
    // taken back: as if it had never been set
    assert.deepEqual(fees.withoutFeeChange(RAISED, '2027-01'), flat());
    // every change is the fees from its month on, until the next one - one entered for a month in between does not
    // reach into the later one
    const three = from(from(RAISED, '2029-07', { vollverdiener: 65, geringverdiener: 30 }), '2028-01', { keinverdiener: 0 });
    assert.deepEqual(['2026-12', '2027-06', '2028-06', '2030-01'].map((month) => fees.feesInMonth(three, month)), [
      FEES, { ...FEES, vollverdiener: 60 }, { ...FEES, vollverdiener: 60, keinverdiener: 0 }, { ...FEES, vollverdiener: 65, geringverdiener: 30 }
    ]);
    // fees from a month that are the fees counting before it anyway say nothing and are not kept - a change set
    // back to what it changed is gone
    assert.deepEqual(from(RAISED, '2028-01', { vollverdiener: 60 }), RAISED);
    assert.deepEqual(from(RAISED, '2027-01', { vollverdiener: 50 }, '2027-01'), flat());
    // but what was entered stays until it is taken back, also while another change makes it say nothing: with the
    // fee of 2027 edited to 65 and back, the 65 from 2029 are still there
    const twice = from(RAISED, '2029-01', { vollverdiener: 65 });
    const swallowed = from(twice, '2027-01', { vollverdiener: 65 }, '2027-01');
    assert.deepEqual([swallowed.changes.map((change) => change.from), full(swallowed, '2028-06'), full(swallowed, '2029-06')], [['2027-01', '2029-01'], 65, 65]);
    assert.deepEqual(from(swallowed, '2027-01', { vollverdiener: 60 }, '2027-01'), twice);
    // the same with the fees from the beginning: at 60 from the beginning, "60 from January 2027" waits
    const waiting = from(RAISED, null, { vollverdiener: 60 });
    assert.deepEqual([waiting.changes.map((change) => change.from), months(waiting)], [['2027-01'], [60, 60, 60, 60]]);
    assert.deepEqual(from(waiting, null, { vollverdiener: 50 }), RAISED);
    // none of this touches the history it started from
    assert.deepEqual(months(RAISED), [50, 60, 60, 60]);
  });

  test('only real months and amounts are taken, and a change has to change something', () => {
    for (const month of ['2027-01', '2028-12']) assert.equal(fees.parseMonth(month), month);
    for (const junk of ['2027-13', '2027-00', '2027-1', '27-01', '2027-01-01', '01.2027', ' 2027-01', '', null, undefined, 202701, {}]) assert.equal(fees.parseMonth(junk), null, String(junk));
    assert.deepEqual([fees.addMonths('2027-01', -1), fees.addMonths('2027-12', 1), fees.addMonths('2027-06-15', 0)], ['2026-12', '2028-01', '2027-06']);

    const table = { vollverdiener: 60, geringverdiener: 30, keinverdiener: 10 };
    const check = (input, schedule = RAISED) => fees.checkFeeChange(schedule, input, '2026-11-11');
    // past, this month, still to come, or the fees from the beginning
    for (const month of ['2025-01', '2026-11', '2028-04', '2036-11', null]) assert.deepEqual(check({ from: month, fees: table }).change, { from: month, fees: table, replaces: null });
    // a mistyped month is refused instead of quietly counting from somewhere
    for (const month of ['2028-13', 'April', '', undefined, 0, '1999-12', '1026-11', '2036-12', '2207-01']) assert.equal(check({ from: month, fees: table }).status, 400, String(month));
    // every status needs an amount of 0 or more - a typed text, a missing or a huge one is not taken
    for (const amount of [undefined, null, '60', -1, NaN, Infinity, 100000.01]) assert.equal(check({ from: '2028-04', fees: { ...table, vollverdiener: amount } }).status, 400, String(amount));
    assert.deepEqual(check({ from: '2028-04', fees: { vollverdiener: 0, geringverdiener: 0, keinverdiener: 0 } }).change.fees, { vollverdiener: 0, geringverdiener: 0, keinverdiener: 0 });
    assert.equal(check({ from: '2028-04' }).status, 400);
    // amounts are kept in cents, and no other status can be written this way
    assert.deepEqual(check({ from: '2028-04', fees: { ...table, vollverdiener: 59.999, pausiert: 5, extra: 1 } }).change.fees, table);

    // an edited or moved change has to be there, and does not land on another one
    const two = from(RAISED, '2028-01', { vollverdiener: 65 });
    assert.deepEqual(check({ from: '2027-03', fees: table, replaces: '2027-01' }, two).change, { from: '2027-03', fees: table, replaces: '2027-01' });
    assert.equal(check({ from: '2027-03', fees: table, replaces: '2026-01' }, two).status, 404);
    assert.equal(check({ from: '2028-01', fees: table, replaces: '2027-01' }, two).status, 409);
    assert.equal(check({ from: null, fees: table, replaces: '2027-01' }, two).status, 400, 'a change always has its month');
    // the fees that count anyway are no change
    assert.equal(check({ from: '2027-01', fees: { vollverdiener: 60, geringverdiener: 25, keinverdiener: 10 } }).status, 409);
    assert.equal(check({ from: '2029-01', fees: { vollverdiener: 60, geringverdiener: 25, keinverdiener: 10 } }).status, 409);
    assert.equal(check({ from: null, fees: { vollverdiener: 50, geringverdiener: 25, keinverdiener: 10 } }).status, 409);

    assert.deepEqual(fees.checkFeeRemoval(RAISED, '2027-01'), { from: '2027-01' });
    for (const month of ['2027-02', null, undefined, 'nonsense']) assert.equal(fees.checkFeeRemoval(RAISED, month).status, 404, String(month));
  });

  test('the history says what it is today, and its version changes when a month costs something else', () => {
    const schedule = fees.withFeeChange(RAISED, { from: '2028-07', fees: { vollverdiener: 65 }, setAt: 5, setBy: 'u1', setByName: 'Olga' });
    const now = fees.describeFeeSchedule(schedule, '2027-06-15');
    assertHas(now, { month: '2027-06', current: { ...FEES, vollverdiener: 60 }, since: '2027-01', next: { from: '2028-07', fees: { ...FEES, vollverdiener: 65 } } });
    assert.deepEqual(now.entries.map((entry) => [entry.from, entry.state, entry.fees.vollverdiener]), [[null, 'past', 50], ['2027-01', 'current', 60], ['2028-07', 'planned', 65]]);
    // before the first change the fees from the beginning count; a change counts from the first day of its month
    assertHas(fees.describeFeeSchedule(schedule, '2026-12-31'), { current: FEES, since: null, next: { from: '2027-01', fees: { ...FEES, vollverdiener: 60 } } });
    assert.deepEqual(fees.describeFeeSchedule(schedule, '2026-12-31').entries.map((entry) => entry.state), ['current', 'planned', 'planned']);
    assertHas(fees.describeFeeSchedule(schedule, '2028-07-01'), { since: '2028-07', next: null });
    // an entry that changes nothing at the moment is neither "since" nor "to come": the page says since when the
    // fees have really been what they are, and when they will really be others
    const quiet = from(from(from(RAISED, '2029-01', { vollverdiener: 65 }), '2027-06', { vollverdiener: 65 }), '2027-01', { vollverdiener: 65 }, '2027-01');
    assert.deepEqual(quiet.changes.map((change) => [change.from, change.fees.vollverdiener]), [['2027-01', 65], ['2027-06', 65], ['2029-01', 65]]);
    assertHas(fees.describeFeeSchedule(quiet, '2027-08-15'), { since: '2027-01', next: null, current: { ...FEES, vollverdiener: 65 } });
    assertHas(fees.describeFeeSchedule(quiet, '2026-12-15'), { since: null, next: { from: '2027-01', fees: { ...FEES, vollverdiener: 65 } } });
    // with 70 from 2030: in March 2027 the next change is that one - not the entry of June, which changes nothing
    const later = from(quiet, '2030-01', { vollverdiener: 70 });
    assertHas(fees.describeFeeSchedule(later, '2027-03-15'), { since: '2027-01', next: { from: '2030-01', fees: { ...FEES, vollverdiener: 70 } } });
    assert.deepEqual(fees.describeFeeSchedule(later, '2027-03-15').entries.map((entry) => [entry.from, entry.state]), [[null, 'past'], ['2027-01', 'current'], ['2027-06', 'planned'], ['2029-01', 'planned'], ['2030-01', 'planned']]);
    // taking one change back leaves every other one as it was entered, also those that say nothing at the moment
    assert.deepEqual(fees.withoutFeeChange(later, '2030-01'), quiet);
    assert.deepEqual(fees.withoutFeeChange(later, '2029-01').changes.map((change) => change.from), ['2027-01', '2027-06', '2030-01']);
    // members get the fees; who set them is for those who see the finances
    assert.deepEqual(Object.keys(now.entries[2]), ['from', 'fees', 'state']);
    assertHas(fees.describeFeeSchedule(schedule, '2027-06-15', { withDetails: true }).entries[2], { setAt: 5, setByName: 'Olga' });

    // the version: the same for the same prices, whoever set them - another one as soon as a month costs something else
    assert.equal(fees.feeScheduleVersion(schedule), fees.feeScheduleVersion(from(RAISED, '2028-07', { vollverdiener: 65 })));
    const versions = [schedule, RAISED, flat(), from(schedule, '2028-08', { vollverdiener: 65 }, '2028-07'), from(schedule, null, { keinverdiener: 5 })].map(fees.feeScheduleVersion);
    assert.equal(new Set(versions).size, versions.length);
  });

  test('the stored history is read as a clean one', () => {
    const stored = { base: { ...FEES, note: 'x', keinverdiener: '10' }, log: [{ action: 'set', from: '2027-01', fees: FEES, at: 5, by: 'u1', byName: 'Olga' }, { action: 'removed', from: null }, { action: 'other', from: '2027-01' }, { action: 'set', from: 'nonsense' }, null],
      changes: [{ from: '2028-07', fees: { ...FEES, vollverdiener: 65 }, setAt: 7, setByName: 'Olga' }, { from: '2027-01', fees: { ...FEES, vollverdiener: 55 } }, { from: 'nonsense', fees: FEES }, null,
        { from: '2027-01', fees: { ...FEES, vollverdiener: 60 } }, { from: '2029-01', fees: { ...FEES, vollverdiener: 65 } }] };
    const schedule = fees.normalizeFeeSchedule(stored);
    // real months only, each once (the entry stored last counts), the earliest first - also one that changes
    // nothing at the moment
    assert.deepEqual(schedule.changes.map((change) => [change.from, change.fees.vollverdiener]), [['2027-01', 60], ['2028-07', 65], ['2029-01', 65]]);
    assert.deepEqual(schedule.base, { vollverdiener: 50, geringverdiener: 25, pausiert: 0 });
    assertHas(schedule.changes[1], { setAt: 7, setBy: '', setByName: 'Olga' });
    for (const none of [undefined, null, [], 'x', {}, { changes: [] }]) assert.equal(fees.normalizeFeeSchedule(none), null);
    assert.deepEqual(fees.normalizeFeeScheduleLog(stored).map((entry) => [entry.action, entry.from]), [['set', '2027-01'], ['removed', null]]);
    assert.deepEqual(fees.normalizeFeeScheduleLog(undefined), []);
    // only the newest entries of the log are kept
    let log = [];
    for (let i = 0; i < 130; i += 1) log = fees.withFeeLogEntry(log, { action: 'set', from: '2027-01', at: i });
    assert.deepEqual([log.length, log[0].at, log[99].at], [100, 30, 129]);
  });

  test('an instance from before the history costs exactly what it cost', (t) => {
    const dearer = { ...FEES, vollverdiener: 60, reportStartDate: null };
    const JANUARY = { date: '2027-01-01', feesBefore: FEES };
    const behind = member([[900, '2025-06-10']]);
    const ahead = member([[1500, '2025-06-10']]);
    const cases = {
      // one fee for all time
      'no fresh start': [[], dearer, { base: { ...FEES, vollverdiener: 60 }, changes: [] }],
      // a fresh start kept the fees of the time before it; the fees set now counted from its month on
      'a fresh start that kept other fees': [[JANUARY], dearer, { base: FEES, changes: ['2027-01'] }],
      'a fresh start that kept the same fees': [[JANUARY], FEES, { base: FEES, changes: [] }],
      // one without fees of its own took those of the time after it
      'a fresh start without kept fees': [[{ date: '2027-01-01' }], dearer, { base: { ...FEES, vollverdiener: 60 }, changes: [] }],
      'two fresh starts': [[JANUARY, { date: '2029-07-15', feesBefore: { ...FEES, vollverdiener: 55 } }], dearer, { base: FEES, changes: ['2027-01', '2029-07'] }],
      'two fresh starts in one month': [[JANUARY, { date: '2027-01-20', feesBefore: { ...FEES, vollverdiener: 55 } }], dearer, { base: FEES, changes: ['2027-01'] }]
    };
    for (const [name, [resets, settings, expected]] of Object.entries(cases)) {
      const schedule = fees.scheduleFromLegacy(resets, settings);
      assert.deepEqual([schedule.base, schedule.changes.map((change) => change.from)], [expected.base, expected.changes], name);
      // every month costs what it cost ...
      const periods = feeReset.feePeriods(resets, settings);
      for (let month = '2024-01'; month <= '2031-12'; month = fees.addMonths(month, 1)) {
        assert.deepEqual(fees.feesInMonth(schedule, month), feeReset.feesOfMonth(periods, feeReset.monthIndexOf(month)), `${name}: ${month}`);
      }
      // ... and every account stands where it stood, before and after the fresh starts
      for (const person of [behind, ahead, punctual]) {
        for (const day of ['2026-12-15', '2027-01-01', '2027-02-15', '2029-07-15', '2030-03-01']) {
          const restore = freezeTime(t, noon(day));
          const [was, is] = [preprocessPersonServerSide(structuredClone(person), settings, resets), preprocessPersonServerSide(structuredClone(person), settings, resets, schedule)];
          restore();
          assert.deepEqual(is, was, `${name}: ${person.totalPaid} paid, on ${day}`);
        }
      }
    }
    // a fresh start that was planned with the new fee entered early: the fee counts from its month, still to come
    const planned = fees.describeFeeSchedule(fees.scheduleFromLegacy([JANUARY], dearer), '2026-12-15');
    assertHas(planned, { current: FEES, since: null, next: { from: '2027-01', fees: { ...FEES, vollverdiener: 60 } } });
  });

  test('before it is saved, the admin sees in numbers what a change of the fees does', (t) => {
    const paidAhead = member([[2000, '2025-02-01']], { id: 'p2' });
    const lowFee = member(monthly('2025-01', '2028-03', 25), { id: 'p3', status: 'geringverdiener', statusHistory: [{ status: 'geringverdiener', startDate: '2025-01-15' }] });
    const people = [punctual, paidAhead, lowFee, { ...punctual, id: 'p4', pays: false }, { id: 'p5', name: 'Gone', isDeleted: true, payments: [] }];
    const untouched = structuredClone(people);
    const impact = (after, before = flat(), resets = []) => feeChangeImpact(people, resets, before, after, '2028-03-15');
    const dearer = { ...FEES, vollverdiener: 60 };

    // the full fee at 60 from January 2028, entered in March: January, February and March cost the two full earners
    // 10 more each - one is behind for it, the other has less credit
    assertHas(impact(from(flat(), '2028-01', { vollverdiener: 60 })), {
      inEffect: true, members: 3, more: { count: 2, total: 60 }, less: nobody, freshStart: null,
      stretches: [{ first: '2028-01', last: null, before: FEES, after: dearer }]
    });
    assert.deepEqual(people, untouched, 'the records are only read');
    // from April, the month after: it moves no account today
    assertHas(impact(from(flat(), '2028-04', { vollverdiener: 60 })), { inEffect: false, members: 3, more: nobody, less: nobody, stretches: [{ first: '2028-04', last: null, before: FEES, after: dearer }] });
    // lowered to 40 from January 2027: 15 months at 10 less for each of the two
    assertHas(impact(from(flat(), '2027-01', { vollverdiener: 40 })), { inEffect: true, more: nobody, less: { count: 2, total: 300 } });
    // the fees from the beginning: all 39 months
    assertHas(impact(from(flat(), null, { vollverdiener: 60 })), { more: { count: 2, total: 780 }, stretches: [{ first: null, last: null, before: FEES, after: dearer }] });
    // a change of the lower fee only reaches who pays it
    assertHas(impact(from(flat(), '2028-03', { geringverdiener: 30 })), { more: { count: 1, total: 5 } });

    // moved from January to March 2027: January and February cost the old fee again
    assertHas(impact(from(RAISED, '2027-03', { vollverdiener: 60 }, '2027-01'), RAISED), { less: { count: 2, total: 40 }, stretches: [{ first: '2027-01', last: '2027-02', before: dearer, after: FEES }] });
    // taken back: from its month on the fees before it count again - 15 months at 10 less for each of the two
    assertHas(impact(fees.withoutFeeChange(RAISED, '2027-01'), RAISED), { less: { count: 2, total: 300 }, stretches: [{ first: '2027-01', last: null, before: dearer, after: FEES }] });
    // a change in between counts until the next one
    const later = from(RAISED, '2028-01', { vollverdiener: 65 });
    assert.deepEqual(impact(from(later, '2027-07', { vollverdiener: 62 }), later).stretches, [{ first: '2027-07', last: '2027-12', before: dearer, after: { ...FEES, vollverdiener: 62 } }]);

    // the numbers are what the served balances then do
    const balances = (schedule) => people.slice(0, 3).map((person) => on(t, '2028-03-15', person, schedule)._currentBalance);
    assert.deepEqual([balances(flat()), balances(from(flat(), '2028-01', { vollverdiener: 60 }))], [[0, 50, 0], [-30, 20, 0]]);

    // a fresh start that has come and lies after a month that costs something else: what was dropped or carried
    // over on it is worked out again, and the admin is told which one
    const freshStarts = [{ date: '2027-01-01' }, { date: '2029-01-01' }];
    assert.equal(impact(from(flat(), '2026-07', { vollverdiener: 60 }), flat(), freshStarts).freshStart, '2027-01-01');
    assert.equal(impact(from(flat(), null, { vollverdiener: 60 }), flat(), freshStarts).freshStart, '2027-01-01');
    // from the month of the fresh start on, the change only reaches the account that was opened then
    assert.equal(impact(from(flat(), '2027-01', { vollverdiener: 60 }), flat(), freshStarts).freshStart, null);
    // a change moved from before the fresh start to after it, with another amount: two stretches cost something
    // else, and the earlier one lies before the fresh start
    const early = from(flat(), '2026-07', { vollverdiener: 60 });
    const movedAcross = impact(from(early, '2027-03', { vollverdiener: 65 }, '2026-07'), early, freshStarts);
    assert.deepEqual([movedAcross.stretches.map((stretch) => [stretch.first, stretch.last]), movedAcross.freshStart], [[['2026-07', '2027-02'], ['2027-03', null]], '2027-01-01']);
  });

  test('a fresh start and the fees do not move each other', (t) => {
    const DAY = '2027-01-01';
    const behind = member([[900, '2025-06-10']]);
    const ahead = member([[1500, '2025-06-10']], { id: 'p2' });
    const freshStart = [{ date: DAY }];
    // the 24 months before it cost 50: 300 open are dropped, 300 paid ahead are carried over - and since January a
    // month costs 60
    assertHas(on(t, '2027-02-15', behind, RAISED, freshStart), { _feeReset: DAY, _feeWrittenOff: 300, _currentBalance: -120 });
    assertHas(on(t, '2027-02-15', ahead, RAISED, freshStart), { _feeReset: DAY, _feeCarriedOver: 300, _currentBalance: 180 });
    // fees changed later, from a month after it: what was dropped or carried over stays what it was
    const again = from(RAISED, '2027-02', { vollverdiener: 70 });
    assertHas(on(t, '2027-02-15', behind, again, freshStart), { _feeWrittenOff: 300, _currentBalance: -130 });
    assertHas(on(t, '2027-02-15', ahead, again, freshStart), { _feeCarriedOver: 300, _currentBalance: 170 });
    // setting it or taking it back changes the price of no month - also after the fees were changed (taken back, it
    // used to charge the time before at the fees set now)
    const people = [behind, ahead];
    for (const [resets, schedule] of [[[], RAISED], [freshStart, RAISED], [freshStart, again]]) {
      assertHas(feeResetImpact(people, {}, resets, DAY, '2027-03-01', schedule), { behind: { count: 1, total: 300 }, ahead: { count: 1, total: 300 }, owesMore: nobody, feesBefore: FEES, feesWithout: FEES, repriced: false });
    }
    assert.deepEqual(on(t, '2027-02-15', behind, RAISED, [])._currentBalance, 900 - 24 * 50 - 2 * 60);
    // only fees changed for the time before it work out again what was settled then - at 40 a month, 60 were open
    assertHas(on(t, '2027-02-15', behind, from(RAISED, null, { vollverdiener: 40 }), freshStart), { _feeWrittenOff: 60, _currentBalance: -120 });
  });

  // What is stored: a plain map in the place of the database
  const memory = (values = {}) => {
    const map = new Map(Object.entries(structuredClone(values)));
    return { map, get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : null), set: async (key, value) => { map.set(key, structuredClone(value)); } };
  };
  const olga = { by: 'u1', byName: 'Olga Owner' };

  test('the history of an older instance is written down with the first change, before it', async () => {
    // one fresh start that kept 50 for the time before it, and 60 set since
    const store = memory({ settings: { ...FEES, vollverdiener: 60, reportStartDate: '2026-01-01' }, feeResets: { resets: [{ date: '2027-01-01', feesBefore: FEES, setByName: 'Olga Owner' }], log: [] } });
    const read = await feeState.readFeeState(store);
    assertHas(read, { stored: false, log: [], schedule: { base: FEES, changes: [{ from: '2027-01', fees: { ...FEES, vollverdiener: 60 }, setAt: null, setBy: '', setByName: '' }] } });
    assert.deepEqual([read.resets.map((reset) => reset.date), store.map.has('feeSchedule')], [['2027-01-01'], false], 'reading writes nothing');

    // the fresh start is taken back: no month costs anything else for it
    await feeState.changeFeeResets(store, (current, schedule) => {
      assert.deepEqual(schedule, read.schedule, 'the change sees the fees over time');
      return { resets: [], log: [...current.log, { action: 'removed', date: '2027-01-01', at: 9, by: 'u1', byName: 'Olga Owner' }] };
    }, '2027-03-01');
    const after = await feeState.readFeeState(store);
    assertHas(after, { stored: true, resets: [], schedule: read.schedule });
    assert.equal(after.resetLog.length, 1);
    // the fee settings keep the fees of the month for older apps to read - and whatever else was in them
    assert.deepEqual(store.map.get('settings'), { ...FEES, vollverdiener: 60, reportStartDate: '2026-01-01' });
    // a refused change stores nothing
    const empty = memory({ settings: FEES });
    await assert.rejects(feeState.changeFeeSchedule(empty, () => { throw new Error('refused'); }, '2027-03-01'), /refused/);
    assert.deepEqual([...empty.map.keys()], ['settings']);
  });

  test('a change of the fees is stored with its log, and the fee settings follow', async () => {
    const store = memory({ settings: { ...FEES, reportStartDate: null } });
    const state = await feeState.changeFeeSchedule(store, (current) => ({
      schedule: fees.withFeeChange(current.schedule, { from: '2028-07', fees: { vollverdiener: 60 }, setAt: 5, ...{ setBy: olga.by, setByName: olga.byName } }),
      log: fees.withFeeLogEntry(current.log, { action: 'set', from: '2028-07', fees: { ...FEES, vollverdiener: 60 }, movedFrom: null, at: 5, ...olga })
    }), '2028-03-15');
    assertHas(state, { stored: true });
    assert.deepEqual(await feeState.readFeeState(store), state, 'what is answered is what is stored');
    assert.deepEqual(state.log, [{ action: 'set', from: '2028-07', fees: { ...FEES, vollverdiener: 60 }, movedFrom: null, at: 5, ...olga }]);
    // still to come in March: the settings read 50 until July comes, whatever was stored last
    assert.equal(store.map.get('settings').vollverdiener, 50);
    assert.deepEqual(['2028-06-30', '2028-07-01'].map((day) => feeState.settingsOn(state, day).vollverdiener), [50, 60]);
    assert.equal(feeState.settingsOn(state, '2028-07-01').reportStartDate, null);
  });

  test('an app without the history saves the fee settings: other fees count from this month on', async () => {
    const store = memory({ settings: { ...FEES, reportStartDate: null } });
    const saved = [];
    const save = async (value, day, at = 1) => {
      const state = await feeState.saveFeeSettings(store, value, olga, day, at);
      saved.push(state.feesChangedFrom);
      return state.schedule;
    };
    // saved with the fees as they are: no fee changes, the rest is stored
    assert.deepEqual(await save({ ...FEES, reportStartDate: '2026-01-01' }, '2028-03-15'), flat());
    assert.deepEqual(store.map.get('settings'), { ...FEES, reportStartDate: '2026-01-01' });
    // the full fee raised in March 2028: from March on - not for the 38 months before, as it was
    const raised = await save({ ...FEES, vollverdiener: 60 }, '2028-03-15', 7);
    assert.deepEqual(raised, { base: FEES, changes: [{ from: '2028-03', fees: { ...FEES, vollverdiener: 60 }, setAt: 7, setBy: 'u1', setByName: 'Olga Owner' }] });
    assert.deepEqual((await feeState.readFeeState(store)).log, [{ action: 'set', from: '2028-03', fees: { ...FEES, vollverdiener: 60 }, movedFrom: null, at: 7, ...olga }]);
    // the next field right after (the older screens save every field on its own): still one change of March
    const both = await save({ ...FEES, vollverdiener: 60, geringverdiener: 30 }, '2028-03-15');
    assert.deepEqual(both.changes.map((change) => [change.from, change.fees]), [['2028-03', { ...FEES, vollverdiener: 60, geringverdiener: 30 }]]);
    // a month later another amount: the next change, March stays
    const april = await save({ ...FEES, vollverdiener: 65, geringverdiener: 30 }, '2028-04-02');
    assert.deepEqual(april.changes.map((change) => [change.from, change.fees.vollverdiener]), [['2028-03', 60], ['2028-04', 65]]);
    // set back within the month: that change is gone again
    assert.deepEqual((await save({ ...FEES, vollverdiener: 60, geringverdiener: 30 }, '2028-04-20')).changes.map((change) => change.from), ['2028-03']);
    // what is no amount keeps what the fee is, and the settings never lose their fees
    assert.deepEqual(await save({ vollverdiener: '70', geringverdiener: -5, keinverdiener: null, reportStartDate: null }, '2028-04-20'), both);
    assert.deepEqual(store.map.get('settings'), { ...FEES, vollverdiener: 60, geringverdiener: 30, reportStartDate: null });
    for (const nothing of [null, undefined, 'x', []]) assert.deepEqual(await save(nothing, '2028-04-20'), both);
    // a change still to come is not touched by a fee saved for now
    await feeState.changeFeeSchedule(store, (current) => ({ schedule: fees.withFeeChange(current.schedule, { from: '2029-01', fees: { vollverdiener: 70 } }), log: current.log }), '2028-04-20');
    const now = await save({ ...FEES, vollverdiener: 62, geringverdiener: 30 }, '2028-05-05');
    assert.deepEqual(now.changes.map((change) => [change.from, change.fees.vollverdiener]), [['2028-03', 60], ['2028-05', 62], ['2029-01', 70]]);
    // the answer says from which month a fee was changed, for the server's log: only where one was
    assert.deepEqual(saved, [null, '2028-03', '2028-03', '2028-04', '2028-04', null, null, null, null, null, '2028-05']);
  });
});

describe('web app bookings (assets/finance.js)', () => {
  const path = require('path');
  const { pathToFileURL } = require('url');
  const { preprocessPersonServerSide } = require('../backend/derivedData');
  const { freezeTime } = require('./helpers');
  const load = () => import(pathToFileURL(path.join(__dirname, '..', 'assets', 'finance.js')).href);

  const FEES = { vollverdiener: 50, geringverdiener: 25, keinverdiener: 10, pausiert: 0 };
  // A member as the server creates one (newPersonRecord, new account): the first status entry has no end
  const member = () => ({
    id: 'p1', uid: 'u1', name: 'Paula', status: 'vollverdiener', memberSince: '2025-01-01', originalMemberSince: '2025-01-01',
    totalPaid: 0, payments: [], standingOrders: [], statusHistory: [{ status: 'vollverdiener', startDate: '2025-01-01' }]
  });
  // What the server's fee calculation charges up to and including October 2026
  const owed = (t, person) => {
    const restore = freezeTime(t, '2026-10-16T12:00:00Z');
    try { return -preprocessPersonServerSide(structuredClone(person), FEES)._currentBalance; } finally { restore(); }
  };

  test('an approved status change request changes the fee from its date on', async (t) => {
    const { applyApprovedRequest } = await load();
    const approved = applyApprovedRequest(member(), { id: 'r1', type: 'status', data: { newStatus: 'geringverdiener', date: '2026-01-01' } });
    assert.equal(approved.status, 'geringverdiener');
    // 2025 as a full earner, January to October 2026 at the lower fee
    assert.equal(owed(t, approved), 12 * 50 + 10 * 25);
  });

  test('approving a status request charges the same as the treasury changing the status itself', async (t) => {
    const { applyApprovedRequest, applyStatusChangeToHistory } = await load();
    // the treasury pauses Paula from July 2025, from March 2026 she asks for the lower fee
    const paused = applyStatusChangeToHistory(member(), 'pausiert', '2025-07-01');
    const byRequest = applyApprovedRequest(paused, { id: 'r2', type: 'status', data: { newStatus: 'geringverdiener', date: '2026-03-01' } });
    assert.equal(owed(t, byRequest), 6 * 50 + 8 * 0 + 8 * 25);
    assert.equal(owed(t, byRequest), owed(t, applyStatusChangeToHistory(paused, 'geringverdiener', '2026-03-01')));
  });

  test('amounts are read as they were typed; an ambiguous one is refused instead of guessed', async () => {
    const { parseAmount } = await load();
    for (const [typed, amount] of [['50', 50], ['12,5', 12.5], ['1234,56', 1234.56], ['1234.56', 1234.56], ['1.234,56', 1234.56],
      ['1,234.56', 1234.56], ['1 234,56', 1234.56], ['50 €', 50], ['50 EUR', 50], ['50,-', 50], ['50.-', 50], ['50.', 50], [',50', 0.5],
      ['1.500,00', 1500], ['1.500,-', 1500], ['1.500.000', 1500000], ['-20', -20]]) {
      assert.equal(parseAmount(typed), amount, typed);
    }
    // "1.500" means 1500 € in German and 1.5 in English: it used to be booked as 1,50 €
    for (const typed of ['1.500', '1,500', '2.000', '1.234.56', '1 234.567', '1e3', 'abc', '', ',', '-']) assert.ok(Number.isNaN(parseAmount(typed)), typed);
  });

  test('editing or deleting hits the payment that was opened, also when the list changed meanwhile', async () => {
    const { findPaymentIndex } = await load();
    // The treasurer opened the March payment (second in the list) ...
    const opened = { paymentId: 'mar', targetIndex: 1, original: { id: 'mar', amount: 50, date: '2026-03-05' } };
    // ... and before saving, a backdated February payment was booked for the same member
    const now = [{ id: 'jan', amount: 50, date: '2026-01-05' }, { id: 'feb', amount: 40, date: '2026-02-10' }, { id: 'mar', amount: 50, date: '2026-03-05' }];
    assert.equal(findPaymentIndex(now, opened), 2, 'not the February payment that is second now');
    assert.equal(findPaymentIndex(now.filter((p) => p.id !== 'mar'), opened), -1, 'deleted meanwhile: no other payment is touched');
    // Old payments without an id: by position, only while it is still the payment that was opened
    const legacy = [{ amount: 50, date: '2026-01-05' }, { amount: 50, date: '2026-03-05' }];
    const openedLegacy = { paymentId: 'pay_p1_1', targetIndex: 1, original: legacy[1] };
    assert.equal(findPaymentIndex(legacy, openedLegacy), 1);
    assert.equal(findPaymentIndex([legacy[0], { amount: 40, date: '2026-02-10' }, legacy[1]], openedLegacy), -1);
    // ... also when the stored amount is old text like "50,00"
    const text = [{ amount: '50,00', date: '2026-01-05' }];
    assert.equal(findPaymentIndex(text, { paymentId: 'pay_p1_0', targetIndex: 0, original: text[0] }), 0);
  });

  test('approving the same request again books nothing twice', async () => {
    const { applyApprovedRequest, addApprovedExpense } = await load();
    const payment = { id: '1760001', type: 'payment', personName: 'Paula', data: { amount: '120', date: '2026-10-01', note: 'Q4' } };
    const once = applyApprovedRequest(member(), payment, 'Payment (approved)');
    // a second treasurer, a second device or a retry approves it again: the record already holds the booking
    const twice = applyApprovedRequest(once, payment, 'Payment (approved)');
    assert.deepEqual(twice.payments.map((p) => p.amount), [120]);
    assert.equal(twice.totalPaid, 120);
    assert.equal(applyApprovedRequest(twice, { ...payment, id: '1760002' }, 'x').payments.length, 2, 'another request is another booking');

    const order = { id: '1760003', type: 'standing_order', data: { amount: '50', date: '2026-11-01' } };
    assert.equal(applyApprovedRequest(applyApprovedRequest(member(), order), order).standingOrders.length, 1);

    const expense = { id: '1760004', type: 'expense', personName: 'Paula', data: { amount: '80', description: 'Kerzen', date: '2026-10-02' } };
    const expenses = addApprovedExpense([{ id: 1, amount: 5 }], expense);
    assert.deepEqual(expenses.map((e) => [e.amount, e.issuer]), [[5, undefined], [80, 'Paula']]);
    assert.equal(addApprovedExpense(expenses, expense), null, 'already booked: nothing to save');
  });

  test('an approval that loses against a rejection at the same moment is taken back completely', async () => {
    const { applyApprovedRequest, withoutApprovedRequest, addApprovedExpense, withoutApprovedExpense, applyStatusChangeToHistory } = await load();
    const paula = { ...member(), payments: [{ id: 'own', amount: 50, date: '2026-01-05' }], standingOrders: [{ id: 'so', amount: 25, startDate: '2026-02-01' }] };
    for (const request of [
      { id: 'r1', type: 'payment', data: { amount: '120', date: '2026-10-01' } },
      { id: 'r2', type: 'standing_order', data: { amount: '50', date: '2026-11-01' } }
    ]) {
      const undone = withoutApprovedRequest(applyApprovedRequest(paula, request, 'x'), request);
      assert.deepEqual([undone.payments, undone.standingOrders], [paula.payments, paula.standingOrders], request.type);
    }
    // a status change goes back to the status and history from before the approval
    const paused = applyStatusChangeToHistory(member(), 'pausiert', '2025-07-01');
    const before = { status: paused.status, statusHistory: paused.statusHistory };
    const status = { id: 'r3', type: 'status', data: { newStatus: 'geringverdiener', date: '2026-03-01' } };
    assert.deepEqual(withoutApprovedRequest(applyApprovedRequest(paused, status), status, before), paused);
    const expense = { id: 'r4', type: 'expense', personName: 'Paula', data: { amount: '80', description: 'Kerzen', date: '2026-10-02' } };
    assert.deepEqual(withoutApprovedExpense(addApprovedExpense([{ id: 1, amount: 5 }], expense), expense), [{ id: 1, amount: 5 }]);
    assert.equal(withoutApprovedExpense([{ id: 1, amount: 5 }], expense), null, 'nothing booked: nothing to save');
  });

  test('records from before the version field are protected from their first write on', () => {
    const { isOutdatedVersion } = require('../backend/pocketbase');
    assert.equal(isOutdatedVersion('', ''), false, 'old record, nobody wrote it since it was read');
    assert.equal(isOutdatedVersion('2026-10-16 12:00:00.000Z', ''), true, 'old record that someone else wrote in the meantime');
    assert.equal(isOutdatedVersion('2026-10-16 12:00:00.000Z', '2026-10-16 12:00:00.000Z'), false);
    assert.equal(isOutdatedVersion('2026-10-16 12:00:01.000Z', '2026-10-16 12:00:00.000Z'), true);
    assert.equal(isOutdatedVersion('2026-10-16 12:00:00.000Z', null), false, 'writes without a version are not checked');
  });
});
