// A member's own request (user-request-modal): the choice of the kind, then the form of a payment (or a standing
// order), a status change or an expense with receipts. The treasury decides on it in the finances tab.
import { For, Show, createSignal } from 'solid-js';
import { db, findLinkedPerson, loadData, people, ref, requests, set, setRequests, uploadAll } from '../../../../app/data';
import { apiJson, errorMessage } from '../../../../app/api';
import { t } from '../../../../app/i18n';
import { closeModal } from '../../../../app/modals';
import { currentUser } from '../../../../app/session';
import { showToast } from '../../../../app/toast';
import { fullName, getTodayStr } from '../../../../app/util';
import { Button } from '../../../../ui/Button';
import { Icon } from '../../../../ui/Icon';
import { MODAL_TINTS, Modal, ModalSection } from '../../../../ui/Modal';
import { Field, Input, Select, SwitchRow } from '../../../../ui/form';
import { parseAmount } from '../../../../lib/finance';
import { requestForm, startRequestForm, type RequestKind } from '../state';
import { FeeResetNote, feeResetPaymentHint } from '../../common';
import { AmountInput, PendingFileList, ReceiptDropzone, createPendingFiles, newId } from '../shared';
import { StatusDayNote, StatusOptions } from './StatusDialog';
import { isMemberStatus, type RequestData, type RequestType } from '../../../../app/types';

const HEADS: Record<RequestKind, { tint: string; emoji: string; title: () => string; subtitle: () => string }> = {
  payment: {
    tint: MODAL_TINTS.donation,
    emoji: '💳',
    title: () => t('user_req_payment_title', 'Report payment'),
    subtitle: () => t('user_req_payment_subtitle', 'Report a fee payment or deposit to the admin')
  },
  status: {
    tint: MODAL_TINTS.person,
    emoji: '⚡',
    title: () => t('user_req_status_title', 'Request status change'),
    subtitle: () => t('user_req_status_subtitle', 'Request a new membership status')
  },
  expense: {
    tint: MODAL_TINTS.expense,
    emoji: '🧾',
    title: () => t('user_req_expense_title', 'Report expense'),
    subtitle: () => t('user_req_expense_subtitle', 'Submit expense for reimbursement')
  }
};
const CHOICE_HEAD = {
  tint: MODAL_TINTS.donation,
  emoji: '📝',
  title: () => t('user_request_modal_title', 'Request'),
  subtitle: () => t('user_req_select_subtitle', 'Select request type')
};

const CHOICES: Array<{ kind: RequestKind; bg: string; color: string; emoji: string; title: [string, string]; desc: [string, string] }> = [
  {
    kind: 'payment', bg: 'rgba(6, 182, 212, 0.12)', color: 'var(--primary)', emoji: '💳',
    title: ['user_req_type_payment', 'Payment / Deposit'], desc: ['user_req_type_payment_desc', 'Report a fee payment or deposit.']
  },
  {
    kind: 'status', bg: 'rgba(245, 158, 11, 0.12)', color: '#f59e0b', emoji: '⚡',
    title: ['user_req_type_status', 'Status Change'], desc: ['user_req_type_status_desc', 'Request a membership status change.']
  },
  {
    kind: 'expense', bg: 'rgba(239, 68, 68, 0.12)', color: 'var(--danger)', emoji: '🧾',
    title: ['user_req_type_expense', 'Expense'], desc: ['user_req_type_expense_desc', 'Submit expense for reimbursement (with receipt).']
  }
];

type CollectedRequest = { type: RequestType; data: RequestData };

const fillFields = () => void showToast(t('alert_fill_fields', 'Please fill out all fields.'), 'error');
const invalidAmount = () => void showToast(t('alert_invalid_amount', 'Invalid amount. Please enter it like 1500 or 1,500.00.'), 'error');

/**
 * Sends the request: the receipts first, then the request itself; the treasury is told (push and e-mail, backend).
 * [setBusy] names the step on the button.
 */
async function sendRequest(request: CollectedRequest, receipts: File[], setBusy: (text: string | null) => void) {
  const user = currentUser();
  if (!user) return;
  const person = people().find(p => p.uid === user.uid) || null;
  const personId = person ? person.id : user.uid || user.id || 'unknown';
  const personName = person ? person.name : fullName(user) || user.name || user.email || t('user_fallback_name', 'User');
  if (request.type === 'expense' && receipts.length > 0) {
    setBusy(t('btn_uploading', 'Uploading...'));
    try {
      request.data.receipt = await uploadAll(receipts, personName || '', request.data.date ?? '');
    } catch (err) {
      showToast(t('alert_upload_error', 'Upload failed: ') + errorMessage(err), 'error');
      return setBusy(null);
    }
  }
  const newReq = { id: newId(), type: request.type, userId: user.uid || user.id, personId, personName, data: request.data, status: 'pending', timestamp: Date.now() };
  setBusy(t('btn_sending', 'Sending...'));
  try {
    await set(ref(db, 'requests/' + newReq.id), newReq);
    closeModal('user-request-modal');
    showToast(t('toast_request_sent', 'Request successfully sent'));
    // Shown at once, then synced with the server
    if (!requests().some(r => r.id === newReq.id)) setRequests([newReq, ...requests()]);
    await loadData(true);
    apiJson('/notify-admins', 'POST', { reqType: request.type, personName }).catch(e => console.warn('Telling the treasury failed:', e));
  } catch (err) {
    console.error('Sending the request failed:', err);
    showToast(t('alert_send_request_failed', 'Request could not be sent. Please try again.') + (errorMessage(err) ? ` ${errorMessage(err)}` : ''), 'error');
  } finally {
    setBusy(null);
  }
}

