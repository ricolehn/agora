// Who sees an event and its duty roster / order of service, and who edits it. Pure rules without server state,
// shared by the events routes, API v2, the AI's event context, the duty messages and the tests.
const { isAdmin, can } = require('./permissions');

const uidOf = (user) => user.uid || user.id;

// An account's groups are ids, names or { id, name }
const groupIdOf = (g) => (typeof g === 'object' && g ? g.id || g.name : String(g));
const groupNameOf = (g) => (typeof g === 'object' && g ? g.name : String(g));

/** True when [user] is in the group [group] (its id or name; [name]: the group's name when [group] is its id). */
function isGroupMember(user, group, name) {
  const groups = Array.isArray(user?.groups) ? user.groups : [];
  return groups.some((g) => groupIdOf(g) === group || groupNameOf(g) === group || (Boolean(name) && groupNameOf(g) === name));
}

/** Events without target groups are for everyone; managers see all; otherwise one of the person's groups. */
function userMatchesTargetGroups(user, targetGroups = []) {
  if (!Array.isArray(targetGroups) || targetGroups.length === 0) return true;
  if (!user) return false;
  if (isAdmin(user) || can(user, 'manage_events')) return true;
  // The event editor stores target groups by name, accounts their groups by id: the server adds the names of the
  // user's groups (groupNames, resolveUserPermissions). Without them members never saw their own group's events.
  if (Array.isArray(user.groupNames) && user.groupNames.some(name => targetGroups.includes(name))) return true;
  return targetGroups.some((group) => isGroupMember(user, group));
}

/** Who sees [event]: its creator and whoever its target groups take in. */
const seesEvent = (user, event) => event.createdBy === uidOf(user) || userMatchesTargetGroups(user, event.targetGroups);

/** Who edits [event] - its details, duties, order of service and participants: its creator and the event managers. */
const canEditEvent = (user, event) => event.createdBy === uidOf(user) || can(user, 'manage_events');

/** The duty plan: who edits the event, and everyone entered, asked or in an assigned group. */
function canUserAccessEventDutyPlan(user, event, allEventDuties, groupMap) {
  if (!user || !event) return false;
  if (canEditEvent(user, event)) return true;
  const uid = uidOf(user);
  return Array.isArray(allEventDuties) && allEventDuties.some((d) => d.event === event.id
    && (d.assignedUser === uid || d.requestedUser === uid
      || (Boolean(d.assignedGroup) && isGroupMember(user, d.assignedGroup, groupMap?.get(d.assignedGroup)))));
}

module.exports = { isGroupMember, userMatchesTargetGroups, seesEvent, canEditEvent, canUserAccessEventDutyPlan };
