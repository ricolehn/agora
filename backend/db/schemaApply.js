// Makes PocketBase match the definitions in schema/: creates what is missing, brings fields, help texts and indexes in
// line, and never deletes a field or a record by itself (what does not fit is reported).
const client = require('./client');
const schema = require('./schema');

/**
 * During an upgrade a new collection whose name an old collection still holds is built under this name and gets its
 * own name when the old one is gone (cleanup).
 */
const buildingName = (name) => `v4_${name}`;

/** Ids of the collections by name (to link them). */
async function collectionIds(appConfig) {
  const ids = new Map();
  for (const collection of await client.listCollections(appConfig)) ids.set(collection.name, collection.id);
  return ids;
}

/**
 * Creates the collections [names] that do not exist yet. [tableNameOf] gives the name a collection is stored under
 * (buildingName during an upgrade); links point to the stored names.
 */
async function createCollections(appConfig, names, { tableNameOf = (name) => name } = {}) {
  const wanted = new Set(names);
  const ids = await collectionIds(appConfig);
  const created = [];
  for (const spec of schema.creationOrder(schema.allCollections())) {
    if (!wanted.has(spec.name)) continue;
    const tableName = tableNameOf(spec.name);
    if (ids.has(tableName)) continue;
    const collectionIdOf = (target) => ids.get(target === 'users' ? 'users' : tableNameOf(target)) || ids.get(target);
    const body = schema.toCollectionBody(spec, { collectionIdOf, tableName });
    const record = await client.createCollection(appConfig, body);
    ids.set(tableName, record.id);
    created.push(tableName);
  }
  return created;
}

/** Creates or updates the views of the areas whose collections all exist. */
async function applyViews(appConfig) {
  const existing = new Map((await client.listCollections(appConfig)).map((collection) => [collection.name, collection]));
  for (const view of schema.allViews()) {
    const tables = (view.viewQuery.match(/FROM (\w+)/g) || []).map((part) => part.slice(5)).filter((name) => name.startsWith('finance_') || name.startsWith('event') || name.startsWith('community_'));
    if (!tables.every((name) => existing.has(name))) continue;
    const body = { name: view.name, type: 'view', viewQuery: view.viewQuery, listRule: null, viewRule: null };
    const current = existing.get(view.name);
    if (!current) await client.createCollection(appConfig, body);
    else if (current.viewQuery !== view.viewQuery) await client.updateCollection(appConfig, current.id, body);
  }
}

/**
 * Brings the existing collections [names] in line with their definitions (help texts, options, indexes, rules; missing
 * fields are added). Returns what does not fit, without changing it.
 */
async function ensureCollections(appConfig, names) {
  const problems = [];
  const ids = await collectionIds(appConfig);
  for (const spec of schema.creationOrder(schema.allCollections())) {
    if (!names.includes(spec.name) || !ids.has(spec.name)) continue;
    const existing = await client.getCollection(appConfig, spec.name);
    const { body, problems: found } = schema.mergeIntoCollection(existing, spec, { collectionIdOf: (target) => ids.get(target) });
    problems.push(...found);
    if (!sameCollection(existing, body)) await client.updateCollection(appConfig, existing.id, body);
  }
  return problems;
}

function sameCollection(a, b) {
  const pick = (collection) => JSON.stringify({ fields: collection.fields, indexes: collection.indexes, rules: [collection.listRule, collection.viewRule, collection.createRule, collection.updateRule, collection.deleteRule] });
  return pick(a) === pick(b);
}

module.exports = { buildingName, collectionIds, createCollections, ensureCollections, applyViews };
