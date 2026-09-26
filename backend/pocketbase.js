const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolveDataDirectory, resolvePocketBaseDirectory } = require('./pathConfig');
const {
  encryptMentoringText,
  decryptMentoringText
} = require('./mentoringCrypto');

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
  ownerUid: null,
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
    deleteRule: '@request.auth.owner = true || @request.auth.superAdmin = true || @request.auth.admin = true',
    indexes: [
      'CREATE UNIQUE INDEX idx_app_state_key ON app_state (key)'
    ],
    fields: [
      { name: 'key', type: 'text', required: true },
      { name: 'value', type: 'json' }
    ]
  },
  {
    name: 'groups',
    type: 'base',
    listRule: '@request.auth.admin = true || @request.auth.owner = true',
    viewRule: '@request.auth.admin = true || @request.auth.owner = true',
    createRule: '@request.auth.admin = true || @request.auth.owner = true',
    updateRule: '@request.auth.admin = true || @request.auth.owner = true',
    deleteRule: '@request.auth.admin = true || @request.auth.owner = true',
    indexes: [
      'CREATE UNIQUE INDEX idx_groups_name ON groups (name)'
    ],
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'permissions', type: 'json' }
    ]
  },
  {
    name: 'mentors',
    type: 'base',
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != ""',
    deleteRule: '@request.auth.admin = true || @request.auth.id = user',
    indexes: [
      'CREATE UNIQUE INDEX idx_mentors_user ON mentors (user)',
      'CREATE INDEX idx_mentors_status ON mentors (status)'
    ],
    fields: [
      { name: 'user', type: 'text', required: true },
      { name: 'status', type: 'text', required: true },
      { name: 'bio', type: 'text' },
      { name: 'max_mentees', type: 'number' },
      { name: 'is_accepting', type: 'bool' },
      { name: 'created', type: 'text' }
    ]
  },
  {
    name: 'mentoring_threads',
    type: 'base',
    listRule: '@request.auth.id = mentor || @request.auth.id = mentee',
    viewRule: '@request.auth.id = mentor || @request.auth.id = mentee',
    createRule: '@request.auth.id = mentee',
    updateRule: '@request.auth.id = mentor || @request.auth.id = mentee',
    deleteRule: '@request.auth.id = mentor || @request.auth.id = mentee',
    indexes: [
      'CREATE INDEX idx_mentoring_threads_mentor ON mentoring_threads (mentor)',
      'CREATE INDEX idx_mentoring_threads_mentee ON mentoring_threads (mentee)'
    ],
    fields: [
      { name: 'mentor', type: 'text', required: true },
      { name: 'mentee', type: 'text', required: true },
      { name: 'mentee_alias', type: 'text', required: true },
      { name: 'status', type: 'text', required: true },
      { name: 'last_message', type: 'text' },
      { name: 'created', type: 'text' },
      { name: 'updated', type: 'text' }
    ]
  },
  {
    name: 'mentoring_messages',
    type: 'base',
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != ""',
    deleteRule: '@request.auth.id != ""',
    indexes: [
      'CREATE INDEX idx_mentoring_messages_thread ON mentoring_messages (thread)'
    ],
    fields: [
      { name: 'thread', type: 'text', required: true },
      { name: 'sender_role', type: 'text', required: true },
      { name: 'text', type: 'text', required: true },
      { name: 'read', type: 'bool' },
      { name: 'created', type: 'text' }
    ]
  },
  {
    name: 'events',
    type: 'base',
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != ""',
    deleteRule: '@request.auth.id != ""',
    indexes: [
      'CREATE INDEX idx_events_date ON events (date)',
      'CREATE INDEX idx_events_status ON events (status)',
      'CREATE INDEX idx_events_series ON events (seriesId)'
    ],
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'date', type: 'text', required: true },
      { name: 'startTime', type: 'text' },
      { name: 'endTime', type: 'text' },
      { name: 'location', type: 'text' },
      { name: 'description', type: 'text' },
      { name: 'isRecurring', type: 'bool' },
      { name: 'recurringRule', type: 'text' },
      { name: 'seriesId', type: 'text' },
      { name: 'status', type: 'text', required: true },
      { name: 'requiresRegistration', type: 'bool' },
      { name: 'minParticipants', type: 'number' },
      { name: 'maxParticipants', type: 'number' },
      { name: 'targetGroups', type: 'json' },
      { name: 'isPinned', type: 'bool' },
      { name: 'endDate', type: 'text' },
      { name: 'eventType', type: 'text' },
      { name: 'imageUrl', type: 'text' },
      { name: 'createdBy', type: 'text', required: true },
      { name: 'created', type: 'text' },
      { name: 'updated', type: 'text' }
    ]
  },
  {
    name: 'event_registrations',
    type: 'base',
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != ""',
    deleteRule: '@request.auth.id != ""',
    indexes: [
      'CREATE UNIQUE INDEX idx_event_user_reg ON event_registrations (event, user)',
      'CREATE INDEX idx_event_reg_event ON event_registrations (event)'
    ],
    fields: [
      { name: 'event', type: 'text', required: true },
      { name: 'user', type: 'text', required: true },
      { name: 'status', type: 'text', required: true },
      { name: 'created', type: 'text' },
      { name: 'updated', type: 'text' }
    ]
  },
  {
    name: 'event_duties',
    type: 'base',
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != ""',
    deleteRule: '@request.auth.id != ""',
    indexes: [
      'CREATE INDEX idx_event_duties_event ON event_duties (event)'
    ],
    fields: [
      { name: 'event', type: 'text', required: true },
      { name: 'section', type: 'text' },
      { name: 'roleName', type: 'text', required: true },
      { name: 'assignedGroup', type: 'text' },
      { name: 'assignedUser', type: 'text' },
      { name: 'requestedUser', type: 'text' },
      { name: 'requestedBy', type: 'text' },
      { name: 'notes', type: 'text' },
      { name: 'status', type: 'text', required: true },
      { name: 'created', type: 'text' },
      { name: 'updated', type: 'text' }
    ]
  },
  {
    name: 'push_subscriptions',
    type: 'base',
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != ""',
    deleteRule: '@request.auth.id != ""',
    indexes: [
      'CREATE INDEX idx_push_sub_user ON push_subscriptions (user)',
      'CREATE UNIQUE INDEX idx_push_sub_endpoint ON push_subscriptions (endpoint)'
    ],
    fields: [
      { name: 'user', type: 'text', required: true },
      { name: 'endpoint', type: 'text', required: true },
      { name: 'p256dh', type: 'text', required: true },
      { name: 'auth', type: 'text', required: true },
      { name: 'userAgent', type: 'text' },
      { name: 'created', type: 'text' }
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
    adminEmail: `agora-${crypto.randomUUID()}@local.invalid`,
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

function isPlaceholderEmail(email) {
  if (!email) return true;
  const str = String(email).toLowerCase().trim();
  return str.endsWith('@agora.local') || str.endsWith('@nova.local') || str.endsWith('@local.invalid') || str.startsWith('unclaimed_');
}

function toPublicUser(record) {
  if (!record) return null;
  const isOwner = record.owner === true || record.superAdmin === true;
  const isPlaceholder = isPlaceholderEmail(record.email);
  const isClaimed = !isPlaceholder;
  return {
    uid: record.id,
    id: record.id,
    email: isPlaceholder ? '' : (record.email || ''),
    rawEmail: record.email || '',
    firstName: record.firstName || '',
    lastName: record.lastName || '',
    name: record.name || `${record.firstName || ''} ${record.lastName || ''}`.trim(),
    admin: record.admin === true || isOwner,
    owner: isOwner,
    superAdmin: isOwner,
    pays: record.pays !== false,
    groups: Array.isArray(record.groups) ? record.groups : (record.groups ? [String(record.groups)] : []),
    emailNotifications: record.emailNotifications !== false,
    notificationSettings: record.notificationSettings && typeof record.notificationSettings === 'object'
      ? {
          duties: record.notificationSettings.duties !== false,
          events: record.notificationSettings.events !== false,
          messages: record.notificationSettings.messages !== false,
          finances: record.notificationSettings.finances !== false
        }
      : {
          duties: record.emailNotifications !== false,
          events: record.emailNotifications !== false,
          messages: record.emailNotifications !== false,
          finances: record.emailNotifications !== false
        },
    isClaimed
  };
}

function sanitizeSelfUserWrite(input = {}) {
  const output = {};
  if (typeof input.firstName === 'string') output.firstName = input.firstName.trim();
  if (typeof input.lastName === 'string') output.lastName = input.lastName.trim();
  if (typeof input.emailNotifications === 'boolean') output.emailNotifications = input.emailNotifications;
  if (input.notificationSettings && typeof input.notificationSettings === 'object') {
    output.notificationSettings = {
      duties: input.notificationSettings.duties !== false,
      events: input.notificationSettings.events !== false,
      messages: input.notificationSettings.messages !== false,
      finances: input.notificationSettings.finances !== false
    };
  }
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
    { name: 'owner', type: 'bool' },
    { name: 'superAdmin', type: 'bool' },
    { name: 'pays', type: 'bool' },
    { name: 'groups', type: 'json' },
    { name: 'emailNotifications', type: 'bool' },
    { name: 'notificationSettings', type: 'json' },
    { name: 'isClaimed', type: 'bool' }
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
      listRule: '@request.auth.admin = true || @request.auth.owner = true',
      viewRule: 'id = @request.auth.id || @request.auth.admin = true || @request.auth.owner = true',
      createRule: '',
      updateRule: 'id = @request.auth.id || @request.auth.admin = true || @request.auth.owner = true',
      deleteRule: '@request.auth.owner = true || @request.auth.superAdmin = true || @request.auth.admin = true',
      authToken: { duration: 94670856 },
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

async function listAllRecords(collectionName, filter, appConfig, sort = '') {
  const token = await authenticateSuperuser(appConfig);
  const items = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
    if (filter) params.set('filter', filter);
    if (sort) params.set('sort', sort);
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
    const amount = Number(String(list[i]?.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.'));
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
  if (record.data?.isDeleted || record.isDeleted) {
    data.isDeleted = true;
  }
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


async function migrateUserAndOwnerSchema(appConfig) {
  const systemRecord = await getStateRecord(appConfig, 'system');
  const system = systemRecord?.value || {};
  let ownerUid = system.ownerUid || system.superAdminUid || null;
  let systemNeedsUpdate = false;

  if (system.superAdminUid && !system.ownerUid) {
    system.ownerUid = system.superAdminUid;
    systemNeedsUpdate = true;
  }

  const users = await listAllRecords('users', '', appConfig);

  if (!ownerUid && users.length > 0) {
    const existingOwner = users.find((u) => u.owner === true || u.superAdmin === true) || users[0];
    ownerUid = existingOwner.id;
    system.ownerUid = ownerUid;
    systemNeedsUpdate = true;
  }

  if (systemNeedsUpdate) {
    await upsertStateValue(appConfig, 'system', { ...DEFAULT_SYSTEM_STATE, ...system, ownerUid });
  }

  await runInBatches(users, MIGRATION_BATCH_SIZE, async (userRecord) => {
    const isOwner = userRecord.id === ownerUid || userRecord.owner === true || userRecord.superAdmin === true;
    const updates = {};
    let needsPatch = false;

    if (isOwner) {
      if (userRecord.owner !== true) { updates.owner = true; needsPatch = true; }
      if (userRecord.admin !== true) { updates.admin = true; needsPatch = true; }
      if (userRecord.superAdmin !== true) { updates.superAdmin = true; needsPatch = true; }
    } else {
      if (userRecord.owner === undefined || userRecord.owner === null) { updates.owner = false; needsPatch = true; }
      if (userRecord.superAdmin !== false && userRecord.superAdmin !== undefined) { updates.superAdmin = false; needsPatch = true; }
    }

    if (userRecord.pays === undefined || userRecord.pays === null) {
      updates.pays = true;
      needsPatch = true;
    }

    if (userRecord.groups === undefined || userRecord.groups === null) {
      updates.groups = [];
      needsPatch = true;
    }

    const isPlaceholder = isPlaceholderEmail(userRecord.email);
    if (!isPlaceholder) {
      if (userRecord.isClaimed !== true) {
        updates.isClaimed = true;
        needsPatch = true;
      }
    } else {
      if (userRecord.isClaimed !== false) {
        updates.isClaimed = false;
        needsPatch = true;
      }
    }

    if (needsPatch) {
      try {
        await updateUserRecord(appConfig, userRecord.id, updates);
      } catch (err) {
        console.warn(`[PocketBase Migration] Could not patch user ${userRecord.id}:`, err.message);
      }
    }
  });

  // Ensure every person record has a corresponding user record in the users collection
  try {
    const people = await listPeopleRecords(appConfig);
    const freshUsers = await listAllRecords('users', '', appConfig);

    for (const p of people) {
      const isDeleted = Boolean(p.isDeleted || p.data?.isDeleted);
      const personName = (p.name || p.data?.name || '').trim();
      const existingUid = p.uid || p.data?.uid;
      let linkedUser = existingUid ? freshUsers.find(u => u.id === existingUid) : null;

      if (!linkedUser && personName) {
        const normPersonName = personName.toLowerCase();
        linkedUser = freshUsers.find(u => {
          const uFull = `${u.firstName || ''} ${u.lastName || ''}`.trim().toLowerCase();
          const uName = String(u.name || '').trim().toLowerCase();
          return uFull === normPersonName || uName === normPersonName;
        });
      }

      if (isDeleted) {
        // If an unclaimed or placeholder user exists for this deleted person, remove it so it does not linger
        if (linkedUser && (linkedUser.isClaimed === false || isPlaceholderEmail(linkedUser.email))) {
          try {
            await deleteRecord('users', linkedUser.id, appConfig);
            const userIdx = freshUsers.findIndex(u => u.id === linkedUser.id);
            if (userIdx >= 0) freshUsers.splice(userIdx, 1);
          } catch (cleanErr) {
            console.warn(`[PocketBase Migration] Could not remove phantom user ${linkedUser.id} for deleted person:`, cleanErr.message);
          }
        }
        continue;
      }

      if (linkedUser) {
        if (p.uid !== linkedUser.id || p.data?.uid !== linkedUser.id) {
          const existingData = p.data || {};
          existingData.uid = linkedUser.id;
          await upsertPeopleRecord(appConfig, p.personKey, existingData);
        }
      } else if (personName) {
        const nameParts = personName.split(/\s+/);
        const firstName = nameParts[0] || personName;
        const lastName = nameParts.slice(1).join(' ');

        const createdAuth = await registerUser({
          email: '',
          password: '',
          firstName,
          lastName,
          admin: false,
          owner: false,
          pays: p.data?.pays !== false && p.pays !== false,
          groups: [],
          isClaimed: false
        }, appConfig);

        const newUid = createdAuth.user.id || createdAuth.user.uid;
        const existingData = p.data || {};
        existingData.uid = newUid;
        await upsertPeopleRecord(appConfig, p.personKey, existingData);
        freshUsers.push(createdAuth.created || { id: newUid, firstName, lastName, name: personName });
      }
    }
  } catch (err) {
    console.warn('[PocketBase Migration] Could not link or create user records for legacy people:', err.message);
  }
}

async function ensurePocketBaseSchema(appConfig) {
  await ensureUsersCollection(appConfig);
  for (const spec of DEFAULT_COLLECTION_SPECS) {
    await ensureCollection(appConfig, spec);
  }
  await ensureStateDefaults(appConfig);
  await migrateUserAndOwnerSchema(appConfig);
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

async function registerUser({ email = '', password = '', firstName = '', lastName = '', admin = false, owner = false, pays = true, groups = [], isClaimed = null }, appConfig = null) {
  const normalizedFirstName = String(firstName || '').trim();
  const normalizedLastName = String(lastName || '').trim();
  const name = `${normalizedFirstName} ${normalizedLastName}`.trim();

  const isRealAccount = Boolean(email && password);
  const finalIsClaimed = isClaimed !== null ? isClaimed : isRealAccount;
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const finalEmail = isRealAccount ? String(email).trim() : `unclaimed_${Date.now()}_${randomSuffix}@agora.local`;
  const finalPassword = isRealAccount ? String(password) : crypto.randomBytes(16).toString('hex');

  // When appConfig is provided (e.g. during initial setup), use the superuser token
  // to create the record. This bypasses the collection's minPasswordLength constraint
  // so that passwords shorter than PocketBase's default 8-character minimum are accepted.
  const superuserToken = appConfig ? await authenticateSuperuser(appConfig) : null;

  const isOwner = owner === true;
  const isAdmin = admin === true || isOwner;

  const created = await pocketBaseRequest('/api/collections/users/records', {
    method: 'POST',
    token: superuserToken || undefined,
    body: {
      email: finalEmail,
      password: finalPassword,
      passwordConfirm: finalPassword,
      firstName: normalizedFirstName,
      lastName: normalizedLastName,
      name,
      emailVisibility: false,
      admin: isAdmin,
      owner: isOwner,
      superAdmin: isOwner,
      pays: pays !== false,
      groups: Array.isArray(groups) ? groups : [],
      emailNotifications: true,
      isClaimed: finalIsClaimed
    }
  });

  let token = null;
  let publicUser = toPublicUser(created);

  if (isRealAccount) {
    try {
      const auth = await pocketBaseRequest('/api/collections/users/auth-with-password', {
        method: 'POST',
        body: {
          identity: finalEmail,
          password: finalPassword
        }
      });
      token = auth.token;
      publicUser = toPublicUser(auth.record);
    } catch {
      // Superuser-created account without direct auth
    }
  }

  return {
    created,
    token,
    user: publicUser
  };
}

async function claimUserAccount(appConfig, uid, newEmail, newPassword) {
  const token = await authenticateSuperuser(appConfig);
  const normalizedEmail = String(newEmail || '').trim();
  const normalizedPassword = String(newPassword || '');

  const patched = await pocketBaseRequest(`/api/collections/users/records/${uid}`, {
    method: 'PATCH',
    token,
    body: {
      email: normalizedEmail,
      password: normalizedPassword,
      passwordConfirm: normalizedPassword,
      isClaimed: true
    }
  });

  return toPublicUser(patched);
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

async function adminResetUserPassword(appConfig, uid, newPassword) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/users/records/${uid}`, {
    method: 'PATCH',
    token,
    body: {
      password: newPassword,
      passwordConfirm: newPassword
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

async function deleteUserRecord(appConfig, uid) {
  return deleteRecord('users', uid, appConfig);
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
    isDeleted: Boolean(record.isDeleted || record.data?.isDeleted),
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

    // 3. Keep payments, name, totalPaid, but absolutely delete/clear the rest
    // Set isDeleted = true, status = "", standingOrders = [] inside data JSON blob and people record
    const updatedData = {
      ...(existing.data || {}),
      status: '',
      standingOrders: [],
      uid: '',
      isDeleted: true
    };

    const updatePayload = {
      personKey: String(personKey),
      uid: '',
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

function resolveUserPermissions(userGroups = [], allGroups = []) {
  const groupIds = Array.isArray(userGroups) ? userGroups : (userGroups ? [String(userGroups)] : []);
  const matchingGroups = (Array.isArray(allGroups) ? allGroups : []).filter((g) => groupIds.includes(g.id) || groupIds.includes(g.name));
  const permSet = new Set();
  for (const g of matchingGroups) {
    const perms = Array.isArray(g.permissions) ? g.permissions : [];
    for (const p of perms) {
      if (typeof p === 'string' && p.trim()) {
        permSet.add(p.trim());
      }
    }
  }
  const permissions = Array.from(permSet);
  const canManageFinances = permissions.includes('manage_finances');
  const canViewFinances = canManageFinances || permissions.includes('view_finances');
  const canManageRegistrationCode = permissions.includes('manage_registration_code');
  const canAccessAi = permissions.includes('access_ai');
  const canParticipateMentoring = true;
  const canManageMentoring = permissions.includes('manage_mentoring');
  const canManageEvents = permissions.includes('manage_events');
  return {
    permissions,
    canManageFinances,
    canViewFinances,
    canManageRegistrationCode,
    canAccessAi,
    canParticipateMentoring,
    canManageMentoring,
    canManageEvents
  };
}

async function listGroupRecords(appConfig = null) {
  try {
    const records = await listAllRecords('groups', '', appConfig, '+name');
    return records.map((r) => ({
      id: r.id,
      name: r.name || '',
      permissions: Array.isArray(r.permissions) ? r.permissions : []
    })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } catch (err) {
    console.error('Failed to list group records:', err);
    return [];
  }
}

async function getGroupRecord(appConfig, id) {
  const token = await authenticateSuperuser(appConfig);
  const record = await pocketBaseRequest(`/api/collections/groups/records/${id}`, { token });
  return {
    id: record.id,
    name: record.name || '',
    permissions: Array.isArray(record.permissions) ? record.permissions : []
  };
}

async function createGroupRecord(appConfig, { name, permissions = [] }) {
  const token = await authenticateSuperuser(appConfig);
  const record = await pocketBaseRequest('/api/collections/groups/records', {
    method: 'POST',
    token,
    body: {
      name: String(name || '').trim(),
      permissions: Array.isArray(permissions) ? permissions : []
    }
  });
  return {
    id: record.id,
    name: record.name || '',
    permissions: Array.isArray(record.permissions) ? record.permissions : []
  };
}

async function updateGroupRecord(appConfig, id, { name, permissions }) {
  const token = await authenticateSuperuser(appConfig);
  const body = {};
  if (name !== undefined) body.name = String(name).trim();
  if (permissions !== undefined) body.permissions = Array.isArray(permissions) ? permissions : [];
  const record = await pocketBaseRequest(`/api/collections/groups/records/${id}`, {
    method: 'PATCH',
    token,
    body
  });
  return {
    id: record.id,
    name: record.name || '',
    permissions: Array.isArray(record.permissions) ? record.permissions : []
  };
}

const SYSTEM_PERMISSIONS = [
  { id: 'view_finances', name: 'Finanzverwaltung (Nur Lesen)', description: 'Erlaubt die Einsicht in Kassenstände, Historie, Transaktionen und Berichte ohne Bearbeitungsrechte' },
  { id: 'manage_finances', name: 'Finanzverwaltung (Vollzugriff)', description: 'Erlaubt das Erfassen, Bearbeiten, Buchen und Löschen von Zahlungen, Spenden, Ausgaben und Daueraufträgen' },
  { id: 'manage_registration_code', name: 'Registrierungscode verwalten', description: 'Erlaubt das Einsehen, Kopieren und Neugenerieren des Registrierungscodes für neue Mitglieder' },
  { id: 'access_ai', name: 'KI-Support nutzen', description: 'Erlaubt den Zugriff und die Nutzung des integrierten KI-Assistenten' },
  { id: 'manage_mentoring', name: 'Mentoring-Verwaltung', description: 'Berechtigt Leiter dazu, Mentorenbewerbungen zu prüfen, genehmigen oder abzulehnen (kein Zugriff auf private Chats)' },
  { id: 'manage_events', name: 'Event- & Dienstplanverwaltung', description: 'Erlaubt das Anlegen von Serienterminen und die vollständige Verwaltung aller Events und Dienste' }
];

async function deleteGroupRecord(appConfig, id) {
  const token = await authenticateSuperuser(appConfig);
  let groupName = '';
  try {
    const existing = await pocketBaseRequest(`/api/collections/groups/records/${id}`, { token, allow404: true });
    if (existing) groupName = existing.name || '';
  } catch {}

  await pocketBaseRequest(`/api/collections/groups/records/${id}`, {
    method: 'DELETE',
    token
  });

  try {
    const users = await listAllRecords('users', '', appConfig);
    for (const u of users) {
      if (Array.isArray(u.groups) && (u.groups.includes(id) || (groupName && u.groups.includes(groupName)))) {
        const nextGroups = u.groups.filter((g) => g !== id && g !== groupName);
        await updateUserRecord(appConfig, u.id, { groups: nextGroups });
      }
    }
  } catch (err) {
    console.warn('[PocketBase] Failed to clean up user groups after group deletion:', err.message);
  }

  return true;
}

// Mentors
async function listMentorRecords(appConfig, filter = '', sort = '') {
  const records = await listAllRecords('mentors', filter, appConfig, sort);
  return records.sort((a, b) => (b.created || b.id || '').localeCompare(a.created || a.id || ''));
}

async function getMentorRecord(appConfig, id) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/mentors/records/${id}`, { token, allow404: true });
}

async function getMentorByUserId(appConfig, userId) {
  return getFirstRecord('mentors', pbFilterEquals('user', userId), appConfig);
}

async function createMentorRecord(appConfig, data) {
  const payload = {
    created: new Date().toISOString(),
    ...data
  };
  return createRecord('mentors', payload, appConfig);
}

async function updateMentorRecord(appConfig, id, data) {
  return updateRecord('mentors', id, data, appConfig);
}

async function deleteMentorRecord(appConfig, id) {
  return deleteRecord('mentors', id, appConfig);
}

// Mentoring Threads
async function listAllMentoringThreads(appConfig, filter = '') {
  const records = await listAllRecords('mentoring_threads', filter, appConfig, '');
  return records
    .map(r => ({
      ...r,
      last_message: r.last_message ? decryptMentoringText(r.last_message, r.id) : ''
    }))
    .sort((a, b) => (b.updated || b.created || b.id || '').localeCompare(a.updated || a.created || a.id || ''));
}

async function listMentoringThreadsForUser(appConfig, userIds) {
  if (!userIds || userIds === '') {
    return listAllMentoringThreads(appConfig);
  }
  const ids = Array.isArray(userIds) ? userIds : [userIds].filter(Boolean);
  if (ids.length === 0) return [];
  const parts = [];
  ids.forEach(id => {
    parts.push(pbFilterEquals('mentor', id));
    parts.push(pbFilterEquals('mentee', id));
  });
  const filter = parts.join(' || ');
  return listAllMentoringThreads(appConfig, filter);
}

async function getMentoringThread(appConfig, id) {
  const token = await authenticateSuperuser(appConfig);
  const record = await pocketBaseRequest(`/api/collections/mentoring_threads/records/${id}`, { token, allow404: true });
  if (record && record.last_message) {
    record.last_message = decryptMentoringText(record.last_message, record.id);
  }
  return record;
}

async function createMentoringThread(appConfig, data) {
  const now = new Date().toISOString();
  const rawLastMessage = data.last_message ? String(data.last_message).trim() : '';
  const payload = {
    created: now,
    updated: now,
    ...data,
    last_message: ''
  };
  let record;
  try {
    record = await createRecord('mentoring_threads', payload, appConfig);
  } catch (err) {
    if (payload.last_message !== undefined) {
      delete payload.last_message;
      record = await createRecord('mentoring_threads', payload, appConfig);
    } else {
      throw err;
    }
  }

  if (rawLastMessage && record && record.id) {
    const encryptedLastMessage = encryptMentoringText(rawLastMessage, record.id);
    await updateRecord('mentoring_threads', record.id, { last_message: encryptedLastMessage }, appConfig).catch(() => {});
    record.last_message = rawLastMessage;
  } else if (record) {
    record.last_message = rawLastMessage;
  }
  return record;
}

async function updateMentoringThread(appConfig, id, data) {
  const rawLastMessage = data.last_message;
  const payload = {
    updated: new Date().toISOString(),
    ...data
  };
  if (rawLastMessage !== undefined) {
    payload.last_message = rawLastMessage ? encryptMentoringText(rawLastMessage, id) : '';
  }
  try {
    const updated = await updateRecord('mentoring_threads', id, payload, appConfig);
    if (updated && rawLastMessage !== undefined) {
      updated.last_message = rawLastMessage;
    }
    return updated;
  } catch (err) {
    if (payload.last_message !== undefined) {
      delete payload.last_message;
      return await updateRecord('mentoring_threads', id, payload, appConfig).catch(() => null);
    }
    throw err;
  }
}

// Mentoring Messages
async function listMentoringMessages(appConfig, threadId) {
  const filter = pbFilterEquals('thread', threadId);
  const records = await listAllRecords('mentoring_messages', filter, appConfig, '');
  return records
    .map(r => ({
      ...r,
      text: decryptMentoringText(r.text, threadId)
    }))
    .sort((a, b) => (a.created || a.id || '').localeCompare(b.created || b.id || ''));
}

async function createMentoringMessage(appConfig, data) {
  const rawText = data.text ? String(data.text) : '';
  const threadId = data.thread || '';
  const encryptedText = encryptMentoringText(rawText, threadId);
  const payload = {
    created: new Date().toISOString(),
    ...data,
    text: encryptedText
  };
  const record = await createRecord('mentoring_messages', payload, appConfig);
  return {
    ...record,
    text: rawText
  };
}

async function markMentoringMessagesRead(appConfig, threadId, currentRole) {
  const otherRole = currentRole === 'mentor' ? 'mentee' : 'mentor';
  const filter = `${pbFilterEquals('thread', threadId)} && ${pbFilterEquals('sender_role', otherRole)} && read = false`;
  const unreadMessages = await listAllRecords('mentoring_messages', filter, appConfig, '');
  for (const msg of unreadMessages) {
    await updateRecord('mentoring_messages', msg.id, { read: true }, appConfig).catch(() => {});
  }
}

// Events
async function listEvents(appConfig, filter = '', sort = '+date,+startTime') {
  return await listAllRecords('events', filter, appConfig, sort);
}

async function getEventRecord(appConfig, id) {
  const token = await authenticateSuperuser(appConfig);
  return await pocketBaseRequest(`/api/collections/events/records/${id}`, { token, allow404: true });
}

async function createEventRecord(appConfig, data) {
  const now = new Date().toISOString();
  const payload = {
    created: now,
    updated: now,
    status: 'scheduled',
    eventType: 'event',
    isPinned: false,
    endDate: '',
    imageUrl: '',
    isRecurring: false,
    requiresRegistration: false,
    minParticipants: 0,
    maxParticipants: 0,
    targetGroups: [],
    ...data
  };
  return await createRecord('events', payload, appConfig);
}

async function updateEventRecord(appConfig, id, data) {
  const payload = {
    updated: new Date().toISOString(),
    ...data
  };
  return await updateRecord('events', id, payload, appConfig);
}

async function deleteEventRecord(appConfig, id) {
  const token = await authenticateSuperuser(appConfig);
  try {
    const regs = await listAllRecords('event_registrations', pbFilterEquals('event', id), appConfig);
    for (const r of regs) {
      await pocketBaseRequest(`/api/collections/event_registrations/records/${r.id}`, { method: 'DELETE', token }).catch(() => {});
    }
    const duties = await listAllRecords('event_duties', pbFilterEquals('event', id), appConfig);
    for (const d of duties) {
      await pocketBaseRequest(`/api/collections/event_duties/records/${d.id}`, { method: 'DELETE', token }).catch(() => {});
    }
  } catch (err) {
    console.warn('[PocketBase] Failed to clean up event children:', err.message);
  }
  return await pocketBaseRequest(`/api/collections/events/records/${id}`, { method: 'DELETE', token });
}

// Event Registrations
async function listEventRegistrations(appConfig, filter = '') {
  return await listAllRecords('event_registrations', filter, appConfig, '+created');
}

async function getEventRegistration(appConfig, eventId, userId) {
  const filter = `${pbFilterEquals('event', eventId)} && ${pbFilterEquals('user', userId)}`;
  const records = await listAllRecords('event_registrations', filter, appConfig);
  return records[0] || null;
}

async function upsertEventRegistration(appConfig, eventId, userId, status) {
  const existing = await getEventRegistration(appConfig, eventId, userId);
  const now = new Date().toISOString();
  if (existing) {
    return await updateRecord('event_registrations', existing.id, { status, updated: now }, appConfig);
  }
  return await createRecord('event_registrations', {
    event: eventId,
    user: userId,
    status,
    created: now,
    updated: now
  }, appConfig);
}

// Event Duties
async function listEventDuties(appConfig, filter = '') {
  return await listAllRecords('event_duties', filter, appConfig, '+created');
}

async function getEventDuty(appConfig, id) {
  const token = await authenticateSuperuser(appConfig);
  return await pocketBaseRequest(`/api/collections/event_duties/records/${id}`, { token, allow404: true });
}

async function createEventDuty(appConfig, data) {
  const now = new Date().toISOString();
  const payload = {
    created: now,
    updated: now,
    status: 'open',
    notes: '',
    ...data
  };
  return await createRecord('event_duties', payload, appConfig);
}

async function updateEventDuty(appConfig, id, data) {
  const payload = {
    updated: new Date().toISOString(),
    ...data
  };
  return await updateRecord('event_duties', id, payload, appConfig);
}

async function deleteEventDuty(appConfig, id) {
  const token = await authenticateSuperuser(appConfig);
  return await pocketBaseRequest(`/api/collections/event_duties/records/${id}`, { method: 'DELETE', token });
}

async function listPushSubscriptions(appConfig, filter = '') {
  return listAllRecords('push_subscriptions', filter, appConfig);
}

async function getPushSubscriptionByEndpoint(appConfig, endpoint) {
  return getFirstRecord('push_subscriptions', pbFilterEquals('endpoint', endpoint), appConfig);
}

async function upsertPushSubscription(appConfig, userId, subscription, userAgent = '') {
  const existing = await getPushSubscriptionByEndpoint(appConfig, subscription.endpoint);
  const payload = {
    user: String(userId),
    endpoint: String(subscription.endpoint),
    p256dh: String(subscription.keys?.p256dh || ''),
    auth: String(subscription.keys?.auth || ''),
    userAgent: String(userAgent || ''),
    created: new Date().toISOString()
  };
  if (existing) {
    return updateRecord('push_subscriptions', existing.id, payload, appConfig);
  }
  return createRecord('push_subscriptions', payload, appConfig);
}

async function deletePushSubscription(appConfig, endpoint) {
  const existing = await getPushSubscriptionByEndpoint(appConfig, endpoint);
  if (existing) {
    return deleteRecord('push_subscriptions', existing.id, appConfig);
  }
  return null;
}

module.exports = {
  listPushSubscriptions,
  getPushSubscriptionByEndpoint,
  upsertPushSubscription,
  deletePushSubscription,
  listAllRecords,
  createRecord,
  updateRecord,
  deleteRecord,
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
  deleteUserRecord,
  adminResetUserPassword,
  claimUserAccount,
  isPlaceholderEmail,
  listGroupRecords,
  getGroupRecord,
  createGroupRecord,
  updateGroupRecord,
  deleteGroupRecord,
  resolveUserPermissions,
  listPeopleRecords,
  getPeopleRecord,
  upsertPeopleRecord,
  removePeopleRecord,
  listExpenseRecords,
  syncExpenseRecords,
  listRequestRecords,
  getRequestRecord,
  upsertRequestRecord,
  SYSTEM_PERMISSIONS,
  listMentorRecords,
  getMentorRecord,
  getMentorByUserId,
  createMentorRecord,
  updateMentorRecord,
  deleteMentorRecord,
  listAllMentoringThreads,
  listMentoringThreadsForUser,
  getMentoringThread,
  createMentoringThread,
  updateMentoringThread,
  listMentoringMessages,
  createMentoringMessage,
  markMentoringMessagesRead,
  encryptMentoringText,
  decryptMentoringText,
  listEvents,
  getEventRecord,
  createEventRecord,
  updateEventRecord,
  deleteEventRecord,
  listEventRegistrations,
  getEventRegistration,
  upsertEventRegistration,
  listEventDuties,
  getEventDuty,
  createEventDuty,
  updateEventDuty,
  deleteEventDuty,
  pbFilterEquals
};
