// The instance's own data in the new structure: settings per area (system_settings) with their secrets kept apart
// (system_secrets), the rights to media folders (media_folder_rules), reported content (system_content_reports) and
// push devices (system_push_devices). The server keeps calling the functions it always called - the values of
// app_state by key, the push and Firebase records - and gets exactly what the old storage gave it.
const client = require('../client');
const codecs = require('../codecs/system');
const { isPlainObject } = require('../codec');
const { table } = require('../tables');
const { queueRecordWrite } = require('../writeQueue');
const { recordStore, linkContextOf, existingIds, without, has } = require('./oldTables');
const links = require('../links');

const SETTINGS = 'system_settings';
const SECRETS = 'system_secrets';
const RULES = 'media_folder_rules';
const REPORTS = 'system_content_reports';

// Values of app_state kept as settings: the area, and the key of the value that is a secret (kept apart, as text)
const STATE_AREAS = {
  system: { area: 'registration' },
  ai_config: { area: 'ai', secret: ['apiKey', 'aiApiKey'] },
  media: { area: 'media', secret: ['password', 'mediaPassword'] },
  vapid_keys: { area: 'push', secret: ['privateKey', 'vapidPrivateKey'] }
};
const LEGACY_AREA = 'legacy';
const ALL_MEMBERS = '*';
const PERSON_PREFIX = 'user:';
const LEVELS = ['read', 'write', 'hide'];
/** What getStateValue gives when the old storage had no value: the caller's fallback applies. */
const MISSING = undefined;

// --- Settings and secrets ----------------------------------------------------------------------------------------

const rowOf = (appConfig, collection, field, value) => client.getFirstRecord(table(collection), client.pbFilterEquals(field, value), appConfig);

async function putRow(appConfig, collection, field, value, body) {
  const existing = await rowOf(appConfig, collection, field, value);
  if (existing) return client.updateRecord(table(collection), existing.id, body, appConfig);
  return client.createRecord(table(collection), { [field]: value, ...body }, appConfig);
}

async function dropRow(appConfig, collection, field, value) {
  const existing = await rowOf(appConfig, collection, field, value);
  if (existing) await client.deleteRecord(table(collection), existing.id, appConfig);
}

/** [value] of an app_state key split into what is stored as the setting and the secret ({ setting, secret }). */
function splitSecret(key, value) {
  const secretKey = STATE_AREAS[key]?.secret?.[0];
  if (secretKey && isPlainObject(value) && typeof value[secretKey] === 'string') {
    const { [secretKey]: secret, ...setting } = value;
    return { setting, secret };
  }
  return { setting: value, secret: undefined };
}

async function getAreaValue(appConfig, key) {
  const { area, secret } = STATE_AREAS[key];
  const row = await rowOf(appConfig, SETTINGS, 'area', area);
  if (!row) return MISSING;
  if (!secret || !isPlainObject(row.value)) return row.value;
  const kept = await rowOf(appConfig, SECRETS, 'name', secret[1]);
  return kept ? { ...row.value, [secret[0]]: kept.value } : row.value;
}

async function setAreaValue(appConfig, key, value) {
  const { area, secret: names } = STATE_AREAS[key];
  const { setting, secret } = splitSecret(key, value);
  if (names) {
    if (secret !== undefined) await putRow(appConfig, SECRETS, 'name', names[1], { value: secret });
    else await dropRow(appConfig, SECRETS, 'name', names[1]);
  }
  return putRow(appConfig, SETTINGS, 'area', area, { value: setting === undefined ? null : setting });
}

// --- Media folder rights: { rules: { folder: { '*' | 'user:<uid>' | groupId: level } } } ---------------------------

const ruleKeyOf = (row) => (row.target === 'everyone' ? ALL_MEMBERS : row.target === 'user' ? `${PERSON_PREFIX}${row.user}` : row.group);

async function getMediaRules(appConfig) {
  const rows = await client.listAllRecords(table(RULES), '', appConfig);
  if (!rows.length) return MISSING;
  const rules = {};
  for (const row of rows) {
    const key = ruleKeyOf(row);
    if (!key || !LEVELS.includes(row.level)) continue;
    if (!has(rules, row.folder)) rules[row.folder] = {};
    rules[row.folder][key] = row.level;
  }
  return { rules };
}

