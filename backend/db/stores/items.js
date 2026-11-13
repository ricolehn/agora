// Songs, prayer requests and polls in the new structure (community_*), behind the interface the server has always
// used for them (itemStore.js): list, count, get, update. Each item is one record with columns instead of one JSON
// value; codecs/community.js turns it back into exactly the object the routes wrote.
//
// The record id is the item's key (the id the routes made). A key that is no record id (only possible in data an
// older version or a hand edit left) gets a new id and keeps the key in `original.key` - the routes could never reach
// such an item by its key, and they still cannot; it stays in the lists as before.
//
// Changes to one kind run one after another (the app is a single process), so two votes or two editors at the same
// moment never overwrite each other. All parts of the server share one store per kind (one queue).
const client = require('../client');
const codecs = require('../codecs/community');
const { isPlainObject } = require('../codec');
const { table } = require('../tables');

const isValidKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(key);
const originalOf = (row) => (isPlainObject(row?.original) ? row.original : {});

// The names the routes use, and where those items live now
const KINDS = {
  songs: { collection: 'community_songs', codec: codecs.song },
  prayers: { collection: 'community_prayers', codec: codecs.prayer },
  polls: { collection: 'community_polls', codec: codecs.poll }
};

/**
 * The record of [item] of [kind] (without its id): its columns, and in `original` what the columns cannot show. An
 * item that is no object at all (only in old data) is kept whole in `original.data`. [ctx]: recordId, exists().
 */
function itemBody(kind, item, ctx) {
  if (!isPlainObject(item)) return { original: { notAnObject: true, data: item === undefined ? null : item } };
  const { columns, original } = KINDS[kind].codec.encode(item, ctx);
  const body = { ...columns, original };
  delete body.id;
  return body;
}

/** The item exactly as it was saved. */
function decodeItem(kind, row) {
  const original = originalOf(row);
  if (original.notAnObject === true) return original.data === undefined ? null : original.data;
  return KINDS[kind].codec.decode(row);
}

/** The key the routes know a record by. */
const keyOf = (row) => (typeof originalOf(row).key === 'string' ? originalOf(row).key : row.id);

/** Which accounts exist, for the links of a prayer request (a link to an account that is gone stays in `original`). */
async function linkContext(appConfig, kind, item) {
  const uid = kind === 'prayers' && isPlainObject(item) ? item.authorUid : null;
  if (typeof uid !== 'string' || !uid) return { exists: () => false };
  const found = isValidKey(uid) ? await client.getRecord('users', uid, appConfig) : null;
  return { exists: (collection, id) => collection === 'users' && Boolean(found) && id === found.id };
}

function makeItemStore(kind) {
  const spec = KINDS[kind];
  const collection = () => table(spec.collection);
  let queue = Promise.resolve();
  const serial = (work) => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };

  async function find(appConfig, key) {
    if (!isValidKey(key)) return null;
    const row = await client.getRecord(collection(), key, appConfig);
    return row && keyOf(row) === key ? row : null;
  }

  return {
    isValidKey,

    async list(appConfig) {
      const rows = await client.listAllRecords(collection(), '', appConfig);
      return rows.map((row) => decodeItem(kind, row)).filter((data) => data && typeof data === 'object');
    },

    async count(appConfig) {
      return client.countRecords(collection(), '', appConfig);
    },

    async get(appConfig, key) {
      const row = await find(appConfig, key);
      return (row && decodeItem(kind, row)) || null;
    },

    /**
     * Reads the item [key] (null if missing), lets [change] decide and stores its decision: { save: item } writes it,
     * { remove: true } deletes it; the whole result is returned.
     */
    update(appConfig, key, change) {
      return serial(async () => {
        const row = await find(appConfig, key);
        const result = (await change((row && decodeItem(kind, row)) || null)) || {};
        if (result.save) {
          const id = row ? row.id : key;
          const body = itemBody(kind, result.save, { ...(await linkContext(appConfig, kind, result.save)), recordId: id });
          // Kinds whose items carry no time of their own for it: when the record was last written
          if (kind !== 'songs') body.updated = new Date().toISOString();
          if (row) await client.updateRecord(collection(), row.id, body, appConfig);
          else await client.createRecord(collection(), { id, ...body }, appConfig);
        } else if (result.remove && row) {
          // An order of service keeps naming a deleted song, as it always did (../links.js)
          if (kind === 'songs') await require('../links').keepLinksTo(appConfig, spec.collection, row.id);
          await client.deleteRecord(collection(), row.id, appConfig);
        }
        return result;
      });
    },

    /** Deletes every item [matches] picks (also one no key reaches); returns how many it picked. */
    removeWhere(appConfig, matches) {
      return serial(async () => {
        const rows = await client.listAllRecords(collection(), '', appConfig);
        const picked = rows.filter((row) => {
          const item = decodeItem(kind, row);
          return item && typeof item === 'object' && matches(item);
        });
        for (const row of picked) await client.deleteRecord(collection(), row.id, appConfig).catch(() => {});
        return picked.length;
      });
    }
  };
}

const stores = new Map();

/** The store of [kind] ('songs', 'prayers' or 'polls'). */
function createItemStore(kind) {
  if (!KINDS[kind]) throw new Error(`Unknown kind of item: ${kind}`);
  if (!stores.has(kind)) stores.set(kind, makeItemStore(kind));
  return stores.get(kind);
}

module.exports = { createItemStore, isValidKey, KINDS, itemBody, decodeItem, keyOf };
