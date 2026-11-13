// API v2 (docs/API_V2.md): the data in the shapes of the new structure - record ids, money in whole cents, days as
// 'YYYY-MM-DD', moments as ISO 8601 (UTC), camelCase, lists in pages with a cursor, errors as { error: { code,
// message } }. The permissions are those of the old API (v1), which stays as it is for every app version.
//
// Reads come from the new tables' columns. Writes of the books go through the same functions as v1: the balances,
// the change log and the checks for conflicting changes work exactly alike. A write names the version it is based on
// (memberVersion for a member's payments, listVersion for donations and expenses) and is refused with 409 when the
// data changed meanwhile.
const express = require('express');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { context, verifyToken, protectedActionRateLimit, broadcastDataUpdate, userMatchesTargetGroups, writeLogicalPath } = require('../context');
const client = require('../db/client');
const finance = require('../db/stores/finance');
const eventsStore = require('../db/stores/events');
const { toCents, amountValue, fromCents } = require('../db/codec');
const { createItemStore } = require('../itemStore');
const { listGroupRecords, listMentoringThreadsForUser, listMentoringMessages, listMentorRecords, listUserRecords } = require('../pocketbase');
const { seatCounts } = require('../eventSeats');
const { canUserAccessEventDutyPlan } = require('../eventAccess');

const router = express.Router();
const BASE = '/api/v2';

// --- Answers -------------------------------------------------------------------------------------------------------

const ERROR_CODES = { 400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict' };
const fail = (res, status, message) => res.status(status).json({ error: { code: ERROR_CODES[status] || 'server_error', message } });

/** Runs [handler]; errors become { error: { code, message } } (409 for a conflicting change). */
const handle = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    const status = [400, 403, 404, 409].includes(err?.status) ? err.status : 500;
    if (status === 500) console.error(`[API v2] ${req.method} ${req.path} failed:`, err);
    fail(res, status, status === 500 ? 'The request could not be handled.' : status === 409 ? 'The data changed meanwhile: read it again and repeat the change.' : err.message);
  }
};

const cents = (amount) => toCents(amountValue(amount)).cents;
const isoOf = (stored) => (stored ? new Date(String(stored).replace(' ', 'T')).toISOString() : null);
const isoFromMillis = (value) => (Number.isFinite(value) && value > 0 && value <= 8.64e15 ? new Date(value).toISOString() : null);
const uidOf = (req) => req.user.uid || req.user.id;
const canView = (req) => req.user.canViewFinances === true;
const canManage = (req) => req.user.canManageFinances === true;
const needs = (allowed) => {
  if (!allowed) throw Object.assign(new Error('You may not do this.'), { status: 403 });
};
const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const notFound = (what) => Object.assign(new Error(`${what} not found.`), { status: 404 });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// --- Pages: newest first (or as named), cut after an item (not a position: an item added meanwhile shifts nothing) ---

const encodeCursor = (key) => Buffer.from(JSON.stringify(key)).toString('base64url');
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const key = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return Array.isArray(key) && key.length === 2 ? key : null;
  } catch {
    return null;
  }
}

/** [items] sorted by [sortKey] (descending - or [ascending] -, then by id), as one page of [req] ({ items, nextCursor }). */
function page(items, req, sortKey, { ascending = false } = {}) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const keyOf = (item) => [String(sortKey(item) ?? ''), String(item.id)];
  const order = (a, b) => {
    const result = a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    return ascending ? result : -result;
  };
  const after = (a, b) => order(a, b) > 0;
  const sorted = [...items].sort((x, y) => order(keyOf(x), keyOf(y)));
  const cursor = decodeCursor(req.query.cursor);
  const start = cursor ? sorted.findIndex((item) => after(keyOf(item), cursor)) : 0;
  const slice = start < 0 ? [] : sorted.slice(start, start + limit);
  const more = start >= 0 && start + limit < sorted.length;
  return { items: slice, nextCursor: more ? encodeCursor(keyOf(slice[slice.length - 1])) : null };
}

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
    totalPaidCents: cents(person?.totalPaid),
    balanceCents: data._currentBalance === undefined ? null : cents(data._currentBalance),
    overdueCents: data._overdueAmount === undefined ? null : cents(data._overdueAmount),
    monthlyFeeCents: data._monthlyFee === undefined ? null : cents(data._monthlyFee),
    paidUntil: data._paidUntil ? String(data._paidUntil).slice(0, 10) : null,
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

