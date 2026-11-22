// Recording a donation (add-donation-modal), from the finances tab's action button. Donations are saved as one list
// on the latest server copy (mutateCollection): a donation booked meanwhile elsewhere stays.
import { createSignal } from 'solid-js';
import { mutateCollection } from '../../../../app/data';
import { t } from '../../../../app/i18n';
import { closeModal } from '../../../../app/modals';
import { showToast } from '../../../../app/toast';
import { getTodayStr } from '../../../../app/util';
import { Button } from '../../../../ui/Button';
import { MODAL_TINTS, Modal, ModalSection } from '../../../../ui/Modal';
import { Field, Input } from '../../../../ui/form';
import { parseAmount } from '../../../../lib/finance.js';
import { refreshFinanceViews } from '../../admin/state';
import { AmountInput, createRequired } from '../shared';

export function DonationDialog() {
  const [amount, setAmount] = createSignal('');
  const [name, setName] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [date, setDate] = createSignal(getTodayStr());
  const [busy, setBusy] = createSignal(false);
  const required = createRequired<'amount' | 'date' | 'name'>();

  async function addDonation() {
    if (!required.check({ amount: amount(), date: date(), name: name() })) return;
    const value = parseAmount(amount());
    if (Number.isNaN(value)) return showToast(t('alert_invalid_amount', 'Invalid amount. Please enter it like 1500 or 1,500.00.'), 'error');
    setBusy(true);
    try {
      const donation = { amount: value, name: name(), date: date(), description: description().trim(), id: Date.now() };
      await mutateCollection('donations', list => [...list, donation]);
      closeModal('add-donation-modal');
      // The balance and the history on screen at once, as before (not only once a live update comes)
      refreshFinanceViews();
      // Every donation gets its own day: the form is empty again, the day too
      setAmount('');
      setName('');
      setDate('');
      setDescription('');
      showToast(t('toast_donation_saved', 'Donation saved'));
    } catch (err) {
      console.error('Saving the donation failed:', err);
      showToast(t('alert_save_donation_failed', 'Donation could not be saved. Please try again.'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      id="add-donation-modal"
      title={t('btn_add_donation', 'Donation')}
      subtitle={t('modal_add_donation_subtitle', 'Book a one-off or earmarked donation')}
      icon="💚"
      iconClass={MODAL_TINTS.donation}
    >
      <ModalSection icon="💶" title={t('modal_section_donation_amount', 'Donation amount')}>
        <Field>
          <AmountInput
            id="donation-amount"
            value={amount()}
            invalid={required.isInvalid('amount')}
            onInput={value => {
              setAmount(value);
              required.clear('amount');
            }}
          />
        </Field>
      </ModalSection>
      <ModalSection icon="📝" title={t('modal_section_details', 'Donation details')}>
        <Field label={t('modal_donor_name', 'Donor name')} for="donation-name">
          <Input
            id="donation-name"
            placeholder={t('modal_donor_name', 'Donor name')}
            value={name()}
            invalid={required.isInvalid('name')}
            onInput={e => {
              setName(e.currentTarget.value);
              required.clear('name');
            }}
          />
        </Field>
        <Field label={t('details_description', 'Description')} for="donation-desc">
          <Input
            id="donation-desc"
            placeholder={t('details_description', 'Description')}
            value={description()}
            onInput={e => setDescription(e.currentTarget.value)}
          />
        </Field>
        <Field label={t('modal_date', 'Date')} for="donation-date">
          <Input
            type="date"
            id="donation-date"
            value={date()}
            invalid={required.isInvalid('date')}
            onInput={e => {
              setDate(e.currentTarget.value);
              required.clear('date');
            }}
          />
        </Field>
      </ModalSection>
      <Button id="btn-add-donation" block busy={busy()} busyText={t('setup_btn_saving', 'Saving...')} onClick={() => void addDonation()}>
        {t('btn_save', 'Save')}
      </Button>
    </Modal>
  );
}
