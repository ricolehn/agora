// The rules of the mentoring, shared by the routes of API v1 (routes/mentoring.js) and v2 (v2/community.js): when a
// conversation is closed or blocked, how many people a mentor takes, and how the mentor and an unreadable message
// read. Pure: the routes load the records and answer.
const { DECRYPTION_FAILED } = require('./mentoringCrypto');
const { translate } = require('./i18n');
const { fullName } = require('./utils/names');

// What a mentor takes at once until they choose their own number
const DEFAULT_MAX_MENTEES = 3;

/** Blocked by one of the two: the status remembers who (blocked_<uid>), only they can open it again. */
const isBlockedStatus = (status) => typeof status === 'string' && status.startsWith('blocked_');

/** Over for both: ended, or blocked. */
const isClosedStatus = (status) => status === 'closed' || isBlockedStatus(status);

/** How many people [mentor] takes at once. */
const maxMenteesOf = (mentor) => (typeof mentor?.max_mentees === 'number' ? mentor.max_mentees : DEFAULT_MAX_MENTEES);

/** The open conversations of each mentor (by account id) among [threads]. */
function openConversationsByMentor(threads) {
  const open = new Map();
  for (const thread of threads) {
    if (thread.mentor && !isClosedStatus(thread.status)) open.set(thread.mentor, (open.get(thread.mentor) || 0) + 1);
  }
  return open;
}

/** Takes nobody new: as many open conversations as they take, or not taking anyone right now. */
const isFull = (mentor, openCount) => openCount >= maxMenteesOf(mentor) || mentor.is_accepting === false;

/** The mentor's name in the conversations ('Mentor' without an account or a name). */
const mentorNameOf = (user) => fullName(user) || 'Mentor';

/** A message's text for a reader of [lang]: one that could not be decrypted says so in their language. */
const readableText = (text, lang) => (text === DECRYPTION_FAILED ? translate(lang, text) : text);

module.exports = {
  DEFAULT_MAX_MENTEES, isBlockedStatus, isClosedStatus, maxMenteesOf, openConversationsByMentor, isFull, mentorNameOf, readableText
};
