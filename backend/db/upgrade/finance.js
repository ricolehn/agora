// The upgrade of the books: people, payments, status_history, expenses, requests and the finance values of app_state
// (settings, donations, feeSchedule, feeResets) into the finance_* tables.
//
// plan() reads every old record and works out the new ones (nothing is written) together with what it noticed;
// apply() writes them; compare() checks that the new tables answer exactly like the old ones.
const { isDeepStrictEqual } = require('util');
const client = require('../client');
const codecs = require('../codecs/finance');
const shapes = require('../legacyShapes');
const store = require('../stores/finance');
const { amountValue, toCents } = require('../codec');
const { toDateStr } = require('../../utils/date');
const { firstDifference } = require('./differ');

const OLD_COLLECTIONS = ['people', 'payments', 'status_history', 'expenses', 'requests'];
const OLD_STATE_KEYS = ['settings', 'donations', 'expenses', 'feeSchedule', 'feeResets'];
const NEW_COLLECTIONS = [
  'finance_members', 'finance_standing_orders', 'finance_payments', 'finance_status_periods', 'finance_donations',
  'finance_expenses', 'finance_requests', 'finance_fee_changes', 'finance_fresh_starts', 'finance_changes'
];
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const has = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
const isEmpty = (value) => value === undefined || value === null || value === '';

/** What the check noticed, by kind: record ids only (no names, no amounts) - the report can be shared. */
function newFindings() {
  return {
    amountsAsText: [], amountsUnreadable: [], amountsWithFractionOfCent: [], datesInOtherSpelling: [], datesUnreadable: [],
    linksToMissingAccounts: [], unknownValues: [], listColumnsDisagreeWithRecord: [], paymentsWithoutMember: [], keysThatAreNoIds: []
  };
}

/** Notes what `original` holds for a record: amounts and dates the columns had to read, links that point nowhere. */
function noteOriginal(findings, where, original) {
  const values = original?.values || {};
  for (const [key, raw] of Object.entries(values)) {
    if (key === 'amount') {
      if (typeof raw === 'string') (amountValue(raw) === 0 && raw.trim() !== '' && !/^0+([.,]0*)?$/.test(raw.trim()) ? findings.amountsUnreadable : findings.amountsAsText).push(where);
      else if (typeof raw === 'number' && !toCents(raw).exact) findings.amountsWithFractionOfCent.push(where);
      else findings.unknownValues.push(`${where}.amount`);
    } else if (['date', 'startDate', 'endDate', 'memberSince', 'originalMemberSince', 'lastAutoPayment'].includes(key)) {
      const read = typeof raw === 'string' ? toDateStr(raw) : null;
      (read === '1970-01-01' && !String(raw).startsWith('1970') ? findings.datesUnreadable : findings.datesInOtherSpelling).push(`${where}.${key}`);
    } else if (['uid', 'userId', 'personId'].includes(key)) {
      findings.linksToMissingAccounts.push(`${where}.${key}`);
    } else {
      findings.unknownValues.push(`${where}.${key}`);
    }
  }
  if (original?.data) noteOriginal(findings, `${where}.data`, original.data);
}

async function readOld(appConfig) {
  const [people, payments, history, expenses, requests, state, users] = await Promise.all([
    ...OLD_COLLECTIONS.map((name) => client.listAllRecords(name, '', appConfig)),
    client.listAllRecords('app_state', '', appConfig),
    client.listAllRecords('users', '', appConfig, '', { fields: 'id' })
  ]);
  const stateRecord = (key) => state.find((record) => record.key === key) || null;
  return { people, payments, history, expenses, requests, stateRecord, userIds: new Set(users.map((user) => user.id)) };
}

