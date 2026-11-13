// Links to something that is deleted. PocketBase empties a link when the record it points to is deleted; the old
// tables kept the id (a duty of a person whose account is gone still named them, an event kept its deleted target
// group and stayed hidden). Before the server deletes an account, a group or a song, keepLinksTo() lets every record
// that links to it let go: the column is emptied (nothing in the new structure points to what is gone) and the value
// the older apps read moves into `original`, where they still find it.
//
// The stores register what links to what (holdLinks) when they are loaded.
const holders = new Map();

/** [letGo](appConfig, id) runs before a record of [target] (a table name) is deleted. */
function holdLinks(target, letGo) {
  if (!holders.has(target)) holders.set(target, []);
  holders.get(target).push(letGo);
}

/** Lets every record that links to [id] of [target] let go of it (call right before deleting it). */
async function keepLinksTo(appConfig, target, id) {
  // Every store that links to something registers itself when it is loaded
  require('./stores/finance');
  require('./stores/events');
  require('./stores/mentoring');
  require('./stores/system');
  for (const letGo of holders.get(target) || []) await letGo(appConfig, id);
}

module.exports = { holdLinks, keepLinksTo };
