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
    rawEmail: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    name: 'Ada Lovelace',
    admin: false,
    owner: false,
    superAdmin: false,
    pays: true,
    groups: [],
    emailNotifications: true,
    isClaimed: true
  });
});

test('toPublicUser preserves owner, pays, and groups fields', () => {
  const user = toPublicUser({
    id: 'user-2',
    email: 'owner@example.com',
    firstName: 'Grace',
    lastName: 'Hopper',
    owner: true,
    pays: false,
    groups: ['Admins', 'Board']
  });

  assert.deepEqual(user, {
    uid: 'user-2',
    id: 'user-2',
    email: 'owner@example.com',
    rawEmail: 'owner@example.com',
    firstName: 'Grace',
    lastName: 'Hopper',
    name: 'Grace Hopper',
    admin: true,
    owner: true,
    superAdmin: true,
    pays: false,
    groups: ['Admins', 'Board'],
    emailNotifications: true,
    isClaimed: true
  });
});

test('toPublicUser handles unclaimed placeholder email accounts', () => {
  const user = toPublicUser({
    id: 'user-3',
    email: 'unclaimed_12345_abcdef@agora.local',
    firstName: 'John',
    lastName: 'Doe',
    isClaimed: false
  });

  assert.equal(user.email, '');
  assert.equal(user.rawEmail, 'unclaimed_12345_abcdef@agora.local');
  assert.equal(user.isClaimed, false);
  assert.equal(user.name, 'John Doe');
});

