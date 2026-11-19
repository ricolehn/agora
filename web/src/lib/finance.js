// Money logic of the web app: what an approved request or a status change does to a member's record (pure
// functions; tests/finance.test.js checks them together with the server's fee calculation in backend/derivedData.js).

const list = value => (!value ? [] : Array.isArray(value) ? value : Object.values(value));
const hasEntry = (entries, id) => list(entries).some(entry => String(entry?.id) === id);
/** Id of what an approved request books: approving the same request again finds its booking and adds nothing. */
const bookingId = request => `req_${request.id}`;

// Amounts as people type them: "1.234,56", "1,234.56", "1234,56", "1234.56", "1 234,56", "50 €", "50 EUR", "50,-",
// ",50". One or two digits after the last "." or "," are the cents ("-" or nothing: none), groups of three digits
// before it thousands. A lone "1.500" or "1,500" is 1500 in one language and 1.5 in the other: it is not guessed (it
// used to be booked as 1,50 €).
const AMOUNT = /^([+-]?)(\d+|\d{1,3}([.,])\d{3}(?:\3\d{3})*)?(?:([.,])(\d{1,2}|-{1,2})?)?$/;

/** The amount typed in [raw] as a number, or NaN when it is not an unambiguous amount of money. */
function parseAmount(raw) {
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
function applyStatusChangeToHistory(person, newStatus, changeDateStr) {
    const memberSince = person.originalMemberSince || person.memberSince || changeDateStr;
    const changeDate = new Date(changeDateStr);
    if (changeDate < new Date(memberSince)) {
        throw Object.assign(new Error('The change date is before the start of the membership.'), { key: 'status_change_before_member_since' });
    }
    if (changeDateStr <= memberSince) return { ...person, status: newStatus, statusHistory: [{ status: newStatus, startDate: memberSince }] };

    const history = list(person.statusHistory)
        .filter(entry => (entry.startDate ? new Date(entry.startDate) : new Date(memberSince)) < changeDate)
        .map(entry => (entry.endDate && new Date(entry.endDate) <= changeDate ? { ...entry } : { ...entry, endDate: changeDateStr }));
    const lastEnd = history[history.length - 1]?.endDate;
    if (history.length === 0 || (lastEnd && lastEnd < changeDateStr)) {
        const priorStart = lastEnd || memberSince;
        if (priorStart < changeDateStr) history.push({ status: person.status || 'vollverdiener', startDate: priorStart, endDate: changeDateStr });
    }
    history.push({ status: newStatus, startDate: changeDateStr });
    return { ...person, status: newStatus, statusHistory: history };
}

/** What an approved request books on the member's record ([note]: description of a payment that has none). */
const REQUEST_APPLIERS = {
    payment: (person, data, id, note) => (hasEntry(person.payments, id) ? person : {
        ...person,
        payments: [...person.payments, { id, amount: parseFloat(data.amount), date: data.date, description: data.note || note }],
        totalPaid: (person.totalPaid || 0) + parseFloat(data.amount)
    }),
    // The same as a status change by the treasury. It used to leave the open entry of the old status running, so
    // the fee calculation kept charging the old status after the request was approved.
    status: (person, { date, newStatus }) => applyStatusChangeToHistory(person, newStatus, date),
    standing_order: (person, data, id) => (hasEntry(person.standingOrders, id) ? person : {
        ...person,
        standingOrders: [...list(person.standingOrders), { id, amount: parseFloat(data.amount), startDate: data.date, note: data.note || 'Dauerauftrag (Genehmigt)', lastAutoPayment: null }]
    })
};

/**
 * The member's record with an approved request booked. Approving a request twice (two treasurers, a second device,
 * a retry) used to book the money twice; a request that is already booked now changes nothing.
 */
function applyApprovedRequest(person, request, note) {
    const apply = REQUEST_APPLIERS[request.type];
    return apply ? apply(person, request.data || {}, bookingId(request), note) : person;
}

/** The expense list with an approved expense request (the requester is the issuer), or null when it is booked already. */
function addApprovedExpense(expenses, request) {
    const id = bookingId(request);
    if (hasEntry(expenses, id)) return null;
    const { amount, description, date, receipt } = request.data || {};
    return [...expenses, { id, amount: parseFloat(amount), description, issuer: request.personName || '', date, receipt }];
}

/**
 * The record without what approving [request] booked, for an approval that lost against a rejection made at the same
 * moment: its payment or standing order goes, a status change goes back to [before] ({ status, statusHistory }).
 */
function withoutApprovedRequest(person, request, before) {
    if (request.type === 'status') return before ? { ...person, ...before } : person;
    const id = bookingId(request);
    return {
        ...person,
        payments: list(person.payments).filter(payment => String(payment?.id) !== id),
        standingOrders: list(person.standingOrders).filter(order => String(order?.id) !== id)
    };
}

/** The expense list without the expense an approved request booked, or null when it is not there. */
function withoutApprovedExpense(expenses, request) {
    const id = bookingId(request);
    return hasEntry(expenses, id) ? list(expenses).filter(expense => String(expense?.id) !== id) : null;
}

/**
 * Where the payment a treasurer opened (to edit or delete it) is in the current list, or -1 when it is gone. By its
 * id: the list can change while the dialog is open (another booking for the same member shifts the positions), and
 * going by the position edited, or additionally deleted, a different payment. Old payments without an id only by
 * position, while the payment there is still the one that was opened.
 */
function findPaymentIndex(payments, { paymentId, targetIndex, original }) {
    const hasId = payment => payment?.id !== undefined && payment?.id !== null && payment?.id !== '';
    const byId = payments.findIndex(payment => hasId(payment) && String(payment.id) === String(paymentId));
    if (byId >= 0) return byId;
    const there = payments[targetIndex];
    // compared as stored: old amounts can be texts like "50,00"
    const unchanged = there && !hasId(there) && (!original || (there.date === original.date && String(there.amount ?? '') === String(original.amount ?? '')));
    return unchanged ? targetIndex : -1;
}

// --- Fee reset (CALDERA): the fee accounts start afresh on a day the admins chose (backend/feeReset.js) ---
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const monthIndex = dateStr => {
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
function calculatePaidUntil(person, fees) {
    const history = list(person.statusHistory).slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
    const statusAt = month => {
        const entry = history.find(e => !e.endDate || month < monthIndex(e.endDate));
        return (entry && month >= monthIndex(entry.startDate) ? entry.status : null) || person.status;
    };
    const reset = DAY.test(person._feeReset || '') ? person._feeReset : null;
    let credit = reset
        ? list(person.payments).reduce((sum, payment) => (String(payment?.date || '').slice(0, 10) >= reset ? sum + (parseFloat(payment.amount) || 0) : sum), Number(person._feeCarriedOver) || 0)
        : person.totalPaid || 0;
    // (the month as it is written: read as a date, a 1st is still the month before west of Greenwich)
    let month = monthIndex(person.originalMemberSince || person.memberSince);
    if (reset) month = Math.max(month, monthIndex(reset));
    // In whole cents, like the server: added up as they are, amounts like 49.99 drift by a fraction of a cent
    const cents = amount => Math.round(amount * 100);
    credit = cents(credit);
    for (let i = 0; credit > 0 && i < 1200; i++, month++) {
        const rate = cents(fees[statusAt(month)] || 0);
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
function droppedFeesBefore(person, day) {
    const reset = DAY.test(person?._feeReset || '') ? person._feeReset : null;
    if (!reset || !DAY.test(day || '') || day >= reset) return 0;
    return Math.max(0, Number(person._feeWrittenOff) || 0);
}

/**
 * True when what the admin typed is the day [iso] - written as the dialog shows it ("01.01.2027", "01/01/2027", also
 * "1.1.2027") or as "2027-01-01". Typing the day is the confirmation of a fresh start: a tap alone never starts one.
 */
function typedDayMatches(typed, iso) {
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
function feeResetIsNews(day, today) {
    if (!DAY.test(day || '') || !DAY.test(today || '')) return false;
    return Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`) < FEE_RESET_NEWS_DAYS * 86400000;
}

export {
    parseAmount, applyStatusChangeToHistory, applyApprovedRequest, addApprovedExpense, withoutApprovedRequest, withoutApprovedExpense,
    findPaymentIndex, calculatePaidUntil, droppedFeesBefore, typedDayMatches, feeResetIsNews
};
