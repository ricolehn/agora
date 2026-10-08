const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

describe('standingOrders', () => {
  const { checkAndExecuteStandingOrders } = require('../backend/standingOrders');

  test('standing order scheduled on Saturday delays execution to Monday when no endDate blocks it', () => {
      // Saturday date: 2026-03-07
      const person = {
          id: 'p1',
          payments: [],
          standingOrders: [
              {
                  id: 'so1',
                  amount: 50,
                  startDate: '2026-03-07', // Saturday
                  note: 'Test Saturday SO'
              }
          ]
      };

      const OriginalDate = global.Date;
      class MockDateSaturday extends OriginalDate {
          constructor(...args) {
              if (args.length === 0) {
                  super('2026-03-07T12:00:00Z');
              } else {
                  super(...args);
              }
          }
      }
      global.Date = MockDateSaturday;

      try {
          const resultSat = checkAndExecuteStandingOrders(person);
          assert.equal(resultSat, null, 'Standing order should not execute on Saturday');
      } finally {
          global.Date = OriginalDate;
      }

      class MockDateMonday extends OriginalDate {
          constructor(...args) {
              if (args.length === 0) {
                  super('2026-03-09T12:00:00Z');
              } else {
                  super(...args);
              }
          }
      }
      global.Date = MockDateMonday;

      try {
          const resultMon = checkAndExecuteStandingOrders(person);
          assert.notEqual(resultMon, null, 'Standing order should execute on Monday');
          assert.equal(resultMon.payments.length, 1);
          assert.equal(resultMon.payments[0].date, '2026-03-09');
          assert.equal(resultMon.payments[0].id, 'auto_so1_2026-03-07');
      } finally {
          global.Date = OriginalDate;
      }
  });

  test('standing order scheduled on Saturday with endDate on Saturday executes on Monday (not on Saturday)', () => {
      // Saturday date: 2026-03-07, endDate: 2026-03-07
      const person = {
          id: 'p2',
          payments: [],
          standingOrders: [
              {
                  id: 'so2',
                  amount: 100,
                  startDate: '2026-03-07', // Saturday
                  endDate: '2026-03-07',   // Saturday
                  note: 'Final Saturday SO'
              }
          ]
      };

      const OriginalDate = global.Date;
      class MockDateSaturday extends OriginalDate {
          constructor(...args) {
              if (args.length === 0) {
                  super('2026-03-07T12:00:00Z');
              } else {
                  super(...args);
              }
          }
      }
      global.Date = MockDateSaturday;

      try {
          const resultSat = checkAndExecuteStandingOrders(person);
          assert.equal(resultSat, null, 'Standing order should not execute on Saturday');
      } finally {
          global.Date = OriginalDate;
      }

      class MockDateMonday extends OriginalDate {
          constructor(...args) {
              if (args.length === 0) {
                  super('2026-03-09T12:00:00Z');
              } else {
                  super(...args);
              }
          }
      }
      global.Date = MockDateMonday;

      try {
          const resultMon = checkAndExecuteStandingOrders(person);
          assert.notEqual(resultMon, null, 'Standing order scheduled on Saturday should execute on Monday');
          assert.equal(resultMon.payments.length, 1);
          assert.equal(resultMon.payments[0].date, '2026-03-09');
          assert.equal(resultMon.payments[0].id, 'auto_so2_2026-03-07');
      } finally {
          global.Date = OriginalDate;
      }
  });

  test('standing order scheduled on Sunday with endDate on Sunday executes on Monday (not on Sunday)', () => {
      // Sunday date: 2026-03-08, endDate: 2026-03-08
      const person = {
          id: 'p3',
          payments: [],
          standingOrders: [
              {
                  id: 'so3',
                  amount: 75,
                  startDate: '2026-03-08', // Sunday
                  endDate: '2026-03-08',   // Sunday
                  note: 'Final Sunday SO'
              }
          ]
      };

      const OriginalDate = global.Date;
      class MockDateSunday extends OriginalDate {
          constructor(...args) {
              if (args.length === 0) {
                  super('2026-03-08T12:00:00Z'); // Correct Sunday 2026-03-08 timestamp
              } else {
                  super(...args);
              }
          }
      }
      global.Date = MockDateSunday;

      try {
          const resultSun = checkAndExecuteStandingOrders(person);
          assert.equal(resultSun, null, 'Standing order should not execute on Sunday');
      } finally {
          global.Date = OriginalDate;
      }

      class MockDateMonday extends OriginalDate {
          constructor(...args) {
              if (args.length === 0) {
                  super('2026-03-09T12:00:00Z');
              } else {
                  super(...args);
              }
          }
      }
      global.Date = MockDateMonday;

      try {
          const resultMon = checkAndExecuteStandingOrders(person);
          assert.notEqual(resultMon, null, 'Standing order scheduled on Sunday should execute on Monday');
          assert.equal(resultMon.payments.length, 1);
          assert.equal(resultMon.payments[0].date, '2026-03-09');
          assert.equal(resultMon.payments[0].id, 'auto_so3_2026-03-08');
      } finally {
          global.Date = OriginalDate;
      }
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