/** The day field of a request (today at first). */
function RequestDate(props: { value: string; onInput: (value: string) => void; label?: string }) {
  return (
    <Input type="date" id="req-date" aria-label={props.label} value={props.value} onInput={e => props.onInput(e.currentTarget.value)} />
  );
}

/** The send button below each form; the form collects its request (null: it said what is missing). */
function SubmitButton(props: { collect: () => CollectedRequest | null; date: string; receipts?: File[] }) {
  const [busyText, setBusyText] = createSignal<string | null>(null);
  const submit = async () => {
    if (!currentUser()) return;
    if (!props.date) return fillFields();
    const request = props.collect();
    if (request) await sendRequest(request, props.receipts || [], setBusyText);
  };
  return (
    <Button id="btn-submit-request" block busy={busyText() !== null} busyText={busyText()} onClick={() => void submit()}>
      {t('btn_submit', 'Submit')}
    </Button>
  );
}

function PaymentRequestForm() {
  const [amount, setAmount] = createSignal('');
  const [date, setDate] = createSignal(getTodayStr());
  const [note, setNote] = createSignal('');
  const [standingOrder, setStandingOrder] = createSignal(false);
  const dateLabel = () => (standingOrder() ? t('modal_date_start', 'Start Date') : t('modal_date', 'Date'));
  const resetHint = () => feeResetPaymentHint(standingOrder() ? null : findLinkedPerson(currentUser()?.uid), date());
  const collect = (): CollectedRequest | null => {
    const typed = amount().trim();
    const parsed = parseAmount(typed);
    if (!typed) return (fillFields(), null);
    if (!(parsed > 0)) return (invalidAmount(), null);
    // Stored as a plain number text ("1500", "12.5") like before
    return { type: standingOrder() ? 'standing_order' : 'payment', data: { amount: String(parsed), date: date(), note: note().trim() } };
  };
  return (
    <>
      <div class="flex flex-col gap-2.5">
        <ModalSection icon="💶" title={t('req_section_payment_amount', 'Payment amount')}>
          <Field>
            <AmountInput id="req-amount" value={amount()} onInput={setAmount} />
          </Field>
        </ModalSection>
        <ModalSection icon="⚙️" title={t('modal_section_payment_type', 'Payment type & date')}>
          <SwitchRow small id="req-is-standing-order" checked={standingOrder()} onChange={on => setStandingOrder(on)} label={t('modal_standing_order', 'Standing Order')} />
          <Field label={<span id="req-date-label">{dateLabel()}</span>} for="req-date">
            <RequestDate value={date()} onInput={setDate} />
            <FeeResetNote id="req-reset-hint" text={resetHint()} />
          </Field>
        </ModalSection>
        <ModalSection icon="📝" title={t('req_section_note', 'Note / Reference')}>
          <Field>
            <Input type="text" id="req-note" placeholder={t('modal_note_placeholder', 'e.g. May fee')} value={note()} onInput={e => setNote(e.currentTarget.value)} />
          </Field>
        </ModalSection>
      </div>
      <SubmitButton collect={collect} date={date()} />
    </>
  );
}

function StatusRequestForm() {
  // The own current status is chosen until the member picks another one
  const [picked, setPicked] = createSignal<string | null>(null);
  const [date, setDate] = createSignal(getTodayStr());
  const current = () => {
    const mine = people().length > 0 ? findLinkedPerson(currentUser()?.uid) : null;
    return mine?._currentStatus || mine?.status || '';
  };
  const status = () => picked() ?? (isMemberStatus(current()) ? current() : 'vollverdiener');
  const collect = (): CollectedRequest | null => (status() ? { type: 'status', data: { newStatus: status(), date: date() } } : (fillFields(), null));
  return (
    <>
      <div class="flex flex-col gap-2.5">
        <ModalSection icon="💼" title={t('modal_new_status', 'New Status')}>
          <Field>
            <Select id="req-status" value={status()} onChange={e => setPicked(e.currentTarget.value)}>
              <StatusOptions />
            </Select>
          </Field>
        </ModalSection>
        <ModalSection icon="📅" title={t('modal_valid_from', 'Valid From')}>
          <Field>
            <RequestDate value={date()} onInput={setDate} label={t('modal_valid_from', 'Valid From')} />
            <StatusDayNote />
          </Field>
        </ModalSection>
      </div>
      <SubmitButton collect={collect} date={date()} />
    </>
  );
}

