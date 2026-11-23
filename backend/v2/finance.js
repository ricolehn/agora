// API v2: the books (docs/API_V2.md) - the members with their fee accounts, payments, standing orders, status changes,
// donations, expenses, receipts, requests, all bookings in one list, the money as the statistics count it, the change
// log, the fees over time and the fresh starts.
//
// Reads come from the new tables' columns. Writes of the books go through the same functions as v1 and book by the
// web app's rules (bookings.js): the balances, the change log and the checks for conflicting changes work exactly
// alike. A write names the version it is based on (memberVersion for what belongs to a member - payments, standing
// orders, its status -, listVersion for donations and expenses) and is refused with 409 when the data changed
// meanwhile. The fees and the fresh starts run v1's own handlers: the same checks, confirmations and logs.
const express = require('express');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { context } = require('../context');
const { verifyToken } = require('../auth');
const { protectedActionRateLimit } = require('../rateLimits');
const { broadcastDataUpdate } = require('../liveUpdates');
const { writeLogicalPath, isOwnFullNameMatch } = require('../dataPaths');
const { NO_REASON_GIVEN, rejectionReasonText } = require('../requestMessages');
const { listUserRecords, getUserRecord } = require('../pocketbase');
const { isAdmin, can } = require('../permissions');
const client = require('../db/client');
const finance = require('../db/stores/finance');
const { fromCents, toCents } = require('../db/codec');
const { REQUEST_TYPES, CHANGE_AREAS, INCOME_STATUSES } = require('../db/schema/finance');
const { checkAndExecuteStandingOrders } = require('../standingOrders');
const bookings = require('../bookings');
const { translate, requestLanguage } = require('../i18n');
const { toDateStr } = require('../utils/date');
const financeRouter = require('../routes/finance');
const data = require('../v2Data');
const {
  CHANGED, invalid, notFound, conflict, needs, handle, ID, TEXT_LIMITS,
  bodyOf, isCalendarDay, dayInput, optionalDayInput, monthInput, centsInput, boolInput, textInput, receiptNames, receiptFieldInput, idInput,
  versionInput, requestIdInput, choiceInput, daysOf, idOfQuery, sortable, searchOf, dayTexts, amountTexts, matchesSearch,
  limitOf, storedCursorOf, storedPage, page, v1Route, runV1, runSteps
} = require('./http');
const { fullName } = require('../utils/names');

const { cents, isoFromMillis, memberOf, paymentOf, statusPeriodOf, standingOrderOf } = data;

const router = express.Router();
const BASE = '/api/v2';

const canView = (req) => can(req.user, 'view_finances');
const canManage = (req) => can(req.user, 'manage_finances');
// Who set the fees and fresh starts, and their logs: for those who see the finances or run the instance (as in v1)
const isFeeInsider = (req) => isAdmin(req.user) || canView(req);

const NEEDS_MEMBER_VERSION = '{name} is needed: the version of the member the change is based on.';
const NEEDS_LIST_VERSION = '{name} is needed: the version of the list the change is based on.';

// --- Members ------------------------------------------------------------------------------------------------------

async function memberRow(id) {
  const row = typeof id === 'string' && ID.test(id) ? await client.getRecord(finance.COLLECTIONS.MEMBERS, id, context.appConfig) : null;
  if (!row || finance.isOrphan(row)) throw notFound('There is no such member.');
  return row;
}

/** One member as /members/:id answers it: with its payments, status periods and standing orders. */
async function memberAnswer(id) {
  const member = await finance.memberReadOnly(context.appConfig, id);
  if (!member) throw notFound('There is no such member.');
  const { row, person, payments, periods, orders } = member;
  return {
    row,
    person,
    answer: {
      ...memberOf(row, person, payments),
      payments: payments.map((payment) => paymentOf(payment, row.updated)).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      statusPeriods: periods.map(statusPeriodOf),
      standingOrders: [...orders].sort((a, b) => (a.position || 0) - (b.position || 0)).map(standingOrderOf)
    }
  };
}

/**
 * True when the person of [req] may claim the member record [row] ([person]: its record as the old API knows it): a
 * record no account is linked to that bears their full name - theirs to link to their account, as in v1.
 */
const isClaimable = (req, row, person) => !row.user && !person?.uid && !person?.data?.uid && row.isDeleted !== true && isOwnFullNameMatch(req.user, row.name);

/** The members [req]'s person may see: all with finance rights; else their own and the ones they may claim (as v1). */
async function membersShownTo(req) {
  if (canView(req)) return data.membersFor(req.user);
  const uid = req.user.uid;
  return (await finance.membersReadOnly(context.appConfig)).filter(({ row, person }) => row.user === uid || isClaimable(req, row, person));
}

// In the order of their names (A to Z); ?q= finds them by name
router.get(`${BASE}/members`, verifyToken, handle(async (req, res) => {
  const words = searchOf(req);
  const members = (await membersShownTo(req)).map(({ row, person, payments }) => memberOf(row, person, payments));
  const shown = members.filter((member) => (req.query.includeDeleted === '1' || !member.isDeleted) && matchesSearch(words, [member.name]));
  res.json(page(shown, req, (member) => sortable(member.name), { ascending: true }));
}));

// One member: from the books' memo where it is up to date (stores/finance.js), its rows are read only here
router.get(`${BASE}/members/:id`, verifyToken, handle(async (req, res) => {
  const { row, answer, person } = await memberAnswer(req.params.id);
  needs(canView(req) || row.user === req.user.uid || isClaimable(req, row, person));
  res.json(answer);
}));

// Links an account to a member record: those who manage the finances any account (an account without a record of
// its own); a member their own account to the record that bears their name - as v1 links them
router.put(`${BASE}/members/:id/account`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const userId = idInput(bodyOf(req).userId, 'userId');
  const row = await memberRow(req.params.id);
  if (!(await getUserRecord(context.appConfig, userId).catch(() => null))) throw notFound('There is no such account.');
  await writeLogicalPath(`people/${finance.keyOfMember(row)}`, { uid: userId }, req.user, 'patch', {});
  broadcastDataUpdate();
  res.json((await memberAnswer(row.id)).answer);
}));

