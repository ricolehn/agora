// The finance records as the apps write them, and as the new tables keep them (see ../codec.js).
//
// The default shapes (canonicalKeys) are the ones the current web app writes - for its records `original` stays
// empty. Everything older apps wrote differently comes back exactly as they wrote it.
const { createCodec, fieldKinds: f } = require('../codec');
const { INCOME_STATUSES, REQUEST_TYPES, REQUEST_STATES } = require('../schema/finance');

const when = (condition, keys) => (condition ? keys : []);
const hasClientId = (row) => row.clientId !== null && row.clientId !== undefined;

// The server works these out whenever it hands a member out (derivedData.preprocessPersonServerSide,
// hydratePersonRecord) - an app that writes a member back sends its last copy of them along. They are not stored.
const COMPUTED_MEMBER_KEYS = new Set([
  '_paidUntil', '_statusMeta', '_overdueAmount', '_currentStatus', '_currentBalance', '_anticipatedPayment', '_overpayment',
  '_feeReset', '_feeCarriedOver', '_feeWrittenOff', '_monthlyFee', 'totalPaid', 'payments', 'statusHistory', 'standingOrders'
]);
// prepareStatusHistory gives every status entry its months as numbers; written back, they are not stored either
const COMPUTED_STATUS_KEYS = new Set(['startTotal', 'endTotal']);

const withoutKeys = (object, keys) => Object.fromEntries(Object.entries(object && typeof object === 'object' ? object : {}).filter(([key]) => !keys.has(key)));

/** A payment of a member: { amount, date, description, id } (+ isAuto for standing orders, receipt). */
const payment = createCodec({
  fields: {
    id: f.json('clientId'),
    amount: f.money('amountCents'),
    date: f.day('date'),
    description: f.text('description'),
    receipt: f.text('receipt'),
    isAuto: {
      column: 'source',
      toColumn: (value, source) => (value === true ? 'standingOrder' : String(source.id ?? '').startsWith('req_') ? 'request' : 'manual'),
      fromColumn: (stored) => stored === 'standingOrder'
    }
  },
  canonicalKeys: (row) => ['amount', 'date', 'description', ...when(hasClientId(row), ['id']), ...when(row.source === 'standingOrder', ['isAuto']), ...when(row.receipt, ['receipt'])]
});

/** A period of a member's income status: { status, startDate } (+ endDate, id). */
const statusPeriod = createCodec({
  fields: {
    id: f.json('clientId'),
    status: f.select('status', INCOME_STATUSES),
    startDate: f.day('startDate'),
    endDate: f.day('endDate')
  },
  canonicalKeys: (row) => ['status', 'startDate', ...when(row.endDate, ['endDate']), ...when(hasClientId(row), ['id'])]
});

/** A standing order: { id, amount, startDate, note, lastAutoPayment } (+ endDate). */
const standingOrder = createCodec({
  fields: {
    id: f.json('clientId'),
    amount: f.money('amountCents'),
    startDate: f.day('startDate'),
    endDate: f.day('endDate'),
    note: f.text('note'),
    lastAutoPayment: f.day('lastAutoPayment', { empty: null })
  },
  canonicalKeys: (row) => [...when(hasClientId(row), ['id']), 'amount', 'startDate', 'note', 'lastAutoPayment', ...when(row.endDate, ['endDate'])]
});

/** A donation: { amount, name, date, description, id }. */
const donation = createCodec({
  fields: {
    id: f.json('clientId'),
    amount: f.money('amountCents'),
    name: f.text('donorName'),
    date: f.day('date'),
    description: f.text('description')
  },
  canonicalKeys: (row) => ['amount', 'name', 'date', 'description', ...when(hasClientId(row), ['id'])]
});

/** An expense: { id, amount, description, issuer, date } (+ receipt). */
const expense = createCodec({
  fields: {
    id: f.json('clientId'),
    amount: f.money('amountCents'),
    description: f.text('description'),
    issuer: f.text('issuer'),
    date: f.day('date'),
    receipt: f.text('receipt')
  },
  canonicalKeys: (row) => [...when(hasClientId(row), ['id']), 'amount', 'description', 'issuer', 'date', ...when(row.receipt, ['receipt'])]
});

