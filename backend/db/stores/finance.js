// The books in the new structure: finance_members with their payments, status periods and standing orders, donations,
// expenses, requests, the fees over time and the fresh starts.
//
// The rest of the server and the old API keep calling the functions they always called (listPeopleRecords,
// upsertPeopleRecord, getStateValue('donations'), ...) and get exactly the shapes they always got: this store rebuilds
// the old records from its tables (codecs/finance.js) and runs the same functions on them (legacyShapes.js) - how a
// member is put together, how payments are sorted, how a balance is worked out. No second calculation of money.
//
// Writes go to PocketBase as one batch (all or nothing): a member with all the payments that changed with it.
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const client = require('../client');
const { currentActor } = require('../../actor');
const codecs = require('../codecs/finance');
const shapes = require('../legacyShapes');
const { queueRecordWrite } = require('../writeQueue');
const { readFeeState, changeFeeSchedule, changeFeeResets, saveFeeSettings } = require('../../feeState');
const { normalizeFeeSchedule, normalizeFeeScheduleLog, FEE_SCHEDULE_STATE_KEY } = require('../../feeSchedule');
const { normalizeFeeResets, normalizeFeeResetLog, FEE_RESET_STATE_KEY } = require('../../feeReset');
const { toDateStr } = require('../../utils/date');
const { toCents, fromCents } = require('../codec');
const { DEFAULT_SETTINGS } = require('../defaults');

const MEMBERS = 'finance_members';
const PAYMENTS = 'finance_payments';
const PERIODS = 'finance_status_periods';
const STANDING_ORDERS = 'finance_standing_orders';
const DONATIONS = 'finance_donations';
const EXPENSES = 'finance_expenses';
const REQUESTS = 'finance_requests';
const FEE_CHANGES = 'finance_fee_changes';
const FRESH_STARTS = 'finance_fresh_starts';
const CHANGES = 'finance_changes';
const SETTINGS = 'system_settings';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const has = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
const originalOf = (row) => (row?.original && typeof row.original === 'object' ? row.original : {});
/** A new PocketBase record id (15 lowercase letters and digits), made here so records of one batch can link each other. */
const { newRecordId } = client;
const byRowid = (records) => records; // listAllRecords sorts by @rowid (the order records were written in)

// --- Links: which accounts and members exist (codecs keep a link to something that is gone in `original`) ---

async function linkContext(appConfig, extraMembers = []) {
  const [users, members] = await Promise.all([
    client.listAllRecords('users', '', appConfig, '', { fields: 'id' }),
    client.listAllRecords(MEMBERS, '', appConfig, '', { fields: 'id' })
  ]);
  const ids = { users: new Set(users.map((record) => record.id)), finance_members: new Set([...members.map((record) => record.id), ...extraMembers]) };
  return { exists: (collection, id) => Boolean(ids[collection]?.has(id)) };
}

// --- Rebuilding the old records ---------------------------------------------------------------------------------

/** The key the apps and the old API know a member by (people/<key>). */
const keyOfMember = (row) => (typeof originalOf(row).key === 'string' ? originalOf(row).key : row.id);
/** A member record that only holds payments of a member that never had a record (kept, never shown, as before). */
const isOrphan = (row) => originalOf(row).orphan === true;

// The old child records were sorted by their own date column; where an old record's column disagreed with its copy,
// original.columns keeps it (the order stays the same)
// The old records of a member's payments and status periods, as the old server's functions get them. Their old key
// (a hash) is worked out only when something reads it - only ever for entries without an id (the order of two on the
// same day); working it out for every payment of every read took a sixth of the time.
const ROW = Symbol('row');
const KEY = Symbol('key');
const storedKey = (record, prefix) => {
  const row = record[ROW];
  if (record[KEY] === undefined) record[KEY] = typeof originalOf(row).key === 'string' ? originalOf(row).key : shapes.buildStableChildKey(prefix, record.personKey, record.data.id, 0, record.data);
  return record[KEY];
};

class OldPaymentRecord {
  constructor(row, personKey) {
    const data = codecs.payment.decode(row);
    const columns = originalOf(row).columns || {};
    this.id = row.id;
    this.personKey = personKey;
    this.amount = shapes.toFiniteNumber(data.amount);
    this.date = has(columns, 'date') ? columns.date : shapes.toOptionalText(data.date);
    this.description = shapes.toOptionalText(data.description);
    this.data = data;
    this[ROW] = row;
  }

  get paymentKey() {
    return storedKey(this, 'payment');
  }
}

class OldStatusRecord {
  constructor(row, personKey) {
    const data = codecs.statusPeriod.decode(row);
    const columns = originalOf(row).columns || {};
    this.id = row.id;
    this.personKey = personKey;
    this.status = shapes.toOptionalText(data.status);
    this.startDate = has(columns, 'startDate') ? columns.startDate : shapes.toOptionalText(data.startDate);
    this.endDate = shapes.toOptionalText(data.endDate);
    this.data = data;
    this[ROW] = row;
  }

  get historyKey() {
    return storedKey(this, 'status');
  }
}

const oldPaymentRecord = (row, personKey) => new OldPaymentRecord(row, personKey);
const oldStatusRecord = (row, personKey) => new OldStatusRecord(row, personKey);

/**
 * The old "people" record of a member: its list columns (personKey, uid, name, status, the membership days, totalPaid)
 * and the record's own copy (data). Where the list columns of an old record disagreed with its copy, `original.columns`
 * keeps them - code that read the columns gets what it always got.
 */
function oldPeopleRecord(row, standingOrderRows = [], paymentRows = [], { decodedPayments = null } = {}) {
  const effective = codecs.member.decode(row);
  const columns = originalOf(row).columns || {};
  const data = { ...effective };
  // Standing orders kept as something else than a list were none for the old server either (hydratePersonRecord)
  data.standingOrders = has(originalOf(row), 'standingOrders') ? originalOf(row).standingOrders : standingOrderRows.map((order) => codecs.standingOrder.decode(order));
  const column = (key) => (has(columns, key) ? columns[key] : shapes.toOptionalText(effective[key]));
  return {
    id: row.id,
    collectionName: 'people',
    personKey: keyOfMember(row),
    uid: column('uid'),
    name: column('name'),
    status: column('status'),
    memberSince: column('memberSince'),
    originalMemberSince: has(columns, 'originalMemberSince') ? columns.originalMemberSince : shapes.toOptionalText(effective.originalMemberSince || effective.memberSince),
    totalPaid: has(columns, 'totalPaid') ? columns.totalPaid : shapes.calculateTotalPaid(decodedPayments || paymentRows.map((payment) => codecs.payment.decode(payment))),
    data,
    created: row.created,
    updated: row.updated
  };
}

