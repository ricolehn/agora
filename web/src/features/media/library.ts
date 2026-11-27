// The media library (Extras): the community's Nextcloud folder. The server checks every request against the folder
// rights; this part keeps what it sends - the open folder, its entries in the chosen order, the selection - and the
// pages on screen. As in the Android app: a folder that opens rises from below, going back it comes down from above
// and the folder above shows where it was left.
import { createSignal } from 'solid-js';
import { apiJson, errorMessage, errorStatus } from '../../app/api';
import { loadMediaStatus } from '../../app/data';
import { t } from '../../app/i18n';
import { activeTab, leaveHistoryLevels, switchTab, syncUrl } from '../../app/router';
import { scrollContainer } from '../../app/shell';
import { readStored, store } from '../../app/storage';
import { showToast } from '../../app/toast';
import { newestWins } from '../../app/util';
import { folderDepth, folderFromRoute, parentPath, sortEntries } from '../../lib/media.js';
import { motionAllowed } from './files';
import type { MediaAccess, MediaEntry, MediaFile, MediaFolder, MediaListing, MediaSort } from './types';
import { flushNow } from '../../app/flush';

/** Why a folder is not shown: nothing to see (not set up, gone) or the server's message. */
export type MediaLoadError = { unavailable: true; message?: undefined } | { unavailable?: undefined; message: string };

const storedSort = (): MediaSort => (readStored('agora-media-sort') === 'newest' ? 'newest' : 'name');

const [folder, setFolder] = createSignal('');
const [listing, setListing] = createSignal<MediaListing | null>(null);
// The folder the listing belongs to (null while it loads)
const [loadedPath, setLoadedPath] = createSignal<string | null>(null);
const [error, setError] = createSignal<MediaLoadError | null>(null);
const [sort, setSort] = createSignal<MediaSort>(storedSort());
// The order shown: folders and files as on screen (the viewer steps through the pictures in this order)
const [shown, setShown] = createSignal<{ folders: MediaFolder[]; files: MediaFile[] }>({ folders: [], files: [] });
// Names selected in the open folder (to download or delete several at once)
const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());

export {
  folder as mediaFolder, listing as mediaListing, error as mediaError, sort as mediaSort, shown as mediaShown,
  selected as mediaSelected
};

/** Upload and new folder: where the member may write, once the folder is there and nothing is selected. */
export const mediaCanAdd = () => listing()?.access === 'write' && loadedPath() === folder() && selected().size === 0;

/** The open folder's part of the page address: /media/Photos/2026 (each name encoded). */
export const mediaSubPath = () => folder().split('/').filter(Boolean).map(encodeURIComponent).join('/');

/** /media/Photos/2026: the folder is set before the tab opens (the tab then loads it). */
export function setMediaFolderFromRoute(parts: string[]) {
  setFolder(folderFromRoute(parts));
  flushNow();
}

// --- Pages on screen: the open folder's (its entries, a message or the circle while they load) and the one it
// replaces while that moves on. A page shows what it was given, so the one leaving keeps its folder ---
export type MediaPageView =
  | { kind: 'loading' }
  | { kind: 'error'; error: MediaLoadError }
  | { kind: 'empty'; access: MediaAccess }
  | { kind: 'entries'; access: MediaAccess; folders: MediaFolder[]; files: MediaFile[] };

export interface MediaPageState {
  id: number;
  path: string;
  view: MediaPageView;
  /** Rises in from this many pixels below (comes down from above when negative); 0: no move. */
  enter: number;
  /** The entries after the circle: they fade in a little from below. */
  fresh: boolean;
  /** Moving on: out of the flow at [top] (still where it was seen), sliding by [shift] while it fades out. */
  leaving?: { top: number; shift: number };
}

const [pages, setPages] = createSignal<MediaPageState[]>([]);
export { pages as mediaPages };
let pageSeq = 0;
// The folder of the page on screen and how the next page comes in: from below for a folder further in, from above
// going back up, in place (0) for the same folder
let pagePath: string | null = null;
let enterWay = 0;
// Where each folder was scrolled to: going back up shows a folder where it was left, one opened anew starts on top
const scrolled = new Map<string, number>();
let restoreScroll: string | null = null;
// The tab is opening (it was hidden): its first page is no move between folders
let entering = false;

export function dropMediaPage(id: number) {
  setPages(pages().filter(page => page.id !== id));
}

/**
 * Puts [view] on screen as the open folder's page. Another folder's page moves on a little and fades out over it
 * (from where it was seen), the new one rises from below or comes down from above; the page stays where it was
 * scrolled for the same folder, starts on top for one opened anew and shows one gone back to where it was left.
 */
