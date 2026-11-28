// Receipts of bookings and requests: loaded with the session (object URLs, revoked when no longer shown), a picture
// opens large in its own dialog (receipt-preview-modal), a PDF in the browser's viewer. ReceiptList shows the
// receipts of a record, ReceiptFileRow is one receipt as a compact row (lists to manage receipts in).
import type { JSX } from '@solidjs/web';
import { For, Match, Show, Switch, createEffect, createMemo, createSignal } from 'solid-js';
import { fetchReceiptImage } from '../../../app/data';
import { t } from '../../../app/i18n';
import { closeModal, openModal } from '../../../app/modals';
import { isPdfReceipt, parseReceipts } from '../../../app/util';
import { Button, buttonClass } from '../../../ui/Button';
import { Spinner } from '../../../ui/feedback';
import { Icon, type IconName } from '../../../ui/Icon';
import { Modal } from '../../../ui/Modal';

/** The small links of a receipt (download, open): a small secondary button with a plain frame; compact: only the
 *  symbol. */
export const receiptLinkClass = (compact = false): JSX.ClassValue => [
  buttonClass({ variant: 'secondary', size: 'small' }),
  '!rounded-lg !border-border !bg-surface !text-text no-underline',
  compact ? '!p-1.5' : '!gap-1.5 !px-3 !py-1.5'
];

// --- The large view of a picture ---
const [preview, setPreview] = createSignal<{ title: string; url: string; filename: string } | null>(null);

/** Opens a receipt picture large (receipt-preview-modal), with its download. */
export function showReceiptImage(title: string, url: string, filename: string) {
  setPreview({ title: title || t('receipt', 'Receipt'), url, filename });
  openModal('receipt-preview-modal');
}

function download(url: string, filename: string) {
  const link = Object.assign(document.createElement('a'), { href: url, download: filename || 'beleg' });
  link.click();
}

export function ReceiptPreviewDialog() {
  return (
    <Modal
      id="receipt-preview-modal"
      title={preview()?.title}
      subtitle={preview()?.filename}
      icon="📎"
      maxWidth="520px"
      footer={
        <>
          <Button onClick={() => download(preview()!.url, preview()!.filename)}>📥 {t('download_btn', 'Download')}</Button>
          <Button variant="secondary" onClick={() => closeModal('receipt-preview-modal')}>
            {t('btn_close', 'Close')}
          </Button>
        </>
      }
    >
      <Show when={preview()}>
        {shown => (
          <div class="text-center">
            <img src={shown().url} alt={t('receipt', 'Receipt')} class="inline max-w-full rounded-lg border border-border align-baseline" />
          </div>
        )}
      </Show>
    </Modal>
  );
}

// --- Cards of a loaded receipt ---
function PdfThumb() {
  return (
    <div class="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary">
      <Icon name="file" size={20} />
    </div>
  );
}

function ReceiptLink(props: { href: string; download?: string; icon: IconName; label: string; compact?: boolean; newTab?: boolean }) {
  return (
    <a
      href={props.href}
      download={props.download}
      target={props.newTab ? '_blank' : undefined}
      rel={props.newTab ? 'noopener' : undefined}
      class={receiptLinkClass(props.compact)}
      title={props.label}
    >
      <Icon name={props.icon} />
      <Show when={!props.compact}>{props.label}</Show>
    </a>
  );
}

/** "Open" in the browser's PDF viewer. */
export function OpenPdfLink(props: { url: string; compact?: boolean }) {
  return <ReceiptLink href={props.url} icon="eye" label={t('media_open', 'Open')} compact={props.compact} newTab />;
}

/** Download of a receipt. */
export function DownloadLink(props: { url: string; filename: string; compact?: boolean }) {
  return <ReceiptLink href={props.url} download={props.filename} icon="download" label={t('download_btn', 'Download')} compact={props.compact} />;
}

function ReceiptCard(props: { url: string; filename: string }) {
  const [loaded, setLoaded] = createSignal(false);
  const title = () => t('receipt', 'Receipt');
  return (
    <div class="relative rounded-xl border border-border bg-surface-alt p-2.5">
      <Show
        when={!isPdfReceipt(props.filename)}
        fallback={
          <div class="flex min-w-0 items-center gap-2.5">
            <PdfThumb />
            <span class="truncate text-[0.85rem] font-semibold text-text">{props.filename}</span>
          </div>
        }
      >
        <img
          src={props.url}
          alt={title()}
          class={['inline w-full cursor-pointer rounded-lg align-baseline transition-opacity duration-300 ease-in', loaded() ? 'opacity-100' : 'opacity-0']}
          onLoad={() => setLoaded(true)}
          onClick={() => showReceiptImage(title(), props.url, props.filename)}
        />
      </Show>
      <div class="mt-2.5 flex justify-end gap-2.5">
        <Show when={isPdfReceipt(props.filename)}>
          <OpenPdfLink url={props.url} />
        </Show>
        <DownloadLink url={props.url} filename={props.filename} />
      </div>
    </div>
  );
}

