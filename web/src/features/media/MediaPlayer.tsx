// Video and music: played right in the app (the browser's own controls); a format the browser cannot play is
// offered as a download.
import { Show, createSignal, onSettled } from 'solid-js';
import { API } from '../../app/api';
import { t } from '../../app/i18n';
import { onModalClosed, openModal } from '../../app/modals';
import { Modal } from '../../ui/Modal';
import { Icon } from '../../ui/Icon';
import { fileUrl, previewUrl, viewerSize } from '../../lib/media';
import { fileMeta } from './files';
import { VIEWER_BACKDROP, VIEWER_PANEL, ViewerError, ViewerTop } from './viewerChrome';
import type { MediaFile } from './types';

const ID = 'media-player-modal';
// The file of the player, a new opening every time: the player is made anew for every file opened, also when it opens
// again while the last one still fades out (that one lost its source when it closed, and only a new player starts
// playing by itself)
const [opening, setOpening] = createSignal<{ file: MediaFile } | null>(null);
const [failed, setFailed] = createSignal(false);
let player: HTMLMediaElement | undefined;

export function openMediaPlayer(next: MediaFile) {
  setOpening({ file: next });
  setFailed(false);
  onModalClosed(ID, () => {
    // Stops playing and loading at once (only taking it out of the page leaves the download running)
    player?.pause();
    player?.removeAttribute('src');
    player?.load();
    player = undefined;
  });
  openModal(ID);
}

/** The video or the music; opened with a tap, browsers let it start right away (one that does not shows its play button). */
function Player(props: { file: MediaFile }) {
  let element!: HTMLMediaElement;
  onSettled(() => {
    player = element;
    element.play().catch(() => {});
  });
  const src = () => fileUrl(API, props.file);
  const poster = () => (props.file.hasPreview ? previewUrl(API, props.file, viewerSize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1)) : undefined);
  return (
    <Show
      when={props.file.kind === 'video'}
      fallback={
        <div class="flex w-[min(460px,100%)] flex-col items-center gap-[18px] rounded-[22px] border border-white/8 bg-white/6 px-[22px] py-8 text-center">
          <span class="flex size-[104px] items-center justify-center rounded-[28px] bg-[linear-gradient(135deg,rgba(217,119,6,0.35),rgba(124,58,237,0.3))] text-[#fbbf24]">
            <Icon name="music" size={46} strokeWidth={1.6} />
          </span>
          <span class="text-base font-bold text-[#f5f5f4] [overflow-wrap:anywhere]">{props.file.name}</span>
          <audio ref={el => (element = el)} class="w-full" controls preload="metadata" src={src()} onError={() => setFailed(true)} />
        </div>
      }
    >
      <video
        ref={el => (element = el)}
        class="size-full max-h-full rounded-[6px] bg-black object-contain outline-none"
        controls
        playsinline
        preload="metadata"
        poster={poster()}
        src={src()}
        onError={() => setFailed(true)}
      />
    </Show>
  );
}

export function MediaPlayer() {
  return (
    <Modal id={ID} plain panelClass={VIEWER_PANEL} backdropClass={VIEWER_BACKDROP} labelledBy="media-player-name">
      <Show when={opening()} keyed>
        {({ file: current }) => (
          <div class="relative flex size-full flex-col text-[#f5f5f4]">
            <ViewerTop id="media-player" modal={ID} name={current.name} meta={fileMeta(current)} file={current} />
            {/* Video as large as fits, music as a calm card */}
            <div class="flex min-h-0 flex-1 items-center justify-center px-3 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
              <Show
                when={!failed()}
                fallback={
                  <ViewerError
                    icon={current.kind === 'video' ? 'play' : 'music'}
                    text={current.kind === 'video' ? t('media_video_failed', 'This video cannot be played in this browser.') : t('media_audio_failed', 'This file cannot be played in this browser.')}
                    file={current}
                  />
                }
              >
                <Player file={current} />
              </Show>
            </div>
          </div>
        )}
      </Show>
    </Modal>
  );
}
