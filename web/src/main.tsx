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
startAuth();
// The boot screen of index.html gives way to the app's own screens
document.getElementById('boot')?.remove();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.log('ServiceWorker registration failed: ', err));
  });
}
