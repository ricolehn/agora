// Anonymous polls. Votes are only counted: the server keeps one tally per option and nothing that links an
// account to an option. To stop double votes it keeps a keyed hash of "who took part" (HMAC with a secret that
// lives in a file next to the database, not in it); the creator is stored the same way, so only they (and admins)
// can end or delete a poll. Results are shown after the end, and only with enough votes to stay anonymous.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const MIN_RESULT_VOTES = 3;
const MAX_DURATION_MS = 366 * 24 * 60 * 60 * 1000;
const MIN_DURATION_MS = 5 * 60 * 1000;

function loadSecret(dataDir) {
  const file = path.join(dataDir, 'polls-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* created below */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

const keyedHash = (secret, purpose, pollId, uid) =>
  crypto.createHmac('sha256', secret).update(`${purpose}:${pollId}:${uid}`).digest('hex');

const cleanText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Validates a new poll; returns { poll } or { error }. */
function buildPoll(input, { uid, secret, now = Date.now(), id = crypto.randomUUID() }) {
  const title = cleanText(input?.title, 120);
  const description = String(input?.description ?? '').trim().slice(0, 1000);
  const texts = (Array.isArray(input?.options) ? input.options : []).map((text) => cleanText(text, 100)).filter(Boolean);
  const unique = [...new Set(texts.map((text) => text.toLowerCase()))];
  const endsAt = Number(input?.endsAt);
  if (title.length < 3) return { error: 'Please enter a question with at least 3 characters.' };
  if (texts.length < MIN_OPTIONS || texts.length > MAX_OPTIONS) return { error: 'A poll needs 2 to 10 answers.' };
  if (unique.length !== texts.length) return { error: 'Every answer may only appear once.' };
  if (!Number.isFinite(endsAt) || endsAt < now + MIN_DURATION_MS || endsAt > now + MAX_DURATION_MS) {
    return { error: 'The end has to be between 5 minutes and one year in the future.' };
  }
  const options = texts.map((text, index) => ({ id: `o${index + 1}`, text }));
  return {
    poll: {
      id,
      title,
      description,
      options,
      multiple: input?.multiple === true,
      createdAt: now,
      endsAt,
      creator: keyedHash(secret, 'creator', id, uid),
      tallies: Object.fromEntries(options.map((option) => [option.id, 0])),
      voters: []
    }
  };
}

/** Applies a vote; returns { poll } or { error, status }. The ballot is only added to the counters. */
function castVote(poll, optionIds, { uid, secret, now = Date.now() }) {
  if (!poll) return { error: 'Poll not found', status: 404 };
  if (now >= poll.endsAt) return { error: 'This poll has ended.', status: 400 };
  const voter = keyedHash(secret, 'voter', poll.id, uid);
  if (poll.voters.includes(voter)) return { error: 'You have already voted in this poll.', status: 409 };
  const valid = new Set(poll.options.map((option) => option.id));
  const chosen = [...new Set((Array.isArray(optionIds) ? optionIds : []).map(String))].filter((id) => valid.has(id));
  if (chosen.length === 0) return { error: 'Please choose an answer.', status: 400 };
  if (!poll.multiple && chosen.length > 1) return { error: 'Only one answer is possible in this poll.', status: 400 };
  const tallies = { ...poll.tallies };
  chosen.forEach((id) => { tallies[id] = (tallies[id] || 0) + 1; });
  // The participation list is kept in random order, so its order says nothing about when someone voted
  const voters = [...poll.voters];
  voters.splice(crypto.randomInt(voters.length + 1), 0, voter);
  return { poll: { ...poll, tallies, voters } };
}

const isMine = (poll, uid, secret) => poll.creator === keyedHash(secret, 'creator', poll.id, uid);

/** What a member sees: never the creator or the participation list; results only after the end. */
function publicPoll(poll, { uid, secret, now = Date.now() }) {
  const closed = now >= poll.endsAt;
  const participants = poll.voters.length;
  const enough = participants >= MIN_RESULT_VOTES;
  return {
    id: poll.id,
    title: poll.title,
    description: poll.description,
    options: poll.options,
    multiple: poll.multiple,
    createdAt: poll.createdAt,
    endsAt: poll.endsAt,
    closed,
    participants,
    hasVoted: poll.voters.includes(keyedHash(secret, 'voter', poll.id, uid)),
    isMine: isMine(poll, uid, secret),
    results: closed && enough ? { counts: poll.tallies, participants } : null,
    tooFewVotes: closed && !enough
  };
}

module.exports = { MIN_RESULT_VOTES, loadSecret, buildPoll, castVote, publicPoll, isMine };
