const express = require('express');
const {
  context,
  dataDir,
  verifyToken,
  protectedActionRateLimit,
  broadcastDataUpdate
} = require('../context');
const { getStateValue, upsertStateValue } = require('../pocketbase');
const { loadSecret, buildPoll, castVote, publicPoll, isMine } = require('../polls');

const router = express.Router();
const STATE_KEY = 'polls';

let secret = null;
const pollSecret = () => (secret ||= loadSecret(dataDir));

// Writes run one after another, so two votes at the same moment never overwrite each other's counter
let queue = Promise.resolve();
function withPolls(change) {
  const run = queue.then(async () => {
    const polls = (await getStateValue(context.appConfig, STATE_KEY, {})) || {};
    const result = await change(polls);
    if (result?.save) await upsertStateValue(context.appConfig, STATE_KEY, result.save);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

const userId = (req) => req.user?.uid || req.user?.id;
const isAdmin = (req) => req.user?.admin === true || req.user?.owner === true || req.user?.superAdmin === true;

router.get('/api/polls', verifyToken, async (req, res) => {
  try {
    const polls = (await getStateValue(context.appConfig, STATE_KEY, {})) || {};
    const now = Date.now();
    const list = Object.values(polls)
      .map((poll) => publicPoll(poll, { uid: userId(req), secret: pollSecret(), now }))
      .sort((a, b) => (a.closed - b.closed) || (a.closed ? b.endsAt - a.endsAt : a.endsAt - b.endsAt));
    res.json(list);
  } catch (err) {
    console.error('Failed to list polls:', err);
    res.status(500).json({ error: 'Polls could not be loaded' });
  }
});

router.post('/api/polls', protectedActionRateLimit, verifyToken, async (req, res) => {
  try {
    const { poll, error } = buildPoll(req.body, { uid: userId(req), secret: pollSecret() });
    if (error) return res.status(400).json({ error });
    await withPolls((polls) => ({ save: { ...polls, [poll.id]: poll } }));
    broadcastDataUpdate('polls');
    res.status(201).json(publicPoll(poll, { uid: userId(req), secret: pollSecret() }));
  } catch (err) {
    console.error('Failed to create poll:', err);
    res.status(500).json({ error: 'The poll could not be created' });
  }
});

router.post('/api/polls/:id/vote', protectedActionRateLimit, verifyToken, async (req, res) => {
  try {
    const result = await withPolls((polls) => {
      const outcome = castVote(polls[req.params.id], req.body?.optionIds, { uid: userId(req), secret: pollSecret() });
      return outcome.error ? outcome : { ...outcome, save: { ...polls, [req.params.id]: outcome.poll } };
    });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    broadcastDataUpdate('polls');
    res.json(publicPoll(result.poll, { uid: userId(req), secret: pollSecret() }));
  } catch (err) {
    console.error('Failed to vote:', err);
    res.status(500).json({ error: 'The vote could not be saved' });
  }
});

// End a poll now (creator or admin); the results show right away
router.post('/api/polls/:id/close', protectedActionRateLimit, verifyToken, async (req, res) => {
  try {
    const result = await withPolls((polls) => {
      const poll = polls[req.params.id];
      if (!poll) return { error: 'Poll not found', status: 404 };
      if (!isMine(poll, userId(req), pollSecret()) && !isAdmin(req)) return { error: 'Only the person who created the poll can end it.', status: 403 };
      const ended = { ...poll, endsAt: Math.min(poll.endsAt, Date.now()) };
      return { poll: ended, save: { ...polls, [poll.id]: ended } };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    broadcastDataUpdate('polls');
    res.json(publicPoll(result.poll, { uid: userId(req), secret: pollSecret() }));
  } catch (err) {
    console.error('Failed to close poll:', err);
    res.status(500).json({ error: 'The poll could not be ended' });
  }
});

router.delete('/api/polls/:id', protectedActionRateLimit, verifyToken, async (req, res) => {
  try {
    const result = await withPolls((polls) => {
      const poll = polls[req.params.id];
      if (!poll) return { error: 'Poll not found', status: 404 };
      if (!isMine(poll, userId(req), pollSecret()) && !isAdmin(req)) return { error: 'Only the person who created the poll can delete it.', status: 403 };
      const rest = { ...polls };
      delete rest[poll.id];
      return { save: rest };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    broadcastDataUpdate('polls');
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete poll:', err);
    res.status(500).json({ error: 'The poll could not be deleted' });
  }
});

module.exports = router;
