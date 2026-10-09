// Songbook: songs with chords in ChordPro style ("[G]Amazing [D]grace", "# Chorus" for sections). Everyone reads,
// members with the manage_songbook permission add, edit and delete songs.
const crypto = require('crypto');

const MAX_SONGS = 2000;

const canManageSongbook = (user) => Array.isArray(user?.permissions) && user.permissions.includes('manage_songbook');

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** CCLI numbers are digits only (song number, church licence number); returns '' for empty, null for invalid. */
function cleanCcli(value) {
  const text = String(value ?? '').replace(/\s+/g, '').trim();
  if (!text) return '';
  return /^\d{1,12}$/.test(text) ? text : null;
}

/** A key like "G", "F#m", "Bb", "H" (German); '' for empty, null for anything else. */
function cleanKey(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return /^[A-H](#|b)?m?$/.test(text) ? text : null;
}

/** A whole number in [min, max]; '' / null / undefined mean "not set" (null). Returns undefined when invalid. */
function cleanNumber(value, min, max) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
}

/** Validates a song; returns { song } or { error }. Keeps id and creation time of [existing]. */
function buildSong(input, { existing = null, now = Date.now(), id = crypto.randomUUID() } = {}) {
  const title = clean(input?.title, 120);
  const content = String(input?.content ?? '').replace(/\r\n?/g, '\n').trimEnd().slice(0, 20000);
  const ccli = cleanCcli(input?.ccli);
  const key = cleanKey(input?.key);
  const capo = cleanNumber(input?.capo, 0, 11);
  const tempo = cleanNumber(input?.tempo, 20, 300);
  if (!title) return { error: 'Please enter a title.' };
  if (!content.trim()) return { error: 'Please enter the lyrics.' };
  if (ccli === null) return { error: 'The CCLI song number consists of digits only.' };
  if (key === null) return { error: 'The key has to be a note like G, F#m or Bb.' };
  if (capo === undefined) return { error: 'The capo has to be a fret from 0 to 11.' };
  if (tempo === undefined) return { error: 'The tempo has to be between 20 and 300 BPM.' };
  return {
    song: {
      id: existing?.id || id,
      title,
      artist: clean(input?.artist, 120),
      key,
      capo,
      tempo,
      ccli,
      copyright: clean(input?.copyright, 300),
      content,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }
  };
}

module.exports = { MAX_SONGS, canManageSongbook, cleanCcli, cleanKey, buildSong };