/** The member rows and their worked-out data, by member id - all of them, or the reader's own (no finance rights). */
async function membersFor(req) {
  const [rows, people] = await Promise.all([client.listAllRecords(finance.COLLECTIONS.MEMBERS, '', context.appConfig), finance.listPeopleRecords(context.appConfig)]);
  const byKey = new Map(people.map((person) => [person.personKey, person]));
  const visible = rows.filter((row) => !finance.isOrphan(row) && (canView(req) || row.user === uidOf(req)));
  return visible.map((row) => ({ row, person: byKey.get(finance.keyOfMember(row)) }));
}

async function memberRow(id) {
  const row = typeof id === 'string' && id ? await client.getRecord(finance.COLLECTIONS.MEMBERS, id, context.appConfig) : null;
  if (!row || finance.isOrphan(row)) throw notFound('Member');
  return row;
}

router.get(`${BASE}/members`, verifyToken, handle(async (req, res) => {
  const members = (await membersFor(req)).map(({ row, person }) => memberOf(row, person));
  res.json(page(members.filter((member) => req.query.includeDeleted === '1' || !member.isDeleted), req, (member) => member.name));
}));

router.get(`${BASE}/members/:id`, verifyToken, handle(async (req, res) => {
  const row = await memberRow(req.params.id);
  needs(canView(req) || row.user === uidOf(req));
  const person = await finance.getPeopleRecord(context.appConfig, finance.keyOfMember(row));
  const [payments, periods, orders] = await Promise.all([finance.COLLECTIONS.PAYMENTS, finance.COLLECTIONS.PERIODS, finance.COLLECTIONS.STANDING_ORDERS]
    .map((collection) => client.listAllRecords(collection, client.pbFilterEquals('member', row.id), context.appConfig)));
  res.json({
    ...memberOf(row, person),
    payments: payments.map((payment) => paymentOf(payment)).sort((a, b) => String(b.date).localeCompare(String(a.date))),
    statusPeriods: periods.map((period) => ({ id: period.id, status: period.status || null, startDate: period.startDate || null, endDate: period.endDate || null })),
    standingOrders: orders.sort((a, b) => (a.position || 0) - (b.position || 0)).map((order) => ({
      id: order.id, amountCents: order.amountCents, startDate: order.startDate || null, endDate: order.endDate || null, note: order.note || '', lastBookedOn: order.lastAutoPayment || null
    }))
  });
}));

router.get(`${BASE}/payments`, verifyToken, handle(async (req, res) => {
  const visible = new Set((await membersFor(req)).map(({ row }) => row.id));
  const filters = [];
  if (req.query.member) filters.push(client.pbFilterEquals('member', String(req.query.member)));
  if (DAY.test(String(req.query.from || ''))) filters.push(`date >= ${JSON.stringify(req.query.from)}`);
  if (DAY.test(String(req.query.to || ''))) filters.push(`date <= ${JSON.stringify(req.query.to)}`);
  const rows = await client.listAllRecords(finance.COLLECTIONS.PAYMENTS, filters.join(' && '), context.appConfig);
  res.json(page(rows.filter((row) => visible.has(row.member)).map((row) => paymentOf(row)), req, (payment) => payment.date));
}));

