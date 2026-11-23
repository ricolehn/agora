// The cards of the events tab: the compact list card (appointments, also the start page's own duties), the large
// cover card (events) and the tear-off calendar leaf both use.
import type { JSX } from '@solidjs/web';
import { Show } from 'solid-js';
import { t } from '../../app/i18n';
import { Icon, type IconName } from '../../ui/Icon';
import {
  dutyViaGroup, eventCategory, eventDateParts, eventStatusInfo, eventTimeRange, formatEventDateSpanShort, isMultiDay,
  type EventCategory
} from './format';
import { eventImage, isEventPast, openEventDetailModal, type AppEvent } from './store';
import { getTodayStr } from '../../app/util';
import { onActivateKey } from '../../ui/keys';

const CATEGORY_LABEL: Record<EventCategory, () => string> = {
  pinned: () => t('events_major_event', 'Major event'),
  event: () => t('detail_groups_event', 'Event'),
  termin: () => t('detail_groups_termin', 'Appointment')
};

// The category colour: stripe and leaf of the list card, the "today" tag
const STRIPE: Record<EventCategory, string> = {
  pinned: 'before:bg-[#6366f1] before:opacity-85',
  event: 'before:bg-brand before:opacity-85',
  termin: 'before:bg-[#a8a29e] before:opacity-45'
};
const LEAF_MONTH: Record<EventCategory, string> = {
  pinned: 'bg-[#6366f1]',
  event: 'bg-brand',
  termin: 'bg-[#78716c] dark:bg-[#57534e]'
};
const TODAY_TAG: Record<EventCategory, string> = {
  pinned: 'bg-[#6366f1]/14 text-[#6366f1]',
  event: 'bg-brand/14 text-brand',
  termin: 'bg-brand/12 text-primary'
};

/** Tear-off calendar leaf: month strip in the category colour, big day number, weekday. */
function CalendarLeaf(props: { day: string | undefined; category: EventCategory; class?: string }) {
  const parts = () => eventDateParts(props.day);
  return (
    <div class={['flex w-11 shrink-0 flex-col items-center overflow-hidden bg-surface text-center leading-none', props.class]} aria-hidden="true">
      <span class={['w-full pb-[2px] pt-[3px] text-[0.56rem] font-extrabold uppercase tracking-[0.08em] text-white', LEAF_MONTH[props.category]]}>{parts().monthStr}</span>
      <span class="pt-[3px] text-[1.12rem] font-extrabold tracking-[-0.03em] text-text">{parts().dayNum}</span>
      <span class="pb-1 pt-px text-[0.6rem] font-semibold text-text-secondary">{parts().weekdayStr}</span>
    </div>
  );
}

type StatusKind = 'duty' | 'requested' | 'waitlist' | 'open-duties' | 'full';
interface CardStatus {
  kind: StatusKind;
  icon?: IconName;
  label: string;
  title?: string;
}

/** The one status a list card shows: my duty, my open request, the waiting list, open duties or "fully booked". */
function listCardStatus(ev: AppEvent): CardStatus | null {
  const { myDuty, myRequestedDuty, isRegistered, isWaitlist, openDutiesCount } = eventStatusInfo(ev);
  if (myDuty) {
    const label = dutyViaGroup(myDuty)
      ? myDuty.assignedGroupName || myDuty.assignedGroup || myDuty.roleName || t('events_duty', 'Duty')
      : myDuty.roleName || t('events_duty', 'Duty');
    return { kind: 'duty', icon: 'user', label, title: t('events_status_assigned_duty', 'Assigned duty') };
  }
  if (myRequestedDuty) return { kind: 'requested', icon: 'clock', label: t('events_status_request_open', 'Request pending'), title: t('events_status_duty_request_open', 'Duty request pending') };
  if (isWaitlist) return { kind: 'waitlist', icon: 'alert', label: t('home_waitlist', 'Waiting list'), title: t('events_status_on_waitlist', 'On the waiting list') };
  if (!isRegistered && openDutiesCount > 0 && ev.canAccessDutyPlan) {
    return {
      kind: 'open-duties',
      label: openDutiesCount === 1 ? t('events_duty_free_one', '1 duty open') : t('events_duty_free_many', '{count} duties open', { count: openDutiesCount }),
      title: t('events_duties_open_title', '{count} open duties', { count: openDutiesCount })
    };
  }
  if (!isRegistered && ev.requiresRegistration && ev.isFull) return { kind: 'full', label: t('events_status_full', 'Fully booked') };
  return null;
}

