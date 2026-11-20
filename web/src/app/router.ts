// Tabs, page addresses and the back gesture.
//
// Every page has its own path (/events, /events/Jugendfreizeit_2026, /settings/profile, ...). The history keeps its
// shape like the Android app: the start page, one entry for "somewhere else", one entry per level the member went
// down to by tapping (an app from Extras, a folder, a settings page) and the open dialogs. The address of the current
// entry follows what is on screen. Old #links (notifications, the apps, bookmarks) still lead there.
//
// Features plug in through the hooks below: what happens when their tab opens, their part of the address, how a
// deeper address opens (an event, a song, a chat), and what "back" means inside them.
import { createSignal } from 'solid-js';
import { FEATURES } from './config';
import { consumeProgrammaticBack, programmaticBack } from './history';
import { closeModal, onModalChange, topModal } from './modals';
import {
  aiEnabled, canAccessAi, canUseMentoring, canViewFinances, isAuthenticated, isSuperAdminUser
} from './session';
import { HOME_TAB, HUB_TABS, NAV_ORDER, TAB_PATHS, type TabId } from './tabs';
import { getTodayStr, slugify } from './util';
import { flushNow } from './flush';

export { HOME_TAB, HUB_TABS, type TabId };

const [activeTab, setActiveTabSignal] = createSignal<TabId>(HOME_TAB);
// The direction the page slides in from (a tab left of the current one comes from the left)
const [tabSlide, setTabSlide] = createSignal<'left' | 'right'>('right');
// Counts every switch (the page's entrance animation restarts)
const [tabSwitchCount, setTabSwitchCount] = createSignal(0);
export { activeTab, tabSlide, tabSwitchCount };

// --- Hooks for the features ---
type Hook = () => void;
const enterHooks = new Map<TabId, Hook[]>();
const leaveHooks = new Map<TabId, Hook[]>();
const subPaths = new Map<TabId, () => string>();
const routeHandlers = new Map<TabId, RouteHandler>();
const routeOverrides: Array<() => string | null> = [];
const backFirst: Array<() => boolean> = [];
const levelBack: Array<() => boolean> = [];

/** Runs every time [tab] is opened (load its data, reset a sub-page). */
export function onTabEnter(tab: TabId, fn: Hook) {
  enterHooks.set(tab, [...(enterHooks.get(tab) || []), fn]);
}
/** Runs when another tab replaces [tab]. */
export function onTabLeave(tab: TabId, fn: Hook) {
  leaveHooks.set(tab, [...(leaveHooks.get(tab) || []), fn]);
}
/** The part of the address after the tab's own (/finances/members, /settings/profile); '' for none. */
export function registerSubPath(tab: TabId, fn: () => string) {
  subPaths.set(tab, fn);
}
export interface RouteHandler {
  /** Before the tab opens: the address parts after the tab's own (a folder to open, a song to show later). */
  before?: (rest: string[]) => void;
  /** After the tab opened: opens what the parts name (a sub-page, an event, a chat). */
  after?: (rest: string[]) => void | Promise<void>;
}
/** How an address below the tab opens (/events/<slug>, /mentoring/chat/<id>, /media/<folder>, ...). */
export function registerRouteHandler(tab: TabId, handler: RouteHandler) {
  routeHandlers.set(tab, handler);
}
/** An address that wins over the tab's own while something is on screen (an open event or song): a path or null. */
export function registerRouteOverride(fn: () => string | null) {
  routeOverrides.push(fn);
}
/** A back gesture handled before the dialogs (the open mobile chat): return true when handled. */
export function registerBackFirst(fn: () => boolean) {
  backFirst.push(fn);
}
/** One level up inside a tab (settings page → menu, folder → folder above): return true when handled. */
export function registerLevelBack(fn: () => boolean) {
  levelBack.push(fn);
}