// The accounts and the member record each is linked to (memberId; null: none - ?unlinked=1 lists only those), by name -
// for administrators, who alone see every account in v1 too
router.get(`${BASE}/accounts`, verifyToken, handle(async (req, res) => {
  needs(isAdmin(req.user), 'Admin access required');
  const [users, members] = await Promise.all([listUserRecords(context.appConfig), finance.membersReadOnly(context.appConfig)]);
  const memberOfUser = new Map();
  for (const { row } of members) if (row.user && !row.isDeleted && !memberOfUser.has(row.user)) memberOfUser.set(row.user, row.id);
  const words = searchOf(req);
  const items = users.map((user) => ({ id: user.id, name: fullName(user), email: user.email || '', memberId: memberOfUser.get(user.id) || null }))
    .filter((account) => (req.query.unlinked !== '1' || !account.memberId) && matchesSearch(words, [account.name, account.email]));
  res.json(page(items, req, (account) => sortable(account.name), { ascending: true }));
}));

/**
 * Changes the books of the member [memberId] based on its version [memberVersion]: [change](value, byRecordId) gets
 * the member as the apps write it (value, its payments as a list of their own) and the entries of its payments by
 * their record ids, and returns the member as it should be - written through the member, as v1 does.
 */
async function changeMember(req, memberId, memberVersion, change) {
  needs(canManage(req));
  versionInput(memberVersion, 'memberVersion', NEEDS_MEMBER_VERSION);
  const row = await memberRow(memberId);
  if (row.updated !== memberVersion) throw conflict(CHANGED);
  const personKey = finance.keyOfMember(row);
  const person = await finance.getPeopleRecord(context.appConfig, personKey);
  // The payments as a list to change; the status history and the standing orders as they are kept (a change that
  // touches them makes them a list - one that does not leaves them as an older app wrote them)
  const value = { ...person.data, payments: listOf(person.data.payments) };
  // The old records of the member's payments know their record ids; their data are the very objects of the list
  const byRecordId = new Map((person._childPayments || []).map((old) => [old.id, old.data]));
  const next = change(value, byRecordId);
  const saved = await finance.upsertPeopleRecord(context.appConfig, personKey, next, memberVersion);
  broadcastDataUpdate();
  return { row, saved };
}

/** A list as the apps keep one: a list, or the values of a map older apps kept. */
const listOf = (value) => (Array.isArray(value) ? [...value] : value && typeof value === 'object' ? Object.values(value) : []);

// --- Payments -----------------------------------------------------------------------------------------------------

/** The names of the members [req] may see, by member id. */
async function memberNames(req) {
  return new Map((await data.membersFor(req.user)).map(({ row }) => [row.id, row.name || '']));
}

router.get(`${BASE}/payments`, verifyToken, handle(async (req, res) => {
  const { from, to } = daysOf(req);
  const words = searchOf(req);
  const member = idOfQuery(req, 'member');
  const [payments, names] = await Promise.all([data.paymentsFor(req.user, { member, from, to }), words ? memberNames(req) : null]);
  const found = words ? payments.filter((payment) => matchesSearch(words, [names.get(payment.memberId), payment.description, ...dayTexts(payment.date), ...amountTexts(payment.amountCents)])) : payments;
  res.json(page(found, req, (payment) => payment.date));
}));

/** Where the payment [current] (an object of the member's list) is in [payments]: the same object, or one just like it. */
function indexOfPayment(payments, current) {
  if (!current) return -1;
  const same = payments.indexOf(current);
  return same >= 0 ? same : payments.findIndex((payment) => isDeepStrictEqual(payment, current));
}

/** [current] (an entry as the apps keep it) with what [body] changes - every value checked first. */
function paymentInput(body, current = {}) {
  const next = { ...current };
  if (body.amountCents !== undefined) next.amount = fromCents(centsInput(body.amountCents));
  if (body.date !== undefined) next.date = dayInput(body.date, 'date');
  if (body.description !== undefined) next.description = textInput(body, 'description');
  const receipt = receiptFieldInput(body);
  if (receipt !== undefined) {
    if (!receipt) delete next.receipt;
    else next.receipt = receipt;
  }
  return next;
}

async function paymentAnswer(memberId, clientId) {
  const row = await memberRow(memberId);
  const rows = await client.listAllRecords(finance.COLLECTIONS.PAYMENTS, client.pbFilterEquals('member', memberId), context.appConfig);
  const payment = rows.find((candidate) => JSON.stringify(candidate.clientId) === JSON.stringify(clientId));
  return payment ? paymentOf(payment, row.updated) : null;
}

/** The payment booked with the id [clientId], for whichever member - null when there is none. */
async function bookedPayment(clientId) {
  for (const { row, payments } of await finance.membersReadOnly(context.appConfig)) {
    const payment = payments.find((candidate) => candidate.clientId === clientId);
    if (payment) return paymentOf(payment, row.updated);
  }
  return null;
}

router.post(`${BASE}/payments`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  needs(canManage(req));
  const body = bodyOf(req);
  const memberId = idInput(body.memberId, 'memberId');
  if (body.amountCents === undefined || body.date === undefined) throw invalid('amountCents and date are needed.');
  const requestId = requestIdInput(body.requestId);
  const payment = paymentInput(body, { description: '' });
  const clientId = requestId ? bookings.bookingId({ id: requestId }) : crypto.randomUUID();
  if (requestId) {
    // Booked already (sent again after an answer that got lost): that booking, once more - no second one. With
    // another member, amount or day it is no repetition, and refused
    const booked = await bookedPayment(clientId);
    if (booked) {
      if (booked.memberId !== memberId || booked.amountCents !== body.amountCents || booked.date !== body.date) throw conflict('This request is booked already, with another member, amount or day.');
      res.status(200).json(await paymentAnswer(memberId, clientId));
      return;
    }
  }
  await changeMember(req, memberId, body.memberVersion, (value) => {
    // Booked meanwhile by the same request sent at the same moment: sent again, it finds that booking
    if (value.payments.some((existing) => existing?.id === clientId)) throw conflict('This request was booked meanwhile: send it again to get the booking.');
    return { ...value, payments: [...value.payments, { amount: payment.amount, date: payment.date, description: payment.description, id: clientId, ...(payment.receipt ? { receipt: payment.receipt } : {}) }] };
  });
  res.status(201).json(await paymentAnswer(memberId, clientId));
}));

