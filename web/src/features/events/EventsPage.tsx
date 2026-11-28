// The events tab: appointments ("Termine": a list by day, a month calendar beside it on desktop) or events (cover
// cards, highlights first, past ones on request); search, my open duty requests, loading / error / empty states.
import type { JSX } from '@solidjs/web';
import { For, Show, createMemo, createSignal, onFlush } from 'solid-js';
import { monthYearFormatter, t } from '../../app/i18n';
import { canManageEvents, currentUser, isCurrentUser } from '../../app/session';
import { scrollContainer } from '../../app/shell';
import { getTodayStr, groupBy, toDateStr } from '../../app/util';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { SearchInput } from '../../ui/feedback';
import { Icon } from '../../ui/Icon';
import { PillTabs } from '../../ui/PillTabs';
import { DutyRequestsBanner } from './DutyRequests';
import { CoverEventCard, EventCard } from './EventCards';
import { EventsNotLoaded } from './EventsNotLoaded';
import { eventCategory, monthKey, type EventCategory } from './format';
import {
  appEvents, eventsLoaded, eventsSubTab, isEventPast, isMyDuty, myDutyRequests, openNewEventDetailModal, switchEventsSubTab,
  type AppEvent
} from './store';
import { TermineCalendar } from './TermineCalendar';

/** An entry of the list: the event and the day it stands for (a multi-day event has one per remaining day). */
interface ListItem {
  ev: AppEvent;
  day: string;
}

// The search (lower case) and the past events of the events tab (shown on request)
const [searchText, setSearchText] = createSignal('');
const query = () => searchText().toLowerCase().trim();
const [showPast, setShowPast] = createSignal(false);
// The day chosen in the month calendar (it stays while the tab switches between appointments and events)
const [selectedDay, setSelectedDay] = createSignal<string | null>(null);

function filteredEvents(todayStr: string, subTab: 'termine' | 'events'): AppEvent[] {
  const q = query();
  const matches = (text: unknown) => String(text || '').toLowerCase().includes(q);
  return appEvents().filter(ev => {
    const duties = Array.isArray(ev.duties) ? ev.duties : [];
    if (subTab === 'termine') {
      if (isEventPast(ev, todayStr)) return false;
      const isRegistered = ev.myRegistration?.status === 'registered' || ev.myRegistration?.status === 'waitlist';
      // Mine like on the start page: my duties, my group's, and open requests to me (not declined ones)
      const hasDuty = duties.some(d => isMyDuty(d) || (isCurrentUser(d.requestedUser) && d.status === 'requested'));
      // Registration events only show up in "Termine" for participants; pinned highlights live on the events tab
      if (ev.requiresRegistration ? !isRegistered && !hasDuty : ev.isPinned && ev.eventType !== 'termin' && !hasDuty) return false;
    } else if (ev.eventType === 'termin' && !ev.isPinned) {
      return false;
    }
    return (
      !q || matches(ev.title) || matches(ev.location) || matches(ev.description) ||
      duties.some(d => matches(d.roleName) || matches(d.assignedGroupName) || matches(d.assignedUserName))
    );
  });
}

/** "Termine": a multi-day event gets one entry per remaining day (from today on), each with its own day. */
function expandEventDays(list: AppEvent[], todayStr: string): ListItem[] {
  return list.flatMap(ev => {
    if (!ev.date || !ev.endDate || ev.endDate <= ev.date) return [{ ev, day: ev.date }];
    const items: ListItem[] = [];
    const [y, m, d] = (ev.date > todayStr ? ev.date : todayStr).split('-').map(Number);
    for (let date = new Date(y, m - 1, d); toDateStr(date) <= ev.endDate && items.length < 366; date.setDate(date.getDate() + 1)) {
      items.push({ ev, day: toDateStr(date) });
    }
    return items;
  });
}

const byStart = (a: ListItem, b: ListItem) => (a.day || '').localeCompare(b.day || '') || (a.ev.startTime || '').localeCompare(b.ev.startTime || '');

/** The items grouped by month, in their order ("November 2026"). */
function byMonth(items: ListItem[]) {
  return [...groupBy(items, item => monthKey(item.day))].map(([key, list]) => {
    const [y, m] = key.split('-').map(Number);
    return { key, title: key.includes('-') ? monthYearFormatter.format(new Date(y, m - 1, 1)) : key, items: list };
  });
}

function MonthGroup(props: { title: string; count: number; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-2.5">
      <div class="flex items-center gap-2 px-0.5 pb-1 pt-2.5 text-[0.74rem] font-bold uppercase tracking-[0.1em] text-text after:h-px after:flex-1 after:bg-hairline after:content-['']">
        <span>{props.title}</span>
        <span class="text-[0.76rem] font-semibold tracking-normal text-text-secondary opacity-80">({props.count})</span>
      </div>
      {props.children}
    </div>
  );
}

