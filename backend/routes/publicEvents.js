// Shared events without an account. Everyone with the link of an event whose share switch is on sees what, when
// and where; when the event takes registrations they sign up with name, e-mail address and age. Each guest gets
// an own random key (kept in their browser, linked in their e-mails) to see or cancel their place - also after
// the switch was turned off again.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { context, pageRateLimit, broadcastDataUpdate } = require('../context');
const { findEventByPublicToken, getEventRecord, findEventGuestByKey, createEventGuest, deleteEventGuest } = require('../pocketbase');
const { seatCounts, isBookedOut, withEventSeats, loadSeats, fillFreeSeats } = require('../eventSeats');
const {
  isPublicToken,
  isGuestKey,
  newGuestKey,
  readGuestInput,
  isSameGuest,
  isEventOver,
  publicEventView,
  sendGuestEmail,
  tellPromotedGuests
} = require('../eventGuests');
const { originOf } = require('../notify');
const { requestLanguage } = require('../i18n');

const router = express.Router();

// Signing up and cancelling without an account: enough for a family, too little for a flood of fake guests
const guestWriteRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' }
});

const LINK_INACTIVE = 'This link is not active.';
const REGISTRATION_GONE = 'This registration no longer exists.';

/** The event of a share link while its switch is on, else null. */
async function sharedEvent(token) {
  if (!isPublicToken(token)) return null;
  const event = await findEventByPublicToken(context.appConfig, token);
  return event && event.isPublic === true ? event : null;
}

async function viewOf(event) {
  const { memberRegs, guests } = await loadSeats(context.appConfig, event.id);
  return publicEventView(event, seatCounts(memberRegs, guests));
}

router.get('/api/public/events/:token', pageRateLimit, async (req, res) => {
  try {
    const event = await sharedEvent(req.params.token);
    if (!event) return res.status(404).json({ error: LINK_INACTIVE });
    res.json(await viewOf(event));
  } catch (err) {
    console.error('Failed to load a shared event:', err);
    res.status(500).json({ error: 'The event could not be loaded' });
  }
});

router.post('/api/public/events/:token/register', guestWriteRateLimit, async (req, res) => {
  try {
    const event = await sharedEvent(req.params.token);
    if (!event) return res.status(404).json({ error: LINK_INACTIVE });
    if (!event.requiresRegistration) return res.status(400).json({ error: 'This event does not require registration' });
    if (event.status === 'cancelled') return res.status(400).json({ error: 'This event was cancelled.' });
    if (isEventOver(event)) return res.status(400).json({ error: 'This event is already over. Registration is no longer possible.' });
    // A field people never see: only bots fill it in
    if (String(req.body?.website ?? '').trim()) return res.status(400).json({ error: 'Registration failed' });
    const input = readGuestInput(req.body);
    if (input.error) return res.status(400).json({ error: input.error });

    const result = await withEventSeats(event.id, async () => {
      const { memberRegs, guests } = await loadSeats(context.appConfig, event.id);
      if (guests.some((guest) => isSameGuest(guest, input))) return { duplicate: true };
      const status = isBookedOut(event, seatCounts(memberRegs, guests).registered) ? 'waitlist' : 'registered';
      const guest = await createEventGuest(context.appConfig, {
        event: event.id,
        name: input.name,
        email: input.email,
        age: input.age,
        status,
        key: newGuestKey(),
        // E-mails to the guest in the language of the page they signed up on
        language: requestLanguage(req)
      });
      return { guest };
    });
    if (result.duplicate) return res.status(409).json({ error: 'This person is already signed up for this event.' });

    broadcastDataUpdate('events');
    const { guest } = result;
    // emailed: a confirmation is on its way (only when the server can send e-mails)
    const emailed = Boolean(context.transporter && context.appConfig?.smtp?.user);
    res.status(201).json({ key: guest.key, name: guest.name, status: guest.status, emailed, event: await viewOf(event) });
    sendGuestEmail(guest, event, guest.status, originOf(req));
  } catch (err) {
    console.error('Failed to register a guest:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// A guest's own places (keys from their browser or e-mail): status and the event, also when the share switch was
// turned off since. The share link only while it is active.
router.post('/api/public/guests/lookup', pageRateLimit, async (req, res) => {
  try {
    const keys = Array.isArray(req.body?.keys) ? [...new Set(req.body.keys.filter(isGuestKey))].slice(0, 20) : [];
    const events = new Map();
    const registrations = [];
    for (const key of keys) {
      const guest = await findEventGuestByKey(context.appConfig, key);
      if (!guest) continue;
      if (!events.has(guest.event)) {
        const event = await getEventRecord(context.appConfig, guest.event);
        events.set(guest.event, event ? { event, view: await viewOf(event) } : null);
      }
      const found = events.get(guest.event);
      if (!found) continue;
      registrations.push({
        key,
        name: guest.name,
        status: guest.status,
        shareToken: found.event.isPublic === true ? found.event.publicToken || '' : '',
        event: found.view
      });
    }
    res.json({ registrations });
  } catch (err) {
    console.error('Failed to look up guest registrations:', err);
    res.status(500).json({ error: 'The registration could not be loaded' });
  }
});

router.post('/api/public/guests/cancel', guestWriteRateLimit, async (req, res) => {
  try {
    const key = req.body?.key;
    const guest = isGuestKey(key) ? await findEventGuestByKey(context.appConfig, key) : null;
    if (!guest) return res.status(404).json({ error: REGISTRATION_GONE });
    const event = await getEventRecord(context.appConfig, guest.event);
    const promoted = await withEventSeats(guest.event, async () => {
      // Gone already (cancelled twice at once, removed by the organisers): nothing left to free
      if (!(await findEventGuestByKey(context.appConfig, key))) return [];
      await deleteEventGuest(context.appConfig, guest.id);
      return event ? fillFreeSeats(context.appConfig, event) : [];
    });
    broadcastDataUpdate('events');
    res.json({ success: true, status: 'cancelled' });
    if (event) tellPromotedGuests(promoted, event, originOf(req));
  } catch (err) {
    console.error('Failed to cancel a guest registration:', err);
    res.status(500).json({ error: 'The registration could not be cancelled' });
  }
});

module.exports = router;
