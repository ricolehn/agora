// The song page (song-view-modal): the text straight on the page, the controls behind an "Adjust" button at the
// bottom right - key, chords, text size, auto-scroll with its speed, sharing and printing.
import type { JSX } from '@solidjs/web';
import { For, Show, createMemo } from 'solid-js';
import { t, uiLocale } from '../../app/i18n';
import { isModalOpen } from '../../app/modals';
import { transposedKey } from '../../lib/songbook';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/form';
import { Icon } from '../../ui/Icon';
import { Modal } from '../../ui/Modal';
import { BackButton } from '../../ui/pages';
import { openSongEditor } from './SongEditor';
import { SongLines } from './SongLines';
import { type Song, canManageSongs, songbookLicense, songs } from './store';
import {
  closeSong, cycleSongSpeed, onSongBodyScroll, openSongId, printSong, resetSongKey, setSongBody, setSongChordsShown, shareSong,
  sizeSong, songBodyTap, songChords, songControlsShown, songPanelOpen, songScrolling, songSize, songSpeed, songSteps,
  toggleSongPanel, toggleSongScroll, transposeSong
} from './view';

const Glyph = (props: { size: number; strokeWidth: number; children: JSX.Element }) => (
  <svg
    width={props.size}
    height={props.size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width={props.strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {props.children}
  </svg>
);

// A round button at the top right of the page (.song-head-btn)
const HEAD_BUTTON =
  'inline-flex size-[42px] shrink-0 items-center justify-center rounded-full border border-border-light bg-surface text-text shadow-[0_4px_14px_rgba(28,25,23,0.12)] hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
// A row of the "Display" panel and its label
const PANEL_ROW = 'flex min-h-[52px] items-center justify-between gap-3 border-t border-border-light py-1.5';
const PANEL_LABEL = 'flex flex-col items-start gap-0.5 text-[0.92rem] font-bold text-text';
// Two or three buttons in one pill, and one of them
const STEPPER = 'inline-flex shrink-0 items-center gap-0.5 rounded-[14px] border border-border-light bg-surface-alt p-0.5';
const STEP =
  'inline-flex h-[38px] min-w-[42px] items-center justify-center rounded-xl border-0 px-2 font-extrabold text-text transition-[background-color,color] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
// Its text size: the symbols, the two "A" of the text size, the speed
const STEP_TEXT = 'text-[0.9rem]';
const STEP_IDLE = 'bg-transparent hover:bg-brand/12';
const STEP_ACTIVE = 'bg-gradient-primary text-white';
// The gradient pills at the bottom right (.song-pill)
const PILL =
  'inline-flex h-12 items-center gap-2 rounded-full border text-[0.95rem] font-extrabold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
const PILL_GRADIENT = 'border-transparent bg-gradient-primary text-white shadow-[0_8px_22px_rgba(var(--glow-rgb),0.35)]';

// Only the shown page takes taps: while it fades out, its floating controls must not catch them
const pageOpen = () => isModalOpen('song-view-modal');

export function SongViewModal() {
  // A song that was just deleted stays on screen while the page fades out
  const song = createMemo<Song | null>(prev => songs().find(s => s.id === openSongId()) ?? prev ?? null);
  return (
    <Modal id="song-view-modal" page maxWidth="860px" labelledBy="song-view-title">
      <Show when={song()}>{current => <SongPage song={current()} />}</Show>
    </Modal>
  );
}

function SongPage(props: { song: Song }) {
  // The (transposed) key, else the shift in semitones
  const key = () => transposedKey(props.song.key, props.song.content, songSteps());
  const shift = () => `${songSteps() > 0 ? '+' : ''}${songSteps()}`;
  // The facts a musician needs at a glance; a transposed key shows there too, so the change stays visible while the
  // controls are closed
  const keyFact = () => {
    if (songSteps()) {
      return {
        text: key() ? t('songbook_key_shifted', 'Key {key} ({shift})', { key: key(), shift: shift() }) : t('songbook_transposed', 'Transposed by {steps} semitones', { steps: shift() }),
        shifted: true
      };
    }
    return props.song.key ? { text: t('songbook_key_short', 'Key {key}', { key: props.song.key }), shifted: false } : null;
  };
  // CCLI notes after the last line (CCLI asks for licence, song number and copyright with the text)
  const ccli = () =>
    [
      songbookLicense() ? t('songbook_license', 'CCLI licence {number}', { number: songbookLicense() }) : '',
      props.song.ccli ? t('songbook_ccli_song_short', 'CCLI song {number}', { number: props.song.ccli }) : '',
      props.song.copyright ? `© ${String(props.song.copyright).replace(/^©\s*/, '')}` : ''
    ].filter(Boolean);

  return (
    <div data-song-view class="relative flex h-full w-full flex-col">
      <div
        data-song-top
        class="flex items-start gap-3 border-b border-border-light px-5 pt-[calc(14px+env(safe-area-inset-top,0px))] pb-3.5 max-[480px]:px-3.5 md:px-6"
      >
        <BackButton large onClick={closeSong} />
        <div class="min-w-0 flex-1 pt-0.5">
          <h2 id="song-view-title" class="m-0 text-[1.35rem] leading-[1.25] font-extrabold text-text [overflow-wrap:anywhere] max-[480px]:text-[1.2rem]">
            {props.song.title}
          </h2>
          {/* Songwriter and the key (as before, the line keeps its small space above even when it is empty) */}
          <div id="song-view-sub" class="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[0.88rem] text-text-secondary">
            <Show when={props.song.artist}>
              <span class="[overflow-wrap:anywhere]">{props.song.artist}</span>
            </Show>
            <Show when={keyFact()}>
              {fact => (
                <span class="inline-flex flex-wrap gap-1.5">
                  <span
                    data-song-fact
                    class={[
                      'rounded-full px-2.5 py-0.5 text-[0.76rem] font-bold whitespace-nowrap',
                      fact().shifted
                        ? 'bg-gradient-primary text-white'
                        : 'bg-brand/12 text-brand-deep dark:bg-[rgba(34,211,238,0.14)] dark:text-brand'
                    ]}
                  >
                    {fact().text}
                  </span>
                </span>
              )}
            </Show>
          </div>
        </div>
        <Show when={canManageSongs()}>
          <button
            type="button"
            id="song-edit-btn"
            class={HEAD_BUTTON}
            aria-label={t('songbook_edit', 'Edit song')}
            title={t('songbook_edit', 'Edit song')}
            onClick={() => openSongEditor(props.song)}
          >
            <Glyph size={18} strokeWidth={2}>
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </Glyph>
          </button>
        </Show>
      </div>

      <div
        id="song-view-body"
        data-song-body
        ref={setSongBody}
        class="flex-1 overflow-y-auto px-4 text-[length:var(--song-size)] leading-[1.5] text-text [--song-base:1rem] [--song-size:calc(var(--song-base)*(1+var(--song-step)*0.12))] max-[480px]:px-[18px] md:px-7 md:[--song-base:1.2rem]"
        style={{ '--song-step': String(songSize()) }}
        onClick={songBodyTap}
        onScroll={onSongBodyScroll}
      >
        <div class="px-1 pt-5 md:pt-7">
          <SongLines content={props.song.content || ''} steps={songSteps()} declaredKey={props.song.key || ''} chords={songChords()} />
          <Show when={ccli().length}>
            <div class="mt-8 flex flex-col gap-0.5 border-t border-border-light pt-3 text-[0.72rem] font-semibold text-text-secondary">
              <For each={ccli()} keyed={false}>{line => <span>{line()}</span>}</For>
            </div>
          </Show>
        </div>
        <div data-song-end class="h-[max(40vh,calc(120px+env(safe-area-inset-bottom,0px)))]" />
      </div>

      <div
        id="song-controls"
        data-song-controls
        class="pointer-events-none absolute right-4 bottom-[calc(16px+env(safe-area-inset-bottom,0px))] z-[2] flex flex-col items-end gap-2.5 md:right-6 md:bottom-6"
      >
        <SongPanel songKey={key()} shift={shift()} />
        <div
          class={[
            'flex gap-2 transition-[translate,opacity,visibility] duration-[250ms] ease-[ease]',
            songControlsShown() ? { 'pointer-events-auto': pageOpen() } : 'invisible translate-y-[calc(100%+24px)] opacity-0'
          ]}
        >
          <Show when={songScrolling()}>
            <button
              type="button"
              id="song-quick-scroll"
              class={[PILL, PILL_GRADIENT, 'w-12 justify-center p-0']}
              aria-label={t('songbook_pause', 'Pause scrolling')}
              onClick={toggleSongScroll}
            >
              <Icon name="pause" size={18} strokeWidth={2.4} />
            </button>
          </Show>
          <button
            type="button"
            id="song-panel-btn"
            class={[
              PILL,
              'pr-5 pl-4',
              songPanelOpen() ? 'border-border bg-surface text-text shadow-card-lg' : PILL_GRADIENT
            ]}
            aria-expanded={songPanelOpen() ? 'true' : 'false'}
            aria-controls="song-panel"
            onClick={() => toggleSongPanel()}
          >
            <Glyph size={18} strokeWidth={2.2}>
              <line x1="4" y1="21" x2="4" y2="14" />
              <line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" />
              <line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" />
              <line x1="9" y1="8" x2="15" y2="8" />
              <line x1="17" y1="16" x2="23" y2="16" />
            </Glyph>
            <span>{t('songbook_adjust', 'Adjust')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** The "Display" panel: key, chords, text size, auto-scroll; share and print. */
function SongPanel(props: { songKey: string; shift: string }) {
  const shifted = () => songSteps() !== 0;
  return (
    <div
      id="song-panel"
      role="group"
      aria-labelledby="song-panel-title"
      hidden={!songPanelOpen()}
      class={[
        'w-[min(360px,calc(100vw-32px))] animate-[song-panel-in_0.2s_ease-out] rounded-card border border-border bg-surface px-4 pt-3 pb-4 shadow-card-lg',
        { 'pointer-events-auto': pageOpen() }
      ]}
    >
      <div class="flex items-center justify-between gap-3 pb-1.5">
        <span id="song-panel-title" class="text-[1rem] font-extrabold text-text">
          {t('songbook_display', 'Display')}
        </span>
        <button
          type="button"
          data-panel-close
          class="inline-flex size-9 items-center justify-center rounded-full border-0 bg-surface-alt text-text-secondary hover:bg-brand/12 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          aria-label={t('btn_close', 'Close')}
          onClick={() => toggleSongPanel(false)}
        >
          <Icon name="x" size={18} strokeWidth={2.4} />
        </button>
      </div>
      <div class={PANEL_ROW}>
        <div class={PANEL_LABEL}>
          <span>{t('songbook_key_label', 'Key')}</span>
          <Show when={shifted()}>
            <button
              type="button"
              id="song-key-reset"
              class="inline-flex items-center gap-1 border-0 bg-transparent p-0 text-[0.78rem] font-bold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              onClick={resetSongKey}
            >
              <Glyph size={13} strokeWidth={2.4}>
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5" />
              </Glyph>
              <span>{t('songbook_original_key', 'Original key')}</span>
            </button>
          </Show>
        </div>
        <div class={STEPPER}>
          <button type="button" class={[STEP, STEP_TEXT, STEP_IDLE]} aria-label={t('songbook_down', 'Semitone down')} onClick={() => transposeSong(-1)}>
            <Glyph size={16} strokeWidth={2.6}>
              <line x1="5" y1="12" x2="19" y2="12" />
            </Glyph>
          </button>
          <button
            type="button"
            id="song-key"
            class={[
              'h-[38px] min-w-12 rounded-xl border-0 px-1.5 text-[0.95rem] font-extrabold text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
              shifted() ? 'cursor-pointer bg-brand/14 hover:bg-brand/12' : 'cursor-default bg-transparent'
            ]}
            aria-label={shifted() ? `${props.songKey || props.shift} – ${t('songbook_key_reset', 'Back to the original key')}` : props.songKey || t('songbook_key_label', 'Key')}
            title={shifted() ? t('songbook_key_reset', 'Back to the original key') : ''}
            onClick={resetSongKey}
          >
            {props.songKey || (shifted() ? props.shift : '♪')}
          </button>
          <button type="button" class={[STEP, STEP_TEXT, STEP_IDLE]} aria-label={t('songbook_up', 'Semitone up')} onClick={() => transposeSong(1)}>
            <Icon name="plus" size={16} strokeWidth={2.6} />
          </button>
        </div>
      </div>
      <div class={PANEL_ROW}>
        <label class={PANEL_LABEL} for="song-chords-btn">
          {t('songbook_show_chords', 'Show chords')}
        </label>
        <Switch id="song-chords-btn" checked={songChords()} onChange={setSongChordsShown} />
      </div>
      <div class={PANEL_ROW}>
        <span class={PANEL_LABEL}>{t('songbook_text_size', 'Text size')}</span>
        <div class={STEPPER}>
          <button type="button" class={[STEP, STEP_IDLE, 'text-[0.76rem]']} aria-label={t('songbook_smaller', 'Smaller text')} onClick={() => sizeSong(-1)}>
            A
          </button>
          <button type="button" class={[STEP, STEP_IDLE, 'text-[1.05rem]']} aria-label={t('songbook_larger', 'Larger text')} onClick={() => sizeSong(1)}>
            A
          </button>
        </div>
      </div>
      <div class={PANEL_ROW}>
        <span class={PANEL_LABEL}>{t('songbook_autoscroll', 'Scroll automatically')}</span>
        <div class={STEPPER}>
          <button
            type="button"
            id="song-scroll-btn"
            class={[STEP, STEP_TEXT, songScrolling() ? STEP_ACTIVE : STEP_IDLE]}
            aria-pressed={songScrolling() ? 'true' : 'false'}
            aria-label={t('songbook_autoscroll', 'Scroll automatically')}
            onClick={toggleSongScroll}
          >
            <Icon name={songScrolling() ? 'pause' : 'play'} size={16} strokeWidth={2.4} />
          </button>
          <button type="button" id="song-speed-btn" class={[STEP, STEP_IDLE, 'text-[0.8rem]']} aria-label={t('songbook_speed', 'Speed')} onClick={cycleSongSpeed}>
            {songSpeed().toLocaleString(uiLocale())}×
          </button>
        </div>
      </div>
      <div class="flex gap-2 border-t border-border-light pt-3">
        <Button variant="secondary" class="flex-1 !px-3 !py-2.5 !text-[0.86rem]" onClick={() => void shareSong()}>
          <Glyph size={16} strokeWidth={2}>
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </Glyph>
          <span>{t('songbook_share', 'Share link')}</span>
        </Button>
        <Button variant="secondary" class="flex-1 !px-3 !py-2.5 !text-[0.86rem]" onClick={printSong}>
          <Glyph size={16} strokeWidth={2}>
            <polyline points="6 9 6 2 18 2 18 9" />
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <rect x="6" y="14" width="12" height="8" />
          </Glyph>
          <span>{t('songbook_print', 'Print')}</span>
        </Button>
      </div>
    </div>
  );
}
