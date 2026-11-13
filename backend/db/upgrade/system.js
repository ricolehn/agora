// The upgrade of the instance's own data: the values of app_state (registration, AI, media and push settings - their
// secrets kept apart -, media folder rights, reported content, values older versions left) and the push devices
// (push_subscriptions and fcm_tokens -> system_push_devices). Runs last: app_state goes in its cleanup, after the
// books and the community took their values out of it.
const client = require('../client');
const store = require('../stores/system');
const { linkContextOf } = require('../stores/oldTables');
const { fieldKinds, isPlainObject } = require('../codec');
const { makeDiffer } = require('./differ');
const { table } = require('../tables');
const media = require('../../media');

const OLD_COLLECTIONS = ['push_subscriptions', 'fcm_tokens', 'app_state'];
const NEW_COLLECTIONS = ['system_secrets', 'system_push_devices', 'system_content_reports', 'media_folder_rules'];
// Values of app_state the other areas take (they delete them in their cleanup)
const TAKEN_ELSEWHERE = ['settings', 'donations', 'expenses', 'feeSchedule', 'feeResets', 'polls', 'songs'];
const isoColumn = fieldKinds.isoTime('created').toColumn;
const fieldsOf = (row) => {
  const { collectionId, collectionName, expand, ...fields } = row;
  return fields;
};

function newFindings() {
  return { valuesOfOlderVersions: [], mediaRightsOfGroupsOrPeopleThatAreGone: [], mediaRulesInAnotherShape: [], reportsKeptAsWritten: [], reportsListInAnotherShape: [], devicesOfDeletedAccounts: [], devicesKeptAsWritten: [] };
}

async function readOld(appConfig) {
  const [state, pushRows, fcmRows, users, groups, threads] = await Promise.all([
    client.listAllRecords('app_state', '', appConfig),
    client.listAllRecords('push_subscriptions', '', appConfig),
    client.listAllRecords('fcm_tokens', '', appConfig),
    client.listAllRecords('users', '', appConfig, '', { fields: 'id' }),
    client.listAllRecords('groups', '', appConfig, '', { fields: 'id,name' }).catch(() => []),
    client.listAllRecords('mentoring_threads', '', appConfig, '', { fields: 'id' }).catch(() => [])
  ]);
  return { state, pushRows, fcmRows, userIds: new Set(users.map((user) => user.id)), groupIds: new Set(groups.map((group) => group.id)), threadIds: new Set(threads.map((thread) => thread.id)) };
}

/** The rights the server reads from [value] ({ rules }): those of groups and people that exist (media.pruneRules). */
const knownTargets = (old) => new Set([media.ALL_MEMBERS, ...old.groupIds, ...[...old.userIds].map((uid) => media.personKey(uid))]);

async function plan(appConfig) {
  const old = await readOld(appConfig);
  const findings = newFindings();
  const ops = [];
  const legacy = {};
  const valueOf = (key) => old.state.find((record) => record.key === key);

  // Settings (and their secrets)
  for (const [key, { area, secret }] of Object.entries(store.STATE_AREAS)) {
    const record = valueOf(key);
    if (!record) continue;
    const { setting, secret: hidden } = store.splitSecret(key, record.value);
    ops.push({ method: 'POST', collection: table('system_settings'), body: { area, value: setting === undefined ? null : setting } });
    if (secret && hidden !== undefined) ops.push({ method: 'POST', collection: table('system_secrets'), body: { name: secret[1], value: hidden } });
  }
  for (const record of old.state) {
    if (store.STATE_AREAS[record.key] || TAKEN_ELSEWHERE.includes(record.key) || ['media_rules', 'content_reports'].includes(record.key)) continue;
    legacy[record.key] = record.value;
    findings.valuesOfOlderVersions.push(`app_state/${record.id}`);
  }
  if (Object.keys(legacy).length) ops.push({ method: 'POST', collection: table('system_settings'), body: { area: store.LEGACY_AREA, value: legacy } });

  // Media folder rights: the ones the server reads (rights of groups and people that are gone were never used)
  const rulesRecord = valueOf('media_rules');
  let rules = 0;
  if (rulesRecord) {
    const value = rulesRecord.value;
    if (!isPlainObject(value) || Object.keys(value).some((key) => key !== 'rules')) findings.mediaRulesInAnotherShape.push(`app_state/${rulesRecord.id}`);
    const all = isPlainObject(value?.rules) ? value.rules : {};
    const kept = media.pruneRules(all, knownTargets(old));
    const before = Object.values(all).reduce((sum, own) => sum + Object.keys(isPlainObject(own) ? own : {}).length, 0);
    const after = Object.values(kept).reduce((sum, own) => sum + Object.keys(own).length, 0);
    for (let index = after; index < before; index += 1) findings.mediaRightsOfGroupsOrPeopleThatAreGone.push(`app_state/${rulesRecord.id}`);
    const records = await store.ruleRecords(appConfig, kept, { groups: old.groupIds, users: old.userIds });
    for (const body of records) ops.push({ method: 'POST', collection: table('media_folder_rules'), body });
    rules = records.length;
  }

  // Reported content: oldest first, so the newest is the last record (the list reads them newest first)
  const reportsRecord = valueOf('content_reports');
  const list = Array.isArray(reportsRecord?.value) ? reportsRecord.value : [];
  if (reportsRecord && !Array.isArray(reportsRecord.value)) findings.reportsListInAnotherShape.push(`app_state/${reportsRecord.id}`);
  const ctx = linkContextOf({ users: old.userIds, mentoring_threads: old.threadIds });
  const taken = new Set();
  for (const [index, report] of list.map((entry, position) => [position, entry]).reverse()) {
    const id = typeof report?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(report.id) && !taken.has(report.id) ? report.id : client.newRecordId();
    taken.add(id);
    const body = store.reportBody(report, id, ctx);
    if (body.original) findings.reportsKeptAsWritten.push(`content_reports.${index}`);
    ops.push({ method: 'POST', collection: table('system_content_reports'), body: { id, ...body } });
  }

  // Push devices of accounts that exist (the others were never used again)
  let devices = 0;
  for (const [rows, kindStore, kind] of [[old.pushRows, store.webPush, 'webPush'], [old.fcmRows, store.fcmTokens, 'fcm']]) {
    for (const row of rows) {
      if (!old.userIds.has(row.user)) {
        findings.devicesOfDeletedAccounts.push(`${kindStore.kind}/${row.id}`);
        continue;
      }
      const object = fieldsOf(row);
      const { columns, original } = kindStore.codec.encode(object, { ...ctx, recordId: row.id });
      if (original) findings.devicesKeptAsWritten.push(`${kindStore.kind}/${row.id}`);
      const body = { ...columns, kind, original };
      // Web push: "created" was the last registration (lastSeen); the record's own times are the best the upgrade knows
      if (kind === 'webPush') {
        body.created = isoColumn(object.created);
        body.updated = isoColumn(object.created);
      }
      ops.push({ method: 'POST', collection: table('system_push_devices'), body: { ...body, id: row.id } });
      devices += 1;
    }
  }

  const counts = {
    old: { app_state: old.state.length, push_subscriptions: old.pushRows.length, fcm_tokens: old.fcmRows.length, content_reports: list.length },
    new: { media_folder_rules: rules, system_content_reports: list.length, system_push_devices: devices }
  };
  return { ops, findings, counts, totals: {} };
}

