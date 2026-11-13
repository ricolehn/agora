// The upgrade of the songbook, prayer requests and polls: the old tables songs, prayers and polls kept one record per
// item ({ key, data }); the new ones (community_*) keep each item in columns, under its key as the record id, and
// give back exactly the object the routes wrote (codecs/community.js, stores/items.js).
//
// v3.1 beta kept polls and songs in app_state. The old server moved what was still there into the tables at every
// start; the upgrade does the same in its copy (and the comparison expects it), without touching the old data.
const client = require('../client');
const items = require('../stores/items');
const { makeDiffer } = require('./differ');

const KINDS = Object.keys(items.KINDS);
const OLD_COLLECTIONS = [...KINDS];
const OLD_STATE_KEYS = ['polls', 'songs'];
const NEW_COLLECTIONS = KINDS.map((kind) => items.KINDS[kind].collection);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** What the check noticed, by kind: record ids and item keys only (no texts, no names). */
function newFindings() {
  return { keysThatAreNoIds: [], itemsThatAreNoObjects: [], idDiffersFromKey: [], linksToMissingAccounts: [], valuesKeptAsWritten: [], itemsFromOldAppState: [] };
}

function noteOriginal(findings, where, original) {
  if (!original) return;
  if (original.notAnObject) findings.itemsThatAreNoObjects.push(where);
  for (const key of Object.keys(original.values || {})) {
    if (key === 'id') findings.idDiffersFromKey.push(where);
    else if (key === 'authorUid') findings.linksToMissingAccounts.push(`${where}.${key}`);
    else findings.valuesKeptAsWritten.push(`${where}.${key}`);
  }
  if (original.keys || original.extra) findings.valuesKeptAsWritten.push(`${where} (its fields)`);
}

/**
 * The items v3.1 beta left in app_state under [kind], as the old server moved them: keys that are ids, values that
 * are objects, keys the table does not have yet - in the order of the stored value.
 */
async function stateItems(appConfig, kind, keysInTable) {
  if (!OLD_STATE_KEYS.includes(kind)) return [];
  const record = await client.getFirstRecord('app_state', client.pbFilterEquals('key', kind), appConfig).catch(() => null);
  if (!record) return [];
  const map = isPlainObject(record.value) ? record.value : {};
  return Object.entries(map)
    .filter(([key, data]) => data && typeof data === 'object' && items.isValidKey(key) && !keysInTable.has(key))
    .map(([key, data]) => ({ key, data }));
}

/** The ids the songs have after the upgrade (the order of service links to them). */
async function songIdsAfter(appConfig) {
  const keys = (await client.listAllRecords('songs', '', appConfig, '', { fields: 'key' }).catch(() => [])).map((row) => row.key);
  const fromState = await stateItems(appConfig, 'songs', new Set(keys)).catch(() => []);
  return new Set([...keys, ...fromState.map((entry) => entry.key)].filter(items.isValidKey));
}

/** Works out the new records (in the order the old tables hold them) and what the check noticed. */
async function plan(appConfig) {
  const findings = newFindings();
  const users = await client.listAllRecords('users', '', appConfig, '', { fields: 'id' });
  const userIds = new Set(users.map((user) => user.id));
  const exists = (collection, id) => collection === 'users' && userIds.has(id);
  const ops = [];
  const counts = { old: {}, new: {} };
  for (const kind of KINDS) {
    const rows = await client.listAllRecords(kind, '', appConfig);
    const fromState = await stateItems(appConfig, kind, new Set(rows.map((row) => row.key)));
    const collection = items.KINDS[kind].collection;
    const entries = [
      ...rows.map((row) => ({ key: row.key, data: row.data, where: `${kind}/${row.id}` })),
      ...fromState.map((entry) => ({ ...entry, where: `app_state ${kind}/${entry.key}` }))
    ];
    for (const { key, data, where } of entries) {
      const id = items.isValidKey(key) ? key : client.newRecordId();
      const body = items.itemBody(kind, data, { exists, recordId: id });
      if (id !== key) {
        findings.keysThatAreNoIds.push(where);
        body.original = { ...(body.original || {}), key };
      }
      noteOriginal(findings, where, body.original);
      ops.push({ method: 'POST', collection, body: { id, ...body } });
    }
    findings.itemsFromOldAppState.push(...fromState.map((entry) => `${kind}/${entry.key}`));
    counts.old[kind] = rows.length;
    if (fromState.length) counts.old[`app_state ${kind}`] = fromState.length;
    counts.new[collection] = entries.length;
  }
  return { ops, findings, counts, totals: {} };
}

/** Writes what plan() worked out. */
async function apply(appConfig, planned) {
  for (let start = 0; start < planned.ops.length; start += client.BATCH_MAX_REQUESTS) {
    await client.batchWrite(appConfig, planned.ops.slice(start, start + client.BATCH_MAX_REQUESTS));
  }
}

/**
 * Checks that the new tables answer like the old ones: every list as the routes get it (in order), the counts, and
 * every item read by its key - plus what the old server would have moved from app_state at its next start.
 */
async function compare(appConfig, { legacy }) {
  const { differences, differ } = makeDiffer();
  for (const kind of KINDS) {
    const before = legacy.itemStore.createItemStore(kind);
    const after = items.createItemStore(kind);
    const keys = (await client.listAllRecords(kind, '', appConfig, '', { fields: 'key' })).map((row) => row.key);
    const fromState = await stateItems(appConfig, kind, new Set(keys));
    differ(`the ${kind} (all, in order)`, [...await before.list(appConfig), ...fromState.map((entry) => entry.data)], await after.list(appConfig));
    differ(`the number of ${kind}`, (await before.count(appConfig)) + fromState.length, await after.count(appConfig));
    for (let start = 0; start < keys.length; start += 25) {
      const chunk = keys.slice(start, start + 25);
      const pairs = await Promise.all(chunk.map((key) => Promise.all([before.get(appConfig, key), after.get(appConfig, key)])));
      pairs.forEach(([a, b], index) => differ(`${kind} ${chunk[index]}`, a, b));
    }
    for (const entry of fromState) differ(`${kind} ${entry.key}`, entry.data, await after.get(appConfig, entry.key));
  }
  return differences;
}

/** After the switch: the old tables and app_state values go (the backup taken before keeps them). */
async function cleanup(appConfig) {
  for (const name of OLD_COLLECTIONS) await client.deleteCollection(appConfig, name).catch((err) => { if (err.status !== 404) throw err; });
  const state = await client.listAllRecords('app_state', '', appConfig).catch(() => []);
  for (const record of state) if (OLD_STATE_KEYS.includes(record.key)) await client.deleteRecord('app_state', record.id, appConfig);
}

module.exports = { key: 'community', OLD_COLLECTIONS, OLD_STATE_KEYS, NEW_COLLECTIONS, plan, apply, compare, cleanup, songIdsAfter };
