// Who is doing what the server does right now: the signed-in person of the request being handled (set by verifyToken),
// or nobody for the server's own work (standing orders, cleanups). The finance change log records it with every
// change, without every caller having to pass it along.
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

const nameOf = (user) => user?.name || `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || user?.email || '';

/** Runs [work] (and everything it starts) as [user]. */
function runAs(user, work) {
  return storage.run({ by: String(user?.uid || user?.id || ''), byName: nameOf(user) }, work);
}

/** { by, byName } of who is acting; the server itself when no request is being handled. */
function currentActor() {
  return storage.getStore() || { by: 'system', byName: '' };
}

module.exports = { runAs, currentActor };
