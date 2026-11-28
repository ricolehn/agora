// The events and the own duty requests, shared by the events tab, the event dialog, the plan, sharing and the start
// page (owner: the events port). Loaded with the data, on the events tab and on a live update. Also the state of the
// event dialog (which event, viewing or editing, the editor's draft) and the actions on events.
import { createMemo, createRoot, createSignal, createStore, snapshot } from 'solid-js';
import { api, apiJson, asFailure, errorMessage, errorStatus } from '../../app/api';
import { groupList, loadSystemGroups, userInGroup } from '../../app/groups';
import { t } from '../../app/i18n';
import { closeModal, openModal } from '../../app/modals';
import { whenPicturesReady } from '../../app/pictures';
import { itemSlug } from '../../app/router';
import { createServerData, reload } from '../../app/serverData';
import { canManageEvents, currentUid, currentUser } from '../../app/session';
import { confirmAction, showToast, type ToastType } from '../../app/toast';
import { getTodayStr, once, toDateStr } from '../../app/util';
import type { Group } from '../../app/types';
import type { AppEvent, Duty, DutyRequest } from './types';

export type { AppEvent };

/** The events and the own duty requests; error: the first load failed (its reason; "Try again" asks again). */
interface EventsData {
  events: AppEvent[];
  requests: DutyRequest[];
  error?: string;
}

// The events as the server has them: loaded with the app's data (the start page shows them), again on the events tab,
// a live update and after every change (app/serverData.ts). Many parts read them on the way: until the first answer
// there are none (a spinner where they would show), and a failed first load is a value with its reason
const serverEvents = createServerData<EventsData | null>(
  async () => {
    // Groups rarely change: a live update of the events reuses them for a few minutes
    const [events, requestsRes] = await Promise.all([
      apiJson<AppEvent[]>('/events', 'GET', undefined, t('events_load_failed', 'Events could not be loaded')),
      api('/events/my-requests').catch(() => null),
      loadSystemGroups(5 * 60 * 1000)
    ]);
    const requests = requestsRes?.ok ? ((await requestsRes.json()) as DutyRequest[]) : [];
    // The pictures' versions first: the lists never ask for every picture
    await whenPicturesReady();
    return { events: Array.isArray(events) ? events : [], requests };
  },
  { loadingValue: null, failed: err => ({ events: [], requests: [], error: errorMessage(err) }) }
);
export const appEvents = () => serverEvents()?.events ?? [];
export const myDutyRequests = () => serverEvents()?.requests ?? [];
/** A first load succeeded (until then a spinner, or the failed load with "Try again"). */
export const eventsLoaded = () => !!serverEvents() && !serverEvents()!.error;
export const eventsLoadError = () => serverEvents()?.error ?? '';

/** Loads the events again (what is shown stays until they are there); resolves to them. */
export async function loadEventsData(): Promise<AppEvent[]> {
  if (!currentUser()) return [];
  return (await reload(serverEvents)).events;
}

export function isEventPast(ev: AppEvent, todayStr = getTodayStr()): boolean {
  const compareDate = ev.endDate?.trim() || ev.date?.trim() || '';
  return !!compareDate && compareDate < todayStr;
}

/** A duty is "mine" when it is assigned/confirmed to me or assigned to one of my groups. */
export const isMyDuty = (d: Duty) =>
  ((d.assignedUser === currentUid() || d.assignedUser === currentUser()?.id) && (d.status === 'confirmed' || d.status === 'assigned')) ||
  (d.status === 'assigned' && d.assignedGroup && userInGroup(currentUser(), d.assignedGroup));
export const hasDutyAssignee = (d: Duty) => Boolean(d.assignedUser || d.requestedUser || d.assignedGroup || d.assignedGroupName);

export const eventDay = (ev: AppEvent) => ev.date;
/** The event's part of its address (/events/<slug>). */
export const eventSlug = (ev: AppEvent) => itemSlug(ev, appEvents(), eventDay);

/** The cover picture's address ('' without one). */
export const eventImage = (ev: Pick<AppEvent, 'imageUrl'> | null | undefined) => (ev?.imageUrl || '').trim();

// --- The events tab: appointments ("termine") or events; the start page's "All" opens the appointments ---
export type EventsSubTab = 'termine' | 'events';
const [eventsSubTab, setEventsSubTab] = createSignal<EventsSubTab>('termine');
export { eventsSubTab };
export function switchEventsSubTab(tab: EventsSubTab | string) {
  setEventsSubTab(tab === 'events' ? 'events' : 'termine');
}

