// State of the app's frame that features may touch: the loading screen, the header that slides away while scrolling,
// the scrolling page container, the profile menu and the floating action menu.
import { createSignal } from 'solid-js';
import { setRevealHeaderHook } from './router';

// --- Loading screen (covers the app while data loads after signing in) ---
const [loading, setLoading] = createSignal<{ visible: boolean; message: string }>({ visible: false, message: '' });
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

// --- The scrolling page (.container): set by the shell ---
let container: HTMLElement | null = null;
export function setScrollContainer(el: HTMLElement | null) {
  container = el;
}
export const scrollContainer = () => container;
export function scrollPageToTop(behavior: ScrollBehavior = 'auto') {
  container?.scrollTo({ top: 0, behavior });
}

// --- Profile menu and floating action menu ---
const [profileMenuOpen, setProfileMenuOpen] = createSignal(false);
const [fabMenuOpen, setFabMenuOpen] = createSignal(false);
export { profileMenuOpen, setProfileMenuOpen, fabMenuOpen, setFabMenuOpen };
export const closeFabMenu = () => setFabMenuOpen(false);
