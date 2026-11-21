// Picture viewer: the small preview of the tile at once, then Nextcloud's largest preview, like its own viewer
// (sharp at every zoom: two fingers, double tap, mouse wheel, the magnifier). The original is never loaded for a
// picture with a preview (it may be DNG, HEIC or a file too large for the browser); only pictures without any
// preview in a format the browser shows open as they are.
import { Show, createSignal, flush, onSettled } from 'solid-js';
import { API } from '../../app/api';
import { t } from '../../app/i18n';
import { onModalClosed, openModal, topModal } from '../../app/modals';
import { Modal } from '../../ui/Modal';
import { Icon } from '../../ui/Icon';
import {
  LARGEST_PREVIEW_SIZE, browserShowsOriginal, clampView, fileUrl, neighbourIndex, opensInViewer, pinchView, previewUrl, zoomAt
} from '../../lib/media.js';
import { fileMeta, mediaTileSize } from './files';
import { mediaShown } from './library';
import { VIEWER_BACKDROP, VIEWER_PANEL, ViewerError, ViewerSpinner, ViewerTop, viewerButton } from './viewerChrome';
import type { MediaFile } from './types';

const ID = 'media-viewer-modal';
const DOUBLE_TAP_ZOOM = 2.5;

type View = { scale: number; x: number; y: number };
type Point = { x: number; y: number };
const WHOLE: View = { scale: 1, x: 0, y: 0 };

const [pictures, setPictures] = createSignal<MediaFile[]>([]);
const [index, setIndex] = createSignal(0);
const [src, setSrc] = createSignal<string | null>(null);
// The thumbnail, slightly soft, until the large one is there
const [soft, setSoft] = createSignal(false);
const [loading, setLoading] = createSignal(false);
const [failed, setFailed] = createSignal(false);
const [zoomed, setZoomed] = createSignal(false);
const [transform, setTransform] = createSignal('');
// Jumps (double tap, back to the whole picture) glide; fingers move it directly
const [animating, setAnimating] = createSignal(false);

const current = () => pictures()[index()];
// The view as the gestures need it right away (signals show it on the next frame)
let view: View = WHOLE;
let token = 0;
let img: HTMLImageElement | undefined;
let stage: HTMLDivElement | undefined;

/** The opened picture: the largest preview; the file itself only without any preview (see above). */
function largeUrl(file: MediaFile) {
  if (file.hasPreview) return previewUrl(API, file, LARGEST_PREVIEW_SIZE);
  return browserShowsOriginal(file) ? fileUrl(API, file) : '';
}

/** Opens the picture [fileIndex] of the files shown; the arrows and swipes go through the pictures of the folder. */
export function openMediaViewer(fileIndex: number) {
  const files = mediaShown().files;
  const list = files.filter(opensInViewer);
  setPictures(list);
  setIndex(Math.max(0, list.indexOf(files[fileIndex])));
  flush();
  onModalClosed(ID, () => {
    token++;
    setSrc(null);
  });
  openModal(ID);
  showPicture();
}

