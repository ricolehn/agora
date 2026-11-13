// Accounts (users, PocketBase's login table) and groups (user_groups) in the new structure. The server keeps calling
// the functions it always called (getUserRecord, listUserRecords, updateUserRecord, listGroupRecords, ...) and gets
// the raw records in their old shape (codecs/accounts.js).
const client = require('../client');
const codecs = require('../codecs/accounts');
const { usersGroupsField, table } = require('../tables');
const { queueRecordWrite } = require('../writeQueue');

const USERS = 'users';
const GROUPS = 'user_groups';
// Fields of a login PocketBase keeps itself; written as they come (e-mail address, password)
const AUTH_KEYS = ['email', 'emailVisibility', 'verified', 'password', 'passwordConfirm', 'oldPassword'];

/** What the codecs need to know: which groups exist, by id and by name. */
async function groupContext(appConfig) {
  const groups = await client.listAllRecords(table(GROUPS), '', appConfig);
  return { groupIds: new Set(groups.map((group) => group.id)), groupIdByName: new Map(groups.map((group) => [group.name, group.id])) };
}

const decode = (row) => codecs.decodeUser(row, usersGroupsField());

async function getUserRecord(appConfig, uid) {
  const token = await client.authenticateSuperuser(appConfig);
  const row = await client.pocketBaseRequest(`/api/collections/${USERS}/records/${encodeURIComponent(uid)}`, { token, allow404: true });
  return decode(row);
}

async function listUserRecords(appConfig, filter = '') {
  return (await client.listAllRecords(USERS, filter, appConfig)).map(decode);
}

/** The body PocketBase gets for [record] (old fields, also only some of them): columns, `original`, login fields. */
async function writeBody(appConfig, current, changes) {
  const merged = { ...(current || {}), ...changes };
  const { columns, original } = codecs.encodeUser(merged, await groupContext(appConfig), usersGroupsField());
  const body = { ...columns, original };
  for (const key of AUTH_KEYS) if (key in changes) body[key] = changes[key];
  return body;
}

/** Changes the account [uid] ([body]: old fields and login fields). Returns the record in its old shape. */
function updateUserRecord(appConfig, uid, body) {
  return queueRecordWrite(`users:${uid}`, async () => {
    const current = await getUserRecord(appConfig, uid);
    if (!current) throw Object.assign(new Error('User not found'), { status: 404 });
    return decode(await client.updateRecord(USERS, uid, await writeBody(appConfig, current, body || {}), appConfig));
  });
}

/** Creates an account from [body] in the old shape (registerUser). Returns the raw record in its old shape. */
async function createUserRecord(appConfig, body, { token } = {}) {
  const defaults = { name: '', avatar: '', firstName: '', lastName: '', admin: false, owner: false, superAdmin: false, pays: false, groups: [], emailNotifications: true, notificationSettings: null, language: '', timeZone: '', isClaimed: false, calendarToken: '' };
  const record = await client.pocketBaseRequest(`/api/collections/${USERS}/records`, {
    method: 'POST',
    token: token || await client.authenticateSuperuser(appConfig),
    body: await writeBody(appConfig, defaults, body)
  });
  return decode(record);
}

/** Deletes the account; what links to it keeps its id for the older apps (../links.js). */
async function deleteUserRecord(appConfig, uid) {
  if (typeof uid === 'string' && uid && await client.getRecord(USERS, uid, appConfig)) await require('../links').keepLinksTo(appConfig, USERS, uid);
  return client.deleteRecord(USERS, uid, appConfig);
}

// --- Groups ---

const groupOf = (row) => ({ id: row.id, ...codecs.group.decode(row) });

async function listGroupRecords(appConfig) {
  try {
    const rows = await client.listAllRecords(table(GROUPS), '', appConfig, '+name');
    return rows.map(groupOf).map((group) => ({ id: group.id, name: group.name || '', permissions: Array.isArray(group.permissions) ? group.permissions : [] }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } catch (err) {
    console.error('Failed to list group records:', err);
    return [];
  }
}

async function createGroupRecord(appConfig, { name, permissions = [] }) {
  const { columns, original } = codecs.group.encode({ name: String(name || '').trim(), permissions: Array.isArray(permissions) ? permissions : [] });
  const row = await client.createRecord(table(GROUPS), { ...columns, original }, appConfig);
  const group = groupOf(row);
  return { id: group.id, name: group.name || '', permissions: group.permissions };
}

async function updateGroupRecord(appConfig, id, { name, permissions }) {
  return queueRecordWrite(`groups:${id}`, async () => {
    const current = groupOf(await client.getRecord(table(GROUPS), id, appConfig) || { id });
    const next = { name: name !== undefined ? String(name).trim() : current.name, permissions: permissions !== undefined ? (Array.isArray(permissions) ? permissions : []) : current.permissions };
    const { columns, original } = codecs.group.encode(next);
    const group = groupOf(await client.updateRecord(table(GROUPS), id, { ...columns, original }, appConfig));
    return { id: group.id, name: group.name || '', permissions: group.permissions };
  });
}

/**
 * Deletes a group. The links of the accounts go with it; an account whose old list names the group (by id or name,
 * kept in `original`) loses that entry too - as the old function did.
 */
async function deleteGroupRecord(appConfig, id) {
  const existing = await client.getRecord(table(GROUPS), id, appConfig);
  const groupName = existing?.name || '';
  // Events and duties keep naming the group, as they always did (../links.js)
  if (existing) await require('../links').keepLinksTo(appConfig, GROUPS, id);
  await client.deleteRecord(table(GROUPS), id, appConfig);
  try {
    for (const user of await listUserRecords(appConfig)) {
      if (Array.isArray(user.groups) && (user.groups.includes(id) || (groupName && user.groups.includes(groupName)))) {
        await updateUserRecord(appConfig, user.id, { groups: user.groups.filter((g) => g !== id && g !== groupName) });
      }
    }
  } catch (err) {
    console.warn('[PocketBase] Failed to clean up user groups after group deletion:', err.message);
  }
  return true;
}

module.exports = {
  USERS,
  GROUPS,
  decode,
  groupContext,
  getUserRecord,
  listUserRecords,
  updateUserRecord,
  createUserRecord,
  deleteUserRecord,
  listGroupRecords,
  createGroupRecord,
  updateGroupRecord,
  deleteGroupRecord
};
