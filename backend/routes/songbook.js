const express = require('express');
const { context } = require('../context');
const { verifyToken } = require('../auth');
const { protectedActionRateLimit } = require('../rateLimits');
const { broadcastDataUpdate } = require('../liveUpdates');
const { createItemStore, changeItem } = require('../itemStore');
const { requestLanguage } = require('../i18n');
const { MAX_SONGS, canManageSongbook, buildSong } = require('../songbook');
const { route } = require('./http');

const router = express.Router();
const store = createItemStore('songs');

const denied = (res) => res.status(403).json({ error: 'You do not have permission for the songbook.' });

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
  const result = await changeItem(context.appConfig, store, req.params.id, 'Song not found', (existing) => {
    const { song, error } = buildSong(req.body, { existing });
    return error ? { error } : { song, save: song };
  });
  broadcastDataUpdate('songs');
  res.json(result.song);
}));

router.delete('/api/songs/:id', protectedActionRateLimit, verifyToken, route('The song could not be deleted', async (req, res) => {
  if (!canManageSongbook(req.user)) return denied(res);
  await changeItem(context.appConfig, store, req.params.id, 'Song not found', () => ({ remove: true }));
  broadcastDataUpdate('songs');
  res.json({ success: true });
}));

module.exports = router;
