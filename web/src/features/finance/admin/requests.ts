// Members' requests (a payment, a status change, an expense, a standing order): how they read, and the decision on
// them. The request dialog (RequestDetailDialog.tsx) and the lists of open requests show them.
import { createSignal } from 'solid-js';
import { db, errorStatus, get, ref, update } from '../../../app/api';
import { findPerson, loadData, mutateCollection, mutatePerson, requests, type FinanceRequest } from '../../../app/data';
import { formatDateFast, t } from '../../../app/i18n';
import { closeModal, openModal } from '../../../app/modals';
import { attempt, showToast } from '../../../app/toast';
import {
  addApprovedExpense, applyApprovedRequest, withoutApprovedExpense, withoutApprovedRequest
} from '../../../lib/finance';
import type { StoredPerson } from '../../../app/data';

/** The open requests, newest first. */
export const pendingRequests = () => requests().filter(r => r.status === 'pending').sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

export const requestPersonName = (req: FinanceRequest) => req.personName || t('status_unknown', 'Unknown');
export const requestPersonUid = (req: FinanceRequest): string | null => findPerson(req.personId)?.uid || req.userId || null;

export function requestDateLabel(req: FinanceRequest): string {
  const date = req.data?.date;
  if (!date) return '';
  return req.type === 'status' || req.type === 'standing_order'
    ? t('request_from_date', 'from {date}', { date: formatDateFast(date) })
    : t('request_on_date', 'on {date}', { date: formatDateFast(date) });
}

// --- The request dialog: which request, the reject form, the decision being saved ---
const [openRequestId, setOpenRequestId] = createSignal<string | null>(null);
const [rejectFormOpen, setRejectFormOpen] = createSignal(false);
const [rejectReason, setRejectReason] = createSignal('');
const [requestBusy, setRequestBusy] = createSignal(false);
export { openRequestId, rejectFormOpen, rejectReason, requestBusy, setRejectReason };

/** Opens the request with all details and (for those who decide) the decision. */
export function openRequestDetail(reqId: string) {
  if (!requests().some(r => r.id === reqId)) return;
  setOpenRequestId(reqId);
  setRejectFormOpen(false);
  setRejectReason('');
  setRequestBusy(false);
  openModal('request-detail-modal');
}

export function toggleRejectForm(open: boolean) {
  setRejectFormOpen(open);
}

// Another treasurer (or the same one on another device) may have decided the request since this screen was loaded
async function requestStillPending(reqId: string) {
  if ((await get<FinanceRequest>(ref(db, 'requests/' + reqId))).val()?.status === 'pending') return true;
  await showRequestAlreadyDecided();
  return false;
}

async function showRequestAlreadyDecided() {
  closeModal('request-detail-modal');
  await loadData();
  showToast(t('toast_request_already_decided', 'This request was already decided.'), 'error');
}

export async function approveRequest(reqId = openRequestId()) {
  const req = requests().find(r => r.id === reqId);
  // One decision at a time: the buttons are disabled meanwhile, the Enter key of the reason was not (a second
  // rejection reported "already decided" after the first had worked)
  if (!req || !reqId || requestBusy()) return;
  setRequestBusy(true);
  await attempt(
    async () => {
      if (!(await requestStillPending(reqId))) return;
      // Bookings carry the request's id (lib/finance.ts): approving it again cannot book the money twice
      let before: Pick<StoredPerson, 'status' | 'statusHistory'> | null = null;
      if (req.type === 'expense') await mutateCollection('expenses', list => addApprovedExpense(list, req));
      else {
        await mutatePerson(req.personId!, person => {
          before = { status: person.status, statusHistory: person.statusHistory };
          return applyApprovedRequest(person, req, t('req_payment_approved_desc', 'Payment (approved)'));
        });
      }
      try {
        await update(ref(db, 'requests/' + reqId), { status: 'approved' });
      } catch (err) {
        if (errorStatus(err) !== 409) throw err;
        // Rejected by someone else between the check and now: the booking is taken back
        if (req.type === 'expense') await mutateCollection('expenses', list => withoutApprovedExpense(list, req));
        else await mutatePerson(req.personId!, person => withoutApprovedRequest(person, req, before));
        return showRequestAlreadyDecided();
      }
      closeModal('request-detail-modal');
      await loadData();
      showToast(t('toast_request_approved', 'Request approved'));
    },
    err => (err?.key ? t(err.key, err.message) : t('alert_approve_failed', 'Could not approve request. Please try again.'))
  );
  setRequestBusy(false);
}

// Rejection with an optional reason typed into the dialog (instead of a browser prompt)
export async function confirmRejectRequest(reqId = openRequestId()) {
  if (!reqId || requestBusy()) return;
  const reason = rejectReason().trim();
  setRequestBusy(true);
  await attempt(
    async () => {
      if (!(await requestStillPending(reqId))) return;
      try {
        await update(ref(db, 'requests/' + reqId), { status: 'rejected', rejectionReason: reason || 'Kein Grund angegeben' });
      } catch (err) {
        if (errorStatus(err) === 409) return showRequestAlreadyDecided();
        throw err;
      }
      closeModal('request-detail-modal');
      await loadData();
      showToast(t('toast_request_rejected', 'Request rejected'));
    },
    t('alert_reject_failed', 'Could not reject request. Please try again.')
  );
  setRequestBusy(false);
}
