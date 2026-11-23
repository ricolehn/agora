// What a person may do. It follows from two things only: being an admin (a role of the account - the owner is one
// too) and the permissions of the person's groups (SYSTEM_PERMISSIONS, given to groups on the admin page). The
// server's checks ask isAdmin() and can(); what the apps are told the person may do is worked out here from the same
// answers (the flags of the old API, `can` of API v2), so an app never offers what the server then refuses.

/** The permissions a group can give, as the admin page lists them (English source texts, translated per request). */
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

// A permission that includes others: who manages the finances sees them
const INCLUDES = { manage_finances: ['view_finances'] };

/** True for an admin of the instance (the owner is one). */
const isAdmin = (user) => user?.admin === true || user?.owner === true || user?.superAdmin === true;

/** True when the groups of [user] give [permission] (directly or with a permission that includes it). */
function can(user, permission) {
  const given = Array.isArray(user?.permissions) ? user.permissions : [];
  return given.includes(permission) || given.some((own) => INCLUDES[own]?.includes(permission) === true);
}

/** The flags of the old API on an account: the web app and older Android apps decide by them what to offer. */
const permissionFlags = (user) => ({
  canManageFinances: can(user, 'manage_finances'),
  canViewFinances: can(user, 'view_finances'),
  canManageRegistrationCode: can(user, 'manage_registration_code'),
  canAccessAi: can(user, 'access_ai'),
  // Every member may talk to a mentor
  canParticipateMentoring: true,
  canManageMentoring: can(user, 'manage_mentoring'),
  canManageEvents: can(user, 'manage_events')
});

/** What API v2 tells the apps the person may do. */
const abilities = (user) => ({
  viewFinances: can(user, 'view_finances'),
  manageFinances: can(user, 'manage_finances'),
  manageEvents: can(user, 'manage_events'),
  manageMentoring: can(user, 'manage_mentoring'),
  manageSongbook: can(user, 'manage_songbook'),
  useAi: can(user, 'access_ai'),
  manageRegistrationCode: can(user, 'manage_registration_code')
});

/**
 * What [userGroups] (ids or names) give among [allGroups]: the ids and names of those groups (accounts keep their
 * groups by id, events their target groups by name, eventAccess.js), their permissions and the flags of the old API.
 */
function resolveUserPermissions(userGroups = [], allGroups = []) {
  const keys = Array.isArray(userGroups) ? userGroups : (userGroups ? [String(userGroups)] : []);
  const groups = (Array.isArray(allGroups) ? allGroups : []).filter((g) => keys.includes(g.id) || keys.includes(g.name));
  const permissions = [...new Set(groups
    .flatMap((g) => (Array.isArray(g.permissions) ? g.permissions : []))
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => p.trim()))];
  return {
    groupIds: groups.map((g) => g.id).filter(Boolean),
    groupNames: groups.map((g) => g.name).filter(Boolean),
    permissions,
    ...permissionFlags({ permissions })
  };
}

module.exports = { SYSTEM_PERMISSIONS, isAdmin, can, permissionFlags, abilities, resolveUserPermissions };
