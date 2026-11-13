// Order of service ("Ablauf") of an event: the items in their order, each with a duration; the app adds the
// times up from the start of the event. An item can be a song from the songbook (with the key the band plays).
// Seen by the people who see the duty roster, edited by those who may edit the event.
const crypto = require('crypto');
const { cleanKey } = require('./songbook');

const MAX_ITEMS = 60;
const MAX_MINUTES = 600;

const cleanLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** Validates the items of an order of service; returns { items } or { error }. */
function buildProgram(input) {
  const raw = Array.isArray(input?.items) ? input.items : null;
  if (!raw) return { error: 'The order of service is missing.' };
  if (raw.length > MAX_ITEMS) return { error: 'An order of service can have at most 60 items.' };
  const items = [];
  const ids = new Set();
  for (const entry of raw) {
    const songId = isId(entry?.songId) ? entry.songId : '';
    const title = cleanLine(entry?.title, 120);
    if (!title && !songId) return { error: 'Every item needs a title.' };
    const minutes = entry?.minutes === '' || entry?.minutes === null || entry?.minutes === undefined ? null : Number(entry.minutes);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_MINUTES)) {
      return { error: 'A duration is a whole number of minutes between 0 and 600.' };
    }
    const id = isId(entry?.id) && !ids.has(entry.id) ? entry.id : crypto.randomUUID();
    ids.add(id);
    items.push({
      id,
      title,
      minutes,
      who: cleanLine(entry?.who, 80),
      note: String(entry?.note ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 300),
      songId,
      // An unknown key is simply not kept (the song's own key applies)
      songKey: songId ? cleanKey(entry?.songKey) || '' : ''
    });
  }
  return { items };
}

module.exports = { MAX_ITEMS, MAX_MINUTES, buildProgram };
