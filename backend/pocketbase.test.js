const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDataPath,
  decodeTokenPayload,
  toPublicUser,
  sanitizeSelfUserWrite,
  buildPocketBaseError,
  generatePocketBaseCredentials,
  normalizeRecordListInput,
  stripNormalizedPersonData,
  buildPersonRecordPayload,
  buildPaymentRecordPayload,
  buildStatusHistoryRecordPayload,
  buildExpenseRecordPayload,
  hydratePersonRecord,
  clearSuperuserTokenCache
} = require('./pocketbase');

test('normalizeDataPath trims duplicate separators', () => {
  assert.equal(normalizeDataPath('/people//123/'), 'people/123');
  assert.equal(normalizeDataPath(''), '');
});

test('decodeTokenPayload decodes base64url JWT payloads', () => {
  const payload = { id: 'abc123', type: 'auth' };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const decoded = decodeTokenPayload(`x.${encoded}.y`);
  assert.deepEqual(decoded, payload);
});

test('sanitizeSelfUserWrite strips admin flags but keeps editable profile fields', () => {
  const sanitized = sanitizeSelfUserWrite({
    firstName: 'Ada',
    lastName: 'Lovelace',
    emailNotifications: false,
    admin: true,
    superAdmin: true
  });

  assert.deepEqual(sanitized, {
    firstName: 'Ada',
    lastName: 'Lovelace',
    emailNotifications: false,
    name: 'Ada Lovelace'
  });
});

test('toPublicUser falls back to first and last name when the auth record has no name', () => {
  const user = toPublicUser({
    id: 'user-1',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace'
  });

  assert.deepEqual(user, {
    uid: 'user-1',
    id: 'user-1',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    name: 'Ada Lovelace',
    admin: false,
    superAdmin: false,
    emailNotifications: true
  });
});

test('buildPocketBaseError prefers detailed field validation messages', () => {
  const error = buildPocketBaseError({
    status: 400,
    message: 'Failed to create record.',
    data: {
      firstName: { message: 'Vorname ist erforderlich.' }
    }
  }, 'Fallback');

  assert.equal(error.message, 'Vorname ist erforderlich.');
  assert.equal(error.status, 400);
});

test('generatePocketBaseCredentials returns docker-local defaults', () => {
  const credentials = generatePocketBaseCredentials();
  assert.equal(credentials.url, 'http://127.0.0.1:8090');
  assert.match(credentials.adminEmail, /^nova-.*@local\.invalid$/);
  assert.ok(credentials.adminPassword.length >= 20);
});

