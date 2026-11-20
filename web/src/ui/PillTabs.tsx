import type { JSX } from '@solidjs/web';
import { For, Show } from 'solid-js';
import { CountBadge } from './feedback';

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
const DEFAULT_TAB = 'inline-flex flex-1 items-center justify-center gap-2 px-[14px] py-[7px] text-[0.88rem] [&_svg]:size-[15px]';

/**
 * Segmented pill tabs (.pill-tabs / .pill-tab): a soft track, the chosen tab as a raised white pill.
 * The tabs are sized like the Finances and Events segments; `tabClass` replaces that sizing for the other rows, e.g.
 * - sign-in (.auth-tab-btn): 'flex-1 p-[10px] text-[0.95rem]'
 * - mentoring (.mentoring-nav-segment): 'flex flex-[1_1_0] min-w-0 items-center justify-center gap-1.5 px-2 py-2 text-[0.9rem]
 *   whitespace-nowrap overflow-hidden text-ellipsis max-[480px]:px-1 max-[480px]:text-[0.82rem] [&_svg]:size-[15px]'
 * - system settings (.sys-subnav-btn): 'flex items-center gap-1.5 px-[14px] py-2 text-[0.88rem]'
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
    <div
      role="tablist"
      aria-label={props['aria-label']}
      class={[
        'flex gap-[3px] rounded-full border border-hairline bg-surface-alt p-[3px] shadow-[inset_0_1px_2px_rgba(48,38,26,0.05)] dark:border-white/5 dark:bg-white/8',
        props.class
      ]}
    >
      <For each={props.options.filter(o => !o.hidden)}>
        {option => (
          <button
            type="button"
            role="tab"
            id={option.id}
            aria-selected={props.value === option.value ? 'true' : 'false'}
            class={[
              'cursor-pointer rounded-full border-0 select-none [transition:background-color_0.2s_var(--ease),color_0.2s_var(--ease),box-shadow_0.2s_var(--ease)]',
              'focus-visible:shadow-ring focus-visible:outline-none',
              props.tabClass ?? DEFAULT_TAB,
              props.value === option.value
                ? 'bg-surface font-bold text-text shadow-[0_1px_2px_rgba(48,38,26,0.10),0_2px_8px_-2px_rgba(48,38,26,0.10),0_0_0_0.5px_rgba(48,38,26,0.06)] dark:bg-surface-alt dark:shadow-[0_2px_8px_rgba(0,0,0,0.3)]'
                : 'bg-transparent font-semibold text-text-secondary hover:text-text'
            ]}
            onClick={() => props.onChange(option.value)}
          >
            {option.icon}
            <span>{option.label}</span>
            <Show when={option.badge}>
              <CountBadge count={option.badge!} danger={option.badgeDanger} />
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}
