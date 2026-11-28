// Prayer requests (Extras): a calm list; a request is shared (also anonymously) and removed when it is done. The
// server never tells who shared an anonymous request (backend/prayers.js).
import { action, createOptimistic, createRoot, createSignal, refresh } from 'solid-js';
import { apiJson } from '../../app/api';
import { shortDayText, t, uiLocale } from '../../app/i18n';
import { createServerData } from '../../app/serverData';

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

// The requests as the server has them: loaded when the tab first shows them, again on every visit, live update and
// change (app/serverData.ts)
const serverPrayers = createServerData(() =>
  apiJson<{ prayers?: Prayer[] }>('/prayers', 'GET', undefined, t('prayers_load_failed', 'Prayer requests could not be loaded')).then(data =>
    Array.isArray(data.prayers) ? data.prayers : []
  )
);
/** Loads the requests again (the list keeps showing the last ones meanwhile). */
export const refreshPrayers = () => refresh(serverPrayers);

// What the page shows: the server's requests, a removal already applied while the server is asked
const [prayers, setShownPrayers] = createRoot(() => createOptimistic<Prayer[]>(() => serverPrayers(), { lazy: true }));
export { prayers };

const [prayerFilter, setPrayerFilter] = createSignal<PrayerFilter>('all');
export { prayerFilter, setPrayerFilter };

/** True while a new request is on its way (its button waits); back to false by itself when the sharing ends. */
const [sharing, setSharing] = createOptimistic(false);
export { sharing };

/** Shares a request; it is in the list when this resolves. */
export const sharePrayer = action(function* (request: { text: string; anonymous: boolean; duration: PrayerDuration }) {
  setSharing(true);
  yield apiJson('/prayers', 'POST', request, t('prayers_share_failed', 'The prayer request could not be shared'));
  yield refreshPrayers();
});

/** Done (own request) or removed by a moderator: gone from the list at once, back when the server refuses. */
export const removePrayer = action(function* (id: string) {
  setShownPrayers(list => list.filter(p => p.id !== id));
  yield apiJson(`/prayers/${encodeURIComponent(id)}`, 'DELETE', undefined, t('prayers_delete_failed', 'The prayer request could not be deleted'));
  // The list as it is now ends the removal: it never shows the request again in between
  yield refreshPrayers();
});

// --- Labels ---
export const prayerDate = (ms: number) => shortDayText(new Date(ms));

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
