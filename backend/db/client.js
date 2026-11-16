// The connection to PocketBase: requests as the server's superuser, a read cache, and the record helpers every store
// uses. The apps never talk to PocketBase themselves; everything goes through these functions.
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolvePocketBaseDirectory } = require('../pathConfig');

const execFileAsync = promisify(execFile);

const SUPERUSER_TOKEN_TTL_MS = 300_000; // 5 minutes
let cachedSuperuserToken = null;
let cachedSuperuserTokenExpiry = 0;

function getPocketBaseBaseUrl() {
  return process.env.POCKETBASE_BASE_URL || `http://127.0.0.1:${process.env.POCKETBASE_PORT || '8090'}`;
}

function getPocketBaseBinaryPath() {
  return process.env.POCKETBASE_BIN || path.join(__dirname, '..', '..', 'pocketbase');
}

function getPocketBaseDataDir() {
  return resolvePocketBaseDirectory();
}


function buildPocketBaseError(response, fallback) {
  const details = response?.data && typeof response.data === 'object'
    ? Object.values(response.data)
        .map((entry) => entry?.message)
        .find((message) => typeof message === 'string' && message.trim())
    : null;
  const error = new Error(details || response?.message || fallback || 'PocketBase request failed');
  error.status = response?.status || 500;
  error.response = response || null;
  return error;
}

// --- Read cache ---
// The apps only reach PocketBase through this server, and every request goes through pocketBaseRequest: record
// reads (as superuser) are kept in memory per collection and dropped the moment anything in that collection is
// written. Each collection has a generation: a read that started before a write is not kept. READ_CACHE_TTL_MS
// covers changes made outside the app (PocketBase's admin page). The answer is kept as PocketBase's JSON text and
// parsed for every caller: each gets its own objects (three times faster than copying them).
const READ_CACHE_TTL_MS = 30 * 1000;
const READ_CACHE_MAX_ENTRIES = 400;
const readCache = new Map();
const readGenerations = new Map();
const recordsPath = /^\/api\/collections\/([^/?]+)\/records(?:[/?]|$)/;

function collectionOf(path) {
  return recordsPath.exec(path)?.[1] || null;
}

// Counts every write the server makes (and every forgetting of the cache): results worked out from the data are valid
// as long as it has not changed
let writes = 0;
// Bumped when every collection is forgotten at once (a change of the schema, a write the server cannot place)
let everything = 0;
const writeGeneration = () => writes;
const generationOf = (collection) => `${everything}:${readGenerations.get(collection) || 0}`;

// The newest writes in order: { seq, collections (null: all of them), tag }. What was worked out from the data (the
// members with their balances, stores/finance.js) is brought up to date by them instead of being worked out anew -
// a save names the members it changed in its tag. Older entries are dropped: a reader that missed them starts over.
const CHANGES_KEPT = 5000;
const changes = [];

/** The writes since [seq] ({ complete: false } when some of them are no longer known). */
function changesSince(seq) {
  const first = changes.length ? changes[0].seq : writes + 1;
  return { complete: seq >= first - 1, list: changes.filter((change) => change.seq > seq) };
}

/** Forgets the cached reads of [collections] (a name or a list; all collections without one); [tag] says what changed. */
function invalidateReadCache(collections, tag = null) {
  writes += 1;
  const list = collections === undefined || collections === null ? null : [...new Set([].concat(collections))];
  changes.push({ seq: writes, collections: list, tag });
  if (changes.length > CHANGES_KEPT) changes.splice(0, changes.length - CHANGES_KEPT);
  if (!list) {
    everything += 1;
    readCache.clear();
    return;
  }
  for (const collection of list) {
    readCache.delete(collection);
    readGenerations.set(collection, (readGenerations.get(collection) || 0) + 1);
  }
}

// --- Which cached reads a write changes -----------------------------------------------------------------------
// A write of a record changes its collection and the views that read it. A delete changes more: PocketBase deletes
// the records that link to it with cascadeDelete and empties the links of the others - and so on, along the links.
// Worked out once from the schema. Forgetting every collection on every delete and batch (as before) made the read
// of all members after any delete - a prayer request, a push device - read 108,000 payments again: 2.4 s instead of 0.3 s.
let dependency = null;

