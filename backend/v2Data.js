// The data API v2 reads (routes/v2.js), in its shapes - record ids, money in whole cents, days as 'YYYY-MM-DD',
// moments as ISO 8601 (UTC) - with the permissions of the old API (v1). The AI assistant's lookups (aiTools.js) read
// through the same functions, so both always see the same data under the same rules.
const { context, userMatchesTargetGroups } = require('./context');
const client = require('./db/client');
const finance = require('./db/stores/finance');
const eventsStore = require('./db/stores/events');
const { toCents, amountValue } = require('./db/codec');
const { toDateStr } = require('./utils/date');
const { receiptNames } = require('./v2/http');

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Whole cents, or null for an amount no whole number of cents can hold (an absurd old value like 1e21)
const cents = (amount) => {
  const value = toCents(amountValue(amount)).cents;
  return Number.isSafeInteger(value) ? value : null;
};
const sumCents = (rows) => rows.reduce((sum, row) => sum + (Number.isSafeInteger(row.amountCents) ? row.amountCents : 0), 0);
const isoOf = (stored) => (stored ? new Date(String(stored).replace(' ', 'T')).toISOString() : null);
const isoFromMillis = (value) => (Number.isFinite(value) && value > 0 && value <= 8.64e15 ? new Date(value).toISOString() : null);
const uidOf = (user) => user.uid || user.id;
const canViewFinances = (user) => user.canViewFinances === true;

// --- Finance ------------------------------------------------------------------------------------------------------

/** A member with what the server works out for them (from the member, its hydrated data and its payment rows). */
function memberOf(row, person, paymentRows = null) {
  const data = person?.data || {};
  return {
    id: row.id,
    key: finance.keyOfMember(row),
    userId: row.user || null,
    name: row.name,
    status: row.status || null,
    memberSince: row.memberSince || null,
    originalMemberSince: row.originalMemberSince || null,
    pays: row.pays !== false,
    isDeleted: row.isDeleted === true,
    // What the member's payments add up to: the sum of its payments as API v2 lists them (whole cents each). The old
    // API sums the amounts as written - with an amount beyond the cent (33.333) a member's payments and its total
    // differed by a cent here, and an absurd old amount (1e21) gave no whole number of cents at all
    totalPaidCents: Array.isArray(paymentRows) ? sumCents(paymentRows) : cents(data.totalPaid ?? person?.totalPaid),
    balanceCents: data._currentBalance === undefined ? null : cents(data._currentBalance),
    overdueCents: data._overdueAmount === undefined ? null : cents(data._overdueAmount),
    monthlyFeeCents: data._monthlyFee === undefined ? null : cents(data._monthlyFee),
    // _paidUntil is the last paid day at midnight of the server's time zone, written as a moment in UTC: its day is
    // read in that time zone again (the first ten letters are the day before wherever the clock is ahead of UTC -
    // "paid until the 30th" instead of the 31st)
    paidUntil: data._paidUntil && !Number.isNaN(new Date(data._paidUntil).getTime()) ? toDateStr(new Date(data._paidUntil)) : null,
    isOverdue: data._statusMeta?.isOverdue === true,
    // The fee account as the apps show it: the status this month is charged at, overdue / paid by a standing order /
    // in order, a standing order still to book this month ("due soon", and what it books), and the fresh start the
    // account counts from with what happened on its day
    currentStatus: data._currentStatus || row.status || null,
    feeState: feeStateOf(data._statusMeta),
    isDueSoon: data._statusMeta?.isSoonDue === true,
    hasActiveStandingOrder: data._statusMeta?.isActiveStandingOrder === true,
    anticipatedCents: data._anticipatedPayment === undefined ? null : cents(data._anticipatedPayment),
    freshStart: data._feeReset ? { day: data._feeReset, carriedOverCents: cents(data._feeCarriedOver || 0), writtenOffCents: cents(data._feeWrittenOff || 0) } : null,
    version: row.updated
  };
}

/** The state of a fee account: overdue, paid by a running standing order, or in order (null: nothing worked out). */
function feeStateOf(meta) {
  if (!meta) return null;
  if (meta.isOverdue === true) return 'overdue';
  return meta.isActiveStandingOrder === true ? 'standingOrder' : 'ok';
}

const paymentOf = (row, memberVersion) => ({
  id: row.id,
  memberId: row.member,
  amountCents: row.amountCents,
  date: row.date || null,
  description: row.description || '',
  receipt: row.receipt || null,
  receipts: receiptNames(row.receipt),
  source: row.source || 'manual',
  standingOrderId: row.standingOrder || null,
  clientId: row.clientId ?? null,
  ...(memberVersion ? { memberVersion } : {})
});