/** Shows [next] (clamped to the picture); [animate] for jumps (double tap, back to fit), not for fingers. */
function setView(next: View, animate = false) {
  if (!img) return;
  view = clampView(next, { width: img.clientWidth, height: img.clientHeight }, { width: img.naturalWidth, height: img.naturalHeight });
  setAnimating(animate);
  setTransform(view.scale === 1 ? '' : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`);
  setZoomed(view.scale > 1);
}

function showPicture() {
  const file = current();
  if (!file) return;
  const mine = ++token;
  view = WHOLE;
  setAnimating(false);
  setTransform('');
  setZoomed(false);
  setFailed(false);
  // The thumbnail is already in the browser's cache: shown right away, slightly soft, until the large one is there
  const small = file.hasPreview ? previewUrl(API, file, mediaTileSize()) : '';
  setSrc(small || null);
  setSoft(!!small);
  setLoading(true);
  const large = new Image();
  large.decoding = 'async';
  large.onload = () => {
    if (mine !== token) return;
    setSrc(large.src);
    setSoft(false);
    setLoading(false);
  };
  // No large preview: never the original instead (see above), only the download
  large.onerror = () => {
    if (mine !== token) return;
    setLoading(false);
    showError();
  };
  const url = largeUrl(file);
  if (url) large.src = url;
  else {
    // Neither a preview nor a format the browser shows (a camera file without preview): only the download
    setLoading(false);
    showError();
  }
  // The neighbours are fetched meanwhile: swiping on shows them at once
  for (const direction of [1, -1]) {
    const next = pictures()[neighbourIndex(pictures(), index(), direction)];
    const nextUrl = next && next !== file ? largeUrl(next) : '';
    if (nextUrl) new Image().src = nextUrl;
  }
}

function showError() {
  setFailed(true);
  setSrc(null);
}

function stepViewer(direction: number) {
  const next = neighbourIndex(pictures(), index(), direction);
  if (next < 0) return;
  setIndex(next);
  flush();
  showPicture();
}

/** The magnifier: in to 2.5x around the middle, or back to the whole picture. */
function toggleZoom() {
  if (failed()) return;
  setView(view.scale > 1 ? WHOLE : zoomAt(view, { x: 0, y: 0 }, DOUBLE_TAP_ZOOM), true);
}

// Keys: arrows step (zoomed in: they move the picture), + / - zoom, 0 shows the whole picture
function onKey(e: KeyboardEvent) {
  if (topModal() !== ID) return;
  const moves: Record<string, [number, number]> = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] };
  if (view.scale > 1 && moves[e.key]) {
    e.preventDefault();
    setView({ ...view, x: view.x + moves[e.key][0], y: view.y + moves[e.key][1] }, true);
  } else if (e.key === 'ArrowLeft') stepViewer(-1);
  else if (e.key === 'ArrowRight') stepViewer(1);
  else if (e.key === '+' || e.key === '=') setView(zoomAt(view, { x: 0, y: 0 }, view.scale * 1.5), true);
  else if (e.key === '-') setView(zoomAt(view, { x: 0, y: 0 }, view.scale / 1.5), true);
  else if (e.key === '0') setView(WHOLE, true);
}

// --- Fingers and mouse (pointer events cover both): two fingers zoom around their middle and move the picture, one
// finger moves a zoomed picture or - not zoomed - swipes to the next one, a double tap zooms in or out, the mouse
// wheel zooms where the mouse is ---
type Gesture =
  | { kind: 'pinch'; view: View; distance: number; middle: Point }
  | { kind: 'pan' | 'swipe'; view: View; start: Point; moved: boolean };
const pointers = new Map<number, Point>();
let gesture: Gesture | null = null;
let lastTap = { time: 0, x: 0, y: 0 };

// Measured from the middle of the picture's box (its place without zoom)
function at(e: { clientX: number; clientY: number }): Point {
  const box = stage!.getBoundingClientRect();
  return { x: e.clientX - box.left - (img!.offsetLeft + img!.offsetWidth / 2), y: e.clientY - box.top - (img!.offsetTop + img!.offsetHeight / 2) };
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
// Nothing to touch without a picture
const touchable = () => !failed() && !!img?.getAttribute('src');

function begin() {
  const points = [...pointers.values()];
  if (points.length >= 2) gesture = { kind: 'pinch', view: { ...view }, distance: Math.max(1, distance(points[0], points[1])), middle: middle(points[0], points[1]) };
  else if (points.length === 1) gesture = { kind: view.scale > 1 ? 'pan' : 'swipe', view: { ...view }, start: points[0], moved: false };
  else gesture = null;
}

function tap(point: Point) {
  const now = Date.now();
  if (now - lastTap.time < 320 && distance(point, lastTap) < 30) {
    lastTap = { time: 0, x: 0, y: 0 };
    setView(view.scale > 1 ? WHOLE : zoomAt(view, point, DOUBLE_TAP_ZOOM), true);
  } else lastTap = { time: now, ...point };
}

function onPointerDown(e: PointerEvent) {
  if ((e.pointerType === 'mouse' && e.button !== 0) || !touchable()) return;
  try {
    stage!.setPointerCapture(e.pointerId);
  } catch {
    /* already gone */
  }
  pointers.set(e.pointerId, at(e));
  begin();
}

function onPointerMove(e: PointerEvent) {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, at(e));
  const points = [...pointers.values()];
  if (gesture.kind === 'pinch') {
    if (points.length >= 2) setView(pinchView(gesture.view, gesture.middle, middle(points[0], points[1]), (gesture.view.scale * distance(points[0], points[1])) / gesture.distance));
    return;
  }
  const dx = points[0].x - gesture.start.x;
  const dy = points[0].y - gesture.start.y;
  if (Math.hypot(dx, dy) > 8) gesture.moved = true;
  if (gesture.kind === 'pan') setView({ ...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy });
  // Not zoomed: the picture follows the finger sideways, so a swipe feels like turning a page
  else if (gesture.moved && pictures().length > 1) {
    setAnimating(false);
    setTransform(`translateX(${dx}px)`);
  }
}

function onPointerEnd(e: PointerEvent) {
  const point = pointers.get(e.pointerId);
  if (!point) return;
  pointers.delete(e.pointerId);
  const finished = gesture;
  if (finished?.kind === 'swipe' && pointers.size === 0) {
    const dx = point.x - finished.start.x;
    const dy = point.y - finished.start.y;
    if (pictures().length > 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      gesture = null;
      return stepViewer(dx < 0 ? 1 : -1);
    }
    if (finished.moved) setView(WHOLE, true);
    else if (e.type === 'pointerup') tap(point);
  } else if (finished?.kind === 'pan' && pointers.size === 0 && !finished.moved && e.type === 'pointerup') {
    tap(point);
  } else if (finished?.kind === 'pinch' && view.scale < 1.08) {
    setView(WHOLE, true);
  }
  // One finger left after zooming: it goes on moving the picture
  begin();
}

function onWheel(e: WheelEvent) {
  if (!touchable()) return;
  e.preventDefault();
  setView(zoomAt(view, at(e), view.scale * Math.exp(-e.deltaY * 0.0015)));
}

export function MediaViewer() {
  onSettled(() => {
    // A new size of the window: the zoomed picture has to stay in its box
    const onResize = () => {
      if (view.scale > 1) setView(view);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  });
  const several = () => pictures().length > 1;
  return (
    <Modal id={ID} plain panelClass={VIEWER_PANEL} backdropClass={VIEWER_BACKDROP} labelledBy="media-viewer-name">
      <Show when={current()}>
        {file => (
          <div class="relative flex size-full flex-col text-[#f5f5f4]">
            <ViewerTop id="media-viewer" modal={ID} name={file().name} meta={fileMeta(file())} file={file()}>
              <button
                type="button"
                id="media-viewer-zoom"
                class={viewerButton(zoomed())}
                aria-pressed={zoomed() ? 'true' : 'false'}
                title={t('media_zoom', 'Zoom')}
                aria-label={t('media_zoom', 'Zoom')}
                onClick={toggleZoom}
              >
                <Icon name="zoomIn" size={20} strokeWidth={2} />
              </button>
            </ViewerTop>
            {/* The app handles every finger on the picture itself (zoom, move, swipe): the browser must not zoom the page */}
            <div
              id="media-viewer-stage"
              ref={el => {
                stage = el;
                el.addEventListener('wheel', onWheel, { passive: false });
              }}
              class="relative flex min-h-0 flex-1 touch-none overflow-hidden px-3 pb-[calc(16px+env(safe-area-inset-bottom,0px))] select-none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
            >
              {/* The picture's box fills the stage (the picture letterboxed in it): thumbnail, preview and original all
                  show at the same size, and zooming scales the box around the middle of the screen */}
              <img
                id="media-viewer-img"
                ref={el => (img = el)}
                class={[
                  'size-full object-contain [transform-origin:center_center] will-change-transform [-webkit-user-drag:none] [&:not([src])]:invisible',
                  animating() ? '[transition:filter_0.25s_ease,transform_0.22s_cubic-bezier(0.2,0.8,0.2,1)]' : '[transition:filter_0.25s_ease]',
                  zoomed() ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in',
                  { 'blur-[2px]': soft() }
                ]}
                style={{ transform: transform() || undefined }}
                src={src() ?? undefined}
                alt={file().name}
                draggable="false"
              />
              <Show when={loading()}>
                <ViewerSpinner />
              </Show>
              <Show when={failed()}>
                <ViewerError icon="image" text={t('media_no_preview', 'This picture cannot be shown here.')} file={file()} class="absolute inset-0 justify-center" />
              </Show>
            </div>
            <Show when={several() && !zoomed()}>
              <button
                type="button"
                id="media-viewer-prev"
                class="absolute top-1/2 left-3.5 z-[2] -mt-6 flex size-12 items-center justify-center rounded-full border-0 bg-white/10 text-white hover:bg-white/22 [@media(pointer:coarse)]:hidden"
                aria-label={t('media_previous', 'Previous picture')}
                onClick={() => stepViewer(-1)}
              >
                <Icon name="chevronLeft" size={26} strokeWidth={2.4} />
              </button>
              <button
                type="button"
                id="media-viewer-next"
                class="absolute top-1/2 right-3.5 z-[2] -mt-6 flex size-12 items-center justify-center rounded-full border-0 bg-white/10 text-white hover:bg-white/22 [@media(pointer:coarse)]:hidden"
                aria-label={t('media_next', 'Next picture')}
                onClick={() => stepViewer(1)}
              >
                <Icon name="chevronRight" size={26} strokeWidth={2.4} />
              </button>
              <div
                id="media-viewer-count"
                class="absolute bottom-[calc(16px+env(safe-area-inset-bottom,0px))] left-1/2 z-[2] -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-[0.78rem] font-semibold"
              >
                {index() + 1} / {pictures().length}
              </div>
            </Show>
          </div>
        )}
      </Show>
    </Modal>
  );
}
