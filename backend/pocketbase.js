const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolvePocketBaseDirectory } = require('./pathConfig');

const execFileAsync = promisify(execFile);

const DEFAULT_SETTINGS = {
  vollverdiener: 50,
  geringverdiener: 25,
  keinverdiener: 10,
  pausiert: 0,
  reportStartDate: null
};

const DEFAULT_SYSTEM_STATE = {
  inviteCode: '123456',
  superAdminUid: null
};

const MIGRATION_BATCH_SIZE = 10;

const SUPERUSER_TOKEN_TTL_MS = 300_000; // 5 minutes
let cachedSuperuserToken = null;
let cachedSuperuserTokenExpiry = 0;

const DEFAULT_COLLECTION_SPECS = [
  {
    name: 'people',
    type: 'base',
    listRule: '@request.auth.admin = true || uid = @request.auth.id',
    viewRule: '@request.auth.admin = true || uid = @request.auth.id',
    createRule: '@request.auth.admin = true',
    updateRule: '@request.auth.admin = true',
    deleteRule: '@request.auth.admin = true',
    indexes: [
      'CREATE UNIQUE INDEX idx_people_person_key ON people (personKey)',
      'CREATE INDEX idx_people_uid ON people (uid)',
      'CREATE INDEX idx_people_name ON people (name)',
      'CREATE INDEX idx_people_status ON people (status)'
    ],
    fields: [
      { name: 'personKey', type: 'text', required: true },
      { name: 'uid', type: 'text' },
      { name: 'name', type: 'text', required: true },
      { name: 'status', type: 'text' },
      { name: 'memberSince', type: 'text' },
      { name: 'originalMemberSince', type: 'text' },
      { name: 'totalPaid', type: 'number' },
      { name: 'data', type: 'json', required: true }
    ]
  },
  {
    name: 'payments',
    type: 'base',
    listRule: '@request.auth.admin = true',
    viewRule: '@request.auth.admin = true',
    createRule: '@request.auth.admin = true',
    updateRule: '@request.auth.admin = true',
    deleteRule: '@request.auth.admin = true',
    indexes: [
      'CREATE UNIQUE INDEX idx_payments_payment_key ON payments (paymentKey)',
      'CREATE INDEX idx_payments_person_key ON payments (personKey)',
      'CREATE INDEX idx_payments_date ON payments (date)'
    ],
    fields: [
      { name: 'paymentKey', type: 'text', required: true },
      { name: 'personKey', type: 'text', required: true },
      { name: 'amount', type: 'number' },
      { name: 'date', type: 'text' },
      { name: 'description', type: 'text' },
      { name: 'data', type: 'json', required: true }
    ]
  },
  {
    name: 'status_history',
    type: 'base',
    listRule: '@request.auth.admin = true',
    viewRule: '@request.auth.admin = true',
    createRule: '@request.auth.admin = true',
    updateRule: '@request.auth.admin = true',
    deleteRule: '@request.auth.admin = true',
    indexes: [
      'CREATE UNIQUE INDEX idx_status_history_key ON status_history (historyKey)',
      'CREATE INDEX idx_status_history_person_key ON status_history (personKey)',
      'CREATE INDEX idx_status_history_start_date ON status_history (startDate)'
    ],
    fields: [
      { name: 'historyKey', type: 'text', required: true },
      { name: 'personKey', type: 'text', required: true },
      { name: 'status', type: 'text', required: true },
      { name: 'startDate', type: 'text', required: true },
      { name: 'endDate', type: 'text' },
      { name: 'data', type: 'json', required: true }
    ]
  },
  {
    name: 'expenses',
    type: 'base',
    listRule: '@request.auth.admin = true',
    viewRule: '@request.auth.admin = true',
    createRule: '@request.auth.admin = true',
    updateRule: '@request.auth.admin = true',
    deleteRule: '@request.auth.admin = true',
    indexes: [
      'CREATE UNIQUE INDEX idx_expenses_expense_key ON expenses (expenseKey)',
      'CREATE INDEX idx_expenses_date ON expenses (date)'
    ],
    fields: [
      { name: 'expenseKey', type: 'text', required: true },
      { name: 'amount', type: 'number' },
      { name: 'date', type: 'text' },
      { name: 'issuer', type: 'text' },
      { name: 'description', type: 'text' },
      { name: 'receipt', type: 'text' },
      { name: 'data', type: 'json', required: true }
    ]
  },
  {
    name: 'requests',
    type: 'base',
    listRule: '@request.auth.admin = true || userId = @request.auth.id',
    viewRule: '@request.auth.admin = true || userId = @request.auth.id',
    createRule: '@request.auth.admin = true || userId = @request.auth.id',
    updateRule: '@request.auth.admin = true || userId = @request.auth.id',
    deleteRule: '@request.auth.admin = true',
    indexes: [
      'CREATE UNIQUE INDEX idx_requests_request_key ON requests (requestKey)',
      'CREATE INDEX idx_requests_user_id ON requests (userId)',
      'CREATE INDEX idx_requests_status ON requests (status)'
    ],
    fields: [
      { name: 'requestKey', type: 'text', required: true },
      { name: 'userId', type: 'text', required: true },
      { name: 'personId', type: 'text' },
      { name: 'personName', type: 'text' },
      { name: 'type', type: 'text' },
      { name: 'status', type: 'text' },
      { name: 'timestamp', type: 'number' },
      { name: 'data', type: 'json', required: true }
    ]
  },
  {
    name: 'app_state',
    type: 'base',
    listRule: '@request.auth.admin = true',
    viewRule: '@request.auth.admin = true',
    createRule: '@request.auth.admin = true',
    updateRule: '@request.auth.admin = true',
    deleteRule: '@request.auth.superAdmin = true',
    indexes: [
      'CREATE UNIQUE INDEX idx_app_state_key ON app_state (key)'
    ],
    fields: [
      { name: 'key', type: 'text', required: true },
      { name: 'value', type: 'json' }
    ]
  }
];

