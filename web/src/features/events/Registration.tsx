// The registration card of the event page: places taken (and the minimum), my status or the register button, and
// the participants (removable by those who may edit the event; guests without an account are marked).
import type { JSX } from '@solidjs/web';
import { For, Show, createEffect, createSignal } from 'solid-js';
import { apiJson } from '../../app/api';
import { t } from '../../app/i18n';
import { confirmAction } from '../../app/toast';
import { newestWins } from '../../app/util';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { ProgressBar } from '../../ui/feedback';
import { Icon, type IconName } from '../../ui/Icon';
import { eventAction, isEventPast, toggleEventRegistration, type AppEvent } from './store';

/** "1 of 2 places taken · 1 free · 3 more needed (min. 4)" (members and guests count alike). */
export function capacityText(ev: AppEvent) {
  const max = ev.maxParticipants || 0;
  const count = ev.registeredCount || 0;
  const min = ev.minParticipants || 0;
  const free = Math.max(0, max - count);
  return [
    max > 0 ? t('events_capacity_taken', '{count} of {max} places taken', { count, max }) : t('events_registered_count', '{count} registered', { count }),
    max > 0 ? (free > 0 ? t('events_capacity_free', '{count} free', { count: free }) : t('events_capacity_full', 'fully booked')) : '',
    min > 0
      ? count >= min
        ? t('events_capacity_min_reached', 'minimum of {count} reached', { count: min })
        : t('events_capacity_min_missing', '{missing} more needed (min. {count})', { missing: min - count, count: min })
      : ''
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The bar of places taken (only with a maximum). */
export function CapacityBar(props: { event: AppEvent }) {
  const max = () => props.event.maxParticipants || 0;
  const count = () => props.event.registeredCount || 0;
  const full = () => max() > 0 && count() >= max();
  return (
    <Show when={max() > 0}>
      <ProgressBar
        class="mt-3 border border-border-light"
        fill={full() ? 'bg-[linear-gradient(90deg,#f59e0b_0%,#ef4444_100%)]' : undefined}
        percent={(count() / max()) * 100}
      />
    </Show>
  );
}

const BANNER: Record<'registered' | 'waitlist' | 'past', { box: string; icon: string }> = {
  registered: { box: 'border-[rgba(16,185,129,0.3)] bg-[rgba(16,185,129,0.08)]', icon: 'bg-[#10b981]' },
  waitlist: { box: 'border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)]', icon: 'bg-[#f59e0b]' },
  past: { box: 'border-border-light bg-surface-alt', icon: 'bg-[#a8a29e]' }
};

/** A status band of the registration card: my place, the waiting list, or why it is closed. */
export function RegBanner(props: { kind: keyof typeof BANNER; icon: IconName; title: JSX.Element; sub?: JSX.Element; action?: JSX.Element }) {
  return (
    <div class={['flex items-center gap-3 rounded-[14px] border px-3 py-2.5', BANNER[props.kind].box]}>
      <span class={['flex size-[30px] shrink-0 items-center justify-center rounded-full text-white', BANNER[props.kind].icon]}>
        <Icon name={props.icon} size={16} strokeWidth={2.5} />
      </span>
      <div class="flex min-w-0 flex-1 flex-col text-[0.8rem] text-text-secondary">
        <strong class="text-[0.92rem] font-bold text-text">{props.title}</strong>
        <Show when={props.sub}>
          <span>{props.sub}</span>
        </Show>
      </div>
      {props.action}
    </div>
  );
}

/** "Unregister" / "Leave" at the end of a status band. */
export function RegBannerAction(props: { onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      class="cursor-pointer rounded-lg border-0 bg-transparent px-1.5 py-2 text-[0.84rem] font-bold text-text-secondary hover:bg-[rgba(239,68,68,0.08)] hover:text-danger"
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}

// --- Participants (loaded for the open event; every refresh of the event loads them again) ---
interface Attendees {
  eventId: string;
  registered: any[];
  waitlist: any[];
}
const [attendees, setAttendees] = createSignal<Attendees | null>(null);
const attendeesLoad = newestWins();

async function loadEventAttendees(eventId: string) {
  const isNewest = attendeesLoad();
  try {
    const data = await apiJson(`/events/${eventId}/attendees`);
    if (!isNewest()) return;
    setAttendees({ eventId, registered: data.registered || [], waitlist: data.waitlist || [] });
  } catch (err) {
    console.warn('Failed to load event attendees:', err);
  }
}

async function removeEventAttendee(eventId: string, userId: string) {
  if (!confirmAction(t('events_attendee_remove_confirm', 'Do you really want to remove this participant from the list?'))) return;
  await eventAction(`/events/${eventId}/attendees/${userId}`, 'DELETE', undefined, {
    success: t('events_attendee_removed', 'Participant removed'),
    successType: 'info',
    error: t('events_attendee_remove_error', 'Failed to remove the participant'),
    useServerError: false
  });
}

function AttendeeRow(props: { event: AppEvent; attendee: any; waiting: boolean }) {
  const att = () => props.attendee;
  return (
    <div class="flex items-center gap-2.5 px-0.5 py-1.5">
      <Avatar
        uid={att().guest ? null : att().userId}
        name={att().name}
        size={32}
        initialsClass="text-[0.72rem]"
        class={props.waiting ? '!bg-[rgba(245,158,11,0.15)] !bg-none' : undefined}
      />
      <Show
        when={att().guest}
        fallback={<span class="min-w-0 flex-1 truncate text-[0.9rem] font-semibold text-text">{att().name}</span>}
      >
        {/* Guests signed up without an account (shared link): marked; the e-mail address and age only reach editors */}
        <span class="flex min-w-0 flex-1 flex-col gap-px">
          <span class="truncate text-[0.9rem] font-semibold text-text">
            {att().name}{' '}
            <span class="ml-1 inline-block rounded-full bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] px-[7px] py-px align-[1px] text-[0.66rem] font-extrabold uppercase tracking-[0.04em] text-primary-dark dark:text-primary">
              {t('events_attendee_guest', 'Guest')}
            </span>
          </span>
          <Show when={att().email}>
            <span class="truncate text-[0.76rem] font-medium text-text-secondary">
              <a href={`mailto:${att().email}`} class="text-inherit underline">{att().email}</a>
              {Number.isFinite(att().age) ? ` · ${t('events_attendee_age', 'Age {age}', { age: att().age })}` : ''}
            </span>
          </Show>
        </span>
      </Show>
      <Show when={props.event.canEdit}>
        <button
          type="button"
          class="inline-flex size-7 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-text-secondary hover:bg-[rgba(239,68,68,0.1)] hover:text-danger"
          title={props.waiting ? t('events_attendee_remove_waitlist', 'Remove from waiting list') : t('events_attendee_remove', 'Remove participant')}
          aria-label={t('btn_remove', 'Remove')}
          onClick={() => void removeEventAttendee(props.event.id, att().userId)}
        >
          <Icon name="x" size={13} strokeWidth={2.5} />
        </button>
      </Show>
    </div>
  );
}

function AttendeesList(props: { event: AppEvent }) {
  const list = () => (attendees()?.eventId === props.event.id ? attendees() : null);
  const registered = () => list()?.registered || [];
  const waitlist = () => list()?.waitlist || [];
  const stack = () => registered().slice(0, 5);
  return (
    <details class="group/att mt-3 border-t border-border-light">
      <summary class="flex cursor-pointer list-none select-none items-center gap-2.5 pb-0.5 pt-3 [&::-webkit-details-marker]:hidden">
        <Show when={stack().length}>
          <div class="flex items-center pl-1.5">
            <For each={stack()} keyed={att => att.userId}>
              {att => <Avatar uid={att().guest ? null : att().userId} name={att().name} size={28} initialsClass="text-[0.65rem]" class="-ml-1.5 border-2 border-surface" />}
            </For>
            <Show when={registered().length > stack().length}>
              <span class="-ml-1.5 inline-flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-surface bg-surface-alt px-1.5 text-[0.7rem] font-extrabold text-text-secondary">
                +{registered().length - stack().length}
              </span>
            </Show>
          </div>
        </Show>
        <span class="inline-flex min-w-0 flex-1 items-center gap-2 text-[0.9rem] font-bold text-text">
          <span>{list() && !registered().length ? t('events_attendees_none', 'Nobody registered yet') : t('events_attendees', 'Participants')}</span>
          <Show when={registered().length}>
            <span class="inline-flex h-5 min-w-[22px] items-center justify-center rounded-full border border-border-light bg-surface-alt px-[7px] text-[0.72rem] font-extrabold text-text-secondary">
              {registered().length}
            </span>
          </Show>
        </span>
        <span class="inline-flex text-text-secondary transition-transform duration-200 ease-[ease] group-open/att:rotate-180">
          <Icon name="chevronDown" size={14} strokeWidth={2.5} />
        </span>
      </summary>
      <div class="flex flex-col pt-2">
        <Show
          when={registered().length || waitlist().length}
          fallback={<div class="px-0.5 py-2 text-[0.84rem] text-text-secondary">{t('events_attendees_empty', 'As soon as someone registers, they will appear here.')}</div>}
        >
          <For each={registered()} keyed={att => att.userId}>
            {att => <AttendeeRow event={props.event} attendee={att()} waiting={false} />}
          </For>
          <Show when={waitlist().length}>
            <div class="mx-0.5 mb-0.5 mt-2.5 text-[0.72rem] font-extrabold uppercase tracking-[0.6px] text-[#d97706]">
              {t('home_waitlist', 'Waiting list')} · {waitlist().length}
            </div>
            <For each={waitlist()} keyed={att => att.userId}>
              {att => <AttendeeRow event={props.event} attendee={att()} waiting />}
            </For>
          </Show>
        </Show>
      </div>
    </details>
  );
}

/** My status (registered / waiting list / over) or the button to register or join the waiting list. */
function RegistrationAction(props: { event: AppEvent }) {
  const status = () => props.event.myRegistration?.status;
  const toggle = (current: string) => void toggleEventRegistration(props.event.id, current);
  return (
    <div class="mt-3.5">
      <Show
        when={!isEventPast(props.event)}
        fallback={
          <RegBanner
            kind="past"
            icon={status() === 'registered' ? 'check' : 'clock'}
            title={status() === 'registered' ? t('events_reg_was_registered', 'You were registered') : t('events_reg_closed', 'Registration has closed')}
            sub={t('events_reg_event_over', 'The event is over.')}
          />
        }
      >
        <Show when={status() === 'registered'}>
          <RegBanner
            kind="registered"
            icon="check"
            title={t('events_reg_you_are_registered', 'You are registered')}
            sub={t('events_reg_looking_forward', 'We look forward to seeing you!')}
            action={<RegBannerAction onClick={() => toggle('registered')}>{t('events_reg_unregister', 'Unregister')}</RegBannerAction>}
          />
        </Show>
        <Show when={status() === 'waitlist'}>
          <RegBanner
            kind="waitlist"
            icon="clock"
            title={t('events_reg_on_waitlist', 'You are on the waiting list')}
            sub={t('events_reg_waitlist_hint', 'You will move up as soon as a place becomes free.')}
            action={<RegBannerAction onClick={() => toggle('waitlist')}>{t('events_reg_leave', 'Leave')}</RegBannerAction>}
          />
        </Show>
        <Show when={status() !== 'registered' && status() !== 'waitlist'}>
          <Show
            when={props.event.isFull}
            fallback={
              <Button variant="primary" block class="gap-2" onClick={() => toggle('none')}>
                <Icon name="check" size={15} strokeWidth={2.5} />
                <span>{t('events_reg_register', 'Register')}</span>
              </Button>
            }
          >
            <Button variant="secondary" block class="gap-2" onClick={() => toggle('none')}>
              <Icon name="clock" size={15} />
              <span>{t('events_reg_join_waitlist', 'Join the waiting list')}</span>
            </Button>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

/** The card head: symbol, "Registration", the places (also the guests' page uses it). */
export function RegistrationHead(props: { event: AppEvent }) {
  return (
    <>
      <div class="flex min-w-0 items-center gap-3">
        <div class="flex size-[38px] shrink-0 items-center justify-center rounded-xl bg-brand/14 text-primary">
          <Icon name="users" size={18} />
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="text-[1rem] font-extrabold text-text">{t('events_registration', 'Registration')}</span>
          <span class="text-[0.82rem] text-text-secondary">{capacityText(props.event)}</span>
        </div>
      </div>
      <CapacityBar event={props.event} />
    </>
  );
}

export function RegistrationCard(props: { event: AppEvent }) {
  // Every state of the event (a registration, a live update) loads the participants again
  createEffect(
    () => props.event,
    ev => void loadEventAttendees(ev.id)
  );
  return (
    <div class="rounded-[20px] border border-border-light bg-surface px-4 py-3.5 shadow-card">
      <RegistrationHead event={props.event} />
      <RegistrationAction event={props.event} />
      <AttendeesList event={props.event} />
    </div>
  );
}
