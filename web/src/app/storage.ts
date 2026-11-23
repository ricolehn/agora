// What the app remembers in the browser (localStorage). Private modes and blocked site data throw on every access:
// the app then goes on without it - with the default language, theme and order, and the sign-in at the start.

/** The text stored under [key]; null when there is none or no storage. */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** What is stored under [key] as JSON; [fallback] when there is nothing, no storage or no JSON. */
export function readStoredJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

/** Keeps [value] under [key] (a text as it is, anything else as JSON); null removes it. */
export function store(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    /* no storage: nothing is remembered */
  }
}

// Signed in on this device (also under the name of the previous app): the start shows the loading screen instead of
// the sign-in until the session is known
const SIGNED_IN = 'agora-is-logged-in';
const SIGNED_IN_BEFORE = 'nova-is-logged-in';
export const wasSignedIn = () => readStored(SIGNED_IN) === 'true' || readStored(SIGNED_IN_BEFORE) === 'true';
export function setSignedIn(on: boolean) {
  store(SIGNED_IN, on ? 'true' : null);
  if (!on) store(SIGNED_IN_BEFORE, null);
}
