// Prayer requests (Extras). Every member sees every request; a request can be shared anonymously. Like the polls,
// the server keeps no plain link between an account and an anonymous request: the owner is stored as a keyed hash
// (HMAC with a secret in a file next to the database). Named requests also keep the author's id and name, so their
// picture and name can be shown.
//
// A request runs for a chosen time (a week, a month, three months); the owner extends it or removes it when it is
// done. Members with the manage_prayers permission can remove any request. Expired requests stay visible to their
// owner for a while (to extend them), then they disappear on their own.
const crypto = require('crypto');

const DAY = 24 * 60 * 60 * 1000;
const DURATIONS = { week: 7 * DAY, month: 30 * DAY, quarter: 90 * DAY };
const MAX_TEXT = 1000;
/** Open requests per person and requests in total (expired ones count until they are gone). */
const MAX_OPEN_PER_OWNER = 10;
const MAX_PRAYERS = 500;
/** How long expired requests stay for their owner to extend. */
const KEEP_EXPIRED_MS = 14 * DAY;

const keyedHash = (secret, purpose, id, uid) =>
  crypto.createHmac('sha256', secret).update(`prayer-${purpose}:${id}:${uid}`).digest('hex');

const canModerate = (user) => Array.isArray(user?.permissions) && user.permissions.includes('manage_prayers');

/** Line breaks are kept (a request may have paragraphs), runs of empty lines are not. */
const cleanText = (value, max) => String(value ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim()
  .slice(0, max);

const isOpen = (prayer, now) => now < prayer.expiresAt;
const isMine = (prayer, uid, secret) => prayer.owner === keyedHash(secret, 'owner', prayer.id, uid);

/** Validates a new request; returns { prayer } or { error }. */
function buildPrayer(input, { uid, name, secret, now = Date.now(), id = crypto.randomUUID() }) {
  const text = cleanText(input?.text, MAX_TEXT);
  const duration = DURATIONS[input?.duration] ? input.duration : 'month';
  if (text.length < 3) return { error: 'Please write your request (at least 3 characters).' };
  const anonymous = input?.anonymous === true;
  return {
    prayer: {
      id,
      text,
      anonymous,
      authorUid: anonymous ? null : uid,
      authorName: anonymous ? null : String(name || '').trim().slice(0, 120),
      owner: keyedHash(secret, 'owner', id, uid),
      createdAt: now,
      expiresAt: now + DURATIONS[duration]
    }
  };
}

/** Whether [uid] may share another request: a few open ones per person, and a cap in total. */
function canCreate(prayers, { uid, secret, now = Date.now() }) {
  if (prayers.length >= MAX_PRAYERS) return { error: 'There are too many prayer requests right now.', status: 409 };
  const open = prayers.filter((prayer) => isOpen(prayer, now) && isMine(prayer, uid, secret));
  if (open.length >= MAX_OPEN_PER_OWNER) return { error: 'You already have 10 open prayer requests.', status: 409 };
  return null;
}

/** The owner's change: a new running time (from the later of now and the old end). */
function ownerUpdate(prayer, input, { now = Date.now() } = {}) {
  const next = { ...prayer };
  if (DURATIONS[input?.extend]) next.expiresAt = Math.max(now, prayer.expiresAt) + DURATIONS[input.extend];
  return { prayer: next };
}

/** Expired requests are kept for a while for their owner, then removed. */
const isGone = (prayer, now = Date.now()) => now - prayer.expiresAt > KEEP_EXPIRED_MS;

/** What a member sees: never the owner hash; expired requests only their owner. */
function publicPrayer(prayer, { uid, secret, now = Date.now(), moderator = false }) {
  const mine = isMine(prayer, uid, secret);
  return {
    id: prayer.id,
    text: prayer.text,
    anonymous: prayer.anonymous,
    author: prayer.anonymous ? null : { uid: prayer.authorUid, name: prayer.authorName },
    createdAt: prayer.createdAt,
    expiresAt: prayer.expiresAt,
    expired: now >= prayer.expiresAt,
    isMine: mine,
    canDelete: mine || moderator
  };
}

/** The list for one member: the running requests (newest first), plus their own expired ones. */
function visiblePrayers(prayers, { uid, secret, now = Date.now(), moderator = false }) {
  return prayers
    .filter((prayer) => !isGone(prayer, now))
    .filter((prayer) => now < prayer.expiresAt || isMine(prayer, uid, secret))
    .map((prayer) => publicPrayer(prayer, { uid, secret, now, moderator }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

module.exports = {
  DURATIONS, MAX_OPEN_PER_OWNER, MAX_PRAYERS, KEEP_EXPIRED_MS,
  canModerate, buildPrayer, canCreate, ownerUpdate, isMine, isOpen, isGone, publicPrayer, visiblePrayers
};
