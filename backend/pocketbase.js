const { readNotificationSettings } = require('./notificationPrefs');
const crypto = require('crypto');
const {
  encryptMentoringText,
  decryptMentoringText
} = require('./mentoringCrypto');
const {
  getPocketBaseBaseUrl,
  getPocketBaseBinaryPath,
  getPocketBaseDataDir,
  buildPocketBaseError,
  invalidateReadCache,
  pocketBaseRequest,
  authenticateSuperuser,
  clearSuperuserTokenCache,
  ensurePocketBaseSuperuser,
  listAllRecords,
  pbFilterEquals,
  getFirstRecord,
  createRecord,
  updateRecord,
  deleteRecord
} = require('./db/client');
const {
  normalizeRecordListInput,
  toOptionalText,
  toFiniteNumber,
  calculateTotalPaid,
  stableSerialize,
  buildStableChildKey,
  stripNormalizedPersonData,
  buildPaymentRecordPayload,
  buildStatusHistoryRecordPayload,
  buildExpenseRecordPayload,
  groupRecordsBy,
  getChildRecordIdentity,
  toSortedChildValues,
  hydratePersonRecord,
  buildPersonRecordPayload,
  buildRequestRecordPayload,
  isOutdatedVersion,
  isDeletedPerson,
  deletedPersonPayload
} = require('./db/legacyShapes');
const { queueRecordWrite } = require('./db/writeQueue');

const { DEFAULT_SETTINGS, DEFAULT_SYSTEM_STATE } = require('./db/defaults');

// Older versions stored this fixed code until someone made a new one: anyone could register with it
const LEGACY_DEFAULT_INVITE_CODE = '123456';
const randomInviteCode = () => String(crypto.randomInt(100000, 1000000));

/** The system state with a registration code of its own (a random one instead of none or the old fixed one). */
const withSecureInviteCode = (system) => {
  const code = String(system?.inviteCode || '');
  return !code || code === LEGACY_DEFAULT_INVITE_CODE ? { ...system, inviteCode: randomInviteCode() } : system;
};

/**
 * The owner recorded in [system] ({ ownerUid, claim: false }). Setup records one; only an installation from before
 * that has none, and then an admin of it ([user]) becomes the owner ({ ownerUid: their uid, claim: true }) - a member
 * never does: the app asks on every sign-in, so the first member to open it would have taken over the instance.
 */
function ownerClaim(system, user) {
  const recorded = system?.ownerUid || system?.superAdminUid || null;
  if (recorded) return { ownerUid: recorded, claim: false };
  return user?.admin === true && user.uid ? { ownerUid: user.uid, claim: true } : { ownerUid: null, claim: false };
}

// Every collection is the server's alone: it reads and writes as superuser, and the apps only reach the data through it.
// A member's own PocketBase token (the session token) could otherwise read and change records directly wherever
// PocketBase's port is reachable - from another container on the same Docker network, or where port 8090 is published
// for the admin page. Only the users collection lets a token read its own record (the server's sign-in check).
const SERVER_ONLY_RULES = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };

function generatePocketBaseCredentials() {
  return {
    url: getPocketBaseBaseUrl(),
    // Internal-only superuser used by the bundled backend to provision PocketBase.
    adminEmail: `agora-${crypto.randomUUID()}@local.invalid`,
    // base64url may start with "-", which the PocketBase CLI would read as an option: always start with a letter
    adminPassword: `p${crypto.randomBytes(24).toString('base64url')}`
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
    // Channels and kinds per channel; the flat keys repeat the push choice for older app versions
    notificationSettings: (() => {
      const settings = readNotificationSettings(record);
      return { ...settings.push, ...settings };
    })(),
    isClaimed,
    calendarToken: record.calendarToken || '',
    // the language the user's app resolved to (push / e-mail); '' = the instance default
    language: record.language || '',
    // time zone of the user's app (finds the community's zone for duty reminders when the server has no TZ)
    timeZone: record.timeZone || ''
  };
}

