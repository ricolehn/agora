// The songs of the songbook, the church's CCLI licence number and whether the account may manage songs
// (GET /api/songs). Text and chord rules live in lib/songbook.js (tested on their own).
import { createSignal } from 'solid-js';
import { apiJson } from '../../app/api';
import { t, uiLocale } from '../../app/i18n';
import { itemSlug } from '../../app/router';
import { showToast } from '../../app/toast';
import { searchText } from '../../lib/songbook.js';
import { flushNow } from '../../app/flush';

export type Song = { id: string; title: string; key?: string; content?: string; artist?: string; [key: string]: any };

const [songs, setSongs] = createSignal<Song[]>([]);
const [canManageSongs, setCanManageSongs] = createSignal(false);
const [songbookLicense, setSongbookLicense] = createSignal('');
const [songbookLoaded, setSongbookLoaded] = createSignal(false);
// A first load that failed: its message with "Try again" (a later failed refresh keeps the list and says so)
const [songbookError, setSongbookError] = createSignal('');
export { songs, setSongs, canManageSongs, songbookLicense, songbookLoaded, songbookError };

const songCollator = () => new Intl.Collator(uiLocale(), { sensitivity: 'base', numeric: true });
export const sortSongs = (list: Song[]) => list.sort((a, b) => songCollator().compare(a.title || '', b.title || ''));

// The text a search looks in (title, writers, CCLI number, lyrics without chords), once per song
const searchCache = new WeakMap<Song, string>();
export function songSearchText(song: Song): string {
  let text = searchCache.get(song);
  if (text === undefined) {
    text = searchText(song) as string;
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

/** Loads the songs; resolves to false when there is nothing to show (the first load failed). */
export async function fetchSongs(): Promise<boolean> {
  try {
    const data = await apiJson<{ songs?: Song[]; canManage?: boolean; ccliLicense?: string }>(
      '/songs', 'GET', undefined, t('songbook_load_failed', 'Songbook could not be loaded')
    );
    setSongs(sortSongs([...(data.songs || [])]));
    setCanManageSongs(data.canManage === true);
    setSongbookLicense(data.ccliLicense || '');
    setSongbookLoaded(true);
    setSongbookError('');
    flushNow();
  } catch (err: any) {
    if (!songbookLoaded()) {
      setSongbookError(err.message);
      flushNow();
      return false;
    }
    showToast(err.message, 'error');
  }
  return true;
}

/** A song the server saved: in its place in the list (sorted by title). */
export function putSong(saved: Song) {
  setSongs(list => sortSongs([...list.filter(s => s.id !== saved.id), saved]));
  flushNow();
}
export function dropSong(id: string) {
  setSongs(list => list.filter(s => s.id !== id));
  flushNow();
}