async function recordOf(collection, id, missing) {
  const row = typeof id === 'string' && ID.test(id) ? await client.getRecord(collection, id, context.appConfig) : null;
  if (!row) throw notFound(missing);
  return row;
}

const hasClientId = (entry) => entry?.id !== undefined && entry?.id !== null && entry?.id !== '';

router.patch(`${BASE}/payments/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  needs(canManage(req));
  const body = bodyOf(req);
  paymentInput(body);
  const row = await recordOf(finance.COLLECTIONS.PAYMENTS, req.params.id, 'There is no such payment.');
  let clientId = null;
  await changeMember(req, row.member, body.memberVersion, (value, byRecordId) => {
    const current = byRecordId.get(row.id);
    const index = indexOfPayment(value.payments, current);
    if (index < 0) throw notFound('There is no such payment.');
    // An entry of an older app without an id of its own gets one: the answer finds it, and so does every change after
    clientId = hasClientId(current) ? current.id : crypto.randomUUID();
    value.payments[index] = { ...paymentInput(body, value.payments[index]), id: clientId };
    return value;
  });
  const changed = await paymentAnswer(row.member, clientId);
  if (!changed) throw conflict(CHANGED);
  res.json(changed);
}));

router.delete(`${BASE}/payments/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  needs(canManage(req));
  const row = await recordOf(finance.COLLECTIONS.PAYMENTS, req.params.id, 'There is no such payment.');
  await changeMember(req, row.member, req.query.memberVersion || req.body?.memberVersion, (value, byRecordId) => {
    const index = indexOfPayment(value.payments, byRecordId.get(row.id));
    if (index < 0) throw notFound('There is no such payment.');
    return { ...value, payments: value.payments.filter((payment, position) => position !== index) };
  });
  res.status(204).end();
}));

// --- Standing orders: part of their member's books, as payments are ---------------------------------------------

const standingOrderAnswer = (order, row) => ({ ...standingOrderOf(order), memberId: row.id, memberVersion: row.updated });

router.get(`${BASE}/standing-orders`, verifyToken, handle(async (req, res) => {
  const member = idOfQuery(req, 'member');
  const items = [];
  for (const { row, orders } of await data.membersFor(req.user)) {
    if (member && row.id !== member) continue;
    for (const order of orders) items.push(standingOrderAnswer(order, row));
  }
  res.json(page(items, req, (order) => order.startDate));
}));

/** The standing order [body] describes (on top of [current], as the apps keep one) - every value checked first. */
function standingOrderInput(body, current = {}) {
  const next = { ...current };
  if (body.amountCents !== undefined) next.amount = fromCents(centsInput(body.amountCents));
  if (body.startDate !== undefined) next.startDate = dayInput(body.startDate, 'startDate');
  if (body.note !== undefined) next.note = textInput(body, 'note');
  if (body.endDate !== undefined) {
    const endDate = optionalDayInput(body.endDate, 'endDate');
    if (endDate) next.endDate = endDate;
    else delete next.endDate;
  }
  if (next.endDate && next.startDate && next.endDate < next.startDate) throw invalid('endDate must not be before startDate.', null, 'endDate');
  return next;
}

/** The standing order with the record id [id] and its member's row. */
async function standingOrderRecord(id) {
  const row = await recordOf(finance.COLLECTIONS.STANDING_ORDERS, id, 'There is no such standing order.');
  return { row, member: await memberRow(row.member) };
}

/** The standing order of [member] whose id the apps gave it is [clientId], as v2 answers it (null: none). */
async function standingOrderAnswerOf(memberId, clientId) {
  const member = await finance.memberReadOnly(context.appConfig, memberId);
  const order = member?.orders.find((candidate) => JSON.stringify(candidate.clientId) === JSON.stringify(clientId));
  return order ? standingOrderAnswer(order, member.row) : null;
}

/** The standing order booked for the request with the booking id [clientId], for whichever member (null: none). */
async function bookedStandingOrder(clientId) {
  for (const { row, orders } of await finance.membersReadOnly(context.appConfig)) {
    const order = orders.find((candidate) => candidate.clientId === clientId);
    if (order) return standingOrderAnswer(order, row);
  }
  return null;
}

// What a standing order owes up to today is booked at once - as the web app and the server's daily run book it - and
// one whose end has passed goes (its payments stay)
const withDueBookings = (value) => checkAndExecuteStandingOrders(value) || value;

router.post(`${BASE}/standing-orders`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  needs(canManage(req));
  const body = bodyOf(req);
  const memberId = idInput(body.memberId, 'memberId');
  if (body.amountCents === undefined || body.startDate === undefined) throw invalid('amountCents and startDate are needed.');
  const order = standingOrderInput(body, { note: '' });
  if (order.endDate && order.endDate < toDateStr(new Date())) throw invalid('endDate must not be before today: book the payments of a standing order that has ended.', null, 'endDate');
  const requestId = requestIdInput(body.requestId);
  const clientId = requestId ? bookings.bookingId({ id: requestId }) : crypto.randomUUID();
  if (requestId) {
    const booked = await bookedStandingOrder(clientId);
    if (booked) {
      if (booked.memberId !== memberId || booked.amountCents !== body.amountCents || booked.startDate !== body.startDate) throw conflict('This request is booked already, with another member, amount or day.');
      res.status(200).json(booked);
      return;
    }
  }
  await changeMember(req, memberId, body.memberVersion, (value) => {
    const orders = listOf(value.standingOrders);
    if (orders.some((existing) => existing?.id === clientId)) throw conflict('This request was booked meanwhile: send it again to get the booking.');
    const entry = { id: clientId, amount: order.amount, startDate: order.startDate, note: order.note, lastAutoPayment: null, ...(order.endDate ? { endDate: order.endDate } : {}) };
    return withDueBookings({ ...value, standingOrders: [...orders, entry] });
  });
  const created = await standingOrderAnswerOf(memberId, clientId);
  if (!created) throw conflict(CHANGED);
  res.status(201).json(created);
}));

/** Where the standing order [row] is in the member's list: by the id the apps gave it, else by its place. */
function indexOfStandingOrder(orders, row) {
  if (row.clientId !== null && row.clientId !== undefined && row.clientId !== '') return orders.findIndex((order) => JSON.stringify(order?.id) === JSON.stringify(row.clientId));
  return Number.isInteger(row.position) && orders[row.position] && !hasClientId(orders[row.position]) ? row.position : -1;
}

