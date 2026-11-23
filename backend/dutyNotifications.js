// Messages about the duties of an event's duty roster: a person is asked to do one, the one who asked hears the
// answer, a group is assigned. Each in the recipient's language (English source texts, i18n.js), by push and e-mail
// as the person chose (notificationPrefs.js).
const { translator, userLanguage, BASE_LANGUAGE } = require('./i18n');
const { listUserRecords, listGroupRecords, getEventRecord } = require('./pocketbase');
const { wantsNotification } = require('./notificationPrefs');
const { notifyUsers } = require('./notify');
const { formatEventMoment, formatEventShort, pushLine } = require('./eventTexts');
const { isGroupMember } = require('./eventAccess');

const dutyNameOf = (duty, tr) => duty?.roleName || duty?.section || tr('Duty');
const personName = (user) => user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;

/**
 * [requesterId] asks [recipientId] to do [duty] of [event]: a push, and an e-mail unless the person asking left it
 * out ([sendEmail] false).
 */
async function askForDuty({ appConfig, recipientId, requesterId, event, duty, sendEmail = true, origin = '' }) {
  const users = await listUserRecords(appConfig);
  const requester = users.find((u) => u.id === requesterId);
  const facts = (tr) => ({ name: requester ? personName(requester) : tr('An event organiser'), duty: dutyNameOf(duty, tr), event: event.title || 'Event' });
  await notifyUsers(appConfig, users.filter((u) => u.id === recipientId), 'duties', {
    origin,
    // "Anna Becker asks you: Sound" - "Sunday service · Sun 1 Nov, 10:00 · Main hall"
    push: (tr, user) => {
      const x = facts(tr);
      return {
        title: tr('{name} asks you: {duty}', { name: x.name, duty: x.duty }),
        body: pushLine(x.event, formatEventShort(event, userLanguage(user)), event.location),
        data: { url: '/#events', eventId: event.id || '' },
        tag: `agora-duty-request-${duty.id || ''}`
      };
    },
    email: sendEmail === false ? null : (tr, user) => {
      const x = facts(tr);
      return {
        subject: tr('Duty request: {duty}', { duty: x.duty }),
        heading: tr('Duty request: {duty}', { duty: x.duty }),
        lines: [tr('{name} asked you to do a duty. Please accept or decline the request in the app.', { name: x.name })],
        rows: [
          [tr('Duty'), x.duty],
          [tr('Event'), x.event],
          [tr('Date'), formatEventMoment(event, userLanguage(user))],
          ...(event.location ? [[tr('Location'), event.location]] : []),
          ...(duty.notes ? [[tr('Notes'), duty.notes]] : [])
        ],
        actionLabel: tr('Answer the request'),
        path: '/#events',
        accent: '#6366f1'
      };
    }
  });
}

// What the one who asked for a duty hears of the answer
const ANSWERS = {
  accepted: {
    push: '{name} accepted: {duty}',
    subject: 'Duty request accepted: {duty}',
    heading: 'Duty request accepted',
    line: '{name} accepted the request for "{duty}" ({event}).',
    accent: '#059669'
  },
  declined: {
    push: '{name} declined: {duty}',
    subject: 'Duty request declined: {duty}',
    heading: 'Duty request declined',
    line: '{name} declined the request for "{duty}" ({event}).',
    accent: '#dc2626'
  }
};