// Kinds of messages plus the two channel switches (notificationPrefs.js)
const NOTIFICATION_SETTING_KEYS = ['duties', 'events', 'messages', 'requests', 'finances', 'reports', 'push', 'email'];

function sanitizeSelfUserWrite(input = {}) {
  const output = {};
  // No first / last name: the name links an account to its finance record, so only admins change it
  if (typeof input.emailNotifications === 'boolean') output.emailNotifications = input.emailNotifications;
  if (typeof input.language === 'string') {
    const language = require('./i18n').normalizeLanguage(input.language);
    if (language) output.language = language;
  }
  if (typeof input.timeZone === 'string') {
    const timeZone = require('./dutyReminders').validTimeZone(input.timeZone);
    if (timeZone) output.timeZone = timeZone;
  }
  if (input.notificationSettings && typeof input.notificationSettings === 'object') {
    const pickBooleans = (source) => Object.fromEntries(Object.entries(source && typeof source === 'object' ? source : {})
      .filter(([key, value]) => NOTIFICATION_SETTING_KEYS.includes(key) && typeof value === 'boolean'));
    const settings = input.notificationSettings;
    output.notificationSettings = {
      ...pickBooleans(settings),
      ...(settings.channels && typeof settings.channels === 'object' ? { channels: pickBooleans(settings.channels) } : {}),
      ...(settings.push && typeof settings.push === 'object' ? { push: pickBooleans(settings.push) } : {}),
      ...(settings.email && typeof settings.email === 'object' ? { email: pickBooleans(settings.email) } : {})
    };
  }
  return output;
}

// The values the server kept in app_state by key: the books' in the finance tables, everything else in system_settings
// and the tables of db/stores/system.js
async function upsertStateValue(appConfig, key, value, options = {}) {
  if (financeStore.FINANCE_STATE_KEYS.has(key)) return financeStore.setStateValue(appConfig, key, value, options);
  return systemStore.setStateValue(appConfig, key, value);
}

/** The value of [key] in the old shape of an app_state record ({ key, value }; no "updated", so no version either). */
async function getStateRecord(appConfig, key) {
  if (financeStore.FINANCE_STATE_KEYS.has(key)) {
    const value = await financeStore.getStateValue(appConfig, key);
    return key === 'settings' && value === null ? null : { key, value };
  }
  const value = await systemStore.getStateValue(appConfig, key);
  return value === systemStore.MISSING ? null : { key, value };
}

async function getStateValue(appConfig, key, fallback = null) {
  const record = await getStateRecord(appConfig, key);
  return record ? record.value : fallback;
}

async function ensureStateDefaults(appConfig) {
  // The fee settings are kept by the books (context.js writes them at every start); donations start as the empty map
  const defaults = new Map([
    ['system', DEFAULT_SYSTEM_STATE]
  ]);

  for (const [key, value] of defaults.entries()) {
    const existing = await getStateRecord(appConfig, key);
    if (!existing) {
      await upsertStateValue(appConfig, key, value);
    }
  }
}








// The books live in the finance_* tables (backend/db/stores/finance.js); these are the functions the server always
// called, answering exactly as before.
const financeStore = require('./db/stores/finance');
const eventsStore = require('./db/stores/events');
const mentoringStore = require('./db/stores/mentoring');
const systemStore = require('./db/stores/system');
const accountsStore = require('./db/stores/accounts');
const { ensureUsersSchema } = require('./db/upgrade/accounts');
const { upgradeDatabase, noteFallback } = require('./db/upgrade');
const schemaApply = require('./db/schemaApply');
const { newCollections } = require('./db/upgrade');

/** { settings, resets, resetLog, schedule, log, stored }: see feeState.js. */
const getFeeState = (appConfig) => financeStore.getFeeState(appConfig);

/**
 * The days the fee accounts were started afresh, with the log of who set or took back which (feeReset.js). Kept
 * apart from the fee settings; only the confirmed admin calls in routes/finance.js write it.
 */
