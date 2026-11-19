// How the features plug into the app shell. Each feature's index.ts registers its parts when it is imported
// (features/index.ts imports all of them before the app renders): its tab, its dialogs, what it adds to the start
// page and the settings, its floating action button, its live-update loader and its part of the page address.
import type { Component } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { TabId } from './tabs';

// --- Tabs ---
export interface TabRegistration {
  id: TabId;
  component: Component;
}
export const tabs = new Map<TabId, TabRegistration>();
/** The page shown for a tab. It is mounted the first time the tab opens and stays mounted (its state survives). */
export function registerTab(id: TabId, component: Component) {
  tabs.set(id, { id, component });
}

// --- Components that live at the root of the app (dialogs, viewers, overlays) ---
export const rootComponents: Component[] = [];
/** Dialogs and overlays of a feature: always mounted at the root (a dialog can open from any tab). */
export function registerRoot(component: Component) {
  rootComponents.push(component);
}

// --- Start page ---
export interface HomeCard {
  order: number;
  component: Component;
}
export const homeCards: HomeCard[] = [];
/**
 * A part of the start page, in this order: 0 greeting, 10 overdue payment state, 20 duty requests, 30 open finance
 * requests, 40 coming up (events row), 50 own duties, 60 unread messages, 90 payment state (when not overdue).
 * A card that has nothing to show renders nothing.
 */
export function registerHomeCard(order: number, component: Component) {
  homeCards.push({ order, component });
  homeCards.sort((a, b) => a.order - b.order);
}

// --- Settings pages that belong to a feature (fees: finance, calendar: events) ---
export const settingsPages = new Map<string, Component>();
export function registerSettingsPage(key: string, component: Component) {
  settingsPages.set(key, component);
}

// --- Floating action button ---
export interface FabItem {
  icon: () => JSX.Element;
  /** Tint of the round symbol (background, colour); the brand tint when left out. */
  tint?: { background: string; color: string };
  title: () => string;
  subtitle: () => string;
  onClick: () => void;
}
export interface FabRegistration {
  /** Whether the button shows on its tab (permissions, state). */
  visible: () => boolean;
  /** One action: a tap runs it directly (no menu). */
  action?: () => void;
  /** Several actions: a tap opens the menu with them. */
  items?: () => FabItem[];
}
export const fabs = new Map<TabId, FabRegistration>();
export function registerFab(tab: TabId, fab: FabRegistration) {
  fabs.set(tab, fab);
}
