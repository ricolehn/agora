// Polls and songs: one PocketBase record per item ({ key, data }) in a collection only the server can read.
// Changes to one collection run one after another (the app runs as a single process), so two votes or two editors
// at the same moment never overwrite each other.
const { listAllRecords, getFirstRecord, createRecord, updateRecord, deleteRecord, pbFilterEquals } = require('./pocketbase');

/** Ids come from URLs: only plain ids (UUIDs), never "__proto__", filters or paths. */
const isValidKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(key);

function createItemStore(collection) {
  let queue = Promise.resolve();
  const serial = (work) => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };

  const find = async (appConfig, key) => (isValidKey(key) ? getFirstRecord(collection, pbFilterEquals('key', key), appConfig) : null);

  return {
    isValidKey,

    async list(appConfig) {
      const records = await listAllRecords(collection, '', appConfig);
      return records.map((record) => record.data).filter((data) => data && typeof data === 'object');
    },

    async count(appConfig) {
      return (await listAllRecords(collection, '', appConfig)).length;
    },

    async get(appConfig, key) {
      return (await find(appConfig, key))?.data || null;
    },

    /**
     * Reads the item [key] (null if missing), lets [change] decide and stores its decision:
     * { save: item } writes it, { remove: true } deletes it; the whole result is returned.
     */
    update(appConfig, key, change) {
      return serial(async () => {
        const record = await find(appConfig, key);
        const result = (await change(record?.data || null)) || {};
        if (result.save) {
          if (record) await updateRecord(collection, record.id, { data: result.save }, appConfig);
          else await createRecord(collection, { key, data: result.save }, appConfig);
        } else if (result.remove && record) {
          await deleteRecord(collection, record.id, appConfig);
        }
        return result;
      });
    }
  };
}

module.exports = { createItemStore, isValidKey };
