const test = require('node:test');
const assert = require('node:assert/strict');
const { withDecisionTimestamp, isExpiredRequest, DECIDED_REQUEST_RETENTION_DAYS } = require('./requestRetention');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 29);

test('withDecisionTimestamp stamps approve/reject once and leaves pending requests alone', () => {
  assert.deepEqual(withDecisionTimestamp({ status: 'pending' }, { status: 'pending', amount: 5 }, NOW), { status: 'pending', amount: 5 });
  assert.equal(withDecisionTimestamp({ status: 'pending' }, { status: 'approved' }, NOW).decidedAt, NOW);
  assert.equal(withDecisionTimestamp(null, { status: 'rejected', rejectionReason: 'Doppelt' }, NOW).decidedAt, NOW);
  // A later edit keeps the original decision time
  assert.equal(withDecisionTimestamp({ status: 'approved', decidedAt: NOW - DAY }, { status: 'approved', note: 'x' }, NOW).decidedAt, NOW - DAY);
  assert.equal(withDecisionTimestamp({ status: 'pending' }, { status: 'approved', decidedAt: 123 }, NOW).decidedAt, 123);
});

test('isExpiredRequest only drops decided requests older than the retention period', () => {
  const decided = (status, age) => ({ status, data: { status, decidedAt: NOW - age } });
  assert.equal(DECIDED_REQUEST_RETENTION_DAYS, 30);
  assert.equal(isExpiredRequest(decided('approved', 29 * DAY), NOW), false);
  assert.equal(isExpiredRequest(decided('approved', 31 * DAY), NOW), true);
  assert.equal(isExpiredRequest(decided('rejected', 31 * DAY), NOW), true);
  assert.equal(isExpiredRequest({ status: 'pending', data: { status: 'pending', timestamp: NOW - 400 * DAY } }, NOW), false);
  // Decided before decidedAt existed: kept until the cleanup dates it
  assert.equal(isExpiredRequest({ status: 'approved', data: { status: 'approved', timestamp: NOW - 400 * DAY } }, NOW), false);
});