// What the reads of the members need of their child records (the whole table is read for a list of all members:
// leaving out PocketBase's own fields makes it a third smaller to send and to parse)
const READ_FIELDS = {
  [PAYMENTS]: 'id,member,clientId,amountCents,date,description,receipt,source,original',
  [PERIODS]: 'id,member,clientId,status,startDate,endDate,original',
  [STANDING_ORDERS]: 'id,member,clientId,amountCents,startDate,endDate,note,lastAutoPayment,position,original'
};

/** Records of [collection] belonging to the members [memberIds] (all members: one read of the whole table). */
async function rowsOfMembers(appConfig, collection, memberIds) {
  if (!memberIds.length) return [];
  if (memberIds.length === 1) return client.listAllRecords(collection, client.pbFilterEquals('member', memberIds[0]), appConfig);
  const wanted = new Set(memberIds);
  return (await client.listAllRecords(collection, '', appConfig, '', { fields: READ_FIELDS[collection] || '' })).filter((row) => wanted.has(row.member));
}

const groupBy = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row[key]);
    if (list) list.push(row);
    else map.set(row[key], [row]);
  }
  return map;
};
const byPosition = (rows) => [...rows].sort((a, b) => (a.position || 0) - (b.position || 0));

async function hydrateMembers(appConfig, memberRows, fees) {
  const ids = memberRows.map((row) => row.id);
  const [payments, periods, orders] = await Promise.all([
    rowsOfMembers(appConfig, PAYMENTS, ids),
    rowsOfMembers(appConfig, PERIODS, ids),
    rowsOfMembers(appConfig, STANDING_ORDERS, ids)
  ]);
  const paymentsBy = groupBy(payments, 'member');
  const periodsBy = groupBy(periods, 'member');
  const ordersBy = groupBy(orders, 'member');
  return memberRows.map((row) => {
    const memberPayments = paymentsBy.get(row.id) || [];
    const personKey = keyOfMember(row);
    const oldPayments = memberPayments.map((payment) => oldPaymentRecord(payment, personKey));
    const record = oldPeopleRecord(row, byPosition(ordersBy.get(row.id) || []), memberPayments, { decodedPayments: oldPayments.map((payment) => payment.data) });
    const oldPeriods = (periodsBy.get(row.id) || []).map((period) => oldStatusRecord(period, record.personKey));
    return {
      record,
      rows: { member: row, payments: memberPayments, periods: periodsBy.get(row.id) || [], orders: ordersBy.get(row.id) || [] },
      oldPayments,
      oldPeriods,
      data: shapes.hydratePersonRecord(record, oldPayments, oldPeriods, fees.settings, fees.resets, fees.schedule)
    };
  });
}

// --- Reading members (the old functions) ----------------------------------------------------------------------

async function findMemberRow(appConfig, personKey) {
  const key = String(personKey);
  if (ID_PATTERN.test(key)) {
    const row = await client.getRecord(MEMBERS, key, appConfig);
    if (row && keyOfMember(row) === key) return row;
  }
  // A key that is no record id (kept in original.key)
  return client.getFirstRecord(MEMBERS, `original.key = ${JSON.stringify(key)}`, appConfig);
}

async function getPeopleRecord(appConfig, personKey) {
  const row = await findMemberRow(appConfig, personKey);
  if (!row || isOrphan(row)) return null;
  const fees = await getFeeState(appConfig);
  const [member] = await hydrateMembers(appConfig, [row], fees);
  const record = { ...member.record, data: member.data };
  // For the writes of this store only: not part of any answer (an object spread leaves them out)
  for (const [key, value] of [['_childPayments', member.oldPayments], ['_childStatusHistory', member.oldPeriods], ['_rows', member.rows]]) {
    Object.defineProperty(record, key, { value, enumerable: false });
  }
  return record;
}

// All members with what the server works out for them (balance, paid until, overdue) are read by every app after
// every change. They are worked out once and handed to each caller as its own copy, until anything is written, the
// day changes (what is due depends on it) or MEMBERS_MEMO_MS pass (changes made on PocketBase's admin page).
const MEMBERS_MEMO_MS = 30 * 1000;
const localDay = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
let membersMemo = null;

async function allMembers(appConfig) {
  const key = `${client.writeGeneration()}|${localDay()}`;
  if (membersMemo && membersMemo.key === key && Date.now() - membersMemo.at < MEMBERS_MEMO_MS) return membersMemo.members;
  const [rows, fees] = await Promise.all([client.listAllRecords(MEMBERS, '', appConfig), getFeeState(appConfig)]);
  const hydrated = await hydrateMembers(appConfig, rows.filter((row) => !isOrphan(row)), fees);
  const members = hydrated.map(({ record, data }) => ({ ...record, isDeleted: Boolean(record.isDeleted || record.data?.isDeleted), data }));
  // Kept only when nothing was written while it was worked out
  if (`${client.writeGeneration()}|${localDay()}` === key) membersMemo = { key, at: Date.now(), members };
  return members;
}

async function listPeopleRecords(appConfig, query = {}) {
  const filtered = (query.orderByChild === 'uid' || query.orderByChild === 'name') && query.equalTo !== undefined;
  // One member's own entries (by account or name): from the members worked out already, or worked out alone
  if (filtered && !(membersMemo && membersMemo.key === `${client.writeGeneration()}|${localDay()}` && Date.now() - membersMemo.at < MEMBERS_MEMO_MS)) {
    const [rows, fees] = await Promise.all([client.listAllRecords(MEMBERS, '', appConfig), getFeeState(appConfig)]);
    // The old query compared the list column (record.uid / record.name); worked out on the rebuilt records
    const wanted = String(query.equalTo);
    const members = rows.filter((row) => !isOrphan(row) && oldPeopleRecord(row)[query.orderByChild] === wanted);
    const hydrated = await hydrateMembers(appConfig, members, fees);
    return hydrated.map(({ record, data }) => ({ ...record, isDeleted: Boolean(record.isDeleted || record.data?.isDeleted), data }));
  }
  const members = await allMembers(appConfig);
  const picked = filtered ? members.filter((member) => member[query.orderByChild] === String(query.equalTo)) : members;
  return structuredClone(picked);
}

