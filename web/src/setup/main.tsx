// The first-time setup (served while the instance has no configuration): app name and logo, the owner's account,
// e-mail settings. It needs none of the app's session or data.
import '../styles/app.css';
import { render } from '@solidjs/web';
import { languageReady } from '../app/i18n';
import { Setup } from './Setup';

// A configured instance has no setup: to the app
fetch('/api/status')
  .then(res => res.json())
  .then(data => {
    if (!data.setupMode) window.location.href = '/';
  })
  .catch(() => {});

await languageReady;
render(() => <Setup />, document.getElementById('setup')!);
