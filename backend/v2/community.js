// API v2: who is signed in, the groups, the songbook and mentoring (docs/API_V2.md). Reads come from the new tables;
// writes run the old API's own handlers (v1Route / runV1): the same checks, encryption and notifications as v1.
const express = require('express');
const { context, verifyToken, protectedActionRateLimit } = require('../context');
const { createItemStore } = require('../itemStore');
const { listGroupRecords, listMentoringThreadsForUser, listMentorRecords, listUserRecords, decryptMentoringText, getMentorByUserId, getMentoringThreadSummary } = require('../pocketbase');
const { translate, requestLanguage } = require('../i18n');
const { DECRYPTION_FAILED } = require('../mentoringCrypto');
const songbookRouter = require('../routes/songbook');
const mentoringRouter = require('../routes/mentoring');
const data = require('../v2Data');
const {
  notFound, needs, handle, bodyOf, textInput, requiredTextInput, wholeInput, boolInput, idInput, choiceInput,
  sortable, searchOf, matchesSearch, limitOf, storedCursorOf, storedPage, page, v1Route, runV1
} = require('./http');

const { isoFromMillis } = data;
const router = express.Router();
const BASE = '/api/v2';
const uidOf = (req) => data.uidOf(req.user);

// --- Who am I, the groups --------------------------------------------------------------------------------------------

router.get(`${BASE}/me`, verifyToken, handle(async (req, res) => {
  const groups = await listGroupRecords(context.appConfig).catch(() => []);
  const mine = new Set(req.user.groups || []);
  res.json({
    id: uidOf(req),
    email: req.user.email || '',
    firstName: req.user.firstName || '',
    lastName: req.user.lastName || '',
    name: req.user.name || '',
    isAdmin: req.user.admin === true,
    isOwner: req.user.owner === true,
    permissions: req.user.permissions || [],
    groups: groups.filter((group) => mine.has(group.id) || mine.has(group.name)).map((group) => ({ id: group.id, name: group.name })),
    language: req.user.language || null,
    timeZone: req.user.timeZone || null,
    // What the person may do, as the apps decide what to offer (the server checks every call itself)
    can: {
      viewFinances: req.user.canViewFinances === true,
      manageFinances: req.user.canManageFinances === true,
      manageEvents: req.user.canManageEvents === true || (req.user.permissions || []).includes('manage_events'),
      manageMentoring: req.user.canManageMentoring === true || (req.user.permissions || []).includes('manage_mentoring'),
      manageSongbook: (req.user.permissions || []).includes('manage_songbook'),
      useAi: req.user.canAccessAi === true || (req.user.permissions || []).includes('access_ai')
    }
  });
}));

router.get(`${BASE}/groups`, verifyToken, handle(async (req, res) => {
  const groups = (await listGroupRecords(context.appConfig)).map((group) => ({ id: group.id, name: group.name, permissions: group.permissions }));
  res.json(page(groups, req, (group) => sortable(group.name), { ascending: true }));
}));

// --- The songbook ----------------------------------------------------------------------------------------------------

const songOf = (song) => ({
  id: song.id, title: song.title || '', artist: song.artist || '', key: song.key || null, capo: song.capo ?? null, tempo: song.tempo ?? null,
  ccli: song.ccli || null, copyright: song.copyright || '', content: song.content || '', createdAt: isoFromMillis(song.createdAt), updatedAt: isoFromMillis(song.updatedAt)
});

const songs = () => createItemStore('songs').list(context.appConfig);

// In the order of their titles (A to Z); ?q= finds them by title, writer or words
router.get(`${BASE}/songs`, verifyToken, handle(async (req, res) => {
  const words = searchOf(req);
  const items = (await songs()).filter((song) => song && !Array.isArray(song)).map(songOf).filter((song) => matchesSearch(words, [song.title, song.artist, song.content]));
  // The church's CCLI licence number goes with every song the apps show
  res.json({ ...page(items, req, (song) => sortable(song.title), { ascending: true }), ccliLicense: context.appConfig?.ccliLicense || '' });
}));