async function apply(appConfig, planned) {
  for (let start = 0; start < planned.ops.length; start += client.BATCH_MAX_REQUESTS) {
    await client.batchWrite(appConfig, planned.ops.slice(start, start + client.BATCH_MAX_REQUESTS));
  }
}

/**
 * Checks that the new tables answer like the old storage: every value of app_state the server reads (media rights as
 * the server reads them: without groups and people that are gone), the reports in their order, every push device by
 * its address or token and per account.
 */
async function compare(appConfig, { legacy }) {
  const { differences, differ } = makeDiffer();
  const plain = (value) => {
    if (Array.isArray(value)) return value.map(plain);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'collectionId').map(([key, inner]) => [key, plain(inner)]));
  };
  const both = async (what, before, after) => differ(what, plain(await before().catch((err) => `failed: ${err.message}`)), plain(await after().catch((err) => `failed: ${err.message}`)));
  const old = legacy.store;
  const current = require('../../pocketbase');
  const oldData = await readOld(appConfig);

  for (const key of Object.keys(store.STATE_AREAS)) await both(`the value ${key}`, () => old.getStateValue(appConfig, key, null), () => current.getStateValue(appConfig, key, null));
  await both('the reported content', () => old.getStateValue(appConfig, 'content_reports', []), () => require('../../contentReports').listReports(appConfig));
  await both('the media rights', async () => media.pruneRules((await old.getStateValue(appConfig, 'media_rules', { rules: {} }))?.rules || {}, knownTargets(oldData)),
    async () => (await current.getStateValue(appConfig, 'media_rules', { rules: {} }))?.rules || {});
  for (const record of oldData.state) {
    if (store.STATE_AREAS[record.key] || TAKEN_ELSEWHERE.includes(record.key) || ['media_rules', 'content_reports'].includes(record.key)) continue;
    await both(`the value ${record.key}`, () => old.getStateValue(appConfig, record.key, null), () => current.getStateValue(appConfig, record.key, null));
  }
  for (const uid of oldData.userIds) {
    await both(`the web push devices of ${uid}`, () => old.listAllRecords('push_subscriptions', old.pbFilterEquals('user', uid), appConfig), () => current.listPushSubscriptionsOf(appConfig, uid));
    await both(`the Android devices of ${uid}`, () => old.listAllRecords('fcm_tokens', old.pbFilterEquals('user', uid), appConfig), () => current.listFcmTokensOf(appConfig, uid));
  }
  for (const row of oldData.pushRows.filter((sub) => oldData.userIds.has(sub.user))) {
    await both(`the web push device ${row.id}`, () => old.getPushSubscriptionByEndpoint(appConfig, row.endpoint), () => current.getPushSubscriptionByEndpoint(appConfig, row.endpoint));
  }
  for (const row of oldData.fcmRows.filter((token) => oldData.userIds.has(token.user))) {
    await both(`the Android device ${row.id}`, () => old.getFcmTokenRecord(appConfig, row.token), () => current.getFcmTokenRecord(appConfig, row.token));
  }
  return differences;
}

/** After the switch: the old tables go, and with app_state the last of the old storage (the backup keeps it). */
async function cleanup(appConfig) {
  for (const name of OLD_COLLECTIONS) await client.deleteCollection(appConfig, name).catch((err) => { if (err.status !== 404) throw err; });
}

module.exports = { key: 'system', OLD_COLLECTIONS, NEW_COLLECTIONS, plan, apply, compare, cleanup };
