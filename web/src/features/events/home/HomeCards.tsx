// The start page's event parts: the greeting, the open duty requests, the next appointments and events as a
// swipeable row, the own duties.
import type { JSX } from '@solidjs/web';
import { For, Match, Show, Switch, createEffect, createSignal, onSettled } from 'solid-js';
import { intlFormatter, t } from '../../../app/i18n';
import { switchTab } from '../../../app/router';
import { currentUser } from '../../../app/session';
import { fullName, getTodayStr } from '../../../app/util';
import { Icon } from '../../../ui/Icon';
import { DutyRequestsBanner } from '../DutyRequests';
import { EventCard } from '../EventCards';
import { EventsNotLoaded } from '../EventsNotLoaded';
import { eventCategory, eventStatusInfo, formatEventDateSpanShort, isMultiDay, type EventCategory } from '../format';
import { onActivateKey } from '../../../ui/keys';
import {
  appEvents, eventImage, eventsLoaded, isEventPast, isMyDuty, myDutyRequests, openEventDetailModal, switchEventsSubTab, type AppEvent
} from '../store';

/**
 * Keeps the text of [el] on one line: a long text gets smaller (down to [min] px) instead of wrapping. Measured again
 * when [text] changes and when the box around it changes its width (its own height follows the font size).
 */
function useFitOneLine(el: () => HTMLElement | undefined, text: () => unknown, min: number) {
  let width = 0;
  const fit = (force: boolean) => {
    const target = el();
    if (!target) return;
    const w = target.clientWidth;
    if (!w || (!force && w === width)) return;
    width = w;
    target.style.fontSize = '';
    if (target.scrollWidth <= w) return;
    const base = parseFloat(getComputedStyle(target).fontSize);
    target.style.fontSize = `${Math.max(min, Math.floor(((base * w) / target.scrollWidth) * 2) / 2)}px`;
  };
  createEffect(text, () => fit(true));
  onSettled(() => {
    const parent = el()?.parentElement;
    if (!parent || !('ResizeObserver' in window)) return;
    const observer = new ResizeObserver(() => fit(false));
    observer.observe(parent);
    return () => observer.disconnect();
  });
}

// The hour of the greeting: taken again with every load of the data (the app stays open for hours)
const [greetingTime, setGreetingTime] = createSignal(new Date());
export function refreshGreeting() {
  setGreetingTime(new Date());
}

export function HomeGreeting() {
  let title: HTMLHeadingElement | undefined;
  const hello = () => {
    const hour = greetingTime().getHours();
    return hour < 11 ? t('home_greeting_morning', 'Good morning') : hour < 18 ? t('home_greeting_day', 'Hello') : t('home_greeting_evening', 'Good evening');
  };
  const greeting = () => {
    const user = currentUser();
    const first = (user?.firstName || fullName(user) || user?.name || '').trim().split(/\s+/)[0];
    return first ? `${hello()}, ${first} 👋` : `${hello()} 👋`;
  };
  // The greeting stays on one line: a long name makes the text smaller instead of wrapping
  useFitOneLine(() => title, greeting, 14);
  return (
    <div class="mb-[26px] px-0.5 pt-0.5 pb-1">
      <div id="home-greeting-date" class="text-[0.76rem] font-semibold tracking-[0.08em] text-brand-deep uppercase">
        {intlFormatter(Intl.DateTimeFormat, { weekday: 'long', day: 'numeric', month: 'long' }).format(greetingTime())}
      </div>
      <h1
        ref={title}
        id="home-greeting-title"
        class="mt-1.5 overflow-hidden text-[1.6rem] leading-[1.15] font-[750] tracking-[-0.03em] whitespace-nowrap text-text dark:text-[#e4ded6]"
      >
        {greeting()}
      </h1>
    </div>
  );
}

function SectionHead(props: { title: string; children?: JSX.Element }) {
  return (
    <div class="mb-3.5 flex items-center justify-between">
      <h2 class="m-0 text-[1.2rem] font-bold tracking-[-0.02em] text-text">{props.title}</h2>
      {props.children}
    </div>
  );
}

/** The open duty requests of events that are not over yet (a tap on one opens its event). */
export function HomeDutyRequests() {
  const open = () => {
    const today = getTodayStr();
    return currentUser() ? myDutyRequests().filter(req => req && !(req.eventDate && req.eventDate < today)) : [];
  };
  return (
    <Show when={open().length}>
      <div id="home-duty-requests" class="mb-[30px]">
        <DutyRequestsBanner requests={open()} onHome />
      </div>
    </Show>
  );
}