// --- Which tab a request lands on ---
const TAB_ALIASES: Record<string, TabId> = {
  overview: 'finances', 'payment-history': 'finances', 'people-view': 'finances',
  'user-history': 'user-finances', 'user-requests': 'user-finances', calendar: 'events', 'user-settings': 'settings'
};
const TAB_GUARDS: Partial<Record<TabId, () => boolean>> = {
  finances: () => canViewFinances(),
  'user-finances': () => !canViewFinances(),
  'super-admin-settings': () => isSuperAdminUser(),
  'ai-chat': () => canAccessAi() && aiEnabled(),
  mentoring: () => canUseMentoring()
};

/** The finance sub-page the old ids name ('overview', 'payment-history' → history, 'people-view' → members). */
const [financeSubpageRequest, setFinanceSubpageRequest] = createSignal<{ page: 'members' | 'history'; seq: number } | null>(null);
export { financeSubpageRequest };
let financeRequestSeq = 0;

// --- History levels ---
let tabHistoryPushed = false;
// One entry above the "not home" entry per level the member went down to by tapping: 'app' (from Extras),
// 'folder' (in the media library), 'page' (a settings page)
const historyLevels: string[] = [];

/** Called on a tap that goes one level down: the entry is made while the tap counts as the member's own. */
export function pushHistoryLevel(kind: 'app' | 'folder' | 'page') {
  if (!tabHistoryPushed) return;
  history.pushState({ tab: activeTab(), level: kind }, '');
  historyLevels.push(kind);
}

/** Going up in the app itself (its back button, the folder path): up to [max] entries of [kind] are left behind. */
export function leaveHistoryLevels(kind: 'app' | 'folder' | 'page', max = 1) {
  let steps = 0;
  while (steps < max && historyLevels[historyLevels.length - 1] === kind) {
    historyLevels.pop();
    steps++;
  }
  if (steps) programmaticBack(steps);
}

function syncTabHistory(tabName: TabId, previousTab: TabId) {
  // Another tab: the levels of this one are left behind
  const levels = tabName !== previousTab ? historyLevels.splice(0).length : 0;
  if (tabName === HOME_TAB) {
    if (tabHistoryPushed && history.state?.tab) {
      tabHistoryPushed = false;
      programmaticBack(levels + 1);
    } else if (levels) {
      programmaticBack(levels);
    }
    return;
  }
  if (levels) programmaticBack(levels);
  // One history entry for "somewhere other than home"; moving between tabs only replaces it
  if (tabHistoryPushed && history.state?.tab) history.replaceState({ tab: tabName }, '');
  else {
    history.pushState({ tab: tabName }, '');
    tabHistoryPushed = true;
  }
}

/**
 * Opens a tab. source 'history': called from a back navigation (no new history entry).
 * Old ids are understood ('overview', 'people-view', 'user-settings', ...); a tab without the right falls back
 * (the AI chat to Extras, everything else to the start page).
 */
export function switchTab(requested: TabId | string, source?: 'history' | 'nav') {
  let tabName = requested as string;
  // A switched-off app (old link, remembered tab) opens the hub instead
  if (tabName === 'polls' && !FEATURES.polls) tabName = 'hub';
  if (tabName === 'overview' || tabName === 'payment-history') setFinanceSubpageRequest({ page: 'history', seq: ++financeRequestSeq });
  else if (tabName === 'people-view') setFinanceSubpageRequest({ page: 'members', seq: ++financeRequestSeq });
  let tab = (TAB_ALIASES[tabName] || tabName) as TabId;
  if (tab === 'finances' && !canViewFinances()) tab = 'user-finances';
  if (tab === 'user-finances' && canViewFinances()) tab = 'finances';
  if (!(tab in TAB_PATHS)) tab = HOME_TAB;
  const guard = TAB_GUARDS[tab];
  if (guard && !guard()) tab = tab === 'ai-chat' ? 'hub' : HOME_TAB;

  const previousTab = activeTab();
  if (tab !== previousTab) for (const fn of leaveHooks.get(previousTab) || []) fn();
  const currentIndex = NAV_ORDER.indexOf(HUB_TABS.includes(previousTab) ? 'hub' : previousTab);
  const targetIndex = NAV_ORDER.indexOf(HUB_TABS.includes(tab) ? 'hub' : tab);
  setTabSlide(currentIndex > -1 && targetIndex > -1 && targetIndex < currentIndex ? 'left' : 'right');
  setActiveTabSignal(tab);
  setTabSwitchCount(n => n + 1);
  flushNow();
  revealHeaderHook?.();
  if (source !== 'history' && isAuthenticated()) syncTabHistory(tab, previousTab);
  for (const fn of enterHooks.get(tab) || []) fn();
  syncUrl();
}

