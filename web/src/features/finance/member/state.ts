// What the finance dialogs are open for. The entry points (api.ts) set it before they open a dialog; the dialogs read
// it. Values a dialog shows on opening (the status, the end of a standing order) are set here too, everything else the
// dialogs keep themselves (typed values stay until the next booking, as before).
import { createSignal } from 'solid-js';
import { getTodayStr } from '../../../app/util';

/** The kinds of request a member fills in ('standing_order' is a payment with the switch on). */
export type RequestKind = 'payment' | 'status' | 'expense';
export const REQUEST_KINDS: RequestKind[] = ['payment', 'status', 'expense'];

// add-payment-modal: the member the payment is booked for
const [paymentPersonId, setPaymentPersonId] = createSignal<string | null>(null);
// change-status-modal: the member, the status chosen and the day it counts from
const [statusPersonId, setStatusPersonId] = createSignal<string | null>(null);
const [statusChoice, setStatusChoice] = createSignal('vollverdiener');
const [statusDate, setStatusDate] = createSignal(getTodayStr());
// end-standing-order-modal: the standing order and its last day
const [orderTarget, setOrderTarget] = createSignal<{ personId: string; orderId: string } | null>(null);
const [orderEndDate, setOrderEndDate] = createSignal(getTodayStr());
// user-request-modal: the form shown - a new object for every opening, so each one starts empty (kind null: the
// choice of the kind)
const [requestForm, setRequestForm] = createSignal<{ kind: RequestKind | null }>({ kind: null });

export {
  paymentPersonId, setPaymentPersonId, statusPersonId, setStatusPersonId, statusChoice, setStatusChoice, statusDate,
  setStatusDate, orderTarget, setOrderTarget, orderEndDate, setOrderEndDate, requestForm
};

/** Shows the empty form of [kind]; anything else shows the choice of the kind. */
export function startRequestForm(kind: string | null) {
  setRequestForm({ kind: REQUEST_KINDS.includes(kind as RequestKind) ? (kind as RequestKind) : null });
}
