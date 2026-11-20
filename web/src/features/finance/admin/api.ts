// Entry points of the finance views other parts call (owner: the finances tab).
/** Opens the request with all details and the decision (request-detail-modal). */
export { openRequestDetail } from './requests';
/** Opens a booked entry with its details (transaction-details-modal); type: payment | donation | expense
 *  (or pay | don | exp, as the history lists them). */
export { showTransactionDetails } from './TransactionDetailsDialog';
/** Receipts of a booking or request as cards, one receipt as a compact row, a picture opened large. */
export { ReceiptFileRow, ReceiptList, ReceiptThumb, showReceiptImage } from './Receipts';
/** A member's history as a line (status changes, payments, the fresh start). */
export { Timeline } from './Timeline';
