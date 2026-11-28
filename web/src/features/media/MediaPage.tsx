// The library's tab, as in the Android app: the header (or, while entries are selected, what to do with them) and
// the path stay in reach on top; folders as rows like the apps in Extras (a small 3D folder in a painted field),
// files three to a row with their names under them; folders and tiles give a little when pressed.
import type { JSX } from '@solidjs/web';
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onSettled } from 'solid-js';
import { API } from '../../app/api';
import { mediaStatus } from '../../app/data';
import { t, uiLang, uiLocale } from '../../app/i18n';
import { anyModalOpen } from '../../app/modals';
import { activeTab } from '../../app/router';
import { Button } from '../../ui/Button';
import { ProgressBar, Spinner } from '../../ui/feedback';
import { Icon, type IconName } from '../../ui/Icon';
import { MEDIA_FIELD, breadcrumb, fileLook, formatSize, pathSteps, previewUrl, shownName, typeLabel, type PathStep } from '../../lib/media';
import { seedOf } from '../../lib/motifs';
import {
  deleteMediaEntries, downloadMediaEntries, mediaSelectBusy, mediaSelectionDeletable, mediaUpload, openMediaEntry, openMediaMenu,
  openMediaPathMenu, openMediaSortMenu, setMediaFileInput, uploadMediaFiles
} from './actions';
import { MEDIA_EASE, folderMeta, mediaTileSize } from './files';
import {
  clearMediaSelection, dropMediaPage, dropMediaTitle, isMediaSelected, loadMediaFolder, mediaBack, mediaError, mediaFolder,
  mediaListing, mediaOrder, mediaPages, mediaSelected, mediaTitles, openMediaCrumb, selectAllMedia, toggleMediaSelected,
  toggleSelectAllMedia, type MediaLoadError, type MediaPageState, type MediaPageView, type MediaTitle
} from './library';
import { closeMediaMenu, mediaMenuOpen } from './MediaMenu';
import { openMediaRights, openMediaRulesOverview } from './MediaRights';
import { MotifSvg, PaintedField } from './motif';
import type { MediaAccess, MediaFile, MediaFolder } from './types';

