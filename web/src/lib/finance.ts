// Money logic of the web app: what an approved request or a status change does to a member's record (pure
// functions; tests/finance.test.js checks them together with the server's fee calculation in backend/derivedData.js).
import {
    isMemberStatus, type Expense, type FinanceRequest, type MemberStatus, type Payment, type RequestData, type StandingOrder, type StatusEntry
} from '../app/types.ts';

/** A list as records keep it: an array, an object of entries (older data) or nothing. */
type Stored<T> = T[] | Record<string, T> | null | undefined;
const list = <T>(value: Stored<T>): T[] => (!value ? [] : Array.isArray(value) ? value : Object.values(value));
const hasEntry = (entries: Stored<{ id?: unknown } | null | undefined>, id: string) => list(entries).some(entry => String(entry?.id) === id);
/** Id of what an approved request books: approving the same request again finds its booking and adds nothing. */
const bookingId = (request: Pick<FinanceRequest, 'id'>) => `req_${request.id}`;

/** What the rules here read and write of a member's record (the record has more; it is kept as it is). */
export interface StatusRecord {
    status?: string;
    statusHistory?: Stored<StatusEntry>;
    memberSince?: string;
    originalMemberSince?: string;
}
export interface BookedRecord extends StatusRecord {
    payments: Payment[];
    totalPaid?: number;
    standingOrders?: Stored<StandingOrder>;
}

// Amounts as people type them: "1.234,56", "1,234.56", "1234,56", "1234.56", "1 234,56", "50 €", "50 EUR", "50,-",
// ",50". One or two digits after the last "." or "," are the cents ("-" or nothing: none), groups of three digits
// before it thousands. A lone "1.500" or "1,500" is 1500 in one language and 1.5 in the other: it is not guessed (it
// used to be booked as 1,50 €).
const AMOUNT = /^([+-]?)(\d+|\d{1,3}([.,])\d{3}(?:\3\d{3})*)?(?:([.,])(\d{1,2}|-{1,2})?)?$/;

/** The amount typed in [raw] as a number, or NaN when it is not an unambiguous amount of money. */
function parseAmount(raw: unknown): number {
    const match = AMOUNT.exec(String(raw ?? '').replace(/\s|€|euro?/gi, ''));
    if (!match || !/\d/.test(match[0])) return NaN;
    const [, sign, whole = '', group, point, cents = ''] = match;
    // The cents need the other separator ("1.234.56"), and a single group of three could be cents ("1.500")
    if (group && (point === group || (!point && whole.split(group).length === 2))) return NaN;
    return Number(`${sign}${whole.replace(/[.,]/g, '') || '0'}.${/^\d+$/.test(cents) ? cents : '0'}`);
}

/**
 * Rewrites the status history so `newStatus` applies from `changeDateStr` (retroactive or future changes): entries
 * still running at that date end there, the new status starts there. Throws (error.key: the translation) when the
 * date is before the start of the membership.
 */
function applyStatusChangeToHistory<P extends StatusRecord>(person: P, newStatus: string, changeDateStr: string): P & { status: string; statusHistory: StatusEntry[] } {
    const memberSince = person.originalMemberSince || person.memberSince || changeDateStr;
    const changeDate = new Date(changeDateStr);
    if (changeDate < new Date(memberSince)) {
        throw Object.assign(new Error('The change date is before the start of the membership.'), { key: 'status_change_before_member_since' });
    }
    if (changeDateStr <= memberSince) return { ...person, status: newStatus, statusHistory: [{ status: newStatus, startDate: memberSince }] };

    const history = list(person.statusHistory)
        .filter(entry => (entry.startDate ? new Date(entry.startDate) : new Date(memberSince)) < changeDate)
        .map((entry): StatusEntry => (entry.endDate && new Date(entry.endDate) <= changeDate ? { ...entry } : { ...entry, endDate: changeDateStr }));
    const lastEnd = history[history.length - 1]?.endDate;
    if (history.length === 0 || (lastEnd && lastEnd < changeDateStr)) {
        const priorStart = lastEnd || memberSince;
        if (priorStart < changeDateStr) history.push({ status: person.status || 'vollverdiener', startDate: priorStart, endDate: changeDateStr });
    }
    history.push({ status: newStatus, startDate: changeDateStr });
    return { ...person, status: newStatus, statusHistory: history };
}