// A payment is part of its member's books: written through the member (as v1 does), based on the member's version
async function changeMemberPayments(req, memberId, memberVersion, change) {
  needs(canManage(req));
  if (typeof memberVersion !== 'string' || !memberVersion) throw invalid('memberVersion is needed: the version of the member the change is based on.');
  const row = await memberRow(memberId);
  if (row.updated !== memberVersion) throw Object.assign(new Error('Conflict'), { status: 409 });
  const personKey = finance.keyOfMember(row);
  const person = await finance.getPeopleRecord(context.appConfig, personKey);
  const payments = [...(person.data.payments || [])];
  // The old records of the member's payments know their record ids; their data are the very objects of the list
  const byRecordId = new Map((person._childPayments || []).map((old) => [old.id, old.data]));
  const result = change(payments, byRecordId);
  const saved = await finance.upsertPeopleRecord(context.appConfig, personKey, { ...person.data, payments: result.payments }, memberVersion);
  broadcastDataUpdate();
  return { saved, ...result };
}

/** Where the payment [current] (an object of the member's list) is in [payments]: the same object, or one just like it. */
function indexOfPayment(payments, current) {
  if (!current) return -1;
  const same = payments.indexOf(current);
  return same >= 0 ? same : payments.findIndex((payment) => isDeepStrictEqual(payment, current));
}

function paymentInput(body, current = {}) {
  const next = { ...current };
  if (body.amountCents !== undefined) {
    if (!Number.isInteger(body.amountCents)) throw invalid('amountCents must be a whole number of cents.');
    next.amount = fromCents(body.amountCents);
  }
  if (body.date !== undefined) {
    if (!DAY.test(String(body.date))) throw invalid('date must be a day YYYY-MM-DD.');
    next.date = body.date;
  }
  if (body.description !== undefined) next.description = String(body.description).slice(0, 500);
  if (body.receipt !== undefined) {
    if (body.receipt === null || body.receipt === '') delete next.receipt;
    else next.receipt = String(body.receipt).slice(0, 300);
  }
  return next;
}

async function paymentAnswer(memberId, clientId) {
  const row = await memberRow(memberId);
  const rows = await client.listAllRecords(finance.COLLECTIONS.PAYMENTS, client.pbFilterEquals('member', memberId), context.appConfig);
  const payment = rows.find((candidate) => JSON.stringify(candidate.clientId) === JSON.stringify(clientId));
  return payment ? paymentOf(payment, row.updated) : null;
}

router.post(`${BASE}/payments`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = req.body || {};
  if (typeof body.memberId !== 'string' || !body.memberId) throw invalid('memberId is needed.');
  if (body.amountCents === undefined || body.date === undefined) throw invalid('amountCents and date are needed.');
  // Booked for a request: its id makes the booking happen once, however often it is sent
  const clientId = body.requestId ? `req_${String(body.requestId)}` : crypto.randomUUID();
  const payment = { ...paymentInput({ description: '', ...body }), id: clientId };
  await changeMemberPayments(req, body.memberId, body.memberVersion, (payments) => {
    if (payments.some((existing) => existing?.id === clientId)) throw Object.assign(new Error('Conflict'), { status: 409 });
    return { payments: [...payments, { amount: payment.amount, date: payment.date, description: payment.description, id: clientId, ...(payment.receipt ? { receipt: payment.receipt } : {}) }] };
  });
  res.status(201).json(await paymentAnswer(body.memberId, clientId));
}));

async function paymentRow(id) {
  const row = typeof id === 'string' && id ? await client.getRecord(finance.COLLECTIONS.PAYMENTS, id, context.appConfig) : null;
  if (!row) throw notFound('Payment');
  return row;
}

router.patch(`${BASE}/payments/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const row = await paymentRow(req.params.id);
  const body = req.body || {};
  let clientId = null;
  await changeMemberPayments(req, row.member, body.memberVersion, (payments, byRecordId) => {
    const current = byRecordId.get(row.id);
    const index = indexOfPayment(payments, current);
    if (index < 0) throw notFound('Payment');
    payments[index] = paymentInput(body, payments[index]);
    clientId = current.id;
    return { payments };
  });
  res.json(clientId === null ? null : await paymentAnswer(row.member, clientId));
}));

router.delete(`${BASE}/payments/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const row = await paymentRow(req.params.id);
  await changeMemberPayments(req, row.member, req.query.memberVersion || req.body?.memberVersion, (payments, byRecordId) => {
    const index = indexOfPayment(payments, byRecordId.get(row.id));
    if (index < 0) throw notFound('Payment');
    return { payments: payments.filter((payment, position) => position !== index) };
  });
  res.status(204).end();
}));