test('isPlaceholderEmail detects generated placeholder emails', () => {
  const { isPlaceholderEmail } = require('./pocketbase');
  assert.equal(isPlaceholderEmail('unclaimed_123_abc@agora.local'), true);
  assert.equal(isPlaceholderEmail('user@agora.local'), true);
  assert.equal(isPlaceholderEmail(''), true);
  assert.equal(isPlaceholderEmail(null), true);
  assert.equal(isPlaceholderEmail('realuser@gmail.com'), false);
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
  assert.match(credentials.adminEmail, /^agora-.*@local\.invalid$/);
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

  const result = hydratePersonRecord(record, payments, statusHistory, {});

  assert.equal(result.id, 'person-1');
  assert.equal(result.uid, 'user-1');
  assert.equal(result.name, 'Ada');
  assert.equal(result.status, 'active');
  assert.equal(result.totalPaid, 16);
  assert.deepEqual(result.standingOrders, [{ id: 'so-1' }]);
  assert.equal(result.payments.length, 3);
  assert.equal(result.statusHistory.length, 2);
  assert.ok('_paidUntil' in result);
  assert.ok('_statusMeta' in result);
  assert.ok('_overdueAmount' in result);
  assert.ok('_currentStatus' in result);
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

test('decodeTokenPayload handles tokens with expiration far in future', () => {
  const futureExp = Math.floor(Date.now() / 1000) + 315360000; // 10 years
  const payload = { id: 'user123', type: 'auth', exp: futureExp };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `eyJhbGciOiJIUzI1NiJ9.${encoded}.signature`;
  const decoded = decodeTokenPayload(token);
  assert.equal(decoded.id, 'user123');
  assert.equal(decoded.exp, futureExp);
  assert.ok(decoded.exp > Math.floor(Date.now() / 1000) + 300000000);
});

test('admin user and group helper functions are exported correctly', () => {
  const {
    adminResetUserPassword,
    deleteUserRecord,
    claimUserAccount,
    isPlaceholderEmail,
    listGroupRecords,
    getGroupRecord,
    createGroupRecord,
    updateGroupRecord,
    deleteGroupRecord,
    resolveUserPermissions
  } = require('./pocketbase');
  assert.equal(typeof adminResetUserPassword, 'function');
  assert.equal(typeof deleteUserRecord, 'function');
  assert.equal(typeof claimUserAccount, 'function');
  assert.equal(typeof isPlaceholderEmail, 'function');
  assert.equal(typeof listGroupRecords, 'function');
  assert.equal(typeof getGroupRecord, 'function');
  assert.equal(typeof createGroupRecord, 'function');
  assert.equal(typeof updateGroupRecord, 'function');
  assert.equal(typeof deleteGroupRecord, 'function');
  assert.equal(typeof resolveUserPermissions, 'function');
});

test('resolveUserPermissions merges permissions and determines finance, AI, and mentoring access', () => {
  const { resolveUserPermissions } = require('./pocketbase');
  const allGroups = [
    { id: 'g1', name: 'Finance Team', permissions: ['view_finances'] },
    { id: 'g2', name: 'Treasury', permissions: ['manage_finances'] },
    { id: 'g3', name: 'Regular', permissions: [] },
    { id: 'g4', name: 'AI Users', permissions: ['access_ai'] },
    { id: 'g5', name: 'Mentoring Participants', permissions: ['mentoring_participate'] },
    { id: 'g6', name: 'Mentoring Leaders', permissions: ['manage_mentoring'] }
  ];

  const resEmpty = resolveUserPermissions([], allGroups);
  assert.deepEqual(resEmpty.permissions, []);
  assert.equal(resEmpty.canManageFinances, false);
  assert.equal(resEmpty.canViewFinances, false);
  assert.equal(resEmpty.canAccessAi, false);
  assert.equal(resEmpty.canParticipateMentoring, true);
  assert.equal(resEmpty.canManageMentoring, false);

  const resView = resolveUserPermissions(['g1'], allGroups);
  assert.deepEqual(resView.permissions, ['view_finances']);
  assert.equal(resView.canManageFinances, false);
  assert.equal(resView.canViewFinances, true);
  assert.equal(resView.canAccessAi, false);

  const resManage = resolveUserPermissions(['g2'], allGroups);
  assert.deepEqual(resManage.permissions, ['manage_finances']);
  assert.equal(resManage.canManageFinances, true);
  assert.equal(resManage.canViewFinances, true);
  assert.equal(resManage.canAccessAi, false);

  const resAi = resolveUserPermissions(['g4'], allGroups);
  assert.deepEqual(resAi.permissions, ['access_ai']);
  assert.equal(resAi.canManageFinances, false);
  assert.equal(resAi.canViewFinances, false);
  assert.equal(resAi.canAccessAi, true);

  const resMentee = resolveUserPermissions(['g5'], allGroups);
  assert.deepEqual(resMentee.permissions, ['mentoring_participate']);
  assert.equal(resMentee.canParticipateMentoring, true);
  assert.equal(resMentee.canManageMentoring, false);

  const resLeader = resolveUserPermissions(['g6'], allGroups);
  assert.deepEqual(resLeader.permissions, ['manage_mentoring']);
  assert.equal(resLeader.canParticipateMentoring, true);
  assert.equal(resLeader.canManageMentoring, true);

  const resCombined = resolveUserPermissions(['g1', 'g4', 'g5'], allGroups);
  assert.ok(resCombined.permissions.includes('view_finances'));
  assert.ok(resCombined.permissions.includes('access_ai'));
  assert.ok(resCombined.permissions.includes('mentoring_participate'));
  assert.equal(resCombined.canViewFinances, true);
  assert.equal(resCombined.canManageFinances, false);
  assert.equal(resCombined.canAccessAi, true);
  assert.equal(resCombined.canParticipateMentoring, true);
  assert.equal(resCombined.canManageMentoring, false);
});

test('SYSTEM_PERMISSIONS provides valid permission definitions', () => {
  const { SYSTEM_PERMISSIONS } = require('./pocketbase');
  assert.ok(Array.isArray(SYSTEM_PERMISSIONS));
  assert.equal(SYSTEM_PERMISSIONS.length, 4);
  const ids = SYSTEM_PERMISSIONS.map(p => p.id);
  assert.deepEqual(ids, ['view_finances', 'manage_finances', 'access_ai', 'manage_mentoring']);
});

test('encryptMentoringText and decryptMentoringText handle roundtrips, legacy plaintext, and empty inputs', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-test-'));
  const originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;

  try {
    const { encryptMentoringText, decryptMentoringText } = require('./pocketbase');

    assert.equal(encryptMentoringText(''), '');
    assert.equal(encryptMentoringText(null), '');
    assert.equal(encryptMentoringText(undefined), '');
    assert.equal(decryptMentoringText(''), '');
    assert.equal(decryptMentoringText(null), '');

    const secretMessage = 'Hallo, ich benötige vertrauliche Seelsorge-Unterstützung.';
    const encrypted = encryptMentoringText(secretMessage);

    assert.ok(encrypted.startsWith('enc:v1:'));
    assert.notEqual(encrypted, secretMessage);
    assert.ok(!encrypted.includes(secretMessage));

    const decrypted = decryptMentoringText(encrypted);
    assert.equal(decrypted, secretMessage);

    // Re-encrypting an already encrypted string should return the encrypted string as-is
    const doubleEncrypted = encryptMentoringText(encrypted);
    assert.equal(doubleEncrypted, encrypted);

    // Legacy plain text (not starting with enc:v1:) is returned untouched
    const legacyText = 'This is an unencrypted legacy message text';
    assert.equal(decryptMentoringText(legacyText), legacyText);
  } finally {
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('encryptMentoringText and decryptMentoringText respect MENTORING_ENCRYPTION_KEY env override', () => {
  const { encryptMentoringText, decryptMentoringText, clearMentoringKeyCache } = require('./pocketbase');
  const originalEnvKey = process.env.MENTORING_ENCRYPTION_KEY;

  try {
    clearMentoringKeyCache();
    process.env.MENTORING_ENCRYPTION_KEY = 'custom-test-secret-key-12345';
    const message = 'Vertrauliche Testnachricht mit Env Key';
    const encrypted = encryptMentoringText(message);

    assert.ok(encrypted.startsWith('enc:v1:'));
    assert.equal(decryptMentoringText(encrypted), message);
  } finally {
    if (originalEnvKey !== undefined) {
      process.env.MENTORING_ENCRYPTION_KEY = originalEnvKey;
    } else {
      delete process.env.MENTORING_ENCRYPTION_KEY;
    }
    clearMentoringKeyCache();
  }
});

test('decryptMentoringText handles legacy hex enc:v1: ciphertexts', () => {
  const crypto = require('crypto');
  const { decryptMentoringText, clearMentoringKeyCache } = require('./pocketbase');
  const originalEnvKey = process.env.MENTORING_ENCRYPTION_KEY;

  try {
    clearMentoringKeyCache();
    process.env.MENTORING_ENCRYPTION_KEY = 'legacy-test-secret-key';
    const key = crypto.createHash('sha256').update('legacy-test-secret-key').digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const text = 'Legacy hex encrypted text payload';
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const hexPayload = `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
    assert.equal(decryptMentoringText(hexPayload), text);
  } finally {
    if (originalEnvKey !== undefined) {
      process.env.MENTORING_ENCRYPTION_KEY = originalEnvKey;
    } else {
      delete process.env.MENTORING_ENCRYPTION_KEY;
    }
    clearMentoringKeyCache();
  }
});

test('encryptMentoringText handles EEXIST when file already exists concurrently', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const crypto = require('crypto');
  const { encryptMentoringText, decryptMentoringText, clearMentoringKeyCache } = require('./pocketbase');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-race-test-'));
  const keyPath = path.join(tmpDir, 'mentoring.key');
  const existingKeyHex = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyPath, existingKeyHex, { encoding: 'utf8' });

  const originalDataDir = process.env.DATA_DIR;
  const originalEnvKey = process.env.MENTORING_ENCRYPTION_KEY;

  delete process.env.MENTORING_ENCRYPTION_KEY;
  process.env.DATA_DIR = tmpDir;

  try {
    clearMentoringKeyCache();
    const message = 'Test concurrent key file read';
    const encrypted = encryptMentoringText(message);
    assert.equal(decryptMentoringText(encrypted), message);
  } finally {
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    if (originalEnvKey !== undefined) {
      process.env.MENTORING_ENCRYPTION_KEY = originalEnvKey;
    } else {
      delete process.env.MENTORING_ENCRYPTION_KEY;
    }
    clearMentoringKeyCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('encryptMentoringText throws fail-fast error when key cannot be initialized or saved', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { encryptMentoringText, clearMentoringKeyCache } = require('./pocketbase');
  const originalDataDir = process.env.DATA_DIR;
  const originalEnvKey = process.env.MENTORING_ENCRYPTION_KEY;

  const fakeNonexistentPath = path.join(os.tmpdir(), 'nonexistent-dir-12345', 'subfolder');
  delete process.env.MENTORING_ENCRYPTION_KEY;
  process.env.DATA_DIR = fakeNonexistentPath;

  // Mock fs.mkdirSync to fail
  const originalMkdirSync = fs.mkdirSync;
  fs.mkdirSync = () => {
    throw new Error('Permission denied');
  };

  try {
    clearMentoringKeyCache();
    assert.throws(() => {
      encryptMentoringText('Should fail');
    }, /Failed to initialize mentoring encryption key/);
  } finally {
    fs.mkdirSync = originalMkdirSync;
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    if (originalEnvKey !== undefined) {
      process.env.MENTORING_ENCRYPTION_KEY = originalEnvKey;
    } else {
      delete process.env.MENTORING_ENCRYPTION_KEY;
    }
    clearMentoringKeyCache();
  }
});