// --- Writing members ------------------------------------------------------------------------------------------

/** The values the old server filled from the record's list columns when its copy lacked them (hydratePersonRecord). */
function effectiveMember(payload) {
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const effective = codecs.withoutKeys(data, codecs.COMPUTED_MEMBER_KEYS);
  effective.id = data.id || payload.personKey;
  effective.uid = data.uid || payload.uid || '';
  effective.name = data.name || payload.name || '';
  effective.status = data.status || payload.status || '';
  effective.memberSince = data.memberSince || payload.memberSince || '';
  effective.originalMemberSince = data.originalMemberSince || payload.originalMemberSince || data.memberSince || '';
  if (data.isDeleted || payload.isDeleted) effective.isDeleted = true;
  return effective;
}

/** The records a list of child entries becomes: each with the key the old server gave it (by id, else by place and content). */
function childEntries(prefix, personKey, list, codec, stripKeys = null) {
  return shapes.normalizeRecordListInput(list).map((entry, index) => {
    const value = stripKeys ? codecs.withoutKeys(entry, stripKeys) : entry;
    const hasId = value && value.id !== undefined && value.id !== null && value.id !== '';
    const key = shapes.buildStableChildKey(prefix, personKey, hasId ? value.id : undefined, index, entry);
    const { columns, original } = codec.encode(value);
    return { key, columns, original: hasId ? original : { ...(original || {}), key } };
  });
}

/**
 * The operations that make the stored child records of one member ([existing], with their keys) match [wanted].
 * [keepUnseen]: a list sent without a version (older apps) may be stale - a record added after the newest record the
 * list knows is never deleted for missing from it.
 */
function diffChildren(collection, memberId, existing, wanted, { keepUnseen, extraColumns = () => ({}) }) {
  const ops = [];
  const existingByKey = new Map(existing.map((entry) => [entry.key, entry]));
  const wantedKeys = new Set();
  let newestSeen = '';
  for (const entry of wanted) {
    const current = existingByKey.get(entry.key);
    if (current && current.row.created > newestSeen) newestSeen = current.row.created;
  }
  wanted.forEach((entry, index) => {
    wantedKeys.add(entry.key);
    const current = existingByKey.get(entry.key);
    const body = { member: memberId, ...entry.columns, ...extraColumns(entry, index), original: entry.original };
    if (!current) ops.push({ method: 'POST', collection, body: { id: entry.id || newRecordId(), ...body } });
    else if (!sameRow(current.row, body)) ops.push({ method: 'PATCH', collection, id: current.row.id, body });
  });
  const kept = [];
  for (const entry of existing) {
    if (wantedKeys.has(entry.key)) continue;
    if (keepUnseen && !(entry.row.created <= newestSeen)) {
      kept.push(entry.row.id);
      continue;
    }
    ops.push({ method: 'DELETE', collection, id: entry.row.id });
  }
  return { ops, kept };
}

const MOMENT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
const sameValue = (stored, wanted) => {
  if (typeof stored === 'string' && typeof wanted === 'string' && MOMENT.test(stored) && MOMENT.test(wanted)) {
    return Date.parse(stored.replace(' ', 'T')) === Date.parse(wanted.replace(' ', 'T'));
  }
  return isDeepStrictEqual(stored ?? null, wanted ?? null) || (wanted === '' && (stored === '' || stored === undefined));
};

/** True when [row] already holds [body] (nothing to write). */
function sameRow(row, body) {
  return Object.entries(body).every(([key, value]) => sameValue(row[key], value));
}

async function runBatch(appConfig, ops) {
  for (let start = 0; start < ops.length; start += client.BATCH_MAX_REQUESTS) {
    await client.batchWrite(appConfig, ops.slice(start, start + client.BATCH_MAX_REQUESTS));
  }
}

// --- The change log: who changed which booking when, with the values before and after ---------------------------
// Written in the same transaction as the change itself; kept CHANGE_LOG_YEARS (pruneChangeLog), the log of the fees
// and fresh starts (areas fees, freshStart) for good - it is part of the fee history.

/** A row of the change log, by whoever is acting (actor.js: the signed-in person, or the server itself). */
function changeOp(area, action, { member = '', target = '', before, after } = {}) {
  const actor = currentActor();
  const details = {};
  if (before !== undefined) details.before = before;
  if (after !== undefined) details.after = after;
  return { method: 'POST', collection: CHANGES, body: { area, action, at: new Date().toISOString(), by: actor.by, byName: actor.byName, member: member || '', target: String(target || ''), details } };
}

/** The log rows of the record operations [ops] of one kind ([rows]: the records before; [decode]: a record as the apps see it). */
function changeOpsFor(area, ops, rows, decode, member = '') {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ops.map((op) => {
    if (op.method === 'POST') return changeOp(area, 'create', { member, target: op.body.id, after: decode(op.body) });
    const before = byId.get(op.id);
    if (op.method === 'PATCH') return changeOp(area, 'update', { member, target: op.id, before: before && decode(before), after: decode({ ...(before || {}), ...op.body }) });
    return changeOp(area, 'delete', { member, target: op.id, before: before && decode(before) });
  });
}

const CHANGE_LOG_YEARS = () => {
  const years = Number(process.env.AGORA_CHANGE_LOG_YEARS);
  return Number.isFinite(years) && years > 0 ? years : 10;
};

/** Removes the log rows older than the kept years (not the fee history); returns how many went. */
async function pruneChangeLog(appConfig, { years = CHANGE_LOG_YEARS(), now = Date.now() } = {}) {
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - years);
  const filter = `at < ${JSON.stringify(cutoff.toISOString().replace('T', ' '))} && area != "fees" && area != "freshStart"`;
  const rows = await client.listAllRecords(CHANGES, filter, appConfig, '', { fields: 'id' });
  await runBatch(appConfig, rows.map((row) => ({ method: 'DELETE', collection: CHANGES, id: row.id })));
  return rows.length;
}

/**
 * Writes the member [personKey] as the apps send it ([value]: the whole member with payments, status history and
 * standing orders). [expectedUpdated]: the version the write is based on (conflict when the member changed since);
 * without it, records the sender cannot have seen are kept (see diffChildren).
 */