const HOME_UPCOMING_COUNT = 5;

const localDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};

// "Today", "Tomorrow", the weekday within a week, else "Sat, 17 Oct"
function homeDayLabel(day: string, today: string) {
  if (day <= today) return t('home_today', 'Today');
  const date = localDay(day);
  const days = Math.round((date.getTime() - localDay(today).getTime()) / 86400000);
  if (days === 1) return t('home_tomorrow', 'Tomorrow');
  return intlFormatter(Intl.DateTimeFormat, days < 7 ? { weekday: 'long' } : { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
}

const NEXT_CAT: Record<EventCategory, string> = { event: '[--cat:var(--brand)]', termin: '[--cat:#78716c]', pinned: '[--cat:#6366f1]' };
const CHIP = 'mt-auto inline-flex items-center gap-1 self-start rounded-full border px-[9px] py-[3px] text-[0.72rem] font-bold';

function NextCard(props: { ev: AppEvent; day: string }) {
  // A picture that does not load leaves the spheres (a new picture gets its chance)
  const [failedImage, setFailedImage] = createSignal('');
  const image = () => {
    const src = eventImage(props.ev);
    return src !== failedImage() ? src : '';
  };
  const isEvent = () => eventCategory(props.ev) !== 'termin';
  const label = () => homeDayLabel(props.day, getTodayStr());
  const time = () => (isMultiDay(props.ev) ? formatEventDateSpanShort(props.ev.date, props.ev.endDate!) : props.ev.startTime || t('home_all_day', 'All day'));
  const status = () => eventStatusInfo(props.ev);
  const open = () => void openEventDetailModal(props.ev.id);
  return (
    <div
      class={[
        'flex shrink-0 basis-[224px] cursor-pointer snap-start flex-col rounded-[22px] border border-hairline bg-surface p-1.5 shadow-card transition-[transform,box-shadow] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.985] active:duration-100 hover:-translate-y-px hover:shadow-card-md md:basis-[240px] min-[1200px]:basis-[min(264px,calc((100%-4*16px)/5))] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),var(--shadow)]',
        NEXT_CAT[eventCategory(props.ev)]
      ]}
      role="button"
      tabindex="0"
      onClick={open}
      onKeyDown={e => onActivateKey(e, () => open())}
    >
      <div class="relative aspect-video overflow-hidden rounded-[17px] bg-surface-alt min-[1200px]:max-h-[200px]">
        <Show
          when={image()}
          fallback={
            <div class="event-spheres event-wash flex size-full items-center justify-center text-[var(--cat)] [--wash:var(--cat)]">
              <Icon name={isEvent() ? 'calendar' : 'clock'} size={20} />
            </div>
          }
        >
          <img src={image()} alt="" loading="lazy" class="block size-full object-cover" onError={() => setFailedImage(image())} />
        </Show>
        <span
          class={[
            'absolute top-2 left-2 rounded-full border px-2.5 py-1 text-[0.74rem] font-semibold text-white backdrop-blur-[10px]',
            props.day <= getTodayStr() ? 'border-white/45 bg-gradient-primary' : 'border-white/22 bg-[rgba(26,25,23,0.55)]'
          ]}
        >
          {label()}
        </span>
      </div>
      <div class="flex flex-1 basis-0 flex-col gap-1.5 px-2.5 pt-2.5 pb-2">
        <div class="flex min-w-0 items-center gap-[5px] text-[0.78rem] font-bold text-[var(--cat)]">
          <Icon name={isMultiDay(props.ev) ? 'calendar' : 'clock'} size={12} class="shrink-0" />
          <span class="truncate">{time()}</span>
        </div>
        <div class="line-clamp-2 text-[1rem] leading-[1.3] font-bold tracking-[-0.015em] text-text">{props.ev.title}</div>
        <Show when={props.ev.location}>
          <div class="flex min-w-0 items-center gap-[5px] text-[0.78rem] text-text-secondary">
            <Icon name="location" size={12} class="shrink-0" />
            <span class="truncate">{props.ev.location}</span>
          </div>
        </Show>
        <Switch>
          <Match when={status().myDuty}>
            {duty => (
              <span class={[CHIP, 'border-[rgba(var(--brand-rgb),0.25)] bg-brand/10 text-primary']}>
                <Icon name="user" size={12} />
                {duty().roleName || t('events_duty', 'Duty')}
              </span>
            )}
          </Match>
          <Match when={status().isRegistered}>
            <span class={[CHIP, 'border-[rgba(16,185,129,0.3)] bg-[rgba(16,185,129,0.12)] text-[#059669] dark:text-[#34d399]']}>
              <Icon name="check" size={12} />
              {t('home_registered', 'Registered')}
            </span>
          </Match>
          <Match when={status().isWaitlist}>
            <span class={[CHIP, 'border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.12)] text-[#d97706] dark:text-[#fbbf24]']}>{t('home_waitlist', 'Waiting list')}</span>
          </Match>
          <Match when={props.ev.requiresRegistration && !props.ev.isFull}>
            <span class={[CHIP, 'border-[rgba(var(--brand-rgb),0.28)] bg-brand/10 text-primary']}>{t('home_register_open', 'Registration open')}</span>
          </Match>
        </Switch>
      </div>
    </div>
  );
}

/** The next appointments and events (also invitations to register) as swipeable cards. */
export function HomeUpcoming() {
  const upcoming = () => {
    const today = getTodayStr();
    const startOf = (ev: AppEvent) => (ev.date < today ? today : ev.date);
    return appEvents()
      .filter(ev => ev && ev.date && ev.status !== 'cancelled' && !isEventPast(ev, today))
      .sort((a, b) => startOf(a).localeCompare(startOf(b)) || (a.startTime || '').localeCompare(b.startTime || ''))
      .slice(0, HOME_UPCOMING_COUNT)
      .map(ev => ({ ev, day: startOf(ev) }));
  };
  return (
    <Show when={currentUser()}>
      <div id="home-upcoming" class="mb-[30px]">
        <Switch>
          <Match when={!eventsLoaded()}>
            <SectionHead title={t('home_next', 'Up next')} />
            <EventsNotLoaded />
          </Match>
          <Match when={!upcoming().length}>
            <SectionHead title={t('home_next', 'Up next')} />
            <div class="rounded-[18px] border border-dashed border-border bg-surface p-[18px] text-center text-[0.9rem] text-text-secondary">
              {t('home_next_empty', 'Nothing coming up right now – enjoy the free time! 🌿')}
            </div>
          </Match>
          <Match when={upcoming().length}>
            <SectionHead title={t('home_next', 'Up next')}>
              {/* The events tab opens on its appointments list */}
              <button
                type="button"
                class="flex cursor-pointer items-center gap-0.5 border-none bg-transparent px-1 py-1.5 text-[0.9rem] font-semibold text-primary"
                onClick={() => {
                  switchTab('events');
                  switchEventsSubTab('termine');
                }}
              >
                {t('home_messages_all', 'All')}
                <Icon name="chevronRight" size={14} strokeWidth={2.5} />
              </button>
            </SectionHead>
            <div class="-mx-5 flex snap-x snap-mandatory scroll-px-5 gap-3 overflow-x-auto px-5 pt-0.5 pb-3.5 md:-mx-[var(--page-gutter)] md:scroll-px-[var(--page-gutter)] md:px-[var(--page-gutter)] min-[1200px]:gap-4">
              <For each={upcoming()} keyed={item => item.ev.id}>
                {item => <NextCard ev={item().ev} day={item().day} />}
              </For>
            </div>
          </Match>
        </Switch>
      </div>
    </Show>
  );
}

/** Own upcoming duties get their own section below the row (commitments, not offers). */
export function HomeDuties() {
  const dutyEvents = () => {
    const today = getTodayStr();
    if (!currentUser()) return [];
    return appEvents()
      .filter(ev => ev && ev.status !== 'cancelled' && !isEventPast(ev, today) && Array.isArray(ev.duties) && ev.duties.some(d => d && isMyDuty(d)))
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.startTime || '').localeCompare(b.startTime || ''));
  };
  return (
    <Show when={dutyEvents().length}>
      {/* The start page's grid places it by its id: next to the messages on wide screens */}
      <div id="user-duties-home-card" class="mb-[30px]">
        <SectionHead title={t('home_your_duties', 'Your duties')} />
        <div class="flex flex-col gap-3 md:grid md:grid-cols-[repeat(auto-fill,minmax(380px,1fr))] md:gap-x-4 md:gap-y-3">
          <For each={dutyEvents()} keyed={ev => ev.id}>
            {ev => <EventCard event={ev()} />}
          </For>
        </div>
      </div>
    </Show>
  );
}
