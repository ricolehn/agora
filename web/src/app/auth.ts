// Signing in and out. The compat layer restores the session on start (/api/auth/me) and reports every change of the
// signed-in account here; this module loads the profile and the data, or shows the sign-in.
import { createSignal } from 'solid-js';
import {
  api, apiJson, auth, createUserWithEmailAndPassword, db, get, onAuthStateChanged, ref, signInWithEmailAndPassword, signOut,
  updatePassword
} from './api';
import { clearData, loadData } from './data';
import { onLanguageChange, t, uiLang } from './i18n';
import { connectSSE, disconnectSSE } from './live';
import { loadCurrentProfilePicture, setOwnPicture } from './pictures';
import { resetRouting } from './router';
import { currentUid, currentUser, patchCurrentUser, setCurrentUser, setIsAuthenticated, type User } from './session';
import { hideLoading, setLoadingMessage, showLoading } from './shell';
import { alertMessage, confirmAction, showToast } from './toast';
import { flushNow } from './flush';

// --- The sign-in screen ---
export type AuthView = 'none' | 'login' | 'register';
const [authView, setAuthView] = createSignal<AuthView>('none');
const [authError, setAuthError] = createSignal('');
// The first answer about the session arrived (until then the boot screen stays)
const [authResolved, setAuthResolved] = createSignal(false);
export { authView, setAuthView, authError, setAuthError, authResolved };

/** Shows the sign-in (true) or the registration (false). */
export function showAuthForm(isLogin: boolean) {
  setAuthError('');
  setAuthView(isLogin ? 'login' : 'register');
}

// --- Hooks of the features ---
const signedInHooks: Array<(user: User) => void> = [];
const signedOutHooks: Array<() => boolean | void> = [];
/** Runs after signing in (or restoring the session), once the account is known. */
export function onSignedIn(fn: (user: User) => void) {
  signedInHooks.push(fn);
}
/** Runs when nobody is signed in; returning true means the hook shows a page of its own (a shared event for
 *  visitors) instead of the sign-in. */
export function onSignedOut(fn: () => boolean | void) {
  signedOutHooks.push(fn);
}
// Before signing out: e.g. this device's push subscription is removed while still signed in
const beforeSignOutHooks: Array<() => Promise<unknown> | unknown> = [];
export function onBeforeSignOut(fn: () => Promise<unknown> | unknown) {
  beforeSignOutHooks.push(fn);
}

const setLoggedInFlag = (on: boolean) => {
  try {
    if (on) localStorage.setItem('agora-is-logged-in', 'true');
    else {
      localStorage.removeItem('agora-is-logged-in');
      localStorage.removeItem('nova-is-logged-in');
    }
  } catch {
    /* private mode */
  }
};

async function fetchUserProfile(uid: string, retries = 2): Promise<User | null> {
  const snap = await get(ref(db, 'users/' + uid));
  if (snap.exists()) return { ...snap.val(), uid };
  if (retries <= 0) return null;
  await new Promise(res => setTimeout(res, 400));
  return fetchUserProfile(uid, retries - 1);
}

// Runs beside the start: only a fresh installation (no owner yet) or an owner without flags changes anything, then the
// profile and the data are loaded again
async function bootstrapSuperAdmin(user: { uid: string }) {
  try {
    const res = await api('/admin/bootstrap-super-admin', 'POST');
    if (!res.ok) return;
    const result = await res.json();
    if (!(result.isSuperAdmin || result.isOwner)) return;
    const current = currentUser();
    if (current?.owner && current?.superAdmin && current?.admin) return;
    patchCurrentUser({ admin: true, owner: true, superAdmin: true });
    patchCurrentUser((await fetchUserProfile(user.uid, 2)) || {});
    void loadData(true);
  } catch (error) {
    console.warn('Super admin bootstrap skipped:', error);
  }
}

// The server writes push messages and e-mails in the language the user's app resolved to; the time zone helps it find
// the community's zone for duty reminders when the server has no TZ (Docker default UTC)
function syncUserLanguage() {
  const user = currentUser();
  const uid = currentUid();
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    /* old browsers */
  }
  const value: Record<string, string> = {};
  if (user?.language !== uiLang()) value.language = uiLang();
  if (timeZone && user?.timeZone !== timeZone) value.timeZone = timeZone;
  if (!uid || !Object.keys(value).length) return;
  patchCurrentUser(value);
  api('/db', 'PATCH', { path: `users/${uid}`, value }).catch(e => console.warn('Could not save the language:', e));
}
onLanguageChange(() => syncUserLanguage());

// The boot screen of index.html covers the page until the app shows its own screen (loading or sign-in)
const removeBootScreen = () => document.getElementById('boot')?.remove();

const storedSessionHint = () => {
  try {
    return localStorage.getItem('agora-is-logged-in') === 'true' || localStorage.getItem('nova-is-logged-in') === 'true';
  } catch {
    return false;
  }
};