test('normalizeRecordListInput accepts arrays and object maps', () => {
  assert.deepEqual(normalizeRecordListInput([{ id: 'a' }]), [{ id: 'a' }]);
  assert.deepEqual(normalizeRecordListInput({ first: { id: 'a' }, second: { id: 'b' } }), [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(normalizeRecordListInput(null), []);
});

test('stripNormalizedPersonData removes nested payment and status history arrays', () => {
  const person = {
    id: 'person-1',
    name: 'Ada',
    status: 'active',
    payments: [{ amount: '10.50' }, { amount: '4.50' }],
    statusHistory: [{ status: 'active', startDate: '2024-01-01' }]
  };

  assert.deepEqual(stripNormalizedPersonData(person), {
    id: 'person-1',
    name: 'Ada',
    status: 'active',
    totalPaid: 15
  });
});

test('build normalized PocketBase payloads expose relational scalar columns', () => {
  const personPayload = buildPersonRecordPayload('person-1', {
    uid: 'user-1',
    name: 'Ada',
    status: 'active',
    memberSince: '2024-01-01',
    originalMemberSince: '2024-01-01',
    payments: [{ id: 'pay-1', amount: '10.50', date: '2024-02-01', description: 'Fee' }]
  });
  const paymentPayload = buildPaymentRecordPayload('person-1', { id: 'pay-1', amount: '10.50', date: '2024-02-01', description: 'Fee' });
  const statusPayload = buildStatusHistoryRecordPayload('person-1', { status: 'active', startDate: '2024-01-01' });
  const expensePayload = buildExpenseRecordPayload({ id: 'expense-1', amount: '7.25', date: '2024-03-01', issuer: 'Store', description: 'Paper', receipt: 'r.png' });

  assert.equal(personPayload.personKey, 'person-1');
  assert.equal(personPayload.uid, 'user-1');
  assert.equal(personPayload.status, 'active');
  assert.equal(personPayload.totalPaid, 10.5);
  assert.deepEqual(personPayload.data, {
    uid: 'user-1',
    name: 'Ada',
    status: 'active',
    memberSince: '2024-01-01',
    originalMemberSince: '2024-01-01',
    totalPaid: 10.5
  });

  assert.equal(paymentPayload.personKey, 'person-1');
  assert.equal(paymentPayload.amount, 10.5);
  assert.equal(paymentPayload.date, '2024-02-01');
  assert.ok(paymentPayload.paymentKey);

  assert.equal(statusPayload.personKey, 'person-1');
  assert.equal(statusPayload.status, 'active');
  assert.equal(statusPayload.startDate, '2024-01-01');
  assert.ok(statusPayload.historyKey);

  assert.equal(expensePayload.amount, 7.25);
  assert.equal(expensePayload.receipt, 'r.png');
  assert.ok(expensePayload.expenseKey);
});

test('hydratePersonRecord rebuilds normalized child collections into legacy API shape', () => {
  const record = {
    personKey: 'person-1',
    uid: 'user-1',
    name: 'Ada',
    status: 'active',
    memberSince: '2024-01-01',
    originalMemberSince: '2024-01-01',
    data: {
      id: 'person-1',
      standingOrders: [{ id: 'so-1' }]
    }
  };
  const payments = [
    buildPaymentRecordPayload('person-1', { id: 'pay-3', amount: '1.00', date: '2024-02-01', description: 'Adjustment' }),
    buildPaymentRecordPayload('person-1', { id: 'pay-2', amount: '4.50', date: '2024-03-01', description: 'Late fee' }),
    buildPaymentRecordPayload('person-1', { id: 'pay-1', amount: '10.50', date: '2024-02-01', description: 'Fee' })
  ];
  const statusHistory = [
    buildStatusHistoryRecordPayload('person-1', { status: 'paused', startDate: '2024-02-01' }),
    buildStatusHistoryRecordPayload('person-1', { status: 'active', startDate: '2024-01-01' })
  ];

  assert.deepEqual(hydratePersonRecord(record, payments, statusHistory), {
    id: 'person-1',
    uid: 'user-1',
    name: 'Ada',
    status: 'active',
    memberSince: '2024-01-01',
    originalMemberSince: '2024-01-01',
    standingOrders: [{ id: 'so-1' }],
    payments: [
      { id: 'pay-1', amount: '10.50', date: '2024-02-01', description: 'Fee' },
      { id: 'pay-3', amount: '1.00', date: '2024-02-01', description: 'Adjustment' },
      { id: 'pay-2', amount: '4.50', date: '2024-03-01', description: 'Late fee' }
    ],
    statusHistory: [
      { status: 'active', startDate: '2024-01-01' },
      { status: 'paused', startDate: '2024-02-01' }
    ],
    totalPaid: 16
  });
});

test('clearSuperuserTokenCache is a callable function', () => {
  assert.equal(typeof clearSuperuserTokenCache, 'function');
  // Calling it should not throw
  clearSuperuserTokenCache();
});

test('hydratePersonRecord attaches _childPayments/_childStatusHistory-compatible data', () => {
  const record = {
    personKey: 'person-1',
    name: 'Test',
    status: 'active',
    memberSince: '2024-01-01',
    data: { id: 'person-1' }
  };
  const payments = [
    buildPaymentRecordPayload('person-1', { id: 'pay-1', amount: '5.00', date: '2024-01-15', description: 'Fee' })
  ];
  const result = hydratePersonRecord(record, payments, []);

  assert.equal(result.payments.length, 1);
  assert.equal(result.payments[0].id, 'pay-1');
  assert.equal(result.totalPaid, 5);
});

