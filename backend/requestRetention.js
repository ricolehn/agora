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

module.exports = {
  DECIDED_REQUEST_RETENTION_DAYS,
  withDecisionTimestamp,
  isExpiredRequest,
  purgeExpiredRequests
};