const LIST_STATUS_COLOR: Record<StatusKind, string> = {
  duty: 'font-semibold text-primary',
  requested: 'font-semibold text-warning',
  waitlist: 'font-semibold text-warning',
  'open-duties': 'font-medium text-text-secondary',
  full: 'font-semibold text-danger'
};

/**
 * Compact list card (appointments, the start page's own duties): calendar leaf, title, one "when" line, the place and
 * at most one status; the category colour shows as leaf strip and left accent. day: the calendar day this card stands
 * for (a multi-day event gets one card per day in the appointments).
 */
export function EventCard(props: { event: AppEvent; day?: string; jumping?: boolean }) {
  const day = () => props.day ?? props.event.date;
  const category = () => eventCategory(props.event);
  const isToday = () => day() === getTodayStr();
  const multiDay = () => isMultiDay(props.event);
  const when = () => (multiDay() ? formatEventDateSpanShort(props.event.date, props.event.endDate!) : eventTimeRange(props.event) || t('home_all_day', 'All day'));
  const status = () => listCardStatus(props.event);
  return (
    <div
      class={[
        'group relative z-[2] flex cursor-pointer items-center justify-between gap-3 overflow-hidden rounded-2xl border border-hairline bg-surface py-2 pl-3.5 pr-3 text-[0.95rem] shadow-card',
        'transition-[transform,translate,scale,box-shadow,border-color,background-color] duration-250 ease-app hover:-translate-y-px hover:shadow-card-md active:scale-[0.985] active:duration-100',
        'dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),var(--shadow)] dark:hover:shadow-[0_8px_20px_rgba(0,0,0,0.4)]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
        "before:absolute before:bottom-3 before:left-0 before:top-3 before:w-[3px] before:rounded-r-[3px] before:content-['']",
        STRIPE[category()],
        {
          '!shadow-[var(--shadow),0_0_0_2px_rgba(var(--brand-rgb),0.55)] dark:!shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_0_0_1.5px_rgba(var(--brand-rgb),0.35)]': isToday(),
          'opacity-55 grayscale-25': isEventPast(props.event),
          'event-jump-target': !!props.jumping
        }
      ]}
      data-day={day() || ''}
      title={CATEGORY_LABEL[category()]()}
      role="button"
      tabindex="0"
      onClick={() => void openEventDetailModal(props.event.id)}
      onKeyDown={e => onActivateKey(e, () => void openEventDetailModal(props.event.id))}
    >
      <CalendarLeaf day={day()} category={category()} class="rounded-[11px] border border-hairline shadow-card" />
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div class="truncate text-[0.97rem] font-[650] leading-[1.25] tracking-[-0.015em] text-text">{props.event.title}</div>
        <div class="flex min-w-0 items-center gap-1.5 text-[0.82rem] font-[550] text-text">
          <Show when={isToday()}>
            <span class={['rounded-full px-[7px] py-px text-[0.68rem] font-bold', TODAY_TAG[category()]]}>{t('home_today', 'Today')}</span>
          </Show>
          <Icon name={multiDay() ? 'calendar' : 'clock'} size={12} class="shrink-0 opacity-65" />
          <span class="shrink-0 whitespace-nowrap">{when()}</span>
          <Show when={status()}>
            {s => (
              <>
                <span class="shrink-0 font-normal text-text-secondary opacity-60" aria-hidden="true">·</span>
                <span class={['inline-flex min-w-0 items-center gap-1 whitespace-nowrap', LIST_STATUS_COLOR[s().kind]]} title={s().title}>
                  <Show when={s().icon}>{name => <Icon name={name()} size={13} class="shrink-0" />}</Show>
                  <span class="truncate">{s().label}</span>
                </span>
              </>
            )}
          </Show>
        </div>
        <Show when={props.event.location}>
          <div class="flex min-w-0 items-center gap-1.5 text-[0.8rem] text-text-secondary">
            <Icon name="location" size={12} class="shrink-0 opacity-65" />
            <span class="truncate">{props.event.location}</span>
          </div>
        </Show>
      </div>
      <div class="flex shrink-0 items-center justify-center gap-1.5 self-center">
        <div class="inline-flex shrink-0 items-center justify-center text-text-secondary opacity-40 transition-[opacity,transform,translate] duration-150 group-hover:translate-x-0.5 group-hover:opacity-90">
          <Icon name="chevronRight" size={12} strokeWidth={2.5} />
        </div>
      </div>
    </div>
  );
}