// Donations and expenses: lists saved as a whole (as v1 does), based on the list's version
const LISTS = {
  donations: {
    rows: async () => (await client.listAllRecords(finance.COLLECTIONS.DONATIONS, '', context.appConfig)).sort((a, b) => (a.position || 0) - (b.position || 0)),
    values: async () => {
      const value = await finance.getDonationsValue(context.appConfig);
      return Array.isArray(value) ? value : Object.values(value || {});
    },
    version: () => finance.donationsVersion(context.appConfig),
    save: (list, version) => finance.saveDonations(context.appConfig, list, { expectedVersion: version }),
    toV2: (row) => ({ id: row.id, amountCents: row.amountCents, date: row.date || null, donorName: row.donorName || '', description: row.description || '' }),
    fromV2: (body, current = {}) => {
      const next = paymentInput(body, current);
      if (body.donorName !== undefined) next.name = String(body.donorName).slice(0, 200);
      return next;
    },
    fresh: () => ({ amount: 0, name: '', date: '', description: '' })
  },
  expenses: {
    rows: () => client.listAllRecords(finance.COLLECTIONS.EXPENSES, '', context.appConfig),
    values: async () => (await finance.listExpenseRecords(context.appConfig)).map((record) => record.data),
    version: () => finance.expensesVersion(context.appConfig),
    save: (list, version) => finance.syncExpenseRecords(context.appConfig, list, { expectedVersion: version }),
    toV2: (row) => ({ id: row.id, amountCents: row.amountCents, date: row.date || null, issuer: row.issuer || '', description: row.description || '', receipt: row.receipt || null }),
    fromV2: (body, current = {}) => {
      const next = paymentInput(body, current);
      if (body.issuer !== undefined) next.issuer = String(body.issuer).slice(0, 200);
      return next;
    },
    fresh: () => ({ amount: 0, description: '', issuer: '', date: '' })
  }
};

for (const [name, list] of Object.entries(LISTS)) {
  router.get(`${BASE}/${name}`, verifyToken, handle(async (req, res) => {
    needs(canView(req));
    const [rows, version] = await Promise.all([list.rows(), list.version()]);
    res.json({ ...page(rows.map(list.toV2), req, (item) => item.date), listVersion: version });
  }));

  // The rows and the list as the apps see it belong together by position (both in the order the list is kept)
  const change = async (req, edit) => {
    needs(canManage(req));
    const version = req.body?.listVersion || req.query.listVersion;
    if (typeof version !== 'string' || !version) throw invalid('listVersion is needed: the version of the list the change is based on.');
    const [rows, values, current] = await Promise.all([list.rows(), list.values(), list.version()]);
    if (version !== current) throw Object.assign(new Error('Conflict'), { status: 409 });
    const result = edit(rows, values);
    await list.save(result.values, version);
    broadcastDataUpdate();
    return result;
  };

  router.post(`${BASE}/${name}`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
    const body = req.body || {};
    if (body.amountCents === undefined || body.date === undefined) throw invalid('amountCents and date are needed.');
    const clientId = body.requestId ? `req_${String(body.requestId)}` : crypto.randomUUID();
    await change(req, (rows, values) => {
      if (values.some((value) => value?.id === clientId)) throw Object.assign(new Error('Conflict'), { status: 409 });
      return { values: [...values, { ...list.fromV2(body, list.fresh()), id: clientId }] };
    });
    const created = (await list.rows()).find((row) => row.clientId === clientId);
    res.status(201).json({ ...list.toV2(created), listVersion: await list.version() });
  }));

  router.patch(`${BASE}/${name}/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
    await change(req, (rows, values) => {
      const index = rows.findIndex((row) => row.id === req.params.id);
      if (index < 0 || !values[index]) throw notFound('Entry');
      const next = [...values];
      next[index] = list.fromV2(req.body || {}, values[index]);
      return { values: next };
    });
    const updated = (await list.rows()).find((row) => row.id === req.params.id);
    res.json(updated ? { ...list.toV2(updated), listVersion: await list.version() } : null);
  }));

  router.delete(`${BASE}/${name}/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
    await change(req, (rows, values) => {
      const index = rows.findIndex((row) => row.id === req.params.id);
      if (index < 0) throw notFound('Entry');
      return { values: values.filter((value, position) => position !== index) };
    });
    res.status(204).end();
  }));
}