function getPocketBaseBaseUrl() {
  return process.env.POCKETBASE_BASE_URL || `http://127.0.0.1:${process.env.POCKETBASE_PORT || '8090'}`;
}

function getPocketBaseBinaryPath() {
  return process.env.POCKETBASE_BIN || path.join(__dirname, '..', 'pocketbase');
}

function getPocketBaseDataDir() {
  return resolvePocketBaseDirectory();
}

function generatePocketBaseCredentials() {
  return {
    url: getPocketBaseBaseUrl(),
    // Internal-only superuser used by the bundled backend to provision PocketBase.
    adminEmail: `nova-${crypto.randomUUID()}@local.invalid`,
    adminPassword: crypto.randomBytes(24).toString('base64url')
  };
}

function normalizeDataPath(input = '') {
  return String(input || '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

function decodeTokenPayload(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Missing token');
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    throw new Error('Invalid token');
  }

  const payload = parts[1];
  const padded = payload + '='.repeat((4 - (payload.length % 4 || 4)) % 4);
  try {
    return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid token payload');
  }
}

function toPublicUser(record) {
  if (!record) return null;
  return {
    uid: record.id,
    id: record.id,
    email: record.email || '',
    firstName: record.firstName || '',
    lastName: record.lastName || '',
    name: record.name || `${record.firstName || ''} ${record.lastName || ''}`.trim(),
    admin: record.admin === true,
    superAdmin: record.superAdmin === true,
    emailNotifications: record.emailNotifications !== false
  };
}

function sanitizeSelfUserWrite(input = {}) {
  const output = {};
  if (typeof input.firstName === 'string') output.firstName = input.firstName.trim();
  if (typeof input.lastName === 'string') output.lastName = input.lastName.trim();
  if (typeof input.emailNotifications === 'boolean') output.emailNotifications = input.emailNotifications;
  if (output.firstName || output.lastName) {
    output.name = `${output.firstName || ''} ${output.lastName || ''}`.trim();
  }
  return output;
}

function buildPocketBaseError(response, fallback) {
  const details = response?.data && typeof response.data === 'object'
    ? Object.values(response.data)
        .map((entry) => entry?.message)
        .find((message) => typeof message === 'string' && message.trim())
    : null;
  const error = new Error(details || response?.message || fallback || 'PocketBase request failed');
  error.status = response?.status || 500;
  error.response = response || null;
  return error;
}

async function pocketBaseRequest(path, options = {}) {
  const {
    method = 'GET',
    token,
    body,
    allow404 = false,
    headers = {}
  } = options;

  const requestHeaders = { ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined && !requestHeaders['Content-Type']) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${getPocketBaseBaseUrl()}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  const payload = text ? (() => {
    try {
      return JSON.parse(text);
    } catch {
      return { message: text, status: response.status };
    }
  })() : null;

  if (!response.ok) {
    if (allow404 && response.status === 404) return null;
    throw buildPocketBaseError(payload, `PocketBase ${method} ${path} failed`);
  }

  return payload;
}

async function authenticateSuperuser(appConfig) {
  if (!appConfig?.pocketbase?.adminEmail || !appConfig?.pocketbase?.adminPassword) {
    throw new Error('PocketBase superuser credentials are missing.');
  }

  const now = Date.now();
  if (cachedSuperuserToken && now < cachedSuperuserTokenExpiry) {
    return cachedSuperuserToken;
  }

  const auth = await pocketBaseRequest('/api/collections/_superusers/auth-with-password', {
    method: 'POST',
    body: {
      identity: appConfig.pocketbase.adminEmail,
      password: appConfig.pocketbase.adminPassword
    }
  });

  cachedSuperuserToken = auth.token;
  cachedSuperuserTokenExpiry = now + SUPERUSER_TOKEN_TTL_MS;
  return auth.token;
}

function clearSuperuserTokenCache() {
  cachedSuperuserToken = null;
  cachedSuperuserTokenExpiry = 0;
}

async function ensurePocketBaseSuperuser(appConfig) {
  if (!appConfig?.pocketbase?.adminEmail || !appConfig?.pocketbase?.adminPassword) {
    throw new Error('PocketBase superuser credentials are missing.');
  }

  const binary = getPocketBaseBinaryPath();
  const dir = getPocketBaseDataDir();
  const args = [
    '--dir',
    dir,
    'superuser',
    'upsert',
    appConfig.pocketbase.adminEmail,
    appConfig.pocketbase.adminPassword
  ];

  console.log(`[PocketBase] Running superuser upsert with binary: ${binary}, dir: ${dir}, email: ${appConfig.pocketbase.adminEmail}`);
  try {
    const { stdout, stderr } = await execFileAsync(binary, args);
    console.log(`[PocketBase] Superuser upsert stdout: ${stdout.trim()}`);
    if (stderr.trim()) {
      console.warn(`[PocketBase] Superuser upsert stderr: ${stderr.trim()}`);
    }
  } catch (error) {
    console.error(`[PocketBase] Superuser upsert failed! Error:`, error);
    throw error;
  }
}

async function ensureUsersCollection(appConfig) {
  const token = await authenticateSuperuser(appConfig);
  const existing = await pocketBaseRequest('/api/collections/users', { token });
  
  // Set password min length to 6 for PocketBase 0.23+ where password is in fields
  const fields = (existing.fields || []).map((f) => {
    if (f.name === 'password') {
      return { ...f, min: 6 };
    }
    return f;
  });

  const wantedFields = [
    { name: 'firstName', type: 'text' },
    { name: 'lastName', type: 'text' },
    { name: 'admin', type: 'bool' },
    { name: 'superAdmin', type: 'bool' },
    { name: 'emailNotifications', type: 'bool' }
  ];

  for (const field of wantedFields) {
    if (!fields.some((existingField) => existingField.name === field.name)) {
      fields.push(field);
    }
  }

  await pocketBaseRequest('/api/collections/users', {
    method: 'PATCH',
    token,
    body: {
      ...existing,
      listRule: '@request.auth.admin = true',
      viewRule: 'id = @request.auth.id || @request.auth.admin = true',
      createRule: '',
      updateRule: 'id = @request.auth.id || @request.auth.admin = true',
      deleteRule: '@request.auth.superAdmin = true',
      fields,
      indexes: existing.indexes || [],
      options: {
        ...existing.options,
        minPasswordLength: 6
      }
    }
  });
}

function mergeCollectionSpec(existing, spec) {
  const mergedFields = [...(existing.fields || [])];
  for (const field of spec.fields || []) {
    if (!mergedFields.some((existingField) => existingField.name === field.name)) {
      mergedFields.push(field);
    }
  }

  return {
    ...existing,
    ...spec,
    fields: mergedFields,
    indexes: spec.indexes || existing.indexes || []
  };
}

async function ensureCollection(appConfig, spec) {
  const token = await authenticateSuperuser(appConfig);
  const existing = await pocketBaseRequest(`/api/collections/${spec.name}`, {
    token,
    allow404: true
  });

  if (!existing) {
    await pocketBaseRequest('/api/collections', {
      method: 'POST',
      token,
      body: spec
    });
    return;
  }

  await pocketBaseRequest(`/api/collections/${spec.name}`, {
    method: 'PATCH',
    token,
    body: mergeCollectionSpec(existing, spec)
  });
}

async function listAllRecords(collectionName, filter, appConfig) {
  const token = await authenticateSuperuser(appConfig);
  const items = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
    if (filter) params.set('filter', filter);
    const result = await pocketBaseRequest(`/api/collections/${collectionName}/records?${params.toString()}`, { token });
    items.push(...(result.items || []));
    if (page >= (result.totalPages || 1)) break;
    page += 1;
  }

  return items;
}

