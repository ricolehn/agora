// Reminder before a duty: 3 hours before the event starts, everyone on the duty (the person who took it, or the
// members of the assigned group) gets a push and / or e-mail - like every duty message, only when they want duty
// messages over that channel. Events without a start time remind at 8:00 on the day.
//
// Event times are stored as wall-clock times of the community ("18:00", no zone), so they are read in one time zone
// for the whole instance - never per member: 3 hours before the event is the same moment wherever someone is. The
// zone is the server's TZ (recommended to set), else the one most members' apps report (Docker containers often run
// in UTC without TZ), else UTC. Each duty remembers per person for which start it already reminded (field
// "reminded"), so a moved event reminds again, restarts never send twice and new group members still get one.
const { translator, userLanguage, BASE_LANGUAGE } = require('./i18n');
const { isGroupMember } = require('./dutyGroupNotifications');

const REMINDER_HOURS = 3;
const ALL_DAY_HOUR = 8;
const ACTIVE_STATUSES = new Set(['assigned', 'confirmed']);

/** The time zone if it is a valid IANA name, else ''. */
function validTimeZone(value) {
  const zone = String(value || '').trim();
  if (!zone || zone.length > 64) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return '';
  }
}

/** "HH:mm" (also "H:mm" and "HH:mm:ss") as [hours, minutes], or null. */
function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? [hours, minutes] : null;
}

/** Milliseconds since the epoch of the wall-clock time [day] ("yyyy-MM-dd") [hours]:[minutes] in [timeZone]. */
function zonedTime(day, hours, minutes, timeZone) {
  const [y, m, d] = String(day || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return NaN;
  const wall = Date.UTC(y, m - 1, d, hours, minutes);
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const offset = (instant) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - instant;
  };
  // Two rounds settle the offset also next to a daylight saving change
  const first = wall - offset(wall);
  return wall - offset(first);
}

/**
 * When to remind about [event] in [timeZone]: { at, until, key, time } in milliseconds (key identifies the start,
 * time is the start "HH:mm" or '' for events without a time), or null without a date.
 */
