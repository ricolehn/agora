// PDF viewer: the browser's own on computers (search, print); pdf.js on phones and tablets, whose browsers show a
// PDF in a page only as its first page or not at all. pdf.js is loaded the first time it is needed.
import { For, Match, Show, Switch, createEffect, createSignal, flush, onSettled } from 'solid-js';
// Only the worker's address (an asset of the build); pdf.js itself is loaded when the first PDF opens
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { API } from '../../app/api';
import { t, uiLocale } from '../../app/i18n';
import { onModalClosed, openModal } from '../../app/modals';
import { Modal } from '../../ui/Modal';
import { fileUrl, formatSize } from '../../lib/media.js';
import { ZoomIcon } from './icons';
import { VIEWER_PANEL, ViewerError, ViewerSpinner, ViewerTop, viewerButton } from './viewerChrome';
import type { MediaFile } from './types';

type PdfJs = typeof import('pdfjs-dist');
type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;

const ID = 'media-pdf-modal';
const usesNativePdfViewer = () => navigator.pdfViewerEnabled === true && !window.matchMedia('(pointer: coarse)').matches;

let pdfjsLoading: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsLoading ||= import('pdfjs-dist')
    .then(lib => {
      lib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return lib;
    })
    .catch(err => {
      pdfjsLoading = null;
      throw err;
    });
  return pdfjsLoading;
}

/** The document on screen: its pages are drawn as they come into view, at the width of the zoom. */
interface PdfView {
  file: MediaFile;
  zoom: number;
  doc?: PdfDocument;
  loadingTask?: ReturnType<PdfJs['getDocument']>;
  observer?: IntersectionObserver;
  draws: Map<Element, () => void>;
}

const [file, setFile] = createSignal<MediaFile | null>(null);
const [native, setNative] = createSignal(false);
const [doc, setDoc] = createSignal<{ pages: number; ratio: number } | null>(null);
const [failed, setFailed] = createSignal(false);
const [pageWidth, setPageWidth] = createSignal(0);
let pdfView: PdfView | null = null;
let stage: HTMLDivElement | undefined;

function closePdfView() {
  if (!pdfView) return;
  pdfView.observer?.disconnect();
  void pdfView.loadingTask?.destroy();
  pdfView = null;
}

export function openMediaPdf(next: MediaFile) {
  closePdfView();
  const useNative = usesNativePdfViewer();
  setFile(next);
  setNative(useNative);
  setDoc(null);
  setFailed(false);
  flush();
  onModalClosed(ID, closePdfView);
  openModal(ID);
  if (!useNative) void renderWithPdfJs(next);
}

async function renderWithPdfJs(target: MediaFile) {
  const view: PdfView = { file: target, zoom: 1, draws: new Map() };
  pdfView = view;
  try {
    const lib = await loadPdfJs();
    if (pdfView !== view) return;
    view.loadingTask = lib.getDocument({ url: fileUrl(API, target), enableXfa: false });
    view.doc = await view.loadingTask.promise;
    if (pdfView !== view) return;
    const first = (await view.doc.getPage(1)).getViewport({ scale: 1 });
    if (pdfView !== view) return;
    view.observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) if (entry.isIntersecting) view.draws.get(entry.target)?.();
      },
      { root: stage, rootMargin: '800px 0px' }
    );
    layoutPages(view);
    setDoc({ pages: view.doc.numPages, ratio: first.height / first.width });
  } catch (err) {
    if (pdfView !== view) return;
    console.warn('PDF could not be shown:', err);
    setFailed(true);
  }
}

/** Sizes the pages for the zoom (they are drawn again as they come into view). */
function layoutPages(view: PdfView) {
  setPageWidth(Math.round(Math.min((stage?.clientWidth || 0) - 24, 960) * view.zoom));
  flush();
}

function zoomPdf(direction: number) {
  const view = pdfView;
  if (!view?.doc || !stage) return;
  const anchor = stage.scrollTop / Math.max(1, stage.scrollHeight);
  view.zoom = Math.min(3, Math.max(0.5, view.zoom * (direction > 0 ? 1.25 : 0.8)));
  layoutPages(view);
  stage.scrollTop = anchor * stage.scrollHeight;
}

