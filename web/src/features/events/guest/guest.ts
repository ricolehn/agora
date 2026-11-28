// Visitors without an account: the page of a shared event, signing up as a guest, their own places on this device.
import { createSignal } from 'solid-js';
import { setAuthView, showAuthForm } from '../../../app/auth';
import { API, appName } from '../../../app/config';
import { languageReady, t, uiLang } from '../../../app/i18n';
import { openModal, topModal } from '../../../app/modals';
import { hideLoading, setSignInReturn, showLoading } from '../../../app/shell';
import { confirmAction, showToast } from '../../../app/toast';
import { readStoredJson, store } from '../../../app/storage';
import { linkParam, slugify } from '../../../app/util';
import { errorMessage, errorStatus, type ErrorAnswer } from '../../../app/api';
import type { PublicEvent } from '../types';

export const GUEST_MODAL = 'guest-event-modal';
const GUEST_KEYS_STORAGE = 'agora_guest_keys';
// Same as the server (backend/eventGuests.js): a guest's details are deleted this many days after the event
export const GUEST_RETENTION_DAYS = 30;

/** A place a guest signed up for from this device (the key is their way back to it). */
export interface GuestPlace {
  key: string;
  name: string;
  status: string;
  shareToken?: string;
  event?: PublicEvent;
}
/** The places of the keys a device knows (POST /api/public/guests/lookup). */
interface GuestLookup {
  registrations?: GuestPlace[];
}
/** A guest's registration as the server confirms it, with the event's fresh numbers. */
interface GuestRegistration {
  key: string;
  name: string;
  status: string;
  event?: PublicEvent;
  emailed?: boolean;
}

export interface GuestView {
  /** Nobody is signed in: the page stands instead of the app. */
  anon: boolean;
  token: string;
  event: PublicEvent | null;
  /** The places signed up from this device. */
  mine: GuestPlace[];
  formOpen: boolean;
  ownKeyGone?: boolean;
  failed?: boolean;
}

const [guestView, setGuestView] = createSignal<GuestView | null>(null);
export { guestView };

const patchView = (fields: Partial<GuestView>) => setGuestView(view => view && { ...view, ...fields });

function storedGuestKeys(): string[] {
  const keys = readStoredJson<unknown>(GUEST_KEYS_STORAGE, []);
  return Array.isArray(keys) ? keys.filter(key => typeof key === 'string') : [];
}

// Without storage the link in the e-mail still leads to the registration
const storeGuestKeys = (keys: string[]) => store(GUEST_KEYS_STORAGE, [...new Set(keys)].slice(0, 20));