const CARD_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-[18px] md:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]';

function CoverGrid(props: { items: ListItem[]; past?: boolean }) {
  return (
    <div class={CARD_GRID}>
      <For each={props.items} keyed={item => item.ev.id}>
        {item => <CoverEventCard event={item().ev} past={props.past} />}
      </For>
    </div>
  );
}

/** "Show past events (n)" and, opened, the past events as cover cards (newest first). */
function PastEvents(props: { events: AppEvent[] }) {
  return (
    <div class="mt-9 flex w-full flex-col items-center border-t border-dashed border-border pt-6">
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-[20px] border border-border bg-surface-alt px-[18px] py-2 text-[0.84rem] font-semibold text-text-secondary transition-[transform,translate,scale,opacity,box-shadow,background-color,border-color,color] duration-200 hover:border-primary hover:bg-surface hover:text-text"
        onClick={() => setShowPast(!showPast())}
      >
        <span class="text-[0.72rem]">{showPast() ? '▲' : '▼'}</span>
        <span>
          {showPast()
            ? t('events_past_hide', 'Hide past events ({count})', { count: props.events.length })
            : t('events_past_show', 'Show past events ({count})', { count: props.events.length })}
        </span>
      </button>
      <Show when={showPast()}>
        <div class="mt-[22px] w-full">
          <div class="mb-3 flex items-center justify-between px-1">
            <span class="text-[0.84rem] font-bold uppercase tracking-[0.5px] text-text-secondary">{t('events_past_title', 'Past events ({count})', { count: props.events.length })}</span>
            <span class="text-[0.76rem] text-text-secondary">{t('events_past_hint', 'Hidden until deleted manually')}</span>
          </div>
          <CoverGrid items={props.events.map(ev => ({ ev, day: ev.date }))} past />
        </div>
      </Show>
    </div>
  );
}

function EmptyList(props: { eventsTab: boolean }) {
  const newType = () => (props.eventsTab || !canManageEvents() ? 'event' : 'termin');
  return (
    <Card class="mb-0 rounded-2xl" bodyClass="px-5 py-12 text-center text-text-secondary">
      <div class="mb-2 text-[2.2rem]">📅</div>
      <div class="mb-1 text-[1.05rem] font-bold text-text">
        {props.eventsTab ? t('events_empty_events', 'No upcoming events found') : t('events_empty_termine', 'No matching appointments found')}
      </div>
      <Show when={query()}>
        <div class="mb-3.5 text-[0.88rem]">{t('events_empty_search', 'Try a different search.')}</div>
      </Show>
      <Show when={currentUser()}>
        <div class={{ 'mt-3.5': !query() }}>
          <Button variant="primary" size="small" onClick={() => openNewEventDetailModal(newType())}>
            + {newType() === 'event' ? t('events_btn_new', 'New Event') : t('events_new_termin', 'New Appointment')}
          </Button>
        </div>
      </Show>
    </Card>
  );
}

/** The appointments: one list below each other; on desktop a month calendar on the left jumps to a day. */
function TermineList(props: { items: ListItem[] }) {
  // The cards of the day the calendar jumped to light up (null in between: the animation starts again)
  const [jumpDay, setJumpDay] = createSignal<string | null>(null);
  let list!: HTMLDivElement;
  const calendarDays = createMemo(() => {
    const days = new Map<string, Set<EventCategory>>();
    for (const item of props.items) {
      if (!item.day) continue;
      if (!days.has(item.day)) days.set(item.day, new Set());
      days.get(item.day)!.add(eventCategory(item.ev));
    }
    return days;
  });
  // Scrolls the list to the first appointment on (or after) the chosen day and highlights that day's cards briefly
  const jumpTo = (day: string) => {
    setSelectedDay(day);
    const cards = [...list.querySelectorAll<HTMLElement>('[data-day]')];
    const first = cards.find(card => card.dataset.day === day) || cards.find(card => (card.dataset.day || '') > day);
    const scroller = scrollContainer();
    if (!first || !scroller) return;
    // Scrolling down hides the header, scrolling up brings it back: keep the card clear of it
    const distance = first.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const header = document.querySelector<HTMLElement>('.header');
    const offset = distance < 0 ? (header?.offsetHeight || 0) + 20 : 20;
    scroller.scrollTo({ top: scroller.scrollTop + distance - offset, behavior: 'smooth' });
    // The highlight goes, and comes back on the next frame once it is gone from the page (its animation starts anew)
    setJumpDay(null);
    onFlush(() => requestAnimationFrame(() => setJumpDay(first.dataset.day || null)));
  };
  return (
    <div class="lg:grid lg:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)] lg:items-start lg:gap-7">
      <TermineCalendar days={calendarDays()} selected={selectedDay()} onPick={jumpTo} />
      <div ref={list} class="lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
        <For each={byMonth(props.items)} keyed={group => group.key}>
          {group => (
            <MonthGroup title={group().title} count={group().items.length}>
              <div class="flex flex-col gap-3">
                <For each={group().items} keyed={item => `${item.ev.id}|${item.day}`}>
                  {item => <EventCard event={item().ev} day={item().day} jumping={jumpDay() === item().day} />}
                </For>
              </div>
            </MonthGroup>
          )}
        </For>
      </div>
    </div>
  );
}

