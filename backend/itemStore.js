// Items the routes read and change one at a time by their key: songs, prayer requests, polls and the order of service
// of an event. Changes of one kind run one after another (the app runs as a single process).
const newItems = require('./db/stores/items');

/** Ids come from URLs: only plain ids (UUIDs), never "__proto__", filters or paths. */
const isValidKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(key);

/** The store of [collection]: songs, prayers and polls (db/stores/items.js), the order of service (db/stores/events.js). */
function createItemStore(collection) {
  if (collection === 'event_programs') return require('./db/stores/events').programStore;
  return newItems.createItemStore(collection);
}

module.exports = { createItemStore, isValidKey };
