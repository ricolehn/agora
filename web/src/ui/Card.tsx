import type { JSX } from '@solidjs/web';
import { Show } from 'solid-js';

/** A surface card (.card): hairline border, soft shadow; optional header with a title and an action on the right. */
export function Card(props: { title?: JSX.Element; action?: JSX.Element; class?: string; bodyClass?: string; id?: string; children?: JSX.Element }) {
  return (
    <div id={props.id} class={['mb-5 rounded-card border border-hairline bg-surface shadow-card dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),var(--shadow)]', props.class]}>
      <Show when={props.title || props.action}>
        <div class="flex items-center justify-between gap-3 px-5 pt-4">
          <div class="text-[1.05rem] font-bold">{props.title}</div>
          {props.action}
        </div>
      </Show>
      <div class={['p-5', props.bodyClass]}>{props.children}</div>
    </div>
  );
}
