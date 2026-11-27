// Web push on this device. Only for the installed app (PWA), never in a browser tab: no permission prompt there and no
// subscription. iOS / iPadOS offer web push to home screen apps only anyway (16.4+).
import { createSignal } from 'solid-js';
import { api, apiJson, getToken } from '../../app/api';
import { t } from '../../app/i18n';
import { attempt, showToast } from '../../app/toast';

type PushPermission = NotificationPermission | 'unsupported';

export const isInstalledApp = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.matchMedia?.('(display-mode: fullscreen)').matches ||
  (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
const deviceSupportsPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushSupported = () => deviceSupportsPush() && isInstalledApp();

// What the device allows (shown on the notifications page): read again when the page can have changed it
const readPermission = (): PushPermission => (deviceSupportsPush() ? Notification.permission : 'unsupported');
const [pushPermission, setPushPermission] = createSignal<PushPermission>(readPermission());
export { pushPermission };
export const refreshPushPermission = () => setPushPermission(readPermission());

function urlBase64ToUint8Array(base64String: string) {
  const base64 = (base64String + '='.repeat((4 - (base64String.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(window.atob(base64), c => c.charCodeAt(0));
}

// Mobile browsers require a user gesture for the permission prompt, so it is asked on the first tap/click
let autoPromptRegistered = false;
function setupPwaPushAutoPrompt() {
  if (!pushSupported() || Notification.permission !== 'default' || autoPromptRegistered) return;
  autoPromptRegistered = true;
  const onUserInteraction = async () => {
    window.removeEventListener('click', onUserInteraction, true);
    window.removeEventListener('touchend', onUserInteraction, true);
    try {
      if (Notification.permission === 'default' && (await Notification.requestPermission()) === 'granted') await ensurePushNotificationSubscription(true);
    } catch (err) {
      console.warn('Auto-request push permission error:', err);
    }
    refreshPushPermission();
  };
  window.addEventListener('click', onUserInteraction, { capture: true, once: true });
  window.addEventListener('touchend', onUserInteraction, { capture: true, once: true });
}

/** Subscribes this device (once allowed) and tells the server. interactive: may ask for the permission now. */
export async function ensurePushNotificationSubscription(interactive = false) {
  if (!pushSupported()) return;
  try {
    if (!(await getToken())) return;
    let permission = Notification.permission;
    if (permission === 'default') {
      if (!interactive) return setupPwaPushAutoPrompt();
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') return;
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const { publicKey } = await apiJson<{ publicKey: string }>('/push/vapid-public-key');
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    }
    await apiJson('/push/subscribe', 'POST', { subscription: subscription.toJSON(), userAgent: navigator.userAgent, installed: true }).catch(e =>
      console.warn('Push sync error:', e)
    );
  } catch (err) {
    console.warn('Auto-subscribe push notification error:', err);
  }
}

/** "Allow notifications" on the notifications page. */
export async function allowPushOnDevice() {
  await ensurePushNotificationSubscription(true);
  refreshPushPermission();
}

/** "Send test" on the notifications page. */
export async function sendTestPush() {
  // Subscribed again first: a subscription the browser dropped would otherwise make the test silently go nowhere
  await ensurePushNotificationSubscription(false);
  const failed = t('push_test_failed', 'The test could not be sent.');
  if (await attempt(() => apiJson('/push/test', 'POST', {}, failed), failed)) showToast(t('push_test_sent', 'Test notification sent'));
}

/** Signing out: this device gets no more messages for the account. */
export async function unsubscribeDevicePush() {
  if (!pushSupported()) return;
  const subscription = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
  if (subscription) await api('/push/unsubscribe', 'POST', { endpoint: subscription.endpoint });
}

// No install button (there is a native Android app; iOS never offered the prompt). Chrome's own install banner stays
// suppressed, installing via the browser menu still works
window.addEventListener('beforeinstallprompt', e => e.preventDefault());
window.addEventListener('appinstalled', () => setupPwaPushAutoPrompt());