const statusPeriodOf = (period) => ({ id: period.id, status: period.status || null, startDate: period.startDate || null, endDate: period.endDate || null });

const standingOrderOf = (order) => ({
  id: order.id, amountCents: order.amountCents, startDate: order.startDate || null, endDate: order.endDate || null, note: order.note || '', lastBookedOn: order.lastAutoPayment || null,
  clientId: order.clientId ?? null
});

// Who may see which member: those with finance rights all of them, everyone else their own. The members come from
// the books' memo (stores/finance.js: every member with its rows, kept up to date with every save) - read only here;
// the orphans (payments of a member that never had a record) are not in it
const visibleTo = (user) => ({ row }) => canViewFinances(user) || row.user === uidOf(user);

/** The members [user] may see: [{ row, person, payments }] (read only). */
async function membersFor(user) {
  return (await finance.membersReadOnly(context.appConfig)).filter(visibleTo(user));
}

/** The member rows [user] may see. */
async function memberRowsFor(user) {
  return (await membersFor(user)).map(({ row }) => row);
}

/** The status periods and standing orders of all members (or of [memberId]), by member id. */
async function memberHistories(memberId) {
  let periods;
  let orders;
  if (memberId) {
    const filter = client.pbFilterEquals('member', memberId);
    [periods, orders] = await Promise.all([finance.COLLECTIONS.PERIODS, finance.COLLECTIONS.STANDING_ORDERS]
      .map((collection) => client.listAllRecords(collection, filter, context.appConfig)));
  } else {
    const members = await finance.membersReadOnly(context.appConfig);
    periods = members.flatMap(({ periods: own }) => own);
    orders = members.flatMap(({ orders: own }) => own);
  }
  const byMember = new Map();
  const entry = (id) => byMember.get(id) || byMember.set(id, { statusPeriods: [], standingOrders: [] }).get(id);
  for (const period of periods) entry(period.member).statusPeriods.push(statusPeriodOf(period));
  for (const order of [...orders].sort((a, b) => (a.position || 0) - (b.position || 0))) entry(order.member).standingOrders.push(standingOrderOf(order));
  return byMember;
}

/**
 * The payments of the members [user] may see, between the days [from] and [to] (both optional) - of [member] only if
 * given. Each carries its member's version (memberVersion), the one a change of it is based on.
 */
async function paymentsFor(user, { member, from, to } = {}) {
  const after = DAY.test(String(from || '')) ? from : null;
  const before = DAY.test(String(to || '')) ? to : null;
  const list = [];
  for (const { row, payments } of await membersFor(user)) {
    if (member && row.id !== String(member)) continue;
    for (const payment of payments) {
      // As PocketBase compared the day columns: a payment without a day is before every day
      if (after !== null && !((payment.date || '') >= after)) continue;
      if (before !== null && !((payment.date || '') <= before)) continue;
      list.push(paymentOf(payment, row.updated));
    }
  }
  return list;
}

// Donations and expenses: their rows in the order the lists are kept, and their shape. [shown]: the rows that are
// entries of the list (an entry of an older donations list that is no donation - a bare number - is kept for the old
// API only); [rows] keeps them all, in step with the list as the apps see it
const LIST_READS = {
  donations: {
    rows: async () => (await client.listAllRecords(finance.COLLECTIONS.DONATIONS, '', context.appConfig)).sort((a, b) => (a.position || 0) - (b.position || 0)),
    shown: (row) => !finance.isKeptEntry(row),
    toV2: (row) => ({ id: row.id, amountCents: row.amountCents, date: row.date || null, donorName: row.donorName || '', description: row.description || '', clientId: row.clientId ?? null })
  },
  expenses: {
    rows: () => client.listAllRecords(finance.COLLECTIONS.EXPENSES, '', context.appConfig),
    shown: () => true,
    toV2: (row) => ({
      id: row.id, amountCents: row.amountCents, date: row.date || null, issuer: row.issuer || '', description: row.description || '', receipt: row.receipt || null,
      receipts: receiptNames(row.receipt), clientId: row.clientId ?? null
    })
  }
};

/**
 * The money of the books as the app's statistics count it, on [today] (the server's day): per month and kind what is
 * booked up to today (oldest month first), what is dated after today (planned: not in the cash balance yet), and what
 * has no readable day (the statistics count it from the start, so the cash balance does too). Summed from the months
 * of finance_monthly_totals alone, the cash balance of API v2 and the AI took the planned entries in and named another
 * balance than the app. Worked out from the members memo (every payment the books show) and the lists of donations and
 * expenses - SQLite works the view out anew for every question, a few hundred milliseconds after every booking.
 */
