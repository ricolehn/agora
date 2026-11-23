// The conventions of API v2 (docs/API_V2.md), shared by its areas (finance.js, events.js, community.js, media.js):
// errors as { error: { code, message } } in the language of the request, what a request sends checked and never cut or
// guessed, every list in pages with a cursor, and the way into the old API's handlers where v2 does what v1 does.
const { translate, requestLanguage } = require('../i18n');
const { httpError } = require('../httpError');

// --- Answers -------------------------------------------------------------------------------------------------------

const ERROR_CODES = { 400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 429: 'rate_limited', 503: 'unavailable' };
const codeOf = (status) => ERROR_CODES[status] || (status >= 500 ? 'server_error' : 'invalid');
const COULD_NOT = 'The request could not be handled.';
const CHANGED = 'The data changed meanwhile: read it again and repeat the change.';

/**
 * The body of an error answer: the English [message] (with its {placeholders} filled from [params]) in the language of
 * [req] - the one the app asks for (Accept-Language), else the person's own, else the instance's (i18n.js). The code
 * is what a client acts on; [field] names the value of the request that did not fit.
 */
function errorOf(req, status, message, params = null, field = null) {
  const text = translate(requestLanguage(req), message || COULD_NOT, params);
  return { error: { code: codeOf(status), message: text, ...(field ? { field } : {}) } };
}

const fail = (req, res, status, message, params, field) => res.status(status).json(errorOf(req, status, message, params, field));

/** An error of v2: the HTTP [status] and the English [message] (translated when it is answered, see errorOf). */
const apiError = (status, message, params = null, field = null) => httpError(status, message, { params, field });
const invalid = (message, params = null, field = null) => apiError(400, message, params, field);
const forbidden = (message = 'You may not do this.') => apiError(403, message);
const notFound = (message) => apiError(404, message);
const conflict = (message = CHANGED) => apiError(409, message);
const needs = (allowed, message) => {
  if (!allowed) throw forbidden(message);
};

// What a route of v2 answers when it throws: these statuses with their text, anything else is the server's own failure
const ANSWERED = new Set([400, 401, 403, 404, 409, 413, 429, 503]);

/** Runs [handler]; errors become { error: { code, message } } (409 for a conflicting change). */
const handle = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    const status = ANSWERED.has(err?.status) ? err.status : 500;
    if (status === 500) console.error(`[API v2] ${req.method} ${req.path} failed:`, err);
    if (res.headersSent) return;
    // A version that is no longer the current one (found below, by the stores) is answered with what to do
    const message = status === 500 ? COULD_NOT : status === 409 && (!err.message || err.message === 'Conflict') ? CHANGED : err.message;
    fail(req, res, status, message, status === 500 ? null : err.params, status === 500 ? null : err.field);
  }
};

/** [body] of an error answer in the shape of v2: kept when it has it, else its text (or its error's) is the message. */
function asError(req, status, body) {
  if (body?.error && typeof body.error === 'object' && typeof body.error.code === 'string') return body;
  const text = typeof body === 'string' ? body : typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : '';
  // What failed inside the server stays in its log
  return errorOf(req, status, status >= 500 && status !== 503 ? COULD_NOT : text.trim());
}

/**
 * Every error answer under /api/v2 in the shape of v2 and in the language of the request - also those given before a
 * route of v2 runs: no or no valid sign-in (401, a text until now), too many requests (429), a server that is starting
 * or not set up (503). Mounted ahead of everything that may answer there (server.js).
 */
function errorShape(req, res, next) {
  const json = res.json.bind(res);
  const send = res.send.bind(res);
  res.json = (body) => json(res.statusCode >= 400 ? asError(req, res.statusCode, body) : body);
  res.send = (body) => {
    // A text given as an error; Express' json() comes back here with its JSON text, which goes out as it is
    const isText = typeof body === 'string' || Buffer.isBuffer(body) || body === undefined;
    if (res.statusCode >= 400 && isText && !/json/i.test(String(res.get('Content-Type') || ''))) return json(asError(req, res.statusCode, body === undefined ? '' : String(body)));
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
  if (err?.type === 'entity.parse.failed') return fail(req, res, 400, 'The body is no valid JSON.');
  if (err?.type === 'entity.too.large') return fail(req, res, 413, 'The body is too large.');
  const status = Number(err?.status || err?.statusCode);
  if (status >= 400 && status < 500) return fail(req, res, status, err.expose ? err.message : '');
  console.error(`[API v2] ${req.method} ${req.originalUrl} failed:`, err);
  return fail(req, res, 500, COULD_NOT);
}

// --- What a request sends: checked, never cut or guessed ----------------------------------------------------------

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
// The largest amount of one entry, either way: 1,000,000,000.00. Far beyond any booking; whole cents stay exact in
// every sum of them (an amount like 1e300 was taken and left the member without a balance)
const MAX_AMOUNT_CENTS = 100000000000;
// Texts: a note or description as long as the books ever took one (a request's note is booked with it), names short
const TEXT_LIMITS = { description: 5000, note: 5000, donorName: 200, issuer: 200, rejectionReason: 500 };
const RECEIPT_LIMIT = 300;
const MAX_RECEIPTS = 20;

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
  if (!isCalendarDay(value)) throw invalid('{name} must be a day of the calendar, YYYY-MM-DD.', { name }, name);
  return value;
}

