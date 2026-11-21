// A member's history as a line (generateTimelineHTML): status changes and payments, the newest first. A fresh start
// of the fee account is a marked point on the line with what happened then; the settled time below it stays, a little
// quieter (the server counts the same way).
import { For, Show, createMemo } from 'solid-js';
import type { Person } from '../../../app/data';
import { euro, formatDateFast, getStatusLabels, t, type MemberStatus } from '../../../app/i18n';
import { safeList } from '../../../app/util';
import { Icon } from '../../../ui/Icon';

type TimelineEntry = { type: 'status' | 'payment' | 'reset'; dateStr: string; status?: string; amount?: unknown; description?: string };

function timelineEntries(person: Person): TimelineEntry[] {
  const history = safeList<any>(person.statusHistory);
  const entries: TimelineEntry[] = history.map(h => ({ type: 'status', dateStr: h.startDate, status: h.status }));
  const currentStart = history.length > 0 ? history[history.length - 1].endDate : person.originalMemberSince || person.memberSince;
  if (currentStart) entries.push({ type: 'status', dateStr: currentStart, status: person.status });
  for (const p of safeList<any>(person.payments)) entries.push({ type: 'payment', dateStr: p.date, amount: p.amount, description: p.description });
  if (entries.length === 0) return entries;
  if (person._feeReset) entries.push({ type: 'reset', dateStr: person._feeReset });
  // Newest first; on the day of a fresh start its point comes below that day's entries (they belong to the new
  // account). A payment without a date (older or imported data) goes to the end instead of breaking the whole view
  return entries.sort((a, b) => String(b.dateStr || '').localeCompare(String(a.dateStr || '')) || Number(a.type === 'reset') - Number(b.type === 'reset'));
}

/** What the fresh start did to the account: credit taken along, open fees dropped, or nothing to settle. */
export function feeResetOutcome(person: Person): string {
  if (person._feeCarriedOver > 0) return t('fee_reset_carried', 'Credit carried over: {amount}', { amount: euro(person._feeCarriedOver) });
  if (person._feeWrittenOff > 0) return t('fee_reset_dropped', 'Open fees dropped: {amount}', { amount: euro(person._feeWrittenOff) });
  return t('fee_reset_even', 'All paid up');
}

// The dots sit on the line, masked by a ring of the card's colour
const RING = 'absolute rounded-full border-2 border-surface shadow-[0_0_0_4px_var(--surface)]';

function TimelineItem(props: { entry: TimelineEntry; settled: boolean; person: Person }) {
  const date = () => formatDateFast(props.entry.dateStr);
  const title = () =>
    props.entry.type === 'status'
      ? `${t('timeline_status_change', 'Status Change')}: ${getStatusLabels(true)[props.entry.status as MemberStatus] || props.entry.status}`
      : `${t('timeline_payment', 'Payment')}: ${euro(props.entry.amount)}`;
  const meta = () =>
    props.entry.type === 'status'
      ? `${t('timeline_valid_from', 'Valid from')} ${date()}`
      : `${props.entry.description || t('timeline_no_note', 'No note')} • ${date()}`;
  return (
    <Show
      when={props.entry.type === 'reset'}
      fallback={
        <div class="relative mb-6 last:mb-0">
          <div class={[RING, 'top-1.5 -left-[31px] size-3', props.settled ? 'bg-border' : 'bg-primary']} />
          <div class={{ 'opacity-60': props.settled }}>
            <div class="font-semibold">{title()}</div>
            <div class="text-[0.85rem] text-text-secondary">{meta()}</div>
          </div>
        </div>
      }
    >
      <div class="relative mb-6 last:mb-0">
        <div class={[RING, 'top-2 -left-9 inline-flex size-[22px] items-center justify-center bg-warning text-white']} aria-hidden="true">
          <Icon name="rotate" size={12} strokeWidth={3} />
        </div>
        <div class="rounded-xl border border-[color-mix(in_srgb,var(--warning)_28%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] px-3 py-2">
          <div class="flex items-baseline justify-between gap-2.5 font-bold">
            <span>{t('fee_reset_timeline_title', 'Fresh start')}</span>
            <span class="shrink-0 text-[0.8rem] font-semibold text-text-secondary tabular-nums">{date()}</span>
          </div>
          <div class="text-[0.85rem] text-text-secondary">{feeResetOutcome(props.person)}</div>
        </div>
      </div>
    </Show>
  );
}

/** The history of [person]; "No entries found." without any. */
export function Timeline(props: { person: Person }) {
  const entries = createMemo(() => timelineEntries(props.person));
  const resetAt = () => entries().findIndex(entry => entry.type === 'reset');
  return (
    <Show when={entries().length > 0} fallback={<div class="text-[0.8rem] text-text-secondary italic">{t('timeline_no_entries', 'No entries found.')}</div>}>
      <div class="relative my-[15px] ml-2 border-l-2 border-border-light pl-6">
        <For each={entries()}>
          {(entry, index) => <TimelineItem entry={entry} settled={resetAt() >= 0 && index() > resetAt()} person={props.person} />}
        </For>
      </div>
    </Show>
  );
}