function dependencies() {
  if (dependency) return dependency;
  const schema = require('./schema');
  const linkedFrom = new Map();
  const viewsOf = new Map();
  const add = (map, key, value) => (map.get(key) || map.set(key, new Set()).get(key)).add(value);
  const specs = [...schema.allCollections(), { name: 'users', fields: schema.USERS_FIELDS }];
  for (const spec of specs) {
    for (const field of spec.fields || []) if (field.type === 'relation' && field.target) add(linkedFrom, field.target, spec.name);
  }
  const known = new Set(specs.map((spec) => spec.name));
  for (const view of schema.allViews()) {
    known.add(view.name);
    for (const [, name] of String(view.viewQuery).matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_]\w*)/gi)) add(viewsOf, name, view.name);
  }
  dependency = { linkedFrom, viewsOf, known };
  return dependency;
}

/** The collections whose cached reads a write to [collection] changes ([deleted]: a record of it was deleted); null: all. */
function touchedBy(collection, deleted) {
  const { linkedFrom, viewsOf, known } = dependencies();
  // A table this server does not know the links of (an old table, one built during the upgrade): everything
  if (!known.has(collection)) return deleted ? null : [collection];
  const touched = new Set([collection]);
  const queue = [collection];
  while (queue.length) {
    const name = queue.shift();
    // Views, and the views that read those
    for (const view of viewsOf.get(name) || []) {
      if (touched.has(view)) continue;
      touched.add(view);
      queue.push(view);
    }
    if (!deleted) continue;
    for (const linking of linkedFrom.get(name) || []) {
      if (touched.has(linking)) continue;
      touched.add(linking);
      queue.push(linking);
    }
  }
  return [...touched];
}

/** What a request with [method] to [path] (and [body]) changes: the collections (null: all of them), or false for nothing. */
function touchedByRequest(method, path, body) {
  if (path === '/api/batch') {
    const requests = Array.isArray(body?.requests) ? body.requests : [];
    const touched = new Set();
    for (const request of requests) {
      const name = collectionOf(String(request?.url || ''));
      const own = name && touchedBy(name, String(request?.method || '').toUpperCase() === 'DELETE');
      if (!own) return null;
      for (const collection of own) touched.add(collection);
    }
    return [...touched];
  }
  const collection = collectionOf(path);
  if (collection) return touchedBy(collection, method === 'DELETE');
  // Auth actions of a collection (a login only touches "users")
  const own = /^\/api\/collections\/([^/?]+)\/[^/?]/.exec(path)?.[1];
  if (own) return [own];
  // Schema changes: everything; anything else (settings, backups, health) changes no records
  return path.startsWith('/api/collections') ? null : false;
}

const parseCached = (text) => (text === null ? null : JSON.parse(text));

async function cachedRead(collection, key, load) {
  let entries = readCache.get(collection);
  const hit = entries?.get(key);
  if (hit && Date.now() - hit.at < READ_CACHE_TTL_MS) return parseCached(await hit.value);
  const generation = generationOf(collection);
  const value = load();
  if (!entries) readCache.set(collection, (entries = new Map()));
  if (entries.size >= READ_CACHE_MAX_ENTRIES) entries.clear();
  const entry = { at: Date.now(), value };
  entries.set(key, entry);
  try {
    const result = await value;
    // Written meanwhile (or failed): not kept
    if (generationOf(collection) !== generation && readCache.get(collection)?.get(key) === entry) readCache.get(collection).delete(key);
    return parseCached(result);
  } catch (err) {
    if (readCache.get(collection)?.get(key) === entry) readCache.get(collection).delete(key);
    throw err;
  }
}

/**
 * A request to PocketBase. Reads as superuser go through the read cache (options.cache === false: not kept - a read of a
 * whole large table whose result is kept elsewhere); writes forget what they change (see touchedByRequest), before and
 * after: a read running alongside the write is not kept either way. [options.tag] names what a write changed.
 */