const selecting = () => mediaSelected().size > 0;

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
      } else if (!typing && e.key === 'Delete' && selecting() && mediaSelectionDeletable()) {
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

// --- The top bar: sticky under the app's header (right below it while it is shown, at the very top once it hides) ---
function MediaTop() {
  return (
    <div
      class={[
        'sticky z-[7] -mx-2 mb-1.5 rounded-b-2xl bg-[var(--frost-bg)] p-2 [-webkit-backdrop-filter:var(--frost)] [backdrop-filter:var(--frost)]',
        'transition-[top] duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]',
        'top-[var(--mobile-header-h,68px)] header-hidden:top-0 md:top-[calc(72px-var(--desktop-header-offset))] md:header-hidden:top-[calc(0px-var(--desktop-header-offset))]'
      ]}
    >
      <MediaHead />
      <Show when={selecting()}>
        <SelectBar />
      </Show>
      <MediaPath />
    </div>
  );
}

const ROUND_BTN = 'flex size-[34px] shrink-0 items-center justify-center rounded-full border border-border-light bg-surface-alt text-text';

function MediaHead() {
  return (
    <div class={['mb-0.5 items-center gap-3', selecting() ? 'hidden' : 'flex']}>
      <button type="button" class={[ROUND_BTN, 'mr-1']} aria-label={t('btn_back', 'Back')} onClick={mediaBack}>
        <Icon name="chevronLeft" size={20} strokeWidth={2.4} />
      </button>
      <h1
        id="media-title"
        class="relative m-0 min-w-0 flex-1 overflow-hidden text-125 font-extrabold tracking-[-0.022em] text-text md:text-145 dark:text-[#e4ded6]"
      >
        <For each={mediaTitles()} keyed={title => title.id}>
          {title => <TitleText title={title()} />}
        </For>
      </h1>
      <div class="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          id="media-sort-btn"
          class={[ROUND_BTN, 'hover:border-border']}
          aria-haspopup="menu"
          title={t('media_sort', 'Order')}
          aria-label={t('media_sort', 'Order')}
          onClick={e => openMediaSortMenu(e.currentTarget)}
        >
          <Icon name="sort" size={18} strokeWidth={2.2} />
        </button>
        {/* The shield stays while a folder loads: whether the member sets rights is the same in every folder */}
        <Show when={mediaStatus().canManage && !mediaError()}>
          <button
            type="button"
            id="media-rights-btn"
            class={[ROUND_BTN, 'hover:border-border']}
            title={t('media_rights_folder', 'Rights of this folder')}
            aria-label={t('media_rights_folder', 'Rights of this folder')}
            onClick={() => void openMediaRights()}
          >
            <Icon name="shield" size={18} strokeWidth={2} />
          </button>
        </Show>
        <Show when={mediaStatus().canManage}>
          <button
            type="button"
            id="media-rules-btn"
            class={[ROUND_BTN, 'hover:border-border']}
            title={t('media_rules_overview', 'All folder rights')}
            aria-label={t('media_rules_overview', 'All folder rights')}
            onClick={() => void openMediaRulesOverview()}
          >
            <Icon name="list" size={18} />
          </button>
        </Show>
      </div>
    </div>
  );
}

/** The open folder's name; a new one moves in from below (a folder further in) or from above, the old one out. */
function TitleText(props: { title: MediaTitle }) {
  let el!: HTMLSpanElement;
  onSettled(() => {
    const way = props.title.enter;
    if (!way || !el.getClientRects().length) return;
    el.animate([{ transform: `translateY(${way * 100}%)` }, { transform: 'none' }], { duration: 320, easing: MEDIA_EASE });
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 60, fill: 'backwards' });
  });
  createEffect(
    () => (props.title.leaving ? { way: props.title.leaving, id: props.title.id } : null),
    out => {
      if (!out) return;
      const gone = () => dropMediaTitle(out.id);
      el.animate([{ transform: 'none', opacity: 1 }, { transform: `translateY(${-out.way * 100}%)`, opacity: 0 }], {
        duration: 260,
        easing: MEDIA_EASE,
        fill: 'forwards'
      }).finished.then(gone, gone);
    }
  );
  return (
    <span ref={el} class={['block truncate', { 'absolute inset-x-0 top-0': !!props.title.leaving }]}>
      {props.title.path ? breadcrumb(props.title.path).pop()!.name : t('media_title', 'Media')}
    </span>
  );
}

// While entries are selected their bar takes the header's place, as high as the header, so nothing below moves: the
// close sign where the back button was, how many in the title's place, all / none, download and delete
const SELECT_BTN =
  'inline-flex h-[34px] shrink-0 items-center justify-center gap-1.5 rounded-full border text-85 font-semibold transition-[background-color,border-color] duration-150 ' +
  'enabled:hover:border-border disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
// With its label beside the sign (phones: the sign only)
const SELECT_BTN_WIDE = 'px-3 [@media(max-width:600px)]:w-[34px] [@media(max-width:600px)]:px-0 [@media(max-width:600px)]:[&>span]:hidden';

