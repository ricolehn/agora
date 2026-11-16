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
const { context, verifyToken, protectedActionRateLimit, broadcastDataUpdate, writeLogicalPath } = require('../context');
const client = require('../db/client');
const finance = require('../db/stores/finance');
const eventsStore = require('../db/stores/events');
const { fromCents } = require('../db/codec');
const { REQUEST_TYPES, CHANGE_AREAS } = require('../db/schema/finance');
const { createItemStore } = require('../itemStore');
const { listGroupRecords, listMentoringThreadsForUser, listMentorRecords, listUserRecords, decryptMentoringText } = require('../pocketbase');
const { seatCounts } = require('../eventSeats');
const { canUserAccessEventDutyPlan } = require('../eventAccess');
// The reads are shared with the AI assistant's lookups (aiTools.js)
const data = require('../v2Data');
const { DAY, cents, isoOf, isoFromMillis, memberOf, paymentOf, statusPeriodOf, standingOrderOf, eventOf, seesEvent } = data;

const router = express.Router();
const BASE = '/api/v2';

// --- Answers -------------------------------------------------------------------------------------------------------

const ERROR_CODES = { 400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 429: 'rate_limited', 503: 'unavailable' };
const codeOf = (status) => ERROR_CODES[status] || (status >= 500 ? 'server_error' : 'invalid');
const COULD_NOT = 'The request could not be handled.';
const CHANGED = 'The data changed meanwhile: read it again and repeat the change.';
const errorOf = (status, message) => ({ error: { code: codeOf(status), message: message || COULD_NOT } });
const fail = (res, status, message) => res.status(status).json(errorOf(status, message));

/** Runs [handler]; errors become { error: { code, message } } (409 for a conflicting change). */
const handle = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    const status = [400, 403, 404, 409].includes(err?.status) ? err.status : 500;
    if (status === 500) console.error(`[API v2] ${req.method} ${req.path} failed:`, err);
    // A version that is no longer the current one (found below, by the stores) is answered with what to do
    const message = status === 500 ? COULD_NOT : status === 409 && (!err.message || err.message === 'Conflict') ? CHANGED : err.message;
    fail(res, status, message);
  }
};

/** [body] of an error answer in the shape of v2: kept when it has it, else its text (or its error's) is the message. */
function asError(status, body) {
  if (body?.error && typeof body.error === 'object' && typeof body.error.code === 'string') return body;
  const text = typeof body === 'string' ? body : typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : '';
  // What failed inside the server stays in its log
  return errorOf(status, status >= 500 && status !== 503 ? COULD_NOT : text.trim());
}

/**
 * Every error answer under /api/v2 in the shape of v2 - also those given before a route of v2 runs: no or no valid
 * sign-in (401, a text until now), too many requests (429), a server that is starting or not set up (503). Mounted
 * ahead of everything that may answer there (server.js).
 */
function errorShape(req, res, next) {
  const json = res.json.bind(res);
  const send = res.send.bind(res);
  res.json = (body) => json(res.statusCode >= 400 ? asError(res.statusCode, body) : body);
  res.send = (body) => {
    // A text given as an error; Express' json() comes back here with its JSON text, which goes out as it is
    const isText = typeof body === 'string' || Buffer.isBuffer(body) || body === undefined;
    if (res.statusCode >= 400 && isText && !/json/i.test(String(res.get('Content-Type') || ''))) return json(asError(res.statusCode, body === undefined ? '' : String(body)));
    return send(body);
  };
  next();
}

/**
 * What no route of v2 caught - a body that is no JSON or is too large, above all: in the shape of v2 (Express' own
 * page showed the stack trace with the server's paths).
 */
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.parse.failed') return fail(res, 400, 'The body is no valid JSON.');
  if (err?.type === 'entity.too.large') return fail(res, 413, 'The body is too large.');
  const status = Number(err?.status || err?.statusCode);
  if (status >= 400 && status < 500) return fail(res, status, err.expose ? err.message : '');
  console.error(`[API v2] ${req.method} ${req.originalUrl} failed:`, err);
  return fail(res, 500, COULD_NOT);
}

