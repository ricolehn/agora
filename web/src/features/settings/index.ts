// The personal settings: one tab for everyone (a menu with sub-pages at /settings/<page>), and web push on this device.
import { onBeforeSignOut, onSignedIn } from '../../app/auth';
import { onDataLoaded } from '../../app/data';
import { registerTab } from '../../app/registry';
import { activeTab, onTabEnter, registerLevelBack, registerRouteHandler, registerSubPath } from '../../app/router';
import { ensurePushNotificationSubscription, refreshPushPermission, unsubscribeDevicePush } from './push';
import { SettingsTab } from './SettingsTab';
import { closeSettingsPage, isPageAvailable, openPage, openSettingsPage, showSettingsMenu } from './state';

registerTab('settings', SettingsTab);
// Entering the tab shows the menu; the device's push state may have changed meanwhile
onTabEnter('settings', () => {
  showSettingsMenu();
  refreshPushPermission();
});
registerSubPath('settings', () => openPage() || '');
// /settings/<page>: the page, when it is offered to this person
registerRouteHandler('settings', {
  after: rest => {
    if (isPageAvailable(rest[0])) openSettingsPage(rest[0], { fromRoute: true });
  }
});
// Back from a page: the menu
registerLevelBack(() => {
  if (activeTab() !== 'settings' || !openPage()) return false;
  closeSettingsPage(true);
  return true;
});

// Web push: subscribed after signing in and with every full load, removed from this device before signing out
onSignedIn(() => void ensurePushNotificationSubscription());
onDataLoaded(ctx => {
  if (!ctx.full) return;
  refreshPushPermission();
  void ensurePushNotificationSubscription();
});
onBeforeSignOut(() => unsubscribeDevicePush());