async function pocketBaseRequest(path, options = {}) {
  const method = options.method || 'GET';
  const collection = collectionOf(path);
  if (method === 'GET' && collection && options.token && options.token === cachedSuperuserToken && options.cache !== false) {
    return cachedRead(collection, `${path}|${options.allow404 ? 1 : 0}`, () => sendPocketBaseRequest(path, { ...options, rawText: true }));
  }
  if (method !== 'GET') {
    const touched = touchedByRequest(method, path, options.body);
    if (touched !== false) invalidateReadCache(touched, options.tag || null);
    try {
      return await sendPocketBaseRequest(path, options);
    } finally {
      if (touched !== false) invalidateReadCache(touched, options.tag || null);
    }
  }
  return sendPocketBaseRequest(path, options);
}

async function sendPocketBaseRequest(path, options = {}) {
  const {
    method = 'GET',
    token,
    body,
    allow404 = false,
    headers = {}
  } = options;

  const requestHeaders = { ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined && !requestHeaders['Content-Type']) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${getPocketBaseBaseUrl()}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  // The read cache keeps the text itself (see cachedRead)
  if (options.rawText && response.ok) return text || 'null';
  if (options.rawText && allow404 && response.status === 404) return null;
  const payload = text ? (() => {
    try {
      return JSON.parse(text);
    } catch {
      return { message: text, status: response.status };
    }
  })() : null;

  if (!response.ok) {
    if (allow404 && response.status === 404) return null;
    throw buildPocketBaseError(payload, `PocketBase ${method} ${path} failed`);
  }

  return payload;
}

async function authenticateSuperuser(appConfig) {
  if (!appConfig?.pocketbase?.adminEmail || !appConfig?.pocketbase?.adminPassword) {
    throw new Error('PocketBase superuser credentials are missing.');
  }

  const now = Date.now();
  if (cachedSuperuserToken && now < cachedSuperuserTokenExpiry) {
    return cachedSuperuserToken;
  }

  const auth = await pocketBaseRequest('/api/collections/_superusers/auth-with-password', {
    method: 'POST',
    body: {
      identity: appConfig.pocketbase.adminEmail,
      password: appConfig.pocketbase.adminPassword
    }
  });

  cachedSuperuserToken = auth.token;
  cachedSuperuserTokenExpiry = now + SUPERUSER_TOKEN_TTL_MS;
  return auth.token;
}

function clearSuperuserTokenCache() {
  cachedSuperuserToken = null;
  cachedSuperuserTokenExpiry = 0;
}

async function ensurePocketBaseSuperuser(appConfig) {
  if (!appConfig?.pocketbase?.adminEmail || !appConfig?.pocketbase?.adminPassword) {
    throw new Error('PocketBase superuser credentials are missing.');
  }

  const binary = getPocketBaseBinaryPath();
  const dir = getPocketBaseDataDir();
  const args = [
    '--dir',
    dir,
    'superuser',
    'upsert',
    '--', // e-mail and password are values even when they start with "-"
    appConfig.pocketbase.adminEmail,
    appConfig.pocketbase.adminPassword
  ];

  console.log(`[PocketBase] Running superuser upsert with binary: ${binary}, dir: ${dir}, email: ${appConfig.pocketbase.adminEmail}`);
  // The upsert sets the password anew, and with it every token of the superuser ends: one kept from an earlier start
  // of this server (a start that failed is tried again by the same process) would be refused for the rest of its
  // five minutes - every try in that time failed with "The request requires valid record authorization token."
  clearSuperuserTokenCache();
  try {
    const { stdout, stderr } = await execFileAsync(binary, args);
    console.log(`[PocketBase] Superuser upsert stdout: ${stdout.trim()}`);
    if (stderr.trim()) {
      console.warn(`[PocketBase] Superuser upsert stderr: ${stderr.trim()}`);
    }
  } catch (error) {
    console.error(`[PocketBase] Superuser upsert failed! Error:`, error);
    throw error;
  }
}


/**
 * Every record of [collectionName] that matches [filter], in [sort] order (else in the order they were made).
 * [fields]: only these fields; [cache]: false for a read of a whole large table whose result is kept elsewhere - it is
 * not kept in the read cache, and its pages come a few at a time (all of them at once held every page's text in memory
 * together: 109 pages of payments at 300 members over 30 years).
 */