// --- Cover card (events tab) ---
const COVER_STATUS: Record<string, string> = {
  past: '!border-white/25 !bg-[rgba(120,113,108,0.85)] text-white',
  duty: 'text-[#6366f1]',
  requested: 'text-[#f59e0b]',
  waitlist: 'text-[#f59e0b]',
  full: 'text-[#ef4444]'
};

/** A status pill on the picture (frosted glass). */
function CoverStatus(props: { kind: keyof typeof COVER_STATUS; children: JSX.Element }) {
  return (
    <span
      class={[
        'inline-flex items-center gap-[5px] whitespace-nowrap rounded-lg border border-white/90 bg-white/88 px-[7px] py-[2px] text-[0.68rem] font-semibold leading-[1.2] shadow-[0_2px_10px_rgba(0,0,0,0.25)] backdrop-blur-[12px] min-[541px]:px-[9px] min-[541px]:py-[3px] min-[541px]:text-[0.74rem]',
        'dark:border-white/18 dark:bg-[rgba(28,25,23,0.72)]',
        COVER_STATUS[props.kind]
      ]}
    >
      {props.children}
    </span>
  );
}

/** Large cover card of the events tab: picture (or glass spheres), leaf, labels, title, when, where, places. */
export function CoverEventCard(props: { event: AppEvent; past?: boolean }) {
  const ev = () => props.event;
  const isPast = () => props.past || isEventPast(ev());
  const pinned = () => Boolean(ev().isPinned);
  const multiDay = () => isMultiDay(ev());
  const info = () => eventStatusInfo(ev());
  const image = () => eventImage(ev());
  const registered = () => info().isRegistered && !isPast();
  const max = () => ev().maxParticipants || 0;
  const count = () => ev().registeredCount || 0;
  const metaRow = (icon: IconName, text: string, multi = false) => (
    <div class={['flex items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap', { 'font-semibold text-primary': multi, '!text-[#6366f1] dark:!text-[#818cf8]': multi && pinned() }]}>
      <span class={['inline-flex shrink-0', pinned() ? 'text-[#6366f1] dark:text-[#818cf8]' : 'text-primary']}>
        <Icon name={icon} size={12} />
      </span>
      <span>{text}</span>
    </div>
  );
  return (
    <div
      id={`event-card-${ev().id}`}
      class={[
        'group relative z-[2] flex cursor-pointer flex-col overflow-hidden rounded-3xl p-2 transition-[transform,translate,scale,opacity,box-shadow,background-color,border-color,color] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] active:scale-[0.98]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
        pinned()
          ? 'border-[1.5px] border-transparent [background:linear-gradient(var(--surface),var(--surface))_padding-box,linear-gradient(135deg,#6366f1,var(--brand)_55%,#10b981)_border-box] shadow-[0_1px_2px_rgba(28,25,23,0.04),0_12px_30px_-14px_rgba(99,102,241,0.45)] hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(28,25,23,0.05),0_18px_36px_-16px_rgba(99,102,241,0.55)]'
          : 'border border-border-light bg-surface shadow-[0_1px_2px_rgba(28,25,23,0.04),0_10px_28px_-14px_rgba(28,25,23,0.22)] hover:-translate-y-[3px] hover:shadow-[0_2px_4px_rgba(28,25,23,0.05),0_18px_36px_-16px_rgba(var(--glow-rgb),0.45)] dark:shadow-[0_10px_28px_-14px_rgba(0,0,0,0.7)] dark:hover:shadow-[0_8px_20px_rgba(0,0,0,0.4)]',
        { 'opacity-65 hover:opacity-95': isPast() }
      ]}
      role="button"
      tabindex="0"
      onClick={() => void openEventDetailModal(ev().id)}
      onKeyDown={e => onActivateKey(e, () => void openEventDetailModal(ev().id))}
    >
      <div class="relative isolate flex aspect-video items-center justify-center overflow-hidden rounded-[18px] bg-surface-alt after:pointer-events-none after:absolute after:inset-0 after:z-[1] after:bg-[linear-gradient(180deg,rgba(28,25,23,0.28)_0%,rgba(28,25,23,0)_34%,rgba(28,25,23,0)_70%,rgba(28,25,23,0.18)_100%)] after:content-['']">
        <Show
          when={image()}
          fallback={
            <div
              class={[
                'event-spheres flex size-full items-center justify-center',
                pinned()
                  ? 'bg-[radial-gradient(at_20%_25%,rgba(99,102,241,0.42)_0%,transparent_55%),radial-gradient(at_85%_30%,rgba(var(--brand-rgb),0.32)_0%,transparent_55%),radial-gradient(at_50%_100%,rgba(168,85,247,0.25)_0%,transparent_60%)]'
                  : 'bg-[radial-gradient(at_18%_22%,rgba(var(--brand-rgb),0.38)_0%,transparent_52%),radial-gradient(at_82%_28%,rgba(99,102,241,0.32)_0%,transparent_55%),radial-gradient(at_55%_100%,rgba(16,185,129,0.28)_0%,transparent_60%)]',
                'bg-surface-alt'
              ]}
            >
              <div class="flex size-14 items-center justify-center rounded-[18px] border border-white/70 bg-white/55 text-primary shadow-[0_8px_22px_-6px_rgba(28,25,23,0.25)] backdrop-blur-[8px] transition-transform duration-250 group-hover:rotate-3 group-hover:scale-108 dark:border-white/18 dark:bg-[rgba(28,25,23,0.45)]">
                <Icon name="calendar" size={24} />
              </div>
            </div>
          }
        >
          <img
            class={['size-full object-cover transition-[scale,filter] duration-[600ms,300ms] ease-[cubic-bezier(0.16,1,0.3,1),ease] group-hover:scale-104', { 'grayscale-70': isPast() }]}
            src={image()}
            alt={ev().title}
            loading="lazy"
          />
        </Show>
        <CalendarLeaf
          day={ev().date}
          category={pinned() ? 'pinned' : 'event'}
          class="absolute left-2.5 top-2.5 z-[3] rounded-[14px] shadow-[0_8px_20px_-6px_rgba(28,25,23,0.45)] group-hover:scale-105"
        />
        <div class="absolute right-3 top-3 z-[3] flex flex-col items-end gap-1.5">
          <span
            class={[
              'inline-flex items-center justify-center whitespace-nowrap rounded-full border px-[11px] py-1 text-[0.62rem] font-bold uppercase leading-[1.25] tracking-[0.6px] text-white shadow-[0_4px_14px_-4px_rgba(0,0,0,0.35)] backdrop-blur-[12px] backdrop-saturate-140 min-[541px]:text-[0.67rem]',
              pinned() ? 'border-white/45 bg-[rgba(79,70,229,0.62)]' : 'border-white/35 bg-[rgba(28,25,23,0.38)]'
            ]}
          >
            {pinned() ? t('events_major_event', 'Major event') : t('detail_groups_event', 'Event')}
          </span>
          <CardCoverStatus event={ev()} past={isPast()} />
        </div>
      </div>
      <div class="flex flex-1 flex-col gap-2.5 px-2 pb-1.5 pt-3.5">
        <div class="flex items-start justify-between gap-2.5">
          <div class="line-clamp-2 min-w-0 flex-1 text-[1.1rem] font-extrabold leading-[1.3] tracking-[-0.01em] text-text">{ev().title}</div>
          <Show when={registered()}>
            <span
              class="mt-px inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full border border-[rgba(16,185,129,0.32)] bg-[rgba(16,185,129,0.12)] py-1 pl-2 pr-2.5 text-[0.68rem] font-bold leading-[1.2] text-[#059669] min-[541px]:text-[0.74rem] dark:border-[rgba(52,211,153,0.35)] dark:bg-[rgba(16,185,129,0.16)] dark:text-[#34d399]"
              title={t('events_reg_you_are_registered', 'You are registered')}
            >
              <Icon name="check" size={12} strokeWidth={3} class="shrink-0" />
              <span>{t('home_registered', 'Registered')}</span>
            </span>
          </Show>
        </div>
        <div class="flex flex-col gap-1.5 text-[0.84rem] text-text-secondary">
          <Show when={multiDay()}>{metaRow('calendar', formatEventDateSpanShort(ev().date, ev().endDate!), true)}</Show>
          <Show when={!multiDay() && eventTimeRange(ev())}>{metaRow('clock', eventTimeRange(ev()))}</Show>
          <Show when={ev().location}>{metaRow('location', ev().location)}</Show>
        </div>
        <div class="mt-auto flex items-center justify-between gap-2 pt-1 text-[0.8rem]">
          <div>
            <Show
              when={ev().requiresRegistration}
              fallback={<FooterPill>{t('events_no_registration', 'No registration')}</FooterPill>}
            >
              <Show when={max() > 0} fallback={<FooterPill>{t('events_registered_count', '{count} registered', { count: count() })}</FooterPill>}>
                <div class="flex min-w-[120px] flex-col gap-[5px]" title={t('events_capacity_taken', '{count} of {max} places taken', { count: count(), max: max() })}>
                  <span class="text-[0.76rem] font-semibold text-text">{t('events_capacity_short', '{count}/{max} places', { count: count(), max: max() })}</span>
                  <div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-alt">
                    <div class="h-full rounded-full bg-gradient-primary transition-[width] duration-300" style={{ width: `${Math.min(100, Math.round((count() / max()) * 100))}%` }} />
                  </div>
                </div>
              </Show>
            </Show>
          </div>
          <div
            class="flex size-10 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border border-border-light bg-surface-alt text-[0.76rem] font-bold text-text transition-[transform,translate,scale,opacity,box-shadow,background-color,border-color,color] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:border-transparent group-hover:bg-gradient-primary group-hover:text-white group-hover:shadow-[0_6px_16px_-4px_rgba(var(--glow-rgb),0.55)] group-active:border-transparent group-active:bg-gradient-primary group-active:text-white"
            title={t('modal_details_title', 'Details')}
            aria-hidden="true"
          >
            <Icon name="chevronRight" size={18} strokeWidth={2.5} class="transition-transform duration-[180ms] group-hover:translate-x-0.5" />
          </div>
        </div>
      </div>
    </div>
  );
}

