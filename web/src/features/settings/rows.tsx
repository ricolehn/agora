// The rows of the settings (menu, account page): a symbol in its colour, a title with a second line, a chevron. The
// rows of a card are divided by a hairline that starts at the text, not at the edge.
import type { JSX } from '@solidjs/web';
import { Show } from 'solid-js';
import { Icon, type IconName } from '../../ui/Icon';

/** A row (button or link); --row-color tints its symbol. A row right after another one draws the divider. */
export const ROW = [
  'relative flex w-full min-w-0 items-center gap-3.5 px-4 py-3.5 text-left hover:bg-surface-alt',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
  "[&+&]:before:absolute [&+&]:before:top-0 [&+&]:before:right-0 [&+&]:before:left-[72px] [&+&]:before:h-px [&+&]:before:bg-hairline [&+&]:before:content-['']"
];
/** A row in the danger colour (sign out, delete account). */
export const DANGER_ROW = [ROW, 'text-danger [--row-color:var(--danger)]'];

/** A card of rows. */
export function RowCard(props: { class?: string; children?: JSX.Element }) {
  return (
    <div class={['overflow-hidden rounded-card border border-hairline bg-surface shadow-card dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),var(--shadow)]', props.class]}>
      {props.children}
    </div>
  );
}

export function RowIcon(props: { name: IconName }) {
  return (
    <span class="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--row-color)_13%,transparent)] text-[color:var(--row-color)]">
      <Icon name={props.name} size={20} />
    </span>
  );
}

export function RowText(props: { title: JSX.Element; desc?: JSX.Element }) {
  return (
    <span class="flex min-w-0 flex-1 flex-col gap-px">
      <span class="truncate text-[0.95rem] font-bold">{props.title}</span>
      <Show when={props.desc}>
        <span class="line-clamp-2 text-[0.8rem] text-text-secondary">{props.desc}</span>
      </Show>
    </span>
  );
}

export function RowChevron() {
  return <Icon name="chevronRight" size={18} strokeWidth={2.5} class="shrink-0 text-text-secondary opacity-60" />;
}
