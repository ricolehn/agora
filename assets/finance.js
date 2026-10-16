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

export {
    parseAmount, applyStatusChangeToHistory, applyApprovedRequest, addApprovedExpense, withoutApprovedRequest, withoutApprovedExpense,
    findPaymentIndex
};