function upsertPeopleRecord(appConfig, personKey, value, expectedUpdated = null, { actor = null } = {}) {
  return queueRecordWrite(`people:${personKey}`, async () => {
    const payload = shapes.buildPersonRecordPayload(personKey, value);
    // Checked before anything is written: a record PocketBase refuses must not leave payments half written
    if (!payload.name || !payload.data) throw Object.assign(new Error('A person record needs a name.'), { status: 400 });
    const existingRow = await findMemberRow(appConfig, personKey);
    const existing = existingRow && !isOrphan(existingRow) ? existingRow : null;
    if (existing ? shapes.isOutdatedVersion(existing.updated, expectedUpdated) : expectedUpdated) {
      throw Object.assign(new Error('Conflict'), { status: 409 });
    }

    const memberId = existingRow ? existingRow.id : (ID_PATTERN.test(String(personKey)) ? String(personKey) : newRecordId());
    const ctx = { ...(await linkContext(appConfig, [memberId])), recordId: memberId };
    const effective = effectiveMember(payload);
    const encoded = codecs.member.encode(effective, ctx);
    const memberOriginal = { ...(encoded.original || {}) };
    if (memberId !== String(personKey)) memberOriginal.key = String(personKey);
    const standingOrdersValue = payload.data.standingOrders;
    if (standingOrdersValue !== undefined && !Array.isArray(standingOrdersValue)) memberOriginal.standingOrders = standingOrdersValue;
    const memberBody = { ...encoded.columns, original: Object.keys(memberOriginal).length ? memberOriginal : null };
    delete memberBody.id;

    // The child records, with the keys the old server gave them
    const rows = existingRow
      ? await Promise.all([PAYMENTS, PERIODS, STANDING_ORDERS].map((collection) => client.listAllRecords(collection, client.pbFilterEquals('member', existingRow.id), appConfig)))
      : [[], [], []];
    const [paymentRows, periodRows, orderRows] = rows;
    const keyOf = (prefix, decode) => (row) => {
      const data = decode(row);
      const stored = originalOf(row).key;
      return { key: typeof stored === 'string' ? stored : shapes.buildStableChildKey(prefix, String(personKey), data.id, 0, data), row };
    };
    const keepUnseen = expectedUpdated === null || expectedUpdated === undefined;
    const wantedOrders = (Array.isArray(standingOrdersValue) ? standingOrdersValue : []).filter(Boolean).map((order, index) => {
      const { columns, original } = codecs.standingOrder.encode(order);
      const hasId = order && order.id !== undefined && order.id !== null && order.id !== '';
      const key = hasId ? `id:${JSON.stringify(order.id)}` : `pos:${index}:${shapes.stableSerialize(order)}`;
      return { key, columns, original, id: null };
    });
    const orderKey = (row) => {
      const data = codecs.standingOrder.decode(row);
      const hasId = data.id !== undefined && data.id !== null && data.id !== '';
      return { key: hasId ? `id:${JSON.stringify(data.id)}` : `pos:${row.position}:${shapes.stableSerialize(data)}`, row };
    };
    const orders = diffChildren(STANDING_ORDERS, memberId, orderRows.map(orderKey), wantedOrders, { keepUnseen, extraColumns: (entry, index) => ({ position: index }) });
    // Standing orders of the member by the id the apps gave them: the payments they booked link to them
    const orderIdByClientId = new Map();
    for (const row of orderRows) orderIdByClientId.set(JSON.stringify(codecs.standingOrder.decode(row).id), row.id);
    for (const op of orders.ops) if (op.method === 'POST') orderIdByClientId.set(JSON.stringify(op.body.clientId), op.body.id);
    const standingOrderOf = (columns) => {
      const match = columns.source === 'standingOrder' && typeof columns.clientId === 'string' ? /^auto_(.+)_\d{4}-\d{2}-\d{2}$/.exec(columns.clientId) : null;
      return (match && orderIdByClientId.get(JSON.stringify(match[1]))) || '';
    };
    const payments = diffChildren(PAYMENTS, memberId, paymentRows.map(keyOf('payment', codecs.payment.decode)), childEntries('payment', String(personKey), value?.payments, codecs.payment), {
      keepUnseen,
      extraColumns: (entry) => ({ standingOrder: standingOrderOf(entry.columns) })
    });
    const periods = diffChildren(PERIODS, memberId, periodRows.map(keyOf('status', codecs.statusPeriod.decode)), childEntries('status', String(personKey), value?.statusHistory, codecs.statusPeriod, codecs.COMPUTED_STATUS_KEYS), { keepUnseen });

    // A new member first (the payments link to it), the member's own record last: whoever reads its new version
    // reads its payments - all of it in one transaction, with its rows in the change log
    const ops = [];
    if (!existingRow) ops.push({ method: 'POST', collection: MEMBERS, body: { id: memberId, ...memberBody } });
    ops.push(...orders.ops.filter((op) => op.method !== 'DELETE'), ...payments.ops, ...periods.ops, ...orders.ops.filter((op) => op.method === 'DELETE'));
    if (existingRow) ops.push({ method: 'PATCH', collection: MEMBERS, id: memberId, body: memberBody });
    if (!existingRow) ops.push(changeOp('member', 'create', { member: memberId, target: memberId, after: codecs.member.decode({ id: memberId, ...memberBody }) }));
    else if (!sameRow(existingRow, memberBody)) ops.push(changeOp('member', 'update', { member: memberId, target: memberId, before: codecs.member.decode(existingRow), after: codecs.member.decode({ ...existingRow, ...memberBody }) }));
    ops.push(
      ...changeOpsFor('payment', payments.ops, paymentRows, (row) => codecs.payment.decode(row), memberId),
      ...changeOpsFor('statusPeriod', periods.ops, periodRows, (row) => codecs.statusPeriod.decode(row), memberId),
      ...changeOpsFor('standingOrder', orders.ops, orderRows, (row) => codecs.standingOrder.decode(row), memberId)
    );
    await runBatch(appConfig, ops);
    if (payments.kept.length || periods.kept.length) {
      console.warn(`[Finance] Kept ${payments.kept.length + periods.kept.length} entr(ies) of ${personKey} that an app without the current version did not know of`);
    }
    return getPeopleRecord(appConfig, personKey);
  });
}

