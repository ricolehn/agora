// State of the app's frame that features may touch: the loading screen, the header that slides away while scrolling,
// the scrolling page container, the profile menu, the floating action menu and the sign-in over a visitor's page.
import { createSignal } from 'solid-js';
import { activeTab, setRevealHeaderHook } from './router';
import type { TabId } from './tabs';
import { flushNow } from './flush';

// --- Loading screen (covers the app while data loads after signing in) ---
// Signed in before (or a shared event's link): it shows from the start, like the boot screen of index.html, until
// the session is known - no empty page between the two
const expectsSession = () => {
  try {
    return (
      localStorage.getItem('agora-is-logged-in') === 'true' ||
      localStorage.getItem('nova-is-logged-in') === 'true' ||
      /[?&](share|guest)=/.test(window.location.search)
    );
  } catch {
    return false;
  }
};
const [loading, setLoading] = createSignal<{ visible: boolean; message: string }>({ visible: expectsSession(), message: '' });
export { loading };
export function showLoading(message = '') {
  setLoading({ visible: true, message });
}
export function setLoadingMessage(message: string) {
  setLoading(prev => ({ ...prev, message }));
}
export function hideLoading() {
  setLoading(prev => ({ ...prev, visible: false }));
}

// --- Header: slides away while scrolling down, comes back on the first scroll up (like the Android app) ---
const [headerHidden, setHeaderHidden] = createSignal(false);
const [headerScrolled, setHeaderScrolled] = createSignal(false);
export { headerHidden, headerScrolled, setHeaderHidden, setHeaderScrolled };
export const revealHeader = () => setHeaderHidden(false);
setRevealHeaderHook(revealHeader);

// --- The scrolling page: set by the shell ---
let container: HTMLElement | null = null;
export function setScrollContainer(el: HTMLElement | null) {
  container = el;
}
export const scrollContainer = () => container;
/** To the top of the page; smooth like every scroll of the page container unless 'instant'. */
export function scrollPageToTop(behavior: ScrollBehavior = 'auto') {
  container?.scrollTo({ top: 0, behavior });
}

// --- Profile menu: a panel that hangs a little over the profile button (like the Android app) ---
const [profileMenuOpen, setProfileMenuOpen] = createSignal(false);
const [profileMenuPosition, setProfileMenuPosition] = createSignal({ top: 12, right: 12 });
export { profileMenuOpen, setProfileMenuOpen, profileMenuPosition };
let profileButton: HTMLElement | null = null;

/** Opens the profile menu over [button]: 4px over its top right corner, at least 12px inside the window. */
export function openProfileMenu(button: HTMLElement) {
  profileButton = button;
  const box = button.getBoundingClientRect();
  setProfileMenuPosition({ top: Math.max(4, box.top - 4), right: Math.max(12, document.documentElement.clientWidth - box.right - 4) });
  setProfileMenuOpen(true);
  flushNow();
}
/** Closes the profile menu; returnFocus: the focus goes back to the profile button (Escape). */
export function closeProfileMenu(returnFocus = false) {
  if (!profileMenuOpen()) return;
  setProfileMenuOpen(false);
  flushNow();
  if (returnFocus) profileButton?.focus();
}

// --- Floating action button: its menu (open on the tab it was opened on: another tab closes it) ---
const [fabMenuTab, setFabMenuTab] = createSignal<TabId | null>(null);
export const fabMenuOpen = () => fabMenuTab() === activeTab();
export function setFabMenuOpen(open: boolean) {
  setFabMenuTab(open ? activeTab() : null);
}
export function closeFabMenu() {
  setFabMenuTab(null);
}

// Escape closes the profile menu (focus back on its button) and the action menu; a resize closes the profile menu
// (it was placed for the window it opened in)
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (profileMenuOpen()) closeProfileMenu(true);
  if (fabMenuOpen()) closeFabMenu();
});
window.addEventListener('resize', () => closeProfileMenu());

// --- Sign-in over a visitor's page: members who opened a shared event's link signed out sign in from there ---
const [signInBack, setSignInBack] = createSignal<(() => void) | null>(null);
export { signInBack };
/**
 * Shows "Back to the event" in the sign-in (over the visitor's page: the sign-in comes in front of its dialog);
 * null removes it. Show the sign-in itself with showAuthForm(true) (app/auth.ts).
 */
export function setSignInReturn(back: (() => void) | null) {
  setSignInBack(() => back);
}