/** Works out the new records of the books (in the order they are written) and what the check noticed. */
async function plan(appConfig) {
  const old = await readOld(appConfig);
  const findings = newFindings();
  const memberIds = new Map();
  const usedIds = new Set();
  const idFor = (key) => {
    const id = ID_PATTERN.test(key) && !usedIds.has(key) ? key : store.newRecordId();
    usedIds.add(id);
    if (id !== key) findings.keysThatAreNoIds.push(id);
    return id;
  };
  // Who exists: members (also those only payments name) and accounts
  for (const record of old.people) memberIds.set(String(record.personKey), idFor(String(record.personKey)));
  for (const record of [...old.payments, ...old.history]) {
    const key = String(record.personKey);
    if (!memberIds.has(key)) {
      memberIds.set(key, idFor(key));
      findings.paymentsWithoutMember.push(memberIds.get(key));
    }
  }
  const ctxFor = (recordId) => ({
    recordId,
    exists: (collection, id) => (collection === 'users' ? old.userIds.has(id) : collection === 'finance_members' ? [...memberIds.values()].includes(id) : false)
  });

  const members = [];
  const orders = [];
  const payments = [];
  const periods = [];
  const paymentsByKey = new Map();
  for (const record of old.payments) {
    const list = paymentsByKey.get(String(record.personKey)) || [];
    list.push(record);
    paymentsByKey.set(String(record.personKey), list);
  }

  // Members (and the standing orders their record held)
  for (const record of old.people) {
    const personKey = String(record.personKey);
    const id = memberIds.get(personKey);
    const data = record.data && typeof record.data === 'object' ? record.data : {};
    const effective = store.effectiveMember({ personKey, uid: record.uid, name: record.name, status: record.status, memberSince: record.memberSince, originalMemberSince: record.originalMemberSince, isDeleted: record.isDeleted, data });
    const encoded = codecs.member.encode(effective, ctxFor(id));
    const original = { ...(encoded.original || {}) };
    if (id !== personKey) original.key = personKey;
    if (data.standingOrders !== undefined && !Array.isArray(data.standingOrders)) original.standingOrders = data.standingOrders;
    // The list columns of the old record where they disagree with its own copy (code that read them gets the same)
    const rebuilt = store.oldPeopleRecord({ ...encoded.columns, id, original: Object.keys(original).length ? original : null }, [], []);
    const columns = {};
    for (const key of ['uid', 'name', 'status', 'memberSince', 'originalMemberSince']) {
      if ((record[key] ?? '') !== rebuilt[key]) columns[key] = record[key] ?? '';
    }
    const ownPayments = (paymentsByKey.get(personKey) || []).map((payment) => payment.data);
    if ((record.totalPaid ?? 0) !== shapes.calculateTotalPaid(ownPayments)) columns.totalPaid = record.totalPaid ?? 0;
    if (Object.keys(columns).length) {
      original.columns = columns;
      if (Object.keys(columns).some((key) => key !== 'totalPaid')) findings.listColumnsDisagreeWithRecord.push(id);
    }
    noteOriginal(findings, `finance_members/${id}`, encoded.original);
    const body = { ...encoded.columns, original: Object.keys(original).length ? original : null };
    members.push({ method: 'POST', collection: 'finance_members', body: { ...body, id } });

    if (Array.isArray(data.standingOrders)) {
      data.standingOrders.filter(Boolean).forEach((order, position) => {
        const encodedOrder = codecs.standingOrder.encode(order);
        const orderId = store.newRecordId();
        noteOriginal(findings, `finance_standing_orders/${orderId}`, encodedOrder.original);
        orders.push({ method: 'POST', collection: 'finance_standing_orders', body: { id: orderId, member: id, position, ...encodedOrder.columns, original: encodedOrder.original } });
      });
    }
  }
  // Members that only payments name: kept (never shown, as before) so no payment is lost
  for (const [key, id] of memberIds) {
    if (old.people.some((record) => String(record.personKey) === key)) continue;
    members.push({ method: 'POST', collection: 'finance_members', body: { id, name: `(${key})`, isDeleted: true, original: { orphan: true, ...(id !== key ? { key } : {}) } } });
  }

  // The standing orders that booked a payment, by member and the id the app gave them
  const orderIdOf = new Map(orders.map((op) => [`${op.body.member}:${JSON.stringify(op.body.clientId)}`, op.body.id]));
  for (const record of old.payments) {
    const personKey = String(record.personKey);
    const member = memberIds.get(personKey);
    const data = record.data && typeof record.data === 'object' ? record.data : {};
    const encoded = codecs.payment.encode(data);
    const original = { ...(encoded.original || {}) };
    if (shapes.buildStableChildKey('payment', personKey, data.id, 0, data) !== record.paymentKey || isEmpty(data.id)) original.key = record.paymentKey;
    if ((record.date ?? '') !== shapes.toOptionalText(data.date)) original.columns = { date: record.date ?? '' };
    const auto = encoded.columns.source === 'standingOrder' && typeof data.id === 'string' ? /^auto_(.+)_\d{4}-\d{2}-\d{2}$/.exec(data.id) : null;
    const id = store.newRecordId();
    noteOriginal(findings, `finance_payments/${id}`, encoded.original);
    payments.push({ method: 'POST', collection: 'finance_payments', body: { id, member, ...encoded.columns, standingOrder: (auto && orderIdOf.get(`${member}:${JSON.stringify(auto[1])}`)) || '', original: Object.keys(original).length ? original : null } });
  }
  for (const record of old.history) {
    const personKey = String(record.personKey);
    const data = codecs.withoutKeys(record.data && typeof record.data === 'object' ? record.data : {}, codecs.COMPUTED_STATUS_KEYS);
    const encoded = codecs.statusPeriod.encode(data);
    const original = { ...(encoded.original || {}) };
    if (shapes.buildStableChildKey('status', personKey, data.id, 0, data) !== record.historyKey || isEmpty(data.id)) original.key = record.historyKey;
    if ((record.startDate ?? '') !== shapes.toOptionalText(data.startDate)) original.columns = { startDate: record.startDate ?? '' };
    const id = store.newRecordId();
    noteOriginal(findings, `finance_status_periods/${id}`, encoded.original);
    periods.push({ method: 'POST', collection: 'finance_status_periods', body: { id, member: memberIds.get(personKey), ...encoded.columns, original: Object.keys(original).length ? original : null } });
  }

  // Expenses, requests, donations
  const expenses = old.expenses.map((record) => {
    const data = record.data && typeof record.data === 'object' ? record.data : {};
    const encoded = codecs.expense.encode(data);
    const original = { ...(encoded.original || {}) };
    if (shapes.buildExpenseRecordPayload(data, 0).expenseKey !== record.expenseKey || isEmpty(data.id)) original.key = record.expenseKey;
    const id = store.newRecordId();
    noteOriginal(findings, `finance_expenses/${id}`, encoded.original);
    return { method: 'POST', collection: 'finance_expenses', body: { id, ...encoded.columns, original: Object.keys(original).length ? original : null } };
  });
  const requests = old.requests.map((record) => {
    const requestKey = String(record.requestKey);
    const id = idFor(requestKey);
    const encoded = codecs.request.encode(record.data, ctxFor(id));
    const original = { ...(encoded.original || {}) };
    if (id !== requestKey) original.key = requestKey;
    if (record.data === null || record.data === undefined) original.noData = true;
    const rebuilt = store.oldRequestRecord({ ...encoded.columns, id, original: Object.keys(original).length ? original : null });
    const columns = {};
    for (const key of ['userId', 'personId', 'personName', 'type', 'status', 'timestamp']) {
      if (!isDeepStrictEqual(record[key] ?? (key === 'timestamp' ? null : ''), rebuilt[key])) columns[key] = record[key] ?? (key === 'timestamp' ? null : '');
    }
    if (Object.keys(columns).length) original.columns = columns;
    noteOriginal(findings, `finance_requests/${id}`, encoded.original);
    const body = { ...encoded.columns, original: Object.keys(original).length ? original : null };
    delete body.id;
    return { method: 'POST', collection: 'finance_requests', body: { id, ...body } };
  });
  const donationsValue = old.stateRecord('donations')?.value;
  const donationsAsMap = !Array.isArray(donationsValue);
  const donationEntries = Array.isArray(donationsValue) ? donationsValue.map((entry) => [null, entry]) : Object.entries(donationsValue && typeof donationsValue === 'object' ? donationsValue : {});
  const donations = donationEntries.filter(([, entry]) => entry).map(([objectKey, entry], position) => {
    const encoded = codecs.donation.encode(entry);
    const original = { ...(encoded.original || {}), ...(objectKey !== null ? { key: objectKey } : {}) };
    const id = store.newRecordId();
    noteOriginal(findings, `finance_donations/${id}`, encoded.original);
    return { method: 'POST', collection: 'finance_donations', body: { id, position, ...encoded.columns, original: Object.keys(original).length ? original : null } };
  });

  const ops = [...members, ...orders, ...payments, ...periods, ...expenses, ...requests, ...donations];
  const counts = {
    old: { people: old.people.length, payments: old.payments.length, status_history: old.history.length, expenses: old.expenses.length, requests: old.requests.length, donations: donations.length },
    new: { finance_members: members.length, finance_standing_orders: orders.length, finance_payments: payments.length, finance_status_periods: periods.length, finance_expenses: expenses.length, finance_requests: requests.length, finance_donations: donations.length }
  };
  const totals = {
    paymentsCents: payments.reduce((sum, op) => sum + op.body.amountCents, 0),
    donationsCents: donations.reduce((sum, op) => sum + op.body.amountCents, 0),
    expensesCents: expenses.reduce((sum, op) => sum + op.body.amountCents, 0)
  };
  return {
    ops,
    findings,
    counts,
    totals,
    state: {
      settings: old.stateRecord('settings'),
      feeSchedule: old.stateRecord('feeSchedule')?.value,
      feeResets: old.stateRecord('feeResets')?.value,
      donationsAsMap
    }
  };
}