/** Deleting a member keeps the bookkeeping record: the name and the payments. The login goes (see the old function). */
async function removePeopleRecord(appConfig, personKey, { deleteUser } = {}) {
  const existing = await getPeopleRecord(appConfig, personKey);
  if (!existing) return;
  const uid = existing.uid || existing.data?.uid;
  if (uid && deleteUser) {
    const sharedWith = (await listPeopleRecords(appConfig)).filter((p) => p.personKey !== String(personKey) && !shapes.isDeletedPerson(p) && (p.uid === uid || p.data?.uid === uid));
    if (!sharedWith.length) await deleteUser(uid).catch((err) => console.warn(`[PocketBase] Failed to delete auth user ${uid}:`, err.message));
  }
  await writeDeletedMember(appConfig, existing._rows.member, existing);
}

/** The member cut down to what the books keep: the name and the payments (status history and standing orders go). */
async function writeDeletedMember(appConfig, row, record) {
  const deleted = shapes.deletedPersonPayload(record);
  const ctx = { ...(await linkContext(appConfig)), recordId: row.id };
  const encoded = codecs.member.encode(effectiveMember(deleted), ctx);
  const original = { ...(encoded.original || {}), ...(keyOfMember(row) !== row.id ? { key: keyOfMember(row) } : {}) };
  const body = { ...encoded.columns, original: Object.keys(original).length ? original : null };
  delete body.id;
  const [periods, orders] = await Promise.all([PERIODS, STANDING_ORDERS].map((collection) => client.listAllRecords(collection, client.pbFilterEquals('member', row.id), appConfig)));
  // The income status says much about a person: once they are deleted, the log keeps that it changed, not to what
  const statusRows = await client.listAllRecords(CHANGES, `${client.pbFilterEquals('member', row.id)} && area = "statusPeriod"`, appConfig, '', { fields: 'id' });
  await queueRecordWrite(`people:${keyOfMember(row)}`, () => runBatch(appConfig, [
    ...periods.map((period) => ({ method: 'DELETE', collection: PERIODS, id: period.id })),
    ...orders.map((order) => ({ method: 'DELETE', collection: STANDING_ORDERS, id: order.id })),
    { method: 'PATCH', collection: MEMBERS, id: row.id, body },
    ...statusRows.map((change) => ({ method: 'PATCH', collection: CHANGES, id: change.id, body: { details: { removed: true } } })),
    ...orders.map((order) => changeOp('standingOrder', 'delete', { member: row.id, target: order.id, before: codecs.standingOrder.decode(order) })),
    ...periods.map((period) => changeOp('statusPeriod', 'delete', { member: row.id, target: period.id })),
    changeOp('member', 'delete', { member: row.id, target: row.id, before: { name: record.name || record.data?.name || '' } })
  ]));
}

/**
 * Deleted members that still carry more than the books keep (older deletions kept everything) are cut down. Returns
 * { pruned } like the old function.
 */
async function pruneDeletedPeopleRecords(appConfig) {
  if (!appConfig) return { pruned: 0 };
  let pruned = 0;
  try {
    const people = (await listPeopleRecords(appConfig)).filter(shapes.isDeletedPerson);
    for (const person of people) {
      const full = await getPeopleRecord(appConfig, person.personKey);
      const row = full._rows.member;
      const dataKeys = Object.keys(codecs.member.decode(row)).filter((key) => !['uid', 'status', 'memberSince', 'originalMemberSince'].includes(key)).sort().join(',');
      const clean = !full._rows.periods.length && !full._rows.orders.length && !full.uid && !full.status && !full.memberSince && !full.originalMemberSince && dataKeys === 'id,isDeleted,name';
      if (clean) continue;
      await writeDeletedMember(appConfig, row, full);
      pruned += 1;
    }
    if (pruned) console.log(`[People] Cut ${pruned} deleted entr${pruned === 1 ? 'y' : 'ies'} down to their payments`);
  } catch (error) {
    console.error('[People] Pruning deleted entries failed:', error.message);
  }
  return { pruned };
}

// --- Lists written as a whole: donations and expenses ---------------------------------------------------------

/** A version of a list of records: changes with every write to it (the web app saves its lists with it). */
const listVersion = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows.map((row) => [row.id, row.updated]))).digest('hex').slice(0, 16);

async function readCompat(appConfig) {
  return (await getSetting(appConfig, 'compat')) || {};
}

async function getDonationRows(appConfig) {
  return byPosition(await client.listAllRecords(DONATIONS, '', appConfig));
}

/** The donations as the old API hands them out: the list (or the map by id the first versions kept) as it was written. */
async function getDonationsValue(appConfig) {
  const [rows, compat] = await Promise.all([getDonationRows(appConfig), readCompat(appConfig)]);
  // A fresh instance has the empty map {} (as always); the web app's first save makes it a list
  const asMap = compat.donations !== 'array';
  if (!asMap) return rows.map((row) => codecs.donation.decode(row));
  return Object.fromEntries(rows.map((row, index) => [typeof originalOf(row).key === 'string' ? originalOf(row).key : String(index), codecs.donation.decode(row)]));
}

/**
 * Saves the donations an app sends as a whole ([value]: list or map). With [expectedVersion] (the web app) a list that
 * changed meanwhile is refused (409); without (older apps) nothing the app cannot have seen is deleted.
 */
