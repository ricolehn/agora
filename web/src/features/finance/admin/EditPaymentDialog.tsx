// Changing or deleting a booked entry (edit-payment-modal, confirm-delete-modal): a member's payment on the latest
// copy of the member's record, a donation or an expense (with its receipts) in the stored list.
import { For, Match, Show, Switch, createSignal } from 'solid-js';
import { findPerson, mutateCollection, mutatePerson, replaceById, sumAmounts, uploadReceipt } from '../../../app/data';
import { t } from '../../../app/i18n';
import { closeModal, closeMultipleModals, openModal } from '../../../app/modals';
import { canManageFinances } from '../../../app/session';
import { confirmAction, showToast } from '../../../app/toast';
import { isPdfReceipt, parseReceipts, safeList } from '../../../app/util';
import { Button } from '../../../ui/Button';
import { Spinner } from '../../../ui/feedback';
import { Field, Input, Label } from '../../../ui/form';
import { MODAL_TINTS, Modal, ModalBody, ModalHeader, ModalSection } from '../../../ui/Modal';
import { findPaymentIndex, parseAmount } from '../../../lib/finance';
import { FeeResetNote, feeResetPaymentHint } from '../common';
import { DownloadLink, OpenPdfLink, ReceiptFileRow, ReceiptThumb, useReceiptUrls } from './Receipts';
import { refreshFinanceViews, type Transaction } from './state';
import { Icon } from '../../../ui/Icon';
import type { BookingFields } from '../../../app/types';
import { errorMessage } from '../../../app/api';

type EntryType = 'payment' | 'donation' | 'expense';
interface EditedEntry {
  personId: string | null;
  targetIndex: number;
  type: EntryType;
  paymentId: string | null;
  original: BookingFields;
  label: string;
}

const [edited, setEdited] = createSignal<EditedEntry | null>(null);
const [amount, setAmount] = createSignal('');
const [date, setDate] = createSignal('');
const [description, setDescription] = createSignal('');
const [issuer, setIssuer] = createSignal('');
const [receipts, setReceipts] = createSignal<string[]>([]);
const [saving, setSaving] = createSignal(false);
let newReceiptsInput: HTMLInputElement | undefined;

const matchesPaymentId = (id: unknown) => (entry: { id?: unknown }, i: number) => String(entry.id ?? `idx-${i}`) === String(id);
/** The list with the entry changed; a donation or expense deleted meanwhile is an error (it used to say "updated"
 *  while nothing was saved: a list without the entry is not written). */
function changedEntry<T extends { id?: unknown }>(list: T[], id: unknown, fields: Partial<T>) {
  const next = replaceById(list, id, fields);
  if (!next) throw new Error('The entry was deleted in the meantime');
  return next;
}

/** Opens a booking of the history to change it (only for those who manage the finances). */
export function openEditPayment(tx: Transaction) {
  if (!canManageFinances()) return;
  const type = (({ pay: 'payment', don: 'donation', exp: 'expense' }) as Record<string, EntryType>)[tx.type] || (tx.type as EntryType);
  const personId = tx.personId || null;
  const paymentId = tx.paymentId || null;
  let targetIndex = tx.paymentIndex !== undefined ? tx.paymentIndex : -1;
  let payment = tx.payment || null;
  const person = type === 'payment' ? findPerson(personId) : null;
  if (person) {
    const idx = safeList(person.payments).findIndex(matchesPaymentId(paymentId));
    if (idx >= 0) targetIndex = idx;
    payment = safeList(person.payments)[targetIndex] || payment;
  }
  if (!payment) return console.error('openEditPayment: no payment structure resolved.', { personId, paymentId, targetIndex, type });

  const isExpense = type === 'expense';
  const prefix = ({ donation: `[${t('report_type_donation', 'Donation')}] `, expense: `[${t('report_type_expense', 'Expense')}] ` } as Record<string, string>)[type] || '';
  setEdited({ personId, targetIndex, type, paymentId, original: payment, label: prefix + (tx.personName || tx.who || t('status_unknown', 'Unknown')) });
  setAmount(String(payment.amount ?? ''));
  setDate(payment.date || '');
  setDescription(payment.description || '');
  setIssuer(isExpense ? payment.issuer || payment.name || '' : '');
  setReceipts(isExpense ? parseReceipts(payment.receipt) : []);
  setSaving(false);
  openModal('edit-payment-modal');
}

