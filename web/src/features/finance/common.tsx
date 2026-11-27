// What the treasury's views (admin/) and the members' own finances (member/) both show: the texts of a request and
// its state, the state of a fee account and the chips of its card, what a fresh start did, the rows of a card and the
// tinted action tiles. The previous app had a copy of most in app.js and in finance.js. The history line is
// Timeline.tsx; the sum of amounts is in app/data.ts.
import type { JSX } from '@solidjs/web';
import { Show } from 'solid-js';
import { settings, type FinanceRequest, type Person } from '../../app/data';
import { euro, formatDateFast, getStatusLabels, monthYearFormatter, t, type MemberStatus } from '../../app/i18n';
import { getTodayStr } from '../../app/util';
import { Icon } from '../../ui/Icon';
import type { IconName } from '../../ui/icons';
import { droppedFeesBefore, feeResetIsNews } from '../../lib/finance';
import { isMemberStatus } from '../../app/types';

/** A translated text whose {name} is shown in bold ("{amount} a month", "Fresh start on {date}"). */
export function BoldParam(props: { text: string; name: string; value: string; class?: string }) {
  const parts = () => props.text.split(`{${props.name}}`);
  return (
    <>
      {parts()[0]}
      <strong class={props.class}>{props.value}</strong>
      {parts().slice(1).join(props.value)}
    </>
  );
}

// --- Requests (a payment, a status change, an expense, a standing order) ---
const REQUEST_TYPES: Record<string, { label: string; icon: IconName }> = {
  payment: { label: 'Payment', icon: 'coin' },
  status: { label: 'Status change', icon: 'history' },
  expense: { label: 'Expense', icon: 'receipt' },
  standing_order: { label: 'Standing order', icon: 'repeat' }
};
const REQUEST_COLORS: Record<string, string> = { payment: '#10b981', expense: '#ef4444', status: '#6366f1', standing_order: '#06b6d4' };
export const requestColor = (req: FinanceRequest) => REQUEST_COLORS[req.type || ''] || 'var(--primary)';
export const requestIcon = (req: FinanceRequest): IconName => REQUEST_TYPES[req.type || '']?.icon || 'file';

// Plain text: the type comes from the request record, which its author writes
export const requestTypeLabel = (req: FinanceRequest) => {
  const type = REQUEST_TYPES[req.type || ''];
  return type ? t(`request_type_${req.type}`, type.label) : String(req.type || '');
};

// What became of a request; one with a state the app does not know counts as pending
const REQUEST_STATES: Record<string, { color: string; label: [string, string] }> = {
  pending: { color: '#f59e0b', label: ['req_status_pending', 'Pending'] },
  approved: { color: '#10b981', label: ['req_status_approved', 'Approved'] },
  rejected: { color: '#ef4444', label: ['req_status_rejected', 'Rejected'] }
};
const requestState = (req: FinanceRequest) => REQUEST_STATES[req.status || ''] || REQUEST_STATES.pending;
export const requestStateColor = (req: FinanceRequest) => requestState(req).color;
export const requestStateLabel = (req: FinanceRequest) => t(...requestState(req).label);

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
/**
 * The state of a fee account as the server worked it out (backend/derivedData.js); its text is a fixed German value
 * that translateStatusText shows in the reader's language.
 */
interface StatusMeta {
  text: string;
  isOverdue: boolean;
  isSoonDue: boolean;
  isActiveStandingOrder?: boolean;
}
export const statusMetaOf = (p: Person): StatusMeta => p._statusMeta || { text: t('status_unknown', 'Unknown'), isOverdue: false, isSoonDue: false };

/** Overdue, due soon or all paid: the colour of the account's card and of its date in the fee list. */
export type PayState = 'overdue' | 'soon' | 'ok';
export function payStateOf(p: Person): PayState {
  const meta = statusMetaOf(p);
  return meta.isOverdue ? 'overdue' : meta.isSoonDue ? 'soon' : 'ok';
}
export const PAY_ACCENT: Record<PayState, string> = { overdue: 'var(--danger)', soon: 'var(--warning)', ok: 'var(--success)' };

/** The status that applies today (a change can be dated ahead). */
export const currentStatusOf = (p: Person): string => p._currentStatus || p.status || '';

/** "Paid until" as month and year (the server's _paidUntil); "Never" without one. */
export const paidUntilText = (paidUntil: Date | string | number | null | undefined) =>
  paidUntil ? monthYearFormatter.format(new Date(paidUntil)) : t('never_paid', 'Never');

/** A running standing order covers the fee: the lists name it instead of a date. */
export const standingOrderCovers = (meta: { isActiveStandingOrder?: boolean; isOverdue?: boolean }) =>
  !!meta.isActiveStandingOrder && !meta.isOverdue;

/** The chip about a fresh start is a notice: it shows from its day on for about two months (lib/finance.ts). */
const feeResetIsShown = (p: Person) => !!p._feeReset && feeResetIsNews(p._feeReset, getTodayStr());

/** What the fresh start (CALDERA) did to the account: credit taken along, open fees dropped, or nothing to settle. */
export function feeResetOutcome(person: Person): string {
  const carried = person._feeCarriedOver ?? 0;
  const dropped = person._feeWrittenOff ?? 0;
  if (carried > 0) return t('fee_reset_carried', 'Credit carried over: {amount}', { amount: euro(carried) });
  if (dropped > 0) return t('fee_reset_dropped', 'Open fees dropped: {amount}', { amount: euro(dropped) });
  return t('fee_reset_even', 'All paid up');
}

