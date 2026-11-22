export function createIsPreviousServer(deps: { fetch: typeof fetch; api: string }): () => Promise<boolean>;
export function createMutateCollection(deps: {
  db: unknown;
  ref: (db: any, path?: string) => any;
  runTransaction: (reference: any, updater: (current: any) => any) => Promise<unknown>;
  apiGet: (path: string) => Promise<any>;
  set: (reference: any, value: unknown) => Promise<void>;
  isPreviousServer: () => Promise<boolean>;
}): (name: string, change: (list: any[]) => any[] | null | undefined | void) => Promise<void>;
