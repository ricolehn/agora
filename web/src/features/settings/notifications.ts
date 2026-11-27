// Notification preferences. The channels (push, e-mail) are master switches; per channel the person picks which kinds
// of messages arrive. Default: push with everything, e-mail off. Same model as backend/notificationPrefs.js.
import { createSignal } from 'solid-js';
import { db, ref, update } from '../../app/api';
import { t } from '../../app/i18n';
import { canManageFinances, currentUser, patchCurrentUser, type User } from '../../app/session';
import { attempt, showToast } from '../../app/toast';
import type { IconName } from '../../ui/Icon';

const NOTIFICATION_TYPES = ['duties', 'events', 'messages', 'requests', 'finances', 'reports'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationChannel = 'push' | 'email';
type Choices = Record<NotificationType, boolean>;
export interface NotificationSettings {
  channels: Record<NotificationChannel, boolean>;
  push: Choices;
  email: Choices;
}

export const NOTIFICATION_KINDS: Record<NotificationType, { icon: IconName; color: string; title: () => string; desc: () => string }> = {
  duties: {
    icon: 'clipboard', color: '#6366f1', title: () => t('notif_duties_title', 'Duty requests'),
    desc: () => t('notif_duties_desc', 'Duty requests, answers to them, duties of your groups and a reminder 3 hours before your duty')
  },
  events: {
    icon: 'calendar', color: '#0891b2', title: () => t('notif_events_title', 'New events & appointments'),
    desc: () => t('notif_events_desc', 'New events and appointments of the community')
  },
  messages: {
    icon: 'chat', color: '#7c3aed', title: () => t('notif_messages_title', 'Messages'),
    desc: () => t('notif_messages_desc', 'Support requests and mentoring messages')
  },
  requests: {
    icon: 'fileText', color: '#10b981', title: () => t('notif_requests_title', 'My requests'),
    desc: () => t('notif_requests_desc', 'When your payment, expense or status change was approved or rejected')
  },
  finances: {
    icon: 'dollar', color: '#d97706', title: () => t('notif_finances_title', 'Requests to the treasury'),
    desc: () => t('notif_finances_desc', 'New payment, expense and status requests from members')
  },
  reports: {
    icon: 'flag', color: '#ef4444', title: () => t('notif_reports_title', 'Reported content'),
    desc: () => t('notif_reports_desc', 'Reported chat messages and AI answers')
  }
};

/** The stored preferences of [user] with the defaults filled in (also for records saved by older versions). */
export function readNotificationSettings(user: User | null = currentUser()): NotificationSettings {
  const stored = user?.notificationSettings && typeof user.notificationSettings === 'object' ? user.notificationSettings : null;
  // Old records: no settings at all and emailNotifications === false meant "nothing at all"
  const legacyAllOff = !stored && user?.emailNotifications === false;
  const pick = (source: Partial<Record<NotificationType, boolean>> | undefined, fallback: Partial<Record<NotificationType, boolean>> = {}) =>
    Object.fromEntries(
      NOTIFICATION_TYPES.map(type => [type, typeof source?.[type] === 'boolean' ? source[type] : typeof fallback[type] === 'boolean' ? fallback[type] : true])
    ) as Choices;
  return {
    channels: {
      push: typeof stored?.channels?.push === 'boolean' ? stored.channels.push : !legacyAllOff,
      email: typeof stored?.channels?.email === 'boolean' ? stored.channels.email : false
    },
    push: pick(stored?.push, stored || {}),
    email: pick(stored?.email)
  };
}

/** Kinds this person can get at all: requests to the treasury only for those who decide on them, reports only for admins. */
export function availableNotificationTypes(): NotificationType[] {
  const user = currentUser();
  const isAdmin = user?.admin === true || user?.owner === true || user?.superAdmin === true;
  return NOTIFICATION_TYPES.filter(type => (type !== 'finances' || isAdmin || canManageFinances()) && (type !== 'reports' || isAdmin));
}

/** The channels in a few words (the second line of the menu row). */
export function notificationSummary(): string {
  const { push, email } = readNotificationSettings().channels;
  if (push && email) return t('notif_summary_both', 'Push and e-mail');
  if (push) return t('notif_summary_push', 'Push only');
  return email ? t('notif_summary_email', 'E-mail only') : t('notif_summary_off', 'Off');
}

// The channel whose kinds are shown while both channels are on (the tabs)
const [chosenChannel, setChosenChannel] = createSignal<NotificationChannel>('push');
export const setNotificationTab = (channel: NotificationChannel) => setChosenChannel(channel);
/** The channel whose kinds are shown: without e-mail only the push choices, without push only the e-mail ones. */
export function shownChannel(): NotificationChannel {
  const { push, email } = readNotificationSettings().channels;
  if (!email) return 'push';
  return push ? chosenChannel() : 'email';
}

// Shown at once; the previous state comes back when saving fails
async function saveNotificationSettings(settings: NotificationSettings) {
  const user = currentUser();
  if (!user?.uid) return;
  // The flat keys mirror the push choice: older app versions read and write only those
  const notificationSettings = { channels: settings.channels, push: settings.push, email: settings.email, ...settings.push };
  const emailNotifications = settings.channels.push || settings.channels.email;
  const previous = { notificationSettings: user.notificationSettings, emailNotifications: user.emailNotifications };
  patchCurrentUser({ notificationSettings, emailNotifications });
  const saved = await attempt(async () => {
    await update(ref(db, 'users/' + user.uid), { notificationSettings, emailNotifications });
    showToast(t('notification_settings_saved', 'Notification settings saved'));
  }, t('alert_settings_save_failed', 'Settings could not be saved.'));
  if (!saved) patchCurrentUser(previous);
}

export function setNotificationChannel(channel: NotificationChannel, on: boolean) {
  const settings = readNotificationSettings();
  settings.channels[channel] = on;
  // A channel just turned on shows its kinds
  if (on) setChosenChannel(channel);
  void saveNotificationSettings(settings);
}

export function setNotificationKind(channel: NotificationChannel, type: NotificationType, on: boolean) {
  const settings = readNotificationSettings();
  settings[channel][type] = on;
  void saveNotificationSettings(settings);
}
