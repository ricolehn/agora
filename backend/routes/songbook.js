const express = require('express');
const { context } = require('../context');
const { verifyToken } = require('../auth');
const { protectedActionRateLimit } = require('../rateLimits');
const { broadcastDataUpdate } = require('../liveUpdates');
const { createItemStore } = require('../itemStore');
const { requestLanguage } = require('../i18n');
const { MAX_SONGS, canManageSongbook, buildSong } = require('../songbook');
const { route } = require('./http');

const router = express.Router();
const store = createItemStore('songs');

const denied = (res) => res.status(403).json({ error: 'You do not have permission for the songbook.' });
const notFound = (res) => res.status(404).json({ error: 'Song not found' });

// All songs plus the church's CCLI licence number (shown with every song)
router.get('/api/songs', verifyToken, route('The songbook could not be loaded', async (req, res) => {
  const songs = await store.list(context.appConfig);
  const collator = new Intl.Collator(requestLanguage(req) || 'en', { sensitivity: 'base', numeric: true });
  res.json({
    songs: songs.sort((a, b) => collator.compare(a.title || '', b.title || '')),
    ccliLicense: context.appConfig?.ccliLicense || '',
    canManage: canManageSongbook(req.user)
  });
}));

router.post('/api/songs', protectedActionRateLimit, verifyToken, route('The song could not be saved', async (req, res) => {
  if (!canManageSongbook(req.user)) return denied(res);
  const { song, error } = buildSong(req.body);
  if (error) return res.status(400).json({ error });
  if (await store.count(context.appConfig) >= MAX_SONGS) return res.status(409).json({ error: 'The songbook is full.' });
  await store.update(context.appConfig, song.id, () => ({ save: song }));
  broadcastDataUpdate('songs');
  res.status(201).json(song);
}));

router.put('/api/songs/:id', protectedActionRateLimit, verifyToken, route('The song could not be saved', async (req, res) => {
  if (!canManageSongbook(req.user)) return denied(res);
  if (!store.isValidKey(req.params.id)) return notFound(res);
  const result = await store.update(context.appConfig, req.params.id, (existing) => {
    if (!existing) return { error: 'Song not found', status: 404 };
    const { song, error } = buildSong(req.body, { existing });
    if (error) return { error, status: 400 };
    return { song, save: song };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  broadcastDataUpdate('songs');
  res.json(result.song);
}));

router.delete('/api/songs/:id', protectedActionRateLimit, verifyToken, route('The song could not be deleted', async (req, res) => {
  if (!canManageSongbook(req.user)) return denied(res);
  if (!store.isValidKey(req.params.id)) return notFound(res);
  const result = await store.update(context.appConfig, req.params.id, (existing) => (existing ? { remove: true } : { error: 'Song not found', status: 404 }));
  if (result.error) return res.status(result.status).json({ error: result.error });
  broadcastDataUpdate('songs');
  res.json({ success: true });
}));

module.exports = router;
