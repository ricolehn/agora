import { For, Show } from 'solid-js';
import { Dynamic } from '@solidjs/web';
import { authView } from './app/auth';
import { anyModalOpen } from './app/modals';
import { rootComponents } from './app/registry';
import { isAuthenticated } from './app/session';
import { Login } from './shell/Login';
import { LoadingOverlay, Toast } from './shell/Overlays';
import { Shell } from './shell/Shell';

export function App() {
  return (
    <>
      {/* Under an open dialog the page is inert (keyboard and screen readers stay in the dialog) */}
      <div class="h-full" inert={anyModalOpen()}>
        <Show when={isAuthenticated()}>
          <Shell />
        </Show>
      </div>
      {/* The sign-in stands on its own: a visitor's shared event (a dialog) can be open behind it */}
      <Show when={authView() !== 'none'}>
        <Login />
      </Show>
      <For each={rootComponents}>{component => <Dynamic component={component} />}</For>
      <LoadingOverlay />
      <Toast />
    </>
  );
}
