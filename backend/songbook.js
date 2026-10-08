// Songbook: songs with chords in ChordPro style ("[G]Amazing [D]grace", "# Refrain" for sections). Everyone reads,
// members with the manage_songbook permission add, edit and delete songs.
const crypto = require('crypto');

const canManageSongbook = (user) => Array.isArray(user?.permissions) && user.permissions.includes('manage_songbook');

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** CCLI numbers are digits only (song number, church licence number); returns '' for empty, null for invalid. */
function cleanCcli(value) {
  const text = String(value ?? '').replace(/\s+/g, '').trim();
  if (!text) return '';
  return /^\d{1,12}$/.test(text) ? text : null;
}

/** Validates a song; returns { song } or { error }. Keeps id and creation time of [existing]. */
function buildSong(input, { existing = null, now = Date.now(), id = crypto.randomUUID() } = {}) {
  const title = clean(input?.title, 120);
  const content = String(input?.content ?? '').replace(/\r\n?/g, '\n').trimEnd().slice(0, 20000);
  const ccli = cleanCcli(input?.ccli);
  if (!title) return { error: 'Please enter a title.' };
  if (!content.trim()) return { error: 'Please enter the lyrics.' };
  if (ccli === null) return { error: 'The CCLI song number consists of digits only.' };
  return {
    song: {
      id: existing?.id || id,
      title,
      artist: clean(input?.artist, 120),
      key: clean(input?.key, 8),
      ccli,
      copyright: clean(input?.copyright, 300),
      content,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }
  };
}

module.exports = { canManageSongbook, cleanCcli, buildSong };
