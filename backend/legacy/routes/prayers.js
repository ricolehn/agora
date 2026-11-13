const express = require('express');
const {
  context,
  dataDir,
  verifyToken,
  protectedActionRateLimit,
  broadcastDataUpdate
} = require('../context');
const { createItemStore } = require('../itemStore');
const { queueRecordWrite } = require('../pocketbase');
const { loadSecret } = require('../polls');
const { canModerate, buildPrayer, canCreate, ownerUpdate, isMine, isGone, publicPrayer, visiblePrayers } = require('../prayers');

const router = express.Router();
const store = createItemStore('prayers');

let secret = null;
const prayerSecret = () => (secret ||= loadSecret(dataDir, 'prayers-secret'));

const userId = (req) => req.user?.uid || req.user?.id;
const userName = (req) => req.user?.name || `${req.user?.firstName || ''} ${req.user?.lastName || ''}`.trim() || req.user?.email || '';
const viewOf = (prayer, req) => publicPrayer(prayer, { uid: userId(req), secret: prayerSecret(), moderator: canModerate(req.user) });

/** A missing or damaged secret makes prayer requests unusable (never silently replaced, see polls.js). */
function failure(res, err, fallback) {
  if (/prayers-secret/.test(err?.message || '')) {
    console.error('[Prayers]', err.message);
    return res.status(503).json({ error: 'Prayer requests are not available right now.' });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

const notFound = (res) => res.status(404).json({ error: 'Prayer request not found' });

router.get('/api/prayers', verifyToken, async (req, res) => {
  try {
    const now = Date.now();
    const prayers = await store.list(context.appConfig);
    // Requests past their keeping time are removed the first time anyone looks
    for (const prayer of prayers.filter((item) => isGone(item, now))) {
      await store.update(context.appConfig, prayer.id, (current) => (current && isGone(current, now) ? { remove: true } : {}));
    }
    res.json({
      prayers: visiblePrayers(prayers, { uid: userId(req), secret: prayerSecret(), now, moderator: canModerate(req.user) }),
      canModerate: canModerate(req.user)
    });
  } catch (err) {
    failure(res, err, 'Prayer requests could not be loaded');
  }
});

router.post('/api/prayers', protectedActionRateLimit, verifyToken, async (req, res) => {
  try {
    const { prayer, error } = buildPrayer(req.body, { uid: userId(req), name: userName(req), secret: prayerSecret() });
    if (error) return res.status(400).json({ error });
    // Checked and saved one after another per person: parallel posts cannot get past the limit
    const limit = await queueRecordWrite(`prayers-new:${userId(req)}`, async () => {
      const over = canCreate(await store.list(context.appConfig), { uid: userId(req), secret: prayerSecret() });
      if (!over) await store.update(context.appConfig, prayer.id, () => ({ save: prayer }));
      return over;
    });
    if (limit) return res.status(limit.status).json({ error: limit.error });
    broadcastDataUpdate('prayers');
    res.status(201).json(viewOf(prayer, req));
  } catch (err) {
    failure(res, err, 'The prayer request could not be shared');
  }
});

// The owner: extend
router.patch('/api/prayers/:id', protectedActionRateLimit, verifyToken, async (req, res) => {
  if (!store.isValidKey(req.params.id)) return notFound(res);
  try {
    const result = await store.update(context.appConfig, req.params.id, (prayer) => {
      if (!prayer) return { error: 'Prayer request not found', status: 404 };
      if (!isMine(prayer, userId(req), prayerSecret())) return { error: 'Only the person who shared it can change this request.', status: 403 };
      const next = ownerUpdate(prayer, req.body);
      return { ...next, save: next.prayer };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    broadcastDataUpdate('prayers');
    res.json(viewOf(result.prayer, req));
  } catch (err) {
    failure(res, err, 'The prayer request could not be saved');
  }
});

// The owner, or a member with the manage_prayers permission
router.delete('/api/prayers/:id', protectedActionRateLimit, verifyToken, async (req, res) => {
  if (!store.isValidKey(req.params.id)) return notFound(res);
  try {
    const result = await store.update(context.appConfig, req.params.id, (prayer) => {
      if (!prayer) return { error: 'Prayer request not found', status: 404 };
      if (!isMine(prayer, userId(req), prayerSecret()) && !canModerate(req.user)) {
        return { error: 'You may not delete this prayer request.', status: 403 };
      }
      return { remove: true };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    broadcastDataUpdate('prayers');
    res.json({ success: true });
  } catch (err) {
    failure(res, err, 'The prayer request could not be deleted');
  }
});

module.exports = router;
