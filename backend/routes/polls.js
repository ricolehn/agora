const express = require('express');
const {
  context,
  dataDir,
  verifyToken,
  protectedActionRateLimit,
  broadcastDataUpdate
} = require('../context');
const { createItemStore } = require('../itemStore');
const { buildPoll, castVote, publicPoll, isMine, endPoll, sealIfTooFew, canCreate } = require('../polls');
const { instanceSecret } = require('../instanceSecret');
const { isAdmin } = require('../permissions');
const { route } = require('./http');

const router = express.Router();
const store = createItemStore('polls');

// A damaged secret makes polls unusable, it is never silently replaced (instanceSecret.js)
const pollSecret = instanceSecret(dataDir, 'polls-secret', 'Polls are not available right now.');

const view = (poll, req) => publicPoll(poll, { uid: req.user.uid, secret: pollSecret() });

const notFound = (res) => res.status(404).json({ error: 'Poll not found' });

router.get('/api/polls', verifyToken, route('Polls could not be loaded', async (req, res) => {
  const now = Date.now();
  const polls = await store.list(context.appConfig);
  // Polls that ran out with too few votes lose their tallies for good the first time anyone looks
  for (const poll of polls) {
    if (sealIfTooFew(poll, now) !== poll) {
      await store.update(context.appConfig, poll.id, (current) => (current ? { save: sealIfTooFew(current, now) } : {}));
    }
  }
  const list = polls
    .map((poll) => publicPoll(poll, { uid: req.user.uid, secret: pollSecret(), now }))
    .sort((a, b) => (a.closed - b.closed) || (a.closed ? b.endsAt - a.endsAt : a.endsAt - b.endsAt));
  res.json(list);
}));

router.post('/api/polls', protectedActionRateLimit, verifyToken, route('The poll could not be created', async (req, res) => {
  const { poll, error } = buildPoll(req.body, { uid: req.user.uid, secret: pollSecret() });
  if (error) return res.status(400).json({ error });
  const limit = canCreate(await store.list(context.appConfig), { uid: req.user.uid, secret: pollSecret() });
  if (limit) return res.status(limit.status).json({ error: limit.error });
  await store.update(context.appConfig, poll.id, () => ({ save: poll }));
  broadcastDataUpdate('polls');
  res.status(201).json(view(poll, req));
}));

router.post('/api/polls/:id/vote', protectedActionRateLimit, verifyToken, route('The vote could not be saved', async (req, res) => {
  if (!store.isValidKey(req.params.id)) return notFound(res);
  const result = await store.update(context.appConfig, req.params.id, (poll) => {
    const outcome = castVote(poll, req.body?.optionIds, { uid: req.user.uid, secret: pollSecret() });
    return outcome.error ? outcome : { ...outcome, save: outcome.poll };
  });
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  // No live update per vote: it would tell everyone the moment each person voted
  res.json(view(result.poll, req));
}));

// End a poll now (creator or admin); the results show right away if there are enough votes
router.post('/api/polls/:id/close', protectedActionRateLimit, verifyToken, route('The poll could not be ended', async (req, res) => {
  if (!store.isValidKey(req.params.id)) return notFound(res);
  const result = await store.update(context.appConfig, req.params.id, (poll) => {
    if (!poll) return { error: 'Poll not found', status: 404 };
    if (!isMine(poll, req.user.uid, pollSecret()) && !isAdmin(req.user)) return { error: 'Only the person who created the poll can end it.', status: 403 };
    const ended = endPoll(poll);
    return { poll: ended, save: ended };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  broadcastDataUpdate('polls');
  res.json(view(result.poll, req));
}));

router.delete('/api/polls/:id', protectedActionRateLimit, verifyToken, route('The poll could not be deleted', async (req, res) => {
  if (!store.isValidKey(req.params.id)) return notFound(res);
  const result = await store.update(context.appConfig, req.params.id, (poll) => {
    if (!poll) return { error: 'Poll not found', status: 404 };
    if (!isMine(poll, req.user.uid, pollSecret()) && !isAdmin(req.user)) return { error: 'Only the person who created the poll can delete it.', status: 403 };
    return { remove: true };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  broadcastDataUpdate('polls');
  res.json({ success: true });
}));

module.exports = router;