/** Writes what plan() worked out. */
async function apply(appConfig, planned) {
  await store.runBatch(appConfig, planned.ops);
  if (planned.state.settings) await store.setSetting(appConfig, 'finance', planned.state.settings.value);
  await store.setSetting(appConfig, 'compat', { ...((await store.getSetting(appConfig, 'compat')) || {}), donations: planned.state.donationsAsMap ? 'object' : 'array' });
  if (planned.state.feeSchedule !== undefined) await store.setStateValue(appConfig, 'feeSchedule', planned.state.feeSchedule);
  if (planned.state.feeResets !== undefined) await store.setStateValue(appConfig, 'feeResets', planned.state.feeResets);
}

/**
 * Checks that the new tables answer exactly like the old ones: every member as the apps get it (with the balance,
 * paid until, what is overdue - worked out on both sides), the expenses, donations, requests, the fee state, the
 * statistics and the list of all bookings. Returns the differences (none: the upgrade may switch).
 */
async function compare(appConfig, { legacy }) {
  const differences = [];
  const differ = (what, a, b) => {
    if (!isDeepStrictEqual(a, b)) differences.push({ what, ...firstDifference(a, b) });
  };
  const personView = (record) => record && ({ personKey: record.personKey, uid: record.uid, name: record.name, status: record.status, memberSince: record.memberSince, originalMemberSince: record.originalMemberSince, totalPaid: record.totalPaid, isDeleted: record.isDeleted, data: record.data });
  const [oldPeople, newPeople] = await Promise.all([legacy.store.listPeopleRecords(appConfig), store.listPeopleRecords(appConfig)]);
  differ('the members (count and order)', oldPeople.map((p) => p.personKey), newPeople.map((p) => p.personKey));
  const newByKey = new Map(newPeople.map((p) => [p.personKey, p]));
  for (const person of oldPeople) differ(`member ${person.personKey}`, personView(person), personView(newByKey.get(person.personKey)));
  for (const person of oldPeople) {
    const [a, b] = await Promise.all([legacy.store.getPeopleRecord(appConfig, person.personKey), store.getPeopleRecord(appConfig, person.personKey)]);
    differ(`member ${person.personKey} read alone`, personView(a), personView(b));
  }
  const view = (records, fields) => records.map((record) => Object.fromEntries(fields.map((field) => [field, record[field]])));
  differ('the expenses', view(await legacy.store.listExpenseRecords(appConfig), ['expenseKey', 'data']), view(await store.listExpenseRecords(appConfig), ['expenseKey', 'data']));
  // As the old API answers them (an empty value is {})
  differ('the donations', (await legacy.store.getStateValue(appConfig, 'donations', {})) || {}, (await store.getStateValue(appConfig, 'donations')) || {});
  const requestFields = ['requestKey', 'userId', 'personId', 'personName', 'type', 'status', 'timestamp', 'data'];
  differ('the requests', view(await legacy.store.listRequestRecords(appConfig), requestFields), view(await store.listRequestRecords(appConfig), requestFields));
  differ('the fee state', await legacy.store.getFeeState(appConfig), await store.getFeeState(appConfig));
  differ('the statistics', await legacy.stats.aggregateStats(appConfig).catch((err) => `failed: ${err.message}`), await require('../../stats').aggregateStats(appConfig).catch((err) => `failed: ${err.message}`));
  differ('all bookings', await legacy.transactions.getPaginatedTransactions(appConfig, 1, 1000000, '').catch((err) => `failed: ${err.message}`), await require('../../transactions').getPaginatedTransactions(appConfig, 1, 1000000, '').catch((err) => `failed: ${err.message}`));
  return differences;
}

/** After the switch: the old tables and values go (the backup taken before keeps them). */
async function cleanup(appConfig) {
  for (const name of OLD_COLLECTIONS) await client.deleteCollection(appConfig, name).catch((err) => { if (err.status !== 404) throw err; });
  const state = await client.listAllRecords('app_state', '', appConfig).catch(() => []);
  for (const record of state) if (OLD_STATE_KEYS.includes(record.key)) await client.deleteRecord('app_state', record.id, appConfig);
}

module.exports = { key: 'finance', OLD_COLLECTIONS, OLD_STATE_KEYS, NEW_COLLECTIONS, plan, apply, compare, cleanup };