function SelectBar() {
  const count = () => mediaSelected().size;
  const deletable = () => mediaSelectionDeletable();
  return (
    <div
      id="media-selectbar"
      role="toolbar"
      aria-label={t('media_selection', 'Selection')}
      class={['relative mb-0.5 flex min-h-[34px] items-center gap-1.5 animate-[mediaSelectbarIn_0.22s_var(--ease)]', { 'pointer-events-none opacity-60': mediaSelectBusy() }]}
    >
      <button
        type="button"
        class={[SELECT_BTN, 'w-[34px] border-border-light bg-surface-alt px-0 text-text']}
        title={t('media_select_clear', 'Clear selection')}
        aria-label={t('media_select_clear', 'Clear selection')}
        onClick={clearMediaSelection}
      >
        <Icon name="x" size={18} strokeWidth={2.4} />
      </button>
      <span
        id="media-selectbar-count"
        class="ml-2 min-w-0 flex-1 truncate text-125 font-extrabold tracking-[-0.022em] text-text tabular-nums md:text-145"
        aria-live="polite"
      >
        {count() === 1 ? t('media_selected_one', '1 selected') : t('media_selected', '{count} selected', { count: count() })}
      </span>
      <button type="button" class={[SELECT_BTN, SELECT_BTN_WIDE, 'border-transparent bg-transparent text-text-secondary']} onClick={toggleSelectAllMedia}>
        <Icon name="checkSquare" size={16} strokeWidth={2.4} />
        <span id="media-select-all-label">{count() >= mediaOrder().length ? t('media_select_none', 'Select none') : t('media_select_all', 'Select all')}</span>
      </button>
      <button
        type="button"
        id="media-select-download"
        class={[SELECT_BTN, SELECT_BTN_WIDE, 'border-border-light bg-surface-alt text-text']}
        title={t('media_download', 'Download')}
        onClick={() => void downloadMediaEntries([...mediaSelected()])}
      >
        <Icon name="download" size={16} strokeWidth={2.4} />
        <span>{t('media_download', 'Download')}</span>
      </button>
      <Show when={mediaListing()?.access === 'write'}>
        <button
          type="button"
          id="media-select-delete"
          class={[
            SELECT_BTN,
            SELECT_BTN_WIDE,
            'border-[color-mix(in_srgb,var(--danger)_24%,var(--border-light))] bg-[color-mix(in_srgb,var(--danger)_8%,var(--surface))] text-danger'
          ]}
          disabled={!deletable()}
          title={deletable() ? t('media_delete', 'Delete') : t('media_delete_not_allowed', 'You may not delete everything in a selected folder.')}
          onClick={() => void deleteMediaEntries([...mediaSelected()])}
        >
          <Icon name="trash" size={16} strokeWidth={2.4} />
          <span>{t('media_delete', 'Delete')}</span>
        </button>
      </Show>
    </div>
  );
}

// --- The path: pills with a small arrow between them, the open one painted in the library's warm colours. From
// three folders down the base folder shows only its sign; deeper than three the middle folds into "…" (its folders
// in a menu). The row keeps its end in sight; what does not fit fades at the edges, a pill that comes with a new path
// fades in ---

const PILL =
  'inline-flex min-h-8 max-w-[228px] items-center gap-1.5 whitespace-nowrap rounded-full border py-[5px] text-88 leading-[1.25] ' +
  '[transition:background-color_0.2s_ease,color_0.2s_ease,transform_0.2s_cubic-bezier(0.34,1.4,0.64,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
const PILL_WAY = 'border-hairline bg-surface font-medium text-text-secondary hover:bg-surface-alt hover:text-text active:[transform:scale(0.96)]';
const PILL_OPEN =
  'cursor-default border-white/70 font-semibold text-text bg-[linear-gradient(90deg,color-mix(in_oklab,#f6c7a4,#ffffff_38%),color-mix(in_oklab,#f6c7a4,#ffffff_12%))] ' +
  'dark:border-white/6 dark:bg-[linear-gradient(90deg,color-mix(in_oklab,var(--surface),#e0874f_34%),color-mix(in_oklab,var(--surface),#e0874f_20%))]';

