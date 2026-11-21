// Pieces the member finance page and the finance dialogs share: texts with a bold value, the amount field with the
// euro sign, the switch row, the amber note of a fresh start, the receipt drop zone with the chosen files, required
// fields, the dialog badges and the texts of a request.
import type { JSX } from '@solidjs/web';
import { For, Show, createSignal } from 'solid-js';
import type { FinanceRequest, Person } from '../../../app/data';
import { euro, formatDateFast, getStatusLabels, t, type MemberStatus } from '../../../app/i18n';
import { Button } from '../../../ui/Button';
import { Icon, type IconName } from '../../../ui/Icon';
import { Input, Switch } from '../../../ui/form';
import { droppedFeesBefore } from '../../../lib/finance.js';

/** A translated text whose {name} is shown in bold ("{amount} a month", "Fresh start on {date}"). */
export function BoldParam(props: { text: string; name: string; value: string }) {
  const parts = () => props.text.split(`{${props.name}}`);
  return (
    <>
      {parts()[0]}
      <strong>{props.value}</strong>
      {parts().slice(1).join(props.value)}
    </>
  );
}

/** The amount field with the euro sign in front (.hero-amount-wrapper): typed as text, read with parseAmount. */
export function AmountInput(props: { id: string; value: string; onInput: (value: string) => void; invalid?: boolean }) {
  return (
    <div class="relative flex items-center">
      <span class="pointer-events-none absolute left-3 text-[1.1rem] leading-none font-bold text-primary">€</span>
      <Input
        id={props.id}
        type="text"
        inputmode="decimal"
        placeholder={t('amount_placeholder', '0.00')}
        value={props.value}
        invalid={props.invalid}
        // Bigger and bold, room for the sign; it keeps the surface even with the error frame (as before)
        class="!h-[38px] !bg-surface !pl-7 !text-[1.15rem] font-bold tracking-[-0.01em]"
        onInput={e => props.onInput(e.currentTarget.value)}
      />
    </div>
  );
}

/** A switch with its label beside it (.modal-switch-row). */
export function SwitchRow(props: { id: string; checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <div class="flex items-center gap-2 py-0.5">
      <Switch id={props.id} size="sm" checked={props.checked} onChange={props.onChange} />
      <label for={props.id} class="m-0 cursor-pointer text-[0.85rem] font-semibold text-text">
        {props.label}
      </label>
    </div>
  );
}

/** The quiet amber note with the fresh-start symbol (.fee-reset-note); nothing without a text. */
export function FeeResetNote(props: { text: string; id?: string }) {
  return (
    <Show when={props.text}>
      <div
        id={props.id}
        class="mt-2 flex items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] px-3 py-[9px] text-[0.8rem] leading-[1.45] text-text"
      >
        <Icon name="rotate" size={14} strokeWidth={2.4} class="mt-0.5 shrink-0 text-warning" />
        <span>{props.text}</span>
      </div>
    </Show>
  );
}

/**
 * A payment dated before the fresh start belongs to the time before it: where open fees were dropped then, it first
 * makes up for those (lib/finance.js). Said where the day is chosen, so "booked, but still behind" is no riddle.
 */
export function feeResetPaymentHint(person: Person | null | undefined, day: string): string {
  const dropped = person ? droppedFeesBefore(person, day) : 0;
  return dropped > 0
    ? t('fee_reset_payment_hint', 'Before the fresh start ({date}): this first pays off the old arrears of {amount}.', {
        date: formatDateFast(person!._feeReset),
        amount: euro(dropped)
      })
    : '';
}

// --- Receipts chosen for upload (add-expense form, the member's expense request) ---
export interface PendingFile {
  file: File;
  /** A preview of a picture (an object URL, revoked when the file leaves the list). */
  url: string | null;
}

export function createPendingFiles() {
  const [files, setFiles] = createSignal<PendingFile[]>([]);
  return {
    files,
    add(list: FileList | File[] | null) {
      const added = Array.from(list || []);
      if (!added.length) return;
      setFiles(prev => [...prev, ...added.map(file => ({ file, url: file.type?.startsWith('image/') ? URL.createObjectURL(file) : null }))]);
    },
    remove(index: number) {
      const entry = files()[index];
      if (!entry) return;
      if (entry.url) URL.revokeObjectURL(entry.url);
      setFiles(prev => prev.filter((_, i) => i !== index));
    },
    reset() {
      for (const entry of files()) if (entry.url) URL.revokeObjectURL(entry.url);
      setFiles([]);
    }
  };
}