const uidOf = (req) => data.uidOf(req.user);
const canView = (req) => req.user.canViewFinances === true;
const canManage = (req) => req.user.canManageFinances === true;
const needs = (allowed) => {
  if (!allowed) throw Object.assign(new Error('You may not do this.'), { status: 403 });
};
const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const notFound = (what) => Object.assign(new Error(`${what} not found.`), { status: 404 });
const conflict = (message) => Object.assign(new Error(message), { status: 409 });

// --- What a request sends: checked, never cut or guessed ----------------------------------------------------------

const ID = /^[A-Za-z0-9_-]{1,64}$/;
// The largest amount of one entry, either way: 1,000,000,000.00. Far beyond any booking; whole cents stay exact in
// every sum of them (an amount like 1e300 was taken and left the member without a balance)
const MAX_AMOUNT_CENTS = 100000000000;
const TEXT_LIMITS = { description: 500, donorName: 200, issuer: 200, rejectionReason: 500 };
const RECEIPT_LIMIT = 300;

/** The body of a write: a JSON object (nothing sent: an empty one). */
function bodyOf(req) {
  const body = req.body === undefined ? {} : req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('The body must be a JSON object.');
  return body;
}

/** True for a day of the calendar 'YYYY-MM-DD' (2026-02-31 is none). */
function isCalendarDay(value) {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dayInput(value, name) {
  if (!isCalendarDay(value)) throw invalid(`${name} must be a day of the calendar, YYYY-MM-DD.`);
  return value;
}

function centsInput(value) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_AMOUNT_CENTS) throw invalid(`amountCents must be a whole number of cents, at most ${MAX_AMOUNT_CENTS} either way.`);
  return value;
}

/** The text [key] of [body]: text of at most its length (null: empty). */
function textInput(body, key) {
  const value = body[key];
  if (value === null) return '';
  if (typeof value !== 'string') throw invalid(`${key} must be text.`);
  if (value.length > TEXT_LIMITS[key]) throw invalid(`${key} is at most ${TEXT_LIMITS[key]} characters long.`);
  return value;
}

/** A receipt: the name of a file in the receipts folder; null or '' takes it away (null back). */
function receiptInput(value) {
  if (value === null || value === '') return null;
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || value.length > RECEIPT_LIMIT || /[\\/\x00-\x1f]/.test(value) || value === '.' || value === '..') {
    throw invalid('receipt must be the name of a file in the receipts folder.');
  }
  return value;
}

/** A record id [name] ([value]); without one: "is needed". */
function idInput(value, name) {
  if (value === undefined || value === null || value === '') throw invalid(`${name} is needed: a record id.`);
  if (typeof value !== 'string' || !ID.test(value)) throw invalid(`${name} must be a record id.`);
  return value;
}

/** The version [value] a change is based on. */
function versionInput(value, name, of) {
  if (typeof value !== 'string' || !value) throw invalid(`${name} is needed: the version of ${of} the change is based on.`);
  return value;
}

/** The id of a request a booking is for (null: none). */
function requestIdInput(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !ID.test(value)) throw invalid('requestId must be the id of a request.');
  return value;
}

/** The days ?from= and ?to= of [req] (each optional; anything else than a day of the calendar is refused). */
function daysOf(req) {
  const day = (name) => (req.query[name] === undefined || req.query[name] === '' ? null : dayInput(req.query[name], name));
  return { from: day('from'), to: day('to') };
}

/** The record id ?[name]= of [req] (optional). */
const idOfQuery = (req, name) => (req.query[name] === undefined || req.query[name] === '' ? null : idInput(req.query[name], name));

