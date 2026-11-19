// The instance's configuration: the backend writes /assets/config.js for every instance (its name, switched-off
// features). It is loaded as it is (never bundled), before anything else of the app starts.
import { createSignal } from 'solid-js';

export interface AppConfig {
  apiBaseUrl: string;
  appName: string;
  features?: { polls?: boolean };
}

const fallback: AppConfig = { apiBaseUrl: `${window.location.origin}/api`, appName: 'Agora', features: {} };

async function loadConfig(): Promise<AppConfig> {
  try {
    const url = '/assets/config.js';
    const mod = await import(/* @vite-ignore */ url);
    return { ...fallback, ...(mod?.config || {}) };
  } catch (error) {
    console.warn('Could not load /assets/config.js:', error);
    return fallback;
  }
}

export const config: AppConfig = await loadConfig();

/** Base address of the API, e.g. https://example.org/api */
export const API = config.apiBaseUrl;

/** Switched-off features (backend/features.js); an old cached config.js has none, so everything stays off. */
export const FEATURES = { polls: config.features?.polls === true };

// The name from the server configuration; the system settings change it right after saving
const [appName, setAppNameSignal] = createSignal(config.appName || 'Agora');
export { appName };
export function setAppName(name: string) {
  setAppNameSignal(name || 'Agora');
  document.title = name || 'Agora';
}
