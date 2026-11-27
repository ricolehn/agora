// Changing a list that is stored whole (donations, expenses), as app/data.ts does it - here without the app around it,
// so tests/frontend.test.js can run it against a stand-in server.
//
// Read the latest server copy with its version, apply `change`, write it back - refused if someone else saved the list
// meanwhile, then read and applied again (runTransaction). While the database upgrade waits, the previous version of
// the server serves the instance (/api/status names no API versions, only the upgrade): it takes transactions of
// people only and refused every list with 400 - donations and expenses could not be added, changed or deleted at all.
// There they are saved as that version always took them.
import type { DbRef, Snapshot } from '../app/pocketbase-compat';
import type { Collections } from '../app/types';

type Stored<T> = T[] | Record<string, T> | null | undefined;
const list = <T>(value: Stored<T>): T[] => (!value ? [] : Array.isArray(value) ? value : Object.values(value));

/** Whether the server is the previous version (its /api/status names no API versions). */
export function createIsPreviousServer({ fetch, api }: { fetch: typeof globalThis.fetch; api: string }) {
  return async function isPreviousServer(): Promise<boolean> {
    const status = (await fetch(`${api}/status`)
      .then(res => (res.ok ? res.json() : null))
      .catch(() => null)) as { apiVersions?: unknown } | null;
    return Boolean(status) && !Array.isArray(status?.apiVersions);
  };
}

/** Changes the list [name] with [change] (the new list; nothing leaves it as it is) on the latest server copy. */
export type MutateCollection = <K extends keyof Collections>(
  name: K,
  change: (list: Collections[K][]) => Collections[K][] | null | undefined | void
) => Promise<void>;

interface CollectionDeps {
  db: unknown;
  ref: (db: unknown, path?: string) => DbRef;
  runTransaction: <T>(reference: DbRef, updater: (current: T | null | undefined) => T | null | undefined) => Promise<{ committed: boolean; snapshot: Snapshot<T> }>;
  apiGet: <T>(path: string) => Promise<T | null>;
  set: (reference: DbRef, value: unknown) => Promise<void>;
  isPreviousServer: () => Promise<boolean>;
}

/** mutateCollection(name, change): change(list) returns the new list (or nothing to leave it as it is). */
export function createMutateCollection({ db, ref, runTransaction, apiGet, set, isPreviousServer }: CollectionDeps): MutateCollection {
  return async function mutateCollection<K extends keyof Collections>(name: K, change: (list: Collections[K][]) => Collections[K][] | null | undefined | void) {
    type Entry = Collections[K];
    try {
      await runTransaction<Stored<Entry>>(ref(db, name), current => change(list(current)) || undefined);
    } catch (error) {
      if ((error as { status?: number } | null)?.status !== 400 || !(await isPreviousServer())) throw error;
      const next = change(list(await apiGet<Stored<Entry>>(name)));
      if (next) await set(ref(db, name), next);
    }
  };
}