// --- Pages: in a fixed order, cut after an item (not a position: an item added meanwhile shifts nothing) ---------

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** ?limit= of [req]: 1 to 500 (more counts as 500), 100 without. */
function limitOf(req) {
  const value = req.query.limit;
  if (value === undefined || value === '') return DEFAULT_LIMIT;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1) throw invalid(`limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  return Math.min(Number(value), MAX_LIMIT);
}

const encodeCursor = (key) => Buffer.from(JSON.stringify(key)).toString('base64url');
const INVALID_CURSOR = 'cursor is not valid: send the nextCursor of the page before.';

/** ?cursor= of [req]: [key, id] of the last item of the page before (null: the first page); anything else is refused. */
function cursorOf(req) {
  const cursor = req.query.cursor;
  if (cursor === undefined || cursor === '') return null;
  let key = null;
  try {
    key = typeof cursor === 'string' ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) : null;
  } catch { /* refused below */ }
  if (!Array.isArray(key) || key.length !== 2 || !key.every((part) => typeof part === 'string')) throw invalid(INVALID_CURSOR);
  return key;
}

// A moment as the database keeps it ('2026-05-05 08:30:00.000Z'), or none
const STORED_MOMENT = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,9})?Z)?$/;

/** ?cursor= of a list paged by the database: [moment, id] as the database keeps them. */
function storedCursorOf(req) {
  const cursor = cursorOf(req);
  if (cursor && !(STORED_MOMENT.test(cursor[0]) && ID.test(cursor[1]))) throw invalid(INVALID_CURSOR);
  return cursor;
}

/** A page the database cut ({ items, next }, see v2Data.financeChangesPage) as v2 answers it. */
const storedPage = ({ items, next }) => ({ items, nextCursor: next ? encodeCursor(next) : null });

/** A name as it is sorted: without accents and case ("Ärger" next to "Arger", both before "Zora"). */
const sortable = (text) => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');

/** [items] sorted by [sortKey] (descending - or [ascending] -, then by id), as one page of [req] ({ items, nextCursor }). */
function page(items, req, sortKey, { ascending = false } = {}) {
  const limit = limitOf(req);
  const cursor = cursorOf(req);
  const order = (a, b) => {
    const result = a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    return ascending ? result : -result;
  };
  // Each item's key once (worked out in every comparison, it cost more than the sorting itself)
  const sorted = items.map((item) => ({ item, key: [String(sortKey(item) ?? ''), String(item.id)] })).sort((x, y) => order(x.key, y.key));
  const start = cursor ? sorted.findIndex(({ key }) => order(key, cursor) > 0) : 0;
  const slice = start < 0 ? [] : sorted.slice(start, start + limit);
  const more = start >= 0 && start + limit < sorted.length;
  return { items: slice.map(({ item }) => item), nextCursor: more ? encodeCursor(slice[slice.length - 1].key) : null };
}

// --- Finance ------------------------------------------------------------------------------------------------------

/** The member rows and their worked-out data, by member id - all of them, or the reader's own (no finance rights). */
const membersFor = (req) => data.membersFor(req.user);

async function memberRow(id) {
  const row = typeof id === 'string' && ID.test(id) ? await client.getRecord(finance.COLLECTIONS.MEMBERS, id, context.appConfig) : null;
  if (!row || finance.isOrphan(row)) throw notFound('Member');
  return row;
}

// In the order of their names (A to Z)
router.get(`${BASE}/members`, verifyToken, handle(async (req, res) => {
  const members = (await membersFor(req)).map(({ row, person, payments }) => memberOf(row, person, payments));
  res.json(page(members.filter((member) => req.query.includeDeleted === '1' || !member.isDeleted), req, (member) => sortable(member.name), { ascending: true }));
}));

// One member: from the books' memo where it is up to date (stores/finance.js), its rows are read only here
router.get(`${BASE}/members/:id`, verifyToken, handle(async (req, res) => {
  const member = await finance.memberReadOnly(context.appConfig, req.params.id);
  if (!member) throw notFound('Member');
  const { row, person, payments, periods, orders } = member;
  needs(canView(req) || row.user === uidOf(req));
  res.json({
    ...memberOf(row, person, payments),
    payments: payments.map((payment) => paymentOf(payment, row.updated)).sort((a, b) => String(b.date).localeCompare(String(a.date))),
    statusPeriods: periods.map(statusPeriodOf),
    standingOrders: [...orders].sort((a, b) => (a.position || 0) - (b.position || 0)).map(standingOrderOf)
  });
}));

router.get(`${BASE}/payments`, verifyToken, handle(async (req, res) => {
  const { from, to } = daysOf(req);
  const payments = await data.paymentsFor(req.user, { member: idOfQuery(req, 'member'), from, to });
  res.json(page(payments, req, (payment) => payment.date));
}));

// A payment is part of its member's books: written through the member (as v1 does), based on the member's version
async function changeMemberPayments(req, memberId, memberVersion, change) {
  needs(canManage(req));
  versionInput(memberVersion, 'memberVersion', 'the member');
  const row = await memberRow(memberId);
  if (row.updated !== memberVersion) throw conflict(CHANGED);
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

/** [current] (an entry as the apps keep it) with what [body] changes - every value checked first. */
function paymentInput(body, current = {}) {
  const next = { ...current };
  if (body.amountCents !== undefined) next.amount = fromCents(centsInput(body.amountCents));
  if (body.date !== undefined) next.date = dayInput(body.date, 'date');
  if (body.description !== undefined) next.description = textInput(body, 'description');
  if (body.receipt !== undefined) {
    const receipt = receiptInput(body.receipt);
    if (receipt === null) delete next.receipt;
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

// A booking for a request carries the request in its id: whatever sends it again finds it (and no second one is made)
const bookingIdOf = (requestId) => `req_${requestId}`;

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
  const clientId = requestId ? bookingIdOf(requestId) : crypto.randomUUID();
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
  await changeMemberPayments(req, memberId, body.memberVersion, (payments) => {
    // Booked meanwhile by the same request sent at the same moment: sent again, it finds that booking
    if (payments.some((existing) => existing?.id === clientId)) throw conflict('This request was booked meanwhile: send it again to get the booking.');
    return { payments: [...payments, { amount: payment.amount, date: payment.date, description: payment.description, id: clientId, ...(payment.receipt ? { receipt: payment.receipt } : {}) }] };
  });
  res.status(201).json(await paymentAnswer(memberId, clientId));
}));

async function paymentRow(id) {
  const row = typeof id === 'string' && ID.test(id) ? await client.getRecord(finance.COLLECTIONS.PAYMENTS, id, context.appConfig) : null;
  if (!row) throw notFound('Payment');
  return row;
}

const hasClientId = (entry) => entry.id !== undefined && entry.id !== null && entry.id !== '';

router.patch(`${BASE}/payments/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  needs(canManage(req));
  const body = bodyOf(req);
  paymentInput(body);
  const row = await paymentRow(req.params.id);
  let clientId = null;
  await changeMemberPayments(req, row.member, body.memberVersion, (payments, byRecordId) => {
    const current = byRecordId.get(row.id);
    const index = indexOfPayment(payments, current);
    if (index < 0) throw notFound('Payment');
    // An entry of an older app without an id of its own gets one: the answer finds it, and so does every change after
    clientId = hasClientId(current) ? current.id : crypto.randomUUID();
    payments[index] = { ...paymentInput(body, payments[index]), id: clientId };
    return { payments };
  });
  const changed = await paymentAnswer(row.member, clientId);
  if (!changed) throw conflict(CHANGED);
  res.json(changed);
}));

