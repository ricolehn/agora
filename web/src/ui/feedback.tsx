import type { JSX } from '@solidjs/web';
import { Show } from 'solid-js';
import { Icon } from './Icon';

/** The app's spinner (three turning rings in the brand colours). */
export function Spinner(props: { size?: number; class?: string }) {
  const size = () => props.size ?? 60;
  return (
    <div
      class={['animate-spin rounded-full border-4 border-brand/10 border-l-primary', props.class]}
      style={{ width: `${size()}px`, height: `${size()}px` }}
      role="progressbar"
      aria-busy="true"
    />
  );
}

/** A grey placeholder bar while something loads (.skeleton). */
export function Skeleton(props: { class?: string; style?: JSX.CSSProperties }) {
  return <div class={['animate-pulse rounded-lg bg-surface-alt', props.class]} style={props.style} />;
}

/** An empty list: a soft card with a calm text (and an optional symbol and action). */
export function EmptyState(props: { icon?: JSX.Element; title?: JSX.Element; text?: JSX.Element; action?: JSX.Element; class?: string }) {
  return (
    <div class={['rounded-card border border-hairline bg-surface px-5 py-8 text-center text-text-secondary shadow-card', props.class]}>
      <Show when={props.icon}>
        <div class="mb-2 flex justify-center text-text-secondary">{props.icon}</div>
      </Show>
      <Show when={props.title}>
        <div class="mb-1 font-semibold text-text">{props.title}</div>
      </Show>
      <Show when={props.text}>
        <div class="text-[0.9rem]">{props.text}</div>
      </Show>
      <Show when={props.action}>
        <div class="mt-4">{props.action}</div>
      </Show>
    </div>
  );
}

/** A search field with the magnifier (and a clear button while it has text). */
export function SearchInput(props: { value: string; onInput: (value: string) => void; placeholder?: string; class?: string; id?: string; 'aria-label'?: string }) {
  return (
    <div class={['relative', props.class]}>
      <span class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary">
        <Icon name="search" size={18} />
      </span>
      <input
        id={props.id}
        type="search"
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props['aria-label'] ?? props.placeholder}
        class="w-full rounded-full border border-hairline bg-surface py-3 pl-11 pr-10 text-[0.95rem] text-text shadow-card outline-none focus:border-primary focus:shadow-ring"
        onInput={e => props.onInput(e.currentTarget.value)}
      />
      <Show when={props.value}>
        <button
          type="button"
          class="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-text-secondary hover:bg-surface-alt"
          aria-label="Clear"
          onClick={() => props.onInput('')}
        >
          <Icon name="x" size={16} />
        </button>
      </Show>
    </div>
  );
}
