// The whole database structure in one place. Every collection is defined here with a help text for each field;
// applySchema() makes PocketBase match it, docs.js writes docs/DATABASE.md from it, and tests/database.test.js checks
// the house rules (see fields.js).
const finance = require('./finance');
const events = require('./events');
const community = require('./community');
const mentoring = require('./mentoring');
const system = require('./system');
const { SERVER_ONLY_RULES } = require('./fields');

// The structure this code expects. An installation whose database is older is upgraded by backend/db/migrations.
const SCHEMA_VERSION = 4;

const AREAS = [
  { key: 'accounts', title: 'Accounts and groups', module: system, names: ['user_groups'] },
  { key: 'finance', title: 'Finance', module: finance },
  { key: 'events', title: 'Events', module: events },
  { key: 'community', title: 'Community', module: community },
  { key: 'mentoring', title: 'Mentoring', module: mentoring },
  { key: 'media', title: 'Media library', module: system, names: ['media_folder_rules'] },
  { key: 'system', title: 'System', module: system, names: ['system_settings', 'system_secrets', 'system_push_devices', 'system_content_reports', 'system_migrations'] }
];

/** Every collection definition, with its area. */
function allCollections() {
  const list = [];
  for (const area of AREAS) {
    for (const spec of area.module.collections) {
      if (area.names && !area.names.includes(spec.name)) continue;
      list.push({ ...spec, area: area.key, type: 'base', ...SERVER_ONLY_RULES });
    }
  }
  return list;
}

/** Every view (read-only collections computed by the database). */
function allViews() {
  return AREAS.filter((area) => !area.names).flatMap((area) => (area.module.views || []).map((view) => ({ ...view, area: area.key, type: 'view', ...SERVER_ONLY_RULES })));
}

/** The collections in an order in which each one's links point to collections that exist already. */
function creationOrder(specs = allCollections()) {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const done = new Set(['users']);
  const ordered = [];
  const visit = (spec, path = []) => {
    if (done.has(spec.name)) return;
    if (path.includes(spec.name)) throw new Error(`Links form a circle: ${[...path, spec.name].join(' -> ')}`);
    for (const field of spec.fields) {
      if (field.type === 'relation' && field.target !== spec.name && byName.has(field.target)) visit(byName.get(field.target), [...path, spec.name]);
    }
    done.add(spec.name);
    ordered.push(spec);
  };
  for (const spec of specs) visit(spec);
  return ordered;
}

/** A field definition as PocketBase takes it ([collectionIdOf] gives the id of a linked collection). */
function toPocketBaseField(field, collectionIdOf) {
  const { target, ...rest } = field;
  if (field.type !== 'relation') return rest;
  const collectionId = collectionIdOf(target);
  if (!collectionId) throw new Error(`The collection ${target} (linked from ${field.name}) does not exist yet.`);
  return { ...rest, collectionId };
}

/**
 * The index definitions of [spec] for a collection stored as [tableName]: an index name must be unique in the whole
 * database, so a collection built next to an old one of the same name gets its own index names.
 */
function indexesFor(spec, tableName = spec.name) {
  if (tableName === spec.name) return spec.indexes || [];
  return (spec.indexes || []).map((sql) => sql
    .replace(/INDEX (\w+) ON /, (match, indexName) => `INDEX ${indexName.replace(`idx_${spec.name}`, `idx_${tableName}`)}_n ON `)
    .replace(new RegExp(` ON ${spec.name} \\(`), ` ON ${tableName} (`));
}

/** The PocketBase body that creates [spec] (as [tableName]). */
function toCollectionBody(spec, { collectionIdOf, tableName = spec.name } = {}) {
  const fields = [...(spec.id ? [spec.id] : []), ...spec.fields.map((field) => toPocketBaseField(field, collectionIdOf))];
  return {
    name: tableName,
    type: spec.type || 'base',
    ...SERVER_ONLY_RULES,
    fields,
    indexes: indexesFor(spec, tableName)
  };
}

/**
 * Makes an existing collection match [spec]: its fields keep their ids (and so their data), options and help texts
 * follow the definition, missing fields are added. A field of another type, or a field the definition does not know,
 * is left as it is and reported - the schema never deletes data by itself.
 */
function mergeIntoCollection(existing, spec, { collectionIdOf, tableName = existing.name } = {}) {
  const problems = [];
  const fields = [...(existing.fields || [])];
  const wanted = [...(spec.id ? [spec.id] : []), ...spec.fields];
  for (const field of wanted) {
    const desired = toPocketBaseField(field, collectionIdOf);
    const index = fields.findIndex((current) => current.name === field.name);
    if (index < 0) {
      fields.push(desired);
    } else if (fields[index].type !== desired.type) {
      problems.push(`${tableName}.${field.name} is a ${fields[index].type} field, the definition wants ${desired.type}`);
    } else {
      fields[index] = { ...fields[index], ...desired, id: fields[index].id, system: fields[index].system };
    }
  }
  for (const current of fields) {
    if (!current.system && !wanted.some((field) => field.name === current.name)) problems.push(`${tableName}.${current.name} is not part of the definition`);
  }
  return {
    body: { ...existing, ...SERVER_ONLY_RULES, name: tableName, fields, indexes: indexesFor(spec, tableName) },
    problems
  };
}

module.exports = {
  SCHEMA_VERSION,
  AREAS,
  allCollections,
  allViews,
  creationOrder,
  toCollectionBody,
  mergeIntoCollection,
  indexesFor,
  USERS_FIELDS: system.USERS_FIELDS,
  PERMISSIONS: system.PERMISSIONS,
  finance,
  events,
  community,
  mentoring,
  system
};
