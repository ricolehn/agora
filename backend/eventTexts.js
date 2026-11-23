// How an event reads in a message - a push, an e-mail, a shared link's preview: its moment, the short form of a push
// and the line of facts a push body is.
const { translate, localeOf } = require('./i18n');

/** "Sat, 7 Nov 2026, 19:00 – 21:00" in the reader's language (no time zone conversion: event times are local). */
function formatEventMoment(event, lang) {
  const [y, m, d] = String(event?.date || '').split('-').map(Number);
  const date = y && m && d
    ? new Intl.DateTimeFormat(localeOf(lang), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
    : (event?.date || translate(lang, 'No date'));
  const start = event?.startTime || event?.time;
  return start ? `${date}, ${start}${event.endTime ? ` – ${event.endTime}` : ''}` : date;
}

/**
 * The short form for push messages: "Sun 1 Nov, 10:00" ("So., 1. Nov., 10:00"), with the year only when it is not
 * this year's; no end time. '' without a date.
 */
function formatEventShort(event, lang, now = new Date()) {
  const [y, m, d] = String(event?.date || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const options = { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC', ...(y !== now.getUTCFullYear() ? { year: 'numeric' } : {}) };
  const date = new Intl.DateTimeFormat(localeOf(lang), options).format(new Date(Date.UTC(y, m - 1, d)));
  const start = event?.startTime || event?.time;
  return start ? `${date}, ${start}` : date;
}

/** Push bodies are facts, not sentences: "Sunday service · Sun 1 Nov, 10:00 · Main hall" (empty parts left out). */
const pushLine = (...parts) => parts.filter(Boolean).join(' · ');

module.exports = { formatEventMoment, formatEventShort, pushLine };