function saveDonations(appConfig, value, { expectedVersion } = {}) {
  return queueRecordWrite('finance:donations', async () => {
    const rows = await getDonationRows(appConfig);
    if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== listVersion(rows)) throw Object.assign(new Error('Conflict'), { status: 409 });
    const isMap = Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    const entries = isMap ? Object.entries(value) : (Array.isArray(value) ? value : []).map((entry, index) => [null, entry]);
    const keyOfEntry = (objectKey, entry, index) => {
      if (objectKey !== null) return `key:${objectKey}`;
      const hasId = entry && entry.id !== undefined && entry.id !== null && entry.id !== '';
      return hasId ? `id:${JSON.stringify(entry.id)}` : `content:${index}:${shapes.stableSerialize(entry)}`;
    };
    const wanted = entries.filter(([, entry]) => entry).map(([objectKey, entry], index) => {
      const { columns, original } = codecs.donation.encode(entry);
      const withKey = objectKey !== null ? { ...(original || {}), key: objectKey } : original;
      return { key: keyOfEntry(objectKey, entry, index), columns, original: withKey && Object.keys(withKey).length ? withKey : null };
    });
    const existing = rows.map((row, index) => {
      const data = codecs.donation.decode(row);
      return { key: keyOfEntry(typeof originalOf(row).key === 'string' ? originalOf(row).key : null, data, index), row };
    });
    const { ops } = diffChildren(DONATIONS, null, existing, wanted, { keepUnseen: expectedVersion === undefined || expectedVersion === null, extraColumns: (entry, index) => ({ position: index }) });
    for (const op of ops) if (op.body) delete op.body.member;
    // A donation that only moved in the list is no change of it
    const moved = (op) => op.method === 'PATCH' && Object.keys(op.body).every((key) => key === 'position' || sameValue(rows.find((row) => row.id === op.id)?.[key], op.body[key]));
    await runBatch(appConfig, [...ops, ...changeOpsFor('donation', ops.filter((op) => !moved(op)), rows, (row) => codecs.donation.decode(row))]);
    await setSetting(appConfig, 'compat', { ...(await readCompat(appConfig)), donations: isMap ? 'object' : 'array' });
  });
}

async function getExpenseRows(appConfig) {
  return byRowid(await client.listAllRecords(EXPENSES, '', appConfig));
}

function oldExpenseRecord(row) {
  const data = codecs.expense.decode(row);
  const key = typeof originalOf(row).key === 'string' ? originalOf(row).key : shapes.buildExpenseRecordPayload(data, 0).expenseKey;
  return { id: row.id, collectionName: 'expenses', expenseKey: key, amount: shapes.toFiniteNumber(data.amount), date: shapes.toOptionalText(data.date), issuer: shapes.toOptionalText(data.issuer), description: shapes.toOptionalText(data.description), receipt: shapes.toOptionalText(data.receipt), data };
}

async function listExpenseRecords(appConfig) {
  return (await getExpenseRows(appConfig)).map(oldExpenseRecord);
}

/** Saves the expenses an app sends as a whole (see saveDonations for [expectedVersion]). */
function syncExpenseRecords(appConfig, value, { expectedVersion } = {}) {
  return queueRecordWrite('finance:expenses', async () => {
    const rows = await getExpenseRows(appConfig);
    if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== listVersion(rows)) throw Object.assign(new Error('Conflict'), { status: 409 });
    const wanted = shapes.normalizeRecordListInput(value).map((expense, index) => {
      const payload = shapes.buildExpenseRecordPayload(expense, index);
      const hasId = expense && expense.id !== undefined && expense.id !== null && expense.id !== '';
      const { columns, original } = codecs.expense.encode(expense);
      return { key: payload.expenseKey, columns, original: hasId ? original : { ...(original || {}), key: payload.expenseKey } };
    });
    const existing = rows.map((row) => ({ key: oldExpenseRecord(row).expenseKey, row }));
    const { ops } = diffChildren(EXPENSES, null, existing, wanted, { keepUnseen: expectedVersion === undefined || expectedVersion === null });
    for (const op of ops) if (op.body) delete op.body.member;
    await runBatch(appConfig, [...ops, ...changeOpsFor('expense', ops, rows, (row) => codecs.expense.decode(row))]);
  });
}

async function donationsVersion(appConfig) {
  return listVersion(await getDonationRows(appConfig));
}

async function expensesVersion(appConfig) {
  return listVersion(await getExpenseRows(appConfig));
}

// --- Requests ---------------------------------------------------------------------------------------------------

const keyOfRequest = (row) => (typeof originalOf(row).key === 'string' ? originalOf(row).key : row.id);

function oldRequestRecord(row) {
  const data = codecs.request.decode(row);
  const columns = originalOf(row).columns || {};
  const column = (key, fallback) => (has(columns, key) ? columns[key] : fallback);
  return {
    id: row.id,
    collectionName: 'requests',
    requestKey: keyOfRequest(row),
    userId: column('userId', data.userId ? String(data.userId) : ''),
    personId: column('personId', data.personId ? String(data.personId) : ''),
    personName: column('personName', data.personName ? String(data.personName) : ''),
    type: column('type', data.type ? String(data.type) : ''),
    status: column('status', data.status ? String(data.status) : ''),
    timestamp: column('timestamp', typeof data.timestamp === 'number' ? data.timestamp : null),
    data: has(originalOf(row), 'noData') ? null : data,
    created: row.created,
    updated: row.updated
  };
}

async function findRequestRow(appConfig, requestKey) {
  const key = String(requestKey);
  if (ID_PATTERN.test(key)) {
    const row = await client.getRecord(REQUESTS, key, appConfig);
    if (row && keyOfRequest(row) === key) return row;
  }
  return client.getFirstRecord(REQUESTS, `original.key = ${JSON.stringify(key)}`, appConfig);
}

async function getRequestRecord(appConfig, requestKey) {
  const row = await findRequestRow(appConfig, requestKey);
  return row ? oldRequestRecord(row) : null;
}

async function listRequestRecords(appConfig, query = {}) {
  const records = (await client.listAllRecords(REQUESTS, '', appConfig)).map(oldRequestRecord);
  if (query.orderByChild === 'userId' && query.equalTo !== undefined) return records.filter((record) => record.userId === String(query.equalTo));
  return records;
}

async function upsertRequestRecord(appConfig, requestKey, value) {
  const existing = await findRequestRow(appConfig, requestKey);
  const id = existing ? existing.id : (ID_PATTERN.test(String(requestKey)) ? String(requestKey) : newRecordId());
  const ctx = { ...(await linkContext(appConfig)), recordId: id };
  const { columns, original } = codecs.request.encode(value, ctx);
  const withKey = { ...(original || {}), ...(id !== String(requestKey) ? { key: String(requestKey) } : {}) };
  if (!value) withKey.noData = true;
  const body = { ...columns, original: Object.keys(withKey).length ? withKey : null };
  delete body.id;
  const decode = (row) => (has(originalOf(row), 'noData') ? null : codecs.request.decode(row));
  const [result] = await client.batchWrite(appConfig, existing
    ? [{ method: 'PATCH', collection: REQUESTS, id, body }, changeOp('request', 'update', { target: id, before: decode(existing), after: decode({ ...existing, ...body }) })]
    : [{ method: 'POST', collection: REQUESTS, body: { id, ...body } }, changeOp('request', 'create', { target: id, after: decode({ id, ...body }) })]);
  return oldRequestRecord(result);
}

