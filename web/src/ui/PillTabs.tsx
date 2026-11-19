import type { JSX } from '@solidjs/web';
import { For, Show } from 'solid-js';

export interface PillOption<T extends string> {
  value: T;
  label: JSX.Element;
  icon?: JSX.Element;
  /** A count badge after the label (hidden when 0). */
  badge?: number;
  hidden?: boolean;
}

/** Segmented pill tabs (.pill-tabs / .pill-tab): finances, events, mentoring, system settings, login. */
export function PillTabs<T extends string>(props: {
  value: T;
  onChange: (value: T) => void;
  options: PillOption<T>[];
  class?: string;
  'aria-label'?: string;
}) {
  return (
    <div role="tablist" aria-label={props['aria-label']} class={['flex gap-1 rounded-full border border-hairline bg-surface-alt p-1 shadow-[inset_0_1px_2px_rgba(48,38,26,0.05)]', props.class]}>
      <For each={props.options.filter(o => !o.hidden)}>
        {option => (
          <button
            type="button"
            role="tab"
            aria-selected={props.value === option.value ? 'true' : 'false'}
            class={[
              'flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 text-[0.85rem] font-semibold transition',
              props.value === option.value ? 'bg-surface text-text shadow-[0_1px_2px_rgba(48,38,26,0.10),0_2px_8px_-2px_rgba(48,38,26,0.10)]' : 'text-text-secondary'
            ]}
            onClick={() => props.onChange(option.value)}
          >
            {option.icon}
            <span>{option.label}</span>
            <Show when={option.badge}>
              <span class="rounded-full bg-danger px-1.5 text-[0.7rem] text-white">{option.badge! > 99 ? '99+' : option.badge}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}