// Requests: members ask, those who manage the finances decide (the booking is a payment or expense of its own, with
// requestId - as the web app does it)
const requestOf = (record) => ({
  id: record.requestKey,
  type: record.type || null,
  status: record.status || null,
  userId: record.userId || null,
  memberKey: record.personId || null,
  personName: record.personName || '',
  amountCents: record.data?.data?.amount !== undefined ? cents(record.data.data.amount) : null,
  details: record.data?.data ?? null,
  createdAt: isoFromMillis(record.timestamp),
  decidedAt: isoFromMillis(record.data?.decidedAt),
  rejectionReason: record.data?.rejectionReason || null
});

router.get(`${BASE}/requests`, verifyToken, handle(async (req, res) => {
  const records = await finance.listRequestRecords(context.appConfig);
  const uid = uidOf(req);
  const visible = canView(req) ? records : records.filter((record) => record.userId === uid || record.personId === uid);
  res.json(page(visible.map(requestOf), req, (request) => request.createdAt));
}));

router.post(`${BASE}/requests`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = req.body || {};
  const id = crypto.randomUUID();
  const value = { id, type: body.type, userId: uidOf(req), personId: body.memberKey || uidOf(req), personName: req.user.name || '', data: body.details || {}, status: 'pending', timestamp: Date.now() };
  await writeLogicalPath(`requests/${id}`, value, req.user, 'set', {});
  broadcastDataUpdate();
  res.status(201).json(requestOf(await finance.getRequestRecord(context.appConfig, id)));
}));

router.post(`${BASE}/requests/:id/decision`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const status = req.body?.status;
  if (!['approved', 'rejected'].includes(status)) throw invalid('status is approved or rejected.');
  const current = await finance.getRequestRecord(context.appConfig, req.params.id);
  if (!current) throw notFound('Request');
  if (current.status !== 'pending') throw Object.assign(new Error('Conflict'), { status: 409 });
  await writeLogicalPath(`requests/${req.params.id}`, { status, ...(status === 'rejected' ? { rejectionReason: String(req.body?.rejectionReason || '').slice(0, 500) || 'Kein Grund angegeben' } : {}) }, req.user, 'patch', {});
  broadcastDataUpdate();
  res.json(requestOf(await finance.getRequestRecord(context.appConfig, req.params.id)));
}));

router.get(`${BASE}/finance/summary`, verifyToken, handle(async (req, res) => {
  needs(canView(req));
  const months = await client.listAllRecords('finance_monthly_totals', '', context.appConfig, 'month');
  const totals = {};
  for (const row of months) totals[row.kind] = (totals[row.kind] || 0) + row.totalCents;
  res.json({
    totalsCents: { memberPayments: totals.memberPayment || 0, donations: totals.donation || 0, expenses: totals.expense || 0 },
    months: months.map((row) => ({ month: row.month, kind: row.kind, totalCents: row.totalCents, entries: row.entries }))
  });
}));

router.get(`${BASE}/finance/changes`, verifyToken, handle(async (req, res) => {
  needs(canView(req) || req.user.admin === true);
  const filters = [];
  if (req.query.area) filters.push(client.pbFilterEquals('area', String(req.query.area)));
  if (req.query.member) filters.push(client.pbFilterEquals('member', String(req.query.member)));
  const rows = await client.listAllRecords(finance.COLLECTIONS.CHANGES, filters.join(' && '), context.appConfig);
  res.json(page(rows.map((row) => ({ id: row.id, area: row.area, action: row.action, at: isoOf(row.at), by: row.by || null, byName: row.byName || '', memberId: row.member || null, target: row.target || null, details: row.details ?? null })), req, (change) => change.at));
}));

