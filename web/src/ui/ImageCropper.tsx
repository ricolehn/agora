// The crop dialog (ui/crop.ts openImageCrop): the picture in a dark viewport with the crop frame on it. Drag the
// frame, zoom with the slider, the mouse wheel or two fingers. square: the profile picture dialog (a round frame,
// 256x256 JPEG); wide: the event cover dialog (a 16:9 frame, 1280x720 JPEG, "1:1" resets the zoom).
import { Show, createSignal, onSettled } from 'solid-js';
import { t } from '../app/i18n';
import { closeModal } from '../app/modals';
import { showToast } from '../app/toast';
import { Button } from './Button';
import { CROP_MODAL_ID, cropRequest, cropSource, type CropRequest, type CropSource } from './crop';
import { Icon } from './Icon';
import { Modal } from './Modal';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** The viewport (vw x vh), the frame (cropW x cropH) and the scale at which the whole picture is shown at zoom 1. */
interface Layout {
  vw: number;
  vh: number;
  cropW: number;
  cropH: number;
  scale: number;
}
// Profile picture: a 4:3 viewport with the whole picture, the largest circle that fits with 10px around it
function squareLayout(width: number, nw: number, nh: number): Layout {
  const vw = width || 360;
  const vh = Math.round(vw * 0.75);
  const scale = Math.min(vw / nw, vh / nh);
  const size = Math.min(Math.round(nw * scale), Math.round(nh * scale), Math.min(vw, vh) - 20);
  return { vw, vh, cropW: size, cropH: size, scale };
}
// Event cover: the 16:9 frame 94% wide, the picture covering it
function wideLayout(width: number, nw: number, nh: number): Layout {
  const vw = width || 480;
  const cropW = Math.round(vw * 0.94);
  const cropH = Math.round(cropW * (9 / 16));
  return { vw, vh: Math.max(260, Math.round(vw * (9 / 16))), cropW, cropH, scale: Math.max(cropW / nw, cropH / nh) };
}

