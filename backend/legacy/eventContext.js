// Events for the AI assistant: exactly what the asking person can see in the app, in a compact form.
// Same rules as GET /api/events (own events and those of their target groups), the duty roster and the
// order of service only where the person may see them (canUserAccessEventDutyPlan), no attendee names.
const { listEvents, listEventRegistrations, listEventGuests, listEventDuties, listUserRecords, listGroupRecords } = require('./pocketbase');
const { userMatchesTargetGroups, canUserAccessEventDutyPlan } = require('./eventAccess');
const { createItemStore } = require('./itemStore');
const { seatCounts } = require('./eventSeats');
const { toDateStr } = require('./utils/date');

const programStore = createItemStore('event_programs');
const songStore = createItemStore('songs');

const PAST_DAYS = 14;
const FUTURE_DAYS = 365;
const MAX_EVENTS = 80;
const MAX_DESCRIPTION = 600;

const plainText = (html, max) => String(html || '')
  .replace(/<(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\n{3,}/g, '\n\n')
  .trim()
  .slice(0, max);

const addDays = (date, days) => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return toDateStr(copy);
};

/** The events [user] can see, from two weeks ago to a year ahead, with what the app shows them. */
async function buildEventContext(appConfig, user) {
  if (!user) return [];
  const uid = user.uid || user.id;
  const canManage = user.canManageEvents === true || (Array.isArray(user.permissions) && user.permissions.includes('manage_events'));
  const from = addDays(new Date(), -PAST_DAYS);
  const until = addDays(new Date(), FUTURE_DAYS);

  const [events, registrations, guests, duties, users, groups] = await Promise.all([
    listEvents(appConfig, '', '+date,+startTime').catch(() => []),
    listEventRegistrations(appConfig).catch(() => []),
    listEventGuests(appConfig).catch(() => []),
    listEventDuties(appConfig).catch(() => []),
    listUserRecords(appConfig).catch(() => []),
    listGroupRecords(appConfig).catch(() => [])
  ]);
  const nameOf = new Map(users.map((u) => [u.id, u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || '']));
  const groupMap = new Map(groups.map((g) => [g.id, g.name]));

  const visible = events
    .filter((ev) => ev.createdBy === uid || userMatchesTargetGroups(user, ev.targetGroups))
    .filter((ev) => (ev.endDate || ev.date || '') >= from && (ev.date || '') <= until)
    .slice(0, MAX_EVENTS);

  let songTitles = null;
  const result = [];
  for (const ev of visible) {
    const evRegs = registrations.filter((r) => r.event === ev.id);
    // Guests without an account count, but stay anonymous like all attendees
    const seats = seatCounts(evRegs, guests.filter((g) => g.event === ev.id));
    const registered = seats.registered;
    const mine = evRegs.find((r) => r.user === uid && r.status !== 'cancelled');
    const evDuties = duties.filter((d) => d.event === ev.id);
    const seesPlan = canUserAccessEventDutyPlan(user, ev, evDuties, groupMap);

    const entry = {
      title: ev.title || '',
      type: ev.eventType === 'termin' || ev.isRecurring ? 'appointment' : (ev.isPinned ? 'major event' : 'event'),
      date: ev.date || '',
      ...(ev.endDate && ev.endDate !== ev.date ? { endDate: ev.endDate } : {}),
      time: ev.startTime ? `${ev.startTime}${ev.endTime ? `–${ev.endTime}` : ''}` : 'all day',
      ...(ev.location ? { location: ev.location } : {}),
      organizer: nameOf.get(ev.createdBy) || '',
      ...(ev.status === 'cancelled' ? { cancelled: true } : {}),
      ...(Array.isArray(ev.targetGroups) && ev.targetGroups.length ? { forGroups: ev.targetGroups.map((g) => groupMap.get(g) || g) } : { forGroups: 'everyone' }),
      ...(ev.description ? { description: plainText(ev.description, MAX_DESCRIPTION) } : {})
    };
    if (ev.requiresRegistration) {
      entry.registration = {
        registered,
        ...(ev.maxParticipants > 0 ? { maxParticipants: ev.maxParticipants, full: registered >= ev.maxParticipants } : {}),
        waitlist: seats.waitlist,
        me: mine ? mine.status : 'not registered'
      };
    }
    const myDuty = evDuties.find((d) => d.assignedUser === uid || d.requestedUser === uid);
    if (myDuty) entry.myDuty = { role: myDuty.roleName || '', status: myDuty.assignedUser === uid ? 'assigned' : 'requested' };
    if (seesPlan && evDuties.length) {
      entry.dutyRoster = evDuties.map((d) => ({
        role: d.roleName || '',
        ...(d.section && d.section !== 'Allgemein' ? { section: d.section } : {}),
        person: nameOf.get(d.assignedUser) || groupMap.get(d.assignedGroup) || d.assignedGroup || (d.requestedUser ? `${nameOf.get(d.requestedUser) || ''} (asked)` : 'open'),
        status: d.status || 'open'
      }));
    }
    if (seesPlan) {
      const program = await programStore.get(appConfig, ev.id).catch(() => null);
      if (program?.items?.length) {
        if (!songTitles) songTitles = new Map((await songStore.list(appConfig).catch(() => [])).map((s) => [s.id, s.title]));
        entry.orderOfService = program.items.map((item) => ({
          item: item.title || songTitles.get(item.songId) || 'Song',
          ...(item.songId ? { song: true, ...(item.songKey ? { key: item.songKey } : {}) } : {}),
          ...(item.minutes !== null && item.minutes !== undefined ? { minutes: item.minutes } : {}),
          ...(item.who ? { who: item.who } : {})
        }));
      }
    }
    if (ev.createdBy === uid || canManage) entry.canEdit = true;
    result.push(entry);
  }
  return result;
}

module.exports = { buildEventContext };