router.patch(`${BASE}/standing-orders/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  needs(canManage(req));
  const body = bodyOf(req);
  standingOrderInput(body);
  const { row } = await standingOrderRecord(req.params.id);
  let clientId = null;
  await changeMember(req, row.member, body.memberVersion, (value) => {
    value.standingOrders = listOf(value.standingOrders);
    const index = indexOfStandingOrder(value.standingOrders, row);
    if (index < 0) throw notFound('There is no such standing order.');
    const current = value.standingOrders[index];
    clientId = hasClientId(current) ? current.id : crypto.randomUUID();
    const next = { ...standingOrderInput(body, current), id: clientId };
    value.standingOrders[index] = next;
    // Ended: what it booked after its last day goes, as the web app ends a standing order
    if (body.endDate !== undefined && next.endDate) {
      const autoPrefix = `auto_${current.id}_`;
      value.payments = value.payments.filter((payment) => !(payment?.isAuto === true && String(payment.id || '').startsWith(autoPrefix) && String(payment.date || '') > next.endDate));
    }
    return value;
  });
  const changed = await standingOrderAnswerOf(row.member, clientId);
  if (!changed) throw conflict(CHANGED);
  res.json(changed);
}));

router.delete(`${BASE}/standing-orders/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  needs(canManage(req));
  const { row } = await standingOrderRecord(req.params.id);
  // Its payments stay in the books, as when the web app removes a standing order
  await changeMember(req, row.member, req.query.memberVersion || req.body?.memberVersion, (value) => {
    const orders = listOf(value.standingOrders);
    const index = indexOfStandingOrder(orders, row);
    if (index < 0) throw notFound('There is no such standing order.');
    return { ...value, standingOrders: orders.filter((order, position) => position !== index) };
  });
  res.status(204).end();
}));

// --- Status changes: from a day on, as the web app changes a member's income status ------------------------------

router.post(`${BASE}/status-changes`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  needs(canManage(req));
  const body = bodyOf(req);
  const memberId = idInput(body.memberId, 'memberId');
  const status = choiceInput(body.status, 'status', INCOME_STATUSES);
  const date = dayInput(body.date, 'date');
  await changeMember(req, memberId, body.memberVersion, (value) => {
    try {
      return bookings.applyStatusChangeToHistory(value, status, date);
    } catch (err) {
      throw invalid(err.message, null, 'date');
    }
  });
  res.json((await memberAnswer(memberId)).answer);
}));

// --- Donations and expenses: lists of records, each change based on the list's version ---------------------------

const LISTS = {
  donations: {
    ...data.LIST_READS.donations,
    entryOf: (row) => finance.decodeDonation(row),
    save: (entries, rowIds, version) => finance.saveDonations(context.appConfig, entries, { expectedVersion: version, rowIds }),
    fromV2: (body, current = {}) => {
      const next = paymentInput(body, current);
      if (body.donorName !== undefined) next.name = textInput(body, 'donorName');
      return next;
    },
    texts: (item) => [item.donorName, item.description],
    fresh: () => ({ amount: 0, name: '', date: '', description: '' })
  },
  expenses: {
    ...data.LIST_READS.expenses,
    entryOf: (row) => finance.oldExpenseRecord(row).data,
    save: (entries, rowIds, version) => finance.syncExpenseRecords(context.appConfig, entries, { expectedVersion: version, rowIds }),
    fromV2: (body, current = {}) => {
      const next = paymentInput(body, current);
      if (body.issuer !== undefined) next.issuer = textInput(body, 'issuer');
      return next;
    },
    texts: (item) => [item.issuer, item.description],
    fresh: () => ({ amount: 0, description: '', issuer: '', date: '' })
  }
};

for (const [name, list] of Object.entries(LISTS)) {
  router.get(`${BASE}/${name}`, verifyToken, handle(async (req, res) => {
    needs(canView(req));
    const { from, to } = daysOf(req);
    const words = searchOf(req);
    const rows = await list.rows();
    const items = rows.filter(list.shown).map(list.toV2).filter((item) => (from === null || (item.date || '') >= from) && (to === null || (item.date || '') <= to)
      && matchesSearch(words, [...list.texts(item), ...dayTexts(item.date), ...amountTexts(item.amountCents)]));
    res.json({ ...page(items, req, (item) => item.date), listVersion: finance.listVersion(rows) });
  }));

  /**
   * Changes the list based on its version: [edit](items) gets every record with the entry it holds ({ rowId, row,
   * entry }, in the order of the list) and returns the list as it should be - a new entry without rowId. Each entry
   * stays with its record (the store pairs them by rowId): a change never writes another entry anew.
   */
  const change = async (req, edit) => {
    needs(canManage(req));
    const version = versionInput(req.body?.listVersion || req.query.listVersion, 'listVersion', NEEDS_LIST_VERSION);
    const rows = await list.rows();
    if (version !== finance.listVersion(rows)) throw conflict(CHANGED);
    const items = edit(rows.map((row) => ({ rowId: row.id, row, entry: list.entryOf(row) })));
    await list.save(items.map((item) => item.entry), items.map((item) => item.rowId || null), version);
    broadcastDataUpdate();
  };
  const answerOf = async (find) => {
    const rows = await list.rows();
    const row = rows.find(find);
    return row ? { ...list.toV2(row), listVersion: finance.listVersion(rows) } : null;
  };

  router.post(`${BASE}/${name}`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
    needs(canManage(req));
    const body = bodyOf(req);
    if (body.amountCents === undefined || body.date === undefined) throw invalid('amountCents and date are needed.');
    const requestId = requestIdInput(body.requestId);
    const entry = list.fromV2(body, list.fresh());
    const clientId = requestId ? bookings.bookingId({ id: requestId }) : crypto.randomUUID();
    if (requestId) {
      // Booked already: that entry once more (see POST /payments)
      const booked = await answerOf((row) => row.clientId === clientId && list.shown(row));
      if (booked) {
        if (booked.amountCents !== body.amountCents || booked.date !== body.date) throw conflict('This request is booked already, with another amount or day.');
        res.status(200).json(booked);
        return;
      }
    }
    await change(req, (items) => {
      if (items.some((item) => item.entry?.id === clientId)) throw conflict('This request was booked meanwhile: send it again to get the booking.');
      return [...items, { rowId: null, entry: { ...entry, id: clientId } }];
    });
    const created = await answerOf((row) => row.clientId === clientId);
    if (!created) throw conflict(CHANGED);
    res.status(201).json(created);
  }));

  router.patch(`${BASE}/${name}/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
    needs(canManage(req));
    const body = bodyOf(req);
    list.fromV2(body);
    await change(req, (items) => {
      const index = items.findIndex((item) => item.rowId === req.params.id);
      if (index < 0 || !list.shown(items[index].row)) throw notFound('There is no such entry.');
      const current = items[index].entry;
      // An entry of an older app without an id of its own gets one (it keeps its record)
      items[index] = { ...items[index], entry: { ...list.fromV2(body, current), id: hasClientId(current) ? current.id : crypto.randomUUID() } };
      return items;
    });
    const updated = await answerOf((row) => row.id === req.params.id);
    if (!updated) throw conflict(CHANGED);
    res.json(updated);
  }));

  router.delete(`${BASE}/${name}/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
    await change(req, (items) => {
      const index = items.findIndex((item) => item.rowId === req.params.id);
      if (index < 0 || !list.shown(items[index].row)) throw notFound('There is no such entry.');
      return items.filter((item, position) => position !== index);
    });
    res.status(204).end();
  }));
}

