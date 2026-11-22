// The events tab, the event page (view, edit, create) and the calendar subscription settings page.
import { onDataLoadStart } from '../../app/data';
import { t } from '../../app/i18n';
import { isModalOpen, setModalCloseGuard } from '../../app/modals';
import { registerFab, registerRoot, registerSettingsPage, registerTab, type FabItem } from '../../app/registry';
import { findBySlug, onTabEnter, registerRouteHandler, registerRouteOverride } from '../../app/router';
import { registerRemoteLoader } from '../../app/live';
import { canManageEvents, currentUser } from '../../app/session';
import { showToast } from '../../app/toast';
import { linkParam } from '../../app/util';
import { Icon } from '../../ui/Icon';
import { CalendarSettings } from './CalendarSettings';
import { EventDialog } from './EventDialog';
import { EventsPage } from './EventsPage';
import { hasGuestLink, openGuestEvent } from './guest/api';
import { UserCheckIcon } from './icons';
import { refreshProgram } from './plan/api';
import {
  EVENT_DIALOG_ID, appEvents, currentDetailEvent, detailCloseGuard, eventDay, eventSlug, loadEventsData, onEventsLoaded,
  openEventDetailModal, openNewEventDetailModal, refreshDetailEvent
} from './store';

registerTab('events', EventsPage);
registerRoot(EventDialog);
registerSettingsPage('calendar', CalendarSettings);

onTabEnter('events', () => void loadEventsData());
onDataLoadStart(() => void loadEventsData());
registerRemoteLoader('events', () => {
  void loadEventsData();
  void refreshProgram();
});
// The open event page shows the latest state after every load
onEventsLoaded(refreshDetailEvent);
setModalCloseGuard(EVENT_DIALOG_ID, detailCloseGuard);

/** /events/<slug> (also with ?share=<key>): the member's own event, else the page guests see, else a note. */
async function openEventFromRoute(slug: string) {
  // A shared link also names the event by its share key: the title, and with it the address, may have changed
  const shareToken = linkParam('share');
  const find = () => (shareToken && appEvents().find(ev => ev.publicToken === shareToken)) || findBySlug(appEvents(), slug, eventDay);
  let ev = find();
  if (!ev) {
    await loadEventsData();
    ev = find();
  }
  if (ev) {
    // A member gets their own page; the link's keys leave the address
    if (hasGuestLink()) history.replaceState(history.state, '', window.location.pathname);
    await openEventDetailModal(ev.id);
  } else if (hasGuestLink()) {
    // Not one of the member's events (another group's, a guest's link from an e-mail): the page guests see
    await openGuestEvent(false);
  } else {
    showToast(t('events_link_missing', 'This event no longer exists.'), 'error');
  }
}

registerRouteHandler('events', { after: rest => openEventFromRoute(rest[0]) });
registerRouteOverride(() => {
  const ev = currentDetailEvent();
  return isModalOpen(EVENT_DIALOG_ID) && ev && appEvents().some(e => e.id === ev.id) ? `/events/${encodeURIComponent(eventSlug(ev))}` : null;
});

// Event managers choose between an appointment and an event; everyone else creates an event directly
const fabItems = (): FabItem[] => [
  {
    icon: () => Icon({ name: 'calendar', size: 24 }),
    tint: { background: 'rgba(34, 211, 238, 0.15)', color: 'var(--primary)' },
    title: () => t('events_new_termin', 'New Appointment'),
    subtitle: () => t('fab_new_termin_sub', 'Church appointment / calendar entry'),
    onClick: () => openNewEventDetailModal('termin')
  },
  {
    icon: () => UserCheckIcon({ size: 24 }),
    tint: { background: 'rgba(99, 102, 241, 0.15)', color: '#6366f1' },
    title: () => t('events_btn_new', 'New Event'),
    subtitle: () => t('fab_new_event_sub', 'Event with flyer & registration'),
    onClick: () => openNewEventDetailModal('event')
  }
];
registerFab('events', {
  visible: () => !!currentUser(),
  get action() {
    return canManageEvents() ? undefined : () => openNewEventDetailModal('event');
  },
  get items() {
    return canManageEvents() ? fabItems : undefined;
  }
});