router.get(`${BASE}/songs/:id`, verifyToken, handle(async (req, res) => {
  const song = (await songs()).find((candidate) => candidate && candidate.id === req.params.id);
  if (!song) throw notFound('There is no such song.');
  res.json({ ...songOf(song), ccliLicense: context.appConfig?.ccliLicense || '' });
}));

/** What a song sends, checked: the title and the text are needed when it is new. */
function songInput(body, { isNew }) {
  const song = {};
  if (isNew || body.title !== undefined) song.title = requiredTextInput(body, 'title', 120);
  for (const [key, limit] of [['artist', 120], ['copyright', 300]]) if (body[key] !== undefined) song[key] = textInput(body, key, limit);
  if (isNew || body.content !== undefined) song.content = body.content === undefined ? '' : textInput(body, 'content', 20000);
  if (body.key !== undefined) song.key = body.key === null ? '' : textInput(body, 'key', 4);
  if (body.ccli !== undefined) song.ccli = body.ccli === null ? '' : textInput(body, 'ccli', 12);
  if (body.capo !== undefined) song.capo = body.capo === null ? null : wholeInput(body.capo, 'capo', 0, 11);
  if (body.tempo !== undefined) song.tempo = body.tempo === null ? null : wholeInput(body.tempo, 'tempo', 20, 300);
  return song;
}

const createSongRoute = v1Route(songbookRouter, 'post', '/api/songs');
const updateSongRoute = v1Route(songbookRouter, 'put', '/api/songs/:id');
const deleteSongRoute = v1Route(songbookRouter, 'delete', '/api/songs/:id');

/** The song of v1's answer [body] (it hands back the song), read again in the shape of v2. */
async function songAnswer(id) {
  const song = (await songs()).find((candidate) => candidate && candidate.id === id);
  if (!song) throw notFound('There is no such song.');
  return songOf(song);
}

router.post(`${BASE}/songs`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const { body } = await runV1(createSongRoute, req, { body: songInput(bodyOf(req), { isNew: true }) });
  res.status(201).json(await songAnswer(body?.song?.id || body?.id));
}));

router.patch(`${BASE}/songs/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const current = (await songs()).find((candidate) => candidate && candidate.id === req.params.id);
  if (!current) throw notFound('There is no such song.');
  // v1 saves a song whole: what v2 does not change stays as it is
  const changes = songInput(bodyOf(req), { isNew: false });
  const whole = { title: current.title, artist: current.artist, key: current.key, capo: current.capo, tempo: current.tempo, ccli: current.ccli, copyright: current.copyright, content: current.content, ...changes };
  await runV1(updateSongRoute, req, { params: { id: req.params.id }, body: whole });
  res.json(await songAnswer(req.params.id));
}));

router.delete(`${BASE}/songs/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  await runV1(deleteSongRoute, req, { params: { id: req.params.id } });
  res.status(204).end();
}));

// --- Prayer requests ------------------------------------------------------------------------------------------------

const prayersRouter = require('../routes/prayers');
const prayersRoute = v1Route(prayersRouter, 'get', '/api/prayers');
const sharePrayerRoute = v1Route(prayersRouter, 'post', '/api/prayers');
const extendPrayerRoute = v1Route(prayersRouter, 'patch', '/api/prayers/:id');
const removePrayerRoute = v1Route(prayersRouter, 'delete', '/api/prayers/:id');
const PRAYER_DURATIONS = ['week', 'month', 'quarter'];

// A request shared anonymously names nobody - not even to the leaders (the server keeps no plain link to its owner)
const prayerOf = (prayer) => ({
  id: prayer.id,
  text: prayer.text,
  isAnonymous: prayer.anonymous === true,
  authorUserId: prayer.author?.uid || null,
  authorName: prayer.author?.name || null,
  createdAt: isoFromMillis(prayer.createdAt),
  expiresAt: isoFromMillis(prayer.expiresAt),
  isExpired: prayer.expired === true,
  isMine: prayer.isMine === true,
  canDelete: prayer.canDelete === true
});

