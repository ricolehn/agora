const test = require('node:test');
const assert = require('node:assert/strict');
const { preprocessPersonServerSide } = require('./derivedData');

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
