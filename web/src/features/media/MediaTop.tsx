// The top of the library: sticky under the app's header, the folder's title (or, while entries are selected, what to
// do with them) and the upload's progress.
import { For, Show, createEffect, onSettled } from 'solid-js';
import { mediaStatus } from '../../app/data';
import { t } from '../../app/i18n';
import { ProgressBar } from '../../ui/feedback';
import { Icon } from '../../ui/Icon';
import { breadcrumb } from '../../lib/media';
import { deleteMediaEntries, downloadMediaEntries, mediaSelectBusy, mediaSelectionDeletable, mediaUpload, openMediaSortMenu } from './actions';
import { MEDIA_EASE } from './files';
import {
  clearMediaSelection, dropMediaTitle, mediaBack, mediaError, mediaListing, mediaOrder, mediaSelected, mediaTitles, mediaSelecting,
  toggleSelectAllMedia, type MediaTitle
} from './library';
import { openMediaRights, openMediaRulesOverview } from './MediaRights';
import { MediaPath } from './MediaPath';

const ROUND_BTN = 'flex size-[34px] shrink-0 items-center justify-center rounded-full border border-border-light bg-surface-alt text-text';

// While entries are selected their bar takes the header's place, as high as the header, so nothing below moves: the
// close sign where the back button was, how many in the title's place, all / none, download and delete
const SELECT_BTN =
  'inline-flex h-[34px] shrink-0 items-center justify-center gap-1.5 rounded-full border text-85 font-semibold transition-[background-color,border-color] duration-150 ' +
  'enabled:hover:border-border disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

// With its label beside the sign (phones: the sign only)
const SELECT_BTN_WIDE = 'px-3 [@media(max-width:600px)]:w-[34px] [@media(max-width:600px)]:px-0 [@media(max-width:600px)]:[&>span]:hidden';

// --- The top bar: sticky under the app's header (right below it while it is shown, at the very top once it hides) ---
export function MediaTop() {
  return (
    <div
      class={[
        'sticky z-[7] -mx-2 mb-1.5 rounded-b-2xl bg-[var(--frost-bg)] p-2 [-webkit-backdrop-filter:var(--frost)] [backdrop-filter:var(--frost)]',
        'transition-[top] duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]',
        'top-[var(--mobile-header-h,68px)] header-hidden:top-0 md:top-[calc(72px-var(--desktop-header-offset))] md:header-hidden:top-[calc(0px-var(--desktop-header-offset))]'
      ]}
    >
      <MediaHead />
      <Show when={mediaSelecting()}>
        <SelectBar />
      </Show>
      <MediaPath />
    </div>
  );
}

function MediaHead() {
  return (
    <div class={['mb-0.5 items-center gap-3', mediaSelecting() ? 'hidden' : 'flex']}>
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

export function UploadProgress() {
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
