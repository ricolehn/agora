// Booking a payment or a standing order for a member (add-payment-modal), opened from the member's card. What was
// typed stays for the next booking, as before; only the switch goes back to a single payment.
import { createSignal } from 'solid-js';
import { findPerson, mutatePerson } from '../../../../app/data';
import { t } from '../../../../app/i18n';
import { closeModal } from '../../../../app/modals';
import { showToast } from '../../../../app/toast';
import { getTodayStr, safeList } from '../../../../app/util';
import { Button } from '../../../../ui/Button';
import { Modal, ModalSection } from '../../../../ui/Modal';
import { Field, Input } from '../../../../ui/form';
import { parseAmount } from '../../../../lib/finance.js';
import { paymentPersonId } from '../state';
import { AmountInput, BADGE, FeeResetNote, SwitchRow, createRequired, feeResetPaymentHint, newId } from '../shared';

export function PaymentDialog() {
  const [amount, setAmount] = createSignal('');
  const [date, setDate] = createSignal(getTodayStr());
  const [note, setNote] = createSignal('');
  const [standingOrder, setStandingOrder] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const required = createRequired<'amount' | 'date'>();
  // A standing order starts on its day: the note about the time before a fresh start is for single payments
  const resetHint = () => feeResetPaymentHint(standingOrder() ? null : findPerson(paymentPersonId()), date());

  async function addPayment() {
    if (!required.check({ amount: amount(), date: date() })) return;
    const personId = paymentPersonId();
    const value = parseAmount(amount());
    const day = date();
    const description = note();
    const isStandingOrder = standingOrder();
    setBusy(true);
    try {
      if (!personId) return;
      if (Number.isNaN(value)) return showToast(t('alert_invalid_amount', 'Invalid amount. Please enter it like 1500 or 1,500.00.'), 'error');
      // Booked on the latest copy of the record (a transaction): a payment booked meanwhile elsewhere stays
      const updated = await mutatePerson(personId, person =>
        isStandingOrder
          ? { ...person, standingOrders: [...safeList(person.standingOrders), { id: newId(), amount: value, startDate: day, note: description, lastAutoPayment: null }] }
          : { ...person, payments: [...person.payments, { amount: value, date: day, description, id: Date.now() }], totalPaid: (person.totalPaid || 0) + value }
      );
      if (!updated) return showToast(t('alert_person_not_found', 'Person not found.'), 'error');
      closeModal('add-payment-modal');
      setStandingOrder(false);
      showToast(t('toast_payment_booked', 'Payment booked'));
    } catch (err) {
      console.error('Saving the payment failed:', err);
      showToast(t('alert_save_payment_failed', 'Payment could not be saved. Please try again.'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      id="add-payment-modal"
      title={t('modal_book_payment_title', 'Book Payment')}
      subtitle={t('modal_book_payment_subtitle', 'Record fee payment & deposit')}
      icon="💳"
      iconClass={BADGE.donation}
    >
      <ModalSection icon="💶" title={t('req_section_payment_amount', 'Payment amount')}>
        <Field>
          <AmountInput
            id="payment-amount"
            value={amount()}
            invalid={required.isInvalid('amount')}
            onInput={value => {
              setAmount(value);
              required.clear('amount');
            }}
          />
        </Field>
      </ModalSection>
      <ModalSection icon="⚙️" title={t('modal_section_payment_type', 'Payment type & date')}>
        <SwitchRow
          id="payment-is-standing-order"
          checked={standingOrder()}
          onChange={on => setStandingOrder(on)}
          label={t('modal_standing_order', 'Standing Order')}
        />
        <Field>
          <Input
            type="date"
            id="payment-date"
            aria-label={standingOrder() ? t('modal_date_start', 'Start Date') : t('modal_date', 'Date')}
            value={date()}
            invalid={required.isInvalid('date')}
            onInput={e => {
              setDate(e.currentTarget.value);
              required.clear('date');
            }}
          />
          <FeeResetNote id="payment-reset-hint" text={resetHint()} />
        </Field>
      </ModalSection>
      <ModalSection icon="📝" title={t('modal_note', 'Note')}>
        <Field>
          <Input
            type="text"
            id="payment-desc"
            placeholder={t('modal_note_placeholder', 'e.g. May fee')}
            value={note()}
            onInput={e => setNote(e.currentTarget.value)}
          />
        </Field>
      </ModalSection>
      <Button id="btn-add-payment" block busy={busy()} busyText={t('btn_booking', 'Booking...')} onClick={() => void addPayment()}>
        {t('btn_book', 'Book')}
      </Button>
    </Modal>
  );
}