/** The drop zone with the file input (.file-upload-dropzone), as before: the input itself takes the files. */
export function ReceiptDropzone(props: { id: string; onChange: (input: HTMLInputElement) => void }) {
  return (
    <div class="relative cursor-pointer rounded-[10px] border-[1.5px] border-dashed border-border bg-surface px-3 py-2 text-center transition-[transform,opacity,box-shadow,background-color,border-color,color] duration-200 hover:border-primary hover:bg-brand/4">
      <div class="mb-px text-[1.05rem] text-text-secondary">📁</div>
      <div class="text-[0.78rem] font-semibold text-text">{t('modal_expense_receipt_text', 'Select a receipt or drag it here')}</div>
      <div class="mt-px text-[0.68rem] text-text-secondary">JPG, PNG, HEIC, PDF</div>
      <input
        type="file"
        id={props.id}
        accept="image/*,.heic,.heif,.pdf"
        multiple
        class="max-w-full text-[13.3333px]"
        onChange={e => props.onChange(e.currentTarget)}
      />
    </div>
  );
}

/** The chosen receipts: a picture's preview or a file symbol, the name, a button to take it out. */
export function PendingFileList(props: { files: PendingFile[]; onRemove: (index: number) => void }) {
  return (
    <div class="mt-2 flex flex-col gap-2">
      <For each={props.files}>
        {(entry, index) => (
          <div class="flex items-center justify-between gap-2.5 rounded-xl border border-border bg-surface-alt px-3 py-2 transition-transform duration-200">
            <div class="flex min-w-0 flex-1 items-center gap-2.5">
              <Show
                when={entry.url}
                fallback={
                  <div class="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-text-secondary">
                    <Icon name="file" size={20} />
                  </div>
                }
              >
                {url => <img src={url()} alt={t('receipt', 'Receipt')} class="size-10 rounded-lg border border-border object-cover" />}
              </Show>
              <span class="truncate text-[0.85rem] font-semibold text-text">{entry.file.name}</span>
            </div>
            <div class="flex gap-1.5">
              <Button variant="danger" size="small" class="!rounded-lg !p-1.5" title={t('btn_remove', 'Remove')} onClick={() => props.onRemove(index())}>
                <Icon name="trash" />
              </Button>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

/** Required fields (validateRequired): an empty one gets the error frame until something is typed into it again. */
export function createRequired<K extends string>() {
  const [missing, setMissing] = createSignal<ReadonlySet<K>>(new Set());
  return {
    isInvalid: (key: K) => missing().has(key),
    /** Marks the empty ones; true when every field has a value. */
    check(values: Record<K, string>): boolean {
      const empty = (Object.keys(values) as K[]).filter(key => !String(values[key] ?? '').trim());
      if (empty.length) setMissing(prev => new Set([...prev, ...empty]));
      return empty.length === 0;
    },
    clear(key: K) {
      if (!missing().has(key)) return;
      setMissing(prev => new Set([...prev].filter(entry => entry !== key)));
    }
  };
}

/** The text below a field (the status dialogs' note, the end of a standing order). */
export function FieldNote(props: { class?: string; children?: JSX.Element }) {
  return <div class={['text-[0.75rem] leading-[1.35] text-text-secondary', props.class]}>{props.children}</div>;
}

// --- Requests ---
export const REQUEST_TYPES: Record<string, { label: string; icon: IconName }> = {
  payment: { label: 'Payment', icon: 'coin' },
  status: { label: 'Status change', icon: 'history' },
  expense: { label: 'Expense', icon: 'receipt' },
  standing_order: { label: 'Standing order', icon: 'repeat' }
};
export const REQUEST_COLORS: Record<string, string> = { payment: '#10b981', expense: '#ef4444', status: '#6366f1', standing_order: '#06b6d4' };

// Plain text: the type comes from the request record, which its author writes
export const requestTypeLabel = (req: FinanceRequest) =>
  REQUEST_TYPES[req.type || ''] ? t(`request_type_${req.type}`, REQUEST_TYPES[req.type!].label) : String(req.type || '');

/** The amount of a request (or the new status). */
export function requestAmount(req: FinanceRequest, statusLabels = getStatusLabels(false)): string {
  const data = req.data || {};
  if (req.type === 'status') return statusLabels[data.newStatus as MemberStatus] || data.newStatus || '';
  if (req.type === 'standing_order') return `${euro(data.amount)} ${t('request_per_month', '/ month')}`;
  return euro(data.amount);
}

// The reason of a rejection in the reader's language: without one, the apps store "Kein Grund angegeben" (a fixed value)
export const rejectionReasonOf = (req: FinanceRequest) =>
  req.rejectionReason && req.rejectionReason !== 'Kein Grund angegeben' ? req.rejectionReason : t('user_no_reason', 'No reason given');

export const sumAmounts = (list: any[]) => list.reduce((sum, entry) => sum + parseFloat(entry.amount || 0), 0);
export const newId = () => Date.now().toString();
