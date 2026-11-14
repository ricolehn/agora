// The data API v2 reads (routes/v2.js), in its shapes - record ids, money in whole cents, days as 'YYYY-MM-DD',
// moments as ISO 8601 (UTC) - with the permissions of the old API (v1). The AI assistant's lookups (aiTools.js) read
// through the same functions, so both always see the same data under the same rules.
const { context, userMatchesTargetGroups } = require('./context');
const client = require('./db/client');
const finance = require('./db/stores/finance');
const eventsStore = require('./db/stores/events');
const { toCents, amountValue } = require('./db/codec');
const { toDateStr } = require('./utils/date');

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const cents = (amount) => toCents(amountValue(amount)).cents;
const isoOf = (stored) => (stored ? new Date(String(stored).replace(' ', 'T')).toISOString() : null);
const isoFromMillis = (value) => (Number.isFinite(value) && value > 0 && value <= 8.64e15 ? new Date(value).toISOString() : null);
const uidOf = (user) => user.uid || user.id;
const canViewFinances = (user) => user.canViewFinances === true;

// --- Finance ------------------------------------------------------------------------------------------------------

/** A member with what the server works out for them (from the member and its hydrated data). */
function memberOf(row, person) {
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
    // What the member's payments add up to, as the old API shows it (data.totalPaid) - not the list column of the old
    // record, which could be stale (a member whose old column said 0 was shown with nothing paid)
    totalPaidCents: cents(data.totalPaid ?? person?.totalPaid),
    balanceCents: data._currentBalance === undefined ? null : cents(data._currentBalance),
    overdueCents: data._overdueAmount === undefined ? null : cents(data._overdueAmount),
    monthlyFeeCents: data._monthlyFee === undefined ? null : cents(data._monthlyFee),
    // _paidUntil is the last paid day at midnight of the server's time zone, written as a moment in UTC: its day is
    // read in that time zone again (the first ten letters are the day before wherever the clock is ahead of UTC -
    // "paid until the 30th" instead of the 31st)
    paidUntil: data._paidUntil && !Number.isNaN(new Date(data._paidUntil).getTime()) ? toDateStr(new Date(data._paidUntil)) : null,
    isOverdue: data._statusMeta?.isOverdue === true,
    version: row.updated
  };
}

const paymentOf = (row, memberVersion) => ({
  id: row.id,
  memberId: row.member,
  amountCents: row.amountCents,
  date: row.date || null,
  description: row.description || '',
  receipt: row.receipt || null,
  source: row.source || 'manual',
  standingOrderId: row.standingOrder || null,
  clientId: row.clientId ?? null,
  ...(memberVersion ? { memberVersion } : {})
});

const statusPeriodOf = (period) => ({ id: period.id, status: period.status || null, startDate: period.startDate || null, endDate: period.endDate || null });

const standingOrderOf = (order) => ({
  id: order.id, amountCents: order.amountCents, startDate: order.startDate || null, endDate: order.endDate || null, note: order.note || '', lastBookedOn: order.lastAutoPayment || null
});

// Who may see which member: those with finance rights all of them, everyone else their own (never the orphans)
const visibleMemberRows = (rows, user) => rows.filter((row) => !finance.isOrphan(row) && (canViewFinances(user) || row.user === uidOf(user)));

/** The member rows [user] may see. */
async function memberRowsFor(user) {
  return visibleMemberRows(await client.listAllRecords(finance.COLLECTIONS.MEMBERS, '', context.appConfig), user);
}

/** The member rows [user] may see with their worked-out data ({ row, person }). */
async function membersFor(user) {
  const [rows, people] = await Promise.all([client.listAllRecords(finance.COLLECTIONS.MEMBERS, '', context.appConfig), finance.listPeopleRecords(context.appConfig)]);
  const byKey = new Map(people.map((person) => [person.personKey, person]));
  return visibleMemberRows(rows, user).map((row) => ({ row, person: byKey.get(finance.keyOfMember(row)) }));
}

/** The status periods and standing orders of all members (or of [memberId]), by member id. */
async function memberHistories(memberId) {
  const filter = memberId ? client.pbFilterEquals('member', memberId) : '';
  const [periods, orders] = await Promise.all([finance.COLLECTIONS.PERIODS, finance.COLLECTIONS.STANDING_ORDERS]
    .map((collection) => client.listAllRecords(collection, filter, context.appConfig)));
  const byMember = new Map();
  const entry = (id) => byMember.get(id) || byMember.set(id, { statusPeriods: [], standingOrders: [] }).get(id);
  for (const period of periods) entry(period.member).statusPeriods.push(statusPeriodOf(period));
  for (const order of orders.sort((a, b) => (a.position || 0) - (b.position || 0))) entry(order.member).standingOrders.push(standingOrderOf(order));
  return byMember;
}

/** The payments of the members [user] may see, between the days [from] and [to] (both optional) - of [member] only if given. */
async function paymentsFor(user, { member, from, to } = {}) {
  const visible = new Set((await memberRowsFor(user)).map((row) => row.id));
  const filters = [];
  if (member) filters.push(client.pbFilterEquals('member', String(member)));
  if (DAY.test(String(from || ''))) filters.push(`date >= ${JSON.stringify(from)}`);
  if (DAY.test(String(to || ''))) filters.push(`date <= ${JSON.stringify(to)}`);
  const rows = await client.listAllRecords(finance.COLLECTIONS.PAYMENTS, filters.join(' && '), context.appConfig);
  return rows.filter((row) => visible.has(row.member)).map((row) => paymentOf(row));
}

// Donations and expenses: their rows in the order the lists are kept, and their shape
const LIST_READS = {
  donations: {
    rows: async () => (await client.listAllRecords(finance.COLLECTIONS.DONATIONS, '', context.appConfig)).sort((a, b) => (a.position || 0) - (b.position || 0)),
    toV2: (row) => ({ id: row.id, amountCents: row.amountCents, date: row.date || null, donorName: row.donorName || '', description: row.description || '' })
  },
  expenses: {
    rows: () => client.listAllRecords(finance.COLLECTIONS.EXPENSES, '', context.appConfig),
    toV2: (row) => ({ id: row.id, amountCents: row.amountCents, date: row.date || null, issuer: row.issuer || '', description: row.description || '', receipt: row.receipt || null })
  }
};

/** Money per month and kind as the database sums it up (finance_monthly_totals), oldest month first. */
const monthlyTotalRows = () => client.listAllRecords('finance_monthly_totals', '', context.appConfig, 'month');

const changeOf = (row) => ({ id: row.id, area: row.area, action: row.action, at: isoOf(row.at), by: row.by || null, byName: row.byName || '', memberId: row.member || null, target: row.target || null, details: row.details ?? null });

/** The finance change log, of one [area] and one [member] if given. */
async function financeChanges({ area, member } = {}) {
  const filters = [];
  if (area) filters.push(client.pbFilterEquals('area', String(area)));
  if (member) filters.push(client.pbFilterEquals('member', String(member)));
  return (await client.listAllRecords(finance.COLLECTIONS.CHANGES, filters.join(' && '), context.appConfig)).map(changeOf);
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

module.exports = {
  DAY,
  cents,
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
  monthlyTotalRows,
  changeOf,
  financeChanges,
  eventOf,
  seesEvent,
  visibleEvents
};
