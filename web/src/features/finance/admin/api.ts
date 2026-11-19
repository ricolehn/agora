// Entry points of the finance views other parts call (owner: the finances tab port). Stubs until ported.
/** Opens the request with all details and the decision (request-detail-modal). */
export function openRequestDetail(_requestId: string): void {}
/** Opens a booked entry with its details (transaction-details-modal); type: payment | donation | expense. */
export function showTransactionDetails(_id: string, _type: string): void {}