async function saveEditedPayment() {
  const opened = edited();
  if (!canManageFinances() || !opened) return;
  const value = parseAmount(amount());
  const day = date();
  const note = description().trim();
  const who = issuer().trim();
  if (Number.isNaN(value)) return showToast(t('alert_invalid_amount', 'Invalid amount. Please enter it like 1500 or 1,500.00.'), 'error');
  if (!day) return showToast(t('alert_please_enter_date', 'Please specify a date.'), 'error');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return showToast(t('alert_invalid_date', 'Invalid date.'), 'error');

  setSaving(true);
  const { type, personId, paymentId } = opened;
  try {
    if (type === 'payment') {
      await mutatePerson(personId!, draft => {
        const payments = draft.payments;
        const idx = findPaymentIndex(payments, opened);
        if (idx < 0) throw new Error('The payment was changed or deleted in the meantime');
        payments[idx] = { ...payments[idx], amount: value, date: day, description: note };
        return { ...draft, payments, totalPaid: sumAmounts(payments) };
      });
      showToast(t('toast_payment_updated', 'Payment updated'));
    } else if (type === 'expense') {
      const names = [...receipts()];
      for (const file of newReceiptsInput?.files || []) {
        try {
          names.push(await uploadReceipt(file, who || 'Beleg', day));
        } catch (uploadErr) {
          console.error('Error uploading new receipt in edit:', uploadErr);
          showToast(t('alert_upload_error_for', 'Failed to upload: ') + file.name + ' - ' + errorMessage(uploadErr), 'error');
          throw uploadErr;
        }
      }
      const receipt = names.length > 0 ? JSON.stringify(names) : '';
      await mutateCollection('expenses', list => changedEntry(list, paymentId, { amount: value, date: day, description: note, issuer: who, receipt }));
      showToast(t('toast_expense_updated', 'Expense updated'));
    } else {
      await mutateCollection('donations', list => changedEntry(list, paymentId, { amount: value, date: day, description: note }));
      showToast(t('toast_donation_updated', 'Donation updated'));
    }
    closeModal('edit-payment-modal');
    setEdited(null);
    setReceipts([]);
    refreshFinanceViews();
  } catch (err) {
    console.error('Editing failed:', err);
    showToast(t('toast_update_failed', 'Entry could not be updated'), 'error');
  } finally {
    setSaving(false);
  }
}

async function confirmDeleteRecordedPayment() {
  const opened = edited();
  if (!canManageFinances() || !opened) return;
  const { type, personId, paymentId } = opened;
  closeMultipleModals(['confirm-delete-modal', 'edit-payment-modal']);
  try {
    if (type === 'payment') {
      await mutatePerson(personId!, draft => {
        const idx = findPaymentIndex(draft.payments, opened);
        if (idx < 0) throw new Error('The payment was changed or deleted in the meantime');
        const payments = draft.payments.filter((_: unknown, i: number) => i !== idx);
        return { ...draft, payments, totalPaid: sumAmounts(payments) };
      });
    } else {
      await mutateCollection(type === 'donation' ? 'donations' : 'expenses', list => list.filter(entry => String(entry.id) !== String(paymentId)));
    }
    showToast(
      { payment: t('toast_payment_deleted', 'Payment deleted'), donation: t('toast_donation_deleted', 'Donation deleted'), expense: t('toast_expense_deleted', 'Expense deleted') }[type]
    );
    setEdited(null);
    refreshFinanceViews();
  } catch (err) {
    console.error('Deleting failed:', err);
    showToast(t('toast_delete_failed', 'Entry could not be deleted'), 'error');
  }
}

function deleteEditReceipt(filename: string) {
  if (!confirmAction(t('confirm_delete_receipt', 'Are you sure you want to delete this receipt?'))) return;
  setReceipts(receipts().filter(name => name !== filename));
}

/** A receipt of the edited expense: loading, then its preview with open (PDF), download and delete. */
function EditReceiptRow(props: { filename: string }) {
  const state = useReceiptUrls(() => [props.filename]);
  const Remove = () => (
    <Button variant="danger" size="small" class="rounded-lg p-1.5" title={t('btn_delete', 'Delete')} onClick={() => deleteEditReceipt(props.filename)}>
      <Icon name="trash" size={14} />
    </Button>
  );
  return (
    <Switch>
      <Match when={state().status === 'loading'}>
        <ReceiptFileRow preview={<Spinner size={16} stroke={2} class="m-0" />} name={props.filename} muted />
      </Match>
      <Match when={state().status === 'error'}>
        <ReceiptFileRow preview={<span class="text-[1.25rem]">⚠️</span>} name={props.filename} actions={<Remove />} />
      </Match>
      <Match when={state().urls[0]}>
        {url => (
          <ReceiptFileRow
            preview={<ReceiptThumb url={url()} filename={props.filename} />}
            name={props.filename}
            actions={
              <>
                <Show when={isPdfReceipt(props.filename)}>
                  <OpenPdfLink url={url()} compact />
                </Show>
                <DownloadLink url={url()} filename={props.filename} compact />
                <Remove />
              </>
            }
          />
        )}
      </Match>
    </Switch>
  );
}