/** What an approved request books on the member's record ([note]: description of a payment that has none). */
type Applier = <P extends BookedRecord>(person: P, data: RequestData, id: string, note: string) => P;
const REQUEST_APPLIERS: Record<string, Applier> = {
    payment: (person, data, id, note) => (hasEntry(person.payments, id) ? person : {
        ...person,
        payments: [...person.payments, { id, amount: parseFloat(String(data.amount)), date: data.date ?? '', description: data.note || note }],
        totalPaid: (person.totalPaid || 0) + parseFloat(String(data.amount))
    }),
    // The same as a status change by the treasury. It used to leave the open entry of the old status running, so
    // the fee calculation kept charging the old status after the request was approved.
    status: (person, { date, newStatus }) => applyStatusChangeToHistory(person, String(newStatus), String(date)),
    standing_order: (person, data, id) => (hasEntry(person.standingOrders, id) ? person : {
        ...person,
        standingOrders: [...list(person.standingOrders), { id, amount: parseFloat(String(data.amount)), startDate: data.date ?? '', note: data.note || 'Dauerauftrag (Genehmigt)', lastAutoPayment: null }]
    })
};

/**
 * The member's record with an approved request booked. Approving a request twice (two treasurers, a second device,
 * a retry) used to book the money twice; a request that is already booked now changes nothing.
 */
function applyApprovedRequest<P extends BookedRecord>(person: P, request: FinanceRequest, note: string): P {
    const apply = Object.hasOwn(REQUEST_APPLIERS, request.type) ? REQUEST_APPLIERS[request.type] : undefined;
    return apply ? apply(person, request.data || {}, bookingId(request), note) : person;
}

/** The expense list with an approved expense request (the requester is the issuer), or null when it is booked already. */
function addApprovedExpense(expenses: Expense[], request: FinanceRequest): Expense[] | null {
    const id = bookingId(request);
    if (hasEntry(expenses, id)) return null;
    const { amount, description, date, receipt } = request.data || {};
    return [...expenses, { id, amount: parseFloat(String(amount)), description, issuer: request.personName || '', date: date ?? '', receipt }];
}

/**
 * The record without what approving [request] booked, for an approval that lost against a rejection made at the same
 * moment: its payment or standing order goes, a status change goes back to [before] ({ status, statusHistory }).
 */
function withoutApprovedRequest<P extends BookedRecord>(person: P, request: FinanceRequest, before: Pick<StatusRecord, 'status' | 'statusHistory'> | null): P {
    if (request.type === 'status') return before ? { ...person, ...before } : person;
    const id = bookingId(request);
    return {
        ...person,
        payments: list(person.payments).filter(payment => String(payment?.id) !== id),
        standingOrders: list(person.standingOrders).filter(order => String(order?.id) !== id)
    };
}

/** The expense list without the expense an approved request booked, or null when it is not there. */
function withoutApprovedExpense(expenses: Expense[], request: FinanceRequest): Expense[] | null {
    const id = bookingId(request);
    return hasEntry(expenses, id) ? list(expenses).filter(expense => String(expense?.id) !== id) : null;
}

/**
 * Where the payment a treasurer opened (to edit or delete it) is in the current list, or -1 when it is gone. By its
 * id: the list can change while the dialog is open (another booking for the same member shifts the positions), and
 * going by the position edited, or additionally deleted, a different payment. Old payments without an id only by
 * position, while the payment there is still the one that was opened.
 */
function findPaymentIndex(
    payments: Array<{ id?: unknown; date?: string; amount?: unknown } | null | undefined>,
    { paymentId, targetIndex, original }: { paymentId: unknown; targetIndex: number; original?: { date?: string; amount?: unknown } | null }
): number {
    const hasId = (payment: { id?: unknown } | null | undefined) => payment?.id !== undefined && payment?.id !== null && payment?.id !== '';
    const byId = payments.findIndex(payment => hasId(payment) && String(payment?.id) === String(paymentId));
    if (byId >= 0) return byId;
    const there = payments[targetIndex];
    // compared as stored: old amounts can be texts like "50,00"
    const unchanged = there && !hasId(there) && (!original || (there.date === original.date && String(there.amount ?? '') === String(original.amount ?? '')));
    return unchanged ? targetIndex : -1;
}

// --- Fee reset (CALDERA): the fee accounts start afresh on a day the admins chose (backend/feeReset.js) ---
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const monthIndex = (dateStr: string) => {
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return parseInt(dateStr.slice(0, 4), 10) * 12 + parseInt(dateStr.slice(5, 7), 10) - 1;
    const d = new Date(dateStr);
    return d.getFullYear() * 12 + d.getMonth();
};

