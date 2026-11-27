// Types of lib/collections.js (plain JavaScript: tests/frontend.test.js runs it as it is)
import type { DbRef, Snapshot } from '../app/pocketbase-compat';
import type { Collections } from '../app/types';

export function createIsPreviousServer(deps: { fetch: typeof fetch; api: string }): () => Promise<boolean>;

/** Changes the list [name] with [change] (the new list; nothing leaves it as it is) on the latest server copy. */
export type MutateCollection = <K extends keyof Collections>(
  name: K,
  change: (list: Collections[K][]) => Collections[K][] | null | undefined | void
) => Promise<void>;

export function createMutateCollection(deps: {
  db: unknown;
  ref: (db: unknown, path?: string) => DbRef;
  runTransaction: <T>(reference: DbRef, updater: (current: T | null) => T | null | undefined) => Promise<{ committed: boolean; snapshot: Snapshot<T> }>;
  apiGet: <T>(path: string) => Promise<T | null>;
  set: (reference: DbRef, value: unknown) => Promise<void>;
  isPreviousServer: () => Promise<boolean>;
}): MutateCollection;