// --- All bookings in one list: the history of the books, newest first --------------------------------------------

const LEDGER_KINDS = ['memberPayment', 'donation', 'expense'];

router.get(`${BASE}/finance/ledger`, verifyToken, handle(async (req, res) => {
  needs(canView(req));
  const { from, to } = daysOf(req);
  const words = searchOf(req);
  const kind = req.query.kind === undefined || req.query.kind === '' ? null : choiceInput(req.query.kind, 'kind', LEDGER_KINDS);
  const member = idOfQuery(req, 'member');
  const items = [];
  if (!kind || kind === 'memberPayment') {
    const [payments, names] = await Promise.all([data.paymentsFor(req.user, { member, from, to }), memberNames(req)]);
    for (const payment of payments) {
      items.push({
        kind: 'memberPayment', id: payment.id, amountCents: payment.amountCents, date: payment.date, who: names.get(payment.memberId) || '', memberId: payment.memberId,
        description: payment.description, receipts: payment.receipts, clientId: payment.clientId, source: payment.source
      });
    }
  }
  if (!member) {
    for (const [listName, itemKind] of [['donations', 'donation'], ['expenses', 'expense']]) {
      if (kind && kind !== itemKind) continue;
      const list = LISTS[listName];
      for (const row of (await list.rows()).filter(list.shown)) {
        const item = list.toV2(row);
        if ((from !== null && !((item.date || '') >= from)) || (to !== null && !((item.date || '') <= to))) continue;
        items.push({
          kind: itemKind, id: item.id, amountCents: item.amountCents, date: item.date, who: itemKind === 'donation' ? item.donorName : item.issuer, memberId: null,
          description: item.description, receipts: item.receipts || [], clientId: item.clientId, source: null
        });
      }
    }
  }
  const found = items.filter((item) => matchesSearch(words, [item.who, item.description, ...dayTexts(item.date), ...amountTexts(item.amountCents)]));
  // Newest first; the entries of one day by their kind
  res.json(page(found, req, (item) => `${item.date || ''}|${item.kind}`));
}));

// --- Receipts: the files of payments, expenses and requests -------------------------------------------------------

const uploadRoute = v1Route(financeRouter, 'post', '/api/upload');
const receiptRoute = v1Route(financeRouter, 'get', '/api/receipts/:filename');

// One file (field "receipt", as v1 takes it), answered with the name it is kept under: an entry or a request names it
router.post(`${BASE}/receipts`, verifyToken, (req, res) => {
  const json = res.json.bind(res);
  res.json = (body) => (res.statusCode < 400 && typeof body?.filename === 'string' ? json.call(res.status(201), { name: body.filename }) : json(body));
  runSteps(uploadRoute, req, res);
});

// The file, for those who see the finances - and for whoever uploaded it
router.get(`${BASE}/receipts/:name`, verifyToken, (req, res) => {
  req.params.filename = req.params.name;
  runSteps(receiptRoute, req, res);
});

// --- Requests: members ask, those who manage the finances decide -------------------------------------------------

/** The member ids by what requests name a member with: its key (the apps' id of the member) or its record id. */
async function memberIdsByKey() {
  const ids = new Map();
  for (const { row } of await finance.membersReadOnly(context.appConfig)) {
    ids.set(row.id, row.id);
    ids.set(finance.keyOfMember(row), row.id);
  }
  return ids;
}

const requestOf = (record, memberIds) => ({
  id: record.id,
  type: record.type || null,
  status: record.status || null,
  userId: record.userId || null,
  memberId: memberIds.get(record.personId) || null,
  memberName: record.personName || '',
  amountCents: record.data?.data?.amount !== undefined ? cents(record.data.data.amount) : null,
  details: record.data?.data ?? null,
  receipts: receiptNames(record.data?.data?.receipt),
  createdAt: isoFromMillis(record.timestamp),
  decidedAt: isoFromMillis(record.data?.decidedAt),
  // null: none given (the apps store "Kein Grund angegeben" for it - every app shows its own text)
  rejectionReason: rejectionReasonText(record.data?.rejectionReason) || null
});

router.get(`${BASE}/requests`, verifyToken, handle(async (req, res) => {
  const [records, memberIds] = await Promise.all([finance.listRequestRecords(context.appConfig), memberIdsByKey()]);
  const uid = req.user.uid;
  const words = searchOf(req);
  const status = req.query.status === undefined || req.query.status === '' ? null : choiceInput(req.query.status, 'status', ['pending', 'approved', 'rejected']);
  // Everyone else sees what they asked and what was asked about them (their own member record), as in v1
  const own = canView(req) ? null : new Set((await data.membersFor(req.user)).map(({ row }) => row.id));
  const visible = own ? records.filter((record) => record.userId === uid || record.personId === uid || own.has(memberIds.get(record.personId))) : records;
  const items = visible.map((record) => requestOf(record, memberIds)).filter((request) => (!status || request.status === status)
    && matchesSearch(words, [request.memberName, request.details?.note, request.details?.description, ...dayTexts(request.details?.date), ...amountTexts(request.amountCents)]));
  res.json(page(items, req, (request) => request.createdAt));
}));

