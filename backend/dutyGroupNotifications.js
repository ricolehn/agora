// Push to the members of a group when the group is assigned to a duty in an event's duty roster.
const { listUserRecords, listGroupRecords } = require('./pocketbase');
const { sendPushToUsers } = require('./pushNotifications');

function wantsDutyNotifications(user) {
  if (user?.notificationSettings && typeof user.notificationSettings.duties === 'boolean') {
    return user.notificationSettings.duties;
  }
  return user?.emailNotifications !== false;
}

// user.groups holds group ids, names or {id, name} objects (same matching as the duty-plan access check)
function isGroupMember(user, groupId, groupName) {
  const groups = Array.isArray(user?.groups) ? user.groups : [];
  return groups.some(g => {
    const gid = typeof g === 'object' && g ? (g.id || g.name) : String(g);
    const gname = typeof g === 'object' && g ? g.name : String(g);
    return gid === groupId || gname === groupId || (groupName && gname === groupName);
  });
}

function groupDutyRecipients(users, groupId, groupName, excludeUserId) {
  return (users || [])
    .filter(u => u && u.id && u.id !== excludeUserId && isGroupMember(u, groupId, groupName) && wantsDutyNotifications(u))
    .map(u => u.id);
}

function buildGroupDutyPush({ groupName, event, duty }) {
  const dutyName = duty?.roleName || duty?.section || 'Dienst';
  const parts = String(event?.date || '').split('-');
  const date = parts.length === 3 ? ` am ${parts[2]}.${parts[1]}.` : '';
  const time = event?.startTime ? ` um ${event.startTime} Uhr` : '';
  return {
    title: `Dienst für ${groupName}: ${dutyName}`,
    body: `Deine Gruppe „${groupName}“ ist bei „${event?.title || 'Event'}“${date}${time} für „${dutyName}“ eingeteilt.`,
    data: { url: '/#events', eventId: event?.id || '' },
    tag: `agora-duty-${duty?.id || ''}`
  };
}

// Fire-and-forget: only call when the group is newly assigned (not on every save)
async function notifyGroupDutyAssigned({ appConfig, groupId, event, duty, assignedBy }) {
  if (!appConfig || !groupId) return;
  try {
    const [users, groups] = await Promise.all([
      listUserRecords(appConfig),
      listGroupRecords(appConfig).catch(() => [])
    ]);
    const group = groups.find(g => g.id === groupId || g.name === groupId);
    const groupName = group?.name || groupId;
    const recipients = groupDutyRecipients(users, group?.id || groupId, groupName, assignedBy);
    if (!recipients.length) return;
    await sendPushToUsers(appConfig, recipients, buildGroupDutyPush({ groupName, event, duty }));
  } catch (err) {
    console.warn('[WebPush] Failed sending group duty push:', err.message);
  }
}

module.exports = {
  isGroupMember,
  groupDutyRecipients,
  buildGroupDutyPush,
  notifyGroupDutyAssigned
};
