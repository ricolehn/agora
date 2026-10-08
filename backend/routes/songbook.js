const express = require('express');
const { context, verifyToken, protectedActionRateLimit, broadcastDataUpdate } = require('../context');
const { getStateValue, upsertStateValue } = require('../pocketbase');
const { canManageSongbook, buildSong } = require('../songbook');

const router = express.Router();
const STATE_KEY = 'songs';

// Writes one after another, so two editors never overwrite each other's song
let queue = Promise.resolve();
function withSongs(change) {
  const run = queue.then(async () => {
    const songs = (await getStateValue(context.appConfig, STATE_KEY, {})) || {};
    const result = await change(songs);
    if (result?.save) await upsertStateValue(context.appConfig, STATE_KEY, result.save);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

const denied = (res) => res.status(403).json({ error: 'You do not have permission for the songbook.' });

// All songs plus the church's CCLI licence number (shown with every song)
router.get('/api/songs', verifyToken, async (req, res) => {
  try {
    const songs = (await getStateValue(context.appConfig, STATE_KEY, {})) || {};
    res.json({
      songs: Object.values(songs).sort((a, b) => a.title.localeCompare(b.title, 'de')),
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
    await withSongs((songs) => ({ save: { ...songs, [song.id]: song } }));
    broadcastDataUpdate('songs');
    res.status(201).json(song);
  } catch (err) {
    console.error('Failed to create song:', err);
    res.status(500).json({ error: 'The song could not be saved' });
  }
});

router.put('/api/songs/:id', protectedActionRateLimit, verifyToken, async (req, res) => {
  if (!canManageSongbook(req.user)) return denied(res);
  try {
    const result = await withSongs((songs) => {
      const existing = songs[req.params.id];
      if (!existing) return { error: 'Song not found', status: 404 };
      const { song, error } = buildSong(req.body, { existing });
      if (error) return { error, status: 400 };
      return { song, save: { ...songs, [song.id]: song } };
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
  try {
    const result = await withSongs((songs) => {
      if (!songs[req.params.id]) return { error: 'Song not found', status: 404 };
      const rest = { ...songs };
      delete rest[req.params.id];
      return { save: rest };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    broadcastDataUpdate('songs');
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete song:', err);
    res.status(500).json({ error: 'The song could not be deleted' });
  }
});

module.exports = router;