async function getFeeResetState(appConfig) {
  const state = await getFeeState(appConfig);
  return { resets: state.resets, log: state.resetLog };
}

async function getFeeResets(appConfig) {
  return (await getFeeState(appConfig)).resets;
}

const updateFeeResetState = (appConfig, change) => financeStore.updateFeeResetState(appConfig, change);
const updateFeeSchedule = (appConfig, change) => financeStore.updateFeeSchedule(appConfig, change);
const saveSettings = (appConfig, value, actor) => financeStore.saveSettings(appConfig, value, actor);

/** Thrown when the database could not be upgraded: the server hands the instance to the previous backend. */
class UpgradeNotDone extends Error {
  constructor(outcome) {
    super(outcome.status === 'waiting' ? outcome.report?.reason : `The database upgrade did not get through: ${outcome.error?.message || 'unknown error'}`);
    this.name = 'UpgradeNotDone';
    this.permanent = true;
    this.outcome = outcome;
  }
}

async function ensurePocketBaseSchema(appConfig, { onUpgrading } = {}) {
  // An instance from before the new structure is upgraded first; if that does not get through nothing else is touched
  const outcome = await upgradeDatabase(appConfig, { onUpgrading });
  if (outcome.status === 'failed' || outcome.status === 'waiting') throw new UpgradeNotDone(outcome);
  if (outcome.status === 'upgraded') console.log(`[Upgrade] The database has the new structure (backup: ${outcome.report?.backup?.name})`);
  for (const problem of await ensureUsersSchema(appConfig)) console.warn(`[Schema] ${problem} - left as it is`);
  const problems = await schemaApply.ensureCollections(appConfig, newCollections());
  for (const problem of problems) console.warn(`[Schema] ${problem} - left as it is`);
  await schemaApply.applyViews(appConfig);
  await ensureStateDefaults(appConfig);
  await grantNewPermission(appConfig, 'manage_songbook', 'songbookPermissionMigrated', 'manage the songbook');
  await grantNewPermission(appConfig, 'manage_prayers', 'prayersPermissionMigrated', 'moderate prayer requests');
  await grantNewPermission(appConfig, 'manage_media', 'mediaPermissionMigrated', 'manage media folders');
}

/**
 * Installations from before a permission existed have nobody with it (new setups give it to the owner's Admin
 * group). Once: if no group has it, the owner's groups with manage_events (else all of them) get it.
 */
async function grantNewPermission(appConfig, permission, flag, what) {
  const system = await getStateValue(appConfig, 'system', DEFAULT_SYSTEM_STATE);
  if (system?.[flag]) return;
  const groups = await listGroupRecords(appConfig);
  if (!groups.some((g) => g.permissions.includes(permission))) {
    const ownerUid = system?.ownerUid || system?.superAdminUid;
    const owner = ownerUid ? await getUserRecord(appConfig, ownerUid).catch(() => null) : null;
    const ownerGroupIds = new Set((Array.isArray(owner?.groups) ? owner.groups : []).map((g) => (typeof g === 'object' && g ? g.id || g.name : String(g))));
    const ownerGroups = groups.filter((g) => ownerGroupIds.has(g.id) || ownerGroupIds.has(g.name));
    const targets = ownerGroups.some((g) => g.permissions.includes('manage_events'))
      ? ownerGroups.filter((g) => g.permissions.includes('manage_events'))
      : ownerGroups;
    for (const group of targets) {
      await updateGroupRecord(appConfig, group.id, { permissions: [...group.permissions, permission] });
      console.log(`[Migration] Group "${group.name}" may now ${what}`);
    }
  }
  await upsertStateValue(appConfig, 'system', { ...system, [flag]: true });
}

