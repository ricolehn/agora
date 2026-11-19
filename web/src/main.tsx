import './styles/app.css';
import { render } from '@solidjs/web';
import { startAuth } from './app/auth';
import { languageReady } from './app/i18n';
import { initTheme } from './app/theme';
import './features';
import { ImageCropper } from './ui/ImageCropper';
import { registerRoot } from './app/registry';
import { App } from './App';

registerRoot(ImageCropper);
initTheme();

// The texts first (pages for visitors render before any data), then the app; the session decides what shows
await languageReady;
render(() => <App />, document.getElementById('root')!);
// The session decides what shows; the boot screen of index.html stays until then (app/auth.ts)
startAuth();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.log('ServiceWorker registration failed: ', err));
  });
}
