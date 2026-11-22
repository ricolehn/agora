// Prayer requests (Extras): a calm list; a request is shared (also anonymously) and removed when it is done. The
// server never tells who shared an anonymous request (backend/prayers.js).
import { createSignal } from 'solid-js';
import { apiJson } from '../../app/api';
import { t, uiLocale } from '../../app/i18n';
import { showToast } from '../../app/toast';
import { flushNow } from '../../app/flush';

export type Prayer = {
  id: string;
  text: string;
  anonymous: boolean;
  author: { uid: string; name?: string } | null;
  createdAt: number;
  expiresAt: number;
  expired: boolean;
  isMine: boolean;
  canDelete: boolean;
};
export type PrayerFilter = 'all' | 'mine';
export type PrayerDuration = 'week' | 'month' | 'quarter';

const [prayers, setPrayers] = createSignal<Prayer[]>([]);
const [prayersLoaded, setPrayersLoaded] = createSignal(false);
// A first load that failed: its message with "Try again" (a later failed refresh keeps the list and says so)
const [prayersError, setPrayersError] = createSignal('');
const [prayerFilter, setPrayerFilter] = createSignal<PrayerFilter>('all');
export { prayers, prayersLoaded, prayersError, prayerFilter, setPrayerFilter };

export async function loadPrayers(): Promise<void> {
  try {
    const data = await apiJson<{ prayers?: Prayer[] }>('/prayers', 'GET', undefined, t('prayers_load_failed', 'Prayer requests could not be loaded'));
    setPrayers(Array.isArray(data.prayers) ? data.prayers : []);
    setPrayersLoaded(true);
    setPrayersError('');
  } catch (err: any) {
    if (!prayersLoaded()) setPrayersError(err.message);
    else showToast(err.message, 'error');
  }
  flushNow();
}

export function replacePrayer(updated: Prayer) {
  setPrayers(list => list.map(p => (p.id === updated.id ? updated : p)));
  flushNow();
}
export function removePrayer(id: string) {
  setPrayers(list => list.filter(p => p.id !== id));
  flushNow();
}

// --- Labels ---
export const prayerDate = (ms: number) => new Date(ms).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' });

/** "2 hours ago", "yesterday"; older than a week as a date. */
export function timeAgo(ms: number): string {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  if (abs > 7 * 86400000) return prayerDate(ms);
  const format = new Intl.RelativeTimeFormat(uiLocale(), { numeric: 'auto' });
  if (abs >= 86400000) return format.format(Math.round(diff / 86400000), 'day');
  if (abs >= 3600000) return format.format(Math.round(diff / 3600000), 'hour');
  return format.format(Math.min(0, Math.round(diff / 60000)), 'minute');
}

export const prayerName = (p: Prayer) =>
  p.author ? p.author.name || t('events_member_fallback', 'Member') : t('prayers_anonymous_name', 'Anonymous');
