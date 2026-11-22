// The plan card of the event dialog: collapsed (title, "x of y filled", bar), opened the order of service as a
// timeline and the tasks without a time in their own box. Editors tap a row to open its entry, "+" adds one.
import type { JSX } from '@solidjs/web';
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { t } from '../../../app/i18n';
import { groupBy } from '../../../app/util';
import { Icon } from '../../../ui/Icon';
import { appEvents, type AppEvent } from '../store';
import { openPlanEntry } from './entry';
import { PlanAnswer, PlanNames } from './PlanPeople';
import {
  clearShownPlan, filledDuties, itemTask, loadProgram, openProgramSong, planHeader, programItems, programItemTitle, programMinutes,
  programSong, programTimes, roleOf, sameName, setShownPlan, type Duty, type ProgramItem
} from './program';

interface RowData {
  key: string;
  /** In the order of service: its time (or place) and duration. */
  time?: string;
  minutes?: number | null;
  item?: ProgramItem;
  role: string | null;
  duties: Duty[];
  note: string;
  /** A name typed under "who" that is no task of the roster. */
  who?: string;
}

/** The rows of the plan: the order of service, then the tasks no item of the order stands for. */
function planRows(ev: AppEvent, items: ProgramItem[]) {
  const grouped = groupBy<Duty, string>(ev.duties || [], roleOf);
  const roles = [...grouped.keys()];
  const used = new Set<string>();
  const times = programTimes(items, ev.startTime);
  const order: RowData[] = items.map((item, i) => {
    const role = itemTask(item, roles);
    if (role) used.add(role);
    const who = !role && item.who && !sameName(item.who, programItemTitle(item)) ? item.who : undefined;
    return {
      key: `item:${item.id || i}`, item, role, duties: role ? grouped.get(role)! : [], note: item.note || '', who,
      time: (item.minutes && times[i]) || `${i + 1}.`, minutes: item.minutes
    };
  });
  const tasks: RowData[] = [...grouped].filter(([role]) => !used.has(role)).map(([role, duties]) => ({
    key: `role:${role}`, role, duties, note: duties.find(d => d.notes)?.notes || ''
  }));
  return { order, tasks };
}

/** The roster symbol (a sheet with lines). */
const RosterIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="9" y1="9" x2="15" y2="9" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);