/** The records of [rules]: rights of groups and people that exist (the server drops the others when it reads them). */
async function ruleRecords(appConfig, rules, known = null) {
  const entries = Object.entries(isPlainObject(rules) ? rules : {}).flatMap(([folder, own]) => Object.entries(isPlainObject(own) ? own : {}).map(([key, level]) => ({ folder, key, level })));
  const exists = known || {
    groups: await existingIds(appConfig, 'user_groups', entries.map((entry) => entry.key)),
    users: await existingIds(appConfig, 'users', entries.filter((entry) => entry.key.startsWith(PERSON_PREFIX)).map((entry) => entry.key.slice(PERSON_PREFIX.length)))
  };
  const records = [];
  for (const { folder, key, level } of entries) {
    if (!LEVELS.includes(level)) continue;
    if (key === ALL_MEMBERS) records.push({ folder, target: 'everyone', level });
    else if (key.startsWith(PERSON_PREFIX) && exists.users.has(key.slice(PERSON_PREFIX.length))) records.push({ folder, target: 'user', user: key.slice(PERSON_PREFIX.length), level });
    else if (exists.groups.has(key)) records.push({ folder, target: 'group', group: key, level });
  }
  return records;
}

function setMediaRules(appConfig, value) {
  return queueRecordWrite('system:media_rules', async () => {
    const records = await ruleRecords(appConfig, value?.rules);
    const existing = await client.listAllRecords(table(RULES), '', appConfig);
    const ops = [
      ...existing.map((row) => ({ method: 'DELETE', collection: table(RULES), id: row.id })),
      ...records.map((body) => ({ method: 'POST', collection: table(RULES), body }))
    ];
    for (let start = 0; start < ops.length; start += client.BATCH_MAX_REQUESTS) await client.batchWrite(appConfig, ops.slice(start, start + client.BATCH_MAX_REQUESTS));
  });
}

// --- Reported content: newest first, at most 500 (contentReports.js) ----------------------------------------------

const MAX_STORED_REPORTS = 500;
const isReportId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

async function reportContext(appConfig, report) {
  const [users, threads] = await Promise.all([
    existingIds(appConfig, 'users', [report?.reportedBy]),
    existingIds(appConfig, 'mentoring_threads', [report?.threadId])
  ]);
  return linkContextOf({ users, mentoring_threads: threads });
}

/** The columns of [report] for the record [id]. */
function reportBody(report, id, ctx) {
  if (!isPlainObject(report)) return { original: { notAnObject: true, data: report === undefined ? null : report } };
  const { columns, original } = codecs.report.encode(report, { ...ctx, recordId: id });
  const body = { ...columns, original };
  delete body.id;
  return body;
}

function decodeReport(row) {
  if (row?.original?.notAnObject === true) return row.original.data;
  return codecs.report.decode(row);
}

const reportRows = (appConfig) => client.listAllRecords(table(REPORTS), '', appConfig, '-@rowid');

async function listReports(appConfig) {
  const rows = await reportRows(appConfig);
  return rows.length ? rows.map(decodeReport) : MISSING;
}

const withReports = (work) => queueRecordWrite('system:content_reports', work);

/** Stores [report] as the newest; the oldest beyond 500 go. */
function addReport(appConfig, report) {
  return withReports(async () => {
    const id = isReportId(report?.id) && !(await client.getRecord(table(REPORTS), report.id, appConfig)) ? report.id : client.newRecordId();
    await client.createRecord(table(REPORTS), { id, ...reportBody(report, id, await reportContext(appConfig, report)) }, appConfig);
    const rows = await client.listAllRecords(table(REPORTS), '', appConfig, '-@rowid', { fields: 'id' });
    for (const row of rows.slice(MAX_STORED_REPORTS)) await client.deleteRecord(table(REPORTS), row.id, appConfig);
    return report;
  });
}

/** Marks the reports with [id] resolved now; returns the first of them as it is now (null: none). */
function resolveReports(appConfig, id) {
  return withReports(async () => {
    let first = null;
    for (const row of await reportRows(appConfig)) {
      const report = decodeReport(row);
      if (!isPlainObject(report) || report.id !== id) continue;
      const next = { ...report, status: 'resolved', resolved: Date.now() };
      await client.updateRecord(table(REPORTS), row.id, reportBody(next, row.id, await reportContext(appConfig, next)), appConfig);
      first ||= next;
    }
    return first;
  });
}

