// The upgrade of accounts and groups: groups -> user_groups (same ids); users keeps its table (the session tokens
// belong to it) and is changed in place - before the switch only fields are added (groupLinks, original), so the
// previous backend can still serve it if the upgrade does not get through; the old fields go in the cleanup.
const { isDeepStrictEqual } = require('util');
const client = require('../client');
const codecs = require('../codecs/accounts');
const store = require('../stores/accounts');
const schema = require('../schema');
const { SERVER_ONLY_RULES, original } = require('../schema/fields');

const OLD_COLLECTIONS = ['groups'];
const NEW_COLLECTIONS = ['user_groups'];
const BUILDING_FIELDS = { usersGroupsField: 'groupLinks' };
// The fields of users that are worked out now (codecs/accounts.js) - removed in the cleanup
const REMOVED_USER_FIELDS = ['name', 'avatar', 'superAdmin', 'emailNotifications', 'isClaimed', 'groups'];

function newFindings() {
  return { groupsNamedOrAsObjects: [], groupsThatDoNotExist: [], ownerAndSuperAdminDiffer: [], nameDiffersFromFirstAndLast: [], emailNotificationsDifferFromSettings: [], claimedDiffersFromEmail: [], unknownPermissions: [] };
}

async function plan(appConfig) {
  const [groups, users] = await Promise.all([client.listAllRecords('groups', '', appConfig), client.listAllRecords('users', '', appConfig)]);
  const findings = newFindings();
  const ctx = { groupIds: new Set(groups.map((g) => g.id)), groupIdByName: new Map(groups.map((g) => [g.name, g.id])) };
  const groupOps = groups.map((g) => {
    const { columns, original } = codecs.group.encode({ name: g.name || '', permissions: g.permissions });
    if (original) findings.unknownPermissions.push(g.id);
    return { method: 'POST', collection: 'user_groups', body: { id: g.id, ...columns, original } };
  });
  const userOps = users.map((user) => {
    const { columns, original } = codecs.encodeUser(user, ctx, BUILDING_FIELDS.usersGroupsField);
    const values = original?.values || {};
    if ('groups' in values) {
      const list = Array.isArray(user.groups) ? user.groups : [];
      if (list.some((entry) => typeof entry !== 'string' || !ctx.groupIds.has(entry))) findings.groupsNamedOrAsObjects.push(user.id);
      if (list.some((entry) => codecs.groupIdsOf([entry], ctx).length === 0)) findings.groupsThatDoNotExist.push(user.id);
    }
    if ('owner' in values || 'superAdmin' in values) findings.ownerAndSuperAdminDiffer.push(user.id);
    if ('name' in values) findings.nameDiffersFromFirstAndLast.push(user.id);
    if ('emailNotifications' in values) findings.emailNotificationsDifferFromSettings.push(user.id);
    if ('isClaimed' in values) findings.claimedDiffersFromEmail.push(user.id);
    return { user: user.id, body: { [BUILDING_FIELDS.usersGroupsField]: columns[BUILDING_FIELDS.usersGroupsField], original }, owner: columns.owner };
  });
  return { groupOps, userOps, findings, counts: { old: { groups: groups.length, users: users.length }, new: { user_groups: groupOps.length, users: userOps.length } }, totals: {} };
}

/** users with the fields the upgrade adds before the switch (the previous backend does not mind them). */
async function addBuildingFields(appConfig) {
  const users = await client.getCollection(appConfig, 'users');
  const groupsId = (await client.getCollection(appConfig, 'user_groups')).id;
  const fields = [...users.fields];
  if (!fields.some((field) => field.name === BUILDING_FIELDS.usersGroupsField)) fields.push({ name: BUILDING_FIELDS.usersGroupsField, type: 'relation', collectionId: groupsId, maxSelect: 999, cascadeDelete: false });
  if (!fields.some((field) => field.name === 'original')) fields.push(original());
  await client.updateCollection(appConfig, 'users', { fields });
}

async function apply(appConfig, planned) {
  await client.batchWrite(appConfig, planned.groupOps.slice(0, client.BATCH_MAX_REQUESTS));
  for (let start = client.BATCH_MAX_REQUESTS; start < planned.groupOps.length; start += client.BATCH_MAX_REQUESTS) {
    await client.batchWrite(appConfig, planned.groupOps.slice(start, start + client.BATCH_MAX_REQUESTS));
  }
  await addBuildingFields(appConfig);
  const ops = planned.userOps.map((op) => ({ method: 'PATCH', collection: 'users', id: op.user, body: op.body }));
  for (let start = 0; start < ops.length; start += client.BATCH_MAX_REQUESTS) await client.batchWrite(appConfig, ops.slice(start, start + client.BATCH_MAX_REQUESTS));
}