router.get(`${BASE}/fees`, verifyToken, handle(async (req, res) => {
  const [changes, starts] = await Promise.all([
    client.listAllRecords(finance.COLLECTIONS.FEE_CHANGES, '', context.appConfig, 'fromMonth'),
    client.listAllRecords(finance.COLLECTIONS.FRESH_STARTS, '', context.appConfig, 'day')
  ]);
  res.json({
    feeChanges: changes.map((row) => ({ fromMonth: row.fromMonth, feesCents: row.feesCents || {}, setAt: isoOf(row.setAt), setByName: row.setByName || '' })),
    freshStarts: starts.map((row) => ({ day: row.day, feesBeforeCents: row.feesBeforeCents || null }))
  });
}));

// --- Everyone: who am I, groups, events, community, mentoring ------------------------------------------------------

router.get(`${BASE}/me`, verifyToken, handle(async (req, res) => {
  const groups = await listGroupRecords(context.appConfig).catch(() => []);
  const mine = new Set(req.user.groups || []);
  res.json({
    id: uidOf(req),
    email: req.user.email || '',
    firstName: req.user.firstName || '',
    lastName: req.user.lastName || '',
    name: req.user.name || '',
    isAdmin: req.user.admin === true,
    isOwner: req.user.owner === true,
    permissions: req.user.permissions || [],
    groups: groups.filter((group) => mine.has(group.id) || mine.has(group.name)).map((group) => ({ id: group.id, name: group.name })),
    language: req.user.language || null,
    timeZone: req.user.timeZone || null
  });
}));

router.get(`${BASE}/groups`, verifyToken, handle(async (req, res) => {
  res.json({ items: (await listGroupRecords(context.appConfig)).map((group) => ({ id: group.id, name: group.name, permissions: group.permissions })) });
}));

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

async function visibleEvents(req) {
  const uid = uidOf(req);
  const filters = [];
  if (DAY.test(String(req.query.from || ''))) filters.push(`(date >= ${JSON.stringify(req.query.from)} || endDate >= ${JSON.stringify(req.query.from)})`);
  if (DAY.test(String(req.query.to || ''))) filters.push(`date <= ${JSON.stringify(req.query.to)}`);
  const events = await eventsStore.listEvents(context.appConfig, filters.join(' && '));
  return events.filter((event) => event.createdBy === uid || userMatchesTargetGroups(req.user, event.targetGroups));
}

router.get(`${BASE}/events`, verifyToken, handle(async (req, res) => {
  const uid = uidOf(req);
  const [events, registrations, guests] = await Promise.all([visibleEvents(req), eventsStore.listEventRegistrations(context.appConfig), eventsStore.listEventGuests(context.appConfig)]);
  const items = events.map((event) => {
    const regs = registrations.filter((reg) => reg.event === event.id);
    const mine = regs.find((reg) => reg.user === uid && reg.status !== 'cancelled');
    return eventOf(event, seatCounts(regs, guests.filter((guest) => guest.event === event.id)), mine);
  });
  // In the order they take place
  res.json(page(items, req, (event) => `${event.date} ${event.startTime || ''}`, { ascending: true }));
}));

