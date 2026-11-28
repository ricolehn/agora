// The library's tab, as in the Android app: the header (or, while entries are selected, what to do with them) and
// the path stay in reach on top; folders as rows like the apps in Extras (a small 3D folder in a painted field),
// files three to a row with their names under them; folders and tiles give a little when pressed.
import type { JSX } from '@solidjs/web';
import { For, Match, Switch, createEffect, createSignal, onSettled } from 'solid-js';
import { t } from '../../app/i18n';
import { anyModalOpen } from '../../app/modals';
import { activeTab } from '../../app/router';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/feedback';
import { deleteMediaEntries, mediaSelectionDeletable, openMediaEntry, openMediaMenu, setMediaFileInput, uploadMediaFiles } from './actions';
import { MEDIA_EASE } from './files';
import {
  clearMediaSelection, dropMediaPage, loadMediaFolder, mediaListing, mediaPages, mediaSelected, selectAllMedia, toggleMediaSelected,
  mediaSelecting, type MediaLoadError, type MediaPageState, type MediaPageView, type MediaViewOf
} from './library';
import { closeMediaMenu, mediaMenuOpen } from './MediaMenu';
import { MotifSvg } from './motif';
import type { MediaAccess } from './types';
import { MediaTop, UploadProgress } from './MediaTop';
import { Entries } from './MediaEntries';

export function MediaPage() {
  const [dropping, setDropping] = createSignal(false);
  // Dropping files on the page uploads them into the open folder
  const canDrop = (e: DragEvent) => mediaListing()?.access === 'write' && [...(e.dataTransfer?.types || [])].includes('Files');

  // Keys: Escape closes the menu (else ends the selection), Ctrl / Cmd + A selects everything, Delete deletes it.
  // Heard before the dialogs' own Escape (capture phase): an Escape that closes a dialog (the folder rights, a picture
  // opened from the menu) must not also end the selection - a handler after it finds the dialog already closed
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (activeTab() !== 'media' || anyModalOpen()) return;
      const active = document.activeElement as HTMLElement | null;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName || '') || !!active?.isContentEditable;
      if (e.key === 'Escape') {
        if (mediaMenuOpen()) closeMediaMenu();
        else clearMediaSelection();
      } else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && mediaListing()) {
        e.preventDefault();
        selectAllMedia();
      } else if (!typing && e.key === 'Delete' && mediaSelecting() && mediaSelectionDeletable()) {
        void deleteMediaEntries([...mediaSelected()]);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  return (
    <div
      class="[--media-accent:#e0874f] dark:[--media-accent:#e5925d]"
      onDragOver={e => {
        if (!canDrop(e)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={e => {
        setDropping(false);
        if (!canDrop(e)) return;
        e.preventDefault();
        void uploadMediaFiles(e.dataTransfer?.files);
      }}
    >
      <MediaTop />
      <UploadProgress />
      <MediaList dropping={dropping()} />
      <input type="file" id="media-file-input" multiple hidden ref={setMediaFileInput} onChange={e => void uploadMediaFiles(e.currentTarget.files)} />
    </div>
  );
}

// --- The pages: the open folder's, and the one it replaces while that moves on ---
const LONG_PRESS_MS = 480;

function MediaList(props: { dropping: boolean }) {
  // Holding a finger on an entry selects it; then a tap selects too (no menu of the browser, no opening)
  let press: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let lastPointer = 'mouse';
  let suppressClick = false;
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  const itemOf = (target: EventTarget | null) => (target as Element | null)?.closest?.<HTMLElement>('[data-media-name]') || null;
  const on = (target: EventTarget | null, selector: string) => !!(target as Element | null)?.closest?.(selector);

  return (
    <div
      id="media-list"
      class={['relative', { 'rounded-2xl outline-2 outline-offset-[6px] outline-primary outline-dashed': props.dropping }]}
      onPointerDown={e => {
        lastPointer = e.pointerType;
        suppressClick = false;
        const item = itemOf(e.target);
        if (!item || e.pointerType === 'mouse' || on(e.target, '[data-media-check]')) return;
        const name = item.dataset.mediaName!;
        press = {
          x: e.clientX,
          y: e.clientY,
          timer: setTimeout(() => {
            press = null;
            suppressClick = true;
            navigator.vibrate?.(12);
            toggleMediaSelected(name);
          }, LONG_PRESS_MS)
        };
      }}
      onPointerMove={e => {
        if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      onClick={e => {
        const item = itemOf(e.target);
        if (!item) return;
        const name = item.dataset.mediaName!;
        if (suppressClick) {
          suppressClick = false;
          e.preventDefault();
          return;
        }
        // The round mark, a selection under way, Ctrl / Cmd + click, Shift + click (from the last one picked)
        if (on(e.target, '[data-media-check]') || mediaSelecting() || e.ctrlKey || e.metaKey || e.shiftKey) {
          e.preventDefault();
          toggleMediaSelected(name, { range: e.shiftKey });
          return;
        }
        if (on(e.target, '[data-media-open]')) openMediaEntry(name);
      }}
      onContextMenu={e => {
        const item = itemOf(e.target);
        if (!item) return;
        e.preventDefault();
        // A finger held down selects (above) instead of opening the menu of the browser
        if (lastPointer === 'touch' || lastPointer === 'pen') return;
        const keyboard = !e.clientX && !e.clientY;
        const rect = item.getBoundingClientRect();
        openMediaMenu(item.dataset.mediaName!, keyboard ? rect.left + 16 : e.clientX, keyboard ? rect.top + 16 : e.clientY);
      }}
    >
      <For each={mediaPages()} keyed={page => page.id}>
        {page => <PageView page={page()} />}
      </For>
    </div>
  );
}

const viewOf = <K extends MediaPageView['kind']>(view: MediaPageView, kind: K) => (view.kind === kind ? (view as MediaViewOf<K>) : null);

function PageView(props: { page: MediaPageState }) {
  let el!: HTMLDivElement;
  // A folder further in rises from below, one further out comes down from above
  onSettled(() => {
    const shift = props.page.enter;
    if (!shift || !el.getClientRects().length) return;
    el.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], { duration: 340, easing: MEDIA_EASE });
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 60, easing: 'linear', fill: 'backwards' });
  });
  // The page left moves on and fades over the new one
  createEffect(
    () => (props.page.leaving ? { ...props.page.leaving, id: props.page.id } : null),
    out => {
      if (!out) return;
      const gone = () => dropMediaPage(out.id);
      el.animate([{ transform: 'none' }, { transform: `translateY(${out.shift}px)` }], { duration: 260, easing: MEDIA_EASE, fill: 'forwards' }).finished.then(gone, gone);
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'linear', fill: 'forwards' });
    }
  );
  const view = () => props.page.view;
  return (
    <div
      ref={el}
      class={{ 'pointer-events-none absolute inset-x-0': !!props.page.leaving, 'animate-[mediaContentIn_0.32s_var(--ease)]': props.page.fresh }}
      style={props.page.leaving ? { top: `${props.page.leaving.top}px` } : undefined}
    >
      <Switch>
        <Match when={view().kind === 'loading'}>
          {/* Only after a moment, so fast folders do not flash */}
          <div class="flex animate-[mediaFadeIn_0.3s_ease_0.18s_backwards] justify-center py-[72px]" aria-busy="true" role="status">
            <Spinner size={44} class="m-0" />
            <span class="sr-only">{t('loading', 'Loading data...')}</span>
          </div>
        </Match>
        <Match when={viewOf(view(), 'error')}>{failure => <LoadError error={failure().error} />}</Match>
        <Match when={viewOf(view(), 'empty')}>{empty => <EmptyFolder access={empty().access} />}</Match>
        <Match when={viewOf(view(), 'entries')}>{entries => <Entries view={entries()} />}</Match>
      </Switch>
    </div>
  );
}