function pbFilterEquals(field, value) {
  return `${field} = ${JSON.stringify(String(value))}`;
}

async function getFirstRecord(collectionName, filter, appConfig) {
  const token = await authenticateSuperuser(appConfig);
  const params = new URLSearchParams({ page: '1', perPage: '1', filter });
  const result = await pocketBaseRequest(`/api/collections/${collectionName}/records?${params.toString()}`, { token });
  return result.items?.[0] || null;
}

async function createRecord(collectionName, body, appConfig) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${collectionName}/records`, {
    method: 'POST',
    token,
    body
  });
}

async function updateRecord(collectionName, recordId, body, appConfig) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${collectionName}/records/${recordId}`, {
    method: 'PATCH',
    token,
    body
  });
}

async function deleteRecord(collectionName, recordId, appConfig) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${collectionName}/records/${recordId}`, {
    method: 'DELETE',
    token
  });
}

async function upsertStateValue(appConfig, key, value) {
  const existing = await getFirstRecord('app_state', pbFilterEquals('key', key), appConfig);
  if (existing) {
    return updateRecord('app_state', existing.id, { key, value }, appConfig);
  }
  return createRecord('app_state', { key, value }, appConfig);
}

async function getStateRecord(appConfig, key) {
  return getFirstRecord('app_state', pbFilterEquals('key', key), appConfig);
}

async function getStateValue(appConfig, key, fallback = null) {
  const record = await getStateRecord(appConfig, key);
  return record ? record.value : fallback;
}

async function ensureStateDefaults(appConfig) {
  const defaults = new Map([
    ['settings', DEFAULT_SETTINGS],
    ['donations', {}],
    ['expenses', {}],
    ['system', DEFAULT_SYSTEM_STATE]
  ]);

  for (const [key, value] of defaults.entries()) {
    const existing = await getStateRecord(appConfig, key);
    if (!existing) {
      await createRecord('app_state', { key, value }, appConfig);
    }
  }
}

function normalizeRecordListInput(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'object') return Object.values(value).filter(Boolean);
  return [];
}

function toOptionalText(value) {
  if (value === undefined || value === null || value === '') return '';
  return String(value);
}

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ⚡ Bolt: Replaced Array.reduce with a for loop to eliminate callback execution overhead and reduce CPU time
function calculateTotalPaid(payments) {
  const list = normalizeRecordListInput(payments);
  let sum = 0;
  for (let i = 0; i < list.length; i++) {
    const amount = Number(String(list[i]?.amount || 0).replace(',', '.'));
    if (Number.isFinite(amount)) sum += amount;
  }
  return sum;
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildStableChildKey(prefix, ownerKey, itemKey, index, value) {
  const stableSource = itemKey !== undefined && itemKey !== null && itemKey !== ''
    ? String(itemKey)
    : stableSerialize([ownerKey, index, value]);
  return crypto.createHash('sha256').update(`${prefix}:${ownerKey}:${stableSource}`).digest('hex').slice(0, 32);
}

async function runInBatches(items, batchSize, worker) {
  for (let index = 0; index < items.length; index += batchSize) {
    await Promise.all(items.slice(index, index + batchSize).map((item) => worker(item)));
  }
}

function stripNormalizedPersonData(value) {
  if (!value || typeof value !== 'object') return null;
  const data = { ...value };
  delete data.payments;
  delete data.statusHistory;
  data.totalPaid = calculateTotalPaid(value.payments);
  return data;
}

const { preprocessPersonServerSide } = require('./derivedData');

function buildPaymentRecordPayload(personKey, payment, index = 0) {
  const normalized = payment && typeof payment === 'object' ? { ...payment } : {};
  return {
    paymentKey: buildStableChildKey('payment', personKey, normalized.id, index, normalized),
    personKey: String(personKey),
    amount: toFiniteNumber(normalized.amount),
    date: toOptionalText(normalized.date),
    description: toOptionalText(normalized.description),
    data: normalized
  };
}

function buildStatusHistoryRecordPayload(personKey, entry, index = 0) {
  const normalized = entry && typeof entry === 'object' ? { ...entry } : {};
  return {
    historyKey: buildStableChildKey('status', personKey, normalized.id, index, normalized),
    personKey: String(personKey),
    status: toOptionalText(normalized.status),
    startDate: toOptionalText(normalized.startDate),
    endDate: toOptionalText(normalized.endDate),
    data: normalized
  };
}

function buildExpenseRecordPayload(expense, index = 0) {
  const normalized = expense && typeof expense === 'object' ? { ...expense } : {};
  return {
    expenseKey: buildStableChildKey('expense', 'global', normalized.id, index, normalized),
    amount: toFiniteNumber(normalized.amount),
    date: toOptionalText(normalized.date),
    issuer: toOptionalText(normalized.issuer),
    description: toOptionalText(normalized.description),
    receipt: toOptionalText(normalized.receipt),
    data: normalized
  };
}

function groupRecordsBy(records, keyField) {
  const acc = {};
  for (let i = 0, len = records.length; i < len; i++) {
    const record = records[i];
    const key = record?.[keyField];
    if (key) {
      if (!acc[key]) acc[key] = [];
      acc[key].push(record);
    }
  }
  return acc;
}

function mergeChildData(ownerKey, existingRecords, legacyItems, payloadBuilder, keyField) {
  const merged = new Map();

  for (const record of existingRecords) {
    const key = record?.[keyField];
    if (key && record?.data) {
      merged.set(key, record.data);
    }
  }

  normalizeRecordListInput(legacyItems).forEach((item, index) => {
    const payload = payloadBuilder(ownerKey, item, index);
    if (!merged.has(payload[keyField])) {
      merged.set(payload[keyField], item);
    }
  });

  return [...merged.values()];
}

function mergeExpenseData(existingRecords, legacyItems) {
  const merged = new Map();

  for (const record of existingRecords) {
    if (record?.expenseKey && record?.data) {
      merged.set(record.expenseKey, record.data);
    }
  }

  normalizeRecordListInput(legacyItems).forEach((expense, index) => {
    const payload = buildExpenseRecordPayload(expense, index);
    if (!merged.has(payload.expenseKey)) {
      merged.set(payload.expenseKey, expense);
    }
  });

  return [...merged.values()];
}

function getChildRecordIdentity(record) {
  return toOptionalText(
    record?.data?.id
    || record?.paymentKey
    || record?.historyKey
    || record?.expenseKey
    || stableSerialize(record?.data || record || {})
  );
}

function toSortedChildValues(records, sortField) {
  return [...records]
    .sort((left, right) => {
      const leftValue = toOptionalText(left?.[sortField]);
      const rightValue = toOptionalText(right?.[sortField]);
      if (leftValue === rightValue) {
        return getChildRecordIdentity(left).localeCompare(getChildRecordIdentity(right));
      }
      return leftValue.localeCompare(rightValue);
    })
    .map((record) => record.data)
    .filter(Boolean);
}

function hydratePersonRecord(record, payments = [], statusHistory = [], appSettings = {}) {
  if (!record) return null;
  const data = record.data && typeof record.data === 'object' ? { ...record.data } : {};
  const normalizedPayments = toSortedChildValues(payments, 'date');
  const normalizedStatusHistory = toSortedChildValues(statusHistory, 'startDate');
  data.id = data.id || record.personKey;
  data.uid = data.uid || record.uid || '';
  data.name = data.name || record.name || '';
  data.status = data.status || record.status || '';
  data.memberSince = data.memberSince || record.memberSince || '';
  data.originalMemberSince = data.originalMemberSince || record.originalMemberSince || data.memberSince || '';
  data.payments = normalizedPayments;
  data.statusHistory = normalizedStatusHistory;
  data.standingOrders = Array.isArray(data.standingOrders) ? data.standingOrders : [];
  data.totalPaid = calculateTotalPaid(normalizedPayments);
  return preprocessPersonServerSide(data, appSettings);
}

async function syncCollectionRecords(collectionName, keyField, existingRecords, nextPayloads, appConfig) {
  const existingByKey = new Map(existingRecords.map((record) => [record[keyField], record]));
  const nextKeys = new Set();

  const upsertOps = [];
  for (const payload of nextPayloads) {
    const key = payload[keyField];
    nextKeys.add(key);
    const existing = existingByKey.get(key);
    if (existing) {
      upsertOps.push(updateRecord(collectionName, existing.id, payload, appConfig));
    } else {
      upsertOps.push(createRecord(collectionName, payload, appConfig));
    }
  }

  const deleteOps = [];
  for (const record of existingRecords) {
    if (!nextKeys.has(record[keyField])) {
      deleteOps.push(deleteRecord(collectionName, record.id, appConfig));
    }
  }

  await Promise.all(upsertOps);
  await Promise.all(deleteOps);
}

async function listChildRecordsForPeople(collectionName, personKeys, appConfig) {
  if (!personKeys.length) return [];
  if (personKeys.length === 1) {
    return listAllRecords(collectionName, pbFilterEquals('personKey', personKeys[0]), appConfig);
  }
  const allowedKeys = new Set(personKeys.map(String));
  const records = await listAllRecords(collectionName, '', appConfig);
  return records.filter((record) => allowedKeys.has(String(record.personKey)));
}

async function syncPeopleChildRecords(appConfig, personKey, value, existingChildren) {
  const normalizedPayments = normalizeRecordListInput(value?.payments);
  const normalizedStatusHistory = normalizeRecordListInput(value?.statusHistory);
  let existingPayments;
  let existingStatusHistory;
  if (existingChildren) {
    existingPayments = existingChildren.payments;
    existingStatusHistory = existingChildren.statusHistory;
  } else {
    [existingPayments, existingStatusHistory] = await Promise.all([
      listAllRecords('payments', pbFilterEquals('personKey', personKey), appConfig),
      listAllRecords('status_history', pbFilterEquals('personKey', personKey), appConfig)
    ]);
  }

  await Promise.all([
    syncCollectionRecords(
      'payments',
      'paymentKey',
      existingPayments,
      normalizedPayments.map((payment, index) => buildPaymentRecordPayload(personKey, payment, index)),
      appConfig
    ),
    syncCollectionRecords(
      'status_history',
      'historyKey',
      existingStatusHistory,
      normalizedStatusHistory.map((entry, index) => buildStatusHistoryRecordPayload(personKey, entry, index)),
      appConfig
    )
  ]);
}

async function migrateLegacyPeopleData(appConfig) {
  const records = await listAllRecords('people', '', appConfig);
  const [allPayments, allStatusHistory] = await Promise.all([
    listAllRecords('payments', '', appConfig),
    listAllRecords('status_history', '', appConfig)
  ]);
  const paymentsByPersonKey = groupRecordsBy(allPayments, 'personKey');
  const historyByPersonKey = groupRecordsBy(allStatusHistory, 'personKey');
  await runInBatches(records, MIGRATION_BATCH_SIZE, async (record) => {
    const value = record?.data && typeof record.data === 'object' ? record.data : {};
    const existingPayments = paymentsByPersonKey[record.personKey] || [];
    const existingStatusHistory = historyByPersonKey[record.personKey] || [];
    const mergedPayments = mergeChildData(
      record.personKey,
      existingPayments,
      value.payments,
      buildPaymentRecordPayload,
      'paymentKey'
    );
    const mergedStatusHistory = mergeChildData(
      record.personKey,
      existingStatusHistory,
      value.statusHistory,
      buildStatusHistoryRecordPayload,
      'historyKey'
    );
    const nextValue = {
      ...value,
      payments: mergedPayments,
      statusHistory: mergedStatusHistory
    };
    const hasLegacyArrays = (Array.isArray(value.payments) && value.payments.length > 0)
      || (Array.isArray(value.statusHistory) && value.statusHistory.length > 0);
    const totalPaid = calculateTotalPaid(nextValue.payments);
    const recordTotalPaid = toFiniteNumber(record.totalPaid);
    const needsScalarRefresh = record.status !== toOptionalText(nextValue.status)
      || record.memberSince !== toOptionalText(nextValue.memberSince)
      || record.originalMemberSince !== toOptionalText(nextValue.originalMemberSince || nextValue.memberSince)
      || recordTotalPaid !== totalPaid;

    if (hasLegacyArrays || needsScalarRefresh) {
      await upsertPeopleRecord(appConfig, record.personKey, nextValue);
    }
  });
}

async function migrateLegacyExpensesData(appConfig) {
  const stateRecord = await getStateRecord(appConfig, 'expenses');
  const legacyExpenses = normalizeRecordListInput(stateRecord?.value);
  if (!legacyExpenses.length) return;

  const existingExpenses = await listAllRecords('expenses', '', appConfig);
  const mergedExpenses = mergeExpenseData(existingExpenses, legacyExpenses);
  await syncCollectionRecords(
    'expenses',
    'expenseKey',
    existingExpenses,
    mergedExpenses.map((expense, index) => buildExpenseRecordPayload(expense, index)),
    appConfig
  );

  await upsertStateValue(appConfig, 'expenses', {});
}


async function ensurePocketBaseSchema(appConfig) {
  await ensureUsersCollection(appConfig);
  for (const spec of DEFAULT_COLLECTION_SPECS) {
    await ensureCollection(appConfig, spec);
  }
  await ensureStateDefaults(appConfig);
  await migrateLegacyPeopleData(appConfig);
  await migrateLegacyExpensesData(appConfig);
}

async function verifyUserToken(token) {
  const payload = decodeTokenPayload(token);
  if (!payload?.id) {
    throw new Error('Invalid token payload');
  }

  const userRecord = await pocketBaseRequest(`/api/collections/users/records/${payload.id}`, {
    token
  });

  return toPublicUser(userRecord);
}

async function registerUser({ email, password, firstName = '', lastName = '' }, appConfig = null) {
  const normalizedFirstName = String(firstName || '').trim();
  const normalizedLastName = String(lastName || '').trim();
  const name = `${normalizedFirstName} ${normalizedLastName}`.trim();

  // When appConfig is provided (e.g. during initial setup), use the superuser token
  // to create the record. This bypasses the collection's minPasswordLength constraint
  // so that passwords shorter than PocketBase's default 8-character minimum are accepted.
  const superuserToken = appConfig ? await authenticateSuperuser(appConfig) : null;

  const created = await pocketBaseRequest('/api/collections/users/records', {
    method: 'POST',
    token: superuserToken || undefined,
    body: {
      email,
      password,
      passwordConfirm: password,
      firstName: normalizedFirstName,
      lastName: normalizedLastName,
      name,
      emailVisibility: false,
      admin: false,
      superAdmin: false,
      emailNotifications: true
    }
  });

  const auth = await pocketBaseRequest('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: {
      identity: email,
      password
    }
  });

  return {
    created,
    token: auth.token,
    user: toPublicUser(auth.record)
  };
}

async function loginUser(email, password) {
  const auth = await pocketBaseRequest('/api/collections/users/auth-with-password', {
    method: 'POST',
    body: {
      identity: email,
      password
    }
  });

  return {
    token: auth.token,
    user: toPublicUser(auth.record)
  };
}

async function updateOwnPassword(token, userId, oldPassword, password) {
  await pocketBaseRequest(`/api/collections/users/records/${userId}`, {
    method: 'PATCH',
    token,
    body: {
      oldPassword,
      password,
      passwordConfirm: password
    }
  });
}

async function getUserRecord(appConfig, uid) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/users/records/${uid}`, {
    token,
    allow404: true
  });
}