// The running requests, newest first - and the person's own that ran out (to extend them for a while)
router.get(`${BASE}/prayers`, verifyToken, handle(async (req, res) => {
  const { body } = await runV1(prayersRoute, req);
  res.json({ ...page((body.prayers || []).map(prayerOf), req, (prayer) => prayer.createdAt || ''), canModerate: body.canModerate === true });
}));

// Shares one: text (3 to 1,000 characters), for a week, a month or three months, with the name or anonymously
router.post(`${BASE}/prayers`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const text = requiredTextInput(body, 'text', 1000);
  const duration = body.duration === undefined ? 'month' : choiceInput(body.duration, 'duration', PRAYER_DURATIONS);
  const anonymous = body.anonymous === undefined ? false : boolInput(body.anonymous, 'anonymous');
  const { body: shared } = await runV1(sharePrayerRoute, req, { body: { text, duration, anonymous } });
  res.status(201).json(prayerOf(shared));
}));

// Its owner extends it (extend: week, month or quarter, from when it runs out)
router.patch(`${BASE}/prayers/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const extend = choiceInput(bodyOf(req).extend, 'extend', PRAYER_DURATIONS);
  const { body } = await runV1(extendPrayerRoute, req, { params: { id: req.params.id }, body: { extend } });
  res.json(prayerOf(body));
}));

// Its owner, or who moderates the prayer requests
router.delete(`${BASE}/prayers/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  await runV1(removePrayerRoute, req, { params: { id: req.params.id } });
  res.status(204).end();
}));

// --- Mentoring ---------------------------------------------------------------------------------------------------------

// A blocked conversation is closed for both; its status remembers who blocked it (only they can open it again)
const isBlockedStatus = (status) => typeof status === 'string' && status.startsWith('blocked_');
const isClosedStatus = (status) => status === 'closed' || isBlockedStatus(status);
const nameOf = (user) => (user ? user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() : '');
const isMentoringManager = (req) => req.user.canManageMentoring === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_mentoring'));

/**
 * The mentors, by name: the approved ones, each with how many conversations they have open and whether they take
 * someone new (isFull). Those who manage mentoring also see the applications (?status=pending, rejected or all) and
 * the mentors' e-mail addresses, as in v1.
 */
router.get(`${BASE}/mentoring/mentors`, verifyToken, handle(async (req, res) => {
  const manager = isMentoringManager(req);
  const status = req.query.status === undefined || req.query.status === '' ? 'approved' : choiceInput(req.query.status, 'status', ['approved', 'pending', 'rejected', 'all']);
  needs(status === 'approved' || manager, 'Mentor management rights required');
  const [mentors, users] = await Promise.all([listMentorRecords(context.appConfig, status === 'all' ? '' : `status = ${JSON.stringify(status)}`), listUserRecords(context.appConfig)]);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const open = new Map();
  for (const thread of await listMentoringThreadsForUser(context.appConfig, mentors.map((mentor) => mentor.user)).catch(() => [])) {
    if (thread.mentor && !isClosedStatus(thread.status)) open.set(thread.mentor, (open.get(thread.mentor) || 0) + 1);
  }
  const items = mentors.map((mentor) => {
    const maxMentees = typeof mentor.max_mentees === 'number' ? mentor.max_mentees : 3;
    const activeMentees = open.get(mentor.user) || 0;
    return {
      id: mentor.id,
      userId: mentor.user,
      name: nameOf(usersById.get(mentor.user)),
      bio: mentor.bio || '',
      status: mentor.status || null,
      maxMentees: mentor.max_mentees || 0,
      isAccepting: mentor.is_accepting === true,
      activeMentees,
      isFull: activeMentees >= maxMentees || mentor.is_accepting === false,
      ...(manager ? { email: usersById.get(mentor.user)?.email || '' } : {})
    };
  });
  res.json(page(items, req, (mentor) => sortable(mentor.name), { ascending: true }));
}));

