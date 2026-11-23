// Toasts and simple dialogs. Callers pass already translated texts (t()). The toast itself is drawn by the shell
// (shell/Overlays.tsx) from the signal below.
import { createSignal } from 'solid-js';
import { t } from './i18n';

export type ToastType = 'success' | 'error' | 'info' | 'warning';
export interface ToastState {
  message: string;
  type: ToastType;
  visible: boolean;
  /** Changes with every toast (a new toast restarts its timer and animation). */
  seq: number;
}

const [toast, setToast] = createSignal<ToastState>({ message: '', type: 'success', visible: false, seq: 0 });
export { toast };

let toastTimeout: ReturnType<typeof setTimeout> | undefined;
let seq = 0;

/** Shows a short message at the top right for 3 seconds. Neutral news ('info') gets no warning sign. */
export function showToast(message: string, type: ToastType | string = 'success') {
  if (!message) return;
  seq += 1;
  setToast({ message, type: (['success', 'error', 'info', 'warning'].includes(type) ? type : 'error') as ToastType, visible: true, seq });
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => setToast(prev => ({ ...prev, visible: false })), 3000);
}

/** The sign in front of a toast's text. */
export const toastSign = (type: ToastType) => ({ success: '✅', info: 'ℹ️' } as Record<string, string>)[type] || '⚠️';

/** The browser's confirm dialog (as before). */
export function confirmAction(text: string): boolean {
  return window.confirm(text);
}

/** The browser's alert for messages that must be acknowledged; empty messages are not shown. */
export function alertMessage(text: string) {
  if (text) window.alert(text);
}

/**
 * Runs an action and reports a failure as a toast (an error by default - no blocking browser dialog): the message is
 * a string or a function of the error. `setBusy` shows the loading state meanwhile. Resolves to true on success.
 */
export async function attempt(
  action: () => Promise<unknown> | unknown,
  failure: string | ((err: any) => string),
  { toast: toastType = 'error', setBusy }: { toast?: ToastType; setBusy?: (busy: boolean) => void } = {}
): Promise<boolean> {
  setBusy?.(true);
  try {
    await action();
    return true;
  } catch (err) {
    console.error(err);
    const message = typeof failure === 'function' ? failure(err) : failure;
    showToast(message || t('error_unknown', 'Unknown error'), toastType);
    return false;
  } finally {
    setBusy?.(false);
  }
}