router.delete(`${BASE}/payments/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  needs(canManage(req));
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
    ...data.LIST_READS.donations,
    values: async () => {
      const value = await finance.getDonationsValue(context.appConfig);
      return Array.isArray(value) ? value : Object.values(value || {});
    },
    version: () => finance.donationsVersion(context.appConfig),
    save: (list, version) => finance.saveDonations(context.appConfig, list, { expectedVersion: version }),
    fromV2: (body, current = {}) => {
      const next = paymentInput(body, current);
      if (body.donorName !== undefined) next.name = textInput(body, 'donorName');
      return next;
    },
    fresh: () => ({ amount: 0, name: '', date: '', description: '' })
  },
  expenses: {
    ...data.LIST_READS.expenses,
    values: async () => (await finance.listExpenseRecords(context.appConfig)).map((record) => record.data),
    version: () => finance.expensesVersion(context.appConfig),
    save: (list, version) => finance.syncExpenseRecords(context.appConfig, list, { expectedVersion: version }),
    fromV2: (body, current = {}) => {
      const next = paymentInput(body, current);
      if (body.issuer !== undefined) next.issuer = textInput(body, 'issuer');
      return next;
    },
    fresh: () => ({ amount: 0, description: '', issuer: '', date: '' })
  }
};

for (const [name, list] of Object.entries(LISTS)) {
  router.get(`${BASE}/${name}`, verifyToken, handle(async (req, res) => {
    needs(canView(req));
    const [rows, version] = await Promise.all([list.rows(), list.version()]);
    res.json({ ...page(rows.filter(list.shown).map(list.toV2), req, (item) => item.date), listVersion: version });
  }));

  // The rows and the list as the apps see it belong together by position (both in the order the list is kept)
  const change = async (req, edit) => {
    needs(canManage(req));
    const version = versionInput(req.body?.listVersion || req.query.listVersion, 'listVersion', 'the list');
    const [rows, values, current] = await Promise.all([list.rows(), list.values(), list.version()]);
    if (version !== current) throw conflict(CHANGED);
    const result = edit(rows, values);
    await list.save(result.values, version);
    broadcastDataUpdate();
    return result;
  };

  router.post(`${BASE}/${name}`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
    needs(canManage(req));
    const body = bodyOf(req);
    if (body.amountCents === undefined || body.date === undefined) throw invalid('amountCents and date are needed.');
    const requestId = requestIdInput(body.requestId);
    const entry = list.fromV2(body, list.fresh());
    const clientId = requestId ? bookingIdOf(requestId) : crypto.randomUUID();
    if (requestId) {
      // Booked already: that entry once more (see POST /payments)
      const booked = (await list.rows()).find((row) => row.clientId === clientId && list.shown(row));
      if (booked) {
        if (booked.amountCents !== body.amountCents || booked.date !== body.date) throw conflict('This request is booked already, with another amount or day.');
        res.status(200).json({ ...list.toV2(booked), listVersion: await list.version() });
        return;
      }
    }
    await change(req, (rows, values) => {
      if (values.some((value) => value?.id === clientId)) throw conflict('This request was booked meanwhile: send it again to get the booking.');
      return { values: [...values, { ...entry, id: clientId }] };
    });
    const created = (await list.rows()).find((row) => row.clientId === clientId);
    if (!created) throw conflict(CHANGED);
    res.status(201).json({ ...list.toV2(created), listVersion: await list.version() });
  }));

  router.patch(`${BASE}/${name}/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
    needs(canManage(req));
    const body = bodyOf(req);
    list.fromV2(body);
    await change(req, (rows, values) => {
      const index = rows.findIndex((row) => row.id === req.params.id);
      if (index < 0 || !values[index] || !list.shown(rows[index])) throw notFound('Entry');
      const next = [...values];
      next[index] = list.fromV2(body, values[index]);
      return { values: next };
    });
    const updated = (await list.rows()).find((row) => row.id === req.params.id);
    if (!updated) throw conflict(CHANGED);
    res.json({ ...list.toV2(updated), listVersion: await list.version() });
  }));

  router.delete(`${BASE}/${name}/:id`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
    await change(req, (rows, values) => {
      const index = rows.findIndex((row) => row.id === req.params.id);
      if (index < 0 || !list.shown(rows[index])) throw notFound('Entry');
      return { values: values.filter((value, position) => position !== index) };
    });
    res.status(204).end();
  }));
}