type ReceiptUrls = { status: 'loading' | 'done' | 'error'; urls: string[] };

/** Object URLs of [filenames] while the caller is mounted ('loading' until all are there, 'error' if one failed). */
export function useReceiptUrls(filenames: () => string[]): () => ReceiptUrls {
  // The same names (as text) do not load again when the record is replaced by an equal one
  const key = createMemo(() => JSON.stringify(filenames()));
  const [loaded, setLoaded] = createSignal<(ReceiptUrls & { key: string }) | null>(null);
  createEffect(key, json => {
    const names = JSON.parse(json) as string[];
    const urls: string[] = [];
    let current = true;
    if (names.length) {
      void (async () => {
        try {
          for (const name of names) {
            const url = await fetchReceiptImage(name);
            if (!current) return URL.revokeObjectURL(url);
            urls.push(url);
          }
          setLoaded({ key: json, status: 'done', urls: [...urls] });
        } catch (err) {
          console.error(err);
          if (current) setLoaded({ key: json, status: 'error', urls: [] });
        }
      })();
    }
    return () => {
      current = false;
      urls.forEach(url => URL.revokeObjectURL(url));
    };
  });
  return () => {
    const result = loaded();
    if (result && result.key === key()) return result;
    return { status: filenames().length ? 'loading' : 'done', urls: [] };
  };
}

export interface ReceiptListProps {
  /** The receipt field of a record: a JSON list, a list or comma separated names. */
  receipt: unknown;
  /** 'details': a booking's dialog (big spinner, a heading over the cards); 'request': the request dialog. */
  variant: 'details' | 'request';
}

/** The receipts of a booking or request as cards: a picture opens large, a PDF in the browser. */
export function ReceiptList(props: ReceiptListProps) {
  const filenames = () => parseReceipts(props.receipt);
  const receipts = useReceiptUrls(filenames);
  const details = () => props.variant === 'details';
  const note = (text: string, danger = false): JSX.Element => (
    <div
      class={[
        danger ? 'text-danger' : 'text-text-secondary',
        details() ? ['text-center', { 'text-[0.9rem]': !danger }] : 'mt-2.5 text-[0.8rem]'
      ]}
    >
      {text}
    </div>
  );
  return (
    <Switch>
      <Match when={receipts().status === 'loading'}>
        <Spinner class={details() ? 'mx-auto my-5' : 'mx-auto my-2.5'} />
        <div class={['text-center', { 'text-[0.8rem] text-text-secondary': !details() }]}>{t('loading_receipts', 'Loading receipt(s)...')}</div>
      </Match>
      <Match when={receipts().status === 'error'}>{note(t('error_loading_receipts', 'Receipt(s) could not be loaded.'), true)}</Match>
      <Match when={!filenames().length}>{note(t('no_receipts', 'No receipts available.'))}</Match>
      <Match when={receipts().status === 'done'}>
        <Show when={details()}>
          <div class="mb-2.5 font-semibold">{t('details_receipts', 'Receipts')}</div>
        </Show>
        <div class={['flex flex-col gap-[15px]', { 'mt-2.5': !details() }]}>
          <For each={receipts().urls}>{(url, i) => <ReceiptCard url={url} filename={filenames()[i()]} />}</For>
        </div>
      </Match>
    </Switch>
  );
}

/** A receipt as a compact row: a small preview (or a spinner, a PDF or warning sign), its name, actions. */
export function ReceiptFileRow(props: { preview: JSX.Element; name: string; muted?: boolean; actions?: JSX.Element }) {
  return (
    <div class="flex items-center justify-between gap-2.5 rounded-xl border border-border bg-surface-alt px-3 py-2 transition-transform duration-200">
      <div class="flex min-w-0 flex-1 items-center gap-2.5">
        {props.preview}
        <span class={['truncate text-[0.85rem]', props.muted ? 'text-text-secondary' : 'font-semibold text-text']}>{props.name}</span>
      </div>
      <Show when={props.actions}>
        <div class="flex gap-1.5">{props.actions}</div>
      </Show>
    </div>
  );
}

/** The small preview of a receipt row: the picture, or the PDF sign. */
export function ReceiptThumb(props: { url: string; filename: string }) {
  return (
    <Show when={!isPdfReceipt(props.filename)} fallback={<PdfThumb />}>
      <img src={props.url} alt={t('receipt', 'Receipt')} class="size-10 rounded-lg border border-border object-cover" />
    </Show>
  );
}
