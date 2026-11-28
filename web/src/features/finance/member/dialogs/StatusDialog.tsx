// A member's status from a day on (change-status-modal), opened from the member's card. A day in the past corrects
// the fees from then on, a day to come changes them from then (applyStatusChangeToHistory, lib/finance.ts).
import { mutatePerson } from '../../../../app/data';
import { t, tHtml } from '../../../../app/i18n';
import { closeModal } from '../../../../app/modals';
import { showToast } from '../../../../app/toast';
import { Button } from '../../../../ui/Button';
import { MODAL_TINTS, Modal, ModalSection } from '../../../../ui/Modal';
import { Field, Input, Select } from '../../../../ui/form';
import { applyStatusChangeToHistory } from '../../../../lib/finance';
import { setStatusChoice, setStatusDate, statusChoice, statusDate, statusPersonId } from '../state';
import { asFailure } from '../../../../app/api';

/** The four statuses with their symbols, in the order of the fees. */
export function StatusOptions() {
  return (
    <>
      <option value="vollverdiener">{t('member_status_full', '💼 Full earner')}</option>
      <option value="geringverdiener">{t('member_status_low', '📉 Low earner')}</option>
      <option value="keinverdiener">{t('member_status_none', '🎓 Non-earner')}</option>
      <option value="pausiert">{t('member_status_paused', '⏸️ Paused')}</option>
    </>
  );
}

/** "Retroactive: ... Future: ..." below the day a status counts from. */
export function StatusDayNote() {
  return (
    <div
      class="mt-[5px] text-75 leading-[1.35] text-text-secondary"
      // eslint-disable-next-line solid/no-innerhtml -- the app's own translation, its only markup is <strong> and <br>
      innerHTML={tHtml(
        'modal_status_desc',
        '<strong>Retroactive:</strong> Corrects calculations starting from the specified date.<br><strong>Future:</strong> The new status applies from the specified date (previous calculations remain).'
      )}
    />
  );
}

export function StatusDialog() {
  async function saveStatusChange() {
    const personId = statusPersonId();
    if (!personId) return;
    const changeDate = statusDate();
    if (!changeDate) return showToast(t('alert_please_enter_date', 'Please specify a date.'), 'error');
    const newStatus = statusChoice();
    try {
      const updated = await mutatePerson(personId, person => applyStatusChangeToHistory(person, newStatus, changeDate));
      if (!updated) return showToast(t('alert_person_not_found', 'Person not found.'), 'error');
      closeModal('change-status-modal');
      showToast(t('toast_status_changed', 'Status changed'));
    } catch (err) {
      console.error('Changing the status failed:', err);
      // A day before the membership began: the reason in the reader's language
      const { key, message } = asFailure(err);
      showToast(t('alert_status_change_failed', 'Status change failed: ') + (key ? t(key, message) : message), 'error');
    }
  }

  return (
    <Modal
      id="change-status-modal"
      title={t('modal_change_status_title', 'Change Status')}
      subtitle={t('modal_change_status_subtitle', 'Adjust membership status')}
      icon="⚡"
      iconClass={MODAL_TINTS.person}
    >
      <ModalSection icon="💼" title={t('modal_new_status', 'New Status')}>
        <Field>
          <Select id="change-status-select" value={statusChoice()} onChange={e => setStatusChoice(e.currentTarget.value)}>
            <StatusOptions />
          </Select>
        </Field>
      </ModalSection>
      <ModalSection icon="📅" title={t('modal_valid_from', 'Valid From')}>
        <Field>
          <Input
            type="date"
            id="change-status-date"
            aria-label={t('modal_valid_from', 'Valid From')}
            value={statusDate()}
            onInput={e => setStatusDate(e.currentTarget.value)}
          />
          <StatusDayNote />
        </Field>
      </ModalSection>
      <Button block onClick={() => void saveStatusChange()}>
        {t('btn_change_status', 'Change Status')}
      </Button>
    </Modal>
  );
}