/** Wires the session to the app (once, at start). */
export function startAuth() {
  // Nobody signed in on this device and no shared event's link: the sign-in right away, without waiting for the server
  if (!storedSessionHint() && !/[?&](share|guest)=/.test(window.location.search)) {
    showAuthForm(true);
    flushNow();
    removeBootScreen();
  }
  onAuthStateChanged(auth, async user => {
    setAuthResolved(true);
    if (user) {
      setAuthView('none');
      showLoading(t('auth_loading_profile', 'Loading profile...'));
      flushNow();
      removeBootScreen();
      setLoggedInFlag(true);
      // /auth/me carries the whole profile plus the computed fields (permissions, mentor status). Opening the app
      // already restored the session with it: no second round trip before the data; after a fresh login it is
      // asked once
      const { getIdToken, ...account } = user;
      const complete = 'isApprovedMentor' in account;
      const profile = complete
        ? null
        : (await apiJson('/auth/me').then(data => data?.user || null).catch(() => null)) || (await fetchUserProfile(user.uid, 2));
      if (!complete && !profile) setLoadingMessage(t('auth_profile_not_found', 'Profile not found, please contact an admin.'));
      setCurrentUser({ ...(profile || { role: 'user', email: user.email, uid: user.uid }), ...account } as User);
      setIsAuthenticated(true);
      connectSSE();
      void loadData(false, { freshUser: complete || 'isApprovedMentor' in (profile || {}) });
      void bootstrapSuperAdmin(user);
      void loadCurrentProfilePicture();
      syncUserLanguage();
      for (const fn of signedInHooks) fn(currentUser()!);
    } else {
      setLoggedInFlag(false);
      setIsAuthenticated(false);
      resetRouting();
      setCurrentUser(null);
      hideLoading();
      // A shared event's link: visitors without an account see the event (members can sign in from there)
      if (signedOutHooks.some(fn => fn() === true)) {
        setAuthView('none');
      } else {
        showAuthForm(true);
      }
      flushNow();
      removeBootScreen();
    }
    flushNow();
  });
}

export async function attemptLogin(email: string, password: string) {
  if (!email || !password) {
    setAuthError(t('auth_enter_credentials', 'Please enter your email and password.'));
    return;
  }
  try {
    setAuthError('');
    await signInWithEmailAndPassword(auth, email, password);
    setAuthView('none');
    showLoading(t('auth_loading_profile', 'Loading profile...'));
  } catch (error: any) {
    console.error(error);
    setAuthError(t('auth_login_failed', 'Login failed: ') + error.message);
  }
}

export interface Registration {
  code: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  password2: string;
}
export async function attemptRegister(r: Registration) {
  const validationError =
    !r.code || !r.email || !r.firstName || !r.lastName || !r.password || !r.password2
      ? t('alert_fill_fields', 'Please fill out all fields.')
      : r.password.length < 6
        ? t('setup_admin_password_invalid', 'Password must be at least 6 characters long.')
        : r.password !== r.password2
          ? t('setup_err_password_match', 'Passwords do not match.')
          : null;
  if (validationError) {
    setAuthError(validationError);
    return;
  }
  try {
    setAuthError('');
    setAuthView('none');
    showLoading(t('auth_initializing_profile', 'Setting up profile...'));
    await createUserWithEmailAndPassword(auth, r.email, r.password, {
      inviteCode: r.code,
      firstName: r.firstName,
      lastName: r.lastName,
      name: `${r.firstName} ${r.lastName}`.trim()
    });
  } catch (error: any) {
    console.error(error);
    hideLoading();
    setAuthView('register');
    setAuthError(error.status === 403 ? t('auth_invalid_code', 'Invalid registration code.') : t('auth_register_failed', 'Registration failed: ') + error.message);
  }
}

export async function logout() {
  history.replaceState(null, '', '/');
  try {
    disconnectSSE();
    setOwnPicture(null);
    // While still signed in; a slow network must not keep anyone from signing out
    await Promise.race([Promise.all(beforeSignOutHooks.map(fn => fn())), new Promise(resolve => setTimeout(resolve, 3000))]).catch(() => {});
    await signOut(auth);
  } catch (error) {
    console.error('Logout Error:', error);
  }
  clearData();
  // A fresh page for the next person: the AI chat, the last open conversation and the loaded lists of this session
  // must not show up for whoever signs in next on the same device
  location.reload();
}

/** Changes the own password; the server signs out afterwards. */
export async function changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
  if (!oldPassword) {
    showToast(t('alert_enter_old_password', 'Please enter your old password.'), 'error');
    return false;
  }
  if (!newPassword || newPassword.length < 6) {
    showToast(t('alert_new_password_length', 'New password must be at least 6 characters long.'), 'error');
    return false;
  }
  try {
    if (!auth.currentUser) {
      showToast(t('alert_no_user_logged_in', 'No user logged in.'), 'error');
      return false;
    }
    await updatePassword(auth.currentUser, oldPassword, newPassword);
    showToast(t('toast_password_changed', 'Password changed – please sign in again.'));
    return true;
  } catch (error: any) {
    console.error(error);
    showToast(t('alert_password_change_failed', 'Error changing password: ') + error.message, 'error');
    return false;
  }
}

/** Deletes the own account after password confirmation (Google Play account deletion policy). */
export async function deleteOwnAccount(password: string): Promise<boolean> {
  if (!password) {
    showToast(t('delete_account_need_password', 'Please enter your password to confirm.'), 'error');
    return false;
  }
  if (!confirmAction(t('delete_account_confirm', 'Your account and your personal data will be deleted permanently. This cannot be undone. Continue?'))) return false;
  try {
    await apiJson('/auth/delete-account', 'POST', { password }, t('delete_account_failed', 'The account could not be deleted.'));
    alertMessage(t('delete_account_done', 'Your account has been deleted.'));
    await logout();
    return true;
  } catch (err: any) {
    showToast(err.message || t('delete_account_failed', 'The account could not be deleted.'), 'error');
    return false;
  }
}
