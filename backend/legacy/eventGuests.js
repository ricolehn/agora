// Guests: people without an account who open a shared event (the switch in the event's share sheet) and sign up
// with their name, e-mail address and age. Rules for that input, the random keys of the link and of each guest,
// what the public page shows, the guests' e-mails and how long their details are kept.
const crypto = require('crypto');
const { listEvents, listEventGuests, deleteEventGuest } = require('./pocketbase');

// A guest's details are deleted this many days after their event ended
const GUEST_RETENTION_DAYS = 30;
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const MAX_AGE = 120;
// A family signs up several children with one address; more than this per event is someone else's inbox
const MAX_GUESTS_PER_EMAIL = 10;
// The rule browsers use for <input type="email"> (and a dot in the domain): no commas, spaces or brackets, so an
// address can never name more recipients than one
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Share links and guests' keys are random and URL safe (like the calendar feed's token); nothing else is ever
// looked up with them
const newPublicToken = () => crypto.randomBytes(16).toString('base64url');
const newGuestKey = () => crypto.randomBytes(24).toString('base64url');
const isPublicToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
const isGuestKey = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{24,64}$/.test(value);

// Today in the community's time zone (the server's TZ, see the README): an event is over after its day there, not
// after midnight UTC - between 0:00 and 1:00 / 2:00 in Berlin yesterday's event still took sign-ups
const localToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const lastDay = (event) => String(event?.endDate || '').trim() || String(event?.date || '').trim();
const isEventOver = (event, today = localToday()) => lastDay(event) !== '' && lastDay(event) < today;

/** { name, email, age } of a sign-up form, or { error } with the first thing that is missing or wrong. */
function readGuestInput(body) {
  const name = String(body?.name ?? '').replace(/\s+/g, ' ').trim();
  const email = String(body?.email ?? '').trim();
  const age = String(body?.age ?? '').trim();
  if (name.length < 2 || name.length > MAX_NAME_LENGTH) return { error: 'Please enter your full name.' };
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) return { error: 'Please enter a valid e-mail address.' };
  if (!/^\d{1,3}$/.test(age) || Number(age) > MAX_AGE) return { error: 'Please enter your age as a number.' };
  return { name, email, age: Number(age) };
}

const sameEmail = (guest, input) => String(guest.email || '').trim().toLowerCase() === input.email.toLowerCase();

/** The same person signed up twice: same name and e-mail address (a parent may sign up several children). */
const isSameGuest = (guest, input) => String(guest.name || '').trim().toLowerCase() === input.name.toLowerCase() && sameEmail(guest, input);

/** True once [MAX_GUESTS_PER_EMAIL] people of one event share the address of [input]. */
const isEmailFull = (guests, input) => guests.filter((guest) => sameEmail(guest, input)).length >= MAX_GUESTS_PER_EMAIL;

/**
 * What everyone with the link sees of an event: what, when, where and the places. Never the organiser, the groups,
 * the participants, the duty roster or any id.
 */
function publicEventView(event, counts, today = localToday()) {
  const max = typeof event.maxParticipants === 'number' && event.maxParticipants > 0 ? event.maxParticipants : 0;
  const cancelled = event.status === 'cancelled';
  const over = isEventOver(event, today);
  const requiresRegistration = event.requiresRegistration === true;
  return {
    title: event.title || '',
    eventType: (event.eventType || (event.isRecurring ? 'termin' : 'event')) === 'termin' ? 'termin' : 'event',
    isPinned: event.isPinned === true,
    date: event.date || '',
    endDate: event.endDate || '',
    startTime: event.startTime || '',
    endTime: event.endTime || '',
    location: event.location || '',
    description: event.description || '',
    imageUrl: event.imageUrl || '',
    status: cancelled ? 'cancelled' : 'scheduled',
    isPast: over,
    requiresRegistration,
    minParticipants: typeof event.minParticipants === 'number' && event.minParticipants > 0 ? event.minParticipants : 0,
    maxParticipants: max,
    registeredCount: counts.registered,
    isFull: max > 0 && counts.registered >= max,
    registrationOpen: requiresRegistration && !cancelled && !over
  };
}

// Same readable name as the web app gives an event (assets/app.js slugify); the share key finds the event
const slugify = (text) => String(text || '').normalize('NFC').trim().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80);

/** Address of an event's page for the guest with [key] (their e-mails link it: see, share or cancel). */
const guestPagePath = (event, key) => `/events/${encodeURIComponent(slugify(event.title) || 'event')}?guest=${encodeURIComponent(key)}`;

/**
 * E-mail to a guest about their place: 'registered', 'waitlist', 'promoted' (moved up from the waiting list) or
 * 'removed' (by the organisers). Only when SMTP is set up; never throws.
 */
