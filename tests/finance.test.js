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

  test('marks member behind when past arrears exist even if current-month standing order already paid', () => {
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

  test('applies grace period for unexecuted current-month standing order to keep member current', () => {
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

  test('overpayment uses only current balance and excludes anticipated standing order amount', () => {
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

  test('returns Alles in Ordnung for up-to-date member without standing order', () => {
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

  test('returns Dauerauftrag läuft for up-to-date member with active standing order', () => {
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
