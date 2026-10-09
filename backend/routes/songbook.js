const express = require('express');
const { context, verifyToken, protectedActionRateLimit, broadcastDataUpdate } = require('../context');
const { createItemStore } = require('../itemStore');
const { requestLanguage } = require('../i18n');
const { MAX_SONGS, canManageSongbook, buildSong } = require('../songbook');

const router = express.Router();
const store = createItemStore('songs');

const denied = (res) => res.status(403).json({ error: 'You do not have permission for the songbook.' });
const notFound = (res) => res.status(404).json({ error: 'Song not found' });

// All songs plus the church's CCLI licence number (shown with every song)
router.get('/api/songs', verifyToken, async (req, res) => {
  try {
    const songs = await store.list(context.appConfig);
    const collator = new Intl.Collator(requestLanguage(req) || 'en', { sensitivity: 'base', numeric: true });
    res.json({
      songs: songs.sort((a, b) => collator.compare(a.title || '', b.title || '')),
      ccliLicense: context.appConfig?.ccliLicense || '',
      canManage: canManageSongbook(req.user)
    });
  } catch (err) {
    console.error('Failed to list songs:', err);
    res.status(500).json({ error: 'The songbook could not be loaded' });
  }
});

router.post('/api/songs', protectedActionRateLimit, verifyToken, async (req, res) => {
  if (!canManageSongbook(req.user)) return denied(res);
  try {
    const { song, error } = buildSong(req.body);
    if (error) return res.status(400).json({ error });
    if (await store.count(context.appConfig) >= MAX_SONGS) return res.status(409).json({ error: 'The songbook is full.' });
    await store.update(context.appConfig, song.id, () => ({ save: song }));
    broadcastDataUpdate('songs');
    res.status(201).json(song);
  } catch (err) {
    console.error('Failed to create song:', err);
    res.status(500).json({ error: 'The song could not be saved' });
  }
});

router.put('/api/songs/:id', protectedActionRateLimit, verifyToken, async (req, res) => {
  if (!canManageSongbook(req.user)) return denied(res);
  if (!store.isValidKey(req.params.id)) return notFound(res);
  try {
    const result = await store.update(context.appConfig, req.params.id, (existing) => {
      if (!existing) return { error: 'Song not found', status: 404 };
      const { song, error } = buildSong(req.body, { existing });
      if (error) return { error, status: 400 };
      return { song, save: song };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    broadcastDataUpdate('songs');
    res.json(result.song);
  } catch (err) {
    console.error('Failed to update song:', err);
    res.status(500).json({ error: 'The song could not be saved' });
  }
});

router.delete('/api/songs/:id', protectedActionRateLimit, verifyToken, async (req, res) => {
  if (!canManageSongbook(req.user)) return denied(res);
  if (!store.isValidKey(req.params.id)) return notFound(res);
  try {
    const result = await store.update(context.appConfig, req.params.id, (existing) => (existing ? { remove: true } : { error: 'Song not found', status: 404 }));
    if (result.error) return res.status(result.status).json({ error: result.error });
    broadcastDataUpdate('songs');
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete song:', err);
    res.status(500).json({ error: 'The song could not be deleted' });
  }
});

module.exports = router;