async function listUserRecords(appConfig) {
  return listAllRecords('users', '', appConfig);
}

async function updateUserRecord(appConfig, uid, body) {
  return updateRecord('users', uid, body, appConfig);
}

function buildPersonRecordPayload(personKey, value) {
  return {
    personKey: String(personKey),
    uid: toOptionalText(value?.uid),
    name: toOptionalText(value?.name),
    status: toOptionalText(value?.status),
    memberSince: toOptionalText(value?.memberSince),
    originalMemberSince: toOptionalText(value?.originalMemberSince || value?.memberSince),
    totalPaid: calculateTotalPaid(value?.payments),
    data: stripNormalizedPersonData(value)
  };
}

function buildRequestRecordPayload(requestKey, value) {
  return {
    requestKey: String(requestKey),
    userId: value?.userId ? String(value.userId) : '',
    personId: value?.personId ? String(value.personId) : '',
    personName: value?.personName ? String(value.personName) : '',
    type: value?.type ? String(value.type) : '',
    status: value?.status ? String(value.status) : '',
    timestamp: typeof value?.timestamp === 'number' ? value.timestamp : null,
    data: value || null
  };
}

async function getPeopleRecord(appConfig, personKey) {
  const record = await getFirstRecord('people', pbFilterEquals('personKey', personKey), appConfig);
  if (!record) return null;
  const [payments, statusHistory, settingsRecord] = await Promise.all([
    listAllRecords('payments', pbFilterEquals('personKey', personKey), appConfig),
    listAllRecords('status_history', pbFilterEquals('personKey', personKey), appConfig),
    getStateRecord(appConfig, 'settings')
  ]);
  const settings = settingsRecord ? settingsRecord.value : DEFAULT_SETTINGS;
  return {
    ...record,
    _childPayments: payments,
    _childStatusHistory: statusHistory,
    data: hydratePersonRecord(record, payments, statusHistory, settings)
  };
}

