// Who sees an event and its duty roster / order of service. Pure rules without server state, shared by the
// events routes, the AI's event context and the tests (context.js re-exports them).

/** Events without target groups are for everyone; managers see all; otherwise one of the person's groups. */
function userMatchesTargetGroups(user, targetGroups = []) {
  if (!Array.isArray(targetGroups) || targetGroups.length === 0) return true;
  if (!user) return false;
  if (user.admin === true || user.owner === true || user.superAdmin === true || user.canManageEvents === true) return true;
  const userGroups = Array.isArray(user.groups) ? user.groups : [];
  return userGroups.some(g => {
    const gid = typeof g === 'object' && g ? (g.id || g.name) : String(g);
    const gname = typeof g === 'object' && g ? g.name : String(g);
    return targetGroups.includes(gid) || targetGroups.includes(gname);
  });
}

/** The duty plan: the creator, event managers, and everyone entered, asked or in an assigned group. */
function canUserAccessEventDutyPlan(user, event, allEventDuties, groupMap) {
  if (!user || !event) return false;
  const currentUid = user.uid || user.id;

  if (event.createdBy === currentUid) return true;

  const canManage = user.canManageEvents === true || (Array.isArray(user.permissions) && user.permissions.includes('manage_events'));
  if (canManage) {
    return true;
  }

  const isEnteredOrRequested = Array.isArray(allEventDuties) && allEventDuties.some(d => {
    if (d.event !== event.id) return false;
    if (d.assignedUser === currentUid) return true;
    if (d.requestedUser === currentUid) return true;
    if (d.assignedGroup && Array.isArray(user.groups)) {
      return user.groups.some(g => {
        const gid = typeof g === 'object' && g ? (g.id || g.name) : String(g);
        const gname = typeof g === 'object' && g ? g.name : String(g);
        return gid === d.assignedGroup || gname === d.assignedGroup || (groupMap && groupMap.get(d.assignedGroup) === gname);
      });
    }
    return false;
  });
  if (isEnteredOrRequested) return true;

  return false;
}

module.exports = { userMatchesTargetGroups, canUserAccessEventDutyPlan };