const SCAN_PAGES_AT_ONCE = 6;
async function listAllRecords(collectionName, filter, appConfig, sort = '', { fields = '', cache = true } = {}) {
  const token = await authenticateSuperuser(appConfig);
  // PocketBase's largest page. The first page counts the records (one COUNT), the others come in parallel
  // without counting - they used to be 200 at a time, one after another, each with its own COUNT
  const perPage = 1000;
  const pageUrl = (page, count) => {
    const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
    if (!count) params.set('skipTotal', '1');
    if (filter) params.set('filter', filter);
    if (fields) params.set('fields', fields);
    // Pages fetched side by side need a fixed order: without a sort it is PocketBase's own (insertion) order, named
    params.set('sort', sort || '@rowid');
    return `/api/collections/${collectionName}/records?${params.toString()}`;
  };
  const first = await pocketBaseRequest(pageUrl(1, true), { token, cache });
  const items = [...(first.items || [])];
  const pages = Number(first.totalPages) || 1;
  if (pages > 1 && cache) {
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => pocketBaseRequest(pageUrl(i + 2, false), { token, cache })));
    for (const result of rest) items.push(...(result.items || []));
  } else if (pages > 1) {
    for (let start = 2; start <= pages; start += SCAN_PAGES_AT_ONCE) {
      const pagesNow = Array.from({ length: Math.min(SCAN_PAGES_AT_ONCE, pages - start + 1) }, (_, i) => start + i);
      const results = await Promise.all(pagesNow.map((page) => pocketBaseRequest(pageUrl(page, false), { token, cache })));
      for (const result of results) for (const item of result.items || []) items.push(item);
    }
  }
  return items;
}

function pbFilterEquals(field, value) {
  return `${field} = ${JSON.stringify(String(value))}`;
}

async function getFirstRecord(collectionName, filter, appConfig, sort = '') {
  const token = await authenticateSuperuser(appConfig);
  const params = new URLSearchParams({ page: '1', perPage: '1', skipTotal: '1', filter });
  if (sort) params.set('sort', sort);
  const result = await pocketBaseRequest(`/api/collections/${collectionName}/records?${params.toString()}`, { token });
  return result.items?.[0] || null;
}

/**
 * The first [perPage] records of [collectionName] that match [filter], in [sort] order - one page, nothing counted.
 * For pages that start after an item (API v2): the filter says where, an index in the sort's order keeps it short.
 */
async function listRecordsPage(collectionName, filter, appConfig, { sort = '', perPage = 100 } = {}) {
  const token = await authenticateSuperuser(appConfig);
  const params = new URLSearchParams({ page: '1', perPage: String(perPage), skipTotal: '1' });
  if (filter) params.set('filter', filter);
  if (sort) params.set('sort', sort);
  const result = await pocketBaseRequest(`/api/collections/${collectionName}/records?${params.toString()}`, { token });
  return result.items || [];
}

// --- Values of json fields ---
// PocketBase reads a string written to a json field as JSON when it is JSON: "1771345242762" comes back as the number
// 1771345242762, "true" as true, "[1]" as a list. The web app gives standing orders ids like "1771345242762": they came
// back from the new tables as numbers, and the upgrade's comparison failed on every member with a standing order. In
// the tables of the new structure a string therefore goes to PocketBase as its JSON text, which PocketBase reads back
// as exactly that string. (users keeps PocketBase's reading: it is the old table, shared with the previous backend.)
let jsonFields = null;

/** The json fields of the table stored as [collection] (also under the name an upgrade builds it under). */
function jsonFieldsOf(collection) {
  if (!jsonFields) {
    const { allCollections } = require('./schema');
    const { buildingName } = require('./schemaApply');
    jsonFields = new Map();
    for (const spec of allCollections()) {
      const names = (spec.fields || []).filter((field) => field.type === 'json').map((field) => field.name);
      if (names.length) for (const stored of [spec.name, buildingName(spec.name)]) jsonFields.set(stored, names);
    }
  }
  return jsonFields.get(collection) || [];
}