async function sendGuestEmail(guest, event, kind, origin) {
  const { context, formatEventMoment } = require('./context');
  const { sendNotificationEmail } = require('./notify');
  const { translator, normalizeLanguage, instanceLanguage } = require('./i18n');
  const lang = normalizeLanguage(guest.language) || instanceLanguage();
  const tr = translator(lang);
  const appName = context.appConfig?.appName || 'Agora';
  const title = event.title || tr('Event');
  const texts = {
    registered: {
      subject: tr('You are registered: {title}', { title }),
      heading: tr('You are registered'),
      line: tr('Thank you for signing up for "{title}". We look forward to seeing you!', { title })
    },
    waitlist: {
      subject: tr('Waiting list: {title}', { title }),
      heading: tr('You are on the waiting list'),
      line: tr('"{title}" is fully booked at the moment. You will get an e-mail as soon as a place becomes free for you.', { title })
    },
    promoted: {
      subject: tr('A place for you: {title}', { title }),
      heading: tr('A place became free for you'),
      line: tr('You moved up from the waiting list and are now registered for "{title}".', { title })
    },
    removed: {
      subject: tr('Registration removed: {title}', { title }),
      heading: tr('Your registration was removed'),
      line: tr('The organisers removed your registration for "{title}".', { title })
    }
  }[kind];
  if (!texts) return false;
  // The guest's own page (the event, their place, cancelling); a removed guest has none any more
  const ownPage = kind !== 'removed';
  return sendNotificationEmail({ email: guest.email, name: guest.name }, {
    subject: texts.subject,
    heading: texts.heading,
    lines: [texts.line],
    rows: [
      [tr('Event'), title],
      [tr('Date'), formatEventMoment(event, lang)],
      ...(event.location ? [[tr('Location'), event.location]] : []),
      [tr('Name'), guest.name]
    ],
    actionLabel: tr('View or cancel the registration'),
    path: guestPagePath(event, guest.key),
    footer: tr('You get this e-mail because you signed up for "{title}" at {app}. Your details are only used for this event and are deleted {days} days after it.', { title, app: appName, days: GUEST_RETENTION_DAYS })
  }, ownPage ? origin : '', lang);
}

const escapeAttr = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Head of a shared event's page for link previews (messengers read these tags): the event's title, [when] and where,
 * and its picture. Not for search engines: the event is meant for whoever got the link.
 */
function linkPreviewHead(event, { origin = '', appName = 'Agora', when = '', url = '' } = {}) {
  const description = [when, event.location].filter(Boolean).join(' · ');
  const image = /^\/api\/events\/images\//.test(event.imageUrl || '') && origin ? `${origin}${event.imageUrl}` : '';
  const meta = (attr, name, content) => (content ? `\n    <meta ${attr}="${name}" content="${escapeAttr(content)}">` : '');
  return `<title>${escapeAttr(`${event.title || ''} · ${appName}`)}</title>`
    + meta('name', 'robots', 'noindex, nofollow')
    + meta('name', 'description', description)
    + meta('property', 'og:type', 'website')
    + meta('property', 'og:site_name', appName)
    + meta('property', 'og:title', event.title || appName)
    + meta('property', 'og:description', description)
    + meta('property', 'og:url', url)
    + meta('property', 'og:image', image)
    + meta('name', 'twitter:card', image ? 'summary_large_image' : 'summary');
}

/** Tells the guests who moved up from the waiting list (after answering: e-mails must not hold up the answer). */
function tellPromotedGuests(promoted, event, origin) {
  for (const guest of promoted || []) sendGuestEmail(guest, event, 'promoted', origin);
}

/** Guests whose event ended more than GUEST_RETENTION_DAYS ago or no longer exists. */
function expiredGuests(guests, eventsById, today = localToday()) {
  const [y, m, d] = today.split('-').map(Number);
  const cutoff = new Date(Date.UTC(y, m - 1, d - GUEST_RETENTION_DAYS)).toISOString().split('T')[0];
  return guests.filter((guest) => {
    const event = eventsById.get(guest.event);
    if (!event) return true;
    const end = lastDay(event);
    return end !== '' && end < cutoff;
  });
}

/** Daily cleanup: deletes the details of guests whose event is over for the retention period (or deleted). */
async function purgeExpiredGuests(appConfig, today = localToday()) {
  if (!appConfig) return 0;
  try {
    const [guests, events] = await Promise.all([listEventGuests(appConfig), listEvents(appConfig)]);
    const expired = expiredGuests(guests, new Map(events.map((ev) => [ev.id, ev])), today);
    for (const guest of expired) await deleteEventGuest(appConfig, guest.id);
    if (expired.length) console.log(`[Guests] Deleted ${expired.length} guest registration(s) of past events`);
    return expired.length;
  } catch (error) {
    console.error('[Guests] Cleanup failed:', error.message);
    return 0;
  }
}

module.exports = {
  GUEST_RETENTION_DAYS,
  MAX_GUESTS_PER_EMAIL,
  newPublicToken,
  newGuestKey,
  isPublicToken,
  isGuestKey,
  localToday,
  isEventOver,
  readGuestInput,
  isSameGuest,
  isEmailFull,
  publicEventView,
  slugify,
  guestPagePath,
  sendGuestEmail,
  linkPreviewHead,
  tellPromotedGuests,
  expiredGuests,
  purgeExpiredGuests
};
