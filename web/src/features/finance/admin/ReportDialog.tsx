// The financial report dialog (export-report-modal): what goes into the report on the left, the A4 page it becomes on
// the right (a phone shows them one below the other), the PDF download at the bottom. The page is white paper in both
// themes and uses plain colours only: the PDF renderer (html2canvas) cannot read color-mix() or oklch().
import type { JSX } from '@solidjs/web';
import { Match, Switch, createMemo, createSignal, onSettled } from 'solid-js';
import { appName } from '../../../app/config';
import { t } from '../../../app/i18n';
import { closeModal } from '../../../app/modals';
import { Button } from '../../../ui/Button';
import { Spinner } from '../../../ui/feedback';
import { Icon } from '../../../ui/Icon';
import { CloseButton, Modal } from '../../../ui/Modal';
import { bookingsCount, downloadReportPdf, generating, reportStatus, reportTotals, reportType, selectReportTransactions } from './report';
import { ConfigPanel } from './ReportConfig';
import { ReportPage, signed } from './ReportPage';

const PAGE_WIDTH = 794;

function Placeholder(props: { icon: JSX.Element; text: string; danger?: boolean }) {
  return (
    <div class={['flex min-h-[400px] flex-col items-center justify-center p-10 text-center', props.danger ? 'text-danger' : 'text-[#a8a29e]']}>
      {props.icon}
      <p class="m-0 font-semibold">{props.text}</p>
    </div>
  );
}

const placeholderIcon = (icon: JSX.Element) => <div class="mb-[15px] text-[0px] text-[#d6d3d1]">{icon}</div>;

/** The dialog's content: mounted while it is open (the page is measured and scaled while it is on screen). */
function ReportContent() {
  let viewport!: HTMLDivElement;
  let canvas!: HTMLDivElement;
  const [scale, setScale] = createSignal(1);
  const [pageHeight, setPageHeight] = createSignal(1120);
  const selection = createMemo(selectReportTransactions);
  const ready = () => reportStatus() === 'ready';
  const count = () => (ready() ? selection().filtered.length : 0);

  // The page keeps its A4 width and is scaled down to the space there is
  onSettled(() => {
    const observer = new ResizeObserver(() => {
      setScale(Math.min(1, (viewport.clientWidth - 40) / PAGE_WIDTH));
      setPageHeight(canvas.offsetHeight || 1120);
    });
    observer.observe(viewport);
    observer.observe(canvas);
    return () => observer.disconnect();
  });

  return (
    <>
      <div class="flex items-center gap-3.5 border-b border-border-light bg-surface px-4 py-3.5 md:px-[22px] md:py-[18px]">
        <span class="inline-flex size-[42px] shrink-0 items-center justify-center rounded-[13px] bg-gradient-primary text-white">
          <Icon name="report" size={18} />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="text-115 font-extrabold text-text">{t('report_modal_title', 'Create financial report')}</span>
          <span class="hidden text-85 text-text-secondary md:block">
            {t('report_modal_subtitle', 'Choose the period and level of detail – the preview shows the PDF.')}
          </span>
        </span>
        <CloseButton onClick={() => closeModal('export-report-modal')} />
      </div>

      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg md:flex-row md:overflow-hidden">
        <ConfigPanel onTypeChange={() => viewport && (viewport.scrollTop = 0)} />
        <div
          ref={viewport}
          class="flex flex-1 flex-col items-center justify-start gap-3 overflow-visible bg-bg px-4 pt-3.5 pb-5 md:overflow-x-hidden md:overflow-y-auto md:px-6 md:pt-[18px] md:pb-7"
        >
          <div class="flex items-center justify-between self-stretch text-72 font-extrabold tracking-[0.06em] text-text-secondary uppercase">
            <span>{t('report_preview', 'Preview')}</span>
            <span class="rounded-full border border-border-light bg-surface px-2 py-0.5 tracking-[0.04em]">A4</span>
          </div>
          <div
            class="shrink-0 overflow-hidden transition-[width,height] duration-150 ease-[ease] [color-scheme:light]"
            style={{ width: `${PAGE_WIDTH * scale()}px`, height: `${pageHeight() * scale()}px` }}
          >
            <div
              class="w-[794px] min-w-[794px] origin-top-left rounded-md bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_18px_40px_-16px_rgba(15,23,42,0.35)] transition-transform duration-150 ease-[ease]"
              style={{ transform: `scale(${scale()})` }}
            >
              <div
                id="report-print-preview"
                ref={canvas}
                class="relative box-border min-h-[1120px] bg-white px-12 pb-10 font-sans text-[13px] leading-[1.5] text-[#334155] [color-scheme:light]"
              >
                <Switch>
                  <Match when={reportStatus() === 'loading'}>
                    <Placeholder icon={<Spinner class="mx-auto mb-[15px]" />} text={t('loading', 'Loading data...')} />
                  </Match>
                  <Match when={reportStatus() === 'error'}>
                    <Placeholder icon={placeholderIcon('⚠️')} text={t('alert_error_loading_data', 'Failed to load data. Please reload the page.')} danger />
                  </Match>
                  <Match when={!count()}>
                    <Placeholder
                      icon={placeholderIcon(<Icon name="fileText" size={40} strokeWidth={1.6} />)}
                      text={
                        reportType() === 'manual'
                          ? t('report_pick_bookings', 'Tick the bookings on the left that should go into the report.')
                          : t('report_no_data', 'No data found for the selected period')
                      }
                    />
                  </Match>
                  <Match when={count()}>
                    <ReportPage selection={selection()} />
                  </Match>
                </Switch>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="flex flex-col items-stretch gap-2.5 border-t border-border-light bg-surface px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] md:flex-row md:items-center md:justify-between md:gap-3 md:px-[22px] md:py-3.5">
        <span class="min-w-0 text-center text-82 font-bold text-text-secondary md:text-left md:text-88">
          {count() ? `${bookingsCount(count())} · ${t('report_balance', 'Balance')} ${signed(reportTotals(selection().filtered).net)}` : ''}
        </span>
        <div class="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-2.5 md:flex">
          <Button variant="secondary" class="min-h-[46px] px-3 whitespace-nowrap md:min-h-0 md:px-5" onClick={() => closeModal('export-report-modal')}>
            {t('btn_cancel', 'Cancel')}
          </Button>
          <Button
            class="min-h-[46px] px-3 whitespace-nowrap md:min-h-0 md:px-5"
            disabled={!count()}
            busy={generating()}
            busyText={t('report_generating', 'Generating...')}
            onClick={() => void downloadReportPdf(canvas, appName())}
          >
            <Icon name="download" size={18} />
            <span>{t('report_download_pdf', 'Download PDF')}</span>
          </Button>
        </div>
      </div>
    </>
  );
}

export function ReportDialog() {
  return (
    <Modal
      id="export-report-modal"
      plain
      maxWidth="1240px"
      class="h-[100dvh] max-h-[100dvh] w-screen rounded-none md:h-[88vh] md:max-h-[88vh] md:w-[90vw] md:rounded-[24px]"
    >
      <ReportContent />
    </Modal>
  );
}
