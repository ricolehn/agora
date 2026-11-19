// The loading screen and the toast.
import { Show } from 'solid-js';
import { appName } from '../app/config';
import { t } from '../app/i18n';
import { loading } from '../app/shell';
import { toast, toastSign } from '../app/toast';
import { Spinner } from '../ui/feedback';

export function LoadingOverlay() {
  return (
    <Show when={loading().visible}>
      <div id="loading-overlay" class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-bg">
        <Spinner />
        <div class="mt-5 font-semibold text-text">{loading().message || t('loading', 'Loading data...')}</div>
        <div class="absolute bottom-8 text-sm text-text-secondary">
          {appName()} &copy; 2026
        </div>
      </div>
    </Show>
  );
}

export function Toast() {
  return (
    <div
      id="toast"
      role="status"
      aria-live="polite"
      class={[
        'pointer-events-none fixed bottom-[calc(var(--mobile-bottom-nav-offset)+20px)] left-1/2 z-[10000] max-w-[90vw] -translate-x-1/2 rounded-2xl px-5 py-3 font-semibold shadow-card-lg transition md:bottom-8',
        toast().visible ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0',
        toast().type === 'error' ? 'bg-danger text-white' : 'bg-text text-bg'
      ]}
    >
      {toastSign(toast().type)} {toast().message}
    </div>
  );
}
