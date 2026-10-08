// Push to the members of a group when the group is assigned to a duty in an event's duty roster.
const { translator, userLanguage, BASE_LANGUAGE } = require('./i18n');
const { listUserRecords, listGroupRecords } = require('./pocketbase');
const { wantsNotification } = require('./notificationPrefs');

// Members of the group who want duty messages over at least one channel
function wantsDutyNotifications(user) {
  return wantsNotification(user, 'duties', 'push') || wantsNotification(user, 'duties', 'email');
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

/** Push for one group member, in [lang] (English source texts, see i18n.js). */
function buildGroupDutyPush({ groupName, event, duty }, lang = BASE_LANGUAGE) {
  const tr = translator(lang);
  const dutyName = duty?.roleName || duty?.section || tr('Duty');
  const { formatEventMoment } = require('./context');
  return {
    title: tr('Duty for {group}: {duty}', { group: groupName, duty: dutyName }),
    body: tr('Your group "{group}" is assigned to "{duty}" at "{event}" ({when}).', {
      group: groupName, duty: dutyName, event: event?.title || 'Event', when: formatEventMoment(event, lang)
    }),
    data: { url: '/#events', eventId: event?.id || '' },
    tag: `agora-duty-${duty?.id || ''}`
  };
}

// Fire-and-forget: only call when the group is newly assigned (not on every save)
async function notifyGroupDutyAssigned({ appConfig, groupId, event, duty, assignedBy, origin = '' }) {
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
    const { notifyUsers } = require('./notify');
    const { formatEventMoment } = require('./context');
    await notifyUsers(appConfig, users.filter(u => recipients.includes(u.id)), 'duties', {
      origin,
      push: (tr, user) => buildGroupDutyPush({ groupName, event, duty }, userLanguage(user)),
      email: (tr, user) => {
        const push = buildGroupDutyPush({ groupName, event, duty }, userLanguage(user));
        return {
          subject: push.title,
          heading: push.title,
          lines: [push.body],
          rows: [[tr('Event'), event?.title || 'Event'], ...(event?.date ? [[tr('Date'), formatEventMoment(event, userLanguage(user))]] : []), ...(event?.location ? [[tr('Location'), event.location]] : [])],
          actionLabel: tr('View the duty roster'),
          path: '/#events',
          accent: '#6366f1'
        };
      }
    });
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
