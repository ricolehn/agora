// The settings: a menu with sub-pages (like the Android app); the registration code stays on top of the menu.
// One settings tab for everyone: a page is offered when its parts are available to the person. Two pages belong to
// other features and come from the registry (fees: finances, calendar: events) - until a feature registered its page,
// the page is not offered.
import { createSignal } from 'solid-js';
import { t } from '../../app/i18n';
import { settingsPages } from '../../app/registry';
import { leaveHistoryLevels, pushHistoryLevel } from '../../app/router';
import { canViewFinances, currentUser, isSuperAdminUser } from '../../app/session';
import { scrollPageToTop } from '../../app/shell';
import { fullName } from '../../app/util';
import type { IconName } from '../../ui/Icon';
import { notificationSummary } from './notifications';
import { flushNow } from '../../app/flush';

/** The person as the profile row and page show them: the name, or the e-mail address without one. */
export const profileName = () => fullName(currentUser()) || currentUser()?.email || '';

export type SettingsPageKey = 'profile' | 'notifications' | 'appearance' | 'password' | 'calendar' | 'fees' | 'account';

export interface SettingsPageDef {
  key: SettingsPageKey;
  /** The page's title, also the title of its row in the menu (the profile row shows the person instead). */
  title: () => string;
  /** The second line of the row. */
  desc?: () => string;
  icon?: IconName;
  /** The colour of the row's symbol and its tint. */
  color?: string;
  /** A page of another feature (registerSettingsPage): offered once that feature registered it. */
  feature?: boolean;
  /** Who is offered the page (everyone when left out). */
  allowed?: () => boolean;
}

const SETTINGS_PAGES: SettingsPageDef[] = [
  { key: 'profile', title: () => t('settings_profile', 'Profile') },
  { key: 'notifications', icon: 'bell', color: '#f59e0b', title: () => t('notif_channels_title', 'Notifications'), desc: notificationSummary },
  {
    key: 'appearance', icon: 'palette', color: '#8b5cf6',
    title: () => t('settings_appearance', 'Appearance & language'), desc: () => t('settings_appearance_desc', 'Theme and language')
  },
  { key: 'password', icon: 'lock', color: '#64748b', title: () => t('change_password_title', 'Change password'), desc: () => t('settings_password_desc', 'Set a new password') },
  {
    key: 'calendar', icon: 'calendar', color: '#0891b2', feature: true,
    title: () => t('calendar_sub_title', 'Calendar subscription'), desc: () => t('settings_calendar_desc', 'Your appointments in your own calendar')
  },
  // The fees only with the finance permission (or for those who run the instance): a /settings/fees link must not
  // show them to anyone else
  {
    key: 'fees', icon: 'coin', color: '#10b981', feature: true, allowed: () => canViewFinances() || isSuperAdminUser(),
    title: () => t('rates_title', 'Monthly Fees'), desc: () => t('settings_fees_desc', 'Monthly fees per status')
  },
  {
    key: 'account', icon: 'shield', color: '#0ea5e9',
    title: () => t('settings_account_title', 'Account & privacy'), desc: () => t('settings_account_desc', 'Privacy, delete account')
  }
];

const findPage = (key: string | null | undefined) => SETTINGS_PAGES.find(page => page.key === key);

/** Whether [key] names a page this person is offered (reactive: follows the account's permissions). */
export function isPageAvailable(key: string | null | undefined): key is SettingsPageKey {
  const page = findPage(key);
  return !!page && (!page.feature || settingsPages.has(page.key)) && (page.allowed?.() ?? true);
}

/** The pages of the menu, in their order. */
export const availablePages = () => SETTINGS_PAGES.filter(page => isPageAvailable(page.key));

// The open page; null: the menu
const [openPage, setOpenPage] = createSignal<SettingsPageKey | null>(null);
export { openPage };
export const openPageDef = () => findPage(openPage());

/** The id of the open page's title (it takes the focus when a page opens). */
export const PAGE_TITLE_ID = 'settings-page-title';
/** The id of the menu's list of rows (a closed page gives the focus back to its row). */
export const MENU_ID = 'settings-menu';

/** Opens a page. fromRoute: opened by the address (no history level of its own). */
export function openSettingsPage(key: SettingsPageKey, { fromRoute = false } = {}) {
  // From the menu to a page: a level of its own (moving between pages beside the menu is not one)
  if (!fromRoute && !openPage()) pushHistoryLevel('page');
  setOpenPage(key);
  flushNow();
  scrollPageToTop();
  // The row that had the focus is gone now: keyboard and screen reader users continue at the page title
  document.getElementById(PAGE_TITLE_ID)?.focus({ preventScroll: true });
}

/** Back to the menu. fromHistory: the back gesture already left the page's history level. */
export function closeSettingsPage(fromHistory = false) {
  if (!fromHistory) leaveHistoryLevels('page');
  const left = openPage();
  setOpenPage(null);
  flushNow();
  scrollPageToTop();
  document.getElementById(MENU_ID)?.querySelector<HTMLElement>(`[data-key="${left}"]`)?.focus({ preventScroll: true });
}

/** Entering the tab: the menu (a page left open before is closed without a step in the history). */
export function showSettingsMenu() {
  setOpenPage(null);
  flushNow();
}