let moneyKept = null;
async function moneyBooks(today = toDateStr(new Date())) {
  // Kept until anything is written, the members are read anew or the day changes
  const writes = client.writeGeneration();
  const members = await finance.membersReadOnly(context.appConfig);
  if (moneyKept && moneyKept.members === members && moneyKept.writes === writes && moneyKept.today === today) return moneyKept.money;
  const money = await sumMoney(members, today);
  if (client.writeGeneration() === writes) moneyKept = { members, writes, today, money };
  return money;
}

async function sumMoney(members, today) {
  const [donations, expenses] = await Promise.all([LIST_READS.donations.rows(), LIST_READS.expenses.rows()]);
  const bookedBy = new Map();
  const plannedBy = new Map();
  const undated = {};
  const add = (kind, date, cents) => {
    if (!date) {
      const entry = undated[kind] || (undated[kind] = { totalCents: 0, entries: 0 });
      entry.totalCents += cents;
      entry.entries += 1;
      return;
    }
    const month = date.slice(0, 7);
    const into = date > today ? plannedBy : bookedBy;
    const key = `${month}|${kind}`;
    const entry = into.get(key) || into.set(key, { month, kind, totalCents: 0, entries: 0 }).get(key);
    entry.totalCents += cents;
    entry.entries += 1;
  };
  const centsOf = (row) => (Number.isSafeInteger(row.amountCents) ? row.amountCents : 0);
  for (const { payments } of members) for (const payment of payments) add('memberPayment', payment.date || '', centsOf(payment));
  for (const row of donations) if (LIST_READS.donations.shown(row)) add('donation', row.date || '', centsOf(row));
  for (const row of expenses) add('expense', row.date || '', centsOf(row));
  const KIND_ORDER = { memberPayment: 0, donation: 1, expense: 2 };
  const ordered = (map) => [...map.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : KIND_ORDER[a.kind] - KIND_ORDER[b.kind]));
  return { today, booked: ordered(bookedBy), planned: ordered(plannedBy), undated };
}

/** The cents of each kind in [rows] ({ kind, totalCents }): { memberPayment, donation, expense }. */
function centsByKind(rows) {
  const totals = { memberPayment: 0, donation: 0, expense: 0 };
  for (const row of rows) if (Object.hasOwn(totals, row.kind)) totals[row.kind] += row.totalCents;
  return totals;
}

const changeOf = (row) => ({ id: row.id, area: row.area, action: row.action, at: isoOf(row.at), by: row.by || null, byName: row.byName || '', memberId: row.member || null, target: row.target || null, details: row.details ?? null });

// A value in a filter (the values come checked: ids, days, moments as the database writes them)
const quoted = (value) => JSON.stringify(String(value));

/**
 * The filter of the change log: one [area], one [member], the days [from] to [to] (UTC days, as the log's moments are
 * kept) - all optional. Asked of the database, never read whole and sorted out here: the log grows with every booking
 * and is kept ten years.
 */
function changesFilter({ area, member, from, to } = {}) {
  const filters = [];
  if (area) filters.push(client.pbFilterEquals('area', String(area)));
  if (member) filters.push(client.pbFilterEquals('member', String(member)));
  if (DAY.test(String(from || ''))) filters.push(`at >= ${quoted(`${from} 00:00:00.000Z`)}`);
  if (DAY.test(String(to || ''))) filters.push(`at <= ${quoted(`${to} 23:59:59.999Z`)}`);
  return filters;
}

/** The whole finance change log (or the part [changesFilter] picks), oldest first - for the AI's lookups. */
async function financeChanges(options = {}) {
  return (await client.listAllRecords(finance.COLLECTIONS.CHANGES, changesFilter(options).join(' && '), context.appConfig, 'at,id')).map(changeOf);
}

/**
 * Where the next page of a list newest first ([field] descending, then the id) starts: after [at] and [id]. The first
 * condition alone finds the place in the index, the second leaves out what the page before showed.
 */
const pageAfter = (field, [at, id]) => `${field} <= ${quoted(at)} && (${field} < ${quoted(at)} || id < ${quoted(id)})`;

/**
 * One page of the finance change log, newest first: [limit] entries after [after] ([at, id] of the last entry of the
 * page before, as the database keeps them; null: from the newest). { items, next }: next is where the following page
 * starts (null: this was the last).
 */
async function financeChangesPage({ limit, after = null, ...options }) {
  const filters = changesFilter(options);
  if (after) filters.push(pageAfter('at', after));
  const rows = await client.listRecordsPage(finance.COLLECTIONS.CHANGES, filters.join(' && '), context.appConfig, { sort: '-at,-id', perPage: limit + 1 });
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: items.map(changeOf), next: rows.length > limit && last ? [last.at || '', last.id] : null };
}