router.get(`${BASE}/events/:id`, verifyToken, handle(async (req, res) => {
  const uid = uidOf(req);
  const event = await eventsStore.getEventRecord(context.appConfig, req.params.id);
  if (!event || !(event.createdBy === uid || userMatchesTargetGroups(req.user, event.targetGroups))) throw notFound('Event');
  const is = client.pbFilterEquals('event', event.id);
  const [registrations, guests, duties, groups] = await Promise.all([
    eventsStore.listEventRegistrations(context.appConfig, is), eventsStore.listEventGuests(context.appConfig, is), eventsStore.listEventDuties(context.appConfig, is),
    listGroupRecords(context.appConfig).catch(() => [])
  ]);
  const mine = registrations.find((reg) => reg.user === uid && reg.status !== 'cancelled');
  const seesPlan = canUserAccessEventDutyPlan(req.user, event, duties, new Map(groups.map((group) => [group.id, group.name])));
  const program = seesPlan ? await eventsStore.programStore.get(context.appConfig, event.id) : null;
  res.json({
    ...eventOf(event, seatCounts(registrations, guests), mine),
    duties: seesPlan ? duties.map((duty) => ({ id: duty.id, section: duty.section || '', roleName: duty.roleName, assignedGroupId: duty.assignedGroup || null, assignedUserId: duty.assignedUser || null, requestedUserId: duty.requestedUser || null, status: duty.status || 'open', notes: duty.notes || '' })) : null,
    program: seesPlan && program ? { items: program.items || [], updatedAt: isoFromMillis(program.updatedAt) } : null
  });
}));

router.get(`${BASE}/songs`, verifyToken, handle(async (req, res) => {
  const songs = await createItemStore('songs').list(context.appConfig);
  res.json(page(songs.filter((song) => song && !Array.isArray(song)).map((song) => ({
    id: song.id, title: song.title || '', artist: song.artist || '', key: song.key || null, capo: song.capo ?? null, tempo: song.tempo ?? null,
    ccli: song.ccli || null, copyright: song.copyright || '', content: song.content || '', createdAt: isoFromMillis(song.createdAt), updatedAt: isoFromMillis(song.updatedAt)
  })), req, (song) => song.title.toLowerCase()));
}));

router.get(`${BASE}/mentoring/mentors`, verifyToken, handle(async (req, res) => {
  const [mentors, users] = await Promise.all([listMentorRecords(context.appConfig, 'status = "approved"'), listUserRecords(context.appConfig)]);
  const names = new Map(users.map((user) => [user.id, user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim()]));
  res.json({ items: mentors.map((mentor) => ({ id: mentor.id, userId: mentor.user, name: names.get(mentor.user) || '', bio: mentor.bio || '', maxMentees: mentor.max_mentees || 0, isAccepting: mentor.is_accepting === true })) });
}));

/** The reader's conversations: the mentee stays anonymous to the mentor (alias), as in v1. */
router.get(`${BASE}/mentoring/threads`, verifyToken, handle(async (req, res) => {
  const uid = uidOf(req);
  const threads = await listMentoringThreadsForUser(context.appConfig, uid);
  res.json({ items: threads.map((thread) => ({
    id: thread.id, role: thread.mentor === uid ? 'mentor' : 'mentee', mentorUserId: thread.mentor, menteeAlias: thread.mentee_alias,
    status: thread.status, lastMessage: thread.last_message || '', updatedAt: thread.updated || null
  })) });
}));

router.get(`${BASE}/mentoring/threads/:id/messages`, verifyToken, handle(async (req, res) => {
  const uid = uidOf(req);
  const thread = (await listMentoringThreadsForUser(context.appConfig, uid)).find((candidate) => candidate.id === req.params.id);
  if (!thread) throw notFound('Conversation');
  // Reading here marks nothing as read (v1 does that when the app opens the conversation)
  const messages = await listMentoringMessages(context.appConfig, thread.id);
  res.json({ items: messages.map((message) => ({ id: message.id, from: message.sender_role, text: message.text, isRead: message.read === true, createdAt: message.created || null })) });
}));

router.get(BASE, verifyToken, (req, res) => {
  res.json({
    apiVersion: 2,
    documentation: 'docs/API_V2.md in the repository',
    resources: ['me', 'groups', 'members', 'payments', 'donations', 'expenses', 'requests', 'fees', 'finance/summary', 'finance/changes', 'events', 'songs', 'mentoring/mentors', 'mentoring/threads']
  });
});

// Anything else under /api/v2: an error in the shape of v2
router.all(`${BASE}/*`, (req, res) => fail(res, 404, 'There is no such resource in API v2.'));

module.exports = router;