/** [body] of a record of [collection] as PocketBase has to get it: a string in a json field as its JSON text. */
function forPocketBase(collection, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body instanceof FormData) return body;
  let sent = body;
  for (const field of jsonFieldsOf(collection)) {
    if (typeof body[field] !== 'string') continue;
    if (sent === body) sent = { ...body };
    sent[field] = JSON.stringify(body[field]);
  }
  return sent;
}

// [tag] (optional) says what the write changed, for what was worked out from the data (see invalidateReadCache)
async function createRecord(collectionName, body, appConfig, { tag = null } = {}) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${collectionName}/records`, {
    method: 'POST',
    token,
    tag,
    body: forPocketBase(collectionName, body)
  });
}

async function updateRecord(collectionName, recordId, body, appConfig, { tag = null } = {}) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${collectionName}/records/${encodeURIComponent(recordId)}`, {
    method: 'PATCH',
    token,
    tag,
    body: forPocketBase(collectionName, body)
  });
}

async function deleteRecord(collectionName, recordId, appConfig, { tag = null } = {}) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${collectionName}/records/${encodeURIComponent(recordId)}`, {
    method: 'DELETE',
    token,
    tag
  });
}

/** The record [id] of [collectionName], or null. */
async function getRecord(collectionName, id, appConfig) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${collectionName}/records/${encodeURIComponent(id)}`, { token, allow404: true });
}

/** A new PocketBase record id (15 lowercase letters and digits), made here so records of one batch can link each other. */
function newRecordId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(15), (byte) => alphabet[byte % alphabet.length]).join('');
}

/** A filter that matches any of [values] for [field] (false for none: nothing matches). */
function pbFilterIn(field, values) {
  const list = [...new Set((values || []).map(String))];
  return list.length ? `(${list.map((value) => pbFilterEquals(field, value)).join(' || ')})` : 'id = "" && id != ""';
}

// --- Batches: several writes as one transaction (all or nothing) ---
// PocketBase runs a batch in one database transaction: when one request fails, none of them is kept. The setting is
// off by default; ensureBatchSettings switches it on (with room for a member's whole history in one batch).
// One member's save (payments, status periods, standing orders and their change log rows) must be one transaction:
// even importing hundreds of payments at once stays far below this
const BATCH_MAX_REQUESTS = 5000;

async function ensureBatchSettings(appConfig) {
  const token = await authenticateSuperuser(appConfig);
  const settings = await pocketBaseRequest('/api/settings', { token });
  const batch = settings?.batch || {};
  if (batch.enabled === true && Number(batch.maxRequests) >= BATCH_MAX_REQUESTS && Number(batch.timeout) >= 30) return;
  await pocketBaseRequest('/api/settings', {
    method: 'PATCH',
    token,
    body: { batch: { ...batch, enabled: true, maxRequests: BATCH_MAX_REQUESTS, timeout: 30, maxBodySize: batch.maxBodySize || 0 } }
  });
}

/**
 * Runs [requests] ({ method, collection, id?, body? }) as one transaction and returns PocketBase's results (one per
 * request, in order). More than BATCH_MAX_REQUESTS are refused: a caller that writes that much splits it on purpose.
 */
async function batchWrite(appConfig, requests, { tag = null } = {}) {
  if (!requests.length) return [];
  if (requests.length > BATCH_MAX_REQUESTS) throw new Error(`A batch holds at most ${BATCH_MAX_REQUESTS} requests (${requests.length} given).`);
  const token = await authenticateSuperuser(appConfig);
  const body = {
    requests: requests.map(({ method, collection, id, body: recordBody }) => ({
      method,
      url: `/api/collections/${collection}/records${id ? `/${encodeURIComponent(id)}` : ''}`,
      ...(recordBody !== undefined ? { body: forPocketBase(collection, recordBody) } : {})
    }))
  };
  let results;
  try {
    results = await pocketBaseRequest('/api/batch', { method: 'POST', token, body, tag });
  } catch (error) {
    // PocketBase names the request that failed and why (by its place in the batch)
    const failed = error.response?.data?.requests || {};
    const first = Object.entries(failed)[0];
    if (first) {
      const [index, detail] = first;
      const request = requests[Number(index)] || {};
      error.message = `${error.message} Request ${index} (${request.method} ${request.collection}${request.id ? `/${request.id}` : ''}): ${detail?.response?.message || detail?.message || ''} ${JSON.stringify(detail?.response?.data || detail?.data || {}).slice(0, 500)}`;
    }
    throw error;
  }
  return (Array.isArray(results) ? results : []).map((result) => result?.body ?? null);
}