/** A day or nothing: null and '' take it away (''). */
function optionalDayInput(value, name) {
  if (value === null || value === '') return '';
  return dayInput(value, name);
}

function monthInput(value, name) {
  if (typeof value !== 'string' || !MONTH.test(value)) throw invalid('{name} must be a month, YYYY-MM.', { name }, name);
  return value;
}

function timeInput(value, name) {
  if (value === null || value === '') return '';
  if (typeof value !== 'string' || !TIME.test(value)) throw invalid('{name} must be a time of day, HH:mm.', { name }, name);
  return value;
}

function centsInput(value, name = 'amountCents') {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_AMOUNT_CENTS) throw invalid('{name} must be a whole number of cents, at most {max} either way.', { name, max: MAX_AMOUNT_CENTS }, name);
  return value;
}

/** A whole number from [min] to [max]. */
function wholeInput(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid('{name} must be a whole number from {min} to {max}.', { name, min, max }, name);
  return value;
}

function boolInput(value, name) {
  if (typeof value !== 'boolean') throw invalid('{name} must be true or false.', { name }, name);
  return value;
}

/** The text [key] of [body]: text of at most [limit] characters (null: empty). */
function textInput(body, key, limit = TEXT_LIMITS[key]) {
  const value = body[key];
  if (value === null) return '';
  if (typeof value !== 'string') throw invalid('{name} must be text.', { name: key }, key);
  if (value.length > limit) throw invalid('{name} is at most {limit} characters long.', { name: key, limit }, key);
  return value;
}

/** A text that must hold something (after trimming), of at most [limit] characters. */
function requiredTextInput(body, key, limit) {
  const value = body[key] === undefined ? '' : textInput(body, key, limit);
  if (!value.trim()) throw invalid('{name} is needed.', { name: key }, key);
  return value;
}

// eslint-disable-next-line no-control-regex
const isFileName = (value) => typeof value === 'string' && value.length > 0 && value.length <= RECEIPT_LIMIT && !/[\\/\x00-\x1f]/.test(value) && value !== '.' && value !== '..';

/** A receipt: the name of a file in the receipts folder; null or '' takes it away (null back). */
function receiptInput(value) {
  if (value === null || value === '') return null;
  if (!isFileName(value)) throw invalid('receipt must be the name of a file in the receipts folder.', null, 'receipt');
  return value;
}

/** The receipts of an entry: a list of names of files in the receipts folder ([] takes them away). */
function receiptsInput(value) {
  if (!Array.isArray(value) || value.length > MAX_RECEIPTS || !value.every(isFileName)) {
    throw invalid('receipts must be a list of at most {max} names of files in the receipts folder.', { max: MAX_RECEIPTS }, 'receipts');
  }
  return [...new Set(value)];
}

/**
 * The names a receipt field holds, as the web app reads it: one name, a list written as JSON ('["a.jpg","b.pdf"]', what
 * the web app writes), or names with commas between them (older versions).
 */
function receiptNames(field) {
  if (Array.isArray(field)) return field.filter((name) => typeof name === 'string' && name);
  const text = String(field ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[') && text.endsWith(']')) {
    try {
      const list = JSON.parse(text);
      if (Array.isArray(list)) return list.filter((name) => typeof name === 'string' && name);
    } catch { /* names with commas */ }
  }
  return text.split(',').map((name) => name.trim()).filter(Boolean);
}

/** The receipt field of [names], as the web app writes it (a list as JSON; none: ''). */
const receiptField = (names) => (names.length ? JSON.stringify(names) : '');