function MediaPath() {
  let nav!: HTMLElement;
  const [edges, setEdges] = createSignal({ start: false, end: false });
  const steps = createMemo(() => pathSteps(mediaFolder(), t('media_title', 'Media')));
  const syncEdges = () => setEdges({ start: nav.scrollLeft > 1, end: nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1 });
  // A pill that comes with a new path fades in (not the first ones)
  let drawn = false;
  // The row keeps its end in sight
  createEffect(
    () => [mediaFolder(), uiLang(), activeTab() === 'media'],
    () => {
      nav.scrollLeft = nav.scrollWidth;
      syncEdges();
    }
  );
  onSettled(() => {
    drawn = true;
    window.addEventListener('resize', syncEdges);
    return () => window.removeEventListener('resize', syncEdges);
  });
  const stepKey = (step: PathStep) => (step.folded.length ? '…' : `/${step.target}`);
  return (
    <nav
      id="media-crumbs"
      ref={nav}
      aria-label={t('media_path', 'Folder path')}
      class={[
        'flex min-w-0 items-center overflow-x-auto overflow-y-hidden pt-0.5 pb-1 [scrollbar-width:none]',
        '[-webkit-mask-image:linear-gradient(to_right,transparent_0,#000_var(--fade-start),#000_calc(100%-var(--fade-end)),transparent_100%)]',
        '[mask-image:linear-gradient(to_right,transparent_0,#000_var(--fade-start),#000_calc(100%-var(--fade-end)),transparent_100%)]'
      ]}
      style={{ '--fade-start': edges().start ? '28px' : '0px', '--fade-end': edges().end ? '28px' : '0px' }}
      onScroll={syncEdges}
    >
      <For each={steps()} keyed={stepKey}>
        {(step, index) => {
          const fresh = drawn;
          return <PathPill step={step()} first={index() === 0} open={index() === steps().length - 1} compactRoot={steps().length >= 4} fresh={fresh} />;
        }}
      </For>
    </nav>
  );
}

function PathPill(props: { step: PathStep; first: boolean; open: boolean; compactRoot: boolean; fresh: boolean }) {
  const compact = () => props.step.root && props.compactRoot;
  const content = () => (
    <>
      <Show when={props.step.root}>
        <MotifSvg motif="folder" class="block size-5 shrink-0" />
      </Show>
      <Show when={!compact()}>
        <span class="min-w-0 overflow-hidden text-ellipsis">{props.step.name}</span>
      </Show>
    </>
  );
  const padding = () => [props.step.root ? 'pl-2' : 'pl-3.5', compact() ? 'pr-2' : 'pr-3.5'];
  return (
    <span class={['inline-flex shrink-0 items-center', { 'animate-[mediaFadeIn_0.18s_cubic-bezier(0,0,0.2,1)_backwards]': props.fresh }]}>
      <Show when={!props.first}>
        <span class="mx-1 inline-flex text-text-secondary opacity-50" aria-hidden="true">
          <Icon name="chevronRight" size={16} strokeWidth={2.2} />
        </span>
      </Show>
      <Switch
        fallback={
          <button
            type="button"
            class={[PILL, PILL_WAY, padding()]}
            title={props.step.name}
            aria-label={compact() ? props.step.name : undefined}
            onClick={() => openMediaCrumb(props.step.target)}
          >
            {content()}
          </button>
        }
      >
        <Match when={props.step.folded.length}>
          <button
            type="button"
            class={[PILL, PILL_WAY, 'px-2.5']}
            aria-haspopup="menu"
            title={t('media_path_between', 'Folders in between')}
            aria-label={t('media_path_between', 'Folders in between')}
            onClick={e => openMediaPathMenu(e.currentTarget)}
          >
            <Icon name="more" size={20} strokeWidth={2.6} />
          </button>
        </Match>
        {/* The open folder is where you are, not a way to go */}
        <Match when={props.open}>
          <span class={[PILL, PILL_OPEN, padding()]} aria-current="page" title={props.step.name}>
            {content()}
          </span>
        </Match>
      </Switch>
    </span>
  );
}

