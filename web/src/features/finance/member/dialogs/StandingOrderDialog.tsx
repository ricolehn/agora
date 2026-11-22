// Ending or deleting a member's standing order (end-standing-order-modal), opened from the order's row on the
// member's card. Payments it booked after the new last day go again; an order whose last day has passed is removed.
import { mutatePerson, sumAmounts } from '../../../../app/data';
import { t } from '../../../../app/i18n';
import { closeModal } from '../../../../app/modals';
import { attempt, confirmAction, showToast } from '../../../../app/toast';
import { getTodayStr, safeList } from '../../../../app/util';
import { Button } from '../../../../ui/Button';
import { Icon } from '../../../../ui/Icon';
import { MODAL_TINTS, Modal, ModalSection } from '../../../../ui/Modal';
import { Field, Input } from '../../../../ui/form';
import { orderEndDate, orderTarget, setOrderEndDate } from '../state';
import { FieldNote } from '../shared';

export function StandingOrderDialog() {
  async function saveStandingOrderEnd() {
    const target = orderTarget();
    if (!target?.personId || !target.orderId) return;
    const endDate = orderEndDate();
    if (!endDate) return showToast(t('alert_please_choose_date', 'Please choose a date.'), 'error');
    const isThisOrder = (so: any) => String(so.id) === String(target.orderId);
    try {
      await mutatePerson(target.personId, person => {
        // Compared as the days they are ('YYYY-MM-DD', as the auto-payments are dated): the day read as a date is its
        // UTC midnight, and the end of that day in local time was the day before west of Greenwich
        const ended = endDate < getTodayStr();
        // Drop auto-payments booked after the new end date; remove the order entirely once it has ended
        const payments = person.payments.filter((p: any) => !(p.isAuto && String(p.id).startsWith(`auto_${target.orderId}_`) && String(p.date) > endDate));
        const standingOrders = safeList(person.standingOrders)
          .map(so => (isThisOrder(so) ? { ...so, endDate } : so))
          .filter(so => !(ended && isThisOrder(so)));
        return { ...person, standingOrders, payments, totalPaid: sumAmounts(payments) };
      });
      closeModal('end-standing-order-modal');
      showToast(t('toast_so_updated', 'Standing order updated'));
    } catch (err) {
      console.error('Ending the standing order failed:', err);
      showToast(t('alert_save_error', 'Error while saving.'), 'error');
    }
  }

  async function deleteStandingOrderCompletely() {
    const target = orderTarget();
    if (!target) return;
    if (!confirmAction(t('confirm_delete_so', 'Are you sure you want to remove this standing order completely? History will be lost.'))) return;
    await attempt(async () => {
      await mutatePerson(target.personId, person => ({
        ...person,
        standingOrders: safeList(person.standingOrders).filter(so => String(so.id) !== String(target.orderId))
      }));
      closeModal('end-standing-order-modal');
      showToast(t('toast_so_deleted', 'Standing order deleted'));
    }, t('alert_delete_error', 'Error while deleting.'));
  }

  return (
    <Modal
      id="end-standing-order-modal"
      title={t('modal_end_so_title', 'Manage Standing Order')}
      subtitle={t('modal_end_so_desc', 'When should this standing order end?')}
      icon="🔄"
      iconClass={MODAL_TINTS.donation}
    >
      <ModalSection icon="📅" title={t('modal_end_so_date', 'End Date')}>
        <Field>
          <Input
            type="date"
            id="end-so-date"
            aria-label={t('modal_end_so_date', 'End Date')}
            value={orderEndDate()}
            onInput={e => setOrderEndDate(e.currentTarget.value)}
          />
          <FieldNote class="mt-1">{t('modal_end_so_desc_help', 'Payments will only be created up to this date.')}</FieldNote>
        </Field>
      </ModalSection>
      <Button block onClick={() => void saveStandingOrderEnd()}>
        {t('modal_end_so_btn', 'End / Save')}
      </Button>
      <Button
        block
        variant="danger"
        class="!gap-1.5 border border-danger !bg-transparent"
        onClick={() => void deleteStandingOrderCompletely()}
      >
        <Icon name="trash" size={16} />
        <span>{t('modal_end_so_delete_btn', 'Delete entry completely')}</span>
      </Button>
    </Modal>
  );
}