async function verifyUserToken(token) {
  const payload = decodeTokenPayload(token);
  if (!payload?.id) {
    throw new Error('Invalid token payload');
  }

  const userRecord = await pocketBaseRequest(`/api/collections/users/records/${encodeURIComponent(payload.id)}`, {
    token
  });

  return toPublicUser(accountsStore.decode(userRecord));
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

  const created = await accountsStore.createUserRecord(appConfig, {
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
  }, { token: superuserToken || undefined });

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
      publicUser = toPublicUser(accountsStore.decode(auth.record));
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
  const normalizedEmail = String(newEmail || '').trim();
  const normalizedPassword = String(newPassword || '');
  const patched = await accountsStore.updateUserRecord(appConfig, uid, {
    email: normalizedEmail,
    password: normalizedPassword,
    passwordConfirm: normalizedPassword,
    isClaimed: true
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
    user: toPublicUser(accountsStore.decode(auth.record))
  };
}

/**
 * A member changes their own password: the old one is checked by signing in with it, the change is made by the server
 * (a member's token may not change their account record, see ensureUsersSchema in db/upgrade/accounts.js).
 */
async function updateOwnPassword(appConfig, email, userId, oldPassword, password) {
  try {
    await loginUser(email, oldPassword);
  } catch (error) {
    // Only a sign-in that is turned down means a wrong password; a database that does not answer is an error
    if (error?.status >= 400 && error.status < 500) throw Object.assign(new Error('The password is not correct.'), { status: 400 });
    throw error;
  }
  await adminResetUserPassword(appConfig, userId, password);
}

function adminResetUserPassword(appConfig, uid, newPassword) {
  return accountsStore.updateUserRecord(appConfig, uid, { password: newPassword, passwordConfirm: newPassword });
}

// Accounts in their old shape (backend/db/stores/accounts.js)
const getUserRecord = (appConfig, uid) => accountsStore.getUserRecord(appConfig, uid);
const listUserRecords = (appConfig) => accountsStore.listUserRecords(appConfig);
const updateUserRecord = (appConfig, uid, body) => accountsStore.updateUserRecord(appConfig, uid, body);
const deleteUserRecord = (appConfig, uid) => accountsStore.deleteUserRecord(appConfig, uid);

async function getOrCreateUserCalendarToken(appConfig, uid) {
  const user = await getUserRecord(appConfig, uid);
  if (!user) throw new Error('User not found');
  if (user.calendarToken && typeof user.calendarToken === 'string' && user.calendarToken.trim()) {
    return user.calendarToken.trim();
  }
  const newToken = crypto.randomBytes(24).toString('hex');
  await updateUserRecord(appConfig, uid, { calendarToken: newToken });
  return newToken;
}

async function regenerateUserCalendarToken(appConfig, uid) {
  const user = await getUserRecord(appConfig, uid);
  if (!user) throw new Error('User not found');
  const newToken = crypto.randomBytes(24).toString('hex');
  await updateUserRecord(appConfig, uid, { calendarToken: newToken });
  return newToken;
}

async function findUserByCalendarToken(appConfig, token) {
  if (!token || typeof token !== 'string') return null;
  const clean = token.trim();
  if (!clean) return null;
  const users = await accountsStore.listUserRecords(appConfig, pbFilterEquals('calendarToken', clean));
  return users && users.length > 0 ? users[0] : null;
}



const getPeopleRecord = (appConfig, personKey) => financeStore.getPeopleRecord(appConfig, personKey);
const listPeopleRecords = (appConfig, query = {}) => financeStore.listPeopleRecords(appConfig, query);
const upsertPeopleRecord = (appConfig, personKey, value, expectedUpdated = null) => financeStore.upsertPeopleRecord(appConfig, personKey, value, expectedUpdated);

/**
 * Deletes a member: the login goes too - unless another active entry still uses it (a duplicate entry of the same
 * member) or it is the owner's - and only the bookkeeping record stays (name and payments).
 */
function removePeopleRecord(appConfig, personKey) {
  return financeStore.removePeopleRecord(appConfig, personKey, {
    deleteUser: async (uid) => {
      const linkedUser = await getUserRecord(appConfig, uid).catch(() => null);
      if (linkedUser && linkedUser.owner !== true && linkedUser.superAdmin !== true) await accountsStore.deleteUserRecord(appConfig, uid);
    }
  });
}

const pruneDeletedPeopleRecords = (appConfig) => financeStore.pruneDeletedPeopleRecords(appConfig);
const listExpenseRecords = (appConfig) => financeStore.listExpenseRecords(appConfig);
const syncExpenseRecords = (appConfig, value, options) => financeStore.syncExpenseRecords(appConfig, value, options);
const getRequestRecord = (appConfig, requestKey) => financeStore.getRequestRecord(appConfig, requestKey);
const listRequestRecords = (appConfig, query = {}) => financeStore.listRequestRecords(appConfig, query);
const upsertRequestRecord = (appConfig, requestKey, value) => financeStore.upsertRequestRecord(appConfig, requestKey, value);

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
    // Accounts keep their groups by id, events their target groups by name (eventAccess.js)
    groupIds: matchingGroups.map((g) => g.id).filter(Boolean),
    groupNames: matchingGroups.map((g) => g.name).filter(Boolean),
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

// Groups in user_groups (backend/db/stores/accounts.js)
const listGroupRecords = (appConfig = null) => accountsStore.listGroupRecords(appConfig);
const createGroupRecord = (appConfig, group) => accountsStore.createGroupRecord(appConfig, group);
const updateGroupRecord = (appConfig, id, group) => accountsStore.updateGroupRecord(appConfig, id, group);

const SYSTEM_PERMISSIONS = [
  { id: 'view_finances', name: 'Finance management (read only)', description: 'Allows viewing balances, history, transactions and reports without editing rights' },
  { id: 'manage_finances', name: 'Finance management (full access)', description: 'Allows recording, editing, booking and deleting payments, donations, expenses and standing orders' },
  { id: 'manage_registration_code', name: 'Manage registration code', description: 'Allows viewing, copying and regenerating the registration code for new members' },
  { id: 'access_ai', name: 'Use AI support', description: 'Allows access to and use of the built-in AI assistant' },
  { id: 'manage_mentoring', name: 'Mentoring management', description: 'Allows leaders to review, approve or reject mentor applications (no access to private chats)' },
  { id: 'manage_events', name: 'Event & duty roster management', description: 'Allows creating recurring appointments and full management of all events and duties' },
  { id: 'manage_songbook', name: 'Manage songbook', description: 'Allows adding, editing and deleting songs in the songbook' },
  { id: 'manage_prayers', name: 'Moderate prayer requests', description: 'Allows removing unsuitable prayer requests (anonymous ones stay anonymous)' },
  { id: 'manage_media', name: 'Extended media rights', description: 'Allows deciding which groups may read, write or not see a media folder; sees every folder, its files only where the rights allow' }
];

const deleteGroupRecord = (appConfig, id) => accountsStore.deleteGroupRecord(appConfig, id);

// Mentors
// Mentoring: db/stores/mentoring.js keeps the records (in the old tables' shape); texts are encrypted here
async function listMentorRecords(appConfig, filter = '', sort = '') {
  const records = await mentoringStore.mentors.list(appConfig, filter, sort);
  return records.sort((a, b) => (b.created || b.id || '').localeCompare(a.created || a.id || ''));
}

const getMentorRecord = (appConfig, id) => mentoringStore.mentors.get(appConfig, id);
const getMentorByUserId = (appConfig, userId) => mentoringStore.mentors.first(appConfig, pbFilterEquals('user', userId));
const createMentorRecord = (appConfig, data) => mentoringStore.mentors.create(appConfig, { created: new Date().toISOString(), ...data });
const updateMentorRecord = (appConfig, id, data) => mentoringStore.mentors.update(appConfig, id, data);
const deleteMentorRecord = (appConfig, id) => mentoringStore.mentors.remove(appConfig, id);

// Mentoring Threads
async function listAllMentoringThreads(appConfig, filter = '') {
  const records = await mentoringStore.threads.list(appConfig, filter);
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
  const record = await mentoringStore.threads.get(appConfig, id);
  if (record && record.last_message) {
    record.last_message = decryptMentoringText(record.last_message, record.id);
  }
  return record;
}

async function createMentoringThread(appConfig, data) {
  const now = new Date().toISOString();
  const rawLastMessage = data.last_message ? String(data.last_message).trim() : '';
  const record = await mentoringStore.threads.create(appConfig, { created: now, updated: now, ...data, last_message: '' });
  if (rawLastMessage && record && record.id) {
    // The key of a conversation comes from its id: the beginning of the first message is encrypted once it has one
    const encryptedLastMessage = encryptMentoringText(rawLastMessage, record.id);
    await mentoringStore.threads.update(appConfig, record.id, { last_message: encryptedLastMessage }).catch(() => {});
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
  const updated = await mentoringStore.threads.update(appConfig, id, payload);
  if (updated && rawLastMessage !== undefined) {
    updated.last_message = rawLastMessage;
  }
  return updated;
}

// Mentoring Messages
async function listMentoringMessages(appConfig, threadId) {
  const records = await mentoringStore.messages.list(appConfig, pbFilterEquals('thread', threadId));
  return records
    .map(r => ({
      ...r,
      text: decryptMentoringText(r.text, threadId)
    }))
    .sort((a, b) => (a.created || a.id || '').localeCompare(b.created || b.id || ''));
}

// Unread count and newest message of a thread for the thread list: two single-record queries instead of
// loading and decrypting the whole conversation (the list is requested on every data update).
async function getMentoringThreadSummary(appConfig, threadId, otherRole) {
  const thread = pbFilterEquals('thread', threadId);
  const [unreadCount, last] = await Promise.all([
    mentoringStore.messages.count(appConfig, `${thread} && ${pbFilterEquals('sender_role', otherRole)} && read = false`),
    mentoringStore.messages.first(appConfig, thread, '-created')
  ]);
  return {
    unreadCount,
    lastMessage: last ? { ...last, text: decryptMentoringText(last.text, threadId) } : null
  };
}

async function createMentoringMessage(appConfig, data) {
  const rawText = data.text ? String(data.text) : '';
  const threadId = data.thread || '';
  const encryptedText = encryptMentoringText(rawText, threadId);
  const record = await mentoringStore.messages.create(appConfig, {
    created: new Date().toISOString(),
    ...data,
    text: encryptedText
  });
  return {
    ...record,
    text: rawText
  };
}

async function markMentoringMessagesRead(appConfig, threadId, currentRole) {
  const otherRole = currentRole === 'mentor' ? 'mentee' : 'mentor';
  const filter = `${pbFilterEquals('thread', threadId)} && ${pbFilterEquals('sender_role', otherRole)} && read = false`;
  const unreadMessages = await mentoringStore.messages.list(appConfig, filter);
  // Side by side (one after another took a round trip per message when a long conversation is opened)
  await Promise.all(unreadMessages.map((msg) => mentoringStore.messages.update(appConfig, msg.id, { read: true }).catch(() => {})));
}

// Events, sign-ups, guests and duties: db/stores/events.js
const {
  listEvents, getEventRecord, createEventRecord, updateEventRecord, deleteEventRecord, findEventByPublicToken,
  listEventRegistrations, getEventRegistration, upsertEventRegistration, deleteEventRegistration,
  listEventGuests, getEventGuest, findEventGuestByKey, createEventGuest, updateEventGuest, deleteEventGuest,
  listEventDuties, getEventDuty, createEventDuty, updateEventDuty, saveDutyReminded, deleteEventDuty
} = eventsStore;

// Push devices: db/stores/system.js (web push subscriptions and Firebase tokens in system_push_devices)
async function getPushSubscriptionByEndpoint(appConfig, endpoint) {
  return systemStore.webPush.first(appConfig, pbFilterEquals('endpoint', endpoint));
}

async function upsertPushSubscription(appConfig, userId, subscription, userAgent = '', installed = false) {
  const existing = await getPushSubscriptionByEndpoint(appConfig, subscription.endpoint);
  const payload = {
    user: String(userId),
    endpoint: String(subscription.endpoint),
    p256dh: String(subscription.keys?.p256dh || ''),
    auth: String(subscription.keys?.auth || ''),
    userAgent: String(userAgent || ''),
    installed: installed === true,
    created: new Date().toISOString()
  };
  if (existing) {
    return systemStore.webPush.update(appConfig, existing.id, payload);
  }
  return systemStore.webPush.create(appConfig, payload);
}

async function deletePushSubscription(appConfig, endpoint) {
  const existing = await getPushSubscriptionByEndpoint(appConfig, endpoint);
  if (existing) {
    return systemStore.webPush.remove(appConfig, existing.id);
  }
  return null;
}

const listPushSubscriptionsOf = (appConfig, userId) => systemStore.webPush.list(appConfig, pbFilterEquals('user', userId));
const removePushSubscription = (appConfig, id) => systemStore.webPush.remove(appConfig, id);

async function getFcmTokenRecord(appConfig, token) {
  return systemStore.fcmTokens.first(appConfig, pbFilterEquals('token', token));
}

async function upsertFcmToken(appConfig, userId, token, platform = 'android') {
  const existing = await getFcmTokenRecord(appConfig, token);
  const now = new Date().toISOString();
  // A token identifies one app installation, so re-registering moves it to the current user
  const payload = {
    user: String(userId),
    token: String(token),
    platform: String(platform || 'android'),
    updated: now
  };
  if (existing) {
    return systemStore.fcmTokens.update(appConfig, existing.id, payload);
  }
  return systemStore.fcmTokens.create(appConfig, { ...payload, created: now });
}

async function deleteFcmToken(appConfig, token, userId = null) {
  const existing = await getFcmTokenRecord(appConfig, token);
  if (existing && (!userId || existing.user === String(userId))) {
    return systemStore.fcmTokens.remove(appConfig, existing.id);
  }
  return null;
}

const listFcmTokensOf = (appConfig, userId) => systemStore.fcmTokens.list(appConfig, pbFilterEquals('user', userId));
const removeFcmToken = (appConfig, id) => systemStore.fcmTokens.remove(appConfig, id);

module.exports = {
  UpgradeNotDone,
  noteFallback,
  financeStore,
  withSecureInviteCode,
  ownerClaim,
  invalidateReadCache,
  getPushSubscriptionByEndpoint,
  upsertPushSubscription,
  deletePushSubscription,
  getFcmTokenRecord,
  upsertFcmToken,
  deleteFcmToken,
  listPushSubscriptionsOf,
  removePushSubscription,
  listFcmTokensOf,
  removeFcmToken,
  listAllRecords,
  getFirstRecord,
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
  createGroupRecord,
  updateGroupRecord,
  deleteGroupRecord,
  resolveUserPermissions,
  listPeopleRecords,
  getPeopleRecord,
  upsertPeopleRecord,
  getFeeState,
  getFeeResetState,
  getFeeResets,
  updateFeeResetState,
  updateFeeSchedule,
  saveSettings,
  queueRecordWrite,
  isOutdatedVersion,
  removePeopleRecord,
  isDeletedPerson,
  pruneDeletedPeopleRecords,
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
  getMentoringThreadSummary,
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
  deleteEventRegistration,
  findEventByPublicToken,
  listEventGuests,
  getEventGuest,
  findEventGuestByKey,
  createEventGuest,
  updateEventGuest,
  deleteEventGuest,
  listEventDuties,
  getEventDuty,
  createEventDuty,
  updateEventDuty,
  saveDutyReminded,
  deleteEventDuty,
  eventsStore,
  pbFilterEquals,
  getOrCreateUserCalendarToken,
  regenerateUserCalendarToken,
  findUserByCalendarToken
};
