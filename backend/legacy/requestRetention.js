const { listAllRecords, updateRecord, deleteRecord } = require('./pocketbase');

// Approved or rejected finance requests stay visible for this long, then they are deleted
const DECIDED_REQUEST_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const isDecided = (status) => status === 'approved' || status === 'rejected';
const requestStatus = (record) => record?.data?.status || record?.status || '';

/**
 * Adds decidedAt when a request is approved or rejected (the clients only set the status).
 * An existing decision time is kept, so later edits don't extend the retention.
 */
function withDecisionTimestamp(previous, next, now = Date.now()) {
  if (!next || typeof next !== 'object' || !isDecided(next.status)) return next;
  if (next.decidedAt) return next;
  if (previous && isDecided(previous.status) && previous.decidedAt) return { ...next, decidedAt: previous.decidedAt };
  return { ...next, decidedAt: now };
}

/**
 * True once a decided request is older than the retention period. Requests decided before decidedAt existed
 * have no time yet; they get one on the next cleanup run (see purgeExpiredRequests) and are kept until then.
 */
function isExpiredRequest(record, now = Date.now()) {
  if (!isDecided(requestStatus(record))) return false;
  const decidedAt = Number(record?.data?.decidedAt);
  return Number.isFinite(decidedAt) && decidedAt > 0 && now - decidedAt > DECIDED_REQUEST_RETENTION_DAYS * DAY_MS;
}

/**
 * Daily cleanup: deletes decided requests past the retention period and stamps older decided requests
 * without decidedAt with the current time, so they get the full 30 days from now on.
 */
async function purgeExpiredRequests(appConfig, now = Date.now()) {
  if (!appConfig) return { deleted: 0, stamped: 0 };
  let deleted = 0;
  let stamped = 0;
  try {
    const records = await listAllRecords('requests', '', appConfig);
    for (const record of records) {
      if (!isDecided(requestStatus(record))) continue;
      if (!record.data?.decidedAt) {
        await updateRecord('requests', record.id, { data: { ...(record.data || {}), decidedAt: now } }, appConfig);
        stamped += 1;
      } else if (isExpiredRequest(record, now)) {
        await deleteRecord('requests', record.id, appConfig);
        deleted += 1;
      }
    }
    if (deleted || stamped) console.log(`[Requests] Deleted ${deleted} decided request(s) older than ${DECIDED_REQUEST_RETENTION_DAYS} days, dated ${stamped}`);
  } catch (error) {
    console.error('[Requests] Cleanup failed:', error.message);
  }
  return { deleted, stamped };
}

/**
 * Before beta18, approving or rejecting a request wrote the treasurer's id into userId, so the request later showed
 * up as the treasurer's own (e.g. after losing the finance rights). The author is the account linked to the
 * request's person record: put that one back where it differs. Requests without a linked person stay as they are.
 */
async function repairRequestAuthors(appConfig) {
  if (!appConfig) return { repaired: 0 };
  let repaired = 0;
  try {
    const [requests, people] = await Promise.all([listAllRecords('requests', '', appConfig), listAllRecords('people', '', appConfig)]);
    const uidByPerson = new Map();
    for (const person of people) {
      const uid = person.uid || person.data?.uid;
      if (!uid) continue;
      [person.personKey, person.data?.id].filter(Boolean).forEach((key) => uidByPerson.set(String(key), String(uid)));
    }
    for (const record of requests) {
      const personId = String(record.data?.personId || record.personId || '');
      const author = uidByPerson.get(personId);
      const current = String(record.data?.userId || record.userId || '');
      if (!author || author === current) continue;
      await updateRecord('requests', record.id, { userId: author, data: { ...(record.data || {}), userId: author } }, appConfig);
      repaired += 1;
    }
    if (repaired) console.log(`[Requests] Gave ${repaired} request(s) their author back`);
  } catch (error) {
    console.error('[Requests] Author repair failed:', error.message);
  }
  return { repaired };
}

module.exports = {
  repairRequestAuthors,
  DECIDED_REQUEST_RETENTION_DAYS,
  withDecisionTimestamp,
  isExpiredRequest,
  purgeExpiredRequests
};