// --- The event dialog (one page for viewing, editing and creating; owner: the events port) ---
export const EVENT_DIALOG_ID = 'event-detail-modal';
// The event the dialog opened on (null: a new one)
const [openedEvent, setOpenedEvent] = createSignal<AppEvent | null>(null);
/** The event of the dialog in its latest state: it follows every load of the events (an action, a live update); one
 *  that is gone from them stays as it was. */
export const currentDetailEvent = createRoot(() =>
  createMemo(() => {
    const ev = openedEvent();
    return ev && (appEvents().find(e => e.id === ev.id) ?? ev);
  })
);
// Editing the event (or creating one: no current event) instead of viewing it
const [detailEditing, setDetailEditing] = createSignal(false);
// Changes with every event (or new one) the dialog opens on: the page starts at the top again
const [detailShown, setDetailShown] = createSignal(0);
export { detailEditing, detailShown };

function showDetail(ev: AppEvent | null, editing: boolean) {
  setOpenedEvent(ev);
  setDetailEditing(editing);
  setDetailShown(n => n + 1);
  openModal(EVENT_DIALOG_ID);
}

/** Opens the event dialog (loads the events first when the event is not known yet). */
export async function openEventDetailModal(eventId: string): Promise<void> {
  const ev = appEvents().find(e => e.id === eventId) || (await loadEventsData()).find(e => e.id === eventId);
  // Deleted (or not visible) in the meantime - a notification or an old link: say so instead of doing nothing
  if (!ev) return showToast(t('events_link_missing', 'This event no longer exists.'), 'error');
  showDetail(ev, false);
}

// --- The editor: what is typed and chosen, compared with how it opened to notice changes ---
export type EventKind = 'event' | 'termin';
export type RecurringRule = 'weekly' | 'biweekly' | 'monthly';
export interface EventDraft {
  title: string;
  date: string;
  endDate: string;
  startTime: string;
  endTime: string;
  isMultiDay: boolean;
  isRecurring: boolean;
  recurringRule: RecurringRule;
  recurringCount: string;
  location: string;
  description: string;
  imageUrl: string;
  eventType: EventKind;
  isPinned: boolean;
  requiresRegistration: boolean;
  minParticipants: string;
  maxParticipants: string;
  /** The chosen target groups (names; older events may name them by id). */
  targetGroups: string[];
}

const kindOf = (ev: AppEvent): EventKind => (ev.eventType || (ev.isOfficialTermin ? 'termin' : 'event')) as EventKind;

function draftFor(ev: AppEvent | null, type: EventKind): EventDraft {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const numberText = (value: unknown) => (value ? String(value) : '');
  return {
    title: ev?.title || '',
    date: ev ? ev.date || '' : toDateStr(tomorrow),
    endDate: ev?.endDate || '',
    startTime: ev?.startTime || '',
    endTime: ev?.endTime || '',
    isMultiDay: Boolean(ev?.endDate && ev.endDate !== ev.date),
    isRecurring: false,
    recurringRule: 'weekly',
    recurringCount: '10',
    location: ev?.location || '',
    description: ev?.description || '',
    imageUrl: eventImage(ev),
    // Only event managers choose between appointment and event
    eventType: canManageEvents() && type === 'termin' ? 'termin' : 'event',
    isPinned: ev?.isPinned === true,
    requiresRegistration: ev?.requiresRegistration === true,
    minParticipants: numberText(ev?.minParticipants),
    maxParticipants: numberText(ev?.maxParticipants),
    targetGroups: Array.isArray(ev?.targetGroups) ? [...ev.targetGroups] : []
  };
}

const [draft, setDraft] = createStore<EventDraft>(draftFor(null, 'event'));
let draftAtStart: EventDraft = draftFor(null, 'event');
export { draft, setDraft };

const groupKey = (g: Pick<Group, 'id' | 'name'>) => g.name || g.id;
/** Whether the group [g] is chosen in [selected] (by name or id). */
export const groupChosen = (selected: string[], g: Pick<Group, 'id' | 'name'>) => selected.includes(groupKey(g)) || selected.includes(g.id);
/** The chosen groups as the server takes them: the names of the groups that exist. */
export const chosenGroupNames = (selected: string[]) => groupList().filter(g => groupChosen(selected, g)).map(groupKey);

// Groups loaded after the editor opened count the same for both sides: no false "changed"
const comparable = (d: EventDraft) => JSON.stringify({ ...d, targetGroups: chosenGroupNames(d.targetGroups).sort() });
/** Something was typed or chosen since the editor opened. */
const draftChanged = () => comparable(snapshot(draft) as EventDraft) !== comparable(draftAtStart);