// Writes that need not be one transaction (the upgrade's copy: it is checked as a whole afterwards) go in batches of
// this size. 5000 inserts took up to 2.4 s on a fast server against PocketBase's batch timeout of 30 s - slow storage
// and a large instance could reach it, and every attempt of the upgrade then failed the same way.
const COPY_BATCH_REQUESTS = 1000;

/** Writes [requests] in batches of COPY_BATCH_REQUESTS, one after the other (each batch is one transaction). */
async function writeInBatches(appConfig, requests) {
  for (let start = 0; start < requests.length; start += COPY_BATCH_REQUESTS) {
    await batchWrite(appConfig, requests.slice(start, start + COPY_BATCH_REQUESTS));
  }
}

// --- Collections, settings and backups (the schema and the upgrade) ---

async function getCollection(appConfig, nameOrId) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${encodeURIComponent(nameOrId)}`, { token, allow404: true });
}

async function listCollections(appConfig) {
  const token = await authenticateSuperuser(appConfig);
  const items = [];
  for (let page = 1; ; page += 1) {
    const result = await pocketBaseRequest(`/api/collections?page=${page}&perPage=200&sort=name`, { token });
    items.push(...(result.items || []));
    if (page >= (Number(result.totalPages) || 1)) break;
  }
  return items;
}

async function createCollection(appConfig, body) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest('/api/collections', { method: 'POST', token, body });
}

async function updateCollection(appConfig, nameOrId, body) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${encodeURIComponent(nameOrId)}`, { method: 'PATCH', token, body });
}

async function deleteCollection(appConfig, nameOrId) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/collections/${encodeURIComponent(nameOrId)}`, { method: 'DELETE', token, allow404: true });
}

/** Counts the records of [collectionName] that match [filter] (one COUNT, no records). */
async function countRecords(collectionName, filter, appConfig) {
  const token = await authenticateSuperuser(appConfig);
  const params = new URLSearchParams({ page: '1', perPage: '1', fields: 'id' });
  if (filter) params.set('filter', filter);
  const result = await pocketBaseRequest(`/api/collections/${collectionName}/records?${params.toString()}`, { token });
  return Number(result.totalItems) || 0;
}

/** Makes a full backup (PocketBase's zip of the data folder, kept in <data folder>/backups) named [name]. */
async function createBackup(appConfig, name) {
  const token = await authenticateSuperuser(appConfig);
  await pocketBaseRequest('/api/backups', { method: 'POST', token, body: { name } });
}

async function listBackups(appConfig) {
  const token = await authenticateSuperuser(appConfig);
  return (await pocketBaseRequest('/api/backups', { token })) || [];
}

async function deleteBackup(appConfig, key) {
  const token = await authenticateSuperuser(appConfig);
  return pocketBaseRequest(`/api/backups/${encodeURIComponent(key)}`, { method: 'DELETE', token, allow404: true });
}

module.exports = {
  getPocketBaseBaseUrl,
  getPocketBaseBinaryPath,
  getPocketBaseDataDir,
  buildPocketBaseError,
  invalidateReadCache,
  writeGeneration,
  changesSince,
  touchedBy,
  pocketBaseRequest,
  authenticateSuperuser,
  clearSuperuserTokenCache,
  ensurePocketBaseSuperuser,
  listAllRecords,
  pbFilterEquals,
  pbFilterIn,
  getFirstRecord,
  listRecordsPage,
  getRecord,
  newRecordId,
  createRecord,
  updateRecord,
  deleteRecord,
  countRecords,
  ensureBatchSettings,
  batchWrite,
  writeInBatches,
  BATCH_MAX_REQUESTS,
  COPY_BATCH_REQUESTS,
  getCollection,
  listCollections,
  createCollection,
  updateCollection,
  deleteCollection,
  createBackup,
  listBackups,
  deleteBackup
};
