// A booking of the history with its details and receipts (transaction-details-modal); those who manage the finances
// edit it from here.
import { Show, createSignal } from 'solid-js';
import { euro, formatDateFast, t } from '../../../app/i18n';
import { closeModal, openModal } from '../../../app/modals';
import { canManageFinances } from '../../../app/session';
import { Button } from '../../../ui/Button';
import { Icon } from '../../../ui/Icon';
import { MODAL_TINTS, Modal, ModalBody, ModalHeader, ModalSection } from '../../../ui/Modal';
import { openEditPayment } from './EditPaymentDialog';
import { ReceiptList } from './Receipts';
import { transactions, type Transaction } from './state';

const typeName = (type: string) =>
  ({ exp: t('action_expense', 'Expense'), don: t('btn_add_donation', 'Donation'), pay: t('action_payment', 'Payment') })[type];

const [shown, setShown] = createSignal<{ tx: Transaction; type: string } | null>(null);

// The kinds as the history lists them; other parts may name them in full
const KIND_IDS: Record<string, string> = { payment: 'pay', donation: 'don', expense: 'exp' };

/** Opens a booked entry of the history with its details; type: pay | don | exp (or payment | donation | expense). */
export function showTransactionDetails(id: string, kind: string) {
  const type = KIND_IDS[kind] || kind;
  const tx = transactions()?.find(x => String(x.id) === String(id));
  if (!tx || !typeName(type)) return;
  setShown({ tx, type });
  openModal('transaction-details-modal');
}

function editShown() {
  const id = shown()?.tx.id;
  closeModal('transaction-details-modal');
  setTimeout(() => {
    const tx = transactions()?.find(x => String(x.id) === String(id));
    if (tx) openEditPayment(tx);
    else console.error('Transaction not found in the history for ID', id);
  }, 50);
}

// The kind as a small pill above the amount: a payment plain, a donation green, an expense red
const KIND_PILL: Record<string, [string, string]> = {
  pay: ['border border-border bg-surface text-text', '💳'],
  don: [MODAL_TINTS.donation, '💚'],
  exp: [MODAL_TINTS.expense, '🧾']
};

function DetailRow(props: { label: string; value: string }) {
  return (
    <div class="flex items-center justify-between border-b border-border-light pb-1.5">
      <span class="text-78 font-medium text-text-secondary">{props.label}</span>
      <span class="font-semibold text-text">{props.value}</span>
    </div>
  );
}

function TransactionDetails(props: { tx: Transaction; type: string }) {
  const pill = () => KIND_PILL[props.tx.type] || KIND_PILL.pay;
  const who = () => (props.type === 'don' ? props.tx.name || props.tx.who : props.tx.who);
  const description = () => props.tx.description || props.tx.note;
  return (
    // One block like before (#transaction-details-content): its parts keep their own margins, not the body's gap
    <div id="transaction-details-content">
      <div class="mb-2.5 flex flex-col items-center gap-[5px] rounded-[14px] border border-border-light bg-surface-alt px-3.5 py-3 text-center">
        <div class={['inline-flex items-center gap-[5px] rounded-[18px] px-2.5 py-[3px] text-75 font-bold', pill()[0]]}>
          <span>{pill()[1]}</span> {typeName(props.type)}
        </div>
        <div class="text-[1.55rem] font-extrabold tracking-[-0.02em] text-text">{euro(props.tx.amount)}</div>
      </div>
      <ModalSection icon="ℹ️" title={t('details_section_info', 'Transaction details')}>
        <div class="flex flex-col gap-2 text-85">
          <DetailRow label={`📅 ${t('modal_date', 'Date')}`} value={props.tx.date ? formatDateFast(props.tx.date) : '-'} />
          <Show when={who()}>
            <DetailRow label={`👤 ${t('details_person', 'Person')}`} value={who()!} />
          </Show>
          <Show when={props.tx.issuer}>
            <DetailRow label={`🏛️ ${t('details_issued_by', 'Issued by')}`} value={props.tx.issuer!} />
          </Show>
          <Show when={description()}>
            <div class="flex flex-col gap-1 pt-0.5">
              <span class="text-78 font-medium text-text-secondary">📝 {t('details_description', 'Description')}</span>
              <span class="rounded-lg border border-border-light bg-surface px-2.5 py-[7px] text-85 font-medium break-words whitespace-pre-wrap text-text">
                {description()}
              </span>
            </div>
          </Show>
        </div>
      </ModalSection>
      <div class="mt-2.5">
        <Show
          when={props.tx.receipt}
          fallback={<div class="text-center text-90 text-text-secondary">{t('no_receipts', 'No receipts available.')}</div>}
        >
          <ReceiptList receipt={props.tx.receipt} variant="details" />
        </Show>
      </div>
    </div>
  );
}

export function TransactionDetailsDialog() {
  return (
    <Modal id="transaction-details-modal" plain labelledBy="transaction-details-modal-title">
      <ModalHeader
        id="transaction-details-modal"
        icon="📋"
        iconClass={MODAL_TINTS.person}
        title={t('modal_details_title', 'Details')}
        subtitle={t('modal_details_subtitle', 'Transaction overview')}
        onClose={() => closeModal('transaction-details-modal')}
      >
        <Show when={canManageFinances()}>
          <Button
            variant="secondary"
            size="small"
            class="mr-3 ml-auto gap-2 rounded-lg p-1.5"
            aria-label={t('btn_edit', 'Edit')}
            onClick={editShown}
          >
            <Icon name="edit" size={16} />
          </Button>
        </Show>
      </ModalHeader>
      <ModalBody>
        <Show when={shown()}>{details => <TransactionDetails tx={details().tx} type={details().type} />}</Show>
      </ModalBody>
    </Modal>
  );
}
