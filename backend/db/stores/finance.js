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

/**
 * Records of [collection] belonging to the members [memberIds]: a few members by their ids, many with one read of the
 * whole table ([all]: every member - not kept in the read cache, the members memo keeps what it needs). The whole
 * records: asking PocketBase for some of their fields only (fields=...) makes the answer a third smaller, but picking
 * them costs PocketBase more than sending them (108,000 payments: 2.2 s instead of 1.5 s).
 */
const FEW_MEMBERS = 40;
async function rowsOfMembers(appConfig, collection, memberIds, { all = false } = {}) {
  if (!memberIds.length) return [];
  if (memberIds.length === 1) return client.listAllRecords(collection, client.pbFilterEquals('member', memberIds[0]), appConfig);
  if (!all && memberIds.length <= FEW_MEMBERS) return client.listAllRecords(collection, client.pbFilterIn('member', memberIds), appConfig);
  const wanted = new Set(memberIds);
  return (await client.listAllRecords(collection, '', appConfig, '', { cache: false })).filter((row) => wanted.has(row.member));
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

/** A member worked out from its rows ({ member, payments, periods, orders }) with the fee state [fees]. */
function hydrateRows(rows, fees) {
  const personKey = keyOfMember(rows.member);
  const oldPayments = rows.payments.map((payment) => oldPaymentRecord(payment, personKey));
  const record = oldPeopleRecord(rows.member, byPosition(rows.orders), rows.payments, { decodedPayments: oldPayments.map((payment) => payment.data) });
  const oldPeriods = rows.periods.map((period) => oldStatusRecord(period, record.personKey));
  return { record, rows, oldPayments, oldPeriods, data: shapes.hydratePersonRecord(record, oldPayments, oldPeriods, fees.settings, fees.resets, fees.schedule) };
}

// What PocketBase adds to every record and nothing here reads (the payments kept for all members are many)
const lean = (row) => {
  const { collectionId, collectionName, created, updated, ...kept } = row;
  return kept;
};

/**
 * The rows of the members [memberRows] ([all]: every member - whole tables, read past the read cache; [kept]: for the
 * members memo - the payments without what nothing here reads).
 */
async function rowsOf(appConfig, memberRows, { all = false, kept = false } = {}) {
  const ids = memberRows.map((row) => row.id);
  const [payments, periods, orders] = await Promise.all([PAYMENTS, PERIODS, STANDING_ORDERS].map((collection) => rowsOfMembers(appConfig, collection, ids, { all })));
  if (kept) for (let index = 0; index < payments.length; index += 1) payments[index] = lean(payments[index]);
  const paymentsBy = groupBy(payments, 'member');
  const periodsBy = groupBy(periods, 'member');
  const ordersBy = groupBy(orders, 'member');
  return memberRows.map((row) => ({ member: row, payments: paymentsBy.get(row.id) || [], periods: periodsBy.get(row.id) || [], orders: ordersBy.get(row.id) || [] }));
}

async function hydrateMembers(appConfig, memberRows, fees) {
  return (await rowsOf(appConfig, memberRows)).map((rows) => hydrateRows(rows, fees));
}

/** A member as the list of all members hands it out. */
const listed = ({ record, data }) => ({ ...record, isDeleted: Boolean(record.isDeleted || record.data?.isDeleted), data });

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

// --- All members, kept between reads (the memo) --------------------------------------------------------------
// All members with what the server works out for them (balance, paid until, overdue) are read by every app after every
// change. They are kept - each member's rows and what was worked out from them - and brought up to date by what was
// written since (client.changesSince): a save names the members it changed, and only their rows are read again; a
// change of the fees or a new day works every member out anew from the rows kept; anything else that touches the books
// (a write the server cannot place) reads them all again. Working them all out anew after every booking read every
// payment again: 2.3 s at 108,000 payments for the read every app makes after a change - no faster than before the new
// structure, and after any delete anywhere (a prayer request, a push device) seven times slower.
// Changes made outside the app (PocketBase's admin page) are seen after MEMBERS_MEMO_MS: then the database is asked how
// the books' tables stand, and only if they changed are the members read anew - in the background, while the kept ones
// are handed out.
const MEMBERS_MEMO_MS = 30 * 1000;
const localDay = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const ROW_TABLES = new Set([MEMBERS, PAYMENTS, PERIODS, STANDING_ORDERS]);
const FEE_TABLES = new Set([FEE_CHANGES, FRESH_STARTS]);

/** How the books' tables stand (records and newest change of each): the same as before, nothing in them changed. */
const rowTablesStand = async (appConfig) => JSON.stringify(await Promise.all([...ROW_TABLES].map((collection) => client.tableStand(collection, appConfig))));

// { seq: the last write it knows, at, day, fees, ids: member ids in their order, byId: id -> { rows, member }, list }
let memo = null;
let memoUpdate = null;
let memoRefresh = null;

/** What the writes since [seq] mean for the memo: { full } or the members to read again and whether the fees changed. */
function pendingChanges(seq) {
  const { complete, list } = client.changesSince(seq);
  const plan = { full: !complete, fees: false, members: new Set() };
  for (const change of list) {
    if (plan.full) break;
    if (!change.collections) {
      plan.full = true;
      break;
    }
    for (const collection of change.collections) {
      if (ROW_TABLES.has(collection)) {
        const named = change.tag?.members;
        if (Array.isArray(named) && named.length) for (const id of named) plan.members.add(id);
        else plan.full = true;
      } else if (FEE_TABLES.has(collection) || (collection === SETTINGS && (!change.tag?.area || change.tag.area === 'finance'))) {
        plan.fees = true;
      }
    }
  }
  return plan;
}

/** Every member read and worked out ([seq]: the last write known when the reading started). */
async function buildMemo(appConfig) {
  const seq = client.writeGeneration();
  const at = Date.now();
  const day = localDay();
  // How the tables stand before they are read: whatever changes after this is seen by the next look (refreshMemo)
  const stand = await rowTablesStand(appConfig);
  const [rows, fees] = await Promise.all([client.listAllRecords(MEMBERS, '', appConfig, '', { cache: false }), getFeeState(appConfig)]);
  const kept = rows.filter((row) => !isOrphan(row));
  const byId = new Map();
  for (const memberRows of await rowsOf(appConfig, kept, { all: true, kept: true })) byId.set(memberRows.member.id, { rows: memberRows, member: listed(hydrateRows(memberRows, fees)) });
  return { seq, at, day, fees, ids: kept.map((row) => row.id), byId, list: null, stand };
}

/** [current] brought up to date by [plan] (see pendingChanges): the members it names read again, all worked out anew for new fees or a new day. */
async function patchMemo(appConfig, current, plan) {
  const seq = client.writeGeneration();
  const day = localDay();
  const fees = plan.fees ? await getFeeState(appConfig) : current.fees;
  const next = { ...current, seq, day, fees, ids: [...current.ids], byId: new Map(current.byId), list: null, readOnly: null };
  const changed = [...plan.members];
  if (changed.length) {
    const rows = changed.length === 1
      ? [await client.getRecord(MEMBERS, changed[0], appConfig)].filter(Boolean)
      : await client.listAllRecords(MEMBERS, client.pbFilterIn('id', changed), appConfig);
    const found = new Map(rows.filter((row) => !isOrphan(row)).map((row) => [row.id, row]));
    for (const memberRows of await rowsOf(appConfig, [...found.values()], { kept: true })) next.byId.set(memberRows.member.id, { rows: memberRows, member: listed(hydrateRows(memberRows, fees)) });
    for (const id of changed) {
      if (!found.has(id)) {
        next.byId.delete(id);
        next.ids = next.ids.filter((other) => other !== id);
      } else if (!current.byId.has(id)) {
        // A new member: last, as the table lists it (in the order the records were made)
        next.ids.push(id);
      }
    }
  }
  if (plan.fees || day !== current.day) {
    const untouched = next.ids.filter((id) => !plan.members.has(id));
    for (const id of untouched) {
      const entry = next.byId.get(id);
      next.byId.set(id, { rows: entry.rows, member: listed(hydrateRows(entry.rows, fees)) });
    }
  }
  return next;
}

/**
 * Reads all members anew in the background (the kept ones are handed out meanwhile) - when the books' tables changed
 * since they were read whole: by the server itself (its own writes the memo took in already) or outside it. Read whole
 * every 30 seconds, every payment of every year was read twice a minute while anyone used the app, for changes on
 * PocketBase's admin page that hardly ever come; now four small questions find out first.
 */
function refreshMemo(appConfig) {
  if (memoRefresh) return;
  const current = memo;
  memoRefresh = (async () => {
    if (current?.stand && current.stand === await rowTablesStand(appConfig)) {
      current.at = Date.now();
      return;
    }
    const fresh = await buildMemo(appConfig);
    // A newer full read has come in meanwhile: it stays
    if (!memo || memo.at <= fresh.at) memo = fresh;
  })()
    .catch((err) => console.warn('[People] Reading the members anew failed:', err.message))
    .finally(() => { memoRefresh = null; });
}

/**
 * The memo, up to date with every write made through this server before this call. Writes that come in while it is
 * brought up to date are newer than the call: after a few rounds it is handed out as it is (the next call takes them).
 */
async function currentMemo(appConfig) {
  for (let round = 0; ; round += 1) {
    while (memoUpdate) await memoUpdate.catch(() => {});
    if (memo) {
      const plan = pendingChanges(memo.seq);
      const idle = !plan.full && !plan.fees && !plan.members.size && memo.day === localDay();
      if (idle || round >= 3) {
        if (idle && Date.now() - memo.at >= MEMBERS_MEMO_MS) refreshMemo(appConfig);
        return memo;
      }
      // Many members at once (the standing orders of the month), or one the memo does not hold yet (a new member: it
      // takes the place the table gives it): all read anew
      const full = plan.full || plan.members.size > Math.max(FEW_MEMBERS, memo.ids.length / 4) || [...plan.members].some((id) => !memo.byId.has(id));
      const base = memo;
      memoUpdate = (full ? buildMemo(appConfig) : patchMemo(appConfig, base, plan)).then((next) => {
        // A full read that finished in the background meanwhile is newer than a patch of what it replaced
        if (memo === base || memo.at <= next.at) memo = next;
      });
    } else {
      memoUpdate = buildMemo(appConfig).then((next) => { memo = next; });
    }
    try {
      await memoUpdate;
    } finally {
      memoUpdate = null;
    }
  }
}

// A member of the memo as membersReadOnly and memberReadOnly hand it out
const readOnlyEntry = (entry) => ({ row: entry.rows.member, payments: entry.rows.payments, periods: entry.rows.periods, orders: entry.rows.orders, person: entry.member });

/** The members of the memo in their order (shared: callers must not change them). */
function memoList(current) {
  if (!current.list) current.list = current.ids.map((id) => current.byId.get(id).member);
  return current.list;
}

/**
 * Every member as the old API hands them out (query: one member's own by account or name, as before). [shared]: for a
 * caller that only reads them and changes nothing (an answer of the server, a sum) - the kept members themselves. A
 * copy of them all took longer than the rest of such a read: the bookings list and the read of all members were
 * slower than before the new structure at 150 members x 20 years. Everyone else gets a copy of their own to change.
 */
async function listPeopleRecords(appConfig, query = {}, { shared = false } = {}) {
  const filtered = (query.orderByChild === 'uid' || query.orderByChild === 'name') && query.equalTo !== undefined;
  // One member's own entries (by account or name) before anything was kept: worked out alone
  if (filtered && !memo) {
    const [rows, fees] = await Promise.all([client.listAllRecords(MEMBERS, '', appConfig), getFeeState(appConfig)]);
    // The old query compared the list column (record.uid / record.name); worked out on the rebuilt records
    const wanted = String(query.equalTo);
    const members = rows.filter((row) => !isOrphan(row) && oldPeopleRecord(row)[query.orderByChild] === wanted);
    return (await hydrateMembers(appConfig, members, fees)).map(listed);
  }
  const members = memoList(await currentMemo(appConfig));
  const picked = filtered ? members.filter((member) => member[query.orderByChild] === String(query.equalTo)) : members;
  return shared ? picked : structuredClone(picked);
}

/**
 * Every member with its rows, from the memo - read only, never changed (API v2 and the AI read what they need from
 * it): [{ row: the member's row, payments, periods, orders: its rows, person: the member as listPeopleRecords hands it
 * out }].
 */
async function membersReadOnly(appConfig) {
  const current = await currentMemo(appConfig);
  // The same list as long as the memo is the same (what is worked out from it can be kept with it)
  if (!current.readOnly) current.readOnly = current.ids.map((id) => readOnlyEntry(current.byId.get(id)));
  return current.readOnly;
}

/**
 * One member with its rows, as membersReadOnly hands them out (read only), or null when there is none. From the memo
 * when it is up to date or a save of a few members away from it - after a booking of anyone else its own rows were
 * read again; otherwise the member is read alone: the first read after a start, a new day or new fees must not work
 * out every member for one of them.
 */
async function memberReadOnly(appConfig, id) {
  const key = String(id || '');
  if (!key) return null;
  if (memo && !memoUpdate && memo.day === localDay()) {
    const plan = pendingChanges(memo.seq);
    const few = !plan.full && !plan.fees && plan.members.size <= FEW_MEMBERS && [...plan.members].every((member) => memo.byId.has(member));
    if (few) {
      const entry = (await currentMemo(appConfig)).byId.get(key);
      return entry ? readOnlyEntry(entry) : null;
    }
  }
  const row = await client.getRecord(MEMBERS, key, appConfig);
  if (!row || isOrphan(row)) return null;
  const [fees, [rows]] = await Promise.all([getFeeState(appConfig), rowsOf(appConfig, [row])]);
  return { row, payments: rows.payments, periods: rows.periods, orders: rows.orders, person: listed(hydrateRows(rows, fees)) };
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
 * The operations that make the stored child records of one member ([existing], with their keys) match [wanted] -
 * the whole list as it was sent, as the old server did: what the list no longer holds is deleted, also when the list
 * came without a version. (For a while a record added after the newest record the list knows was kept in that case,
 * to protect it from an app with a stale list. But a list never says what its sender had seen: the entry a treasurer
 * had just deleted stayed in the books, and entries without an id - their key holds their place in the list - were
 * left behind and written anew, twice in the books, whenever the list changed above them.)
 * Entries with the same key (the same id twice in one list) pair up with the stored records one by one, in order.
 *
 * An entry may name several keys (`keys`, the surest first): what one key leaves unpaired is paired by the next - an
 * entry of the list in another form (a list that was kept as a map) or at another place still finds its record.
 */
function diffChildren(collection, memberId, existing, wanted, { extraColumns = () => ({}) } = {}) {
  const ops = [];
  const pairs = pairChildren(existing, wanted);
  wanted.forEach((entry, index) => {
    const current = pairs.get(entry);
    const body = { member: memberId, ...entry.columns, ...extraColumns(entry, index), original: entry.original };
    if (!current) ops.push({ method: 'POST', collection, body: { id: entry.id || newRecordId(), ...body } });
    else if (!sameRow(current.row, body)) ops.push({ method: 'PATCH', collection, id: current.row.id, body });
  });
  const paired = new Set(pairs.values());
  for (const entry of existing) {
    if (!paired.has(entry)) ops.push({ method: 'DELETE', collection, id: entry.row.id });
  }
  return { ops };
}

const keysOf = (entry) => entry.keys || [entry.key];

/**
 * Which stored record ([existing]: { key or keys, row }) each entry of [wanted] is: a Map from the wanted entry to the
 * stored one. Key by key: the first keys pair what they can (one by one, in order), the next keys what is left - a
 * key that is null pairs nothing.
 */
function pairChildren(existing, wanted) {
  const pairs = new Map();
  const taken = new Set();
  const rounds = Math.max(1, ...existing.map((entry) => keysOf(entry).length), ...wanted.map((entry) => keysOf(entry).length));
  for (let round = 0; round < rounds; round += 1) {
    const free = new Map();
    for (const entry of existing) {
      const key = keysOf(entry)[round];
      if (taken.has(entry) || key === undefined || key === null) continue;
      const list = free.get(key);
      if (list) list.push(entry);
      else free.set(key, [entry]);
    }
    for (const entry of wanted) {
      const key = keysOf(entry)[round];
      if (pairs.has(entry) || key === undefined || key === null) continue;
      const current = free.get(key)?.shift();
      if (!current) continue;
      pairs.set(entry, current);
      taken.add(current);
    }
  }
  return pairs;
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

// [tag]: what the writes changed - { members: [ids] } for the writes of members (the members memo reads only them again)
async function runBatch(appConfig, ops, { tag = null } = {}) {
  for (let start = 0; start < ops.length; start += client.BATCH_MAX_REQUESTS) {
    await client.batchWrite(appConfig, ops.slice(start, start + client.BATCH_MAX_REQUESTS), { tag });
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
 * without it the member is written as sent, like the old server did.
 */
function upsertPeopleRecord(appConfig, personKey, value, expectedUpdated = null, { actor = null } = {}) {
  return queueRecordWrite(`people:${personKey}`, async () => {
    const payload = shapes.buildPersonRecordPayload(personKey, value);
    // Checked before anything is written: a record PocketBase refuses must not leave payments half written
    if (!payload.name || !payload.data) throw Object.assign(new Error('A person record needs a name.'), { status: 400 });
    // The old table refused a status period without a status or a start (required fields): so does this one
    for (const period of shapes.normalizeRecordListInput(value?.statusHistory)) {
      if (shapes.toOptionalText(period?.status) === '' || shapes.toOptionalText(period?.startDate) === '') {
        throw Object.assign(new Error('A status period needs a status and a start date.'), { status: 400 });
      }
    }
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

    // The child records, with the keys the old server gave them. A member that is new has none to compare with - also
    // when payments are kept under its key from a member whose record was gone: they stay, and are the new member's
    // (the old server wrote a new member's entries next to whatever its key already held)
    const rows = existing
      ? await Promise.all([PAYMENTS, PERIODS, STANDING_ORDERS].map((collection) => client.listAllRecords(collection, client.pbFilterEquals('member', existing.id), appConfig)))
      : [[], [], []];
    const [paymentRows, periodRows, orderRows] = rows;
    const keyOf = (prefix, decode) => (row) => {
      const data = decode(row);
      const stored = originalOf(row).key;
      return { key: typeof stored === 'string' ? stored : shapes.buildStableChildKey(prefix, String(personKey), data.id, 0, data), row };
    };
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
    const orders = diffChildren(STANDING_ORDERS, memberId, orderRows.map(orderKey), wantedOrders, { extraColumns: (entry, index) => ({ position: index }) });
    // Standing orders of the member by the id the apps gave them: the payments they booked link to them
    const orderIdByClientId = new Map();
    for (const row of orderRows) orderIdByClientId.set(JSON.stringify(codecs.standingOrder.decode(row).id), row.id);
    for (const op of orders.ops) if (op.method === 'POST') orderIdByClientId.set(JSON.stringify(op.body.clientId), op.body.id);
    const standingOrderOf = (columns) => {
      const match = columns.source === 'standingOrder' && typeof columns.clientId === 'string' ? /^auto_(.+)_\d{4}-\d{2}-\d{2}$/.exec(columns.clientId) : null;
      return (match && orderIdByClientId.get(JSON.stringify(match[1]))) || '';
    };
    const payments = diffChildren(PAYMENTS, memberId, paymentRows.map(keyOf('payment', codecs.payment.decode)), childEntries('payment', String(personKey), value?.payments, codecs.payment), {
      extraColumns: (entry) => ({ standingOrder: standingOrderOf(entry.columns) })
    });
    const periods = diffChildren(PERIODS, memberId, periodRows.map(keyOf('status', codecs.statusPeriod.decode)), childEntries('status', String(personKey), value?.statusHistory, codecs.statusPeriod, codecs.COMPUTED_STATUS_KEYS));

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
    await runBatch(appConfig, ops, { tag: { members: [memberId] } });
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
  ], { tag: { members: [row.id] } }));
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

const isPlainEntry = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The columns and `original` of one entry of the donations list ([objectKey]: its key in the map the first versions
 * kept). An entry that is no donation - a hole in the list (null, as `delete list[i]` and lists from Firebase leave
 * them) or a bare number or text - is kept exactly as written (original.entry): the old API hands it back where it
 * was. Turned into an empty donation, it made the upgrade's comparison differ on every attempt.
 */
function donationBody(entry, objectKey = null) {
  const isDonation = isPlainEntry(entry);
  const { columns, original } = codecs.donation.encode(isDonation ? entry : {});
  const kept = isDonation ? { ...(original || {}) } : { entry };
  if (objectKey !== null) kept.key = objectKey;
  return { columns, original: Object.keys(kept).length ? kept : null };
}

/** True for a row that holds no donation, only an entry kept as written (see donationBody). */
const isKeptEntry = (row) => has(originalOf(row), 'entry');

/** A donation (or a kept entry) as the apps wrote it. */
const decodeDonation = (row) => (isKeptEntry(row) ? originalOf(row).entry : codecs.donation.decode(row));

/** The donations as the old API hands them out: the list (or the map by id the first versions kept) as it was written. */
async function getDonationsValue(appConfig) {
  const [rows, compat] = await Promise.all([getDonationRows(appConfig), readCompat(appConfig)]);
  // A fresh instance has the empty map {} (as always); the web app's first save makes it a list
  const asMap = compat.donations !== 'array';
  if (!asMap) return rows.map(decodeDonation);
  return Object.fromEntries(rows.map((row, index) => [typeof originalOf(row).key === 'string' ? originalOf(row).key : String(index), decodeDonation(row)]));
}

/**
 * The holes (null) the donations list of an older instance kept: the statistics and the bookings of the old server
 * failed on them (and the upgrade copies them exactly). Removed once after the upgrade; returns how many.
 */
async function removeDonationHoles(appConfig) {
  return queueRecordWrite('finance:donations', async () => {
    const holes = (await getDonationRows(appConfig)).filter((row) => isKeptEntry(row) && originalOf(row).entry === null);
    await runBatch(appConfig, holes.map((row) => ({ method: 'DELETE', collection: DONATIONS, id: row.id })));
    return holes.length;
  });
}

/** The key of an entry that has an id of its own ('id:<the id as JSON>'), else null. */
const idKeyOf = (entry) => (isPlainEntry(entry) && entry.id !== undefined && entry.id !== null && entry.id !== '' ? `id:${JSON.stringify(entry.id)}` : null);
/** The key of an entry by everything it holds (its id included: entries with different ids never pair). */
const contentKeyOf = (entry) => `content:${shapes.stableSerialize(entry)}`;
/** The key of a stored record, as a write that knows which record an entry is names it ([rowIds], see saveDonations). */
const rowKeyOf = (id) => (typeof id === 'string' && id ? `row:${id}` : null);

/**
 * The entries of a list sent as a whole ([value]: a list, or a map by key as the first versions kept the donations)
 * as [objectKey, entry, rowId]: [rowIds] names the record each entry of a list is (a write of the server that read the
 * records itself, API v2; null where it is new). Holes (null) are no entries.
 */
function sentEntries(value, rowIds, { keepKeys }) {
  const isMap = Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const entries = isMap
    ? Object.entries(value).map(([objectKey, entry]) => [keepKeys ? objectKey : null, entry, null])
    : (Array.isArray(value) ? value : []).map((entry, index) => [null, entry, Array.isArray(rowIds) ? rowIds[index] ?? null : null]);
  return { isMap, entries: entries.filter(([, entry]) => entry !== null && entry !== undefined) };
}

/**
 * The change log of a list saved as a whole: what was added, removed, or changed as the apps see it. A record that only
 * moved in the list, or only lost the key of the map it was kept in, is no change of it.
 */
function listChangeOps(area, ops, rows, decode) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const changed = (op) => op.method !== 'PATCH' || !isDeepStrictEqual(decode(byId.get(op.id) || {}), decode({ ...(byId.get(op.id) || {}), ...op.body }));
  return changeOpsFor(area, ops.filter(changed), rows, decode);
}

/**
 * Saves the donations an app sends as a whole ([value]: list or map). With [expectedVersion] (the web app) a list that
 * changed meanwhile is refused (409); without (older apps) the list is written as sent, like the old server did.
 *
 * Every donation keeps its record, whatever form the list comes in: by the record a write names ([rowIds]), the key of
 * the map, the donation's own id, or what it holds - in that order. The first versions kept the donations as a map;
 * the web app and the apps send a list. That list paired with no record of the map: every donation was removed and
 * written anew - new record ids, and the change log full of removals and additions - at the first save of each
 * instance, a donation saved through API v2 included.
 */
function saveDonations(appConfig, value, { expectedVersion, rowIds = null } = {}) {
  return queueRecordWrite('finance:donations', async () => {
    const rows = await getDonationRows(appConfig);
    if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== listVersion(rows)) throw Object.assign(new Error('Conflict'), { status: 409 });
    const { isMap, entries } = sentEntries(value, rowIds, { keepKeys: true });
    const keyOfEntry = (objectKey, entry, index) => {
      if (objectKey !== null) return `key:${objectKey}`;
      return idKeyOf(entry) || `content:${index}:${shapes.stableSerialize(entry)}`;
    };
    // A hole in the list (null) is no entry: the statistics and the bookings of the old server failed on it
    const wanted = entries.map(([objectKey, entry, rowId], index) => {
      const { columns, original } = donationBody(entry, objectKey);
      return { keys: [rowKeyOf(rowId), keyOfEntry(objectKey, entry, index), idKeyOf(entry), contentKeyOf(entry)], columns, original };
    });
    const existing = rows.map((row, index) => {
      const data = decodeDonation(row);
      return { keys: [rowKeyOf(row.id), keyOfEntry(typeof originalOf(row).key === 'string' ? originalOf(row).key : null, data, index), idKeyOf(data), contentKeyOf(data)], row };
    });
    const { ops } = diffChildren(DONATIONS, null, existing, wanted, { extraColumns: (entry, index) => ({ position: index }) });
    for (const op of ops) if (op.body) delete op.body.member;
    await runBatch(appConfig, [...ops, ...listChangeOps('donation', ops, rows, decodeDonation)]);
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

/**
 * Saves the expenses an app sends as a whole (see saveDonations for [expectedVersion] and [rowIds]). Every expense
 * keeps its record: by the record a write names, its key, its own id, or what it holds - an expense of an older app
 * without an id (its key holds its place in the list) was written anew whenever an entry above it was added or removed.
 */
function syncExpenseRecords(appConfig, value, { expectedVersion, rowIds = null } = {}) {
  return queueRecordWrite('finance:expenses', async () => {
    const rows = await getExpenseRows(appConfig);
    if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== listVersion(rows)) throw Object.assign(new Error('Conflict'), { status: 409 });
    // As normalizeRecordListInput: a list or the values of a map, without what is no entry
    const entries = sentEntries(value, rowIds, { keepKeys: false }).entries.filter(([, expense]) => Boolean(expense));
    const wanted = entries.map(([, expense, rowId], index) => {
      const payload = shapes.buildExpenseRecordPayload(expense, index);
      const hasId = expense && expense.id !== undefined && expense.id !== null && expense.id !== '';
      const { columns, original } = codecs.expense.encode(expense);
      return { keys: [rowKeyOf(rowId), payload.expenseKey, idKeyOf(expense), contentKeyOf(expense)], columns, original: hasId ? original : { ...(original || {}), key: payload.expenseKey } };
    });
    const decode = (row) => codecs.expense.decode(row);
    const existing = rows.map((row) => {
      const data = decode(row);
      return { keys: [rowKeyOf(row.id), oldExpenseRecord(row).expenseKey, idKeyOf(data), contentKeyOf(data)], row };
    });
    const { ops } = diffChildren(EXPENSES, null, existing, wanted);
    for (const op of ops) if (op.body) delete op.body.member;
    await runBatch(appConfig, [...ops, ...listChangeOps('expense', ops, rows, decode)]);
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
  // The area tells the members memo whether the fees may have changed (only 'finance' holds them)
  if (existing) return client.updateRecord(SETTINGS, existing.id, { value }, appConfig, { tag: { area } });
  return client.createRecord(SETTINGS, { area, value }, appConfig, { tag: { area } });
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
      await client.updateRecord(collection, row.id, { user: '', original: { ...original, values } }, appConfig, { tag: collection === MEMBERS ? { members: [row.id] } : null });
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
  donationBody,
  decodeDonation,
  isKeptEntry,
  removeDonationHoles,
  membersReadOnly,
  memberReadOnly,
  donationsVersion,
  expensesVersion,
  listVersion,
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