async function listPeopleRecords(appConfig, query = {}) {
  let filter = '';
  if (query.orderByChild === 'uid' && query.equalTo !== undefined) {
    filter = pbFilterEquals('uid', query.equalTo);
  } else if (query.orderByChild === 'name' && query.equalTo !== undefined) {
    filter = pbFilterEquals('name', query.equalTo);
  }
  const people = await listAllRecords('people', filter, appConfig);
  const personKeys = people.map((record) => record.personKey);
  const [payments, statusHistory, settingsRecord] = await Promise.all([
    listChildRecordsForPeople('payments', personKeys, appConfig),
    listChildRecordsForPeople('status_history', personKeys, appConfig),
    getStateRecord(appConfig, 'settings')
  ]);
  const settings = settingsRecord ? settingsRecord.value : DEFAULT_SETTINGS;
  const paymentsByPersonKey = groupRecordsBy(payments, 'personKey');
  const historyByPersonKey = groupRecordsBy(statusHistory, 'personKey');

  return people.map((record) => ({
    ...record,
    data: hydratePersonRecord(record, paymentsByPersonKey[record.personKey] || [], historyByPersonKey[record.personKey] || [], settings)
  }));
}

async function upsertPeopleRecord(appConfig, personKey, value, expectedUpdated = null) {
  const existing = await getPeopleRecord(appConfig, personKey);
  if (existing) {
    if (expectedUpdated && existing.updated !== expectedUpdated) {
      const error = new Error('Conflict');
      error.status = 409;
      throw error;
    }
    const existingChildren = {
      payments: existing._childPayments || [],
      statusHistory: existing._childStatusHistory || []
    };
    await updateRecord('people', existing.id, buildPersonRecordPayload(personKey, value), appConfig);
    await syncPeopleChildRecords(appConfig, personKey, value, existingChildren);
    return getPeopleRecord(appConfig, personKey);
  }
  if (expectedUpdated) {
    const error = new Error('Conflict');
    error.status = 409;
    throw error;
  }
  await createRecord('people', buildPersonRecordPayload(personKey, value), appConfig);
  await syncPeopleChildRecords(appConfig, personKey, value, { payments: [], statusHistory: [] });
  return getPeopleRecord(appConfig, personKey);
}

