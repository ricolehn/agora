// Entry points of the finance actions other parts call (owner: the finance actions / member finances port).
// Stubs until ported.
/** Book a payment for a member (add-payment-modal). */
export function openPaymentModal(_personId: string): void {}
/** Change a member's status from a date (change-status-modal). */
export function openChangeStatusModal(_personId: string): void {}
/** End a standing order (end-standing-order-modal). */
export function openEndStandingOrderModal(_personId: string, _orderId: string): void {}
/** Send the member an e-mail with their status. */
export async function sendStatusEmail(_personId: string): Promise<void> {}
/** A member's own request: 'payment' | 'status' | 'expense' | 'standing_order' (user-request-modal). */
export function openUserRequestModal(_type: string): void {}
/** Record a donation / book an expense (add-donation-modal, add-expense-modal). */
export function openDonationModal(): void {}
export function openExpenseModal(): void {}