// Requests: members ask, those who manage the finances decide (the booking is a payment or expense of its own, with
// requestId - as the web app does it)

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
  createdAt: isoFromMillis(record.timestamp),
  decidedAt: isoFromMillis(record.data?.decidedAt),
  rejectionReason: record.data?.rejectionReason || null
});

router.get(`${BASE}/requests`, verifyToken, handle(async (req, res) => {
  const [records, memberIds] = await Promise.all([finance.listRequestRecords(context.appConfig), memberIdsByKey()]);
  const uid = uidOf(req);
  // Everyone else sees what they asked and what was asked about them (their own member record), as in v1
  const own = canView(req) ? null : new Set((await membersFor(req)).map(({ row }) => row.id));
  const visible = own ? records.filter((record) => record.userId === uid || record.personId === uid || own.has(memberIds.get(record.personId))) : records;
  res.json(page(visible.map((record) => requestOf(record, memberIds)), req, (request) => request.createdAt));
}));

router.post(`${BASE}/requests`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  const body = bodyOf(req);
  if (!REQUEST_TYPES.includes(body.type)) throw invalid(`type must be one of ${REQUEST_TYPES.join(', ')}.`);
  if (body.details !== undefined && body.details !== null && (typeof body.details !== 'object' || Array.isArray(body.details))) throw invalid('details must be an object.');
  const uid = uidOf(req);
  let person = { personId: uid, personName: req.user.name || '' };
  if (body.memberId !== undefined && body.memberId !== null) {
    const row = await memberRow(idInput(body.memberId, 'memberId'));
    // A request about someone else is for those who manage the finances (anyone else's is about themselves)
    needs(canManage(req) || row.user === uid);
    person = { personId: finance.keyOfMember(row), personName: row.name || '' };
  }
  const id = crypto.randomUUID();
  const value = { id, type: body.type, userId: uid, ...person, data: body.details || {}, status: 'pending', timestamp: Date.now() };
  await writeLogicalPath(`requests/${id}`, value, req.user, 'set', {});
  broadcastDataUpdate();
  res.status(201).json(requestOf(await finance.getRequestRecord(context.appConfig, id), await memberIdsByKey()));
}));