// What a request's details may hold: texts as long as a booking takes them (what is asked can be booked as it is)
const DETAIL_TEXTS = { note: TEXT_LIMITS.note, description: TEXT_LIMITS.description };

function detailsInput(body) {
  if (body.details === undefined || body.details === null) return {};
  if (typeof body.details !== 'object' || Array.isArray(body.details)) throw invalid('details must be an object.', null, 'details');
  for (const [key, limit] of Object.entries(DETAIL_TEXTS)) {
    const value = body.details[key];
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > limit)) throw invalid('details.{name} is a text of at most {limit} characters.', { name: key, limit }, `details.${key}`);
  }
  if (body.details.receipt !== undefined && body.details.receipt !== null && body.details.receipt !== '' && !receiptNames(body.details.receipt).length) throw invalid('details.receipt must name files in the receipts folder.', null, 'details.receipt');
  return body.details;
}

const notifyRoute = v1Route(financeRouter, 'post', '/api/notify-admins');

router.post(`${BASE}/requests`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  choiceInput(body.type, 'type', REQUEST_TYPES);
  const details = detailsInput(body);
  const notify = body.notify === undefined ? false : boolInput(body.notify, 'notify');
  const uid = req.user.uid;
  let person = { personId: uid, personName: req.user.name || '' };
  if (body.memberId !== undefined && body.memberId !== null) {
    const row = await memberRow(idInput(body.memberId, 'memberId'));
    // A request about someone else is for those who manage the finances (anyone else's is about themselves)
    needs(canManage(req) || row.user === uid);
    person = { personId: finance.keyOfMember(row), personName: row.name || '' };
  }
  const id = crypto.randomUUID();
  const value = { id, type: body.type, userId: uid, ...person, data: details, status: 'pending', timestamp: Date.now() };
  await writeLogicalPath(`requests/${id}`, value, req.user, 'set', {});
  broadcastDataUpdate();
  // The treasurers are told, as the web app asks for it after filing a request (/api/notify-admins)
  if (notify) await runV1(notifyRoute, req, { body: { reqType: body.type } }).catch((err) => console.warn('[API v2] Telling the treasurers failed:', err.message));
  res.status(201).json(requestOf(await finance.getRequestRecord(context.appConfig, id), await memberIdsByKey()));
}));

/**
 * Books the approved [request] (as the old API knows it) the way the web app does: its payment, status change or
 * standing order on the member's record, its expense in the expenses - once (a booking that is there already, from an
 * approval at the same moment or a client that booked first, is not made again). Resolves with a function that takes
 * back what this call booked (null: nothing was booked here).
 */
async function bookRequest(req, request) {
  const note = translate(requestLanguage(req), 'Payment (approved)');
  const asApproved = { id: request.requestKey, type: request.type, data: request.data?.data || {}, personName: request.personName };
  // A client that booked first named the request by its record id (requestId): that booking counts, too
  const asBookedByRecord = { ...asApproved, id: request.id };
  const bookingIds = new Set([bookings.bookingId(asApproved), bookings.bookingId(asBookedByRecord)]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (request.type === 'expense') {
        const rows = await LISTS.expenses.rows();
        if (rows.some((row) => bookingIds.has(String(LISTS.expenses.entryOf(row)?.id)))) return null;
        const next = bookings.addApprovedExpense(rows.map((row) => LISTS.expenses.entryOf(row)), asApproved);
        if (!next) return null;
        await LISTS.expenses.save(next, [...rows.map((row) => row.id), null], finance.listVersion(rows));
        broadcastDataUpdate();
        return async () => {
          const nowRows = await LISTS.expenses.rows();
          const kept = nowRows.filter((row) => String(LISTS.expenses.entryOf(row)?.id) !== bookings.bookingId(asApproved));
          if (kept.length === nowRows.length) return;
          await LISTS.expenses.save(kept.map((row) => LISTS.expenses.entryOf(row)), kept.map((row) => row.id), finance.listVersion(nowRows));
          broadcastDataUpdate();
        };
      }
      const person = await finance.getPeopleRecord(context.appConfig, request.personId);
      if (!person || person.data?.isDeleted) throw invalid('The member of this request is not in the books.');
      if (bookings.isBookedOn(person.data, asApproved) || bookings.isBookedOn(person.data, asBookedByRecord)) return null;
      const before = { status: person.data.status, statusHistory: person.data.statusHistory };
      let next;
      try {
        next = bookings.applyApprovedRequest({ ...person.data }, asApproved, note);
      } catch (err) {
        throw invalid(err.message, null, 'date');
      }
      if (request.type === 'standing_order') next = withDueBookings(next);
      await finance.upsertPeopleRecord(context.appConfig, request.personId, next, person.updated);
      broadcastDataUpdate();
      return async () => {
        const now = await finance.getPeopleRecord(context.appConfig, request.personId);
        await finance.upsertPeopleRecord(context.appConfig, request.personId, bookings.withoutApprovedRequest(now.data, asApproved, before), now.updated);
        broadcastDataUpdate();
      };
    } catch (err) {
      // Someone booked on the same member (or list) meanwhile: read again and book on what is there now
      if (err?.status !== 409 || attempt === 2) throw err;
    }
  }
  return null;
}

// An amount as the apps file it: a number, or a number as text ("12.5")
const AMOUNT_TEXT = /^\d+(\.\d+)?$/;

/**
 * Refuses to book a request whose details cannot be booked as they are (an amount like "12,50" was booked as 12.00,
 * a status change without a day wrote a history nobody could read): the treasury books it by hand.
 */