// The shell shows the header again when the page changes
let revealHeaderHook: (() => void) | null = null;
export function setRevealHeaderHook(fn: () => void) {
  revealHeaderHook = fn;
}

// --- Readable names in addresses ---
const titleSlug = (item: { title?: string; id: string }) => slugify(item.title) || item.id;

/** A readable name for an item of a list: its title; when titles repeat, the date (events) or the id tells them apart. */
export function itemSlug<T extends { title?: string; id: string }>(item: T, list: T[], date?: (item: T) => string | undefined): string {
  const base = titleSlug(item);
  const twins = list.filter(other => titleSlug(other) === base);
  if (twins.length <= 1) return base;
  const day = date?.(item);
  if (day && twins.filter(other => date!(other) === day).length === 1) return `${base}_${day}`;
  return `${base}~${item.id}`;
}

export function findBySlug<T extends { title?: string; id: string }>(list: T[], slug: string, date?: (item: T) => string | undefined): T | null {
  if (!slug) return null;
  const exact = list.find(item => itemSlug(item, list, date) === slug);
  if (exact) return exact;
  const id = slug.includes('~') ? slug.split('~').pop() : slug;
  const byId = list.find(item => item.id === id);
  if (byId) return byId;
  // An older link whose title got a twin since: the one of that day, else the next upcoming (or the latest)
  const dated = date ? /^(.*)_(\d{4}-\d{2}-\d{2})$/.exec(slug) : null;
  const twins = list.filter(item => titleSlug(item) === (dated ? dated[1] : slug));
  if (dated) return twins.find(item => date!(item) === dated[2]) || null;
  if (!date || twins.length < 2) return twins[0] || null;
  const sorted = [...twins].sort((a, b) => String(date(a)).localeCompare(String(date(b))));
  return sorted.find(item => String(date(item)) >= getTodayStr()) || sorted[sorted.length - 1];
}

// --- Addresses ---
// First part of a path → tab (old tab ids keep working)
const ROUTE_TABS: Record<string, () => TabId> = {
  '': () => HOME_TAB, 'index.html': () => HOME_TAB, home: () => HOME_TAB, 'user-overview': () => HOME_TAB,
  finances: () => (canViewFinances() ? 'finances' : 'user-finances'),
  events: () => 'events', mentoring: () => 'mentoring', extras: () => 'hub', songbook: () => 'songbook',
  ai: () => 'ai-chat', polls: () => 'polls', prayers: () => 'prayers', media: () => 'media', system: () => 'super-admin-settings',
  settings: () => 'settings'
};
// Old #links → paths
const LEGACY_HASHES: Record<string, string> = {
  'super-admin-settings': 'system', 'user-finances': 'finances', requests: 'finances', overview: 'finances', 'payment-history': 'finances',
  'user-history': 'finances', 'user-requests': 'finances', 'people-view': 'finances/members', calendar: 'events', 'ai-chat': 'ai',
  'user-settings': 'settings', hub: 'extras'
};

