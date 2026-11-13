// The places of an event: members (event_registrations) and guests without an account (event_guests) share the
// seats and one waiting list. Every change of who is registered runs in the event's write queue, so two people
// signing up for the last place at the same moment cannot both get it.
const {
  listEventRegistrations,
  listEventGuests,
  upsertEventRegistration,
  updateEventGuest,
  queueRecordWrite,
  pbFilterEquals
} = require('./pocketbase');

const hasLimit = (event) => typeof event?.maxParticipants === 'number' && event.maxParticipants > 0;

/** Registered and waiting people of one event, members and guests together. */
function seatCounts(memberRegs = [], guests = []) {
  const all = [...memberRegs, ...guests];
  return {
    registered: all.filter((r) => r.status === 'registered').length,
    waitlist: all.filter((r) => r.status === 'waitlist').length
  };
}

/** True when [registered] people fill every place of [event] (no limit: never). */
const isBookedOut = (event, registered) => hasLimit(event) && registered >= event.maxParticipants;

/** Who moves up when a place becomes free: whoever has waited longest, member or guest. */
function nextWaitlisted(memberRegs = [], guests = []) {
  const waiting = [
    ...memberRegs.filter((r) => r.status === 'waitlist').map((record) => ({ kind: 'member', record })),
    ...guests.filter((g) => g.status === 'waitlist').map((record) => ({ kind: 'guest', record }))
  ];
  waiting.sort((a, b) => String(a.record.created || '').localeCompare(String(b.record.created || '')));
  return waiting[0] || null;
}

/** Runs [change] in the write queue of the event's places. */
const withEventSeats = (eventId, change) => queueRecordWrite(`event-seats:${eventId}`, change);

async function loadSeats(appConfig, eventId) {
  const [memberRegs, guests] = await Promise.all([
    listEventRegistrations(appConfig, pbFilterEquals('event', eventId)),
    listEventGuests(appConfig, pbFilterEquals('event', eventId))
  ]);
  return { memberRegs, guests };
}

/**
 * Fills free places from the waiting list (call inside withEventSeats). Returns the guests who moved up, so the
 * caller can tell them by e-mail; members see it in the app.
 */
async function fillFreeSeats(appConfig, event) {
  const promotedGuests = [];
  let { memberRegs, guests } = await loadSeats(appConfig, event.id);
  // Without a limit (any more) everyone waiting gets a place
  let free = hasLimit(event) ? event.maxParticipants - seatCounts(memberRegs, guests).registered : Infinity;
  while (free > 0) {
    const next = nextWaitlisted(memberRegs, guests);
    if (!next) break;
    if (next.kind === 'member') {
      await upsertEventRegistration(appConfig, event.id, next.record.user, 'registered');
      memberRegs = memberRegs.map((r) => (r.id === next.record.id ? { ...r, status: 'registered' } : r));
    } else {
      await updateEventGuest(appConfig, next.record.id, { status: 'registered' });
      guests = guests.map((g) => (g.id === next.record.id ? { ...g, status: 'registered' } : g));
      promotedGuests.push({ ...next.record, status: 'registered' });
    }
    free -= 1;
  }
  return promotedGuests;
}

module.exports = { seatCounts, isBookedOut, nextWaitlisted, withEventSeats, loadSeats, fillFreeSeats };
