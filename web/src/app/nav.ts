// The main navigation (desktop header and bottom bar): which entries a person sees, and their count badges.
import { createSignal } from 'solid-js';
import { t } from './i18n';
import { canUseMentoring, canViewFinances, currentUser } from './session';
import type { TabId } from './tabs';
import type { IconName } from '../ui/icons';

export interface NavEntry {
  tab: TabId;
  icon: IconName;
  /** Label in the desktop header and in the bottom bar. */
  label: () => string;
  bottomLabel: () => string;
  visible: () => boolean;
  /** Count shown on the entry (unread messages). */
  badge?: () => number;
}

// Counts on nav entries, set by the features (mentoring: unread conversations)
const [navBadges, setNavBadges] = createSignal<Partial<Record<TabId, number>>>({});
export { navBadges };
export function setNavBadge(tab: TabId, count: number) {
  setNavBadges(prev => ({ ...prev, [tab]: count }));
}

export const NAV_ENTRIES: NavEntry[] = [
  { tab: 'user-overview', icon: 'home', label: () => t('nav_home', 'Home'), bottomLabel: () => t('nav_start', 'Home'), visible: () => true },
  { tab: 'finances', icon: 'dollar', label: () => t('nav_finances', 'Finances'), bottomLabel: () => t('nav_finances', 'Finances'), visible: () => canViewFinances() },
  { tab: 'user-finances', icon: 'dollar', label: () => t('nav_finances', 'Finances'), bottomLabel: () => t('nav_finances', 'Finances'), visible: () => !canViewFinances() },
  { tab: 'events', icon: 'calendar', label: () => t('nav_events', 'Events'), bottomLabel: () => t('nav_events', 'Events'), visible: () => !!currentUser() },
  {
    tab: 'mentoring', icon: 'users', label: () => t('nav_mentoring', 'Mentoring'), bottomLabel: () => t('nav_mentoring', 'Mentoring'),
    visible: () => canUseMentoring(), badge: () => navBadges().mentoring || 0
  },
  { tab: 'hub', icon: 'grid', label: () => t('nav_hub', 'Extras'), bottomLabel: () => t('nav_hub', 'Extras'), visible: () => true }
];