function EditPaymentForm(props: { entry: EditedEntry }) {
  const isExpense = () => props.entry.type === 'expense';
  const resetHint = () => (props.entry.type === 'payment' ? feeResetPaymentHint(findPerson(props.entry.personId), date()) : '');
  return (
    <>
      <ModalSection icon="💶" title={t('modal_section_amount_date', 'Amount & date')}>
        <div class="relative flex items-center">
          <span class="pointer-events-none absolute left-3 z-[1] text-[1.1rem] leading-none font-bold text-primary">€</span>
          <Input
            type="text"
            inputmode="decimal"
            id="edit-payment-amount"
            class="h-[38px] rounded-[9px] bg-surface pl-7 text-[1.15rem] font-bold tracking-[-0.01em] text-text"
            value={amount()}
            onInput={e => setAmount(e.currentTarget.value)}
          />
        </div>
        <Field label={t('modal_date', 'Date')} for="edit-payment-date">
          <Input type="date" id="edit-payment-date" value={date()} onInput={e => setDate(e.currentTarget.value)} />
          <FeeResetNote text={resetHint()} />
        </Field>
      </ModalSection>
      <ModalSection icon="📝" title={t('modal_note', 'Note')}>
        <Input
          type="text"
          id="edit-payment-desc"
          placeholder={t('modal_note_placeholder', 'e.g. May fee')}
          value={description()}
          onInput={e => setDescription(e.currentTarget.value)}
        />
        <Show when={isExpense()}>
          <Field label={t('modal_recipient', 'Who / Recipient')} for="edit-payment-issuer">
            <Input
              type="text"
              id="edit-payment-issuer"
              placeholder={t('modal_recipient_placeholder', 'Name')}
              value={issuer()}
              onInput={e => setIssuer(e.currentTarget.value)}
            />
          </Field>
        </Show>
      </ModalSection>
      <Show when={isExpense()}>
        {/* Its parts sit close together, without the sections' gaps (as before) */}
        <ModalSection icon="📎" title={t('manage_receipts', 'Manage Receipts')} class="!block">
          <div class="mb-1.5 flex flex-col gap-2">
            <For each={receipts()} fallback={<div class="text-[0.85rem] text-text-secondary">{t('no_receipts', 'No receipts available.')}</div>}>
              {name => <EditReceiptRow filename={name} />}
            </For>
          </div>
          <Label for="edit-payment-new-receipt">{t('add_receipts', 'Add Receipt(s)')}</Label>
          {/* The browser's own "Choose files" button, as before (the base styles strip it) */}
          <Input
            type="file"
            id="edit-payment-new-receipt"
            accept="image/*,.heic,.heif,.pdf"
            multiple
           
            ref={el => (newReceiptsInput = el)}
          />
        </ModalSection>
      </Show>
      <Button block busy={saving()} busyText={t('setup_btn_saving', 'Saving...')} onClick={() => void saveEditedPayment()}>
        {t('btn_save', 'Save')}
      </Button>
    </>
  );
}

export function EditPaymentDialog() {
  return (
    <>
      <Modal id="edit-payment-modal" plain labelledBy="edit-payment-modal-title">
        <ModalHeader
          id="edit-payment-modal"
          icon="✏️"
          iconClass={MODAL_TINTS.person}
          title={t('modal_edit_payment_title', 'Edit Payment')}
          subtitle={edited()?.label}
          onClose={() => closeModal('edit-payment-modal')}
        >
          <button
            type="button"
            class="mr-3 ml-auto flex cursor-pointer items-center justify-center border-0 bg-transparent p-1 text-danger transition-opacity duration-200 hover:opacity-70"
            aria-label={t('btn_delete', 'Delete')}
            onClick={() => {
              if (canManageFinances() && edited()) openModal('confirm-delete-modal');
            }}
          >
            <Icon name="trashLines" size={20} />
          </button>
        </ModalHeader>
        <ModalBody>
          <Show when={edited()}>{entry => <EditPaymentForm entry={entry()} />}</Show>
        </ModalBody>
      </Modal>
      <Modal id="confirm-delete-modal" plain maxWidth="380px" labelledBy="title-confirm-delete">
        <div class="p-5 text-center">
          <div class="mb-3 text-[2.2rem] text-danger">⚠️</div>
          <h3 id="title-confirm-delete" class="mb-2 text-[1.15rem] font-bold text-text">
            {t('modal_delete_trans_title', 'Delete Transaction?')}
          </h3>
          <p class="mb-5 text-[0.86rem] leading-[1.4] text-text-secondary">
            {t('modal_delete_trans_desc', 'Are you sure you want to permanently delete this payment? This cannot be undone.')}
          </p>
          <div class="flex gap-2.5">
            <Button variant="secondary" class="h-[38px] flex-1" onClick={() => closeModal('confirm-delete-modal')}>
              {t('btn_cancel', 'Cancel')}
            </Button>
            <Button variant="danger-solid" class="h-[38px] flex-1" onClick={() => void confirmDeleteRecordedPayment()}>
              {t('btn_delete', 'Delete')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
