// The entries of a folder: folders as rows like the apps in Extras (a small 3D folder in a painted field), files three
// to a row with their names under them; both give a little when pressed and can be selected.
import { For, Show, createSignal, onSettled } from 'solid-js';
import { API } from '../../app/api';
import { mediaStatus } from '../../app/data';
import { t, uiLocale } from '../../app/i18n';
import { Icon, type IconName } from '../../ui/Icon';
import { MEDIA_FIELD, fileLook, formatSize, previewUrl, shownName, typeLabel } from '../../lib/media';
import { seedOf } from '../../lib/motifs';
import { folderMeta, mediaTileSize } from './files';
import { isMediaSelected, mediaSelecting, type MediaViewOf } from './library';
import { MotifSvg, PaintedField } from './motif';
import type { MediaAccess, MediaFile, MediaFolder } from './types';

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

export function Entries(props: { view: MediaViewOf<'entries'> }) {
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
        mediaSelecting()
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
        <span class={['mr-2 inline-flex shrink-0 text-[var(--media-accent)] opacity-80 group-hover:invisible', { invisible: mediaSelecting() }]} aria-hidden="true">
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
