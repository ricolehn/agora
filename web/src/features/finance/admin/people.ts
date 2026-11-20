// How a member's fee account reads: paid until, the fresh start of the fee accounts (CALDERA), who pays at all.
import type { Person } from '../../../app/data';
import { euro, formatDateFast, monthYearFormatter, t } from '../../../app/i18n';
import { getTodayStr } from '../../../app/util';
import { droppedFeesBefore, feeResetIsNews } from '../../../lib/finance.js';

/** The fee state the server computed for a member (backend/derivedData.js). */
export interface StatusMeta {
  text: string;
  isOverdue: boolean;
  isSoonDue: boolean;
  isActiveStandingOrder?: boolean;
}

export const statusMeta = (p: Person): StatusMeta => p._statusMeta || { text: '', isOverdue: false, isSoonDue: false };
export const personPaidUntil = (p: Person): Date | null => (p._paidUntil ? new Date(p._paidUntil) : null);
export const paidUntilText = (paidUntil: Date | null) => (paidUntil ? monthYearFormatter.format(paidUntil) : t('never_paid', 'Never'));
/** A running standing order covers the fee: the list names it instead of a date. */
export const standingOrderCovers = (meta: StatusMeta) => !!meta.isActiveStandingOrder && !meta.isOverdue;
/** The status that applies today (a change can be dated ahead). */
export const currentStatus = (p: Person): string => p._currentStatus || p.status || '';

/** Members without a fee (an account that does not pay, deleted ones) are not in the fee list. */
export const isPayingPerson = (p: Person) => !(p.isDeleted || p.data?.isDeleted || p.pays === false || p.data?.pays === false);

// A fee account that was started afresh (CALDERA) says what happened on that day: credit was taken along, open fees
// were dropped
export const feeResetOutcome = (p: Person) =>
  p._feeCarriedOver > 0
    ? t('fee_reset_carried', 'Credit carried over: {amount}', { amount: euro(p._feeCarriedOver) })
    : p._feeWrittenOff > 0
      ? t('fee_reset_dropped', 'Open fees dropped: {amount}', { amount: euro(p._feeWrittenOff) })
      : t('fee_reset_even', 'All paid up');

/** The chip about a fresh start is a notice: it shows from its day on for about two months (lib/finance.js). */
export const feeResetIsShown = (p: Person) => !!p._feeReset && feeResetIsNews(p._feeReset, getTodayStr());

// A payment dated before the fresh start belongs to the time before it: where open fees were dropped then, it first
// makes up for those (lib/finance.js). Said where the day is chosen, so "booked, but still behind" is no riddle
export function feeResetPaymentHint(person: Person | null | undefined, day: string | undefined): string {
  const dropped = person ? droppedFeesBefore(person, day) : 0;
  return dropped > 0
    ? t('fee_reset_payment_hint', 'Before the fresh start ({date}): this first pays off the old arrears of {amount}.', {
        date: formatDateFast(person!._feeReset),
        amount: euro(dropped)
      })
    : '';
}
