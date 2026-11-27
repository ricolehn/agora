// The song page (song-view-modal) for playing: transpose, chords on/off, text size, auto-scroll, the screen stays on.
// Chords on/off, text size and scroll speed stay as the reader left them (instrument, eyesight, playing pace); the
// key starts as written every time a song opens.
import { createSignal } from 'solid-js';
import { t } from '../../app/i18n';
import { closeModal, isModalOpen, isTopModal, onModalClosed, openModal } from '../../app/modals';
import { readStoredJson, store } from '../../app/storage';
import { showToast } from '../../app/toast';
import { copyText } from '../../app/util';
import { findBySlug } from '../../app/router';
import { fetchSongs, songSlug, songs } from './store';
import { flushNow } from '../../app/flush';
import { asFailure } from '../../app/api';

const SONG_SPEEDS = [1, 1.5, 2, 3, 0.5];
const SONG_PREFS_KEY = 'agora-song-view';
const VIEW_ID = 'song-view-modal';

const prefs: { chords: boolean; size: number; speed: number } = { chords: true, size: 0, speed: 1, ...readStoredJson(SONG_PREFS_KEY, {}) };
// Transpositions were remembered per song up to the first ORION builds
store('agora-song-steps', null);

const [openSongId, setOpenSongId] = createSignal<string | null>(null);
// Semitones the song is moved by (-6..5)
const [songSteps, setSongSteps] = createSignal(0);
const [songChords, setSongChords] = createSignal(prefs.chords !== false);
// Text size steps (-2..5)
const [songSize, setSongSize] = createSignal(prefs.size);
const [songSpeed, setSongSpeed] = createSignal(prefs.speed);
const [songScrolling, setSongScrolling] = createSignal(false);
const [songPanelOpen, setSongPanelOpen] = createSignal(false);
// The "Adjust" button hides while reading on (scrolling down)
const [songControlsShown, setSongControlsShown] = createSignal(true);
export { openSongId, songSteps, songChords, songSize, songSpeed, songScrolling, songPanelOpen, songControlsShown };

const savePrefs = () => store(SONG_PREFS_KEY, { chords: songChords(), size: songSize(), speed: songSpeed() });

/** The open song (while the page shows). */
export const shownSong = () => (isModalOpen(VIEW_ID) && songs().find(s => s.id === openSongId())) || null;

// The scrolling text of the open page (set by the page while it is shown) and where it was last read
let body: HTMLElement | null = null;
let lastY = 0;
export function setSongBody(el: HTMLElement) {
  body = el;
}

/** Shows a song; steps: semitones to transpose (the key the order of service asks for). */
export function openSong(id: string, { steps = 0 }: { steps?: number } = {}) {
  if (!songs().some(s => s.id === id)) return;
  setOpenSongId(id);
  stopSongScroll();
  setSongSteps(steps);
  lastY = 0;
  toggleSongPanel(false);
  setSongControlsShown(true);
  flushNow();
  const wasOpen = isModalOpen(VIEW_ID);
  openModal(VIEW_ID);
  // Whenever the page closes (back button, Escape, back gesture)
  if (!wasOpen) onModalClosed(VIEW_ID, leaveSong);
  body?.scrollTo({ top: 0 });
  void keepScreenOn(true);
}

function leaveSong() {
  stopSongScroll();
  toggleSongPanel(false);
  void keepScreenOn(false);
}

export function closeSong() {
  leaveSong();
  closeModal(VIEW_ID);
}

// Opened through its address (/songbook/<name>, old links #songbook/<id>): that song shows once the songs are there
let pendingSongSlug: string | null = null;
export function setPendingSongSlug(slug: string) {
  pendingSongSlug = slug;
}

function followLoadedSongs() {
  const id = openSongId();
  // The open song was deleted elsewhere
  if (id && isModalOpen(VIEW_ID) && !songs().some(s => s.id === id)) closeSong();
  if (pendingSongSlug) {
    const linked = findBySlug(songs(), pendingSongSlug);
    pendingSongSlug = null;
    if (linked) openSong(linked.id);
    else showToast(t('songbook_link_missing', 'This song is no longer in the songbook.'), 'error');
  }
}

/** Loads the songs; the open song follows, a song opened through its address shows. */
export function loadSongs(): Promise<void> {
  return fetchSongs().then(shown => {
    if (shown) followLoadedSongs();
  });
}

// --- The controls stay out of the way: a small "Adjust" button opens them; it hides while reading on (scrolling
// down) and comes back when scrolling up, at the top or with a tap on the song ---
export function toggleSongPanel(open = !songPanelOpen()) {
  const panel = document.getElementById('song-panel');
  const hadFocus = !!panel?.contains(document.activeElement);
  setSongPanelOpen(open);
  flushNow();
  if (open) {
    setSongControlsShown(true);
    panel?.querySelector<HTMLElement>('[data-panel-close]')?.focus({ preventScroll: true });
  } else if (hadFocus) {
    document.getElementById('song-panel-btn')?.focus({ preventScroll: true });
  }
}

