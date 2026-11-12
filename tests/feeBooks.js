// A second set of books for the fee accounts, kept the long way round - for the tests that live through years
// (years.test.js). It shares no code with the server: it only knows the rules as they are told to an admin, and the
// plain facts a treasurer could note on paper - who joined when, who had which status from which day, what was paid
// on which day, which fees count from which month, on which days the accounts were started afresh. Where the server
// and these books disagree about a number, one of them is wrong.
//
// The rules:
//   - A member owes every month from the month of "member since" up to the current one, each at the fee of that month
//     for the status the member had in it. A status counts from the month of its day; the months before the first
//     one cost the status the member has now.
//   - What a month costs is said by the fees over time: the fees of the latest change at or before the month, else
//     the fees from the beginning. Fees from a month that are the fees counting before it anyway say nothing and are
//     not noted; whatever else was entered stays until it is taken back.
//   - Against that stands what was paid, whenever it is dated.
//   - A fresh start whose day has come closes the account of everyone who had joined before it: the months before
//     its month against the payments dated before its day. What is open is dropped, what is ahead is carried over,
//     and the account goes on from the month of the day with that credit and the payments from the day on.
//   - "Paid until" is the last month the money pays for in full, month after month; with nothing paid in, the month
//     before the account begins.
// Everything is counted in whole cents.

