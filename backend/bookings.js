// What a booking does to a member's record or the expenses, by the rules the web app books with (assets/finance.js):
// an approved request, a status change from a day. API v2 books with these, so a booking through v2 is the very
// booking the web app makes (tests/finance.test.js compares both, case by case).

const list = (value) => (!value ? [] : Array.isArray(value) ? value : Object.values(value));
const hasEntry = (entries, id) => list(entries).some((entry) => String(entry?.id) === id);

/** Id of what an approved request books: approving the same request again finds its booking and adds nothing. */
const bookingId = (request) => `req_${request.id}`;

/**
 * Rewrites the status history so [newStatus] applies from [changeDateStr] (retroactive or future changes): entries
 * still running at that date end there, the new status starts there. Throws (error.key: the web app's translation)
 * when the date is before the start of the membership.
 */
function applyStatusChangeToHistory(person, newStatus, changeDateStr) {
  const memberSince = person.originalMemberSince || person.memberSince || changeDateStr;
  const changeDate = new Date(changeDateStr);
  if (changeDate < new Date(memberSince)) {
    throw Object.assign(new Error('The change date is before the start of the membership.'), { key: 'status_change_before_member_since', status: 400 });
  }
  if (changeDateStr <= memberSince) return { ...person, status: newStatus, statusHistory: [{ status: newStatus, startDate: memberSince }] };

  const history = list(person.statusHistory)
    .filter((entry) => (entry.startDate ? new Date(entry.startDate) : new Date(memberSince)) < changeDate)
    .map((entry) => (entry.endDate && new Date(entry.endDate) <= changeDate ? { ...entry } : { ...entry, endDate: changeDateStr }));
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
    payments: [...list(person.payments), { id, amount: parseFloat(data.amount), date: data.date, description: data.note || note }],
    totalPaid: (person.totalPaid || 0) + parseFloat(data.amount)
  }),
  // The same as a status change by the treasury
  status: (person, { date, newStatus }) => applyStatusChangeToHistory(person, newStatus, date),
  standing_order: (person, data, id) => (hasEntry(person.standingOrders, id) ? person : {
    ...person,
    standingOrders: [...list(person.standingOrders), { id, amount: parseFloat(data.amount), startDate: data.date, note: data.note || 'Dauerauftrag (Genehmigt)', lastAutoPayment: null }]
  })
};

/** The member's record with an approved request booked; a request that is booked already changes nothing. */
function applyApprovedRequest(person, request, note) {
  const apply = REQUEST_APPLIERS[request.type];
  return apply ? apply(person, request.data || {}, bookingId(request), note) : person;
}

/** True when [request] is booked on [person] already (its payment or standing order is there). */
function isBookedOn(person, request) {
  if (request.type === 'payment') return hasEntry(person.payments, bookingId(request));
  if (request.type === 'standing_order') return hasEntry(person.standingOrders, bookingId(request));
  return false;
}

/** The expense list with an approved expense request (the requester is the issuer), or null when it is booked already. */
function addApprovedExpense(expenses, request) {
  const id = bookingId(request);
  if (hasEntry(expenses, id)) return null;
  const { amount, description, date, receipt } = request.data || {};
  return [...list(expenses), { id, amount: parseFloat(amount), description, issuer: request.personName || '', date, receipt }];
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
    payments: list(person.payments).filter((payment) => String(payment?.id) !== id),
    standingOrders: list(person.standingOrders).filter((order) => String(order?.id) !== id)
  };
}

/** The expense list without the expense an approved request booked, or null when it is not there. */
function withoutApprovedExpense(expenses, request) {
  const id = bookingId(request);
  return hasEntry(expenses, id) ? list(expenses).filter((expense) => String(expense?.id) !== id) : null;
}

module.exports = {
  bookingId,
  applyStatusChangeToHistory,
  applyApprovedRequest,
  isBookedOn,
  addApprovedExpense,
  withoutApprovedRequest,
  withoutApprovedExpense
};