async function removePeopleRecord(appConfig, personKey) {
  const existing = await getPeopleRecord(appConfig, personKey);
  if (existing) {
    // 1. Delete corresponding auth user record from 'users' collection if uid exists
    const uid = existing.uid || (existing.data && existing.data.uid);
    if (uid) {
      try {
        await deleteRecord('users', uid, appConfig);
      } catch (err) {
        console.warn(`[PocketBase] Failed to delete auth user ${uid}:`, err.message);
      }
    }

    // 2. Delete status history records associated with this personKey
    const statusHistory = await listAllRecords('status_history', pbFilterEquals('personKey', personKey), appConfig);
    await Promise.all(
      statusHistory.map((entry) => deleteRecord('status_history', entry.id, appConfig))
    );

    // 3. Keep payments, name, totalPaid, uid, and profile picture, but absolutely delete/clear the rest
    // Set isDeleted = true, status = "", standingOrders = [] inside data JSON blob and people record
    const updatedData = {
      ...(existing.data || {}),
      status: '',
      standingOrders: [],
      isDeleted: true
    };

    const updatePayload = {
      personKey: String(personKey),
      uid: toOptionalText(uid),
      name: toOptionalText(existing.name),
      status: '',
      memberSince: toOptionalText(existing.memberSince),
      originalMemberSince: toOptionalText(existing.originalMemberSince || existing.memberSince),
      totalPaid: existing.totalPaid || 0,
      data: updatedData
    };

    await updateRecord('people', existing.id, updatePayload, appConfig);
  }
}