function showMediaPage(view: MediaPageView, visible: boolean) {
  const path = folder();
  const scroller = scrollContainer();
  const all = pages();
  const current = all.find(page => !page.leaving);
  const loading = view.kind === 'loading';
  // Coming to the library from elsewhere (its tab still hidden) is no move between folders
  const moved = visible && pagePath !== null && pagePath !== path;
  const afterLoading = current?.view.kind === 'loading';
  if (moved) enterWay = folderDepth(path) >= folderDepth(pagePath) ? 1 : -1;
  else if (!visible) {
    enterWay = 0;
    restoreScroll = null;
  }
  pagePath = path;
  const seen = scroller?.scrollTop || 0;
  const leaving = moved && current && !afterLoading && motionAllowed() ? current : null;
  if (current && current.path === path && !loading && !afterLoading && !enterWay) {
    // The same folder changes in place: its tiles (and their pictures) stay
    setPages(all.map(page => (page === current ? { ...page, view } : page)));
  } else {
    const enter = !loading && enterWay && motionAllowed() ? enterWay * Math.round(window.innerHeight / 7) : 0;
    const page: MediaPageState = { id: ++pageSeq, path, view, enter, fresh: !loading && !enter && afterLoading };
    // A page still leaving from the move before makes room once another one leaves
    setPages(leaving ? [leaving, page] : [...all.filter(entry => entry.leaving), page]);
  }
  flushNow();
  // Where the page is shown: on top for a folder that changed (the one gone back to once its entries are there)
  let top: number | null = null;
  if (!loading && restoreScroll === path) {
    top = scrolled.get(path) || 0;
    restoreScroll = null;
  } else if (moved) top = 0;
  if (top !== null && scroller) scroller.scrollTo({ top, behavior: 'instant' });
  if (leaving) {
    const shift = -enterWay * Math.round(window.innerHeight / 12);
    setPages(pages().map(page => (page === leaving ? { ...leaving, leaving: { top: (scroller?.scrollTop || 0) - seen, shift } } : page)));
    flushNow();
  }
  if (!loading) enterWay = 0;
}

// --- The open folder's name in the header, moving along with the page: up and in from below for a folder further
// in, down for one further out ---
export interface MediaTitle {
  id: number;
  path: string;
  /** Comes in from below (1) or above (-1); 0: stands. */
  enter: number;
  /** Moves out upwards (1) or downwards (-1); 0: the title shown. */
  leaving: number;
}
const [titles, setTitles] = createSignal<MediaTitle[]>([]);
export { titles as mediaTitles };
let titleSeq = 0;
let titlePath: string | null = null;

export function dropMediaTitle(id: number) {
  setTitles(titles().filter(title => title.id !== id));
}

function renderTitle(visible: boolean) {
  const path = folder();
  if (titlePath === path && titles().length) return;
  const current = titles().find(title => !title.leaving);
  const way = titlePath === null || titlePath === path ? 0 : folderDepth(path) >= folderDepth(titlePath) ? 1 : -1;
  titlePath = path;
  const next: MediaTitle = { id: ++titleSeq, path, enter: 0, leaving: 0 };
  if (!current || !way || !visible || selected().size || !motionAllowed()) setTitles([next]);
  else setTitles([{ ...current, leaving: way }, { ...next, enter: way }]);
}

/** Draws the open folder: its title, and its page (an error, the circle, the entries in the chosen order). */
function renderMedia() {
  const visible = !entering && activeTab() === 'media';
  renderTitle(visible);
  const failure = error();
  if (failure) return showMediaPage({ kind: 'error', error: failure }, visible);
  const current = listing();
  // One calm circle (only after a moment, so fast folders do not flash) instead of tiles that may never come
  if (!current) return showMediaPage({ kind: 'loading' }, visible);
  const folders = sortEntries(current.folders, sort() === 'newest' ? 'newest' : 'name') as MediaFolder[];
  const files = sortEntries(current.files, sort()) as MediaFile[];
  setShown({ folders, files });
  // Deleted or gone on another device: no longer selected
  const present = new Set([...folders, ...files].map(entry => entry.name));
  const kept = [...selected()].filter(name => present.has(name));
  if (kept.length !== selected().size) setSelected(new Set(kept));
  flushNow();
  const access = current.access;
  showMediaPage(folders.length || files.length ? { kind: 'entries', access, folders, files } : { kind: 'empty', access }, visible);
}

// --- Loading ---
// Folders seen before show at once from memory; the server is always asked again and the page only drawn anew when
// its answer differs (so deleted or new files show right away, and an unchanged folder does not flicker)
const MEDIA_CACHE_SIZE = 40;
const cache = new Map<string, MediaListing>();
function rememberListing(path: string, value: MediaListing) {
  cache.delete(path);
  cache.set(path, value);
  if (cache.size > MEDIA_CACHE_SIZE) cache.delete(cache.keys().next().value!);
}
const folderLoad = newestWins();