const mentorProfileOf = (mentor) => (mentor ? {
  id: mentor.id,
  status: mentor.status || null,
  bio: mentor.bio || '',
  maxMentees: typeof mentor.max_mentees === 'number' ? mentor.max_mentees : 3,
  isAccepting: mentor.is_accepting !== false
} : null);

// The person's own profile as a mentor (null: they never applied)
router.get(`${BASE}/mentoring/profile`, verifyToken, handle(async (req, res) => {
  res.json({ profile: mentorProfileOf(await getMentorByUserId(context.appConfig, uidOf(req))) });
}));

const applyRoute = v1Route(mentoringRouter, 'post', '/api/mentoring/apply');
const profileRoute = v1Route(mentoringRouter, 'put', '/api/mentoring/my-profile');
const mentorStatusRoute = v1Route(mentoringRouter, 'post', '/api/mentoring/manage/:id/status');

/** What a mentor's profile sends, checked. */
function profileInput(body) {
  const profile = {};
  if (body.bio !== undefined) profile.bio = textInput(body, 'bio', 2000);
  if (body.maxMentees !== undefined) profile.maxMentees = wholeInput(body.maxMentees, 'maxMentees', 1, 50);
  if (body.isAccepting !== undefined) profile.isAccepting = boolInput(body.isAccepting, 'isAccepting');
  return profile;
}

// To become a mentor: an application, which those who manage mentoring approve (applying again asks anew)
router.post(`${BASE}/mentoring/application`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const profile = profileInput(bodyOf(req));
  await runV1(applyRoute, req, { body: { bio: profile.bio || '', maxMentees: profile.maxMentees || 3 } });
  res.status(201).json({ profile: mentorProfileOf(await getMentorByUserId(context.appConfig, uidOf(req))) });
}));

router.patch(`${BASE}/mentoring/profile`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  await runV1(profileRoute, req, { body: profileInput(bodyOf(req)) });
  res.json({ profile: mentorProfileOf(await getMentorByUserId(context.appConfig, uidOf(req))) });
}));

// Those who manage mentoring approve or reject an application (or set it back to pending)
router.post(`${BASE}/mentoring/mentors/:id/status`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const status = choiceInput(bodyOf(req).status, 'status', ['approved', 'rejected', 'pending']);
  await runV1(mentorStatusRoute, req, { params: { id: idInput(req.params.id, 'id') }, body: { status } });
  res.json({ id: req.params.id, status });
}));

/** The reader's conversations (none without an account id: the lookup would take that for "all of them"). */
async function threadsOf(req) {
  const uid = uidOf(req);
  return uid ? listMentoringThreadsForUser(context.appConfig, uid) : [];
}

/** A conversation as the reader sees it: the mentee stays anonymous to the mentor (alias), as in v1. */
async function threadOf(req, thread, users) {
  const uid = uidOf(req);
  const isMentor = thread.mentor === uid;
  const { unreadCount, lastMessage } = await getMentoringThreadSummary(context.appConfig, thread.id, isMentor ? 'mentee' : 'mentor').catch(() => ({ unreadCount: 0, lastMessage: null }));
  const lang = requestLanguage(req);
  const lastText = lastMessage ? (lastMessage.text === DECRYPTION_FAILED ? translate(lang, lastMessage.text) : lastMessage.text).slice(0, 240) : (thread.last_message || '');
  const mentorName = nameOf(users.get(thread.mentor)) || 'Mentor';
  return {
    id: thread.id,
    role: isMentor ? 'mentor' : 'mentee',
    mentorUserId: thread.mentor,
    menteeAlias: thread.mentee_alias,
    status: thread.status,
    lastMessage: lastText,
    updatedAt: thread.updated || null,
    // Grown with what the apps show: whom it is with, closed or blocked (and by whom), what is unread
    title: isMentor ? (thread.mentee_alias || translate(lang, 'Anonymous seeker')) : mentorName,
    mentorName,
    isClosed: isClosedStatus(thread.status),
    isBlocked: isBlockedStatus(thread.status),
    isBlockedByMe: thread.status === `blocked_${isMentor ? 'mentor' : 'mentee'}`,
    unreadCount: unreadCount || 0,
    lastMessageAt: lastMessage?.created || null
  };
}