function cropToJpeg(img: HTMLImageElement, [sx, sy, sw, sh]: number[], width: number, height: number, quality: number) {
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** What is on screen: the picture's size and place, the frame's place, the zoom. */
interface View {
  layout: Layout;
  w: number;
  h: number;
  left: number;
  top: number;
  x: number;
  y: number;
  zoom: number;
}

function CropContent(props: { request: CropRequest; source: CropSource }) {
  const square = () => props.request.shape === 'square';
  const [view, setView] = createSignal<View | null>(null);
  const [busy, setBusy] = createSignal(false);
  let viewport!: HTMLDivElement;
  let image!: HTMLImageElement;
  let overlay!: HTMLDivElement;
  // The working state (pointer moves change it many times a frame); the view signal shows it
  let layout: Layout | null = null;
  let zoom = 1;
  let x = 0;
  let y = 0;

  const update = () => {
    if (!layout) return;
    const w = Math.round(props.source.width * layout.scale * zoom);
    const h = Math.round(props.source.height * layout.scale * zoom);
    const left = Math.round((layout.vw - w) / 2);
    const top = Math.round((layout.vh - h) / 2);
    // The frame stays on the picture
    x = clamp(x, left, left + w - layout.cropW);
    y = clamp(y, top, top + h - layout.cropH);
    setView({ layout, w, h, left, top, x, y, zoom });
  };
  const setZoom = (value: number) => {
    zoom = clamp(value, 1, 3);
    update();
  };

  onSettled(() => {
    // Laid out once the dialog's panel has its width
    const frame = requestAnimationFrame(() => {
      layout = (square() ? squareLayout : wideLayout)(viewport.clientWidth, props.source.width, props.source.height);
      x = Math.round((layout.vw - layout.cropW) / 2);
      y = Math.round((layout.vh - layout.cropH) / 2);
      update();
    });
    // One finger (or the mouse) on the frame moves it; two fingers anywhere in the viewport zoom
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { x: number; y: number; ox: number; oy: number } | null = null;
    let pinch: { distance: number; zoom: number } | null = null;
    const distance = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y) || 1;
    };
    const onDown = (event: PointerEvent) => {
      event.preventDefault();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      viewport.setPointerCapture(event.pointerId);
      if (pointers.size === 2) {
        drag = null;
        pinch = { distance: distance(), zoom };
      } else if (pointers.size === 1 && overlay.contains(event.target as Node)) {
        drag = { x: event.clientX, y: event.clientY, ox: x, oy: y };
      }
    };
    const onMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinch && pointers.size >= 2) setZoom((pinch.zoom * distance()) / pinch.distance);
      else if (drag) {
        x = drag.ox + event.clientX - drag.x;
        y = drag.oy + event.clientY - drag.y;
        update();
      }
    };
    const onUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) drag = null;
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom(zoom + (event.deltaY > 0 ? -0.1 : 0.1));
    };
    viewport.addEventListener('pointerdown', onDown);
    viewport.addEventListener('pointermove', onMove);
    viewport.addEventListener('pointerup', onUp);
    viewport.addEventListener('pointercancel', onUp);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('pointerdown', onDown);
      viewport.removeEventListener('pointermove', onMove);
      viewport.removeEventListener('pointerup', onUp);
      viewport.removeEventListener('pointercancel', onUp);
      viewport.removeEventListener('wheel', onWheel);
    };
  });

  const close = () => closeModal(CROP_MODAL_ID);
  const confirm = async () => {
    const current = view();
    if (!current || busy()) return;
    const scaleX = props.source.width / current.w;
    const scaleY = props.source.height / current.h;
    const sx = Math.round((current.x - current.left) * scaleX);
    const sy = Math.round((current.y - current.top) * scaleY);
    const size = Math.round(current.layout.cropW * Math.min(scaleX, scaleY));
    const blob = square()
      ? await cropToJpeg(image, [sx, sy, size, size], 256, 256, 0.85)
      : await cropToJpeg(image, [sx, sy, Math.round(current.layout.cropW * scaleX), Math.round(current.layout.cropH * scaleY)], 1280, 720, 0.82);
    if (!blob) {
      showToast(square() ? t('toast_image_processing_failed', 'Error processing image.') : t('crop_error', 'Failed to crop the image.'), 'error');
      return;
    }
    setBusy(true);
    try {
      if (await props.request.onConfirm(blob)) close();
    } finally {
      setBusy(false);
    }
  };

  const zoomSlider = (extra: string) => (
    <input
      type="range"
      min="1"
      max="3"
      step="0.01"
      value={view()?.zoom ?? 1}
      class={['flex-1', extra]}
      aria-label={t('crop_zoom', 'Zoom')}
      onInput={e => setZoom(parseFloat(e.currentTarget.value))}
    />
  );

  return (
    <>
      <div class="mt-3">
        <div
          ref={viewport}
          class={['relative w-full touch-none overflow-hidden select-none', square() ? 'rounded-[10px] bg-[#111]' : 'flex h-[290px] items-center justify-center rounded-[12px] bg-[#090d16]']}
          style={view() ? { height: `${view()!.layout.vh}px` } : undefined}
        >
          <img
            ref={image}
            src={props.source.src}
            alt={t('crop_preview_alt', 'Image crop')}
            draggable="false"
            class="pointer-events-none absolute block max-w-none"
            style={view() ? { width: `${view()!.w}px`, height: `${view()!.h}px`, left: `${view()!.left}px`, top: `${view()!.top}px` } : { visibility: 'hidden' }}
          />
          <div
            ref={overlay}
            class={[
              'absolute cursor-move touch-none',
              square() ? 'rounded-full border-[3px] border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]' : 'rounded-[8px] border-2 border-primary shadow-[0_0_0_9999px_rgba(9,13,22,0.68)]'
            ]}
            style={
              view()
                ? { width: `${view()!.layout.cropW}px`, height: `${view()!.layout.cropH}px`, left: `${view()!.x}px`, top: `${view()!.y}px` }
                : { visibility: 'hidden' }
            }
          >
            <Show when={!square()}>
              <div class="pointer-events-none absolute inset-0 rounded-[6px] border border-dashed border-white/30" />
            </Show>
          </div>
        </div>
        <Show
          when={!square()}
          fallback={
            <>
              <div class="mt-[15px] flex items-center gap-2.5">
                <Icon name="zoomOut" size={18} class="text-text-secondary" />
                {zoomSlider('')}
                <Icon name="zoomIn" size={18} class="text-text-secondary" />
              </div>
              <p class="mt-2.5 text-center text-82 text-text-secondary">
                {props.request.subtitle || t('profile_crop_desc', 'Drag and zoom image to choose crop area')}
              </p>
            </>
          }
        >
          <div class="mt-3.5 flex items-center gap-3 px-1">
            <span class="flex items-center text-85 text-text-secondary">
              <Icon name="zoomOut" size={16} />
            </span>
            {zoomSlider('cursor-pointer accent-primary')}
            <span class="flex items-center text-85 text-text-secondary">
              <Icon name="zoomIn" size={16} />
            </span>
            <Button variant="secondary" size="tiny" title={t('crop_zoom_reset', 'Reset zoom')} onClick={() => setZoom(1)}>
              1:1
            </Button>
          </div>
          <p class="mt-2.5 text-center text-80 text-text-secondary">{t('event_crop_hint', 'Move and zoom the crop area with your mouse or finger.')}</p>
        </Show>
      </div>
      <div class={square() ? 'mt-[15px] flex gap-2.5' : 'mt-4 flex justify-end gap-2.5'}>
        <Button variant="secondary" class={{ 'flex-1': square() }} onClick={close}>
          {t('btn_cancel', 'Cancel')}
        </Button>
        <Button
          id={square() ? 'btn-confirm-crop' : 'btn-confirm-event-crop'}
          class={{ 'flex-1': square() }}
          busy={busy()}
          busyText={square() ? t('btn_saving', 'Saving...') : t('saving_short', 'Saving...')}
          onClick={() => void confirm()}
        >
          {props.request.confirmLabel || (square() ? t('btn_save', 'Save') : t('crop_apply', 'Apply crop'))}
        </Button>
      </div>
    </>
  );
}

/** Mounted at the root (main.tsx): the dialog of the current crop request. */
export function ImageCropper() {
  const content = () => (
    <Show when={cropRequest() && cropSource()}>
      <CropContent request={cropRequest()!} source={cropSource()!} />
    </Show>
  );
  return (
    <Show
      when={cropRequest()?.shape === 'wide'}
      fallback={
        <Modal id={CROP_MODAL_ID} classic titleClass="tracking-normal" title={cropRequest()?.title}>
          {content()}
        </Modal>
      }
    >
      <Modal id={CROP_MODAL_ID} maxWidth="560px" title={cropRequest()?.title} subtitle={cropRequest()?.subtitle} icon={<Icon name="picture" size={18} />}>
        {content()}
      </Modal>
    </Show>
  );
}