function UploadProgress() {
  const text = (state: { count: number; percent: number | null }) =>
    state.percent === null
      ? state.count === 1
        ? t('media_uploading_one', 'Uploading 1 file…')
        : t('media_uploading', 'Uploading {count} files…', { count: state.count })
      : state.percent < 100
        ? t('media_uploading_percent', 'Uploading… {percent} %', { percent: state.percent })
        : t('media_upload_storing', 'Saving in the cloud…');
  return (
    <Show when={mediaUpload()}>
      {state => (
        <div id="media-upload" class="mb-3.5 flex items-center gap-3 rounded-[14px] border border-border-light bg-surface px-3.5 py-2.5">
          <ProgressBar class="flex-1" fill="bg-primary" fillId="media-upload-fill" percent={state().percent ?? 0} />
          <span id="media-upload-text" class="whitespace-nowrap text-80 font-semibold text-text-secondary">
            {text(state())}
          </span>
        </div>
      )}
    </Show>
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
        if (on(e.target, '[data-media-check]') || selecting() || e.ctrlKey || e.metaKey || e.shiftKey) {
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

type ViewOf<K extends MediaPageView['kind']> = Extract<MediaPageView, { kind: K }>;
const viewOf = <K extends MediaPageView['kind']>(view: MediaPageView, kind: K) => (view.kind === kind ? (view as ViewOf<K>) : null);

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

/** What the member may do in the open folder: only look, or also add (managers know it), or see no files here. */
function AccessNote(props: { access: MediaAccess; hasFolders: boolean }) {
  const note = (): { write: boolean; icon: IconName; text: string } | null =>
    props.access === 'read'
      ? { write: false, icon: 'eye', text: t('media_access_read', 'Read only') }
      : props.access === 'write' && !mediaStatus().canManage
        ? { write: true, icon: 'upload', text: t('media_access_write', 'You can add files here') }
        : // The rights hold for managers too: they also open folders whose files are hidden from them
          props.access === 'none' && mediaStatus().canManage && props.hasFolders
          ? { write: false, icon: 'eyeOff', text: t('media_access_none', 'Files hidden from you') }
          : null;
  return (
    <Show when={note()}>
      {current => (
        <div class="mt-1 mb-0.5 flex">
          <span
            class={[
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-[5px] text-72 font-semibold',
              current().write ? 'bg-[color-mix(in_srgb,var(--primary)_8%,transparent)] text-primary' : 'bg-surface-alt text-text-secondary'
            ]}
          >
            <Icon name={current().icon} size={13} strokeWidth={2.2} class="shrink-0" />
            <span>{current().text}</span>
          </span>
        </div>
      )}
    </Show>
  );
}

function SectionLabel(props: { label: string; count: number }) {
  return (
    <h2 class="mt-5 mb-3 ml-0.5 flex items-baseline gap-2 text-75 font-bold tracking-[0.067em] text-text-secondary uppercase first:mt-3">
      {props.label}
      <span class="text-75 font-semibold tracking-normal text-text-secondary tabular-nums opacity-60">{props.count}</span>
    </h2>
  );
}

function Entries(props: { view: ViewOf<'entries'> }) {
  return (
    <>
      <AccessNote access={props.view.access} hasFolders={props.view.folders.length > 0} />
      <Show when={props.view.folders.length}>
        <SectionLabel label={t('media_section_folders', 'Folders')} count={props.view.folders.length} />
        {/* Two side by side on wider screens; min-width: 0 keeps a long name from making a row wider than the screen */}
        <div class="grid grid-cols-2 gap-x-2 gap-y-2.5 [@media(max-width:600px)]:grid-cols-1">
          <For each={props.view.folders} keyed={folder => folder.path}>
            {folder => <FolderRow folder={folder()} />}
          </For>
        </div>
      </Show>
      <Show when={props.view.files.length}>
        <SectionLabel label={t('media_section_files', 'Files')} count={props.view.files.length} />
        {/* Three pictures side by side on phones, tiles of at least 150px on wider screens */}
        <div class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-2 gap-y-2.5 [@media(max-width:600px)]:grid-cols-3">
          <For each={props.view.files} keyed={file => `${file.path}|${file.etag}`}>
            {file => <FileTile file={file()} />}
          </For>
        </div>
      </Show>
    </>
  );
}

/**
 * The round mark of a folder or tile: shown on hover and while selecting, filled when selected. Only where it can be
 * seen it can be hit (an invisible one would catch taps meant to open the entry).
 */
function CheckMark(props: { name: string; selected: boolean; tile?: boolean }) {
  return (
    <button
      type="button"
      data-media-check=""
      aria-pressed={props.selected ? 'true' : 'false'}
      aria-label={t('media_select_item', 'Select {name}', { name: props.name })}
      class={[
        'absolute z-[4] inline-flex size-6 items-center justify-center rounded-full border-2 p-0',
        '[transition:opacity_0.18s_ease,transform_0.18s_var(--ease),background-color_0.18s_ease,border-color_0.18s_ease]',
        'focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:[transform:none] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
        selecting()
          ? 'pointer-events-auto opacity-100'
          : 'pointer-events-none opacity-0 [transform:scale(0.85)] group-hover:opacity-100 group-hover:[transform:none] [@media(hover:hover)]:pointer-events-auto',
        props.selected
          ? 'border-white bg-primary text-white'
          : props.tile
            ? 'border-white bg-black/18 text-transparent hover:border-primary'
            : 'border-border bg-transparent text-transparent hover:border-primary',
        props.tile ? 'top-1.5 right-1.5 shadow-[0_1px_3px_rgba(0,0,0,0.16)]' : ['top-1/2 right-3.5 -mt-3', { 'shadow-[0_0_0_1px_var(--primary)]': props.selected }]
      ]}
    >
      <Icon name="check" size={14} strokeWidth={3} class="size-[13px]" />
    </button>
  );
}

const PRESSABLE = 'select-none [-webkit-touch-callout:none]';

/** A folder: a row like the apps in Extras - the folder in a painted field, its name, date and size, an arrow. */
function FolderRow(props: { folder: MediaFolder }) {
  const selected = () => isMediaSelected(props.folder.name);
  return (
    <div
      data-media-name={props.folder.name}
      class={[
        'group relative min-w-0 rounded-[20px] border active:[transform:scale(0.96)]',
        '[transition:transform_0.22s_cubic-bezier(0.34,1.4,0.64,1),border-color_0.2s_ease,background-color_0.2s_ease,box-shadow_0.2s_ease]',
        PRESSABLE,
        selected()
          ? 'border-[color-mix(in_srgb,var(--primary)_60%,transparent)] bg-[color-mix(in_srgb,var(--primary)_8%,var(--surface))] shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--primary)_60%,transparent),0_4px_12px_rgba(28,25,23,0.07)] dark:shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--primary)_60%,transparent),0_4px_12px_rgba(0,0,0,0.35)]'
          : 'border-hairline bg-surface shadow-[0_4px_12px_rgba(28,25,23,0.07)] hover:border-[color-mix(in_srgb,var(--media-accent)_32%,var(--border-light))] hover:shadow-[0_8px_20px_rgba(28,25,23,0.1)] dark:shadow-[0_4px_12px_rgba(0,0,0,0.35)] dark:hover:shadow-[0_8px_20px_rgba(0,0,0,0.45)]'
      ]}
    >
      <button
        type="button"
        data-media-open=""
        class="flex w-full min-w-0 items-center rounded-[20px] p-[7px] text-left text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        title={props.folder.name}
      >
        <PaintedField colors={MEDIA_FIELD} seed={seedOf(props.folder.name)} class="size-14 rounded-[14px]">
          <MotifSvg motif="folder" class="block size-[64%] [grid-area:1/1]" />
        </PaintedField>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5 pr-2 pl-3.5">
          <span class="line-clamp-2 min-w-0 text-88 leading-[1.43] font-semibold [overflow-wrap:anywhere]">{props.folder.name}</span>
          <Show when={folderMeta(props.folder)}>
            {meta => <span class="truncate text-70 text-text-secondary tabular-nums">{meta()}</span>}
          </Show>
        </span>
        <span class={['mr-2 inline-flex shrink-0 text-[var(--media-accent)] opacity-80 group-hover:invisible', { invisible: selecting() }]} aria-hidden="true">
          <Icon name="chevronRight" size={18} strokeWidth={2.4} />
        </span>
      </button>
      <CheckMark name={props.folder.name} selected={selected()} />
    </div>
  );
}

/**
 * A file: its square and under it its name (without the type its tile shows) and size. The square is the painted
 * field of its kind with its motif, under the preview while that comes (a play sign on videos); without a preview the
 * motif is larger and the type (PDF, DOCX, MP3) stands in its corner.
 */
function FileTile(props: { file: MediaFile }) {
  let img: HTMLImageElement | undefined;
  const size = mediaTileSize();
  // The thumbnail fades in when it arrives; without one (no preview for this file) the motif of its kind stays
  const [thumb, setThumb] = createSignal<'' | 'loaded' | 'failed'>('');
  const look = () => fileLook(props.file);
  const preview = () => !!props.file.hasPreview && thumb() !== 'failed';
  const type = () => typeLabel(props.file.name);
  const selected = () => isMediaSelected(props.file.name);
  const meta = () => formatSize(props.file.size, uiLocale());
  onSettled(() => {
    if (img?.complete && img.naturalWidth) setThumb('loaded');
  });
  return (
    <div data-media-name={props.file.name} class={['group relative min-w-0', PRESSABLE]}>
      <button
        type="button"
        data-media-open=""
        class="flex w-full min-w-0 flex-col rounded-xl p-0 text-left text-text [transition:transform_0.22s_cubic-bezier(0.34,1.4,0.64,1)] active:[transform:scale(0.96)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        title={props.file.name}
      >
        <PaintedField
          colors={look().colors}
          seed={seedOf(props.file.name)}
          ring={selected()}
          class={['aspect-square w-full rounded-xl [transition:transform_0.25s_var(--ease)]', { '[transform:scale(0.9)]': selected() }]}
        >
          <span class={['flex [grid-area:1/1]', preview() ? 'w-[32%]' : 'w-[42%]']}>
            <MotifSvg motif={look().motif} accent={look().colors.deep} class="block aspect-square h-auto w-full" />
          </span>
          <Show when={preview()}>
            <img
              ref={img}
              class={['absolute inset-0 z-[1] size-full object-cover transition-opacity duration-[350ms] ease-[ease]', thumb() === 'loaded' ? 'opacity-100' : 'opacity-0']}
              src={previewUrl(API, props.file, size)}
              alt=""
              loading="lazy"
              decoding="async"
              draggable="false"
              onLoad={() => setThumb('loaded')}
              onError={() => setThumb('failed')}
            />
          </Show>
          <Show when={props.file.kind === 'video' && preview()}>
            <span class="pointer-events-none absolute top-1/2 left-1/2 z-[2] -mt-[17px] -ml-[17px] flex size-[34px] items-center justify-center rounded-full bg-white/90 text-[#2a2830] shadow-[0_2px_8px_rgba(0,0,0,0.25)]">
              <Icon name="playFilled" size={21} />
            </span>
          </Show>
          <Show when={type() && !preview()}>
            <span class="absolute top-2 left-2 z-[2] rounded-[5px] bg-[color-mix(in_srgb,var(--field-deep)_92%,transparent)] px-[5px] py-px text-56 leading-[1.5] font-extrabold tracking-[0.04em] text-white">
              {type()}
            </span>
          </Show>
        </PaintedField>
        <span class="truncate px-0.5 pt-1.5 text-75 leading-[1.35] font-semibold">{shownName(props.file.name)}</span>
        <Show when={meta()}>
          <span class="truncate px-0.5 text-70 leading-[1.35] text-text-secondary tabular-nums">{meta()}</span>
        </Show>
      </button>
      <CheckMark name={props.file.name} selected={selected()} tile />
    </div>
  );
}