/**
 * The receipt field [body] asks for, or undefined when it says nothing about it: `receipts` (a list) or `receipt` (one
 * name - or what an app wrote into it, as it was taken until now). Both at once is refused.
 */
function receiptFieldInput(body) {
  if (body.receipts !== undefined && body.receipt !== undefined) throw invalid('Send receipt or receipts, not both.', null, 'receipts');
  if (body.receipts !== undefined) return receiptField(receiptsInput(body.receipts));
  if (body.receipt !== undefined) return receiptInput(body.receipt) || '';
  return undefined;
}

/** A record id [name] ([value]); without one: "is needed". */
function idInput(value, name) {
  if (value === undefined || value === null || value === '') throw invalid('{name} is needed: a record id.', { name }, name);
  if (typeof value !== 'string' || !ID.test(value)) throw invalid('{name} must be a record id.', { name }, name);
  return value;
}

/** The version [value] a change is based on; without one, [message] says which version is needed. */
function versionInput(value, name, message) {
  if (typeof value !== 'string' || !value) throw invalid(message, { name }, name);
  return value;
}

/** The id of a request a booking is for (null: none). */
function requestIdInput(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !ID.test(value)) throw invalid('requestId must be the id of a request.', null, 'requestId');
  return value;
}

/** One of [values] ([name]). */
function choiceInput(value, name, values) {
  if (!values.includes(value)) throw invalid('{name} must be one of {values}.', { name, values: values.join(', ') }, name);
  return value;
}

/** The days ?from= and ?to= of [req] (each optional; anything else than a day of the calendar is refused). */
function daysOf(req) {
  const day = (name) => (req.query[name] === undefined || req.query[name] === '' ? null : dayInput(req.query[name], name));
  return { from: day('from'), to: day('to') };
}

/** The record id ?[name]= of [req] (optional). */
const idOfQuery = (req, name) => (req.query[name] === undefined || req.query[name] === '' ? null : idInput(req.query[name], name));

// --- Search: ?q= -------------------------------------------------------------------------------------------------

/** A text as it is compared: without accents and case ("Ärger" next to "Arger", both before "Zora"). */
const sortable = (text) => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');

/** The words of ?q= (each must be found), or null without a search. */
function searchOf(req) {
  const q = req.query.q;
  if (q === undefined || q === '') return null;
  if (typeof q !== 'string' || q.length > 200) throw invalid('q is a text of at most 200 characters.', null, 'q');
  const words = sortable(q).split(/\s+/).filter(Boolean);
  return words.length ? words : null;
}

/** A day as it is searched for: as written (2026-05-05) and as people write it (05.05.2026, 5.5.2026). */
function dayTexts(day) {
  if (!DAY.test(String(day || ''))) return [];
  const [year, month, date] = day.split('-');
  return [day, `${date}.${month}.${year}`, `${Number(date)}.${Number(month)}.${year}`];
}

/** An amount as it is searched for: 25.50 and 25,50 (and 25 for whole euros). */
function amountTexts(cents) {
  if (!Number.isSafeInteger(cents)) return [];
  const euros = (Math.abs(cents) / 100).toFixed(2);
  const sign = cents < 0 ? '-' : '';
  return [`${sign}${euros}`, `${sign}${euros.replace('.', ',')}`, ...(cents % 100 === 0 ? [`${sign}${Math.abs(cents) / 100}`] : [])];
}

/** True when every word of [words] is in one of [texts] (null: no search, everything matches). */
function matchesSearch(words, texts) {
  if (!words) return true;
  const haystack = texts.filter((text) => text !== undefined && text !== null && text !== '').map(sortable).join('\n');
  return words.every((word) => haystack.includes(word));
}

// --- Pages: in a fixed order, cut after an item (not a position: an item added meanwhile shifts nothing) ---------

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** ?limit= of [req]: 1 to 500 (more counts as 500), 100 without. */
function limitOf(req) {
  const value = req.query.limit;
  if (value === undefined || value === '') return DEFAULT_LIMIT;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1) throw invalid('limit must be a whole number from 1 to {max}.', { max: MAX_LIMIT }, 'limit');
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
  if (!Array.isArray(key) || key.length !== 2 || !key.every((part) => typeof part === 'string')) throw invalid(INVALID_CURSOR, null, 'cursor');
  return key;
}

// A moment as the database keeps it ('2026-05-05 08:30:00.000Z'), or none
const STORED_MOMENT = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,9})?Z)?$/;

