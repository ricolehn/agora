// The data paths of the old API (/api/db: settings, system, donations, expenses, users, people, requests): who may
// read and write which, and what a write does to the records.
const { context } = require('./context');
const { conflict, forbidden, invalid, notFound, unauthorized } = require('./httpError');
const { isAdmin, can, permissionFlags, resolveUserPermissions } = require('./permissions');
const { withDecisionTimestamp, isExpiredRequest } = require('./requestRetention');
const { mergeNotificationSettings } = require('./notificationPrefs');
const { REQUEST_TYPE_LABELS, notifyRequestDecision } = require('./requestMessages');
const { settingsOn } = require('./feeState');
const { toDateStr } = require('./utils/date');
const {
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_STATE,
  financeStore,
  normalizeDataPath,
  sanitizeSelfUserWrite,
  getStateRecord,
  getStateValue,
  upsertStateValue,
  updateSystemState,
  getFeeState,
  saveSettings,
  getUserRecord,
  listUserRecords,
  updateUserRecord,
  isPlaceholderEmail,
  listGroupRecords,
  listPeopleRecords,
  getPeopleRecord,
  upsertPeopleRecord,
  removePeopleRecord,
  isDeletedPerson,
  listExpenseRecords,
  syncExpenseRecords,
  listRequestRecords,
  getRequestRecord,
  upsertRequestRecord,
  queueRecordWrite
} = require('./pocketbase');
const { fullName } = require('./utils/names');

function isOwnFullNameMatch(user, name) {
  if (!user) return false;
  const userFull = fullName(user).trim().toLowerCase();
  const targetName = String(name || '').trim().toLowerCase();
  if (userFull && userFull === targetName) return true;

  const userParts = [user.firstName, user.lastName].filter(Boolean).map((s) => String(s).trim().toLowerCase());
  const targetParts = targetName.split(/\s+/).filter(Boolean);
  if (userParts.length > 0 && userParts.length === targetParts.length) {
    if (userParts.every((part) => targetParts.includes(part))) return true;
  }
  return false;
}

function objectFromRecords(records, keyField, valueMapper) {
  const acc = {};
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    acc[record[keyField]] = valueMapper(record);
  }
  return acc;
}

