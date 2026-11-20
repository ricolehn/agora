// Members' requests (a payment, a status change, an expense, a standing order): how they read, and the decision on
// them. The request dialog (RequestDetailDialog.tsx) and the lists of open requests show them.
import { createSignal } from 'solid-js';
import { flushNow } from '../../../app/flush';
import { db, get, ref, update } from '../../../app/api';
import { findPerson, loadData, mutateCollection, mutatePerson, requests, type FinanceRequest } from '../../../app/data';
import { euro, formatDateFast, getStatusLabels, t, type MemberStatus } from '../../../app/i18n';
import { closeModal, openModal } from '../../../app/modals';
import { attempt, showToast } from '../../../app/toast';
import type { IconName } from '../../../ui/icons';
import {
  addApprovedExpense, applyApprovedRequest, withoutApprovedExpense, withoutApprovedRequest
} from '../../../lib/finance.js';

export const REQUEST_TYPES: Record<string, { label: string; icon: IconName }> = {
  payment: { label: 'Payment', icon: 'coin' },
  status: { label: 'Status change', icon: 'history' },
  expense: { label: 'Expense', icon: 'receipt' },
  standing_order: { label: 'Standing order', icon: 'repeat' }
};
export const REQUEST_COLORS: Record<string, string> = { payment: '#10b981', expense: '#ef4444', status: '#6366f1', standing_order: '#06b6d4' };
export const requestColor = (req: FinanceRequest) => REQUEST_COLORS[req.type || ''] || 'var(--primary)';
export const requestIcon = (req: FinanceRequest): IconName => REQUEST_TYPES[req.type || '']?.icon || 'file';

/** The open requests, newest first. */
export const pendingRequests = () => requests().filter(r => r.status === 'pending').sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

// Plain text: the type comes from the request record, which its author writes
export const requestTypeLabel = (req: FinanceRequest) => {
  const type = REQUEST_TYPES[req.type || ''];
  return type ? t(`request_type_${req.type}`, type.label) : String(req.type || '');
};
export const requestPersonName = (req: FinanceRequest) => req.personName || t('status_unknown', 'Unknown');
export const requestPersonUid = (req: FinanceRequest): string | null => findPerson(req.personId)?.uid || req.userId || null;

/** The amount of a request (or the new status). */
export function requestAmount(req: FinanceRequest): string {
  const data = req.data || {};
  if (req.type === 'status') return getStatusLabels(false)[data.newStatus as MemberStatus] || data.newStatus || '';
  if (req.type === 'standing_order') return `${euro(data.amount)} ${t('request_per_month', '/ month')}`;
  return euro(data.amount);
}

export function requestDateLabel(req: FinanceRequest): string {
  const date = req.data?.date;
  if (!date) return '';
  return req.type === 'status' || req.type === 'standing_order'
    ? t('request_from_date', 'from {date}', { date: formatDateFast(date) })
    : t('request_on_date', 'on {date}', { date: formatDateFast(date) });
}

export const USER_REQUEST_STATES: Record<string, [string, string, string]> = {
  pending: ['#f59e0b', 'req_status_pending', 'Pending'],
  approved: ['#10b981', 'req_status_approved', 'Approved'],
  rejected: ['#ef4444', 'req_status_rejected', 'Rejected']
};
export const requestState = (req: FinanceRequest) => USER_REQUEST_STATES[req.status || ''] || USER_REQUEST_STATES.pending;
export const requestStateLabel = (req: FinanceRequest) => {
  const [, key, fallback] = requestState(req);
  return t(key, fallback);
};

// The reason of a rejection in the reader's language: without one, the apps store "Kein Grund angegeben" (a fixed value)
export const rejectionReasonOf = (req: FinanceRequest) =>
  req.rejectionReason && req.rejectionReason !== 'Kein Grund angegeben' ? req.rejectionReason : t('user_no_reason', 'No reason given');

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
  flushNow();
  openModal('request-detail-modal');
}

export function toggleRejectForm(open: boolean) {
  setRejectFormOpen(open);
  flushNow();
}

// Another treasurer (or the same one on another device) may have decided the request since this screen was loaded
async function requestStillPending(reqId: string) {
  if ((await get(ref(db, 'requests/' + reqId))).val()?.status === 'pending') return true;
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
  if (!req || !reqId) return;
  setRequestBusy(true);
  await attempt(
    async () => {
      if (!(await requestStillPending(reqId))) return;
      // Bookings carry the request's id (lib/finance.js): approving it again cannot book the money twice
      let before: { status?: string; statusHistory?: any[] } | null = null;
      if (req.type === 'expense') await mutateCollection('expenses', list => addApprovedExpense(list, req));
      else {
        await mutatePerson(req.personId!, person => {
          before = { status: person.status, statusHistory: person.statusHistory };
          return applyApprovedRequest(person, req, t('req_payment_approved_desc', 'Payment (approved)'));
        });
      }
      try {
        await update(ref(db, 'requests/' + reqId), { status: 'approved' });
      } catch (err: any) {
        if (err?.status !== 409) throw err;
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
  if (!reqId) return;
  const reason = rejectReason().trim();
  setRequestBusy(true);
  await attempt(
    async () => {
      if (!(await requestStillPending(reqId))) return;
      try {
        await update(ref(db, 'requests/' + reqId), { status: 'rejected', rejectionReason: reason || 'Kein Grund angegeben' });
      } catch (err: any) {
        if (err?.status === 409) return showRequestAlreadyDecided();
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