router.post(`${BASE}/requests/:id/decision`, protectedActionRateLimit, verifyToken, handle(async (req, res) => {
  needs(canManage(req));
  const body = bodyOf(req);
  if (!['approved', 'rejected'].includes(body.status)) throw invalid('status is approved or rejected.');
  if (body.rejectionReason !== undefined) textInput(body, 'rejectionReason');
  const row = ID.test(req.params.id) ? await client.getRecord(finance.COLLECTIONS.REQUESTS, req.params.id, context.appConfig) : null;
  if (!row) throw notFound('Request');
  // The request as the old API knows it (by its key)
  const current = finance.oldRequestRecord(row);
  if (current.status !== 'pending') throw conflict('The request was decided already.');
  const reason = typeof body.rejectionReason === 'string' && body.rejectionReason.trim() ? body.rejectionReason : 'Kein Grund angegeben';
  await writeLogicalPath(`requests/${current.requestKey}`, { status: body.status, ...(body.status === 'rejected' ? { rejectionReason: reason } : {}) }, req.user, 'patch', {});
  broadcastDataUpdate();
  res.json(requestOf(await finance.getRequestRecord(context.appConfig, current.requestKey), await memberIdsByKey()));
}));

// The money as the app's statistics count it: booked up to today (with what has no readable day), the balance of that,
// and apart from it what is dated after today
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

// Newest first, a page at a time - asked of the database: the log grows with every booking and is kept ten years
router.get(`${BASE}/finance/changes`, verifyToken, handle(async (req, res) => {
  needs(canView(req) || req.user.admin === true);
  const area = req.query.area === undefined || req.query.area === '' ? null : req.query.area;
  if (area !== null && !CHANGE_AREAS.includes(area)) throw invalid(`area must be one of ${CHANGE_AREAS.join(', ')}.`);
  const { from, to } = daysOf(req);
  res.json(storedPage(await data.financeChangesPage({ area, member: idOfQuery(req, 'member'), from, to, limit: limitOf(req), after: storedCursorOf(req) })));
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
  const groups = (await listGroupRecords(context.appConfig)).map((group) => ({ id: group.id, name: group.name, permissions: group.permissions }));
  res.json(page(groups, req, (group) => sortable(group.name), { ascending: true }));
}));