router.get(`${BASE}/mentoring/threads`, verifyToken, handle(async (req, res) => {
  const [threads, users] = await Promise.all([threadsOf(req), listUserRecords(context.appConfig)]);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const items = await Promise.all(threads.map((thread) => threadOf(req, thread, usersById)));
  res.json(page(items, req, (thread) => thread.updatedAt || ''));
}));

const startThreadRoute = v1Route(mentoringRouter, 'post', '/api/mentoring/threads');
const sendRoute = v1Route(mentoringRouter, 'post', '/api/mentoring/threads/:id/messages');
const threadStatusRoute = v1Route(mentoringRouter, 'patch', '/api/mentoring/threads/:id/status');
const readRoute = v1Route(mentoringRouter, 'get', '/api/mentoring/threads/:id/messages');

const MESSAGE_LIMIT = 10000;

/** One conversation of the reader, as v2 answers it. */
async function threadAnswer(req, id) {
  const thread = (await threadsOf(req)).find((candidate) => candidate.id === id);
  if (!thread) throw notFound('There is no such conversation.');
  const users = new Map((await listUserRecords(context.appConfig)).map((user) => [user.id, user]));
  return threadOf(req, thread, users);
}

// A mentee asks a mentor (mentorUserId: the mentor's account) - with a first message, if any
router.post(`${BASE}/mentoring/threads`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const mentorUserId = idInput(body.mentorUserId, 'mentorUserId');
  const message = body.message === undefined ? '' : textInput(body, 'message', MESSAGE_LIMIT);
  const { body: started } = await runV1(startThreadRoute, req, { body: { mentorId: mentorUserId, ...(message.trim() ? { initialMessage: message } : {}) } });
  res.status(201).json(await threadAnswer(req, started.threadId));
}));

// The messages, newest first - the next page goes further back (reading marks nothing as read: POST .../read does)
router.get(`${BASE}/mentoring/threads/:id/messages`, verifyToken, handle(async (req, res) => {
  const thread = (await threadsOf(req)).find((candidate) => candidate.id === req.params.id);
  if (!thread) throw notFound('There is no such conversation.');
  const { items, next } = await data.messagesPage(thread.id, { limit: limitOf(req), after: storedCursorOf(req) });
  const lang = requestLanguage(req);
  res.json(storedPage({
    items: items.map((message) => {
      const text = decryptMentoringText(message.text, thread.id);
      return { id: message.id, from: message.sender_role, text: text === DECRYPTION_FAILED ? translate(lang, text) : text, isRead: message.read === true, createdAt: message.created || null };
    }),
    next
  }));
}));

router.post(`${BASE}/mentoring/threads/:id/messages`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const text = requiredTextInput(bodyOf(req), 'text', MESSAGE_LIMIT);
  const { body } = await runV1(sendRoute, req, { params: { id: req.params.id }, body: { text } });
  const sent = body?.message || {};
  res.status(201).json({ id: sent.id, from: sent.senderRole, text: sent.text, isRead: false, createdAt: sent.created || null });
}));

// What the other one wrote is read (v1 does it when the app opens the conversation)
router.post(`${BASE}/mentoring/threads/:id/read`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  await runV1(readRoute, req, { params: { id: req.params.id } });
  res.json(await threadAnswer(req, req.params.id));
}));

// Close, open again or block a conversation (only who blocked it can open it again)
router.patch(`${BASE}/mentoring/threads/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const status = choiceInput(body.status, 'status', ['active', 'closed', 'blocked']);
  await runV1(threadStatusRoute, req, { params: { id: req.params.id }, body: { status } });
  res.json(await threadAnswer(req, req.params.id));
}));


module.exports = { router, RESOURCES: ['me', 'groups', 'songs', 'prayers', 'mentoring/mentors', 'mentoring/profile', 'mentoring/application', 'mentoring/threads'] };
