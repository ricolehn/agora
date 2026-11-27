// The Firebase-like data and auth calls the app has always used (it once ran on Firebase), against the backend's
// /api/db and /api/auth: data paths ("people/<id>") read and written as JSON, transactions on the latest stored
// version, the session kept in localStorage. Reads say what they expect ([T]): the server answers with the stored
// values as they are.
import type { User } from './types';

export interface DbRef {
  db: unknown;
  path: string;
}
/** A read of a list filtered by one field (orderByChild + equalTo). */
export interface DbQuery {
  reference: DbRef;
  constraints: QueryConstraint[];
  orderByChild?: string;
  equalTo?: unknown;
}
type QueryConstraint = { type: 'orderByChild'; field: string } | { type: 'equalTo'; value: unknown };
/** What a read found: val() is null where there is nothing. */
export interface Snapshot<T> {
  exists(): boolean;
  val(): T | null;
}
/** The signed-in account as the sign-in returned it, with its token. */
export type CompatUser = User & { getIdToken(): Promise<string> };
export interface CompatAuth {
  app: unknown;
  readonly currentUser: CompatUser | null;
}
type AuthListener = (user: CompatUser | null) => void;
/** A stored value with its version (a transaction is refused when someone saved the value meanwhile). */
interface RawRead {
  value?: unknown;
  version?: string | null;
}
/** What the sign-in, the registration and /auth/me answer. */
interface SessionReply {
  token?: string | null;
  user?: User | null;
}

const authState: { currentUser: CompatUser | null; token: string | null; listeners: Set<AuthListener>; ready: Promise<void> | null } = {
  currentUser: null,
  token: null,
  listeners: new Set(),
  ready: null
};
const MAX_TRANSACTION_ATTEMPTS = 3;

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function makeSnapshot<T>(value: unknown): Snapshot<T> {
  return {
    exists() {
      if (value === null || value === undefined) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value).length > 0;
      return true;
    },
    val() {
      return value === undefined ? null : (clone(value) as T | null);
    }
  };
}

function notifyAuthListeners() {
  for (const listener of authState.listeners) {
    listener(authState.currentUser);
  }
}

function wrapUser(user: User | null | undefined): CompatUser | null {
  if (!user) return null;
  return {
    ...user,
    async getIdToken() {
      if (!authState.token) {
        throw new Error('Not authenticated');
      }
      return authState.token;
    }
  };
}

const AUTH_STORAGE_KEY = 'agora_auth_session';
const LEGACY_AUTH_STORAGE_KEY = 'nova_auth_session';

function getStoredAuth(): { token?: string | null; user: User } | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY) || localStorage.getItem(LEGACY_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionReply | null;
    if (parsed && typeof parsed === 'object' && parsed.user) {
      return { token: parsed.token, user: parsed.user };
    }
  } catch { /* ignore */ }
  return null;
}

function persistAuth(token: string | null | undefined, user: User | null | undefined) {
  try {
    if (user) {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: token || null, user }));
    } else {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      localStorage.removeItem(LEGACY_AUTH_STORAGE_KEY);
    }
  } catch { /* ignore */ }
}

const initialStored = getStoredAuth();
if (initialStored) {
  authState.token = initialStored.token || null;
  authState.currentUser = wrapUser(initialStored.user);
}

function saveAuth(token: string | null | undefined, user: User | null | undefined, notify = true) {
  authState.token = token || null;
  authState.currentUser = wrapUser(user);
  persistAuth(token, user);
  if (notify) {
    notifyAuthListeners();
  }
}

async function apiFetch(url: string, options: RequestInit = {}): Promise<unknown> {
  // The server answers in the language the page is shown in (set by the app's language loader)
  const headers: Record<string, string> = { 'Accept-Language': document.documentElement.lang || 'en', ...((options.headers as Record<string, string> | undefined) || {}) };
  if (authState.token) {
    headers.Authorization = `Bearer ${authState.token}`;
  }
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401) {
      if (!url.includes('/api/auth/login') && !url.includes('/api/auth/register') && !url.includes('/api/auth/me')) {
        saveAuth(null, null);
      }
    }
    let message = 'Request failed';
    const responseClone = response.clone();
    try {
      const data = (await response.json()) as { error?: string; message?: string } | null;
      message = data?.error || data?.message || message;
    } catch {
      message = await responseClone.text() || message;
    }
    throw Object.assign(new Error(message), { status: response.status });
  }
  if (response.status === 204) return null;
  return response.json();
}

async function restoreAuthState(retries = 4, delayMs = 1000) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const headers: Record<string, string> = {};
      if (authState.token) {
        headers.Authorization = `Bearer ${authState.token}`;
      }
      const response = await fetch('/api/auth/me', { headers });
      if (response.ok) {
        const data = (await response.json()) as SessionReply;
        saveAuth(data.token, data.user, false);
        return;
      }
      if (response.status === 401) {
        saveAuth(null, null, false);
        return;
      }
      if (response.status === 503 || response.status >= 500) {
        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
      }
    } catch {
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
    }
  }
}

