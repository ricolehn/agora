// Sharing an event: the share button opens the link to copy or to hand to the system share sheet. Whoever may edit
// the event decides with a switch whether people without an account can open it: they see the event and sign up as
// guests (full name, e-mail address, age). The link then carries the event's share key (?share=).
import { createMemo, createSignal } from 'solid-js';
import { apiJson } from '../../../app/api';
import { flushNow } from '../../../app/flush';
import { t } from '../../../app/i18n';
import { openModal } from '../../../app/modals';
import { showToast } from '../../../app/toast';
import { copyText } from '../../../app/util';
import { guestShareUrl, guestView } from '../guest/guest';
import { appEvents, currentDetailEvent, eventSlug, type AppEvent } from '../store';

export const SHARE_MODAL = 'event-share-modal';

interface ShareTarget {
  ev: AppEvent;
  url: string;
  isPublic: boolean;
  canEdit: boolean;
}

/** The link of an event: the members' address, with the share key while people without an account may open it. */
function eventShareUrl(ev: AppEvent) {
  const base = `${window.location.origin}/events/${encodeURIComponent(eventSlug(ev))}`;
  return ev.isPublic && ev.publicToken ? `${base}?share=${encodeURIComponent(ev.publicToken)}` : base;
}

// What the sheet offers: an event a member has open (by id), or the shared event a guest is looking at
const [source, setSource] = createSignal<{ eventId: string; fallback: AppEvent | null } | 'guest' | null>(null);
// The switch's answer, while the loaded events still have the state from before it (the next load brings the new one)
type PublicState = { isPublic: boolean; publicToken: string };
const [switched, setSwitched] = createSignal<{ eventId: string; before: PublicState; now: PublicState } | null>(null);
const [switching, setSwitching] = createSignal(false);
export { switching };

const publicState = (ev: AppEvent): PublicState => ({ isPublic: ev.isPublic === true, publicToken: ev.publicToken || '' });
const sameState = (a: PublicState, b: PublicState) => a.isPublic === b.isPublic && a.publicToken === b.publicToken;

export const shareTarget = createMemo((): ShareTarget | null => {
  const from = source();
  if (from === 'guest') {
    const view = guestView();
    return view?.event && view.token ? { ev: view.event, url: guestShareUrl(view.event, view.token), isPublic: true, canEdit: false } : null;
  }
  if (!from) return null;
  const found = appEvents().find(e => e.id === from.eventId) ?? from.fallback;
  if (!found) return null;
  const change = switched();
  const ev = change && change.eventId === found.id && sameState(publicState(found), change.before) ? { ...found, ...change.now } : found;
  return { ev, url: eventShareUrl(ev), isPublic: ev.isPublic === true, canEdit: ev.canEdit === true };
}, { lazy: true });

function openShareSheet() {
  flushNow();
  if (shareTarget()) openModal(SHARE_MODAL);
}

/** Opens the sheet for an event a member sees. */
export function openEventShare(eventId: string) {
  const open = currentDetailEvent();
  setSource({ eventId, fallback: open?.id === eventId ? open : null });
  openShareSheet();
}

/** Opens the sheet for the shared event on the visitors' page. */
export function openGuestShare() {
  setSource('guest');
  openShareSheet();
}

// The switch (only for those who may edit the event; the server checks it again). Off and on again keeps the link.
export async function toggleEventPublic(isPublic: boolean) {
  const target = shareTarget();
  if (!target?.canEdit || switching()) return;
  setSwitching(true);
  try {
    const data = await apiJson(`/events/${encodeURIComponent(target.ev.id)}`, 'PATCH', { isPublic }, t('events_share_switch_failed', 'The setting could not be saved.'));
    const nowPublic = data.event?.isPublic === true;
    const found = appEvents().find(e => e.id === target.ev.id);
    setSwitched({ eventId: target.ev.id, before: publicState(found ?? target.ev), now: { isPublic: nowPublic, publicToken: nowPublic ? data.event?.publicToken || '' : '' } });
  } catch (err: any) {
    showToast(err.message, 'error');
  } finally {
    setSwitching(false);
  }
}

// The clipboard API needs https: installations on plain http copy the selected field instead
export async function copyEventShareLink(field: HTMLInputElement | undefined) {
  const url = shareTarget()?.url;
  if (!url) return;
  if (await copyText(url, field)) showToast(t('events_share_copied', 'Link copied'));
  else showToast(t('events_share_copy_failed', 'The link could not be copied. It is selected, copy it by hand.'), 'error');
}

export const canShareNatively = (url: string) =>
  typeof navigator.share === 'function' && (typeof navigator.canShare !== 'function' || navigator.canShare({ url }));

export async function sendEventShareLink() {
  const target = shareTarget();
  if (!target) return;
  try {
    await navigator.share({ title: target.ev.title, url: target.url });
  } catch (err: any) {
    if (err?.name !== 'AbortError') showToast(t('events_share_failed', 'The link could not be shared.'), 'error');
  }
}