/** Who asked [duty] of someone hears [answer] ('accepted' or 'declined') - unless they answered it themselves. */
async function tellDutyRequester({ appConfig, duty, responderId, answer, origin = '' }) {
  if (!duty.requestedBy || duty.requestedBy === responderId) return;
  const users = await listUserRecords(appConfig);
  const requester = users.find((u) => u.id === duty.requestedBy);
  if (!requester) return;
  const responder = users.find((u) => u.id === responderId);
  const event = await getEventRecord(appConfig, duty.event);
  const texts = ANSWERS[answer];
  const facts = (tr) => ({ name: responder ? personName(responder) : tr('A helper'), duty: dutyNameOf(duty, tr), event: event?.title || 'Event' });
  await notifyUsers(appConfig, [requester], 'duties', {
    origin,
    // "Clara Schmidt accepted: Sound" - "Sunday service · Sun 1 Nov, 10:00"
    push: (tr, user) => {
      const x = facts(tr);
      return {
        title: tr(texts.push, { name: x.name, duty: x.duty }),
        body: pushLine(x.event, formatEventShort(event, userLanguage(user))),
        data: { url: '/#events', eventId: event?.id || '' },
        tag: `agora-duty-answer-${duty.id}`
      };
    },
    email: (tr) => {
      const x = facts(tr);
      return {
        subject: tr(texts.subject, { duty: x.duty }),
        heading: tr(texts.heading),
        lines: [tr(texts.line, x)],
        rows: [[tr('Duty'), x.duty], [tr('Event'), x.event], [tr('From'), x.name]],
        actionLabel: tr('View the duty roster'),
        path: '/#events',
        accent: texts.accent
      };
    }
  });
}

// Members of the group who want duty messages over at least one channel
const wantsDutyNotifications = (user) => wantsNotification(user, 'duties', 'push') || wantsNotification(user, 'duties', 'email');

/** Whom a group's duty is told: its members who want duty messages, without who assigned it. */
function groupDutyRecipients(users, groupId, groupName, excludeUserId) {
  return (users || [])
    .filter(u => u && u.id && u.id !== excludeUserId && isGroupMember(u, groupId, groupName) && wantsDutyNotifications(u))
    .map(u => u.id);
}

/** Push for one group member, in [lang]: "Tech team is on duty: Sound" - "Sunday service · Sun 1 Nov, 10:00 · Main hall". */
function buildGroupDutyPush({ groupName, event, duty }, lang = BASE_LANGUAGE) {
  const tr = translator(lang);
  return {
    title: tr('{group} is on duty: {duty}', { group: groupName, duty: dutyNameOf(duty, tr) }),
    body: pushLine(event?.title || 'Event', formatEventShort(event, lang), event?.location),
    data: { url: '/#events', eventId: event?.id || '' },
    tag: `agora-duty-${duty?.id || ''}`
  };
}

/** The members of [groupId] hear that their group has [duty] - call it when the group is newly assigned only. */
async function notifyGroupDutyAssigned({ appConfig, groupId, event, duty, assignedBy, origin = '' }) {
  if (!appConfig || !groupId) return;
  try {
    const [users, groups] = await Promise.all([listUserRecords(appConfig), listGroupRecords(appConfig).catch(() => [])]);
    const group = groups.find(g => g.id === groupId || g.name === groupId);
    const groupName = group?.name || groupId;
    const recipients = groupDutyRecipients(users, group?.id || groupId, groupName, assignedBy);
    if (!recipients.length) return;
    await notifyUsers(appConfig, users.filter(u => recipients.includes(u.id)), 'duties', {
      origin,
      push: (tr, user) => buildGroupDutyPush({ groupName, event, duty }, userLanguage(user)),
      email: (tr, user) => {
        const push = buildGroupDutyPush({ groupName, event, duty }, userLanguage(user));
        const when = formatEventMoment(event, userLanguage(user));
        return {
          subject: push.title,
          heading: push.title,
          lines: [tr('Your group "{group}" is assigned to "{duty}" at "{event}" ({when}).', { group: groupName, duty: dutyNameOf(duty, tr), event: event?.title || 'Event', when })],
          rows: [[tr('Event'), event?.title || 'Event'], ...(event?.date ? [[tr('Date'), when]] : []), ...(event?.location ? [[tr('Location'), event.location]] : [])],
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

module.exports = { askForDuty, tellDutyRequester, groupDutyRecipients, buildGroupDutyPush, notifyGroupDutyAssigned };
