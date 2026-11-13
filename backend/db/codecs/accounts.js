// Accounts and groups as the old server handed them around (the raw PocketBase records), and as the new structure
// keeps them (see ../codec.js).
//
// users keeps its table (the session tokens belong to it); what was stored twice is worked out instead:
//   name               = first and last name
//   superAdmin         = owner (the old server always read the two together)
//   emailNotifications = a channel of the notification settings is on
//   isClaimed          = the e-mail address is a real one
//   avatar             = '' (never used)
// and groups are links to user_groups. Where an old record held something else, `original` keeps it.
const { createCodec, fieldKinds: f } = require('../codec');
const { PERMISSIONS } = require('../schema/system');

function isPlaceholderEmail(email) {
  if (!email) return true;
  const str = String(email).toLowerCase().trim();
  return str.endsWith('@agora.local') || str.endsWith('@nova.local') || str.endsWith('@local.invalid') || str.startsWith('unclaimed_');
}

/** What the old server kept in emailNotifications for these settings (context.js writes channels.push || channels.email). */
function emailNotificationsOf(settings) {
  if (!settings || typeof settings !== 'object') return true;
  const channels = settings.channels && typeof settings.channels === 'object' ? settings.channels : null;
  if (!channels) return true;
  return channels.push === true || channels.email === true;
}

/** The group ids a list of group entries (ids, names, { id, name } objects) stands for, in order, each once. */
function groupIdsOf(list, ctx) {
  const ids = [];
  for (const entry of Array.isArray(list) ? list : []) {
    let id = null;
    if (typeof entry === 'string') id = ctx?.groupIds?.has(entry) ? entry : (ctx?.groupIdByName?.get(entry) || null);
    else if (entry && typeof entry === 'object') id = (entry.id && ctx?.groupIds?.has(entry.id)) ? entry.id : ((entry.name && ctx?.groupIdByName?.get(entry.name)) || null);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The fields PocketBase keeps itself (they pass through unchanged). */
const SYSTEM_KEYS = ['collectionId', 'collectionName', 'id', 'email', 'emailVisibility', 'verified', 'created', 'updated'];

/** [groupsColumn]: the field that holds the links (during an upgrade it is built under another name). */
function userCodec(groupsColumn = 'groups') {
  return createCodec({
    fields: {
      name: f.computed((row) => `${row.firstName || ''} ${row.lastName || ''}`.trim()),
      avatar: f.computed(() => ''),
      firstName: f.text('firstName'),
      lastName: f.text('lastName'),
      admin: f.bool('admin'),
      owner: { column: 'owner', toColumn: (value, source) => value === true || source.superAdmin === true, fromColumn: (stored) => stored === true },
      // owner or an old superAdmin field still there (during the upgrade): the old server always read the two together
      superAdmin: f.computed((row) => row.owner === true || row.superAdmin === true),
      pays: f.bool('pays'),
      groups: { column: groupsColumn, toColumn: (value, source, ctx) => groupIdsOf(value, ctx), fromColumn: (stored) => (Array.isArray(stored) ? stored : []) },
      emailNotifications: f.computed((row) => emailNotificationsOf(row.notificationSettings)),
      notificationSettings: f.json('notificationSettings'),
      language: f.text('language'),
      timeZone: f.text('timeZone'),
      isClaimed: f.computed((row) => !isPlaceholderEmail(row.email)),
      calendarToken: f.text('calendarToken')
    },
    canonicalKeys: () => ['name', 'avatar', 'firstName', 'lastName', 'admin', 'owner', 'superAdmin', 'pays', 'groups', 'emailNotifications', 'notificationSettings', 'language', 'timeZone', 'isClaimed', 'calendarToken']
  });
}

/** The old raw record of an account from a row of users (decoded) - what every part of the server reads. */
function decodeUser(row, groupsColumn = 'groups') {
  if (!row) return null;
  const system = Object.fromEntries(SYSTEM_KEYS.filter((key) => key in row).map((key) => [key, row[key]]));
  return { ...system, ...userCodec(groupsColumn).decode(row) };
}

/** The columns (and `original`) of an account written in the old shape ([record]: its old fields, also partial). */
function encodeUser(record, ctx, groupsColumn = 'groups') {
  const values = Object.fromEntries(Object.entries(record).filter(([key]) => !SYSTEM_KEYS.includes(key)));
  return userCodec(groupsColumn).encode(values, ctx, { email: record.email });
}

/** A group as listGroupRecords hands it out: { id, name, permissions }; unknown permissions stay in `original`. */
const group = createCodec({
  fields: {
    name: f.text('name'),
    permissions: {
      column: 'permissions',
      toColumn: (value) => [...new Set((Array.isArray(value) ? value : []).filter((permission) => PERMISSIONS.includes(permission)))],
      fromColumn: (stored) => (Array.isArray(stored) ? stored : [])
    }
  },
  canonicalKeys: () => ['name', 'permissions']
});

module.exports = { userCodec, decodeUser, encodeUser, group, groupIdsOf, emailNotificationsOf, isPlaceholderEmail, SYSTEM_KEYS };
