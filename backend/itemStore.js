// Items the routes read and change one at a time by their key: songs, prayer requests, polls and the order of service
// of an event. Changes of one kind run one after another (the app runs as a single process).
const newItems = require('./db/stores/items');
const { httpError, notFound } = require('./httpError');

/** Ids come from URLs: only plain ids (UUIDs), never "__proto__", filters or paths. */
const isValidKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(key);

/** The store of [collection]: songs, prayers and polls (db/stores/items.js), the order of service (db/stores/events.js). */
function createItemStore(collection) {
  if (collection === 'event_programs') return require('./db/stores/events').programStore;
  return newItems.createItemStore(collection);
}

/**
 * Changes the item [key] of [store] by [change](item), in the store's queue. No such item (or a key that cannot be
 * one): 404 with [missing]. A refusal [change] returns ({ error, status }) or throws (httpError.js) is the answer;
 * otherwise its result ({ save } or { remove }, and what the route needs of it).
 */
async function changeItem(appConfig, store, key, missing, change) {
  if (!isValidKey(key)) throw notFound(missing);
  const result = await store.update(appConfig, key, (item) => {
    if (!item) throw notFound(missing);
    return change(item);
  });
  if (result.error) throw httpError(result.status || 400, result.error);
  return result;
}

module.exports = { createItemStore, isValidKey, changeItem };
