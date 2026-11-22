// What the treasury's views (admin/) and the members' own finance page (member/) both show: the texts of a request,
// what a fresh start of a fee account did, "paid until", and the amber note about a fresh start. The previous app had
// a copy of each in app.js and in finance.js. The history line is Timeline.tsx; the sum of amounts is in app/data.ts.
import { Show } from 'solid-js';
import type { FinanceRequest, Person } from '../../app/data';
import { euro, formatDateFast, getStatusLabels, monthYearFormatter, t, type MemberStatus } from '../../app/i18n';
import { Icon } from '../../ui/Icon';
import type { IconName } from '../../ui/icons';
import { droppedFeesBefore } from '../../lib/finance.js';

// --- Requests (a payment, a status change, an expense, a standing order) ---
export const REQUEST_TYPES: Record<string, { label: string; icon: IconName }> = {
  payment: { label: 'Payment', icon: 'coin' },
  status: { label: 'Status change', icon: 'history' },
  expense: { label: 'Expense', icon: 'receipt' },
  standing_order: { label: 'Standing order', icon: 'repeat' }
};
export const REQUEST_COLORS: Record<string, string> = { payment: '#10b981', expense: '#ef4444', status: '#6366f1', standing_order: '#06b6d4' };

// Plain text: the type comes from the request record, which its author writes
export const requestTypeLabel = (req: FinanceRequest) => {
  const type = REQUEST_TYPES[req.type || ''];
  return type ? t(`request_type_${req.type}`, type.label) : String(req.type || '');
};

/** The amount of a request (or the new status). */
export function requestAmount(req: FinanceRequest, statusLabels = getStatusLabels(false)): string {
  const data = req.data || {};
  if (req.type === 'status') return statusLabels[data.newStatus as MemberStatus] || data.newStatus || '';
  if (req.type === 'standing_order') return `${euro(data.amount)} ${t('request_per_month', '/ month')}`;
  return euro(data.amount);
}

// The reason of a rejection in the reader's language: without one, the apps store "Kein Grund angegeben" (a fixed value)
export const rejectionReasonOf = (req: FinanceRequest) =>
  req.rejectionReason && req.rejectionReason !== 'Kein Grund angegeben' ? req.rejectionReason : t('user_no_reason', 'No reason given');

// --- Fee accounts ---
/** "Paid until" as month and year (the server's _paidUntil); "Never" without one. */
export const paidUntilText = (paidUntil: Date | string | number | null | undefined) =>
  paidUntil ? monthYearFormatter.format(new Date(paidUntil)) : t('never_paid', 'Never');

/** A running standing order covers the fee: the lists name it instead of a date. */
export const standingOrderCovers = (meta: { isActiveStandingOrder?: boolean; isOverdue?: boolean }) =>
  !!meta.isActiveStandingOrder && !meta.isOverdue;

/** What the fresh start (CALDERA) did to the account: credit taken along, open fees dropped, or nothing to settle. */
export function feeResetOutcome(person: Person): string {
  if (person._feeCarriedOver > 0) return t('fee_reset_carried', 'Credit carried over: {amount}', { amount: euro(person._feeCarriedOver) });
  if (person._feeWrittenOff > 0) return t('fee_reset_dropped', 'Open fees dropped: {amount}', { amount: euro(person._feeWrittenOff) });
  return t('fee_reset_even', 'All paid up');
}

/**
 * A payment dated before the fresh start belongs to the time before it: where open fees were dropped then, it first
 * makes up for those (lib/finance.js). Said where the day is chosen, so "booked, but still behind" is no riddle.
 */
export function feeResetPaymentHint(person: Person | null | undefined, day: string | undefined): string {
  const dropped = person ? droppedFeesBefore(person, day) : 0;
  return dropped > 0
    ? t('fee_reset_payment_hint', 'Before the fresh start ({date}): this first pays off the old arrears of {amount}.', {
        date: formatDateFast(person!._feeReset),
        amount: euro(dropped)
      })
    : '';
}

/** The quiet amber note with the fresh-start symbol (.fee-reset-note), 8px below what it explains (yields to
 *  `class`); nothing without a text. */
export function FeeResetNote(props: { text: string; id?: string; class?: string }) {
  return (
    <Show when={props.text}>
      <div
        id={props.id}
        class={[
          'flex items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))]',
          'px-3 py-[9px] text-[0.8rem] leading-[1.45] text-text',
          props.class ?? 'mt-2'
        ]}
      >
        <Icon name="rotate" size={14} strokeWidth={2.4} class="mt-0.5 shrink-0 text-warning" />
        <span>{props.text}</span>
      </div>
    </Show>
  );
}