function PlanRow(props: {
  row: RowData;
  editable: boolean;
  timeline: boolean;
  first: boolean;
  boxed: boolean;
  onOpen: () => void;
  onAnswered: () => void;
}) {
  const song = () => (props.row.item ? programSong(props.row.item) : null);
  const songKey = () => props.row.item?.songKey || song()?.key || '';
  const title = () => (props.row.item ? programItemTitle(props.row.item) : props.row.role);
  const inOrder = () => props.row.time !== undefined;
  const onKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.currentTarget.click();
    }
  };
  return (
    <div
      class={[
        'relative -mx-1.5 grid items-start rounded-[10px] px-1.5 py-2',
        inOrder() ? 'grid-cols-[62px_minmax(0,1fr)] gap-1.5' : 'grid-cols-[minmax(0,1fr)] gap-2.5',
        {
          // Timeline: a line through the times with a dot at each item - reads as one sequence
          "before:absolute before:top-0 before:bottom-0 before:left-2.5 before:w-0.5 before:bg-[rgba(2,132,199,0.18)] before:content-[''] first-of-type:before:top-4 last:before:bottom-[calc(100%-16px)] after:absolute after:top-3 after:left-1.5 after:size-2.5 after:rounded-full after:border-2 after:border-[#0284c7] after:bg-surface after:content-[''] dark:after:border-[#38bdf8]":
            props.timeline,
          // Tasks: a hairline between the rows
          "before:absolute before:top-0 before:right-1.5 before:left-1.5 before:h-px before:bg-border-light before:content-['']": !props.timeline && !props.first,
          'cursor-pointer transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary': props.editable,
          'hover:bg-surface-alt': props.editable && !props.boxed,
          'hover:bg-surface': props.editable && props.boxed
        }
      ]}
      role={props.editable ? 'button' : undefined}
      tabindex={props.editable ? 0 : undefined}
      onClick={() => props.editable && props.onOpen()}
      onKeyDown={e => props.editable && onKeyDown(e)}
    >
      <Show when={inOrder()}>
        <span
          class={[
            'flex flex-col pt-px text-[0.86rem] leading-[1.35] font-extrabold tabular-nums',
            /:/.test(props.row.time!) ? 'text-[#0284c7] dark:text-[#38bdf8]' : 'text-text-secondary',
            { 'pl-4': props.timeline }
          ]}
        >
          {props.row.time}
          <Show when={props.row.minutes}>
            <small class="text-[0.7rem] font-semibold text-text-secondary">{programMinutes(props.row.minutes!)}</small>
          </Show>
        </span>
      </Show>
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="min-w-0 text-[0.95rem] font-bold break-words text-text">
          <Show when={song()} fallback={title()}>
            <button
              type="button"
              class="inline-flex max-w-full cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-left text-[0.95rem] font-bold text-text"
              onClick={e => {
                e.stopPropagation();
                openProgramSong(props.row.item!);
              }}
            >
              <span class="break-words underline decoration-[rgba(8,145,178,0.45)] underline-offset-[3px]">{title()}</span>
              <Show when={songKey()}>
                <ProgramKey value={songKey()} />
              </Show>
            </button>
          </Show>
        </span>
        <span class="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[0.84rem] text-text">
          <Show
            when={props.row.role}
            fallback={
              <Show when={props.row.who} fallback={<span class="text-[0.8rem] text-text-secondary opacity-80">{t('plan_open_short', 'open')}</span>}>
                <span class="inline-flex items-center gap-[5px] whitespace-nowrap text-[0.82rem] font-semibold text-text-secondary">{props.row.who}</span>
              </Show>
            }
          >
            <PlanNames duties={props.row.duties} />
          </Show>
        </span>
        <Show when={props.row.note}>
          <span class="text-[0.8rem] whitespace-pre-wrap text-text-secondary italic [overflow-wrap:anywhere]">{props.row.note}</span>
        </Show>
        <PlanAnswer duties={props.row.duties} onAnswered={props.onAnswered} />
      </span>
    </div>
  );
}

/** The key of a song (a small pill). */
export function ProgramKey(props: { value: string }) {
  return <span class="shrink-0 rounded-full bg-brand/12 px-2 py-px text-[0.72rem] font-extrabold text-brand-deep">{props.value}</span>;
}