/**
 * Changes only the request itself (its data), like the old cleanup and repair did: list columns an old record kept
 * apart stay, except those named in [setColumns] (they follow the new data).
 */
async function updateRequestData(appConfig, requestKey, data, { setColumns = [] } = {}) {
  const row = await findRequestRow(appConfig, requestKey);
  if (!row) return null;
  const ctx = { ...(await linkContext(appConfig)), recordId: row.id };
  const { columns, original } = codecs.request.encode(data, ctx);
  const kept = { ...(originalOf(row).columns || {}) };
  for (const key of setColumns) delete kept[key];
  const next = { ...(original || {}), ...(typeof originalOf(row).key === 'string' ? { key: originalOf(row).key } : {}), ...(Object.keys(kept).length ? { columns: kept } : {}) };
  const body = { ...columns, original: Object.keys(next).length ? next : null };
  delete body.id;
  const [result] = await client.batchWrite(appConfig, [
    { method: 'PATCH', collection: REQUESTS, id: row.id, body },
    changeOp('request', 'update', { target: row.id, before: codecs.request.decode(row), after: codecs.request.decode({ ...row, ...body }) })
  ]);
  return oldRequestRecord(result);
}

async function deleteRequestRecord(appConfig, requestKey) {
  const row = await findRequestRow(appConfig, requestKey);
  if (row) {
    await client.batchWrite(appConfig, [
      { method: 'DELETE', collection: REQUESTS, id: row.id },
      changeOp('request', 'delete', { target: row.id, before: has(originalOf(row), 'noData') ? null : codecs.request.decode(row) })
    ]);
  }
}

/** Deletes the requests of the account [uid] (account deletion); returns how many. */
async function deleteRequestsOfUser(appConfig, uid) {
  const records = await listRequestRecords(appConfig, { orderByChild: 'userId', equalTo: uid });
  for (const record of records) await deleteRequestRecord(appConfig, record.requestKey).catch(() => {});
  return records.length;
}

// --- Settings, the fees over time, the fresh starts -------------------------------------------------------------

async function getSettingRecord(appConfig, area) {
  return client.getFirstRecord(SETTINGS, client.pbFilterEquals('area', area), appConfig);
}

async function getSetting(appConfig, area) {
  return (await getSettingRecord(appConfig, area))?.value ?? null;
}

async function setSetting(appConfig, area, value) {
  const existing = await getSettingRecord(appConfig, area);
  if (existing) return client.updateRecord(SETTINGS, existing.id, { value }, appConfig);
  return client.createRecord(SETTINGS, { area, value }, appConfig);
}

const feesToCents = (fees) => (fees && typeof fees === 'object' ? Object.fromEntries(Object.entries(fees).map(([status, amount]) => [status, toCents(amount).cents])) : null);
const feesFromCents = (fees) => (fees && typeof fees === 'object' ? Object.fromEntries(Object.entries(fees).map(([status, cents]) => [status, fromCents(cents)])) : null);
const momentFromMillis = (value) => (Number.isFinite(value) && value > 0 && value <= 8.64e15 ? new Date(value).toISOString() : '');
const millisFromMoment = (value) => (value ? new Date(String(value).replace(' ', 'T')).getTime() : null);

/** The log entries of [area] (fees, freshStart) in the order they were written. */
async function logEntries(appConfig, area) {
  const rows = await client.listAllRecords(CHANGES, client.pbFilterEquals('area', area), appConfig);
  return rows.map((row) => row.details);
}

/** Adds the entries of [log] that are not stored yet (the stored log is the longest prefix [log] continues). */
async function appendLog(appConfig, area, log) {
  const stored = await logEntries(appConfig, area);
  const incoming = Array.isArray(log) ? log : [];
  // [incoming] is the newest part of the whole log: find where the stored entries end in it
  let start = 0;
  for (let overlap = Math.min(stored.length, incoming.length); overlap > 0; overlap -= 1) {
    if (isDeepStrictEqual(stored.slice(stored.length - overlap), incoming.slice(0, overlap))) {
      start = overlap;
      break;
    }
  }
  const fresh = incoming.slice(start);
  await runBatch(appConfig, fresh.map((entry) => ({
    method: 'POST',
    collection: CHANGES,
    body: { area, action: String(entry?.action || ''), at: momentFromMillis(entry?.at), by: String(entry?.by || ''), byName: String(entry?.byName || ''), details: entry }
  })));
}

/** The fees over time as feeSchedule.js keeps them ({ base, changes, log }), or null when none were ever stored. */
async function getFeeScheduleValue(appConfig) {
  const rows = await client.listAllRecords(FEE_CHANGES, '', appConfig, 'fromMonth');
  const base = rows.find((row) => !row.fromMonth);
  if (!base) return null;
  return {
    base: feesFromCents(base.feesCents) || {},
    changes: rows.filter((row) => row.fromMonth).map((row) => ({ from: row.fromMonth, fees: feesFromCents(row.feesCents) || {}, setAt: millisFromMoment(row.setAt), setBy: row.setBy, setByName: row.setByName })),
    log: (await logEntries(appConfig, 'fees')).slice(-100)
  };
}

async function setFeeScheduleValue(appConfig, value) {
  const schedule = normalizeFeeSchedule(value);
  if (!schedule) return;
  const rows = await client.listAllRecords(FEE_CHANGES, '', appConfig);
  const wanted = [
    { fromMonth: '', feesCents: feesToCents(schedule.base), setAt: '', setBy: '', setByName: '' },
    ...schedule.changes.map((change) => ({ fromMonth: change.from, feesCents: feesToCents(change.fees), setAt: momentFromMillis(change.setAt), setBy: change.setBy || '', setByName: change.setByName || '' }))
  ];
  const ops = [];
  const byMonth = new Map(rows.map((row) => [row.fromMonth || '', row]));
  for (const body of wanted) {
    const current = byMonth.get(body.fromMonth);
    byMonth.delete(body.fromMonth);
    if (!current) ops.push({ method: 'POST', collection: FEE_CHANGES, body });
    else if (!sameRow(current, body)) ops.push({ method: 'PATCH', collection: FEE_CHANGES, id: current.id, body });
  }
  for (const row of byMonth.values()) ops.push({ method: 'DELETE', collection: FEE_CHANGES, id: row.id });
  await runBatch(appConfig, ops);
  await appendLog(appConfig, 'fees', normalizeFeeScheduleLog(value));
}

