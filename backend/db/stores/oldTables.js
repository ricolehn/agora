// Tables of the new structure behind the functions of an old table: every record comes back exactly as the old table
// gave it - all fields, the same values, its PocketBase id - through a codec (../codec.js), so the code that used the
// old table works unchanged.
//
// Writes keep the old table's rules: unknown fields are ignored, a value is read the way PocketBase read it for the
// old field's type (a number sent as text is a number), a required field must not be empty. A change reads the
// record, applies the change and writes it back, in the record's own queue: two changes at the same moment never
// overwrite each other. Filters and sorts name the old fields; renamed ones are translated.
const client = require('../client');
const { isPlainObject } = require('../codec');
const { table } = require('../tables');
const { queueRecordWrite } = require('../writeQueue');

const has = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
const originalOf = (row) => (isPlainObject(row?.original) ? row.original : {});
const now = () => new Date().toISOString();

/** A value as PocketBase read it for a field of [type] of the old tables. */
const CAST = {
  text: (value) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)),
  number: (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const text = String(value ?? '').trim();
    const number = Number(text);
    return text !== '' && Number.isFinite(number) ? number : 0;
  },
  bool: (value) => value === true || value === 1 || value === 'true' || value === '1',
  json: (value) => (value === undefined ? null : value)
};
const EMPTY = { text: '', number: 0, bool: false, json: null };

/** A request PocketBase would have refused (an empty required field): the callers answer it as before. */
const refused = (field) => Object.assign(new Error(`Failed to save the record: ${field} cannot be blank.`), { status: 400, data: { [field]: { code: 'validation_required' } } });
const notFound = () => Object.assign(new Error("The requested resource wasn't found."), { status: 404 });

const QUOTED = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/;
const renameIn = (text, columns) => text.replace(/(^|[^.@\w])([A-Za-z_]\w*)/g, (whole, before, name) => (has(columns, name) ? `${before}${columns[name]}` : whole));

/**
 * [filter] (a PocketBase filter naming old fields) with the new names of [columns] ({ old: new }); quoted values are
 * left as they are. For the fields in [exact], "field = 'value'" also finds a record whose value is kept in
 * `original` (a link to something that is gone) and not one whose column holds a value the record never had.
 */
function translateFilter(filter, columns = {}, exact = []) {
  if (!filter) return '';
  const parts = String(filter).split(QUOTED);
  const out = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (index % 2 === 1) {
      out.push(part);
      continue;
    }
    const match = index + 1 < parts.length ? /(^|[^.@\w])([A-Za-z_]\w*)\s*=\s*$/.exec(part) : null;
    if (match && exact.includes(match[2])) {
      const key = match[2];
      const value = parts[index + 1];
      const column = columns[key] || key;
      out.push(`${renameIn(part.slice(0, match.index + match[1].length), columns)}(original.values.${key} = ${value} || (${column} = ${value} && original.values.${key} = null))`);
      index += 1;
      continue;
    }
    out.push(renameIn(part, columns));
  }
  return out.join('');
}

/** The links of new records: [existing] sets of ids by table name, [groups] ({ id, name }) the groups. */
function linkContextOf(existing, groups = []) {
  const groupIds = new Set(groups.map((group) => group.id));
  const groupIdByName = new Map();
  for (const group of groups) if (typeof group.name === 'string' && !groupIdByName.has(group.name)) groupIdByName.set(group.name, group.id);
  return {
    exists: (collection, id) => Boolean(existing[collection]?.has(id)),
    groupId: (entry) => (groupIds.has(entry) ? entry : groupIdByName.get(entry) || null)
  };
}

/** Which of [ids] exist in [collection] (a final table name). */
async function existingIds(appConfig, collection, ids) {
  const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
  const rows = await Promise.all(wanted.map((id) => client.getRecord(table(collection), id, appConfig).catch(() => null)));
  return new Set(rows.filter(Boolean).map((row) => row.id));
}

/** [ctx] in a world without [id] of [target] (it is about to be deleted; [groupName]: the name of a group). */
function without(ctx, target, id, groupName) {
  return {
    ...ctx,
    exists: (collection, other) => !(collection === target && other === id) && ctx.exists(collection, other),
    groupId: (entry) => {
      if (target === 'user_groups' && (entry === id || (groupName && entry === groupName))) return null;
      const found = ctx.groupId(entry);
      return target === 'user_groups' && found === id ? null : found;
    }
  };
}

/** The `original` to store: the codec's, plus what a store keeps there itself ([keep]: such keys of the row's). */
function storedOriginal(codecOriginal, row, keep = []) {
  const kept = Object.fromEntries(keep.filter((key) => has(originalOf(row), key)).map((key) => [key, originalOf(row)[key]]));
  const merged = { ...(codecOriginal || {}), ...kept };
  return Object.keys(merged).length ? merged : null;
}

/**
 * The store of one old table [kind] kept in the new table [tableName]. [fields]: the old fields [name, type,
 * required?] in their order; [links]: { field: table } of the old fields that are links now (users, events, ...);
 * [groupLinks]: the record names groups; [columns]: renamed fields { old: new } for filters and sorts; [ownCreated] /
 * [ownUpdated]: the new table's created / updated is not one of the old fields - set when written; [keep]: keys of
 * `original` the store manages itself; [exact]: fields whose filters also look into `original` (see translateFilter);
 * [scope]: { column: value } of the records of this kind when several old tables share the new one.
 */