export function legacyHashPath(hash: string): string | null {
  const raw = String(hash || '').replace(/^#\/?/, '').split('?')[0].trim();
  if (!raw) return null;
  const [head, ...rest] = raw.split('/');
  return '/' + [head in LEGACY_HASHES ? LEGACY_HASHES[head] : head, ...rest].filter(Boolean).join('/');
}

/** The path of what is on screen. */
export function routePath(): string {
  for (const override of routeOverrides) {
    const path = override();
    if (path) return path;
  }
  const tab = activeTab();
  const sub = subPaths.get(tab)?.() || '';
  return '/' + [TAB_PATHS[tab] ?? '', sub].filter(Boolean).join('/');
}

// Until the first route after signing in is applied, the address still holds where the person wanted to go
let routeReady = false;
export const isRouteReady = () => routeReady;
export function resetRouting() {
  routeReady = false;
  tabHistoryPushed = false;
  historyLevels.length = 0;
}

export function syncUrl() {
  if (!isAuthenticated() || !routeReady) return;
  const path = routePath();
  if (window.location.pathname !== path || window.location.hash) history.replaceState(history.state, '', path + window.location.search);
}
// Opening and closing dialogs changes the address (an open event, a song); a plain callback, not a reactive scope
// eslint-disable-next-line solid/reactivity
onModalChange(syncUrl);

const decodePart = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

// Opened at /ai while the AI status is still on its way: the chat follows when it says the AI is on (data.ts)
let pendingAiRoute = false;
export function takePendingAiRoute() {
  const pending = pendingAiRoute;
  pendingAiRoute = false;
  return pending;
}

/** Shows the page of a path: tab, sub-page, event, song, chat. */
export async function applyRoute(path: string): Promise<void> {
  const [head = '', ...rest] = String(path || '/').split('/').filter(Boolean).map(decodePart);
  const known = ROUTE_TABS[head]?.();
  const tab: TabId = known || ((head in TAB_PATHS ? head : HOME_TAB) as TabId);
  const parts = known || head === tab ? rest : [];
  pendingAiRoute = tab === 'ai-chat' && canAccessAi() && !aiEnabled();
  const handler = routeHandlers.get(tab);
  handler?.before?.(parts);
  switchTab(tab);
  if (activeTab() === tab && parts.length) await handler?.after?.(parts);
  syncUrl();
}

/** Once after signing in: the page the address names (or an old #link), on top of the start page. */
export function applyInitialRoute(): Promise<void> {
  const target = legacyHashPath(window.location.hash) ?? window.location.pathname;
  // A reload keeps the history entry of a deeper page: it stays that entry instead of getting a second one
  if (history.state?.tab || history.state?.isModal || history.state?.view) {
    history.replaceState({ tab: 'restored' }, '');
    tabHistoryPushed = true;
  } else {
    history.replaceState(null, '', '/' + window.location.search);
  }
  routeReady = true;
  return applyRoute(target);
}

/** An old #link opened inside the running app: its entry gets the page's own address, then the app goes there. */
function followLegacyHash(): boolean {
  const path = legacyHashPath(window.location.hash);
  if (!path || !isAuthenticated() || !routeReady) return false;
  history.replaceState(history.state, '', window.location.pathname + window.location.search);
  void applyRoute(path);
  return true;
}
window.addEventListener('hashchange', followLegacyHash);

function handleHistoryBack() {
  if (consumeProgrammaticBack()) return;
  for (const handler of backFirst) if (handler()) return;
  const top = topModal();
  if (top) {
    closeModal(top, true);
    return;
  }
  const levelUp = () => {
    for (const handler of levelBack) if (handler()) return true;
    if (HUB_TABS.includes(activeTab())) {
      switchTab('hub', 'history');
      return true;
    }
    return false;
  };
  // A level the member went down to by tapping has its own entry: back only goes up, it adds nothing. (An entry
  // pushed here, without a tap, would make Chrome skip the one below it on the next back gesture - out of the app.)
  if (tabHistoryPushed && historyLevels.length) {
    historyLevels.pop();
    levelUp();
    return;
  }
  // Back from a tab entry without such levels (opened from an address): one level up first (settings page → menu,
  // an app → Extras), then the start page. Going up keeps the single "not home" history entry
  if (tabHistoryPushed && !history.state?.tab) {
    if (levelUp()) {
      history.pushState({ tab: activeTab() }, '');
      return;
    }
    tabHistoryPushed = false;
    if (activeTab() !== HOME_TAB) switchTab(HOME_TAB, 'history');
  }
}

window.addEventListener('popstate', () => {
  // A #link inside the running app (a notification, an old bookmark) also fires popstate: it is a destination
  if (followLegacyHash()) return;
  handleHistoryBack();
  syncUrl();
});
