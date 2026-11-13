// The shapes of the finance data as the old API hands them out and the apps write them: a member record ("people")
// with its payments and status history as separate records, the keys that identify them, and how a member is put
// together for the apps (hydratePersonRecord). Pure functions - the new storage (stores/finance.js) rebuilds these
// shapes from its tables and runs the same functions on them, so every number comes out exactly as before.
const crypto = require('crypto');
const { preprocessPersonServerSide } = require('../derivedData');

function normalizeRecordListInput(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'object') return Object.values(value).filter(Boolean);
  return [];
}

function toOptionalText(value) {
  if (value === undefined || value === null || value === '') return '';
  return String(value);
}

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ⚡ Bolt: Replaced Array.reduce with a for loop to eliminate callback execution overhead and reduce CPU time
function calculateTotalPaid(payments) {
  const list = normalizeRecordListInput(payments);
  let sum = 0;
  for (let i = 0; i < list.length; i++) {
    const amount = Number(String(list[i]?.amount || 0).replace(/\.(?=.*,)/g, '').replace(',', '.'));
    if (Number.isFinite(amount)) sum += amount;
  }
  return sum;
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildStableChildKey(prefix, ownerKey, itemKey, index, value) {
  const stableSource = itemKey !== undefined && itemKey !== null && itemKey !== ''
    ? String(itemKey)
    : stableSerialize([ownerKey, index, value]);
  return crypto.createHash('sha256').update(`${prefix}:${ownerKey}:${stableSource}`).digest('hex').slice(0, 32);
}

function stripNormalizedPersonData(value) {
  if (!value || typeof value !== 'object') return null;
  const data = { ...value };
  delete data.payments;
  delete data.statusHistory;
  data.totalPaid = calculateTotalPaid(value.payments);
  return data;
}

function buildPaymentRecordPayload(personKey, payment, index = 0) {
  const normalized = payment && typeof payment === 'object' ? { ...payment } : {};
  return {
    paymentKey: buildStableChildKey('payment', personKey, normalized.id, index, normalized),
    personKey: String(personKey),
    amount: toFiniteNumber(normalized.amount),
    date: toOptionalText(normalized.date),
    description: toOptionalText(normalized.description),
    data: normalized
  };
}

function buildStatusHistoryRecordPayload(personKey, entry, index = 0) {
  const normalized = entry && typeof entry === 'object' ? { ...entry } : {};
  return {
    historyKey: buildStableChildKey('status', personKey, normalized.id, index, normalized),
    personKey: String(personKey),
    status: toOptionalText(normalized.status),
    startDate: toOptionalText(normalized.startDate),
    endDate: toOptionalText(normalized.endDate),
    data: normalized
  };
}

function buildExpenseRecordPayload(expense, index = 0) {
  const normalized = expense && typeof expense === 'object' ? { ...expense } : {};
  return {
    expenseKey: buildStableChildKey('expense', 'global', normalized.id, index, normalized),
    amount: toFiniteNumber(normalized.amount),
    date: toOptionalText(normalized.date),
    issuer: toOptionalText(normalized.issuer),
    description: toOptionalText(normalized.description),
    receipt: toOptionalText(normalized.receipt),
    data: normalized
  };
}

function groupRecordsBy(records, keyField) {
  const acc = {};
  for (let i = 0, len = records.length; i < len; i++) {
    const record = records[i];
    const key = record?.[keyField];
    if (key) {
      if (!acc[key]) acc[key] = [];
      acc[key].push(record);
    }
  }
  return acc;
}

function getChildRecordIdentity(record) {
  return toOptionalText(
    record?.data?.id
    || record?.paymentKey
    || record?.historyKey
    || record?.expenseKey
    || stableSerialize(record?.data || record || {})
  );
}

function toSortedChildValues(records, sortField) {
  return [...records]
    .sort((left, right) => {
      const leftValue = toOptionalText(left?.[sortField]);
      const rightValue = toOptionalText(right?.[sortField]);
      if (leftValue === rightValue) {
        return getChildRecordIdentity(left).localeCompare(getChildRecordIdentity(right));
      }
      return leftValue.localeCompare(rightValue);
    })
    .map((record) => record.data)
    .filter(Boolean);
}

function hydratePersonRecord(record, payments = [], statusHistory = [], appSettings = {}, feeResets = [], feeSchedule = null) {
  if (!record) return null;
  const data = record.data && typeof record.data === 'object' ? { ...record.data } : {};
  const normalizedPayments = toSortedChildValues(payments, 'date');
  const normalizedStatusHistory = toSortedChildValues(statusHistory, 'startDate');
  data.id = data.id || record.personKey;
  data.uid = data.uid || record.uid || '';
  data.name = data.name || record.name || '';
  data.status = data.status || record.status || '';
  data.memberSince = data.memberSince || record.memberSince || '';
  data.originalMemberSince = data.originalMemberSince || record.originalMemberSince || data.memberSince || '';
  data.payments = normalizedPayments;
  data.statusHistory = normalizedStatusHistory;
  data.standingOrders = Array.isArray(data.standingOrders) ? data.standingOrders : [];
  data.totalPaid = calculateTotalPaid(normalizedPayments);
  if (record.data?.isDeleted || record.isDeleted) {
    data.isDeleted = true;
  }
  return preprocessPersonServerSide(data, appSettings, feeResets, feeSchedule);
}

function buildPersonRecordPayload(personKey, value) {
  return {
    personKey: String(personKey),
    uid: toOptionalText(value?.uid),
    name: toOptionalText(value?.name),
    status: toOptionalText(value?.status),
    memberSince: toOptionalText(value?.memberSince),
    originalMemberSince: toOptionalText(value?.originalMemberSince || value?.memberSince),
    totalPaid: calculateTotalPaid(value?.payments),
    data: stripNormalizedPersonData(value)
  };
}

function buildRequestRecordPayload(requestKey, value) {
  return {
    requestKey: String(requestKey),
    userId: value?.userId ? String(value.userId) : '',
    personId: value?.personId ? String(value.personId) : '',
    personName: value?.personName ? String(value.personName) : '',
    type: value?.type ? String(value.type) : '',
    status: value?.status ? String(value.status) : '',
    timestamp: typeof value?.timestamp === 'number' ? value.timestamp : null,
    data: value || null
  };
}

/**
 * True when a write based on version [expected] would overwrite a newer state. null / undefined: no check. Records
 * from before the version field have an empty one until their next write: '' is a version too.
 */
function isOutdatedVersion(current, expected) {
  return expected !== null && expected !== undefined && (current || '') !== expected;
}

function isDeletedPerson(record) {
  return Boolean(record && (record.isDeleted || record.data?.isDeleted));
}

// What is left of a deleted person: key, name and the total of the kept payments
function deletedPersonPayload(record) {
  const personKey = String(record.personKey);
  const name = toOptionalText(record.name || record.data?.name);
  return {
    personKey,
    uid: '',
    name,
    status: '',
    memberSince: '',
    originalMemberSince: '',
    totalPaid: toFiniteNumber(record.totalPaid) || 0,
    data: { id: record.data?.id || personKey, name, isDeleted: true }
  };
}

module.exports = {
  normalizeRecordListInput,
  toOptionalText,
  toFiniteNumber,
  calculateTotalPaid,
  stableSerialize,
  buildStableChildKey,
  stripNormalizedPersonData,
  buildPaymentRecordPayload,
  buildStatusHistoryRecordPayload,
  buildExpenseRecordPayload,
  groupRecordsBy,
  getChildRecordIdentity,
  toSortedChildValues,
  hydratePersonRecord,
  buildPersonRecordPayload,
  buildRequestRecordPayload,
  isOutdatedVersion,
  isDeletedPerson,
  deletedPersonPayload
};
