const authState = {
  currentUser: null,
  token: null,
  listeners: new Set(),
  ready: null
};
const MAX_TRANSACTION_ATTEMPTS = 3;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function makeSnapshot(value) {
  return {
    exists() {
      if (value === null || value === undefined) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value).length > 0;
      return true;
    },
    val() {
      return clone(value);
    }
  };
}

function notifyAuthListeners() {
  for (const listener of authState.listeners) {
    listener(authState.currentUser);
  }
}

function wrapUser(user) {
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

const AUTH_STORAGE_KEY = 'nova_auth_session';

function getStoredAuth() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.user) {
      return parsed;
    }
  } catch { /* ignore */ }
  return null;
}

function persistAuth(token, user) {
  try {
    if (user) {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: token || null, user }));
    } else {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  } catch { /* ignore */ }
}

const initialStored = getStoredAuth();
if (initialStored) {
  authState.token = initialStored.token || null;
  authState.currentUser = wrapUser(initialStored.user);
}

function saveAuth(token, user) {
  authState.token = token || null;
  authState.currentUser = wrapUser(user);
  persistAuth(token, user);
  notifyAuthListeners();
}

async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authState.token) {
    headers.Authorization = `Bearer ${authState.token}`;
  }
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401) {
      if (!url.includes('/api/auth/login') && !url.includes('/api/auth/register')) {
        saveAuth(null, null);
      }
    }
    let message = 'Request failed';
    const responseClone = response.clone();
    try {
      const data = await response.json();
      message = data.error || data.message || message;
    } catch {
      message = await responseClone.text() || message;
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function restoreAuthState(retries = 4, delayMs = 1000) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const headers = {};
      if (authState.token) {
        headers.Authorization = `Bearer ${authState.token}`;
      }
      const response = await fetch('/api/auth/me', { headers });
      if (response.ok) {
        const data = await response.json();
        saveAuth(data.token, data.user);
        return;
      }
      if (response.status === 401) {
        saveAuth(null, null);
        return;
      }
      if (response.status === 503 || response.status >= 500) {
        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
      }
    } catch (err) {
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
    }
  }
}

authState.ready = restoreAuthState().then(() => {
  notifyAuthListeners();
});

export function initializeApp(config) {
  return { config };
}

export function getDatabase(app) {
  return { app };
}

export function ref(db, path = '') {
  return { db, path: String(path || '').replace(/^\/+|\/+$/g, '') };
}

export function child(reference, path) {
  return ref(reference.db || reference, [reference.path, path].filter(Boolean).join('/'));
}

export function orderByChild(field) {
  return { type: 'orderByChild', field };
}

export function equalTo(value) {
  return { type: 'equalTo', value };
}

export function query(reference, ...constraints) {
  const output = { reference, constraints };
  for (const constraint of constraints) {
    if (constraint?.type === 'orderByChild') output.orderByChild = constraint.field;
    if (constraint?.type === 'equalTo') output.equalTo = constraint.value;
  }
  return output;
}

async function readRaw(queryTarget) {
  const target = queryTarget.reference ? queryTarget.reference : queryTarget;
  const params = new URLSearchParams({ path: target.path || '', raw: '1' });
  if (queryTarget.orderByChild) params.set('orderByChild', queryTarget.orderByChild);
  if (queryTarget.equalTo !== undefined) params.set('equalTo', String(queryTarget.equalTo));
  return apiFetch(`/api/db?${params.toString()}`);
}

export async function get(queryTarget) {
  const result = await readRaw(queryTarget);
  return makeSnapshot(result?.value);
}

export async function apiGet(path) {
  const result = await apiFetch(`/api/db?path=${encodeURIComponent(path)}`);
  return result; // Note backend returns result.value or just the payload depending on `raw` param
}

export async function set(reference, value) {
  await apiFetch('/api/db', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: reference.path || '', value })
  });
}

export async function update(reference, value) {
  await apiFetch('/api/db', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: reference.path || '', value })
  });
}

export async function remove(reference) {
  await apiFetch('/api/db', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: reference.path || '' })
  });
}

export async function runTransaction(reference, updater) {
  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const current = await readRaw(reference);
    const nextValue = updater(clone(current?.value));
    try {
      const result = await apiFetch('/api/db/transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: reference.path || '',
          currentVersion: current?.version || null,
          value: nextValue
        })
      });
      return {
        committed: true,
        snapshot: makeSnapshot(result?.value)
      };
    } catch (error) {
      if (error.message !== 'Conflict' || attempt === MAX_TRANSACTION_ATTEMPTS - 1) {
        throw error;
      }
    }
  }

  throw new Error('Transaction failed');
}

export function getAuth(app) {
  return {
    app,
    get currentUser() {
      return authState.currentUser;
    }
  };
}

export function onAuthStateChanged(auth, callback) {
  authState.listeners.add(callback);
  authState.ready.then(() => callback(authState.currentUser));
  return () => authState.listeners.delete(callback);
}

export async function signInWithEmailAndPassword(auth, email, password) {
  const data = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  saveAuth(data.token, data.user);
  return { user: authState.currentUser };
}

export async function createUserWithEmailAndPassword(auth, email, password, extra = {}) {
  const data = await apiFetch('/api/auth/register', {
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
  });
  saveAuth(data.token, data.user);
  return { user: authState.currentUser };
}

export async function signOut() {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // Ignore logout transport errors and still clear local state.
  }
  saveAuth(null, null);
}

export async function updatePassword(user, oldPassword, password) {
  await apiFetch('/api/auth/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword, password })
  });
  saveAuth(null, null);
}
