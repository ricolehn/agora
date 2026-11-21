// What the picture viewer, the player and the PDF viewer share: they fill the screen, dark around what they show in
// both themes, with the name, a line under it, download and close on top.
import type { JSX } from '@solidjs/web';
import { closeModal } from '../../app/modals';
import { t } from '../../app/i18n';
import { buttonClass } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import { downloadUrl } from './files';
import type { MediaFile } from './types';

/** The dialog as the whole screen: its backdrop is the dark around what it shows, the panel fills it. */
export const VIEWER_BACKDROP = 'items-stretch justify-stretch bg-[#0b0b0d]';
export const VIEWER_PANEL = 'size-full';

/** A round button on the dark top bar ([on]: pressed). */
export const viewerButton = (on = false) => [
  'inline-flex size-[42px] shrink-0 items-center justify-center rounded-full border-0 text-white no-underline',
  on ? 'bg-white/24' : 'bg-white/8 hover:bg-white/18'
];

export function ViewerTop(props: { id: string; modal: string; name: string; meta: string; file: MediaFile; children?: JSX.Element }) {
  return (
    <div class="relative z-[2] flex items-center gap-1.5 bg-[linear-gradient(rgba(0,0,0,0.55),rgba(0,0,0,0))] pt-[calc(10px+env(safe-area-inset-top,0px))] pr-3 pb-2.5 pl-[18px]">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={`${props.id}-name`} class="truncate text-[0.95rem] font-bold">
          {props.name}
        </span>
        <span id={`${props.id}-meta`} class="text-[0.76rem] text-[rgba(245,245,244,0.65)]">
          {props.meta}
        </span>
      </div>
      {props.children}
      <a
        id={`${props.id}-download`}
        class={viewerButton()}
        href={downloadUrl(props.file)}
        download={props.file.name}
        title={t('media_download', 'Download')}
        aria-label={t('media_download', 'Download')}
      >
        <Icon name="download" size={20} strokeWidth={2} />
      </a>
      <button type="button" class={viewerButton()} aria-label={t('btn_close', 'Close')} onClick={() => closeModal(props.modal)}>
        <Icon name="x" size={22} strokeWidth={2.2} />
      </button>
    </div>
  );
}

/** What cannot be shown here: a word and the download (a link button, underlined like the old ones). */
export function ViewerError(props: { icon: IconName; text: string; file: MediaFile; class?: string }) {
  return (
    <div class={['m-auto flex flex-col items-center gap-3 p-6 text-center text-[rgba(245,245,244,0.8)]', props.class]}>
      <Icon name={props.icon} size={34} strokeWidth={1.6} />
      <span>{props.text}</span>
      <a class={[buttonClass({ variant: 'secondary', size: 'small' }), 'underline']} href={downloadUrl(props.file)} download={props.file.name}>
        {t('media_download', 'Download')}
      </a>
    </div>
  );
}

/** The light ring while something loads on the dark. */
export const ViewerSpinner = () => (
  <div class="pointer-events-none absolute top-1/2 left-1/2 -mt-[17px] -ml-[17px] size-[34px] animate-[mediaSpin_0.8s_linear_infinite] rounded-full border-3 border-white/25 border-t-white" />
);
