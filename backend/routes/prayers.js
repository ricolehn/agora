const express = require('express');
const { context, dataDir } = require('../context');
const { verifyToken } = require('../auth');
const { protectedActionRateLimit } = require('../rateLimits');
const { broadcastDataUpdate } = require('../liveUpdates');
const { createItemStore, changeItem } = require('../itemStore');
const { queueRecordWrite } = require('../pocketbase');
const { instanceSecret } = require('../instanceSecret');
const { route } = require('./http');
const { forbidden } = require('../httpError');
const { canModerate, buildPrayer, canCreate, ownerUpdate, isMine, isGone, publicPrayer, visiblePrayers } = require('../prayers');
const { fullName } = require('../utils/names');

const router = express.Router();
const store = createItemStore('prayers');

// A damaged secret makes prayer requests unusable, it is never silently replaced (instanceSecret.js)
const prayerSecret = instanceSecret(dataDir, 'prayers-secret', 'Prayer requests are not available right now.');

const userName = (req) => fullName(req.user) || req.user?.email || '';
const viewOf = (prayer, req) => publicPrayer(prayer, { uid: req.user.uid, secret: prayerSecret(), moderator: canModerate(req.user) });

router.get('/api/prayers', verifyToken, route('Prayer requests could not be loaded', async (req, res) => {
  const now = Date.now();
  const prayers = await store.list(context.appConfig);
  // Requests past their keeping time are removed the first time anyone looks
  for (const prayer of prayers.filter((item) => isGone(item, now))) {
    await store.update(context.appConfig, prayer.id, (current) => (current && isGone(current, now) ? { remove: true } : {}));
  }
  res.json({
    prayers: visiblePrayers(prayers, { uid: req.user.uid, secret: prayerSecret(), now, moderator: canModerate(req.user) }),
    canModerate: canModerate(req.user)
  });
}));

router.post('/api/prayers', protectedActionRateLimit, verifyToken, route('The prayer request could not be shared', async (req, res) => {
  const { prayer, error } = buildPrayer(req.body, { uid: req.user.uid, name: userName(req), secret: prayerSecret() });
  if (error) return res.status(400).json({ error });
  // Checked and saved one after another per person: parallel posts cannot get past the limit
  const limit = await queueRecordWrite(`prayers-new:${req.user.uid}`, async () => {
    const over = canCreate(await store.list(context.appConfig), { uid: req.user.uid, secret: prayerSecret() });
    if (!over) await store.update(context.appConfig, prayer.id, () => ({ save: prayer }));
    return over;
  });
  if (limit) return res.status(limit.status).json({ error: limit.error });
  broadcastDataUpdate('prayers');
  res.status(201).json(viewOf(prayer, req));
}));

// The owner: extend
router.patch('/api/prayers/:id', protectedActionRateLimit, verifyToken, route('The prayer request could not be saved', async (req, res) => {
  const result = await changeItem(context.appConfig, store, req.params.id, 'Prayer request not found', (prayer) => {
    if (!isMine(prayer, req.user.uid, prayerSecret())) throw forbidden('Only the person who shared it can change this request.');
    const next = ownerUpdate(prayer, req.body);
    return { ...next, save: next.prayer };
  });
  broadcastDataUpdate('prayers');
  res.json(viewOf(result.prayer, req));
}));

// The owner, or a member with the manage_prayers permission
router.delete('/api/prayers/:id', protectedActionRateLimit, verifyToken, route('The prayer request could not be deleted', async (req, res) => {
  await changeItem(context.appConfig, store, req.params.id, 'Prayer request not found', (prayer) => {
    if (!isMine(prayer, req.user.uid, prayerSecret()) && !canModerate(req.user)) throw forbidden('You may not delete this prayer request.');
    return { remove: true };
  });
  broadcastDataUpdate('prayers');
  res.json({ success: true });
}));

module.exports = router;