async function getFeeResetsValue(appConfig) {
  const rows = await client.listAllRecords(FRESH_STARTS, '', appConfig, 'day');
  const log = await logEntries(appConfig, 'freshStart');
  if (!rows.length && !log.length) return null;
  return {
    resets: rows.map((row) => ({ date: row.day, feesBefore: feesFromCents(row.feesBeforeCents), setAt: millisFromMoment(row.setAt), setBy: row.setBy, setByName: row.setByName })),
    log: log.slice(-100)
  };
}

async function setFeeResetsValue(appConfig, value) {
  const resets = normalizeFeeResets(value);
  const rows = await client.listAllRecords(FRESH_STARTS, '', appConfig);
  const ops = [];
  const byDay = new Map(rows.map((row) => [row.day, row]));
  for (const reset of resets) {
    const body = { day: reset.date, feesBeforeCents: feesToCents(reset.feesBefore), setAt: momentFromMillis(reset.setAt), setBy: reset.setBy || '', setByName: reset.setByName || '' };
    const current = byDay.get(reset.date);
    byDay.delete(reset.date);
    if (!current) ops.push({ method: 'POST', collection: FRESH_STARTS, body });
    else if (!sameRow(current, body)) ops.push({ method: 'PATCH', collection: FRESH_STARTS, id: current.id, body });
  }
  for (const row of byDay.values()) ops.push({ method: 'DELETE', collection: FRESH_STARTS, id: row.id });
  await runBatch(appConfig, ops);
  await appendLog(appConfig, 'freshStart', normalizeFeeResetLog(value));
}

// The state values of the books, as the old key/value store answered them (getStateValue / upsertStateValue)
const FINANCE_STATE_KEYS = new Set(['settings', 'donations', 'expenses', FEE_SCHEDULE_STATE_KEY, FEE_RESET_STATE_KEY]);

async function getStateValue(appConfig, key) {
  if (key === 'settings') return getSetting(appConfig, 'finance');
  if (key === 'donations') return getDonationsValue(appConfig);
  if (key === 'expenses') return {};
  if (key === FEE_SCHEDULE_STATE_KEY) return getFeeScheduleValue(appConfig);
  if (key === FEE_RESET_STATE_KEY) return getFeeResetsValue(appConfig);
  return null;
}

async function setStateValue(appConfig, key, value, options = {}) {
  if (key === 'settings') return setSetting(appConfig, 'finance', value);
  if (key === 'donations') return saveDonations(appConfig, value, options);
  if (key === 'expenses') return null;
  if (key === FEE_SCHEDULE_STATE_KEY) return setFeeScheduleValue(appConfig, value);
  if (key === FEE_RESET_STATE_KEY) return setFeeResetsValue(appConfig, value);
  return null;
}

// What is stored about the fees - the fees over time, the fresh starts and the fee settings - is read as one and
// changed by the rules in feeState.js, one change at a time (see pocketbase.js)
const FEE_STATE_LOCK = 'app_state:fees';
const feeStore = (appConfig) => ({
  get: (key) => getStateValue(appConfig, key),
  set: (key, value) => setStateValue(appConfig, key, value)
});
const todayStr = () => toDateStr(new Date());

function getFeeState(appConfig) {
  return readFeeState({
    get: async (key) => {
      const value = await getStateValue(appConfig, key);
      if (key === 'settings' && value === null) return DEFAULT_SETTINGS;
      return value;
    },
    set: () => { throw new Error('read only'); }
  });
}

function updateFeeResetState(appConfig, change) {
  return queueRecordWrite(FEE_STATE_LOCK, () => changeFeeResets(feeStore(appConfig), change, todayStr()));
}

function updateFeeSchedule(appConfig, change) {
  return queueRecordWrite(FEE_STATE_LOCK, () => changeFeeSchedule(feeStore(appConfig), change, todayStr()));
}

function saveSettings(appConfig, value, actor) {
  return queueRecordWrite(FEE_STATE_LOCK, () => saveFeeSettings(feeStore(appConfig), value, actor, todayStr(), Date.now()));
}

// --- Links to an account that is about to be deleted (see ../links.js) ---------------------------------------------

// A member's or a request's account: the column is emptied, the id stays where the older apps read it
require('../links').holdLinks('users', async (appConfig, uid) => {
  for (const [collection, key] of [[MEMBERS, 'uid'], [REQUESTS, 'userId']]) {
    for (const row of await client.listAllRecords(collection, client.pbFilterEquals('user', uid), appConfig)) {
      const original = originalOf(row);
      const values = { ...(original.values || {}) };
      if (!has(values, key)) values[key] = uid;
      await client.updateRecord(collection, row.id, { user: '', original: { ...original, values } }, appConfig);
    }
  }
});

module.exports = {
  pruneChangeLog,
  CHANGE_LOG_YEARS,
  COLLECTIONS: { MEMBERS, PAYMENTS, PERIODS, STANDING_ORDERS, DONATIONS, EXPENSES, REQUESTS, FEE_CHANGES, FRESH_STARTS, CHANGES },
  FINANCE_STATE_KEYS,
  FEE_STATE_LOCK,
  isOrphan,
  keyOfMember,
  oldPeopleRecord,
  oldPaymentRecord,
  oldStatusRecord,
  oldExpenseRecord,
  oldRequestRecord,
  effectiveMember,
  linkContext,
  newRecordId,
  runBatch,
  getSetting,
  setSetting,
  listPeopleRecords,
  getPeopleRecord,
  upsertPeopleRecord,
  removePeopleRecord,
  pruneDeletedPeopleRecords,
  listExpenseRecords,
  syncExpenseRecords,
  getDonationsValue,
  saveDonations,
  donationsVersion,
  expensesVersion,
  listRequestRecords,
  getRequestRecord,
  upsertRequestRecord,
  updateRequestData,
  deleteRequestRecord,
  deleteRequestsOfUser,
  getStateValue,
  setStateValue,
  getFeeState,
  updateFeeResetState,
  updateFeeSchedule,
  saveSettings
};
