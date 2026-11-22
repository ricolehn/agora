// Booking an expense with its receipts (add-expense-modal), from the finances tab's action button. The receipts are
// uploaded first (pictures converted and made smaller, app/data.ts), then the expense is added to the list on the
// latest server copy (mutateCollection).
import { createSignal } from 'solid-js';
import { mutateCollection, uploadAll } from '../../../../app/data';
import { t } from '../../../../app/i18n';
import { closeModal } from '../../../../app/modals';
import { showToast } from '../../../../app/toast';
import { getTodayStr } from '../../../../app/util';
import { Button } from '../../../../ui/Button';
import { MODAL_TINTS, Modal, ModalSection } from '../../../../ui/Modal';
import { Field, Input } from '../../../../ui/form';
import { parseAmount } from '../../../../lib/finance.js';
import { refreshFinanceViews } from '../../admin/state';
import { AmountInput, PendingFileList, ReceiptDropzone, createPendingFiles, createRequired } from '../shared';

export function ExpenseDialog() {
  const [amount, setAmount] = createSignal('');
  const [issuer, setIssuer] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [date, setDate] = createSignal(getTodayStr());
  // The step the button names while it works: saving, uploading the receipts
  const [busyText, setBusyText] = createSignal<string | null>(null);
  const receipts = createPendingFiles();
  const required = createRequired<'amount' | 'date' | 'issuer' | 'description'>();

  async function addExpense() {
    if (!required.check({ amount: amount(), date: date(), issuer: issuer(), description: description() })) return;
    const value = parseAmount(amount());
    if (Number.isNaN(value)) return showToast(t('alert_invalid_amount', 'Invalid amount. Please enter it like 1500 or 1,500.00.'), 'error');
    const [who, day, what] = [issuer(), date(), description()];
    setBusyText(t('setup_btn_saving', 'Saving...'));
    try {
      let receipt: string | null = null;
      const files = receipts.files().map(entry => entry.file);
      if (files.length > 0) {
        setBusyText(t('btn_uploading', 'Uploading...'));
        try {
          receipt = await uploadAll(files, who, day);
        } catch (err: any) {
          console.error(err);
          return showToast(t('alert_receipt_upload_error', 'Failed to upload receipt: ') + err.message, 'error');
        }
      }
      await mutateCollection('expenses', list => [...list, { amount: value, issuer: who, description: what, date: day, id: Date.now(), receipt }]);
      closeModal('add-expense-modal');
      // The balance and the history on screen at once, as before (not only once a live update comes)
      refreshFinanceViews();
      setAmount('');
      setIssuer('');
      setDescription('');
      receipts.reset();
      showToast(t('toast_expense_saved', 'Expense saved'));
    } catch (err) {
      console.error('Saving the expense failed:', err);
      showToast(t('alert_save_expense_failed', 'Expense could not be saved. Please try again.'), 'error');
    } finally {
      setBusyText(null);
    }
  }

  return (
    <Modal
      id="add-expense-modal"
      title={t('modal_add_expense_title', 'Book Expense')}
      subtitle={t('modal_add_expense_subtitle', 'Record expense & receipts')}
      icon="🧾"
      iconClass={MODAL_TINTS.expense}
    >
      <ModalSection icon="💶" title={t('modal_section_amount', 'Expense amount')}>
        <Field>
          <AmountInput
            id="expense-amount"
            value={amount()}
            invalid={required.isInvalid('amount')}
            onInput={value => {
              setAmount(value);
              required.clear('amount');
            }}
          />
        </Field>
      </ModalSection>
      <ModalSection icon="ℹ️" title={t('modal_section_info', 'Expense details')}>
        <Field label={t('modal_expense_who', 'Who?')} for="expense-issuer">
          <Input
            id="expense-issuer"
            placeholder={t('modal_expense_who_placeholder', 'Who?')}
            value={issuer()}
            invalid={required.isInvalid('issuer')}
            onInput={e => {
              setIssuer(e.currentTarget.value);
              required.clear('issuer');
            }}
          />
        </Field>
        <Field label={t('modal_expense_what', 'What for?')} for="expense-desc">
          <Input
            id="expense-desc"
            placeholder={t('modal_expense_what_placeholder', 'What for?')}
            value={description()}
            invalid={required.isInvalid('description')}
            onInput={e => {
              setDescription(e.currentTarget.value);
              required.clear('description');
            }}
          />
        </Field>
        <Field label={t('modal_date', 'Date')} for="expense-date">
          <Input
            type="date"
            id="expense-date"
            value={date()}
            invalid={required.isInvalid('date')}
            onInput={e => {
              setDate(e.currentTarget.value);
              required.clear('date');
            }}
          />
        </Field>
      </ModalSection>
      <ModalSection icon="📎" title={t('modal_expense_receipt', 'Receipt')}>
        <ReceiptDropzone
          id="expense-receipt"
          onChange={input => {
            receipts.add(input.files);
            // The input is emptied again: the list below holds the files (one can be taken out there)
            input.value = '';
          }}
        />
        <PendingFileList files={receipts.files()} onRemove={index => receipts.remove(index)} />
      </ModalSection>
      <Button id="btn-add-expense" block busy={busyText() !== null} busyText={busyText()} onClick={() => void addExpense()}>
        {t('btn_save', 'Save')}
      </Button>
    </Modal>
  );
}