function recordStore({ kind, tableName = kind, codec, fields, links = {}, groupLinks = false, columns = {}, exact = [], ownCreated = false, ownUpdated = false, keep = [], scope = null }) {
  const collection = () => table(tableName);
  const toOld = (row) => ({ collectionId: row.collectionId, collectionName: kind, ...codec.decode(row) });
  const scopeFilter = scope ? Object.entries(scope).map(([column, value]) => client.pbFilterEquals(column, value)).join(' && ') : '';
  const inScope = (row) => !scope || Object.entries(scope).every(([column, value]) => row?.[column] === value);
  /** [filter] of the old table for the new one: translated, and limited to this kind's records. */
  const filterOf = (filter) => {
    const translated = translateFilter(filter, columns, exact);
    if (!scopeFilter) return translated;
    return translated ? `${scopeFilter} && (${translated})` : scopeFilter;
  };
  const sortOf = (sort) => String(sort || '').split(',').filter(Boolean)
    .map((part) => part.replace(/^([+-]?)(\w+)$/, (whole, sign, name) => `${sign}${columns[name] || name}`)).join(',');

  /** The old fields of [data] as PocketBase read them (unknown fields and undefined values are left out). */
  function readFields(data) {
    const values = {};
    for (const [name, type] of fields) if (has(data, name) && data[name] !== undefined) values[name] = CAST[type](data[name]);
    return values;
  }

  /** What exists of what [object] links to. */
  async function writeContext(appConfig, object) {
    const byTable = {};
    for (const [field, target] of Object.entries(links)) (byTable[target] ||= []).push(object[field]);
    const found = await Promise.all(Object.entries(byTable).map(async ([target, ids]) => [target, await existingIds(appConfig, target, ids)]));
    const groups = groupLinks ? await client.listAllRecords(table('user_groups'), '', appConfig, '', { fields: 'id,name' }) : [];
    return linkContextOf(Object.fromEntries(found), groups);
  }

  /** The columns of [object] (the whole old record) for the row [id]. */
  async function body(appConfig, object, id, row = null, ctx = null) {
    const { columns: values, original } = codec.encode({ ...object, id }, { ...(ctx || await writeContext(appConfig, object)), recordId: id });
    const result = { ...values, ...(scope || {}), original: storedOriginal(original, row, keep) };
    delete result.id;
    if (ownUpdated) result.updated = now();
    return result;
  }

  return {
    kind,
    codec,
    collection,
    toOld,
    body,
    writeContext,

    async list(appConfig, filter = '', sort = '') {
      return (await client.listAllRecords(collection(), filterOf(filter), appConfig, sortOf(sort))).map(toOld);
    },

    async first(appConfig, filter, sort = '') {
      const row = await client.getFirstRecord(collection(), filterOf(filter), appConfig, sortOf(sort));
      return row ? toOld(row) : null;
    },

    async count(appConfig, filter = '') {
      return client.countRecords(collection(), filterOf(filter), appConfig);
    },

    async get(appConfig, id) {
      if (typeof id !== 'string' || !id) return null;
      const row = await client.getRecord(collection(), id, appConfig);
      return row && inScope(row) ? toOld(row) : null;
    },

    /** Creates a record from [data] (every field the old table had; missing ones empty); returns it as the old table did. */
    async create(appConfig, data) {
      const object = { ...Object.fromEntries(fields.map(([name, type]) => [name, EMPTY[type]])), ...readFields(data) };
      for (const [name, type, required] of fields) if (required && object[name] === EMPTY[type]) throw refused(name);
      const id = typeof data.id === 'string' && data.id ? data.id : client.newRecordId();
      const values = await body(appConfig, object, id);
      if (ownCreated) values.created = now();
      return toOld(await client.createRecord(collection(), { id, ...values }, appConfig));
    },

    /** Changes the fields in [data] of the record [id]; returns it as the old table did. */
    update(appConfig, id, data) {
      return queueRecordWrite(`${kind}:${id}`, async () => {
        const row = typeof id === 'string' && id ? await client.getRecord(collection(), id, appConfig) : null;
        if (!row || !inScope(row)) throw notFound();
        const object = { ...codec.decode(row), ...readFields(data) };
        delete object.id;
        for (const [name, type, required] of fields) if (required && has(object, name) && object[name] === EMPTY[type]) throw refused(name);
        return toOld(await client.updateRecord(collection(), row.id, await body(appConfig, object, row.id, row), appConfig));
      });
    },

    async remove(appConfig, id) {
      await client.deleteRecord(collection(), id, appConfig);
    },

    /** Re-writes the records [filter] (new column names) picks in a world without [id] of [target]: their links to it move into `original`. */
    async letGo(appConfig, filter, target, id, groupName) {
      for (const found of await client.listAllRecords(collection(), scopeFilter ? `${scopeFilter} && (${filter})` : filter, appConfig)) {
        await queueRecordWrite(`${kind}:${found.id}`, async () => {
          const row = await client.getRecord(collection(), found.id, appConfig);
          if (!row) return;
          const object = codec.decode(row);
          delete object.id;
          const ctx = without(await writeContext(appConfig, object), target, id, groupName);
          const values = await body(appConfig, object, row.id, row, ctx);
          // Letting go of a link is no change of the record for its readers
          if (ownUpdated) delete values.updated;
          await client.updateRecord(collection(), row.id, values, appConfig);
        });
      }
    }
  };
}

module.exports = { CAST, EMPTY, translateFilter, linkContextOf, existingIds, without, storedOriginal, recordStore, originalOf, has };
