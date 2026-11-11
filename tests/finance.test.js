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
  const { freezeTime, assertHas } = require('./helpers');
  const webApp = () => import(pathToFileURL(path.join(__dirname, '..', 'assets', 'finance.js')).href);

  const FEES = { vollverdiener: 50, geringverdiener: 25, keinverdiener: 10, pausiert: 0 };
  // The fresh start of the examples: 1 January 2027, the time before keeps the fees it had
  const DAY = '2027-01-01';
  const FRESH = [{ date: DAY, feesBefore: FEES }];
  // A member since January 2025 (the 24 months up to the fresh start cost 1200) with payments as [amount, day].
  // Joined in the middle of the month: a "member since" on the 1st is read as the month before west of Greenwich
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
  const on = (t, day, person, resets = FRESH, fees = FEES) => {
    const restore = freezeTime(t, noon(day));
    try { return preprocessPersonServerSide(structuredClone(person), fees, resets); } finally { restore(); }
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