/** The whole list at once (newest first), as older code wrote it. */
function setReports(appConfig, list) {
  return withReports(async () => {
    const existing = await client.listAllRecords(table(REPORTS), '', appConfig, '', { fields: 'id' });
    for (const row of existing) await client.deleteRecord(table(REPORTS), row.id, appConfig);
    const taken = new Set();
    for (const report of [...(Array.isArray(list) ? list : [])].slice(0, MAX_STORED_REPORTS).reverse()) {
      const id = isReportId(report?.id) && !taken.has(report.id) ? report.id : client.newRecordId();
      taken.add(id);
      await client.createRecord(table(REPORTS), { id, ...reportBody(report, id, await reportContext(appConfig, report)) }, appConfig);
    }
  });
}

// --- Values of app_state by key -----------------------------------------------------------------------------------

/** The value app_state kept under [key] (MISSING: none). */
async function getStateValue(appConfig, key) {
  if (STATE_AREAS[key]) return getAreaValue(appConfig, key);
  if (key === 'media_rules') return getMediaRules(appConfig);
  if (key === 'content_reports') return listReports(appConfig);
  const legacy = await rowOf(appConfig, SETTINGS, 'area', LEGACY_AREA);
  return isPlainObject(legacy?.value) && has(legacy.value, key) ? legacy.value[key] : MISSING;
}

async function setStateValue(appConfig, key, value) {
  if (STATE_AREAS[key]) return setAreaValue(appConfig, key, value);
  if (key === 'media_rules') return setMediaRules(appConfig, value);
  if (key === 'content_reports') return setReports(appConfig, value);
  return queueRecordWrite('system:legacy', async () => {
    const legacy = await rowOf(appConfig, SETTINGS, 'area', LEGACY_AREA);
    return putRow(appConfig, SETTINGS, 'area', LEGACY_AREA, { value: { ...(isPlainObject(legacy?.value) ? legacy.value : {}), [key]: value } });
  });
}

// --- Push devices: web push subscriptions and Firebase tokens share one table -------------------------------------

const webPush = recordStore({
  kind: 'push_subscriptions', tableName: 'system_push_devices', codec: codecs.webPush, scope: { kind: 'webPush' },
  fields: [['user', 'text', true], ['endpoint', 'text', true], ['p256dh', 'text', true], ['auth', 'text', true], ['userAgent', 'text'], ['created', 'text'], ['installed', 'bool']],
  links: { user: 'users' }, ownCreated: true, ownUpdated: true
});
const fcmTokens = recordStore({
  kind: 'fcm_tokens', tableName: 'system_push_devices', codec: codecs.fcm, scope: { kind: 'fcm' },
  fields: [['user', 'text', true], ['token', 'text', true], ['platform', 'text'], ['created', 'text'], ['updated', 'text']],
  links: { user: 'users' }
});

// --- Links to something that is about to be deleted (see ../links.js) ----------------------------------------------

/** Re-writes the reports [filter] picks in a world without [id] of [target] (the reporter or the conversation is gone). */
async function reportsLetGo(appConfig, filter, target, id) {
  await withReports(async () => {
    for (const row of await client.listAllRecords(table(REPORTS), filter, appConfig)) {
      const report = decodeReport(row);
      if (!isPlainObject(report)) continue;
      const ctx = without(await reportContext(appConfig, report), target, id);
      await client.updateRecord(table(REPORTS), row.id, reportBody(report, row.id, ctx), appConfig);
    }
  });
}

links.holdLinks('users', (appConfig, uid) => reportsLetGo(appConfig, client.pbFilterEquals('reportedBy', uid), 'users', uid));
links.holdLinks('mentoring_threads', (appConfig, threadId) => reportsLetGo(appConfig, client.pbFilterEquals('thread', threadId), 'mentoring_threads', threadId));

module.exports = {
  STATE_AREAS,
  LEGACY_AREA,
  MISSING,
  splitSecret,
  ruleRecords,
  reportBody,
  decodeReport,
  getStateValue,
  setStateValue,
  addReport,
  resolveReports,
  listReports,
  webPush,
  fcmTokens
};