// The API without an account (no token); answers come in the page's language
async function publicApi<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { 'Accept-Language': uiLang(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = (await res.json().catch(() => ({}))) as ErrorAnswer;
  if (!res.ok) throw Object.assign(new Error(data.error || t('error_connection', 'Connection error')), { status: res.status });
  return data as T;
}

// A failed fetch (offline) has no text for people
const guestError = (err: unknown) => (err instanceof TypeError ? t('error_connection', 'Connection error') : errorMessage(err));

/** A guest knows the event's title only: the address gets the same readable name, the share key finds the event. */
export const guestShareUrl = (ev: { title?: string }, token: string) =>
  `${window.location.origin}/events/${encodeURIComponent(slugify(ev.title) || 'event')}?share=${encodeURIComponent(token)}`;

/**
 * What a visitor may see: the event of the share link, or of their own registration (the link in their e-mails),
 * and their places on this device. Registrations that are gone (cancelled, removed, over) leave the device.
 */
async function loadGuestView(anon: boolean): Promise<GuestView> {
  const token = linkParam('share');
  const ownKey = linkParam('guest');
  const keys = [...new Set([ownKey, ...storedGuestKeys()].filter(Boolean))];
  const found = keys.length ? (await publicApi<GuestLookup>('/public/guests/lookup', 'POST', { keys })).registrations || [] : [];
  const own = ownKey ? found.find(reg => reg.key === ownKey) || null : null;
  storeGuestKeys(found.map(reg => reg.key));
  const view: GuestView = { anon, token: '', event: null, mine: [], formOpen: false, ownKeyGone: !!ownKey && !own };
  if (token) {
    try {
      view.event = await publicApi<PublicEvent>(`/public/events/${encodeURIComponent(token)}`);
      view.token = token;
    } catch (err) {
      if (errorStatus(err) !== 404) throw err;
    }
  }
  if (!view.event && own) {
    view.event = own.event ?? null;
    view.token = own.shareToken || '';
  }
  view.mine = view.token ? found.filter(reg => reg.shareToken === view.token) : own ? [own] : [];
  return view;
}

/** Shows the shared event's page; anon: nobody is signed in (the page instead of the sign-in). */
export async function openGuestEvent(anon: boolean): Promise<void> {
  // Signed out the session's answer has just taken the boot screen away: the loading screen stays until the page is
  // there (a blank page showed while the event loaded - for as long as a slow connection took)
  if (anon) showLoading();
  await languageReady;
  let view: GuestView;
  try {
    view = await loadGuestView(anon);
  } catch (err) {
    console.warn('Shared event could not be loaded:', err);
    view = { anon, token: '', event: null, mine: [], formOpen: false, failed: true };
  }
  // A member closes it like any page and is back in the app: the link's keys leave the address first (the page's
  // own history entry comes after it)
  if (!anon) history.replaceState(history.state, '', window.location.pathname);
  setGuestView(view);
  if (anon) hideLoading();
  if (view.event) {
    document.title = `${view.event.title} · ${appName()}`;
    // Once the share link is known the address shows it, not the guest's own key: copied from the address bar it
    // shares the event, never the registration
    if (view.token && linkParam('guest')) history.replaceState(history.state, '', guestShareUrl(view.event, view.token).slice(window.location.origin.length));
  } else {
    document.title = appName();
  }
  if (anon) holdGuestPage();
  else openModal(GUEST_MODAL);
}

// Signed out there is no app behind the shared event: the back gesture keeps the visitor on the page (as before, when
// the page was a dialog that refused to close). The page has a history entry of its own - a "view" entry, so that
// after signing in from the page the app takes it over as the entry of the event (router.ts applyInitialRoute) - and
// a back gesture puts it back. A dialog over the page (sharing) gets an entry of its own and closes first.
const GUEST_PAGE_ENTRY = { view: 'guest-event' };
function holdGuestPage() {
  if (history.state?.view !== GUEST_PAGE_ENTRY.view) history.pushState(GUEST_PAGE_ENTRY, '');
}

/** The back gesture on the visitors' page (registerBackFirst): the page stays; true when handled. */
export function backOnGuestPage(): boolean {
  if (!guestView()?.anon || topModal()) return false;
  history.pushState(GUEST_PAGE_ENTRY, '');
  return true;
}

/** Back to the members' page: closed, or signed in. */
export function leaveGuestView() {
  if (!guestView()) return;
  setGuestView(null);
  document.title = appName();
}

export function openGuestForm() {
  patchView({ formOpen: true });
}

export interface GuestFields {
  name: string;
  email: string;
  age: string;
  /** The honeypot field (left empty by people). */
  website: string;
}

/** Signs a guest up; resolves to the error text to show in the form ('' when it worked). */
export async function submitGuestRegistration(form: GuestFields): Promise<string> {
  const view = guestView();
  if (!view?.token) return '';
  try {
    const data = await publicApi<GuestRegistration>(`/public/events/${encodeURIComponent(view.token)}/register`, 'POST', form);
    storeGuestKeys([data.key, ...storedGuestKeys()]);
    const current = guestView() || view;
    patchView({
      mine: [...current.mine, { key: data.key, name: data.name, status: data.status, shareToken: view.token }],
      event: data.event || current.event,
      formOpen: false
    });
    const done = data.status === 'waitlist' ? t('guest_reg_waitlist_done', 'You are on the waiting list.') : t('guest_reg_done', 'You are registered.');
    showToast(data.emailed ? `${done} ${t('guest_reg_emailed', 'A confirmation is on its way by e-mail.')}` : done);
    return '';
  } catch (err) {
    return guestError(err);
  }
}

export async function cancelGuestRegistration(key: string) {
  const view = guestView();
  const reg = view?.mine.find(entry => entry.key === key);
  if (!view || !reg || !confirmAction(t('guest_reg_cancel_confirm', 'Do you really want to cancel the registration of {name}?', { name: reg.name }))) return;
  try {
    await publicApi('/public/guests/cancel', 'POST', { key });
    storeGuestKeys(storedGuestKeys().filter(stored => stored !== key));
    const left = (guestView()?.mine || view.mine).filter(entry => entry.key !== key);
    // Fresh places (someone may have moved up); without the share link only the own places change. One of the own
    // places on the waiting list may be the one that moved up: their states are asked again too (the page said
    // "on the waiting list" for a guest the server had just given the place)
    const [event, found] = await Promise.all([
      view.token ? publicApi<PublicEvent>(`/public/events/${encodeURIComponent(view.token)}`).catch(() => view.event) : view.event,
      left.length ? publicApi<GuestLookup>('/public/guests/lookup', 'POST', { keys: left.map(entry => entry.key) }).then(data => data.registrations || [], () => null) : null
    ]);
    const mine = left.map(entry => ({ ...entry, status: found?.find(reg => reg.key === entry.key)?.status || entry.status }));
    patchView({ mine, event });
    showToast(t('guest_reg_cancelled', 'The registration is cancelled.'));
  } catch (err) {
    showToast(guestError(err), 'error');
  }
}

// Members who open the link signed out (another browser, the phone) sign in; the app then opens the event. The
// sign-in comes in front of the page with "Back to the event"
export function showGuestSignIn() {
  setSignInReturn(closeGuestSignIn);
  showAuthForm(true);
}

function closeGuestSignIn() {
  setSignInReturn(null);
  setAuthView('none');
}

/** Signed in (from the page or anywhere): the app takes over (the address opens the event as a member). */
export function endGuestPage() {
  setSignInReturn(null);
  leaveGuestView();
}
