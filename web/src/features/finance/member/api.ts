// Entry points of the finance actions other parts call (owner: the finance actions / member finances port): the
// treasury's bookings for a member, the member's own requests, donations and expenses.
import { findPerson } from '../../../app/data';
import { openModal } from '../../../app/modals';
import { canManageFinances } from '../../../app/session';
import { getTodayStr, safeList } from '../../../app/util';
import {
  setOrderEndDate, setOrderTarget, setPaymentPersonId, setStatusChoice, setStatusDate, setStatusPersonId, startRequestForm
} from './state';
import type { StandingOrder } from '../../../app/types';

/** Book a payment for a member (add-payment-modal). */
export function openPaymentModal(personId: string): void {
  if (!canManageFinances()) return;
  setPaymentPersonId(personId);
  openModal('add-payment-modal');
}

/** Change a member's status from a date (change-status-modal). */
export function openChangeStatusModal(personId: string): void {
  if (!canManageFinances()) return;
  setStatusPersonId(personId);
  const person = findPerson(personId);
  if (person) setStatusChoice(person.status || 'vollverdiener');
  setStatusDate(getTodayStr());
  openModal('change-status-modal');
}

/** End a standing order (end-standing-order-modal). */
export function openEndStandingOrderModal(personId: string, orderId: string): void {
  if (!canManageFinances()) return;
  setOrderTarget({ personId, orderId });
  const person = findPerson(personId);
  if (person) setOrderEndDate(safeList<StandingOrder>(person.standingOrders).find(so => String(so.id) === String(orderId))?.endDate || getTodayStr());
  openModal('end-standing-order-modal');
}

/** Send the member an e-mail with their status. */
export { sendStatusEmail } from './statusEmail';

/** A member's own request: 'payment' | 'status' | 'expense' (user-request-modal); anything else shows the choice. */
export function openUserRequestModal(type: string): void {
  startRequestForm(type || null);
  openModal('user-request-modal');
}

/** Record a donation / book an expense (add-donation-modal, add-expense-modal). */
export function openDonationModal(): void {
  openModal('add-donation-modal');
}
export function openExpenseModal(): void {
  openModal('add-expense-modal');
}
