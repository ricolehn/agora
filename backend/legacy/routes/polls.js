const express = require('express');
const {
  context,
  dataDir,
  verifyToken,
  protectedActionRateLimit,
  broadcastDataUpdate
} = require('../context');
const { createItemStore } = require('../itemStore');
const { loadSecret, buildPoll, castVote, publicPoll, isMine, endPoll, sealIfTooFew, canCreate } = require('../polls');

const router = express.Router();
const store = createItemStore('polls');

let secret = null;
const pollSecret = () => (secret ||= loadSecret(dataDir));

const userId = (req) => req.user?.uid || req.user?.id;
const isAdmin = (req) => req.user?.admin === true || req.user?.owner === true || req.user?.superAdmin === true;
const view = (poll, req) => publicPoll(poll, { uid: userId(req), secret: pollSecret() });

/** A missing or damaged poll secret makes polls unusable (never silently replaced, see polls.js). */
function failure(res, err, fallback) {
  if (/polls-secret/.test(err?.message || '')) {
    console.error('[Polls]', err.message);
    return res.status(503).json({ error: 'Polls are not available right now.' });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

const notFound = (res) => res.status(404).json({ error: 'Poll not found' });

router.get('/api/polls', verifyToken, async (req, res) => {
  try {
    const now = Date.now();
    const polls = await store.list(context.appConfig);
    // Polls that ran out with too few votes lose their tallies for good the first time anyone looks
    for (const poll of polls) {
      if (sealIfTooFew(poll, now) !== poll) {
        await store.update(context.appConfig, poll.id, (current) => (current ? { save: sealIfTooFew(current, now) } : {}));
      }
    }
    const list = polls
      .map((poll) => publicPoll(poll, { uid: userId(req), secret: pollSecret(), now }))
      .sort((a, b) => (a.closed - b.closed) || (a.closed ? b.endsAt - a.endsAt : a.endsAt - b.endsAt));
    res.json(list);
  } catch (err) {
    failure(res, err, 'Polls could not be loaded');
  }
});

router.post('/api/polls', protectedActionRateLimit, verifyToken, async (req, res) => {
  try {
    const { poll, error } = buildPoll(req.body, { uid: userId(req), secret: pollSecret() });
    if (error) return res.status(400).json({ error });
    const limit = canCreate(await store.list(context.appConfig), { uid: userId(req), secret: pollSecret() });
    if (limit) return res.status(limit.status).json({ error: limit.error });
    await store.update(context.appConfig, poll.id, () => ({ save: poll }));
    broadcastDataUpdate('polls');
    res.status(201).json(view(poll, req));
  } catch (err) {
    failure(res, err, 'The poll could not be created');
  }
});

router.post('/api/polls/:id/vote', protectedActionRateLimit, verifyToken, async (req, res) => {
  if (!store.isValidKey(req.params.id)) return notFound(res);
  try {
    const result = await store.update(context.appConfig, req.params.id, (poll) => {
      const outcome = castVote(poll, req.body?.optionIds, { uid: userId(req), secret: pollSecret() });
      return outcome.error ? outcome : { ...outcome, save: outcome.poll };
    });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    // No live update per vote: it would tell everyone the moment each person voted
    res.json(view(result.poll, req));
  } catch (err) {
    failure(res, err, 'The vote could not be saved');
  }
});

// End a poll now (creator or admin); the results show right away if there are enough votes
router.post('/api/polls/:id/close', protectedActionRateLimit, verifyToken, async (req, res) => {
  if (!store.isValidKey(req.params.id)) return notFound(res);
  try {
    const result = await store.update(context.appConfig, req.params.id, (poll) => {
      if (!poll) return { error: 'Poll not found', status: 404 };
      if (!isMine(poll, userId(req), pollSecret()) && !isAdmin(req)) return { error: 'Only the person who created the poll can end it.', status: 403 };
      const ended = endPoll(poll);
      return { poll: ended, save: ended };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    broadcastDataUpdate('polls');
    res.json(view(result.poll, req));
  } catch (err) {
    failure(res, err, 'The poll could not be ended');
  }
});

router.delete('/api/polls/:id', protectedActionRateLimit, verifyToken, async (req, res) => {
  if (!store.isValidKey(req.params.id)) return notFound(res);
  try {
    const result = await store.update(context.appConfig, req.params.id, (poll) => {
      if (!poll) return { error: 'Poll not found', status: 404 };
      if (!isMine(poll, userId(req), pollSecret()) && !isAdmin(req)) return { error: 'Only the person who created the poll can delete it.', status: 403 };
      return { remove: true };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    broadcastDataUpdate('polls');
    res.json({ success: true });
  } catch (err) {
    failure(res, err, 'The poll could not be deleted');
  }
});

module.exports = router;