function PdfPage(props: { number: number; ratio: number }) {
  let box!: HTMLDivElement;
  const [canvas, setCanvas] = createSignal<HTMLCanvasElement | null>(null);
  // The page's own proportions once drawn (the first page's until then)
  const [ratio, setRatio] = createSignal<string | null>(null);
  let drawn = '';
  let drawing = '';
  const draw = async () => {
    const view = pdfView;
    if (!view?.doc) return;
    const width = box.getBoundingClientRect().width;
    const key = `${Math.round(width)}`;
    if (drawn === key || drawing === key) return;
    drawing = key;
    try {
      const page = await view.doc.getPage(props.number);
      if (pdfView !== view) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (width / base.width) * Math.min(window.devicePixelRatio || 1, 3) });
      // A fresh canvas per drawing: a zoom while a page is still drawing must not draw into the same one
      const next = document.createElement('canvas');
      next.width = Math.floor(viewport.width);
      next.height = Math.floor(viewport.height);
      next.className = 'block size-full';
      setRatio(`${base.width} / ${base.height}`);
      await page.render({ canvas: next, viewport }).promise;
      if (pdfView !== view || drawing !== key) return;
      setCanvas(next);
      drawn = key;
    } catch (err) {
      if (pdfView === view) console.warn(`PDF page ${props.number} could not be drawn:`, err);
    } finally {
      if (drawing === key) drawing = '';
    }
  };
  onSettled(() => {
    const view = pdfView;
    if (!view) return;
    view.draws.set(box, draw);
    return () => view.draws.delete(box);
  });
  // Observed anew with every width: the pages in view are drawn again
  createEffect(pageWidth, () => {
    const observer = pdfView?.observer;
    if (!observer) return;
    observer.unobserve(box);
    observer.observe(box);
  });
  return (
    <div
      ref={box}
      class="max-w-none shrink-0 overflow-hidden rounded-[3px] bg-white shadow-[0_2px_14px_rgba(0,0,0,0.45)]"
      style={{ width: `${pageWidth()}px`, 'aspect-ratio': ratio() ?? `1 / ${props.ratio}` }}
    >
      {canvas()}
    </div>
  );
}

export function MediaPdf() {
  const meta = (current: MediaFile) => {
    const size = formatSize(current.size, uiLocale());
    const pages = doc()?.pages;
    if (!pages) return size;
    return [pages === 1 ? t('media_pdf_pages_one', '1 page') : t('media_pdf_pages', '{count} pages', { count: pages }), size].join(' · ');
  };
  return (
    <Modal id={ID} plain class={VIEWER_PANEL}>
      <Show when={file()}>
        {current => (
          <div class="relative flex size-full flex-col text-[#f5f5f4]">
            <ViewerTop id="media-pdf" modal={ID} name={current().name} meta={meta(current())} file={current()}>
              <Show when={!native()}>
                <div id="media-pdf-zoom" class="flex gap-1.5">
                  <button type="button" class={viewerButton()} aria-label={t('media_zoom_out', 'Zoom out')} onClick={() => zoomPdf(-1)}>
                    <ZoomIcon out />
                  </button>
                  <button type="button" class={viewerButton()} aria-label={t('media_zoom_in', 'Zoom in')} onClick={() => zoomPdf(1)}>
                    <ZoomIcon />
                  </button>
                </div>
              </Show>
            </ViewerTop>
            <div
              id="media-pdf-stage"
              ref={el => (stage = el)}
              class={[
                'relative flex min-h-0 flex-1 flex-col items-center gap-3 overflow-auto [-webkit-overflow-scrolling:touch]',
                native() ? 'p-0' : 'px-3 pt-1 pb-[calc(20px+env(safe-area-inset-bottom,0px))]'
              ]}
            >
              <Switch
                fallback={
                  <div class="relative w-full flex-1">
                    <ViewerSpinner />
                  </div>
                }
              >
                <Match when={native()}>
                  <iframe class="size-full flex-1 border-0 bg-white" src={fileUrl(API, current())} title={current().name} />
                </Match>
                <Match when={failed()}>
                  <ViewerError icon="fileText" text={t('media_pdf_failed', 'This PDF cannot be shown here.')} file={current()} />
                </Match>
                <Match when={doc()}>
                  {loaded => <For each={Array.from({ length: loaded().pages }, (_, i) => i + 1)}>{number => <PdfPage number={number} ratio={loaded().ratio} />}</For>}
                </Match>
              </Switch>
            </div>
          </div>
        )}
      </Show>
    </Modal>
  );
}
