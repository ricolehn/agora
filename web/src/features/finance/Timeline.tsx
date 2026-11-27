// A member's history as a line (generateTimelineHTML): status changes, payments and the fresh start of the fee account,
// newest first. The fee list shows it for every member, the members' own finance page for themselves.
import { For, Show, createMemo } from 'solid-js';
import type { Person } from '../../app/data';
import { euro, formatDateFast, getStatusLabels, t, type MemberStatus } from '../../app/i18n';
import { Icon } from '../../ui/Icon';
import { feeResetOutcome } from './common';

interface TimelineEvent {
  type: 'status' | 'payment' | 'reset';
  dateStr: string;
  status?: string;
  amount?: unknown;
  description?: string;
}

function timelineEvents(person: Person): TimelineEvent[] {
  const history = person.statusHistory;
  const events: TimelineEvent[] = history.map(h => ({ type: 'status', dateStr: h.startDate, status: h.status }));
  const currentStart = history.length > 0 ? history[history.length - 1].endDate : person.originalMemberSince || person.memberSince;
  if (currentStart) events.push({ type: 'status', dateStr: currentStart, status: person.status });
  for (const p of person.payments) events.push({ type: 'payment', dateStr: p.date, amount: p.amount, description: p.description });
  if (events.length === 0) return events;
  // The fee account was started afresh (CALDERA): its day is a marked point on the line, with what happened then
  if (person._feeReset) events.push({ type: 'reset', dateStr: person._feeReset });
  // Newest first; on the day of a fresh start its line comes below that day's entries (they belong to the new
  // account). A payment without a date (older or imported data) goes to the end instead of breaking the whole view
  return events.sort(
    (a, b) => String(b.dateStr || '').localeCompare(String(a.dateStr || '')) || Number(a.type === 'reset') - Number(b.type === 'reset')
  );
}

// The dots are masked with the card's colour (not white), so they sit calmly on the line in both themes
const DOT = 'absolute rounded-full border-2 border-surface shadow-[0_0_0_4px_var(--surface)]';

function TimelineItem(props: { event: TimelineEvent; settled: boolean; person: Person }) {
  const date = () => formatDateFast(props.event.dateStr);
  const title = () =>
    props.event.type === 'status'
      ? `${t('timeline_status_change', 'Status Change')}: ${getStatusLabels(true)[props.event.status as MemberStatus] || props.event.status}`
      : `${t('timeline_payment', 'Payment')}: ${euro(props.event.amount)}`;
  const meta = () =>
    props.event.type === 'status'
      ? `${t('timeline_valid_from', 'Valid from')} ${date()}`
      : `${props.event.description || t('timeline_no_note', 'No note')} • ${date()}`;
  return (
    <div class="relative mb-6 last:mb-0">
      <Show
        when={props.event.type !== 'reset'}
        fallback={
          <>
            <div class={[DOT, '-left-9 top-2 flex size-[22px] items-center justify-center bg-warning text-white']} aria-hidden="true">
              <Icon name="rotate" size={12} strokeWidth={3} />
            </div>
            <div class="rounded-xl border border-[color-mix(in_srgb,var(--warning)_28%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] px-3 py-2">
              <div class="flex items-baseline justify-between gap-2.5 font-bold">
                <span>{t('fee_reset_timeline_title', 'Fresh start')}</span>
                <span class="shrink-0 text-[0.8rem] font-semibold text-text-secondary tabular-nums">{date()}</span>
              </div>
              <div class="text-[0.85rem] text-text-secondary">{feeResetOutcome(props.person)}</div>
            </div>
          </>
        }
      >
        <div class={[DOT, '-left-[31px] top-1.5 size-3', props.settled ? 'bg-border' : 'bg-primary']} />
        <div class={{ 'opacity-60': props.settled }}>
          <div class="font-semibold">{title()}</div>
          <div class="text-[0.85rem] text-text-secondary">{meta()}</div>
        </div>
      </Show>
    </div>
  );
}

/** The history of [person]; "No entries found." without any. */
export function Timeline(props: { person: Person }) {
  const events = createMemo(() => timelineEvents(props.person));
  // Below the fresh start lies the settled time: its entries stay, a little quieter (the server counts the same way)
  const resetAt = createMemo(() => events().findIndex(ev => ev.type === 'reset'));
  return (
    <Show
      when={events().length}
      fallback={<div class="text-[0.8rem] text-text-secondary italic">{t('timeline_no_entries', 'No entries found.')}</div>}
    >
      <div class="relative my-[15px] ml-2 border-l-2 border-border-light pl-6">
        {/* By position: every load of the data brings the record anew, and its entries (fresh objects for the same
            history) rebuilt the whole line */}
        <For each={events()} keyed={false}>
          {(event, i) => <TimelineItem event={event()} settled={resetAt() >= 0 && i > resetAt()} person={props.person} />}
        </For>
      </div>
    </Show>
  );
}