/**
 * Fallback for "paid until" when the server sent none (it normally provides _paidUntil): uses up what was paid month
 * by month at the fee ([fees]: status → amount) of the status valid in that month and returns the last day of the
 * last fully paid month. A fee account that was started afresh (_feeReset) counts from the month of that day, with
 * the credit that was carried over (_feeCarriedOver) and the payments from that day on.
 */
interface PaidUntilRecord extends StatusRecord {
    payments?: Stored<Payment>;
    totalPaid?: number;
    _feeReset?: string | null;
    _feeCarriedOver?: number;
}
function calculatePaidUntil(person: PaidUntilRecord, fees: Partial<Record<MemberStatus, number>>): Date {
    const history = list(person.statusHistory).slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
    const statusAt = (month: number) => {
        const entry = history.find(e => !e.endDate || month < monthIndex(e.endDate));
        return (entry && month >= monthIndex(entry.startDate) ? entry.status : null) || person.status;
    };
    const reset = DAY.test(person._feeReset || '') ? person._feeReset : null;
    let credit = reset
        ? list(person.payments).reduce((sum, payment) => (String(payment?.date || '').slice(0, 10) >= reset ? sum + (parseFloat(String(payment.amount)) || 0) : sum), Number(person._feeCarriedOver) || 0)
        : person.totalPaid || 0;
    // (the month as it is written: read as a date, a 1st is still the month before west of Greenwich)
    let month = monthIndex(person.originalMemberSince || person.memberSince || '');
    if (reset) month = Math.max(month, monthIndex(reset));
    // In whole cents, like the server: added up as they are, amounts like 49.99 drift by a fraction of a cent
    const cents = (amount: number) => Math.round(amount * 100);
    credit = cents(credit);
    for (let i = 0; credit > 0 && i < 1200; i++, month++) {
        const status = statusAt(month);
        const rate = cents((isMemberStatus(status) && fees[status]) || 0);
        if (rate > credit) break;
        credit -= rate;
    }
    return new Date(Math.floor(month / 12), month % 12, 0);
}

/**
 * The open fees a payment dated [day] is set against before it becomes credit, or 0. When the fee account was started
 * afresh, the member's open fees of the time before were dropped: a payment dated before that day belongs to that
 * time, so it first makes up for what was dropped - only what goes beyond it is carried over as credit.
 */
function droppedFeesBefore(person: { _feeReset?: string | null; _feeWrittenOff?: number } | null | undefined, day: string | null | undefined): number {
    const reset = person && DAY.test(person._feeReset || '') ? person._feeReset : null;
    if (!reset || !day || !DAY.test(day) || day >= reset) return 0;
    return Math.max(0, Number(person?._feeWrittenOff) || 0);
}

/**
 * True when what the admin typed is the day [iso] - written as the dialog shows it ("01.01.2027", "01/01/2027", also
 * "1.1.2027") or as "2027-01-01". Typing the day is the confirmation of a fresh start: a tap alone never starts one.
 */
function typedDayMatches(typed: unknown, iso: string | null | undefined): boolean {
    const day = DAY.exec(iso || '');
    if (!day) return false;
    const text = String(typed ?? '').trim();
    const shown = /^(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]\s*(\d{4})$/.exec(text);
    if (shown) return Number(shown[1]) === Number(day[3]) && Number(shown[2]) === Number(day[2]) && shown[3] === day[1];
    return text === iso;
}

// How long the member card names a fresh start: a notice, not a fixture - the history keeps the day for good
const FEE_RESET_NEWS_DAYS = 60;

/**
 * True while the fresh start on [day] is news on [today] (both "YYYY-MM-DD"): from its day on, for
 * FEE_RESET_NEWS_DAYS days. Members only learn of a fresh start once its day has come (the server sends the day from
 * then on), so a day still to come only shows here on a device whose clock is behind - and counts as news.
 */
function feeResetIsNews(day: string | null | undefined, today: string | null | undefined): boolean {
    if (!DAY.test(day || '') || !DAY.test(today || '')) return false;
    return Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`) < FEE_RESET_NEWS_DAYS * 86400000;
}

export {
    parseAmount, applyStatusChangeToHistory, applyApprovedRequest, addApprovedExpense, withoutApprovedRequest, withoutApprovedExpense,
    findPaymentIndex, calculatePaidUntil, droppedFeesBefore, typedDayMatches, feeResetIsNews
};
