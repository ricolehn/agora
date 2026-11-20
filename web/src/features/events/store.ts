// The events and the own duty requests, shared by the events tab, the event dialog, the plan, sharing and the start
// page (owner: the events port; extend it there). Loaded with the data, on the events tab and on a live update.
import { createSignal } from 'solid-js';
import { api } from '../../app/api';
import { loadSystemGroups, userInGroup } from '../../app/groups';
import { t } from '../../app/i18n';
import { whenPicturesReady } from '../../app/pictures';
import { itemSlug } from '../../app/router';
import { currentUid, currentUser } from '../../app/session';
import { getTodayStr } from '../../app/util';
import { flushNow } from '../../app/flush';

export type AppEvent = {
  id: string;
  title: string;
  date: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  eventType?: string;
  duties?: any[];
  canAccessDutyPlan?: boolean;
  myRegistration?: { status?: string } | null;
  publicToken?: string;
  [key: string]: any;
};

const [appEvents, setAppEvents] = createSignal<AppEvent[]>([]);
const [myDutyRequests, setMyDutyRequests] = createSignal<any[]>([]);
// Until the first answer: a spinner; after a failed first load an error with "Try again" (an empty list said
// "nothing coming up"); a later failed refresh keeps what is shown
const [eventsLoaded, setEventsLoaded] = createSignal(false);
const [eventsLoadError, setEventsLoadError] = createSignal('');
export { appEvents, myDutyRequests, eventsLoaded, eventsLoadError };

const afterLoad: Array<() => void> = [];
/** Runs after every load of the events (the open event dialog and the plan refresh themselves). */
export function onEventsLoaded(fn: () => void) {
  afterLoad.push(fn);
}

export async function loadEventsData(): Promise<void> {
  if (!currentUser()) return;
  try {
    // Groups rarely change: a live update of the events reuses them for a few minutes
    const [eventsRes, requestsRes] = await Promise.all([
      api('/events'),
      api('/events/my-requests').catch(() => null),
      loadSystemGroups(5 * 60 * 1000)
    ]);
    await whenPicturesReady();
    if (eventsRes.ok) {
      setAppEvents(await eventsRes.json());
      setEventsLoaded(true);
      setEventsLoadError('');
    } else if (!eventsLoaded()) {
      setEventsLoadError(t('events_load_failed', 'Events could not be loaded'));
    }
    setMyDutyRequests(requestsRes?.ok ? await requestsRes.json() : []);
    flushNow();
    for (const fn of afterLoad) fn();
  } catch (err) {
    console.warn('Failed to load events:', err);
    if (!eventsLoaded()) setEventsLoadError(t('error_connection', 'Connection error'));
    flushNow();
  }
}

export function isEventPast(ev: AppEvent, todayStr = getTodayStr()): boolean {
  const compareDate = ev.endDate?.trim() || ev.date?.trim() || '';
  return !!compareDate && compareDate < todayStr;
}

/** A duty is "mine" when it is assigned/confirmed to me or assigned to one of my groups. */
export const isMyDuty = (d: any) =>
  ((d.assignedUser === currentUid() || d.assignedUser === currentUser()?.id) && (d.status === 'confirmed' || d.status === 'assigned')) ||
  (d.status === 'assigned' && d.assignedGroup && userInGroup(currentUser(), d.assignedGroup));
export const hasDutyAssignee = (d: any) => Boolean(d.assignedUser || d.requestedUser || d.assignedGroup || d.assignedGroupName);

export const eventDay = (ev: AppEvent) => ev.date;
/** The event's part of its address (/events/<slug>). */
export const eventSlug = (ev: AppEvent) => itemSlug(ev, appEvents(), eventDay);

// --- The event dialog (owner: the events port) ---
const [currentDetailEvent, setCurrentDetailEvent] = createSignal<AppEvent | null>(null);
export { currentDetailEvent, setCurrentDetailEvent };
/** Opens the event dialog (stub until ported). */
export async function openEventDetailModal(_eventId: string): Promise<void> {}
/** Opens the dialog to create an event ('event') or an appointment ('termin') (stub until ported). */
export function openNewEventDetailModal(_type: 'event' | 'termin' = 'event'): void {}