/** The plan of an event (duty roster and order of service) for those who may see it. */
export function EventPlan(props: { event: AppEvent }) {
  // The freshest copy of the event (the list reloads after every change)
  const ev = createMemo(() => appEvents().find(e => e.id === props.event?.id) ?? props.event);
  const planId = createMemo(() => (ev()?.canAccessDutyPlan ? ev().id : ''));
  createEffect(planId, id => {
    if (!id) return;
    setShownPlan(id);
    void loadProgram(id);
    return () => clearShownPlan(id);
  });
  const [open, setOpen] = createSignal(false);
  const items = () => programItems(ev()?.id);
  const duties = (): Duty[] => ev()?.duties || [];
  const header = () => planHeader(ev(), items());
  const filled = () => filledDuties(duties());
  const rows = createMemo(() => planRows(ev(), items()));
  const editable = () => !!ev()?.canEdit;
  const both = () => rows().order.length > 0 && rows().tasks.length > 0;
  // An answered request closes the card again: its summary shows the new state
  const collapse = () => setOpen(false);

  return (
    <Show when={ev()?.canAccessDutyPlan}>
      <div id="detail-modal-duties-box">
        <details
          id="detail-modal-duties-details"
          class="rounded-[20px] border border-border-light bg-surface px-4 py-[14px] shadow-card"
          open={open()}
          onToggle={e => setOpen(e.currentTarget.open)}
        >
          <summary class="flex min-w-0 cursor-pointer list-none items-center gap-3 select-none [&::-webkit-details-marker]:hidden">
            <div class="flex size-[38px] shrink-0 items-center justify-center rounded-xl bg-[rgba(99,102,241,0.14)] text-[#6366f1] dark:text-[#818cf8]">
              <RosterIcon />
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-[1rem] font-extrabold text-text">{header().title}</span>
              <span class="text-[0.82rem] text-text-secondary">{header().meta}</span>
            </div>
            <span class={['inline-flex text-text-secondary transition-transform duration-200 ease-in-out', { 'rotate-180': open() }]}>
              <Icon name="chevronDown" size={14} strokeWidth={2.5} />
            </span>
          </summary>
          <Show when={duties().length}>
            <div class="mt-3 h-1.5 overflow-hidden rounded-full border border-border-light bg-surface-alt">
              <div
                class={[
                  'h-full rounded-full transition-[width] duration-300 ease-in-out',
                  filled() === duties().length ? 'bg-gradient-primary' : 'bg-[linear-gradient(90deg,#818cf8_0%,#6366f1_100%)]'
                ]}
                style={{ width: `${Math.round((filled() / duties().length) * 100)}%` }}
              />
            </div>
          </Show>
          <div class="mt-1.5 flex flex-col">
            <Show
              when={rows().order.length || rows().tasks.length}
              fallback={
                <div class="pt-2.5 pb-1 text-[0.86rem] text-text-secondary">
                  {editable() ? t('plan_empty_manager', 'Add what happens and who helps – with “+” below.') : t('duty_empty_member', 'No duties for this event.')}
                </div>
              }
            >
              <div class="flex flex-col gap-2.5">
                <Show when={rows().order.length}>
                  <div class="flex flex-col">
                    <Show when={both()}>
                      <div class="mb-1 flex items-center gap-2 text-[0.74rem] font-extrabold tracking-[0.06em] text-[#0284c7] uppercase dark:text-[#38bdf8]">
                        <Icon name="clock" size={15} strokeWidth={2.2} class="shrink-0" />
                        <span>{t('plan_group_program', 'Order of service')}</span>
                      </div>
                    </Show>
                    <For each={rows().order} keyed={row => row.key}>
                      {row => (
                        <PlanRow
                          row={row()}
                          editable={editable()}
                          timeline
                          first={false}
                          boxed={false}
                          onOpen={() => openPlanEntry(ev(), { mode: 'edit', itemId: row().item!.id })}
                          onAnswered={collapse}
                        />
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={rows().tasks.length}>
                  <div class={['flex flex-col', { 'rounded-[14px] bg-surface-alt px-2.5 py-0.5': both() }]}>
                    <For each={rows().tasks} keyed={row => row.key}>
                      {(row, i) => (
                        <PlanRow
                          row={row()}
                          editable={editable()}
                          timeline={false}
                          first={i() === 0}
                          boxed={both()}
                          onOpen={() => openPlanEntry(ev(), { mode: 'edit', role: row().role! })}
                          onAnswered={collapse}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
          <Show when={editable()}>
            <div class="mt-1.5">
              <button
                type="button"
                id="detail-btn-add-duty"
                class="inline-flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border-[1.5px] border-dashed border-border bg-transparent p-2.5 text-[0.88rem] font-bold text-text-secondary hover:border-primary hover:text-primary"
                onClick={() => openPlanEntry(ev(), { mode: 'new' })}
              >
                <Icon name="plus" size={15} strokeWidth={2.5} />
                <span>{t('plan_add_entry', 'Add entry')}</span>
              </button>
            </div>
          </Show>
        </details>
      </div>
    </Show>
  );
}