async function compare(appConfig, { legacy }) {
  const differences = [];
  const differ = (what, a, b) => { if (!isDeepStrictEqual(a, b)) differences.push({ what, path: '', before: a, after: b }); };
  // The fields the upgrade adds before the switch are not part of what the old records were
  const withoutSystem = (record) => record && Object.fromEntries(Object.entries(record).filter(([key]) => !['created', 'updated', 'collectionId', BUILDING_FIELDS.usersGroupsField, 'original'].includes(key)));
  const [oldUsers, newUsers] = await Promise.all([legacy.store.listUserRecords(appConfig), store.listUserRecords(appConfig)]);
  differ('the accounts (count and order)', oldUsers.map((u) => u.id), newUsers.map((u) => u.id));
  const byId = new Map(newUsers.map((u) => [u.id, u]));
  for (const user of oldUsers) {
    // Without the fields the upgrade adds before the switch (the old records do not have them)
    const after = withoutSystem(byId.get(user.id));
    differ(`account ${user.id}`, withoutSystem(user), after);
    differ(`account ${user.id} as the apps see it`, legacy.store.toPublicUser(withoutSystem(user)), legacy.store.toPublicUser(after));
  }
  differ('the groups', await legacy.store.listGroupRecords(appConfig), await store.listGroupRecords(appConfig));
  return differences;
}

/** After the switch: owner takes in superAdmin, the worked-out fields go, the links get the name groups. */
async function cleanup(appConfig) {
  const users = await client.getCollection(appConfig, 'users');
  const linkField = users.fields.find((field) => field.name === BUILDING_FIELDS.usersGroupsField);
  if (linkField) {
    // owner as the old server read it (owner or superAdmin) - before superAdmin goes
    const rows = await client.listAllRecords('users', '', appConfig);
    const ops = rows.filter((row) => row.superAdmin === true && row.owner !== true).map((row) => ({ method: 'PATCH', collection: 'users', id: row.id, body: { owner: true } }));
    for (let start = 0; start < ops.length; start += client.BATCH_MAX_REQUESTS) await client.batchWrite(appConfig, ops.slice(start, start + client.BATCH_MAX_REQUESTS));
    await client.updateCollection(appConfig, 'users', { fields: users.fields.filter((field) => !REMOVED_USER_FIELDS.includes(field.name)) });
    const after = await client.getCollection(appConfig, 'users');
    await client.updateCollection(appConfig, 'users', { fields: after.fields.map((field) => (field.name === BUILDING_FIELDS.usersGroupsField ? { ...field, name: 'groups' } : field)) });
  }
  await ensureUsersSchema(appConfig);
  await client.deleteCollection(appConfig, 'groups');
}

/** An attempt that did not get through: the fields it added to users go again. */
async function rollback(appConfig) {
  const users = await client.getCollection(appConfig, 'users');
  if (!users) return;
  const fields = users.fields.filter((field) => field.name !== BUILDING_FIELDS.usersGroupsField && field.name !== 'original');
  if (fields.length !== users.fields.length) await client.updateCollection(appConfig, 'users', { fields });
}

/**
 * users as the new structure defines it: the fields of schema/system.js (with their help texts), a token may read
 * its own record and nothing else, sessions last about three years, passwords of at least 6 characters.
 */
async function ensureUsersSchema(appConfig) {
  const users = await client.getCollection(appConfig, 'users');
  const groupsId = (await client.getCollection(appConfig, 'user_groups'))?.id;
  const fields = [...users.fields];
  const problems = [];
  for (const wanted of schema.USERS_FIELDS) {
    const { target, ...rest } = wanted;
    const desired = wanted.type === 'relation' ? { ...rest, collectionId: groupsId } : rest;
    const index = fields.findIndex((field) => field.name === wanted.name);
    if (index < 0) fields.push(desired);
    else if (fields[index].type !== desired.type) problems.push(`users.${wanted.name} is a ${fields[index].type} field, the definition wants ${desired.type}`);
    else fields[index] = { ...fields[index], ...desired, id: fields[index].id };
  }
  // A fresh instance: PocketBase's own fields that the structure works out instead
  const kept = fields.filter((field) => !['name', 'avatar'].includes(field.name) || field.system);
  const password = kept.find((field) => field.name === 'password');
  if (password) password.min = 6;
  const otherIndexes = (users.indexes || []).filter((index) => !index.includes('idx_users_calendar_token'));
  const body = {
    ...SERVER_ONLY_RULES,
    viewRule: 'id = @request.auth.id',
    authToken: { ...(users.authToken || {}), duration: 94670856 },
    fields: kept,
    indexes: [...otherIndexes, "CREATE UNIQUE INDEX idx_users_calendar_token ON users (calendarToken) WHERE calendarToken != ''"]
  };
  try {
    await client.updateCollection(appConfig, 'users', body);
  } catch (error) {
    // Two accounts with the same calendar address (the app never makes that; a record edited by hand can have it) make
    // the unique index impossible. It only guards against that: the structure is applied without it and the
    // duplicates are reported, instead of a cleanup of the upgrade - or a start - that can never get through
    const tokens = (await client.listAllRecords('users', 'calendarToken != ""', appConfig, '', { fields: 'id,calendarToken' })).map((row) => row.calendarToken);
    if (new Set(tokens).size === tokens.length) throw error;
    await client.updateCollection(appConfig, 'users', { ...body, indexes: otherIndexes });
    problems.push('several accounts share one calendar address (users.calendarToken): the index that keeps them apart could not be made');
  }
  return problems;
}

module.exports = { key: 'accounts', OLD_COLLECTIONS, NEW_COLLECTIONS, BUILDING_FIELDS, REMOVED_USER_FIELDS, plan, apply, compare, cleanup, rollback, ensureUsersSchema };