function checkBookable(request) {
  const details = request.data?.data || {};
  if (request.type !== 'status') {
    const amount = details.amount;
    const fits = typeof amount === 'number' ? Number.isFinite(amount) && amount > 0 : typeof amount === 'string' && AMOUNT_TEXT.test(amount.trim()) && Number(amount) > 0;
    if (!fits) throw invalid('The amount of this request cannot be booked as it is: book it by hand.', null, 'details.amount');
  }
  if (!isCalendarDay(details.date)) throw invalid('The day of this request cannot be booked as it is: book it by hand.', null, 'details.date');
  if (request.type === 'status' && !INCOME_STATUSES.includes(details.newStatus)) throw invalid('The status of this request cannot be booked as it is: book it by hand.', null, 'details.newStatus');
}

router.post(`${BASE}/requests/:id/decision`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  needs(canManage(req));
  const body = bodyOf(req);
  choiceInput(body.status, 'status', ['approved', 'rejected']);
  if (body.rejectionReason !== undefined) textInput(body, 'rejectionReason');
  const book = body.book === undefined ? false : boolInput(body.book, 'book');
  if (book && body.status !== 'approved') throw invalid('book goes with status approved only.', null, 'book');
  const row = ID.test(req.params.id) ? await client.getRecord(finance.COLLECTIONS.REQUESTS, req.params.id, context.appConfig) : null;
  if (!row) throw notFound('There is no such request.');
  // The request as the old API knows it (by its key)
  const current = finance.oldRequestRecord(row);
  if (current.status !== 'pending') throw conflict('The request was decided already.');
  if (book) checkBookable(current);
  const takeBack = book ? await bookRequest(req, current) : null;
  const reason = typeof body.rejectionReason === 'string' && body.rejectionReason.trim() ? body.rejectionReason : NO_REASON_GIVEN;
  try {
    await writeLogicalPath(`requests/${current.requestKey}`, { status: body.status, ...(body.status === 'rejected' ? { rejectionReason: reason } : {}) }, req.user, 'patch', {});
  } catch (err) {
    // Rejected by someone else meanwhile: what this call booked goes again (an approval keeps its booking)
    if (err?.status === 409 && takeBack) await takeBack().catch((undoErr) => console.error('[API v2] Taking back a booking failed:', undoErr));
    if (err?.status === 409) throw conflict('The request was decided already.');
    throw err;
  }
  broadcastDataUpdate();
  res.json(requestOf(await finance.getRequestRecord(context.appConfig, current.requestKey), await memberIdsByKey()));
}));

// --- The money as the app's statistics count it, and the change log ----------------------------------------------

router.get(`${BASE}/finance/summary`, verifyToken, handle(async (req, res) => {
  needs(canView(req));
  const money = await data.moneyBooks();
  const undated = Object.entries(money.undated).map(([kind, entry]) => ({ kind, totalCents: entry.totalCents }));
  const totals = data.centsByKind([...money.booked, ...undated]);
  const planned = data.centsByKind(money.planned);
  const undatedCents = data.centsByKind(undated);
  const month = (row) => ({ month: row.month, kind: row.kind, totalCents: row.totalCents, entries: row.entries });
  res.json({
    today: money.today,
    totalsCents: { memberPayments: totals.memberPayment, donations: totals.donation, expenses: totals.expense, balance: totals.memberPayment + totals.donation - totals.expense },
    months: money.booked.map(month),
    undatedCents: { memberPayments: undatedCents.memberPayment, donations: undatedCents.donation, expenses: undatedCents.expense },
    plannedCents: { memberPayments: planned.memberPayment, donations: planned.donation, expenses: planned.expense },
    planned: money.planned.map(month)
  });
}));

// Newest first, a page at a time - asked of the database: the log grows with every booking and is kept ten years.
// It holds the books, so it is for those who see them: a system admin without these rights reads it no more than any
// other member (as v1 and the AI's finance_changes keep it)
router.get(`${BASE}/finance/changes`, verifyToken, handle(async (req, res) => {
  needs(canView(req));
  const area = req.query.area === undefined || req.query.area === '' ? null : choiceInput(req.query.area, 'area', CHANGE_AREAS);
  const { from, to } = daysOf(req);
  res.json(storedPage(await data.financeChangesPage({ area, member: idOfQuery(req, 'member'), from, to, limit: limitOf(req), after: storedCursorOf(req) })));
}));

// --- The fees over time and the fresh starts: v1's own handlers, money in cents -----------------------------------

const centsOfAmount = (amount) => (typeof amount === 'number' && Number.isFinite(amount) ? toCents(amount).cents : null);
const feesInCents = (fees) => (fees && typeof fees === 'object' ? Object.fromEntries(Object.entries(fees).map(([status, amount]) => [status, centsOfAmount(amount)])) : null);
const sideInCents = (side) => (side ? { count: side.count, totalCents: centsOfAmount(side.total) } : null);

const feesRoute = v1Route(financeRouter, 'get', '/api/fees');

/**
 * The fees as v2 answers them, from v1's answer [fees] ([req]: who reads - who set what only for insiders, as in v1).
 * The fees over time are those that count, as v1 lists them - the fees from the beginning first. An instance on which
 * no change was ever saved (every one updated from a version before the history) has none stored: its fees are read
 * off the fee settings and the fresh starts (scheduleFromLegacy), and listed all the same.
 */
async function feesAnswer(req, fees) {
  const starts = await client.listAllRecords(finance.COLLECTIONS.FRESH_STARTS, '', context.appConfig, 'day');
  const insider = isFeeInsider(req);
  return {
    today: fees.today,
    month: fees.month,
    currentCents: feesInCents(fees.current),
    since: fees.since,
    next: fees.next ? { fromMonth: fees.next.from, feesCents: feesInCents(fees.next.fees) } : null,
    feeChanges: (fees.entries || []).map((entry) => ({
      fromMonth: entry.from || '', feesCents: feesInCents(entry.fees) || {}, state: entry.state || null,
      setAt: insider ? isoFromMillis(entry.setAt) : null, setByName: insider ? entry.setByName || '' : ''
    })),
    freshStarts: starts.map((row) => ({ day: row.day, feesBeforeCents: insider ? row.feesBeforeCents || null : null })),
    ...(insider ? {
      version: fees.version || null,
      log: (fees.log || []).map((entry) => ({ action: entry.action, fromMonth: entry.from ?? null, feesCents: feesInCents(entry.fees), movedFrom: entry.movedFrom || null, at: isoFromMillis(entry.at), by: entry.by || null, byName: entry.byName || '' }))
    } : {})
  };
}

