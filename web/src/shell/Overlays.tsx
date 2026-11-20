// The loading screen and the toast.
import { Show } from 'solid-js';
import { appName } from '../app/config';
import { t } from '../app/i18n';
import { loading } from '../app/shell';
import { toast, toastSign, type ToastType } from '../app/toast';
import { Spinner } from '../ui/feedback';

/** The page while the profile and the data load: the spinner, what is happening, the app's name at the bottom. */
export function LoadingOverlay() {
  return (
    <Show when={loading().visible}>
      <div
        id="loading-overlay"
        class={[
          'fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-bg',
          // A dark system shows the old warm black behind the spinner (unless the app is set to light)
          'dark:[@media(prefers-color-scheme:dark)]:bg-[#1c1917]'
        ]}
      >
        <Spinner />
        <div id="loading-message" class="mt-5 font-semibold text-text">
          {loading().message || t('loading', 'Loading data...')}
        </div>
        <div class="absolute bottom-5 text-[0.7rem] font-medium text-[#a8a29e]">{appName()} &copy; 2026</div>
      </div>
    </Show>
  );
}

const TOAST_EDGE: Record<ToastType, string> = {
  success: 'border-l-success',
  error: 'border-l-danger',
  info: 'border-l-primary',
  warning: 'border-l-warning'
};

/** A short message at the top right (app/toast.ts showToast): it springs in and fades after 3 seconds. */
export function Toast() {
  return (
    <div
      id="toast"
      role="status"
      aria-live="polite"
      class={[
        'fixed top-5 right-5 z-[10001] flex max-w-[350px] items-center gap-3 rounded-[12px] border border-l-[5px] border-border px-5 py-3 font-semibold text-text',
        'bg-[var(--frost-surface)] shadow-[0_10px_30px_rgba(0,0,0,0.15)] will-change-[transform,opacity] [backdrop-filter:var(--frost)]',
        '[transition:translate_0.35s_cubic-bezier(0.34,1.56,0.64,1),scale_0.35s_cubic-bezier(0.34,1.56,0.64,1),opacity_0.35s_cubic-bezier(0.34,1.56,0.64,1),box-shadow_0.35s_cubic-bezier(0.34,1.56,0.64,1),background-color_0.35s_cubic-bezier(0.34,1.56,0.64,1),border-color_0.35s_cubic-bezier(0.34,1.56,0.64,1),color_0.35s_cubic-bezier(0.34,1.56,0.64,1)]',
        TOAST_EDGE[toast().type],
        toast().visible ? 'pointer-events-auto translate-x-0 scale-100 opacity-100' : 'pointer-events-none translate-x-[30px] scale-95 opacity-0'
      ]}
    >
      {toastSign(toast().type)} {toast().message}
    </div>
  );
}