function reminderWindow(event, timeZone) {
  const day = String(event?.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const clock = parseClock(event.startTime || event.time);
  if (clock) {
    const start = zonedTime(day, clock[0], clock[1], timeZone);
    if (Number.isNaN(start)) return null;
    const time = `${String(clock[0]).padStart(2, '0')}:${String(clock[1]).padStart(2, '0')}`;
    return { at: start - REMINDER_HOURS * 3600000, until: start, key: `${day} ${time}`, time };
  }
  const at = zonedTime(day, ALL_DAY_HOUR, 0, timeZone);
  if (Number.isNaN(at)) return null;
  return { at, until: zonedTime(day, 23, 59, timeZone), key: day, time: '' };
}

/** The people on [duty]: the one who took it, else the members of the assigned group. */
function dutyRecipients(duty, users, groups = []) {
  if (!duty || !ACTIVE_STATUSES.has(duty.status)) return [];
  if (duty.assignedUser) {
    return users.filter((u) => u && (u.id === duty.assignedUser || u.uid === duty.assignedUser));
  }
  if (duty.assignedGroup) {
    const group = groups.find((g) => g.id === duty.assignedGroup || g.name === duty.assignedGroup);
    return users.filter((u) => u && isGroupMember(u, group?.id || duty.assignedGroup, group?.name || duty.assignedGroup));
  }
  return [];
}

const isUtc = (zone) => /^(Etc\/)?(UTC|UCT|GMT|Zulu|Universal)([+-]?0)?$/i.test(zone);

/**
 * The instance's time zone for event times: the server's TZ unless it is UTC, else the zone most members' apps
 * reported, else the zone the server runs in, else UTC.
 */
function communityTimeZone(users) {
  const configured = validTimeZone(process.env.TZ);
  if (configured && !isUtc(configured)) return configured;
  const counts = new Map();
  for (const user of users || []) {
    const zone = validTimeZone(user?.timeZone);
    if (zone) counts.set(zone, (counts.get(zone) || 0) + 1);
  }
  let best = '';
  for (const [zone, count] of counts) if (!best || count > counts.get(best)) best = zone;
  return best || configured || validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
}

/** Push for one person, in [lang] (English source texts, see i18n.js). */
function buildDutyReminderPush({ event, duty, time }, lang = BASE_LANGUAGE) {
  const tr = translator(lang);
  const dutyName = duty?.roleName || duty?.section || tr('Duty');
  const eventTitle = event?.title || 'Event';
  const body = time
    ? tr('Your duty "{duty}" at "{event}" starts at {time}.', { duty: dutyName, event: eventTitle, time })
    : tr('Your duty "{duty}" at "{event}" is today.', { duty: dutyName, event: eventTitle });
  return {
    title: tr('Reminder: {duty}', { duty: dutyName }),
    body: event?.location ? `${body} ${tr('Location')}: ${event.location}` : body,
    data: { url: '/#events', eventId: event?.id || '' },
    tag: `agora-duty-reminder-${duty?.id || ''}`
  };
}

/**
 * Sends the reminders that are due at [now]. [deps] replaces the PocketBase access in tests:
 * { listEvents, listDuties, listUsers, listGroups, saveReminded, notify }.
 */
async function sendDueDutyReminders(appConfig, now = Date.now(), deps = {}) {
  const pb = require('./pocketbase');
  const io = {
    listEvents: (filter) => pb.listEvents(appConfig, filter),
    listDuties: (filter) => pb.listEventDuties(appConfig, filter),
    listUsers: () => pb.listUserRecords(appConfig),
    listGroups: () => pb.listGroupRecords(appConfig).catch(() => []),
    // Not via updateEventDuty: the reminder is no change of the duty for the others
    saveReminded: (duty, reminded) => pb.updateRecord('event_duties', duty.id, { reminded }, appConfig),
    notify: (users, content) => require('./notify').notifyUsers(appConfig, users, 'duties', content),
    ...deps
  };
  // Events from yesterday to the day after tomorrow cover every time zone
  const day = (offset) => new Date(now + offset * 86400000).toISOString().slice(0, 10);
  const events = await io.listEvents(`date >= ${JSON.stringify(day(-1))} && date <= ${JSON.stringify(day(2))}`);
  if (!events.length) return 0;
  const byId = new Map(events.map((e) => [e.id, e]));
  const duties = (await io.listDuties(events.map((e) => pb.pbFilterEquals('event', e.id)).join(' || ')))
    .filter((d) => ACTIVE_STATUSES.has(d.status) && byId.has(d.event));
  if (!duties.length) return 0;
  const [users, groups] = await Promise.all([io.listUsers(), io.listGroups()]);
  const timeZone = communityTimeZone(users);
  let sent = 0;
  for (const duty of duties) {
    const event = byId.get(duty.event);
    if (event.status === 'cancelled') continue;
    // The same moment for everyone on the duty
    const slot = reminderWindow(event, timeZone);
    if (!slot || now < slot.at || now >= slot.until) continue;
    const reminded = duty.reminded && typeof duty.reminded === 'object' ? { ...duty.reminded } : {};
    const due = [];
    for (const user of dutyRecipients(duty, users, groups)) {
      if (reminded[user.id] === slot.key) continue;
      reminded[user.id] = slot.key;
      due.push({ user, time: slot.time });
    }
    if (!due.length) continue;
    // Remember first: a failing mail server must not lead to a reminder every few minutes
    await io.saveReminded(duty, reminded);
    for (const { user, time } of due) {
      const content = {
        push: () => buildDutyReminderPush({ event, duty, time }, userLanguage(user)),
        email: (tr) => {
          const push = buildDutyReminderPush({ event, duty, time }, userLanguage(user));
          const { formatEventMoment } = require('./context');
          return {
            subject: push.title,
            heading: push.title,
            lines: [push.body],
            rows: [[tr('Event'), event.title || 'Event'], [tr('Date'), formatEventMoment(event, userLanguage(user))],
              ...(event.location ? [[tr('Location'), event.location]] : []), ...(duty.notes ? [[tr('Notes'), duty.notes]] : [])],
            actionLabel: tr('View the duty roster'),
            path: '/#events',
            accent: '#6366f1'
          };
        }
      };
      await io.notify([user], content).catch((err) => console.warn('[Reminder] failed:', err.message));
      sent += 1;
    }
  }
  return sent;
}

let running = false;
/** Cron entry: one run at a time, errors are logged. */
async function runDutyReminders(appConfig) {
  if (running || !appConfig) return;
  running = true;
  try {
    const sent = await sendDueDutyReminders(appConfig);
    if (sent) console.log(`[Reminder] Sent ${sent} duty reminder(s)`);
  } catch (err) {
    console.warn('[Reminder] Duty reminders failed:', err.message);
  } finally {
    running = false;
  }
}

module.exports = {
  REMINDER_HOURS,
  validTimeZone,
  zonedTime,
  reminderWindow,
  dutyRecipients,
  communityTimeZone,
  buildDutyReminderPush,
  sendDueDutyReminders,
  runDutyReminders
};