function startDraft(ev: AppEvent | null, type: EventKind) {
  draftAtStart = draftFor(ev, type);
  setDraft(() => draftFor(ev, type));
  if (groupList().length === 0) void loadSystemGroups();
}

/** Appointment or event (event managers only; everyone else creates events). */
export function setDraftType(type: EventKind) {
  setDraft(d => {
    d.eventType = canManageEvents() && type === 'termin' ? 'termin' : 'event';
  });
}

/** The open event in the editor. */
export function enterDetailEditMode() {
  const ev = currentDetailEvent();
  if (!ev) return;
  startDraft(ev, kindOf(ev));
  setDetailEditing(true);
}

/** Back to the event; a new one is not created (the dialog closes). */
export function cancelDetailEditMode() {
  setDetailEditing(false);
  if (!currentDetailEvent()) closeModal(EVENT_DIALOG_ID);
}

/** Opens the dialog to create an event ('event') or an appointment ('termin'; event managers only). */
export function openNewEventDetailModal(type: 'event' | 'termin' = 'event'): void {
  startDraft(null, canManageEvents() ? type : 'event');
  showDetail(null, true);
}

/** Leaving the editor (Escape, back gesture, back button) asks first when something changed. */
export const detailCloseGuard = () => !detailEditing() || !draftChanged() || confirmAction(t('songbook_discard', 'Discard your changes?'));

// --- Actions on events: the server call, its toast, a fresh load of the events (the open dialog follows it) ---
interface EventActionOptions<T> {
  success: string | ((data: T) => string);
  successType?: ToastType | ((data: T) => ToastType);
  error: string;
  /** The server's own error text when it sends one (default). */
  useServerError?: boolean;
  networkError?: string;
}

/** The call with its toast and a fresh load of the events, ready to run. */
function eventActionRun<T>(path: string, method: string, body: unknown, options: EventActionOptions<T>) {
  const { success, successType = 'success', error, useServerError = true, networkError = t('error_connection', 'Connection error') } = options;
  return async () => {
    try {
      const data = await apiJson<T>(path, method, body);
      showToast(typeof success === 'function' ? success(data) : success, typeof successType === 'function' ? successType(data) : successType);
      await loadEventsData();
    } catch (err) {
      showToast(errorStatus(err) ? (useServerError && asFailure(err).data?.error) || error : networkError, 'error');
    }
  };
}

/** An event API call with its toast and a reload of the events. The same call twice (a double tap) runs once. */
export function eventAction<T = unknown>(path: string, method: string, body: unknown, options: EventActionOptions<T>) {
  return once(`${method} ${path}`, eventActionRun(path, method, body, options));
}

export const respondToDutyRequest = (dutyId: string, action: 'accept' | 'decline') =>
  eventAction(`/events/duties/${dutyId}/respond`, 'POST', { action }, {
    success: action === 'accept' ? t('duty_toast_accepted', 'Duty accepted! You are now assigned to this event.') : t('duty_toast_declined', 'Duty request declined.'),
    successType: action === 'accept' ? 'success' : 'info',
    error: t('duty_respond_error', 'Failed to respond to the duty request')
  });

/** Registers for an event (the waiting list when it is full) or leaves it again. */
export async function toggleEventRegistration(eventId: string, currentStatus: string) {
  if (!currentUser()) return;
  const cancel = currentStatus === 'registered' || currentStatus === 'waitlist';
  await eventAction<{ isWaitlist?: boolean }>(`/events/${eventId}/register`, 'POST', { action: cancel ? 'cancel' : 'register' }, {
    success: data => (cancel ? t('events_unregistered_success', 'Unregistered') : data.isWaitlist ? t('events_waitlist_success', 'Added to the waiting list') : t('events_registered_success', 'Registered successfully!')),
    successType: data => (cancel ? 'info' : data.isWaitlist ? 'warning' : 'success'),
    error: t('error_action_failed', 'Action failed')
  });
}

async function deleteEvent(eventId: string) {
  if (!confirmAction(t('events_delete_confirm', 'Do you really want to delete this event?'))) return;
  await eventAction(`/events/${eventId}`, 'DELETE', undefined, {
    success: t('events_deleted_success', 'Event deleted'),
    error: t('toast_delete_failed_short', 'Deletion failed'),
    networkError: t('events_delete_error', 'Failed to delete the event')
  });
}

/** The delete button of the event page: the page closes, then the deletion is confirmed. */
export function deleteCurrentEvent() {
  const ev = currentDetailEvent();
  if (!ev) return;
  closeModal(EVENT_DIALOG_ID);
  void deleteEvent(ev.id);
}
