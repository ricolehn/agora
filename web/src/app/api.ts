// The backend API. Plain objects go out as JSON, FormData as it is; the session token comes from the compat layer
// (pocketbase-compat.js: the Firebase-like data and auth calls the app has always used against /api/db and /api/auth).
import {
  initializeApp, getDatabase, getAuth, ref, set, get, child, update, query, orderByChild, equalTo, runTransaction, apiGet,
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, updatePassword
} from './pocketbase-compat.js';
import { API, config } from './config';
import { t, uiLang } from './i18n';

export const db = getDatabase(initializeApp(config));
export const auth = getAuth();

export {
  ref, set, get, child, update, query, orderByChild, equalTo, runTransaction, apiGet,
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, updatePassword
};

export { API };

/** The session token ('' when signed out). */
export const getToken = async (): Promise<string> => (auth.currentUser ? auth.currentUser.getIdToken() : '');

export async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  let token: string;
  try {
    token = await auth.currentUser!.getIdToken();
  } catch (tokenError: any) {
    throw new Error(t('error_auth_failed', 'Authentication failed. Please sign in again.') + ' (' + (tokenError?.code || tokenError?.message || t('error_unknown', 'Unknown error')) + ')');
  }
  const headers: Record<string, string> = { 'Accept-Language': uiLang(), ...((options.headers as Record<string, string>) || {}), Authorization: `Bearer ${token}` };
  if (typeof options.body === 'string' && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  return fetch(url, { ...options, headers });
}

/** A request against the backend API (path below /api). Plain objects are sent as JSON, FormData as it is. */
export function api(path: string, method = 'GET', body?: unknown): Promise<Response> {
  const isJson = body !== undefined && !(body instanceof FormData);
  return fetchWithAuth(API + path, { method, body: isJson ? JSON.stringify(body) : (body as BodyInit | undefined) });
}

export interface ApiError extends Error {
  status?: number;
  data?: any;
  offline?: boolean;
}

/** Like api(), but resolves to the parsed JSON body and throws the backend's error message on failure. */
export async function apiJson<T = any>(path: string, method = 'GET', body?: unknown, fallbackError?: string): Promise<T> {
  // No connection: the browser's own English "Failed to fetch" reached the screen, also in German
  const res = await api(path, method, body).catch(err => {
    throw Object.assign(new Error(t('error_connection', 'Connection error')), { cause: err, offline: true });
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || data.message || fallbackError || `HTTP ${res.status}`), { data, status: res.status }) as ApiError;
  return data as T;
}

/** fetch with a time limit (uploads and receipts on a bad connection must not hang forever). */
export async function fetchWithTimeout(resource: string, options: RequestInit = {}, ms = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// While the database upgrade waits, the previous version of the server serves the instance: its /api/status names
// no API versions, only the upgrade (see mutateCollection in data.ts)
export async function isPreviousServer(): Promise<boolean> {
  const status = await fetch(`${API}/status`).then(res => (res.ok ? res.json() : null)).catch(() => null);
  return Boolean(status) && !Array.isArray(status.apiVersions);
}
