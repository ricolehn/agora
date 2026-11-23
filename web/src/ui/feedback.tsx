import type { JSX } from '@solidjs/web';
import { Show } from 'solid-js';
import { t } from '../app/i18n';
import { Icon } from './Icon';

/**
 * The app's spinner (.spinner): a faint ring with a teal arc and two more arcs turning at their own pace.
 * size in px (60); stroke: the outer ring's width (4). 15px below it, as before (yields to `class`).
 */
export function Spinner(props: { size?: number; stroke?: number; class?: string }) {
  const size = () => props.size ?? 60;
  return (
    <div
      class={[
        'relative shrink-0 rounded-full border-solid border-[rgba(13,158,148,0.1)] border-l-primary animate-[spin_1s_linear_infinite] weak:mb-[15px]',
        "before:absolute before:-inset-1 before:rounded-full before:border-4 before:border-solid before:border-transparent before:border-t-secondary before:content-[''] before:animate-[spin_2s_linear_infinite_reverse]",
        "after:absolute after:inset-[6px] after:rounded-full after:border-4 after:border-solid after:border-transparent after:border-r-primary-dark after:content-[''] after:animate-[spin_1.5s_linear_infinite]",
        props.class
      ]}
      style={{ width: `${size()}px`, height: `${size()}px`, 'border-width': `${props.stroke ?? 4}px` }}
      role="progressbar"
      aria-busy="true"
      aria-label={t('loading', 'Loading data...')}
    />
  );
}

/** A placeholder bar while something loads (.skeleton): a soft shimmer; 4px corners (yield to `class`). */
export function Skeleton(props: { class?: string; style?: JSX.CSSProperties }) {
  return (
    <div
      class={[
        'animate-skeleton bg-[linear-gradient(90deg,var(--surface-alt)_25%,rgba(var(--brand-rgb),0.05)_50%,var(--surface-alt)_75%)] bg-[length:400%_100%] weak:rounded-[4px]',
        props.class
      ]}
      style={props.style}
    />
  );
}

/**
 * An empty list (.polls-empty): a soft card with a round symbol (amber by default; iconClass: its tint), a title,
 * a calm line and an action (e.g. "Try again").
 */
export function EmptyState(props: { icon?: JSX.Element; iconClass?: string; title?: JSX.Element; text?: JSX.Element; action?: JSX.Element; class?: string }) {
  return (
    <div class={['flex flex-col items-center gap-2 rounded-[20px] border border-hairline bg-surface px-5 py-10 text-center text-text-secondary shadow-card', props.class]}>
      <Show when={props.icon}>
        <span class={['mb-1.5 inline-flex size-[52px] items-center justify-center rounded-full', props.iconClass ?? 'bg-[rgba(245,158,11,0.13)] text-[#d97706]']}>
          {props.icon}
        </span>
      </Show>
      <Show when={props.title}>
        <span class="font-[650] tracking-[-0.015em] text-text">{props.title}</span>
      </Show>
      <Show when={props.text}>
        <span class="text-[0.84rem]">{props.text}</span>
      </Show>
      {props.action}
    </div>
  );
}

/** A search field (.search-bar-wrapper with .search-input): a rounded field with the magnifier, 12px below it. */
export function SearchInput(props: {
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  class?: string;
  inputClass?: string;
  id?: string;
  'aria-label'?: string;
}) {
  return (
    <div class={['group relative weak:mb-3', props.class]}>
      <span class="pointer-events-none absolute top-1/2 left-3.5 z-[2] flex -translate-y-1/2 items-center justify-center text-text-secondary transition-colors duration-200 group-focus-within:text-primary">
        <Icon name="magnifier" size={18} strokeWidth={2.5} />
      </span>
      <input
        id={props.id}
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props['aria-label'] ?? props.placeholder}
        class={[
          'w-full rounded-full border border-hairline bg-surface-alt py-2.5 pr-4 pl-[42px] text-[0.92rem] text-text shadow-card outline-none',
          '[transition:border-color_0.2s_var(--ease),box-shadow_0.2s_var(--ease),background-color_0.2s_var(--ease)] focus:shadow-[inset_0_0_0_1px_var(--primary)]',
          props.inputClass
        ]}
        onInput={e => props.onInput(e.currentTarget.value)}
      />
    </div>
  );
}

/**
 * A count on a navigation entry or a tab (.mentoring-badge-count): nothing at 0, "99+" above 99. The brand colour,
 * or red (danger). Its size yields to `class`.
 */
/** A count as a badge shows it: "99+" above 99. */
export const badgeText = (count: number) => (count > 99 ? '99+' : String(count));

export function CountBadge(props: { count: number; danger?: boolean; class?: string }) {
  return (
    <Show when={props.count > 0}>
      <span
        class={[
          'inline-flex shrink-0 items-center justify-center rounded-full leading-none font-bold whitespace-nowrap text-white tabular-nums',
          'weak:h-[18px] weak:min-w-[18px] weak:px-[5px] weak:text-[0.7rem] weak:shadow-[0_2px_5px_rgba(var(--glow-rgb),0.35)]',
          props.danger ? 'bg-[#ef4444]' : 'bg-primary',
          props.class
        ]}
      >
        {badgeText(props.count)}
      </span>
    </Show>
  );
}
