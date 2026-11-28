import type { JSX } from '@solidjs/web';
import { createContext, createMemo, For, Show, useContext } from 'solid-js';
import { CountBadge } from './feedback';

type PillsKind = 'tabs' | 'radio';
// The row's kind as an accessor: a provider takes its value once, the pills follow the row through it
const PillsKindContext = createContext<() => PillsKind>(() => 'tabs');

// Right and down go to the next pill, left and up to the one before (round the row)
const ARROW_STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * A row of pills that picks one: `tabs` switch what is shown below them (a tablist), `radio` choose a value (a
 * radiogroup). Only the chosen pill is in the tab order, the arrow keys move between the pills and choose. How the
 * row and its pills look is the caller's (class): the rows of the app differ.
 */
export function Pills(props: {
  kind: PillsKind;
  class?: JSX.ClassValue;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  children: JSX.Element;
}) {
  const kind = createMemo(() => props.kind);
  const onKeyDown = (e: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const step = ARROW_STEPS[e.key];
    const pills = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"], [role="radio"]')];
    const at = pills.indexOf(document.activeElement as HTMLButtonElement);
    if (!step || at < 0) return;
    e.preventDefault();
    const next = pills[(at + step + pills.length) % pills.length];
    next.click();
    next.focus();
  };
  return (
    <PillsKindContext value={kind}>
      <div
        id={props.id}
        role={kind() === 'tabs' ? 'tablist' : 'radiogroup'}
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        class={props.class}
        onKeyDown={onKeyDown}
      >
        {props.children}
      </div>
    </PillsKindContext>
  );
}

/** One pill of <Pills>: a tab or a radio button as the row says, [chosen] or not. */
export function Pill(props: { chosen: boolean; onSelect: () => void; class?: JSX.ClassValue; id?: string; children: JSX.Element }) {
  const kind = useContext(PillsKindContext);
  return (
    <button
      type="button"
      role={kind() === 'tabs' ? 'tab' : 'radio'}
      id={props.id}
      aria-selected={kind() === 'tabs' ? (props.chosen ? 'true' : 'false') : undefined}
      aria-checked={kind() === 'radio' ? (props.chosen ? 'true' : 'false') : undefined}
      tabindex={props.chosen ? 0 : -1}
      class={props.class}
      onClick={() => props.onSelect()}
    >
      {props.children}
    </button>
  );
}

export interface PillOption<T extends string> {
  value: T;
  label: JSX.Element;
  icon?: JSX.Element;
  /** A count after the label (hidden when 0; "99+" above 99). */
  badge?: number;
  /** The badge in red (pending applications) instead of the brand colour (unread messages). */
  badgeDanger?: boolean;
  hidden?: boolean;
  id?: string;
}

// The segments of Finances and Events (.finance-subnav-btn / .events-subnav-segment): sharing the width
const DEFAULT_TAB = 'inline-flex flex-1 items-center justify-center gap-2 px-[14px] py-[7px] text-88 [&_svg]:size-[15px]';

/**
 * Segmented pill tabs (.pill-tabs / .pill-tab): a soft track, the chosen tab as a raised white pill.
 * The tabs are sized like the Finances and Events segments; `tabClass` replaces that sizing for the other rows, e.g.
 * - sign-in (.auth-tab-btn): 'flex-1 p-[10px] text-95'
 * - mentoring (.mentoring-nav-segment): 'flex flex-[1_1_0] min-w-0 items-center justify-center gap-1.5 px-2 py-2 text-90
 *   whitespace-nowrap overflow-hidden text-ellipsis max-mini:px-1 max-mini:text-82 [&_svg]:size-[15px]'
 * - system settings (.sys-subnav-btn): 'flex items-center gap-1.5 px-[14px] py-2 text-88'
 */
export function PillTabs<T extends string>(props: {
  value: T;
  onChange: (value: T) => void;
  options: PillOption<T>[];
  class?: string;
  tabClass?: string;
  'aria-label'?: string;
}) {
  return (
    <Pills
      kind="tabs"
      aria-label={props['aria-label']}
      class={[
        'flex gap-[3px] rounded-full border border-hairline bg-surface-alt p-[3px] shadow-[inset_0_1px_2px_rgba(48,38,26,0.05)] dark:border-white/5 dark:bg-white/8',
        props.class
      ]}
    >
      <For each={props.options.filter(o => !o.hidden)}>
        {option => (
          <Pill
            id={option.id}
            chosen={props.value === option.value}
            class={[
              'cursor-pointer rounded-full border-0 select-none [transition:background-color_0.2s_var(--ease),color_0.2s_var(--ease),box-shadow_0.2s_var(--ease)]',
              'focus-visible:shadow-ring focus-visible:outline-none',
              props.tabClass ?? DEFAULT_TAB,
              props.value === option.value
                ? 'bg-surface font-bold text-text shadow-[0_1px_2px_rgba(48,38,26,0.10),0_2px_8px_-2px_rgba(48,38,26,0.10),0_0_0_0.5px_rgba(48,38,26,0.06)] dark:bg-surface-alt dark:shadow-[0_2px_8px_rgba(0,0,0,0.3)]'
                : 'bg-transparent font-semibold text-text-secondary hover:text-text'
            ]}
            onSelect={() => props.onChange(option.value)}
          >
            {option.icon}
            <span>{option.label}</span>
            <Show when={option.badge}>
              <CountBadge count={option.badge!} danger={option.badgeDanger} />
            </Show>
          </Pill>
        )}
      </For>
    </Pills>
  );
}