/**
 * A payment dated before the fresh start belongs to the time before it: where open fees were dropped then, it first
 * makes up for those (lib/finance.ts). Said where the day is chosen, so "booked, but still behind" is no riddle.
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

// --- The card of a fee account: the member's own (large), a member's card in the fee list (compact) ---
/** The symbol of the state at [size]: an alert, a clock, or a check (2px bigger). */
export function PayStateIcon(props: { state: PayState; size: number }) {
  return (
    <Show when={props.state !== 'ok'} fallback={<Icon name="check" size={props.size + 2} strokeWidth={2.8} />}>
      <Icon name={props.state === 'overdue' ? 'alert' : 'clock'} size={props.size} strokeWidth={2.4} />
    </Show>
  );
}

/** A chip below the state (.user-finance-chip). */
export const FEE_CHIP = 'flex min-w-0 items-center justify-center truncate rounded-[14px] border border-hairline bg-surface-alt px-2.5 py-[9px] text-[0.86rem]';

/** A chip that only tells (a value in it in bold). */
export function FeeChip(props: { class?: string; children: JSX.Element }) {
  return <span class={[FEE_CHIP, 'font-medium text-text-secondary [&_strong]:font-bold [&_strong]:text-text', props.class ?? 'gap-1']}>{props.children}</span>;
}

/** The fee a month costs at [status] by the fee settings (0 for a status without one). */
const monthlyFeeOf = (status: string) => (isMemberStatus(status) ? settings()[status] : 0);

/** The chips of the card: what this month costs, the status ([status], a chip itself), a fresh start. */
export function FeeChips(props: { person: Person; status: JSX.Element; class?: string }) {
  return (
    <div class={['grid grid-cols-2 gap-2', props.class]}>
      <FeeChip>
        <BoldParam
          text={t('user_fee_per_month', '{amount} a month')}
          name="amount"
          value={euro(props.person._monthlyFee ?? monthlyFeeOf(currentStatusOf(props.person)))}
        />
      </FeeChip>
      {props.status}
      <Show when={feeResetIsShown(props.person)}>
        <FeeChip class="col-span-full gap-1.5">
          <Icon name="rotate" size={13} strokeWidth={2.4} class="shrink-0 text-warning" />
          <span>
            <BoldParam text={t('fee_reset_chip', 'Fresh start on {date}')} name="date" value={formatDateFast(props.person._feeReset)} />
          </span>
        </FeeChip>
      </Show>
    </div>
  );
}

// --- The rows of a card (.so-rows): a member's standing orders, the fees over time, the fresh starts ---
export function Rows(props: { class?: string; children?: JSX.Element }) {
  return <div class={['overflow-hidden rounded-2xl border border-hairline bg-surface [&>*+*]:border-t [&>*+*]:border-hairline', props.class]}>{props.children}</div>;
}

/** One row (.so-row): an ended one is quieter; 16px in from the left (yields to `class`). */
export function Row(props: { ended: boolean; class?: string; children?: JSX.Element }) {
  return <div class={['flex items-center gap-3 py-[11px] pr-3', props.class ?? 'pl-4', { 'opacity-60': props.ended }]}>{props.children}</div>;
}
export const ROW_FACTS = 'text-[0.78rem] text-text-secondary';

/** The state of a row as a small pill (.so-row-state): in effect, still to come, or over. */
export function StatePill(props: { look: 'active' | 'planned' | 'ended'; children: JSX.Element }) {
  return (
    <span
      class={[
        'shrink-0 rounded-full px-[9px] py-[3px] text-[0.72rem] font-[650]',
        {
          active: 'bg-[color-mix(in_srgb,var(--success)_13%,var(--surface))] text-[color-mix(in_srgb,var(--success)_85%,var(--text))]',
          planned: 'bg-[color-mix(in_srgb,var(--warning)_15%,var(--surface))] text-[color-mix(in_srgb,var(--warning)_70%,var(--text))]',
          ended: 'bg-surface-alt text-text-secondary'
        }[props.look]
      ]}
    >
      {props.children}
    </span>
  );
}

/** The round button at the end of a row (.so-row-edit): edit or take back. */
export function RowButton(props: { icon: JSX.Element; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-hairline bg-surface-alt text-text-secondary hover:bg-border-light hover:text-text [&+&]:-ml-1"
      title={props.label}
      aria-label={props.label}
      onClick={() => props.onClick()}
    >
      {props.icon}
    </button>
  );
}

// --- Action tiles: what a member can submit, what the treasury does on a member's card ---
/** A tile tinted in its --req-color that gives a little on a tap; the size and the layout are the caller's. */
export const TINTED_TILE = [
  'border border-[color-mix(in_srgb,var(--req-color)_16%,var(--border-light))] bg-[color-mix(in_srgb,var(--req-color)_5%,var(--surface))] shadow-card',
  'transition-[transform,border-color,box-shadow] duration-150 active:scale-[0.96]',
  'hover:border-[color-mix(in_srgb,var(--req-color)_28%,var(--border-light))] hover:bg-[color-mix(in_srgb,var(--req-color)_9%,var(--surface))] hover:shadow-card-md',
  'dark:border-[color-mix(in_srgb,var(--req-color)_20%,var(--border-light))] dark:bg-[color-mix(in_srgb,var(--req-color)_7%,var(--surface))]'
];
/** The round symbol of a tile in the tile's colour (the dark tint is the caller's). */
export const TILE_SYMBOL = 'inline-flex shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--req-color)_14%,var(--surface))] text-[var(--req-color)]';