router.get(`${BASE}/fees`, verifyToken, handle(async (req, res) => {
  const { body } = await runV1(feesRoute, req);
  res.json(await feesAnswer(req, body));
}));

/** What a change of the fees sends to v1: the month and the fees in euros (v1's units). */
function feeChangeBody(body, { withFees }) {
  const fromMonth = body.fromMonth === null ? null : monthInput(body.fromMonth, 'fromMonth');
  const v1 = { from: fromMonth };
  if (withFees) {
    if (!body.feesCents || typeof body.feesCents !== 'object' || Array.isArray(body.feesCents)) throw invalid('feesCents must be an object: the fee of each income status in cents.', null, 'feesCents');
    const fees = {};
    for (const [status, amount] of Object.entries(body.feesCents)) {
      choiceInput(status, 'feesCents', INCOME_STATUSES);
      fees[status] = fromCents(centsInput(amount, `feesCents.${status}`));
    }
    v1.fees = fees;
    if (body.replaces !== undefined && body.replaces !== null) v1.replaces = monthInput(body.replaces, 'replaces');
  }
  return v1;
}

const feePreviewRoute = v1Route(financeRouter, 'post', '/api/admin/fees/preview');
const feeChangeRoute = v1Route(financeRouter, 'post', '/api/admin/fees');
const feeRemoveRoute = v1Route(financeRouter, 'post', '/api/admin/fees/remove');

// What a change of the fees (or taking one back: remove) would do, before anything is saved - system admins
router.post(`${BASE}/fees/preview`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const remove = body.remove === undefined ? false : boolInput(body.remove, 'remove');
  const { body: impact } = await runV1(feePreviewRoute, req, { body: remove ? { ...feeChangeBody(body, { withFees: false }), remove: true } : feeChangeBody(body, { withFees: true }) });
  res.json({
    fromMonth: impact.from,
    remove: impact.remove,
    movedFrom: impact.movedFrom,
    stretches: (impact.stretches || []).map((stretch) => ({ first: stretch.first, last: stretch.last, beforeCents: feesInCents(stretch.before), afterCents: feesInCents(stretch.after) })),
    inEffect: impact.inEffect,
    members: impact.members,
    more: sideInCents(impact.more),
    less: sideInCents(impact.less),
    freshStart: impact.freshStart,
    version: impact.version
  });
}));

// Saves the change as it was checked (the version of the preview) - system admins
router.post(`${BASE}/fees`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const version = versionInput(body.version, 'version', '{name} is needed: the version of the fees the preview showed.');
  await runV1(feeChangeRoute, req, { body: { ...feeChangeBody(body, { withFees: true }), version } });
  res.json(await feesAnswer(req, (await runV1(feesRoute, req)).body));
}));

router.post(`${BASE}/fees/remove`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  const version = versionInput(body.version, 'version', '{name} is needed: the version of the fees the preview showed.');
  await runV1(feeRemoveRoute, req, { body: { ...feeChangeBody(body, { withFees: false }), version } });
  res.json(await feesAnswer(req, (await runV1(feesRoute, req)).body));
}));

const freshStartsRoute = v1Route(financeRouter, 'get', '/api/fee-reset');
const freshStartPreviewRoute = v1Route(financeRouter, 'get', '/api/admin/fee-reset/preview');
const freshStartRoute = v1Route(financeRouter, 'post', '/api/admin/fee-reset');
const freshStartRemoveRoute = v1Route(financeRouter, 'post', '/api/admin/fee-reset/remove');

/** The fresh starts as v2 answers them, from v1's answer. */
function freshStartsAnswer(answer) {
  return {
    today: answer.today,
    items: (answer.resets || []).map((reset) => ({
      day: reset.date,
      state: reset.state,
      ...(reset.feesBefore !== undefined ? { feesBeforeCents: feesInCents(reset.feesBefore), setAt: isoFromMillis(reset.setAt), setByName: reset.setByName || '' } : {})
    })),
    nextCursor: null,
    ...(answer.log ? { log: answer.log.map((entry) => ({ action: entry.action, day: entry.date, at: isoFromMillis(entry.at), by: entry.by || null, byName: entry.byName || '' })) } : {})
  };
}

router.get(`${BASE}/fresh-starts`, verifyToken, handle(async (req, res) => {
  res.json(freshStartsAnswer((await runV1(freshStartsRoute, req)).body));
}));

// What a fresh start on ?day= (or taking it back: ?remove=1) would change, in numbers - system admins
router.get(`${BASE}/fresh-starts/preview`, verifyToken, handle(async (req, res) => {
  const day = dayInput(req.query.day, 'day');
  const { body: impact } = await runV1(freshStartPreviewRoute, req, { query: { date: day, ...(req.query.remove === '1' ? { remove: '1' } : {}) } });
  res.json({
    day: impact.date,
    inEffect: impact.inEffect,
    firstMonth: impact.firstMonth,
    members: impact.members,
    behind: sideInCents(impact.behind),
    ahead: sideInCents(impact.ahead),
    owesMore: sideInCents(impact.owesMore),
    feesBeforeCents: feesInCents(impact.feesBefore),
    feesWithoutCents: feesInCents(impact.feesWithout),
    repriced: impact.repriced
  });
}));

/** What setting or taking back a fresh start sends: the day twice and the admin's own password. */
function freshStartBody(body) {
  const day = dayInput(body.day, 'day');
  const confirmDay = typeof body.confirmDay === 'string' ? body.confirmDay : '';
  const password = typeof body.password === 'string' ? body.password : '';
  return { date: day, confirmDate: confirmDay, password };
}

router.post(`${BASE}/fresh-starts`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const { body } = await runV1(freshStartRoute, req, { body: freshStartBody(bodyOf(req)) });
  res.json(freshStartsAnswer(body));
}));

router.post(`${BASE}/fresh-starts/remove`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const { body } = await runV1(freshStartRemoveRoute, req, { body: freshStartBody(bodyOf(req)) });
  res.json(freshStartsAnswer(body));
}));

module.exports = {
  router,
  RESOURCES: ['members', 'accounts', 'payments', 'standing-orders', 'status-changes', 'donations', 'expenses', 'receipts', 'requests', 'finance/ledger', 'finance/summary', 'finance/changes', 'fees', 'fresh-starts']
};