function EventsList() {
  const todayStr = () => getTodayStr();
  const isEventsTab = () => eventsSubTab() === 'events';
  const filtered = createMemo(() => filteredEvents(todayStr(), eventsSubTab()));
  const upcoming = createMemo(() => {
    const items = isEventsTab()
      ? filtered().filter(ev => !isEventPast(ev, todayStr())).map(ev => ({ ev, day: ev.date }))
      : expandEventDays(filtered(), todayStr());
    // Events tab: pinned highlights first; Termine: purely by day
    return items.sort((a, b) => (isEventsTab() ? Number(Boolean(b.ev.isPinned)) - Number(Boolean(a.ev.isPinned)) : 0) || byStart(a, b));
  });
  const past = createMemo(() =>
    isEventsTab()
      ? filtered()
          .filter(ev => isEventPast(ev, todayStr()))
          .sort((a, b) => (b.endDate || b.date || '').localeCompare(a.endDate || a.date || '') || (b.startTime || '').localeCompare(a.startTime || ''))
      : []
  );
  const pinned = () => upcoming().filter(item => item.ev.isPinned);
  return (
    <Show when={eventsLoaded()} fallback={<EventsNotLoaded />}>
      <Show
        when={upcoming().length}
        fallback={
          <>
            <EmptyList eventsTab={isEventsTab()} />
            <Show when={past().length}>
              <PastEvents events={past()} />
            </Show>
          </>
        }
      >
        <Show when={isEventsTab()} fallback={<TermineList items={upcoming()} />}>
          <Show when={pinned().length}>
            <MonthGroup title={t('events_tab_pinned', 'Highlights')} count={pinned().length}>
              <CoverGrid items={pinned()} />
            </MonthGroup>
          </Show>
          <For each={byMonth(upcoming().filter(item => !item.ev.isPinned))} keyed={group => group.key}>
            {group => (
              <MonthGroup title={group().title} count={group().items.length}>
                <CoverGrid items={group().items} />
              </MonthGroup>
            )}
          </For>
          <Show when={past().length}>
            <PastEvents events={past()} />
          </Show>
        </Show>
      </Show>
    </Show>
  );
}

export function EventsPage() {
  return (
    <div class="mx-auto flex w-full flex-col gap-3.5">
      <div class="mb-3.5 flex flex-wrap items-center justify-between gap-3 max-md:flex-col max-md:items-stretch max-md:gap-2.5">
        <div>
          <h2 class="m-0 text-[1.7rem] font-[750] leading-[1.15] tracking-[-0.03em] text-text md:text-[2.1rem]">{t('events_title', 'Appointments & Events')}</h2>
        </div>
      </div>
      <div class="mb-3">
        <PillTabs
          class="md:max-w-[460px]"
          aria-label={t('events_view_select', 'Choose view')}
          value={eventsSubTab()}
          onChange={switchEventsSubTab}
          options={[
            { value: 'termine', id: 'events-tab-btn-termine', label: t('events_tab_termine', 'Appointments'), icon: <Icon name="calendar" size={16} /> },
            { value: 'events', id: 'events-tab-btn-events', label: t('events_tab_events', 'Events'), icon: <Icon name="sparkles" size={16} /> }
          ]}
        />
      </div>
      <div class="mb-1.5 flex flex-wrap items-center justify-between gap-2.5">
        <SearchInput
          id="events-search-input"
          class="mb-0 w-full max-w-full flex-1"
          value={searchText()}
          onInput={setSearchText}
          placeholder={t('events_search_placeholder', 'Search appointments & events...')}
        />
      </div>
      <Show when={myDutyRequests().length}>
        <div class="mb-4">
          <DutyRequestsBanner requests={myDutyRequests()} />
        </div>
      </Show>
      <div class="flex flex-col gap-6">
        <EventsList />
      </div>
    </div>
  );
}
