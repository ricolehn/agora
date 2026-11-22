// How a member's fee account reads in the fee list: its state, paid until, the fresh start of the fee accounts
// (CALDERA), who pays at all (what the members' own page shows too is in ../common.tsx).
import type { Person } from '../../../app/data';
import { getTodayStr } from '../../../app/util';
import { feeResetIsNews } from '../../../lib/finance.js';

/** The fee state the server computed for a member (backend/derivedData.js). */
export interface StatusMeta {
  text: string;
  isOverdue: boolean;
  isSoonDue: boolean;
  isActiveStandingOrder?: boolean;
}

export const statusMeta = (p: Person): StatusMeta => p._statusMeta || { text: '', isOverdue: false, isSoonDue: false };
export const personPaidUntil = (p: Person): Date | null => (p._paidUntil ? new Date(p._paidUntil) : null);
/** The status that applies today (a change can be dated ahead). */
export const currentStatus = (p: Person): string => p._currentStatus || p.status || '';

/** Members without a fee (an account that does not pay, deleted ones) are not in the fee list. */
export const isPayingPerson = (p: Person) => !(p.isDeleted || p.data?.isDeleted || p.pays === false || p.data?.pays === false);

/** The chip about a fresh start is a notice: it shows from its day on for about two months (lib/finance.js). */
export const feeResetIsShown = (p: Person) => !!p._feeReset && feeResetIsNews(p._feeReset, getTodayStr());

