// The theme: 'system' (follows the device), 'light' or 'dark'; stored on the device. <html data-theme> carries the
// actual one (index.html sets it before the first paint).
import { createSignal } from 'solid-js';

export type ThemeSetting = 'system' | 'light' | 'dark';

const readStored = (): ThemeSetting => {
  try {
    return (localStorage.getItem('agora-theme') || localStorage.getItem('nova-theme') || 'system') as ThemeSetting;
  } catch {
    return 'system';
  }
};

const [themeSetting, setThemeSetting] = createSignal<ThemeSetting>(readStored());
const [actualTheme, setActualTheme] = createSignal<'light' | 'dark'>('light');
export { themeSetting, actualTheme };

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

function applyActualTheme(theme: ThemeSetting) {
  const actual = theme === 'system' ? (systemDark() ? 'dark' : 'light') : theme;
  document.documentElement.setAttribute('data-theme', actual);
  setActualTheme(actual);
  // The status / title bar takes the page's own background
  const pageBg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || (actual === 'dark' ? '#181817' : '#f5f4f1');
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(meta => {
    meta.content = pageBg;
  });
}

export function setTheme(theme: ThemeSetting) {
  try {
    localStorage.setItem('agora-theme', theme);
  } catch {
    /* private mode */
  }
  setThemeSetting(theme);
  applyActualTheme(theme);
}

export function initTheme() {
  applyActualTheme(themeSetting());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (readStored() === 'system') applyActualTheme('system');
  });
}
