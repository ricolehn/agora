// Live updates: the server names the area that changed ('mentoring', 'events', ..., otherwise 'all') over
// /api/stream. Events arriving in a burst are collected for a moment and answered with a single reload of just those
// areas. Features register the loader of their area; 'all' reloads everything (data.ts loadData).
import { API } from './config';
import { isAuthenticated } from './session';

const REMOTE_UPDATE_DELAY_MS = 350;
const pendingRemoteScopes = new Set<string>();
let remoteUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let remoteUpdateRunning = false;
const loaders = new Map<string, Array<() => unknown>>();
let reloadAll: (() => Promise<unknown>) | null = null;

/** What to reload when the server says [scope] changed (several features may share a scope). */
export function registerRemoteLoader(scope: string, fn: () => unknown) {
  loaders.set(scope, [...(loaders.get(scope) || []), fn]);
}
/** data.ts: the reload of everything. */
export function setReloadAll(fn: () => Promise<unknown>) {
  reloadAll = fn;
}

export function queueRemoteUpdate(scope: string) {
  pendingRemoteScopes.add(scope);
  if (!remoteUpdateTimer) remoteUpdateTimer = setTimeout(flushRemoteUpdates, REMOTE_UPDATE_DELAY_MS);
}

async function flushRemoteUpdates() {
  remoteUpdateTimer = null;
  if (!isAuthenticated()) return pendingRemoteScopes.clear();
  // A reload is still running: keep the scopes and try again afterwards
  if (remoteUpdateRunning) {
    remoteUpdateTimer = setTimeout(flushRemoteUpdates, REMOTE_UPDATE_DELAY_MS);
    return;
  }
  const scopes = [...pendingRemoteScopes];
  pendingRemoteScopes.clear();
  remoteUpdateRunning = true;
  try {
    if (scopes.includes('all')) await reloadAll?.();
    else await Promise.all(scopes.flatMap(scope => (loaders.get(scope) || []).map(fn => fn())));
  } catch (err) {
    console.warn('Remote update failed:', err);
  } finally {
    remoteUpdateRunning = false;
  }
}

let sseConnection: EventSource | null = null;
// After a lost connection the changes made in the meantime never arrive as live updates: reload everything
let sseLost = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function connectSSE() {
  if (sseConnection) return;
  sseConnection = new EventSource(API + '/stream', { withCredentials: true });
  sseConnection.onopen = () => {
    if (sseLost) queueRemoteUpdate('all');
    sseLost = false;
  };
  sseConnection.addEventListener('data_update', e => {
    let scope = 'all';
    try {
      scope = (JSON.parse((e as MessageEvent).data || '{}') as { scope?: string } | null)?.scope || 'all';
    } catch {
      /* older servers send an empty payload: reload everything */
    }
    queueRemoteUpdate(scope);
  });
  sseConnection.onerror = () => {
    console.log('SSE error, reconnecting...');
    sseLost = true;
    sseConnection?.close();
    sseConnection = null;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // Signed out meanwhile: the next sign-in connects again
      if (isAuthenticated()) connectSSE();
    }, 5000);
  };
}

export function disconnectSSE() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  sseLost = false;
  sseConnection?.close();
  sseConnection = null;
}

// Back in the app after a while (phone locked, another app open): catch up, like the Android app does on resume
let hiddenSince = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenSince = Date.now();
    return;
  }
  if (hiddenSince && Date.now() - hiddenSince > 2 * 60 * 1000 && isAuthenticated()) queueRemoteUpdate('all');
  hiddenSince = 0;
});