/** Loads the open folder. silent: a refresh in the background (a failure keeps what is shown). */
export async function loadMediaFolder({ silent = false } = {}): Promise<void> {
  const path = folder();
  const isNewest = folderLoad();
  if (loadedPath() !== path || error()) {
    const cached = cache.get(path);
    setListing(cached || null);
    setLoadedPath(cached ? path : null);
    setError(null);
    flushNow();
    renderMedia();
  }
  // What is on the page now: the answer is compared with it
  const before = listing();
  const shownJson = before && loadedPath() === path ? JSON.stringify(before) : null;
  try {
    const result = await apiJson<MediaListing>(`/media/list?path=${encodeURIComponent(path)}`, 'GET', undefined, t('media_load_failed', 'The folder could not be loaded'));
    if (!isNewest()) return;
    rememberListing(path, result);
    setListing(result);
    setLoadedPath(path);
    setError(null);
    flushNow();
    if (shownJson !== null && JSON.stringify(result) === shownJson) {
      syncUrl();
      return;
    }
  } catch (err) {
    if (!isNewest()) return;
    // A folder that is gone (or no longer visible): one level up
    if (errorStatus(err) === 404 && path) {
      cache.delete(path);
      showToast(t('media_folder_gone', 'This folder is not available.'), 'error');
      setFolder(parentPath(path));
      flushNow();
      return loadMediaFolder();
    }
    if (!silent || !listing()) {
      cache.delete(path);
      setListing(null);
      setLoadedPath(null);
      setError(errorStatus(err) === 503 || errorStatus(err) === 404 ? { unavailable: true } : { message: String(errorMessage(err) || '') });
      flushNow();
    }
  }
  // A folder already on the page changes in place
  renderMedia();
  syncUrl();
}

/** The tab opens: the status (is there still access?) and the open folder are asked for again. */
export function enterMediaTab() {
  void loadMediaStatus();
  entering = true;
  try {
    void loadMediaFolder();
  } finally {
    entering = false;
  }
}

// --- Moving between folders ---

/** Opens [path] in the library (from the hub, a folder, the path or an address); [back]: going up to it. */
export function openMediaFolder(path = '', { back = false }: { back?: boolean } = {}): void {
  if (path !== folder()) {
    clearMediaSelection();
    if (activeTab() === 'media') scrolled.set(folder(), scrollContainer()?.scrollTop || 0);
  }
  if (!back) scrolled.delete(path);
  restoreScroll = back ? path : null;
  setFolder(path);
  flushNow();
  if (activeTab() !== 'media') return switchTab('media');
  void loadMediaFolder();
}

/** The back button: the folder above, from the base folder back to Extras. */
export function mediaBack() {
  if (folder()) {
    leaveHistoryLevels('folder');
    openMediaFolder(parentPath(folder()), { back: true });
  } else switchTab('hub');
}

/** The back gesture inside a folder: the folder above (true when handled). */
export function mediaLevelBack(): boolean {
  if (activeTab() !== 'media' || !folder()) return false;
  openMediaFolder(parentPath(folder()), { back: true });
  return true;
}

/** A folder of the path above the open one: the history steps of the folders in between are left behind. */
export function openMediaCrumb(path: string) {
  leaveHistoryLevels('folder', folderDepth(folder()) - folderDepth(path));
  openMediaFolder(path, { back: true });
}

/** Name or newest first (remembered on the device). */
export function setMediaSort(value: string) {
  const next: MediaSort = value === 'newest' ? 'newest' : 'name';
  setSort(next);
  flushNow();
  store('agora-media-sort', next);
  renderMedia();
}

// --- The entries shown and the selection ---

/** The folder or file of that name in the open folder, or null. */
export function mediaEntry(name: string): MediaEntry | null {
  const { folders, files } = shown();
  const match = folders.find(entry => entry.name === name);
  if (match) return { name, folder: match };
  const index = files.findIndex(entry => entry.name === name);
  return index >= 0 ? { name, file: files[index], index } : null;
}

/** Every name of the open folder in the order shown. */
export const mediaOrder = () => [...shown().folders, ...shown().files].map(entry => entry.name);

/** Files where the member may write in the folder; folders only when they may write everywhere in them. */
export const canDeleteMediaEntry = (entry: MediaEntry) => listing()?.access === 'write' && (entry.file ? true : !!entry.folder.canDelete);

export const isMediaSelected = (name: string) => selected().has(name);

let selectAnchor: string | null = null;
function setSelection(names: Iterable<string>) {
  setSelected(new Set(names));
  flushNow();
}

/** Selects or unselects [name]; range (Shift): everything from the last one picked to it. */
export function toggleMediaSelected(name: string, { range = false } = {}) {
  if (!mediaEntry(name)) return;
  const next = new Set(selected());
  if (range && selectAnchor && selectAnchor !== name) {
    const order = mediaOrder();
    const [from, to] = [order.indexOf(selectAnchor), order.indexOf(name)].sort((a, b) => a - b);
    if (from >= 0) for (const entry of order.slice(from, to + 1)) next.add(entry);
  } else if (next.has(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  selectAnchor = name;
  setSelection(next);
}

export function clearMediaSelection() {
  if (!selected().size) return;
  selectAnchor = null;
  setSelection([]);
}

export function selectAllMedia() {
  setSelection([...selected(), ...mediaOrder()]);
}

export function toggleSelectAllMedia() {
  if (selected().size >= mediaOrder().length) return clearMediaSelection();
  selectAllMedia();
}

/** Forgets [names] after they were deleted. */
export function unselectMedia(names: string[]) {
  setSelection([...selected()].filter(name => !names.includes(name)));
}