const cents = (amount) => Math.round(Number(amount) * 100) + 0;
const monthOf = (day) => day.slice(0, 7);
const TWO_DIGITS = Array.from({ length: 13 }, (_, i) => String(i).padStart(2, '0'));
const addMonths = (month, count) => {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + count;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${TWO_DIGITS[(index % 12) + 1]}`;
};
const addDays = (day, count) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};

/** Empty books: the fees from the beginning, no change, no fresh start, nobody. */
function openBooks(feesFromTheBeginning) {
  return { fees: { start: { ...feesFromTheBeginning }, changes: {} }, freshStarts: [], members: {} };
}

/** The fee table of [month]: the latest change at or before it, else the fees from the beginning. */
function feesIn(books, month) {
  let table = books.fees.start;
  for (const from of Object.keys(books.fees.changes).sort()) if (from <= month) table = books.fees.changes[from];
  return table;
}

const sameFees = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every((status) => cents(a[status] || 0) === cents(b[status] || 0));

// --- What an admin does to the fees, as it is noted ---

function write(books, month, table) {
  delete books.fees.changes[month];
  if (!sameFees(table, feesIn(books, addMonths(month, -1)))) books.fees.changes[month] = table;
}

/** Fees [fees] (the statuses they name) from [month] on - until the next change. */
function noteFeesFrom(books, month, fees) {
  write(books, month, { ...feesIn(books, month), ...fees });
}

/** The change of [from] now counts from [month], with [fees]. */
function noteFeesMoved(books, from, month, fees) {
  const table = { ...books.fees.changes[from], ...fees };
  delete books.fees.changes[from];
  write(books, month, table);
}

function noteFeesTakenBack(books, month) {
  delete books.fees.changes[month];
}

function noteFeesFromTheBeginning(books, fees) {
  books.fees.start = { ...books.fees.start, ...fees };
}

function noteFreshStart(books, day) {
  books.freshStarts.push(day);
}

function noteFreshStartTakenBack(books, day) {
  books.freshStarts = books.freshStarts.filter((other) => other !== day);
}

// --- What happens to a member, as it is noted ---

function noteMember(books, id, since, status) {
  books.members[id] = { since, status: [{ from: since, status }], payments: {}, gone: false };
}

function notePayment(books, id, key, day, amount) {
  books.members[id].payments[key] = { day, amount };
}

function notePaymentGone(books, id, key) {
  delete books.members[id].payments[key];
}

/** From [day] on the member has [status]: whatever was noted for that day or later no longer counts. */
function noteStatus(books, id, day, status) {
  const member = books.members[id];
  member.status = day <= member.since ? [{ from: member.since, status }] : [...member.status.filter((entry) => entry.from < day), { from: day, status }];
}

/** "Member since" is corrected to [day]: the first status counts from there. */
function noteMemberSince(books, id, day) {
  const member = books.members[id];
  member.since = day;
  member.status[0] = { ...member.status[0], from: day };
}

// --- The numbers ---

function statusIn(member, month) {
  let status = null;
  for (const entry of member.status) if (monthOf(entry.from) <= month) status = entry.status;
  return status || member.status[member.status.length - 1].status;
}

/** What [month] costs the member, in cents. */
function feeFor(books, id, month) {
  return cents(feesIn(books, month)[statusIn(books.members[id], month)] || 0);
}

/**
 * The member's fee account on [today], in cents: { balance, open, paidUntil ('YYYY-MM'), countsFrom, carriedOver,
 * dropped, feeThisMonth }. countsFrom: the day of the fresh start the account counts from, else null.
 */
function accountOf(books, id, today) {
  const member = books.members[id];
  const changes = Object.keys(books.fees.changes).sort().reverse();
  const cost = (month) => {
    const from = changes.find((change) => change <= month);
    return cents((from ? books.fees.changes[from] : books.fees.start)[statusIn(member, month)] || 0);
  };
  const payments = Object.values(member.payments);
  const paid = (from, before) => payments.reduce((sum, payment) => (
    (from === null || payment.day >= from) && (before === null || payment.day < before) ? sum + cents(payment.amount) : sum
  ), 0);

  let month = monthOf(member.since);
  let countsFrom = null;
  let carriedOver = 0;
  let dropped = 0;
  for (const day of books.freshStarts.filter((line) => line <= today && line > member.since).sort()) {
    let closing = carriedOver + paid(countsFrom, day);
    for (; month < monthOf(day); month = addMonths(month, 1)) closing -= cost(month);
    dropped = Math.max(0, -closing);
    carriedOver = Math.max(0, closing);
    countsFrom = day;
  }

  const firstMonth = month;
  const paidIn = carriedOver + paid(countsFrom, null);
  let balance = paidIn;
  for (; month <= monthOf(today); month = addMonths(month, 1)) balance -= cost(month);

  // the months the money pays for, one after the other (a month that costs nothing is passed)
  let paidUntil = addMonths(firstMonth, -1);
  if (paidIn !== 0) {
    let left = paidIn;
    for (let next = firstMonth, i = 0; left >= 0 && i < 1200; next = addMonths(next, 1), i += 1) {
      if (cost(next) > left) break;
      left -= cost(next);
      paidUntil = next;
    }
  }
  return { balance, open: Math.max(0, -balance), paidUntil, countsFrom, carriedOver, dropped, feeThisMonth: cost(monthOf(today)) };
}

/**
 * What the fees page shows on [today]: the fees of this month, since which month they have counted (null: from the
 * beginning), and the month from which they will next be others (null: no change to come) - found by going through
 * the months one by one.
 */
function feesPageOf(books, today) {
  const month = monthOf(today);
  const current = feesIn(books, month);
  const changes = Object.keys(books.fees.changes).sort();
  let since = null;
  for (const from of changes) if (from <= month && !sameFees(feesIn(books, from), feesIn(books, addMonths(from, -1)))) since = from;
  const next = changes.find((from) => from > month && !sameFees(feesIn(books, from), feesIn(books, addMonths(from, -1)))) || null;
  return { current, since, next };
}

module.exports = {
  cents,
  monthOf,
  addMonths,
  addDays,
  sameFees,
  openBooks,
  feesIn,
  noteFeesFrom,
  noteFeesMoved,
  noteFeesTakenBack,
  noteFeesFromTheBeginning,
  noteFreshStart,
  noteFreshStartTakenBack,
  noteMember,
  notePayment,
  notePaymentGone,
  noteStatus,
  noteMemberSince,
  statusIn,
  feeFor,
  accountOf,
  feesPageOf
};
