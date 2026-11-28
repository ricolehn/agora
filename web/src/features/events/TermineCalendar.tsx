// "Termine" on desktop: a month calendar beside the appointment list. Days with entries get one dot per category;
// a tap jumps the list to that day.
import { For, Show, createMemo, createSignal } from 'solid-js';
import { monthYearFormatter, t } from '../../app/i18n';
import { getTodayStr, toDateStr } from '../../app/util';
import { Icon } from '../../ui/Icon';
import { weekdayShort, type EventCategory } from './format';

const DOT: Record<EventCategory, string> = { pinned: 'bg-[#6366f1]', event: 'bg-brand', termin: 'bg-[#a8a29e]' };
const LEGEND: Array<[EventCategory, () => string]> = [
  ['termin', () => t('detail_groups_termin', 'Appointment')],
  ['event', () => t('detail_groups_event', 'Event')],
  ['pinned', () => t('events_major_event', 'Major event')]
];

function Dot(props: { category: EventCategory; selected?: boolean }) {
  return <span class={['size-1.5 shrink-0 rounded-full', props.selected ? 'bg-white' : DOT[props.category]]} />;
}

function CalendarDay(props: { day: string; num: number; categories?: Set<EventCategory>; selected: boolean; onPick: (day: string) => void }) {
  const isPast = () => props.day < getTodayStr();
  const isToday = () => props.day === getTodayStr();
  return (
    <button
      type="button"
      class={[
        'relative flex aspect-square min-w-0 flex-col items-center justify-center gap-[3px] rounded-xl text-[0.9rem] transition-[background,color] duration-150',
        props.categories ? 'font-extrabold' : 'font-semibold',
        props.selected
          ? 'bg-primary text-white'
          : isPast()
            ? 'cursor-default text-text-secondary opacity-45'
            : [isToday() ? 'text-primary shadow-[inset_0_0_0_2px_var(--primary)]' : 'text-text', 'hover:bg-surface-alt']
      ]}
      disabled={isPast()}
      onClick={() => props.onPick(props.day)}
    >
      <span class="leading-none">{props.num}</span>
      <Show when={props.categories}>
        {cats => (
          <span class="flex h-1.5 gap-[3px]">
            <For each={(['pinned', 'event', 'termin'] as EventCategory[]).filter(cat => cats().has(cat))}>
              {cat => <Dot category={cat} selected={props.selected} />}
            </For>
          </span>
        )}
      </Show>
    </button>
  );
}

// The month shown (the current one at first); it stays while the tab switches between appointments and events
const [month, setMonth] = createSignal<Date | null>(null);

/** days: the categories on each day with entries. onPick: a day was chosen (the list scrolls there). */
export function TermineCalendar(props: { days: Map<string, Set<EventCategory>>; selected: string | null; onPick: (day: string) => void }) {
  const today = () => getTodayStr();
  const thisMonth = () => {
    const [y, m] = today().split('-').map(Number);
    return new Date(y, m - 1, 1);
  };
  const shown = () => month() ?? thisMonth();
  const atCurrentMonth = () => shown().getFullYear() === thisMonth().getFullYear() && shown().getMonth() === thisMonth().getMonth();
  const shift = (delta: number) => setMonth(new Date(shown().getFullYear(), shown().getMonth() + delta, 1));
  const cells = createMemo(() => {
    const year = shown().getFullYear();
    const m = shown().getMonth();
    const lead = (new Date(year, m, 1).getDay() + 6) % 7;
    const count = new Date(year, m + 1, 0).getDate();
    return [
      ...Array.from({ length: lead }, (_, i) => ({ num: -i, day: '' })),
      ...Array.from({ length: count }, (_, i) => ({ num: i + 1, day: toDateStr(new Date(year, m, i + 1)) }))
    ];
  });
  return (
    <aside
      class={[
        'sticky top-0 hidden rounded-[20px] border border-border-light bg-surface p-[18px] shadow-[0_1px_2px_rgba(28,25,23,0.04),0_8px_22px_-14px_rgba(28,25,23,0.25)] transition-[top] duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] lg:block',
        // The header slides away while scrolling down: the calendar follows it up
        'header-hidden:top-[calc(20px-var(--desktop-header-offset))]'
      ]}
      aria-label={t('events_calendar', 'Calendar')}
    >
      <div class="mb-3 flex items-center justify-between gap-2">
        <button
          type="button"
          class="inline-flex size-[34px] items-center justify-center rounded-[11px] border border-border-light bg-surface-alt text-text enabled:hover:border-primary enabled:hover:text-primary disabled:cursor-default disabled:opacity-35"
          disabled={atCurrentMonth()}
          aria-label={t('events_calendar_prev', 'Previous month')}
          onClick={() => shift(-1)}
        >
          <Icon name="chevronLeft" size={18} strokeWidth={2.5} />
        </button>
        <span class="text-[1.02rem] font-extrabold capitalize text-text">{monthYearFormatter.format(shown())}</span>
        <button
          type="button"
          class="inline-flex size-[34px] items-center justify-center rounded-[11px] border border-border-light bg-surface-alt text-text hover:border-primary hover:text-primary"
          aria-label={t('events_calendar_next', 'Next month')}
          onClick={() => shift(1)}
        >
          <Icon name="chevronRight" size={18} strokeWidth={2.5} />
        </button>
      </div>
      <div class="grid grid-cols-7 gap-1">
        <For each={[1, 2, 3, 4, 5, 6, 0]}>
          {index => <span class="pb-1.5 text-center text-[0.7rem] font-extrabold uppercase tracking-[0.04em] text-text-secondary">{weekdayShort(index)}</span>}
        </For>
        <For each={cells()}>
          {cell => (cell.day ? <CalendarDay day={cell.day} num={cell.num} categories={props.days.get(cell.day)} selected={cell.day === props.selected} onPick={props.onPick} /> : <span class="aspect-square min-w-0 rounded-xl" />)}
        </For>
      </div>
      <div class="mt-3.5 flex flex-wrap gap-x-3.5 gap-y-1.5 border-t border-border-light pt-3 text-[0.78rem] font-semibold text-text-secondary">
        <For each={LEGEND}>
          {([category, label]) => (
            <span class="inline-flex items-center gap-1.5">
              <Dot category={category} />
              {label()}
            </span>
          )}
        </For>
      </div>
    </aside>
  );
}