function FooterPill(props: { children: JSX.Element }) {
  return (
    <span class="inline-flex items-center rounded-full border border-border-light bg-surface-alt px-[11px] py-[5px] text-[0.76rem] font-semibold text-text-secondary">
      {props.children}
    </span>
  );
}

/** The status on a cover card's picture: over, my duty, my open request, the waiting list or fully booked. */
function CardCoverStatus(props: { event: AppEvent; past: boolean }) {
  const info = () => eventStatusInfo(props.event);
  return (
    <Show
      when={!props.past}
      fallback={<CoverStatus kind="past">⌛ {t('events_status_past', 'Over')}</CoverStatus>}
    >
      <Show when={info().myDuty}>
        {duty => (
          <CoverStatus kind="duty">
            <Icon name="user" size={12} class="shrink-0" />
            <span>{duty().roleName || t('events_duty', 'Duty')}</span>
          </CoverStatus>
        )}
      </Show>
      <Show when={!info().myDuty && info().myRequestedDuty}>
        <CoverStatus kind="requested">
          <Icon name="clock" size={12} class="shrink-0" />
          <span>{t('events_status_request_open', 'Request pending')}</span>
        </CoverStatus>
      </Show>
      <Show when={!info().myDuty && !info().myRequestedDuty && info().isWaitlist}>
        <CoverStatus kind="waitlist">
          <span>{t('home_waitlist', 'Waiting list')}</span>
        </CoverStatus>
      </Show>
      <Show when={!info().myDuty && !info().myRequestedDuty && !info().isWaitlist && props.event.requiresRegistration && props.event.isFull && !props.event.myRegistration}>
        <CoverStatus kind="full">
          <span>{t('events_status_full', 'Fully booked')}</span>
        </CoverStatus>
      </Show>
    </Show>
  );
}