// --- Mentoring ----------------------------------------------------------------------------------------------------

/**
 * One page of the messages of the conversation [threadId], newest first: [limit] records after [after] ([created, id]
 * of the last message of the page before; null: from the newest), as the old table gave them (still encrypted).
 * { items, next } as financeChangesPage. Only the page is read and decrypted - a conversation of years was read and
 * decrypted whole for every look at it.
 */
async function messagesPage(threadId, { limit, after = null }) {
  const { messages } = require('./db/stores/mentoring');
  const filters = [client.pbFilterEquals('thread', threadId)];
  if (after) filters.push(pageAfter('created', after));
  const rows = await client.listRecordsPage(messages.collection(), filters.join(' && '), context.appConfig, { sort: '-created,-id', perPage: limit + 1 });
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: items.map(messages.toOld), next: rows.length > limit && last ? [last.created || '', last.id] : null };
}

// --- Events -------------------------------------------------------------------------------------------------------

const eventOf = (event, counts, mine) => ({
  id: event.id,
  title: event.title,
  date: event.date,
  endDate: event.endDate || null,
  startTime: event.startTime || null,
  endTime: event.endTime || null,
  location: event.location || '',
  description: event.description || '',
  kind: event.eventType || (event.isRecurring ? 'termin' : 'event'),
  status: event.status || 'scheduled',
  isPinned: event.isPinned === true,
  requiresRegistration: event.requiresRegistration === true,
  minParticipants: event.minParticipants || 0,
  maxParticipants: event.maxParticipants || 0,
  targetGroups: Array.isArray(event.targetGroups) ? event.targetGroups : [],
  createdBy: event.createdBy || null,
  imageUrl: event.imageUrl || null,
  isPublic: event.isPublic === true,
  registeredCount: counts.registered,
  waitlistCount: counts.waitlist,
  // null: no minimum
  minimumReached: (event.minParticipants || 0) > 0 ? counts.registered >= event.minParticipants : null,
  myRegistration: mine ? { id: mine.id, status: mine.status } : null,
  createdAt: event.created || null
});

/** May [user] see [event] in the calendar: their own events and those of their target groups (as GET /api/events). */
const seesEvent = (user, event) => event.createdBy === uidOf(user) || userMatchesTargetGroups(user, event.targetGroups);

/** The events [user] sees in the calendar, taking place between the days [from] and [to] (both optional). */
async function visibleEvents(user, { from, to } = {}) {
  const filters = [];
  if (DAY.test(String(from || ''))) filters.push(`(date >= ${JSON.stringify(from)} || endDate >= ${JSON.stringify(from)})`);
  if (DAY.test(String(to || ''))) filters.push(`date <= ${JSON.stringify(to)}`);
  const events = await eventsStore.listEvents(context.appConfig, filters.join(' && '));
  return events.filter((event) => seesEvent(user, event));
}

// The events whose sign-ups one read asks for (a page of API v2 holds at most 500)
const EVENTS_AT_ONCE = 100;

/**
 * The sign-ups and guests of the events [eventIds], by event id ({ registrations, guests }, each in the order of the
 * queue). Only theirs: every sign-up of every year, read and sorted out for each event of a page, made a page of the
 * calendar slower with every year (1,000 events with 20,000 sign-ups: almost half a second).
 */
async function seatsOf(eventIds) {
  const seats = new Map(eventIds.map((id) => [id, { registrations: [], guests: [] }]));
  const ids = [...seats.keys()];
  for (let start = 0; start < ids.length; start += EVENTS_AT_ONCE) {
    const filter = client.pbFilterIn('event', ids.slice(start, start + EVENTS_AT_ONCE));
    const [registrations, guests] = await Promise.all([
      eventsStore.listEventRegistrations(context.appConfig, filter),
      eventsStore.listEventGuests(context.appConfig, filter)
    ]);
    for (const registration of registrations) seats.get(registration.event)?.registrations.push(registration);
    for (const guest of guests) seats.get(guest.event)?.guests.push(guest);
  }
  return seats;
}

module.exports = {
  DAY,
  cents,
  sumCents,
  isoOf,
  isoFromMillis,
  uidOf,
  canViewFinances,
  memberOf,
  paymentOf,
  statusPeriodOf,
  standingOrderOf,
  memberRowsFor,
  membersFor,
  memberHistories,
  paymentsFor,
  LIST_READS,
  moneyBooks,
  centsByKind,
  changeOf,
  financeChanges,
  financeChangesPage,
  messagesPage,
  eventOf,
  seesEvent,
  visibleEvents,
  seatsOf
};