function ExpenseRequestForm() {
  const [amount, setAmount] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [date, setDate] = createSignal(getTodayStr());
  const receipts = createPendingFiles();
  const collect = (): CollectedRequest | null => {
    const typed = amount().trim();
    const parsed = parseAmount(typed);
    const what = description().trim();
    if (!typed || !what) return (fillFields(), null);
    if (!(parsed > 0)) return (invalidAmount(), null);
    return { type: 'expense', data: { amount: String(parsed), description: what, date: date() } };
  };
  return (
    <>
      <div class="flex flex-col gap-2.5">
        <ModalSection icon="💶" title={t('modal_section_amount', 'Expense amount')}>
          <Field>
            <AmountInput id="req-amount" value={amount()} onInput={setAmount} />
          </Field>
        </ModalSection>
        <ModalSection icon="ℹ️" title={t('modal_section_info', 'Expense details')}>
          <Field label={t('req_desc_label', 'Description')} for="req-desc">
            <Input
              type="text"
              id="req-desc"
              placeholder={t('modal_expense_what_placeholder', 'What for?')}
              value={description()}
              onInput={e => setDescription(e.currentTarget.value)}
            />
          </Field>
          <Field label={t('modal_date', 'Date')} for="req-date">
            <RequestDate value={date()} onInput={setDate} />
          </Field>
        </ModalSection>
        <ModalSection icon="📎" title={t('modal_expense_receipt', 'Receipt')}>
          <ReceiptDropzone
            id="req-receipt"
            onChange={input => {
              receipts.add(input.files);
              input.value = '';
            }}
          />
          <PendingFileList files={receipts.files()} onRemove={index => receipts.remove(index)} />
        </ModalSection>
      </div>
      <SubmitButton collect={collect} date={date()} receipts={receipts.files().map(entry => entry.file)} />
    </>
  );
}

/** The choice of the kind (the form's back button leads here). */
function RequestChoice() {
  return (
    <div class="mt-0.5 flex flex-col gap-2">
      <For each={CHOICES}>
        {choice => (
          <button
            type="button"
            class="flex w-full cursor-pointer items-center rounded-xl border border-border-light bg-surface-alt px-3 py-2.5 text-left transition-all duration-200 ease-[ease]"
            onClick={() => startRequestForm(choice.kind)}
          >
            <div
              class="mr-[11px] flex size-[34px] shrink-0 items-center justify-center rounded-[9px] text-[1.05rem]"
              style={{ background: choice.bg, color: choice.color }}
            >
              {choice.emoji}
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-[0.88rem] font-bold text-text">{t(...choice.title)}</div>
              <div class="mt-px text-[0.76rem] text-text-secondary">{t(...choice.desc)}</div>
            </div>
          </button>
        )}
      </For>
    </div>
  );
}

/**
 * The header's badge, and before it the way back to the choice while a form is shown. (The dialog frame has no place
 * before its badge: the badge is drawn here, in the frame's badge slot.)
 */
function RequestHeadBadge() {
  const head = () => {
    const kind = requestForm().kind;
    return kind ? HEADS[kind] : CHOICE_HEAD;
  };
  return (
    <>
      <Show when={requestForm().kind}>
        <Button
          variant="secondary"
          size="small"
          class="mr-1 !gap-1 !px-[9px] !py-[5px] max-md:!h-9 max-md:min-w-9 max-md:!px-2.5 max-md:!py-1.5"
          title={t('btn_back', 'Back')}
          onClick={() => startRequestForm(null)}
        >
          <Icon name="chevronLeft" size={15} strokeWidth={2.5} />
          <span class="max-md:hidden">{t('btn_back', 'Back')}</span>
        </Button>
      </Show>
      <span class={['flex size-9 shrink-0 items-center justify-center rounded-[9px] text-[1.1rem] leading-[normal]', head().tint]}>{head().emoji}</span>
    </>
  );
}

export function RequestDialog() {
  const head = () => {
    const kind = requestForm().kind;
    return kind ? HEADS[kind] : CHOICE_HEAD;
  };
  return (
    <Modal
      id="user-request-modal"
      title={head().title()}
      subtitle={head().subtitle()}
      icon={<RequestHeadBadge />}
      iconClass="!size-auto !rounded-none !bg-transparent gap-2.5"
    >
      {/* A new form for every opening and every change of the kind: it starts empty */}
      <Show when={requestForm()} keyed>
        {form =>
          form.kind === 'payment' ? <PaymentRequestForm />
          : form.kind === 'status' ? <StatusRequestForm />
          : form.kind === 'expense' ? <ExpenseRequestForm />
          : <RequestChoice />
        }
      </Show>
    </Modal>
  );
}