/** An empty folder or one that could not be loaded: the folder motif with a word, and what can be done. */
function MediaMessage(props: { title: string; hints?: Array<string | false>; action?: JSX.Element }) {
  return (
    <div class="flex flex-col items-center gap-2 px-6 pt-10 pb-6 text-center">
      <MotifSvg motif="folder" class="mb-1.5 block size-[76px]" />
      <span class="text-base font-semibold text-text">{props.title}</span>
      <For each={(props.hints || []).filter((hint): hint is string => !!hint)}>
        {hint => <span class="max-w-[38ch] text-88 leading-[1.45] text-text-secondary">{hint}</span>}
      </For>
      {props.action}
    </div>
  );
}

function LoadError(props: { error: MediaLoadError }) {
  return (
    <MediaMessage
      title={props.error.unavailable ? t('media_unavailable', 'There is nothing to see here yet.') : props.error.message}
      action={
        <Button variant="secondary" size="small" class="mt-1.5" onClick={() => void loadMediaFolder()}>
          {t('btn_retry', 'Try again')}
        </Button>
      }
    />
  );
}

function EmptyFolder(props: { access: MediaAccess }) {
  // A manager in a folder the rights hide from them: not empty, only not theirs to see
  const hidden = () => props.access === 'none';
  return (
    <MediaMessage
      title={hidden() ? t('media_hidden_title', 'The files here are hidden from you') : t('media_empty', 'This folder is empty')}
      hints={[
        hidden() && t('media_hidden_hint', 'The folder rights apply to you too. Change them with the shield to see the files.'),
        props.access === 'write' && t('media_empty_hint', 'Add files with the plus at the bottom right, or drop them here.')
      ]}
    />
  );
}
