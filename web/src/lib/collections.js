// Changing a list that is stored whole (donations, expenses), as app/data.ts does it - here without the app around it,
// so tests/frontend.test.js can run it against a stand-in server.
//
// Read the latest server copy with its version, apply `change`, write it back - refused if someone else saved the list
// meanwhile, then read and applied again (runTransaction). While the database upgrade waits, the previous version of
// the server serves the instance (/api/status names no API versions, only the upgrade): it takes transactions of
// people only and refused every list with 400 - donations and expenses could not be added, changed or deleted at all.
// There they are saved as that version always took them.

const list = value => (!value ? [] : Array.isArray(value) ? value : Object.values(value));

/** Whether the server is the previous version (its /api/status names no API versions). */
export function createIsPreviousServer({ fetch, api }) {
  return async function isPreviousServer() {
    const status = await fetch(`${api}/status`).then(res => (res.ok ? res.json() : null)).catch(() => null);
    return Boolean(status) && !Array.isArray(status.apiVersions);
  };
}

/** mutateCollection(name, change): change(list) returns the new list (or nothing to leave it as it is). */
export function createMutateCollection({ db, ref, runTransaction, apiGet, set, isPreviousServer }) {
  return async function mutateCollection(name, change) {
    try {
      await runTransaction(ref(db, name), current => change(list(current)) || undefined);
    } catch (error) {
      if (error?.status !== 400 || !(await isPreviousServer())) throw error;
      const next = change(list(await apiGet(name)));
      if (next) await set(ref(db, name), next);
    }
  };
}