async function readLogicalPath(targetPath, query, user) {
  const normalizedPath = normalizeDataPath(targetPath);
  const [root, id] = normalizedPath.split('/');

  if (!user) {
    throw unauthorized('Unauthorized');
  }

  if (root === 'settings' && !id) {
    // With the fees of this month, whatever was stored last: a change of the fees may count from a month that has
    // come since (feeState.js)
    const [record, fees] = await Promise.all([getStateRecord(context.appConfig, 'settings'), getFeeState(context.appConfig)]);
    return { value: settingsOn(fees, toDateStr(new Date())), version: record?.updated || null };
  }

  if (root === 'system' && !id) {
    if (!isAdmin(user)) {
      throw forbidden('Admin access required');
    }
    const record = await getStateRecord(context.appConfig, 'system');
    const val = record?.value ? { ...record.value } : { ...DEFAULT_SYSTEM_STATE };
    if (!can(user, 'manage_registration_code')) {
      delete val.inviteCode;
    }
    return { value: val, version: record?.updated || null };
  }

  if (root === 'system' && id === 'inviteCode') {
    if (!can(user, 'manage_registration_code')) {
      throw forbidden('Registration code management rights required');
    }
    const record = await getStateRecord(context.appConfig, 'system');
    return { value: record?.value?.inviteCode || '', version: record?.updated || null };
  }

  if (root === 'donations' || root === 'expenses') {
    if (!can(user, 'view_finances')) {
      throw forbidden('Financial access required');
    }
    // The version of the whole list: a save that sends it back is refused if the list changed meanwhile (409)
    if (root === 'expenses') {
      const records = await listExpenseRecords(context.appConfig);
      return {
        value: objectFromRecords(records, 'expenseKey', (record) => record.data),
        version: await financeStore.expensesVersion(context.appConfig)
      };
    }
    const record = await getStateRecord(context.appConfig, root);
    return { value: record?.value || {}, version: await financeStore.donationsVersion(context.appConfig) };
  }

  if (root === 'users') {
    let allGroups = [];
    try {
      allGroups = await listGroupRecords(context.appConfig);
    } catch { /* ignore */ }

    if (id) {
      if (!isAdmin(user) && id !== user.uid) {
        throw forbidden('Forbidden');
      }
      const record = await getUserRecord(context.appConfig, id);
      return { value: record ? toUserValue(record, allGroups) : null, version: record?.updated || null };
    }

    if (!isAdmin(user)) {
      const record = await getUserRecord(context.appConfig, user.uid);
      return {
        value: record ? { [user.uid]: toUserValue(record, allGroups) } : {},
        version: record?.updated || null
      };
    }

    const records = await listUserRecords(context.appConfig);
    return {
      value: objectFromRecords(records, 'id', (record) => toUserValue(record, allGroups)),
      version: null
    };
  }

  if (root === 'people') {
    if (id) {
      const record = await getPeopleRecord(context.appConfig, id);
      const value = record?.data || null;
      // By name only while the record is not linked to an account yet (the name alone proves nothing)
      const unlinkedNameMatch = !value?.uid && !record?.uid && !isDeletedPerson(record) && isOwnFullNameMatch(user, value?.name || record?.name);
      if (value && !can(user, 'view_finances') && value.uid !== user.uid && !unlinkedNameMatch) {
        throw forbidden('Forbidden');
      }
      return { value, version: record?.updated || null };
    }

    // Only read and sent (shared: no copy of them all)
    let people = await listPeopleRecords(context.appConfig, query, { shared: true });
    if (!can(user, 'view_finances')) {
      people = people.filter((record) => record.uid === user.uid || (record.data && record.data.uid === user.uid)
        || (!record.uid && !record.data?.uid && !isDeletedPerson(record) && isOwnFullNameMatch(user, record.name || record.data?.name)));
    }
    return {
      value: objectFromRecords(people, 'personKey', (record) => record.data),
      version: null
    };
  }

  if (root === 'requests') {
    if (id) {
      const record = await getRequestRecord(context.appConfig, id);
      const value = record?.data || null;
      if (value && !can(user, 'view_finances') && value.userId !== user.uid && record?.userId !== user.uid) {
        throw forbidden('Forbidden');
      }
      return { value, version: record?.updated || null };
    }

    // Approved / rejected requests are only shown for 30 days (the daily cleanup deletes them)
    let requests = (await listRequestRecords(context.appConfig, query)).filter((record) => !isExpiredRequest(record));
    if (!can(user, 'view_finances')) {
      // Also by the own person record: approving or rejecting used to overwrite userId with the treasurer's id
      const ownPeople = new Set((await listPeopleRecords(context.appConfig, {}, { shared: true }))
        .filter((record) => record.uid === user.uid || record.data?.uid === user.uid)
        .flatMap((record) => [record.personKey, record.data?.id].filter(Boolean).map(String)));
      requests = requests.filter((record) => record.userId === user.uid || record.data?.userId === user.uid
        || ownPeople.has(String(record.data?.personId || record.personId || '')));
    }
    return {
      value: objectFromRecords(requests, 'requestKey', (record) => record.data),
      version: null
    };
  }

  throw notFound('Unknown path');
}

function toUserValue(record, allGroups) {
  const isOwner = record.owner === true || record.superAdmin === true;
  const isPlaceholder = isPlaceholderEmail(record.email);
  const isClaimed = !isPlaceholder;
  const rawGroups = Array.isArray(record.groups) ? record.groups : (record.groups ? [String(record.groups)] : []);

  const { permissions } = resolveUserPermissions(rawGroups, allGroups);

  return {
    firstName: record.firstName || '',
    lastName: record.lastName || '',
    name: fullName(record),
    email: isPlaceholder ? '' : (record.email || ''),
    rawEmail: record.email || '',
    admin: record.admin === true || isOwner,
    owner: isOwner,
    superAdmin: isOwner,
    pays: record.pays !== false,
    groups: rawGroups,
    permissions,
    ...permissionFlags({ permissions }),
    emailNotifications: record.emailNotifications !== false,
    language: record.language || '',
    isClaimed,
    uid: record.id
  };
}

/**
 * Whom a member's own request is about, as the app files it: their person record (its id, the one an approval
 * books to, and its name), else - a member without one - their account.
 */
async function ownRequestPerson(user) {
  const own = (await listPeopleRecords(context.appConfig, {}, { shared: true })).find((record) => !record.isDeleted && record.data?.uid === user.uid);
  return {
    personId: String(own?.data?.id || user.uid),
    personName: own?.data?.name || user.name || user.email || ''
  };
}

