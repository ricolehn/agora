// The tabs (pages) of the app. The ids are the ones the previous version used (old #links and notifications still
// name some of them); 'settings' is one tab for everyone (members see the pages they may use).
export type TabId =
  | 'user-overview'
  | 'finances'
  | 'user-finances'
  | 'events'
  | 'mentoring'
  | 'hub'
  | 'songbook'
  | 'prayers'
  | 'media'
  | 'ai-chat'
  | 'polls'
  | 'settings'
  | 'super-admin-settings';

export const HOME_TAB: TabId = 'user-overview';
/** Apps inside "Extras": their nav entry stays highlighted, back goes to Extras. */
export const HUB_TABS: TabId[] = ['ai-chat', 'polls', 'songbook', 'prayers', 'media'];

/** First part of the page address of each tab. */
export const TAB_PATHS: Record<TabId, string> = {
  'user-overview': '',
  finances: 'finances',
  'user-finances': 'finances',
  events: 'events',
  mentoring: 'mentoring',
  hub: 'extras',
  songbook: 'songbook',
  prayers: 'prayers',
  media: 'media',
  'ai-chat': 'ai',
  polls: 'polls',
  settings: 'settings',
  'super-admin-settings': 'system'
};

/** Order of the main navigation (a tab further left slides in from the left). */
export const NAV_ORDER: TabId[] = ['user-overview', 'finances', 'user-finances', 'events', 'mentoring', 'hub'];