/** What a request asks for (request.data); its shape depends on the kind of request. */
const requestData = createCodec({
  fields: {
    amount: f.money('amountCents', { asString: true }),
    date: f.day('date'),
    note: f.text('note'),
    description: f.text('description'),
    receipt: f.text('receipt'),
    newStatus: f.select('newStatus', INCOME_STATUSES)
  },
  canonicalKeys: (row) => {
    if (row.type === 'status') return ['newStatus', 'date'];
    if (row.type === 'expense') return ['amount', 'description', 'date', ...when(row.receipt, ['receipt'])];
    if (row.type === 'payment' || row.type === 'standing_order') return ['amount', 'date', 'note'];
    return [];
  }
});

/**
 * A request: { id, type, userId, personId, personName, data, status, timestamp } (+ decidedAt, rejectionReason). What
 * it asks for (data) lives in columns of the same record (requestData); its `original`, if any, is kept under
 * original.data.
 */
const requestTop = createCodec({
  fields: {
    id: { column: 'id', toColumn: (value, source, ctx) => ctx.recordId ?? String(value ?? ''), fromColumn: (stored) => stored },
    type: f.select('type', REQUEST_TYPES),
    userId: f.link('user', 'users'),
    personId: f.link('member', 'finance_members'),
    personName: f.text('memberName'),
    status: f.select('status', REQUEST_STATES),
    timestamp: f.millis('submittedAt'),
    decidedAt: f.millis('decidedAt'),
    rejectionReason: f.text('rejectionReason'),
    // data is encoded on its own (requestData); here it only has to be there (encode hands it over in outer.data)
    data: { column: null, toColumn: () => undefined, fromColumn: (stored, row) => row.data }
  },
  canonicalKeys: (row) => ['id', 'type', 'userId', 'personId', 'personName', 'data', 'status', 'timestamp', ...when(row.decidedAt, ['decidedAt']), ...when(row.rejectionReason, ['rejectionReason'])]
});

const request = {
  encode(value, ctx = {}) {
    const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const dataIsObject = Boolean(object.data) && typeof object.data === 'object' && !Array.isArray(object.data);
    const top = requestTop.encode(object, ctx, { data: object.data });
    const inner = requestData.encode(dataIsObject ? object.data : {}, ctx, top.columns);
    const original = { ...(top.original || {}) };
    if (has(object, 'data') && !dataIsObject) original.values = { ...(original.values || {}), data: object.data };
    else if (inner.original) original.data = inner.original;
    return { columns: { ...inner.columns, ...top.columns }, original: Object.keys(original).length ? original : null };
  },
  decode(row) {
    const original = row.original && typeof row.original === 'object' ? row.original : {};
    const top = requestTop.decode({ ...row, data: undefined });
    if (!has(top, 'data') || (original.values && has(original.values, 'data'))) return top;
    return { ...top, data: requestData.decode({ ...row, original: original.data || null }) };
  }
};

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * A member's own values, as the server hands them out (the keys it always fills - id, uid, name, status, the
 * membership days - with the values it fills them with) plus whatever else the record holds (pays, isDeleted, notes,
 * fields of older apps). Payments, status periods and standing orders are records of their own.
 */
const member = createCodec({
  fields: {
    id: { column: 'id', toColumn: (value, source, ctx) => ctx.recordId ?? String(value ?? ''), fromColumn: (stored) => stored },
    uid: f.link('user', 'users'),
    name: f.text('name'),
    status: f.select('status', INCOME_STATUSES),
    memberSince: f.day('memberSince'),
    originalMemberSince: f.day('originalMemberSince'),
    pays: f.bool('pays'),
    isDeleted: f.bool('isDeleted')
  },
  canonicalKeys: (row) => ['id', 'uid', 'name', 'status', 'memberSince', 'originalMemberSince', ...(row.isDeleted ? ['isDeleted'] : ['pays'])]
});

module.exports = {
  payment,
  statusPeriod,
  standingOrder,
  donation,
  expense,
  request,
  requestData,
  member,
  COMPUTED_MEMBER_KEYS,
  COMPUTED_STATUS_KEYS,
  withoutKeys
};