async function writeLogicalPath(targetPath, value, user, method = 'set', options = {}) {
  const normalizedPath = normalizeDataPath(targetPath);
  const [root, id, nested] = normalizedPath.split('/');

  if (!user) {
    throw unauthorized('Unauthorized');
  }

  if (root === 'settings' && !id) {
    if (!isAdmin(user)) throw forbidden('Admin access required');
    // Apps without the fees over time write their fees here: other fees than those of this month count from this
    // month on (feeState.js). The web app changes the fees with the month they count from (routes/finance.js)
    const actor = { by: String(user.uid || user.id || ''), byName: fullName(user) };
    const saved = await saveSettings(context.appConfig, value || DEFAULT_SETTINGS, actor);
    if (saved.feesChangedFrom) console.log(`[Finance] Admin ${actor.by} set the fees from ${saved.feesChangedFrom} (saved with the fee settings)`);
    return;
  }

  if (root === 'system' && id === 'inviteCode' && !nested) {
    if (!can(user, 'manage_registration_code')) throw forbidden('Registration code management rights required');
    await updateSystemState(context.appConfig, (system) => ({ ...system, inviteCode: value }));
    return;
  }

  if ((root === 'donations' || root === 'expenses') && !id) {
    if (!can(user, 'manage_finances')) throw forbidden('Finance management rights required');
    // With the version it was read with, a list that changed meanwhile is refused (409) instead of overwritten
    const expectedVersion = typeof options.version === 'string' && options.version ? options.version : undefined;
    if (root === 'expenses') {
      await syncExpenseRecords(context.appConfig, value || {}, { expectedVersion });
      return;
    }
    await upsertStateValue(context.appConfig, root, value || {}, { expectedVersion });
    return;
  }

  if (root === 'users' && id) {
    if (id !== user.uid && !isAdmin(user)) {
      throw forbidden('Forbidden');
    }

    const existing = await getUserRecord(context.appConfig, id);
    if (!existing) {
      throw notFound('User not found');
    }

    const system = await getStateValue(context.appConfig, 'system', DEFAULT_SYSTEM_STATE);
    const ownerUid = system?.ownerUid || system?.superAdminUid || null;
    const isTargetOwner = id === ownerUid || existing.owner === true || existing.superAdmin === true;

    // Like the admin routes: only the owner changes the owner's rights - also groups (they carry the permissions)
    if (isTargetOwner && !user.owner && id !== user.uid) {
      if (value && typeof value === 'object' && ['admin', 'owner', 'pays', 'groups'].some((field) => value[field] !== undefined)) {
        throw forbidden('Forbidden: Cannot modify owner permissions');
      }
    }

    let updates = {};
    if (isAdmin(user) && id !== user.uid && value && typeof value === 'object') {
      if (typeof value.admin === 'boolean') updates.admin = isTargetOwner ? true : value.admin;
      if (typeof value.pays === 'boolean') updates.pays = value.pays;
      if (Array.isArray(value.groups)) updates.groups = value.groups;
      if (user.owner && typeof value.owner === 'boolean') {
        updates.owner = value.owner;
        updates.superAdmin = value.owner;
      }
    } else {
      updates = sanitizeSelfUserWrite(value);
    }

    if (method === 'set' && !isAdmin(user)) {
      updates = sanitizeSelfUserWrite(value || {});
    }

    if (value && typeof value.emailNotifications === 'boolean') {
      updates.emailNotifications = value.emailNotifications;
    }
    // Older apps send only the flat push keys: keep the channels and e-mail choices that are already stored
    if (updates.notificationSettings) {
      updates.notificationSettings = mergeNotificationSettings(existing, updates.notificationSettings);
      updates.emailNotifications = updates.notificationSettings.channels.push || updates.notificationSettings.channels.email;
    }

    if (typeof value?.firstName === 'string' && isAdmin(user) && id !== user.uid) updates.firstName = value.firstName.trim();
    if (typeof value?.lastName === 'string' && isAdmin(user) && id !== user.uid) updates.lastName = value.lastName.trim();
    if ((updates.firstName || updates.lastName) && !updates.name) {
      updates.name = `${updates.firstName || existing.firstName || ''} ${updates.lastName || existing.lastName || ''}`.trim();
    }

    await updateUserRecord(context.appConfig, id, updates);
    return;
  }

  if (root === 'people' && id) {
    const existing = await getPeopleRecord(context.appConfig, id);
    const existingValue = existing?.data || null;
    if (!can(user, 'manage_finances')) {
      const requestedUid = value && typeof value === 'object' ? value.uid : undefined;
      const onlyUidUpdate = value && typeof value === 'object' && Object.keys(value).every((key) => key === 'uid');
      const isAllowedLink = existingValue && !isDeletedPerson(existing) && onlyUidUpdate && requestedUid === user.uid && (!existingValue.uid || existingValue.uid === user.uid) && isOwnFullNameMatch(user, existingValue.name || existing?.name);
      if (!isAllowedLink) {
        throw forbidden('Finance management rights required');
      }
    }
    // Linking only ever adds the uid to the existing record (a plain set would replace it and drop its payments)
    const nextValue = !can(user, 'manage_finances')
      ? { ...existingValue, uid: user.uid }
      : method === 'patch' && existingValue && value && typeof value === 'object'
        ? { ...existingValue, ...value }
        : value;
    await upsertPeopleRecord(context.appConfig, id, nextValue);
    return;
  }

  if (root === 'requests' && id) {
    if (!value || typeof value !== 'object') {
      throw invalid('Invalid request payload');
    }
    // A new request belongs to its author; a partial update (approve / reject) must not take it over
    if (!value.userId && method !== 'patch') {
      value.userId = user.uid;
    }
    const canManageRequests = can(user, 'manage_finances');
    if (!canManageRequests) {
      if (method !== 'set' || String(value.userId) !== String(user.uid)) {
        throw forbidden('Finance management rights required');
      }
    }
    const existing = await getRequestRecord(context.appConfig, id);
    if (existing && existing.data && !canManageRequests && String(existing.data.userId || existing.userId) !== String(user.uid)) {
      throw forbidden('Finance management rights required');
    }
    const mergedValue = method === 'patch' && existing?.data && value && typeof value === 'object'
      ? { ...existing.data, ...value }
      : value;
    // Remember when the request was approved or rejected (starts the 30-day retention)
    const nextValue = withDecisionTimestamp(existing?.data, mergedValue);
    // The author of a request never changes, whoever decides on it
    const author = existing?.data?.userId || existing?.userId;
    if (author) nextValue.userId = author;
    if (!nextValue.userId) {
      nextValue.userId = user.uid;
    }
    if (!canManageRequests && String(nextValue.userId) !== String(user.uid)) {
      throw forbidden('Finance management rights required');
    }
    // Only the known kinds of request (the type is shown to treasurers)
    if (!Object.hasOwn(REQUEST_TYPE_LABELS, nextValue.type)) {
      throw invalid('Unknown kind of request');
    }
    // Members file requests, only treasurers decide on them - and only for themselves: whose record a request books
    // to and the name the treasurers see come from the member's own record, whatever was sent (a request naming
    // another member used to change that member's record once approved, under that member's name)
    if (!canManageRequests) {
      nextValue.status = existing?.data?.status || 'pending';
      for (const key of ['decidedAt', 'rejectionReason']) {
        if (existing?.data?.[key]) nextValue[key] = existing.data[key];
        else delete nextValue[key];
      }
      Object.assign(nextValue, await ownRequestPerson(user));
    }
    // A decision stands: a second treasurer or an outdated screen must not reject a request that was approved (and
    // booked), or approve a rejected one. Checked and written in the request's write queue: an approval and a
    // rejection at the same moment cannot both pass.
    const before = await queueRecordWrite(`requests:${id}`, async () => {
      const current = (await getRequestRecord(context.appConfig, id))?.data?.status || 'pending';
      if ((current === 'approved' || current === 'rejected') && nextValue.status !== current) {
        throw conflict('This request was already decided.');
      }
      await upsertRequestRecord(context.appConfig, id, nextValue);
      return current;
    });
    // Tell the author when a treasurer approved or rejected the request
    if (before === 'pending' && (nextValue.status === 'approved' || nextValue.status === 'rejected')) {
      notifyRequestDecision(nextValue, options.origin).catch((err) => console.warn('[Notify] request decision:', err.message));
    }
    return;
  }

  throw notFound('Unknown path');
}

async function removeLogicalPath(targetPath, user) {
  const normalizedPath = normalizeDataPath(targetPath);
  const [root, id] = normalizedPath.split('/');
  if (!user) throw unauthorized('Unauthorized');
  if (root === 'people' && id) {
    if (!isAdmin(user)) throw forbidden('Admin access required');
    await removePeopleRecord(context.appConfig, id);
    return;
  }
  throw notFound('Unknown path');
}

// Default finance record for a member who has none yet
function newPersonRecord(uid, name, memberSince, pays = true) {
  return {
    id: uid,
    uid,
    name,
    status: 'vollverdiener',
    memberSince,
    originalMemberSince: memberSince,
    totalPaid: 0,
    pays,
    standingOrders: [],
    statusHistory: [{ status: 'vollverdiener', startDate: memberSince }]
  };
}

module.exports = { isOwnFullNameMatch, readLogicalPath, writeLogicalPath, removeLogicalPath, newPersonRecord };