export function songBodyTap() {
  if (songPanelOpen()) toggleSongPanel(false);
  else setSongControlsShown(true);
}

export function onSongBodyScroll() {
  if (!body) return;
  const y = body.scrollTop;
  // Auto-scroll moves the page itself: the pause button has to stay reachable then
  if (!songPanelOpen() && !songScrolling()) {
    if (y < 60 || y < lastY - 12) setSongControlsShown(true);
    else if (y > lastY + 12) setSongControlsShown(false);
  }
  if (Math.abs(y - lastY) > 12 || y < 60) lastY = y;
}

// Escape closes the open controls first, a second Escape the song page
window.addEventListener(
  'keydown',
  e => {
    if (e.key === 'Escape' && songPanelOpen() && isTopModal(VIEW_ID)) {
      e.stopPropagation();
      toggleSongPanel(false);
    }
  },
  true
);

// --- Key, chords, size ---
export function transposeSong(delta: number) {
  setSongSteps(steps => ((steps + delta + 18) % 12) - 6);
}
export function resetSongKey() {
  if (songSteps()) setSongSteps(0);
}
export function setSongChordsShown(on: boolean) {
  setSongChords(on);
  flushNow();
  savePrefs();
}
export function sizeSong(delta: number) {
  setSongSize(size => Math.max(-2, Math.min(5, size + delta)));
  flushNow();
  savePrefs();
}

// --- Auto-scroll for playing: a steady glide; scrolling by hand moves the position, the glide continues from there ---
let frame: number | null = null;
let lastTime = 0;
let position: number | null = null;

function songScrollStep(time: number) {
  if (!songScrolling() || !body || !isModalOpen(VIEW_ID)) return stopSongScroll();
  // scrollTop drops fractions: keep the exact position, take over when the reader scrolled by hand
  if (position === null || Math.abs(body.scrollTop - position) > 2) position = body.scrollTop;
  // At most 100 ms per frame: after a pause (another app, a slow frame) it never jumps
  if (lastTime) position += (Math.min(time - lastTime, 100) / 1000) * 22 * songSpeed();
  body.scrollTop = position;
  lastTime = time;
  if (body.scrollTop + body.clientHeight >= body.scrollHeight - 1) return stopSongScroll();
  frame = requestAnimationFrame(songScrollStep);
}

export function toggleSongScroll() {
  if (songScrolling()) return stopSongScroll();
  setSongScrolling(true);
  flushNow();
  lastTime = 0;
  position = null;
  // The song needs the whole screen while it scrolls; the pause button stays next to "Adjust"
  toggleSongPanel(false);
  setSongControlsShown(true);
  frame = requestAnimationFrame(songScrollStep);
}

function stopSongScroll() {
  setSongScrolling(false);
  flushNow();
  if (frame) cancelAnimationFrame(frame);
  frame = null;
}

export function cycleSongSpeed() {
  setSongSpeed(speed => SONG_SPEEDS[(SONG_SPEEDS.indexOf(speed) + 1) % SONG_SPEEDS.length]);
  flushNow();
  savePrefs();
}

// --- Sharing and printing ---
/** A link to the open song for the band: the system share sheet, else the clipboard. */
export async function shareSong() {
  const song = songs().find(s => s.id === openSongId());
  if (!song) return;
  const url = `${window.location.origin}/songbook/${encodeURIComponent(songSlug(song))}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: song.title, url });
      return;
    }
    if (!(await copyText(url))) throw new Error('copy');
    showToast(t('songbook_link_copied', 'Link copied'));
  } catch (err) {
    if (asFailure(err).name !== 'AbortError') showToast(t('songbook_link_failed', 'The link could not be shared.'), 'error');
  }
}

/** Prints only the song (songbook.css: @media print). */
export function printSong() {
  document.body.classList.add('printing-song');
  const done = () => {
    document.body.classList.remove('printing-song');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

// --- The screen stays on while a song is open (players have no hand free); the lock is lost when the page hides ---
let wakeLock: WakeLockSentinel | null = null;
// A request on its way: a second one (the page shown again meanwhile) would get a lock nobody gives back
let wakeLockPending = false;
async function keepScreenOn(on: boolean) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock && !wakeLockPending && document.visibilityState === 'visible') {
      wakeLockPending = true;
      const lock = await navigator.wakeLock.request('screen').finally(() => (wakeLockPending = false));
      // The song was closed while the lock was on its way: it goes back at once (it used to keep the screen on over
      // the list until the next song was opened and closed)
      if (!isModalOpen(VIEW_ID)) return void (await lock.release());
      wakeLock = lock;
      lock.addEventListener('release', () => {
        if (wakeLock === lock) wakeLock = null;
      });
    } else if (!on && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch {
    /* not supported or refused: the screen just times out as usual */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isModalOpen(VIEW_ID)) void keepScreenOn(true);
  // rAF pauses in the background: continue from where the page is instead of jumping ahead
  lastTime = 0;
});
