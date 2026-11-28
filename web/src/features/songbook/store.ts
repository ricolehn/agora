// The songs of the songbook, the church's CCLI licence number and whether the account may manage songs
// (GET /api/songs). Text and chord rules live in lib/songbook.ts (tested on their own).
import { action, createOptimistic, createRoot, refresh, until } from 'solid-js';
import { apiJson, errorMessage } from '../../app/api';
import { t, uiLocale } from '../../app/i18n';
import { itemSlug } from '../../app/router';
import { serverData } from '../../app/serverData';
import { searchText } from '../../lib/songbook';

/** A song of the songbook (backend/songbook.js): the lyrics in ChordPro with its key, capo and tempo. */
export interface Song {
  id: string;
  title: string;
  artist?: string;
  /** The key it is written in ("G", "F#m", "Bb"; '' when none was given). */
  key?: string;
  capo?: number | null;
  tempo?: number | null;
  /** The CCLI song number (digits). */
  ccli?: string;
  copyright?: string;
  content?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** The songbook as the server has it: the songs (sorted by title), whether the account may manage them, the licence;
 *  error: the first load failed (its reason; "Try again" asks again). */
export interface Songbook {
  songs: Song[];
  canManage: boolean;
  license: string;
  error?: string;
}

const songCollator = () => new Intl.Collator(uiLocale(), { sensitivity: 'base', numeric: true });
export const sortSongs = (list: Song[]) => list.sort((a, b) => songCollator().compare(a.title || '', b.title || ''));

// Loaded when something first reads it - the songbook tab, a song's address, an event's plan with songs - and again
// on every visit, live update and change (app/serverData.ts). Other parts read the songs on the way: until the first
// answer there is none (null), and a failed first load is a value too
const serverSongbook = serverData<Songbook | null>(
  () =>
    apiJson<{ songs?: Song[]; canManage?: boolean; ccliLicense?: string }>('/songs', 'GET', undefined, t('songbook_load_failed', 'Songbook could not be loaded')).then(
      data => ({ songs: sortSongs([...(data.songs || [])]), canManage: data.canManage === true, license: data.ccliLicense || '' })
    ),
  { loadingValue: null, failed: err => ({ songs: [], canManage: false, license: '', error: errorMessage(err) }) }
);
/** Loads the songs again (the list keeps showing the last ones meanwhile); resolves to the songbook then - while the
 *  first load is on its way, to the placeholder at once (songbookReady waits for that one). */
export const refreshSongbook = () => refresh(serverSongbook);
/** The first answer (the songs, or the failed load), loading it when nothing asked for it yet. */
export const songbookReady = () => until(() => serverSongbook());
/** Whether the server's songbook (not what the page shows: a deletion on its way) still has the song [id]. */
export const songOnServer = (id: string) => !!serverSongbook()?.songs.some(s => s.id === id);

// What the pages show: the server's songbook, a deletion already applied while the server is asked
const [songbook, setShownSongbook] = createRoot(() => createOptimistic<Songbook | null>(() => serverSongbook(), { lazy: true }));
export { songbook };
/** The songs (none until they are loaded: reading them loads them). */
export const songs = () => songbook()?.songs ?? [];
export const canManageSongs = () => songbook()?.canManage === true;
export const songbookLicense = () => songbook()?.license ?? '';

// True while a song is being saved (its button waits); back to false by itself when it ends
const [savingSong, setSavingSong] = createOptimistic(false);
export { savingSong };

/** Saves a new song or the song [id]; it is in the list when this resolves. */
export const saveSong = action(function* (id: string | null, song: Record<string, unknown>) {
  setSavingSong(true);
  yield id ? apiJson(`/songs/${encodeURIComponent(id)}`, 'PUT', song) : apiJson('/songs', 'POST', song);
  yield refreshSongbook();
});

/** Deletes a song: gone from the songbook at once, back when the server refuses. */
export const deleteSong = action(function* (id: string) {
  setShownSongbook(book => book && { ...book, songs: book.songs.filter(s => s.id !== id) });
  yield apiJson(`/songs/${encodeURIComponent(id)}`, 'DELETE');
  yield refreshSongbook();
});

// The text a search looks in (title, writers, CCLI number, lyrics without chords), once per song
const searchCache = new WeakMap<Song, string>();
export function songSearchText(song: Song): string {
  let text = searchCache.get(song);
  if (text === undefined) {
    text = searchText(song);
    searchCache.set(song, text);
  }
  return text;
}

/** The readable name of a song in its address (/songbook/Amazing_Grace). */
export const songSlug = (song: Song) => itemSlug(song, songs());

export const songSectionLabels = () => ({
  chorus: t('songbook_label_chorus', 'Chorus'),
  verse: t('songbook_label_verse', 'Verse'),
  bridge: t('songbook_label_bridge', 'Bridge'),
  tab: t('songbook_label_tab', 'Tab')
});