// In the order they take place. Only the sign-ups and guests of the events of the page are read (seatsOf)
router.get(`${BASE}/events`, verifyToken, handle(async (req, res) => {
  const uid = uidOf(req);
  const { from, to } = daysOf(req);
  const { items, nextCursor } = page(await data.visibleEvents(req.user, { from, to }), req, (event) => `${event.date} ${event.startTime || ''}`, { ascending: true });
  const seats = await data.seatsOf(items.map((event) => event.id));
  res.json({
    items: items.map((event) => {
      const { registrations, guests } = seats.get(event.id);
      const mine = registrations.find((reg) => reg.user === uid && reg.status !== 'cancelled');
      return eventOf(event, seatCounts(registrations, guests), mine);
    }),
    nextCursor
  });
}));

router.get(`${BASE}/events/:id`, verifyToken, handle(async (req, res) => {
  const uid = uidOf(req);
  const event = await eventsStore.getEventRecord(context.appConfig, req.params.id);
  if (!event || !seesEvent(req.user, event)) throw notFound('Event');
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

// In the order of their titles (A to Z)
router.get(`${BASE}/songs`, verifyToken, handle(async (req, res) => {
  const songs = await createItemStore('songs').list(context.appConfig);
  res.json(page(songs.filter((song) => song && !Array.isArray(song)).map((song) => ({
    id: song.id, title: song.title || '', artist: song.artist || '', key: song.key || null, capo: song.capo ?? null, tempo: song.tempo ?? null,
    ccli: song.ccli || null, copyright: song.copyright || '', content: song.content || '', createdAt: isoFromMillis(song.createdAt), updatedAt: isoFromMillis(song.updatedAt)
  })), req, (song) => sortable(song.title), { ascending: true }));
}));

router.get(`${BASE}/mentoring/mentors`, verifyToken, handle(async (req, res) => {
  const [mentors, users] = await Promise.all([listMentorRecords(context.appConfig, 'status = "approved"'), listUserRecords(context.appConfig)]);
  const names = new Map(users.map((user) => [user.id, user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim()]));
  const items = mentors.map((mentor) => ({ id: mentor.id, userId: mentor.user, name: names.get(mentor.user) || '', bio: mentor.bio || '', maxMentees: mentor.max_mentees || 0, isAccepting: mentor.is_accepting === true }));
  res.json(page(items, req, (mentor) => sortable(mentor.name), { ascending: true }));
}));

/** The reader's conversations (none without an account id: the lookup would take that for "all of them"). */
async function threadsOf(req) {
  const uid = uidOf(req);
  return uid ? listMentoringThreadsForUser(context.appConfig, uid) : [];
}

/** The reader's conversations, the latest first: the mentee stays anonymous to the mentor (alias), as in v1. */
router.get(`${BASE}/mentoring/threads`, verifyToken, handle(async (req, res) => {
  const uid = uidOf(req);
  const items = (await threadsOf(req)).map((thread) => ({
    id: thread.id, role: thread.mentor === uid ? 'mentor' : 'mentee', mentorUserId: thread.mentor, menteeAlias: thread.mentee_alias,
    status: thread.status, lastMessage: thread.last_message || '', updatedAt: thread.updated || null
  }));
  res.json(page(items, req, (thread) => thread.updatedAt || ''));
}));

// Newest first, a page at a time - only the page is read and decrypted
router.get(`${BASE}/mentoring/threads/:id/messages`, verifyToken, handle(async (req, res) => {
  const thread = (await threadsOf(req)).find((candidate) => candidate.id === req.params.id);
  if (!thread) throw notFound('Conversation');
  // Reading here marks nothing as read (v1 does that when the app opens the conversation)
  const { items, next } = await data.messagesPage(thread.id, { limit: limitOf(req), after: storedCursorOf(req) });
  res.json(storedPage({
    items: items.map((message) => ({ id: message.id, from: message.sender_role, text: decryptMentoringText(message.text, thread.id), isRead: message.read === true, createdAt: message.created || null })),
    next
  }));
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

module.exports = { router, errorShape, errorHandler };