let authReadyResolved = false;
authState.ready = restoreAuthState().then(() => {
  authReadyResolved = true;
  notifyAuthListeners();
});

export function initializeApp(config: unknown) {
  return { config };
}

export function getDatabase(app: unknown) {
  return { app };
}

export function ref(db: unknown, path: unknown = ''): DbRef {
  return { db, path: String(path || '').replace(/^\/+|\/+$/g, '') };
}

export function child(reference: DbRef, path: string): DbRef {
  return ref(reference.db || reference, [reference.path, path].filter(Boolean).join('/'));
}

export function orderByChild(field: string): QueryConstraint {
  return { type: 'orderByChild', field };
}

export function equalTo(value: unknown): QueryConstraint {
  return { type: 'equalTo', value };
}

export function query(reference: DbRef, ...constraints: QueryConstraint[]): DbQuery {
  const output: DbQuery = { reference, constraints };
  for (const constraint of constraints) {
    if (constraint?.type === 'orderByChild') output.orderByChild = constraint.field;
    if (constraint?.type === 'equalTo') output.equalTo = constraint.value;
  }
  return output;
}

async function readRaw(queryTarget: DbRef | DbQuery): Promise<RawRead | null> {
  const filter = 'reference' in queryTarget ? queryTarget : null;
  const target = filter ? filter.reference : (queryTarget as DbRef);
  const params = new URLSearchParams({ path: target.path || '', raw: '1' });
  if (filter?.orderByChild) params.set('orderByChild', filter.orderByChild);
  if (filter && filter.equalTo !== undefined) params.set('equalTo', String(filter.equalTo));
  return (await apiFetch(`/api/db?${params.toString()}`)) as RawRead | null;
}

export async function get<T>(queryTarget: DbRef | DbQuery): Promise<Snapshot<T>> {
  const result = await readRaw(queryTarget);
  return makeSnapshot<T>(result?.value);
}

/** The value of a path itself (without its version). */
export async function apiGet<T>(path: string): Promise<T | null> {
  return (await apiFetch(`/api/db?path=${encodeURIComponent(path)}`)) as T | null;
}

export async function set(reference: DbRef, value: unknown): Promise<void> {
  await apiFetch('/api/db', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: reference.path || '', value })
  });
}

export async function update(reference: DbRef, value: unknown): Promise<void> {
  await apiFetch('/api/db', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: reference.path || '', value })
  });
}

/**
 * Changes the stored value with [updater] on its latest version; a change someone saved meanwhile makes it try again.
 * The updater gets undefined where nothing is stored, and returning undefined leaves everything as it is.
 */
export async function runTransaction<T>(
  reference: DbRef,
  updater: (current: T | null | undefined) => T | null | undefined
): Promise<{ committed: boolean; snapshot: Snapshot<T> }> {
  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const current = await readRaw(reference);
    const nextValue = updater(clone(current?.value) as T | null | undefined);
    // As in Firebase: an updater that returns undefined leaves everything as it is
    if (nextValue === undefined) return { committed: false, snapshot: makeSnapshot<T>(current?.value) };
    try {
      const result = (await apiFetch('/api/db/transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: reference.path || '',
          currentVersion: current?.version || null,
          value: nextValue
        })
      })) as RawRead | null;
      return {
        committed: true,
        snapshot: makeSnapshot<T>(result?.value)
      };
    } catch (error) {
      if ((error as Error).message !== 'Conflict' || attempt === MAX_TRANSACTION_ATTEMPTS - 1) {
        throw error;
      }
    }
  }

  throw new Error('Transaction failed');
}

export function getAuth(app?: unknown): CompatAuth {
  return {
    app,
    get currentUser() {
      return authState.currentUser;
    }
  };
}

export function onAuthStateChanged(_auth: CompatAuth, callback: AuthListener): () => void {
  authState.listeners.add(callback);
  if (authReadyResolved) {
    callback(authState.currentUser);
  }
  return () => {
    authState.listeners.delete(callback);
  };
}

export async function signInWithEmailAndPassword(_auth: CompatAuth, email: string, password: string): Promise<{ user: CompatUser | null }> {
  const data = (await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  })) as SessionReply;
  saveAuth(data.token, data.user);
  return { user: authState.currentUser };
}

export async function createUserWithEmailAndPassword(
  _auth: CompatAuth,
  email: string,
  password: string,
  extra: { inviteCode?: string; firstName?: string; lastName?: string; name?: string } = {}
): Promise<{ user: CompatUser | null }> {
  const data = (await apiFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      inviteCode: extra.inviteCode || null,
      firstName: extra.firstName || '',
      lastName: extra.lastName || '',
      name: extra.name || ''
    })
  })) as SessionReply;
  saveAuth(data.token, data.user);
  return { user: authState.currentUser };
}

export async function signOut(_auth?: CompatAuth): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // Ignore logout transport errors and still clear local state.
  }
  saveAuth(null, null);
}

export async function updatePassword(_user: CompatUser, oldPassword: string, password: string): Promise<void> {
  await apiFetch('/api/auth/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword, password })
  });
  saveAuth(null, null);
}