async function listExpenseRecords(appConfig) {
  return listAllRecords('expenses', '', appConfig);
}

async function syncExpenseRecords(appConfig, value) {
  const normalizedExpenses = normalizeRecordListInput(value);
  const existingExpenses = await listAllRecords('expenses', '', appConfig);
  await syncCollectionRecords(
    'expenses',
    'expenseKey',
    existingExpenses,
    normalizedExpenses.map((expense, index) => buildExpenseRecordPayload(expense, index)),
    appConfig
  );
}

async function getRequestRecord(appConfig, requestKey) {
  return getFirstRecord('requests', pbFilterEquals('requestKey', requestKey), appConfig);
}

async function listRequestRecords(appConfig, query = {}) {
  let filter = '';
  if (query.orderByChild === 'userId' && query.equalTo !== undefined) {
    filter = pbFilterEquals('userId', query.equalTo);
  }
  return listAllRecords('requests', filter, appConfig);
}

async function upsertRequestRecord(appConfig, requestKey, value) {
  const existing = await getRequestRecord(appConfig, requestKey);
  if (existing) {
    return updateRecord('requests', existing.id, buildRequestRecordPayload(requestKey, value), appConfig);
  }
  return createRecord('requests', buildRequestRecordPayload(requestKey, value), appConfig);
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_STATE,
  generatePocketBaseCredentials,
  normalizeDataPath,
  decodeTokenPayload,
  toPublicUser,
  buildPocketBaseError,
  sanitizeSelfUserWrite,
  normalizeRecordListInput,
  stripNormalizedPersonData,
  buildPersonRecordPayload,
  buildPaymentRecordPayload,
  buildStatusHistoryRecordPayload,
  buildExpenseRecordPayload,
  hydratePersonRecord,
  clearSuperuserTokenCache,
  getPocketBaseBaseUrl,
  getPocketBaseBinaryPath,
  getPocketBaseDataDir,
  ensurePocketBaseSuperuser,
  ensurePocketBaseSchema,
  verifyUserToken,
  registerUser,
  loginUser,
  updateOwnPassword,
  getStateValue,
  upsertStateValue,
  getStateRecord,
  getUserRecord,
  listUserRecords,
  updateUserRecord,
  listPeopleRecords,
  getPeopleRecord,
  upsertPeopleRecord,
  removePeopleRecord,
  listExpenseRecords,
  syncExpenseRecords,
  listRequestRecords,
  getRequestRecord,
  upsertRequestRecord
};