/** ?cursor= of a list paged by the database: [moment, id] as the database keeps them. */
function storedCursorOf(req) {
  const cursor = cursorOf(req);
  if (cursor && !(STORED_MOMENT.test(cursor[0]) && ID.test(cursor[1]))) throw invalid(INVALID_CURSOR, null, 'cursor');
  return cursor;
}

/** A page the database cut ({ items, next }, see v2Data.financeChangesPage) as v2 answers it. */
const storedPage = ({ items, next }) => ({ items, nextCursor: next ? encodeCursor(next) : null });

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

// --- The old API's handlers, where v2 does what v1 does ---------------------------------------------------------

/**
 * The route of [router] (one of the old API's) for [method] [path]: its checks (the permissions, the rate limit) and its
 * handler, as v1 runs them - without the sign-in, which v2 has checked already.
 */
function v1Route(router, method, path) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`API v2: the old API has no route ${method} ${path}`);
  const { verifyToken } = require('../context');
  return layer.route.stack.map((entry) => entry.handle).filter((fn) => fn !== verifyToken);
}

/**
 * Runs the old API's route [route] (v1Route) for this call of v2 - the same checks, writes and notifications as v1 -
 * with [params], [body] and [query] in the shapes v1 takes. Resolves with what v1 answered ({ status, body }) when it
 * succeeded; what v1 refused is thrown as an error of v2 (its status and its text, translated when it is answered).
 */
function runV1(route, req, { params = {}, body = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const own = (value) => ({ value, writable: true, enumerable: true, configurable: true });
    const inner = Object.create(req, { params: own(params), body: own(body), query: own(query) });
    let status = 200;
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      if (status < 400) return resolve({ status, body: payload });
      const text = typeof payload === 'string' ? payload : typeof payload?.error === 'string' ? payload.error : typeof payload?.message === 'string' ? payload.message : '';
      if (status >= 500) console.error(`[API v2] ${req.method} ${req.path}: the old API's handler failed (${status}): ${text}`);
      return reject(apiError(ANSWERED.has(status) ? status : 500, status >= 500 && status !== 503 ? COULD_NOT : text));
    };
    const res = {
      get statusCode() { return status; },
      set statusCode(code) { status = code; },
      headersSent: false,
      locals: {},
      status(code) { status = code; return this; },
      json: finish,
      send: finish,
      end: () => finish(undefined),
      sendStatus(code) { status = code; finish(undefined); return this; },
      setHeader() { return this; },
      set() { return this; },
      header() { return this; },
      type() { return this; },
      get() { return undefined; },
      getHeader() { return undefined; },
      on() { return this; },
      once() { return this; }
    };
    const steps = [...route];
    const next = (err) => {
      if (done) return;
      if (err) {
        done = true;
        reject(err);
        return;
      }
      const step = steps.shift();
      if (!step) {
        finish(undefined);
        return;
      }
      Promise.resolve().then(() => step(inner, res, next)).catch((error) => {
        if (!done) {
          done = true;
          reject(error);
        }
      });
    };
    next();
  });
}

/**
 * Runs the steps of an old API's route ([steps], v1Route) on this very request: a file goes out or comes in as v1 sends
 * and takes it (errorShape gives what it refuses the shape of v2).
 */
function runSteps(steps, req, res) {
  const queue = [...steps];
  const next = (err) => {
    if (err) {
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.status ? err.message : COULD_NOT });
      return;
    }
    const step = queue.shift();
    if (step) Promise.resolve(step(req, res, next)).catch(next);
  };
  next();
}

module.exports = {
  COULD_NOT,
  CHANGED,
  errorOf,
  fail,
  apiError,
  invalid,
  forbidden,
  notFound,
  conflict,
  needs,
  handle,
  errorShape,
  errorHandler,
  DAY,
  ID,
  MAX_AMOUNT_CENTS,
  TEXT_LIMITS,
  bodyOf,
  isCalendarDay,
  dayInput,
  optionalDayInput,
  monthInput,
  timeInput,
  centsInput,
  wholeInput,
  boolInput,
  textInput,
  requiredTextInput,
  receiptInput,
  receiptsInput,
  receiptNames,
  receiptField,
  receiptFieldInput,
  idInput,
  versionInput,
  requestIdInput,
  choiceInput,
  daysOf,
  idOfQuery,
  sortable,
  searchOf,
  dayTexts,
  amountTexts,
  matchesSearch,
  limitOf,
  cursorOf,
  storedCursorOf,
  storedPage,
  page,
  v1Route,
  runV1,
  runSteps
};
