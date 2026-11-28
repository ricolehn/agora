import type { JSX } from '@solidjs/web';
import { Show } from 'solid-js';

/**
 * A surface card (.card): 20px corners, hairline border, soft shadow, 20px below it. An optional header
 * (.card-header: title, an action on the right) and the body (.card-body). Margin and paddings yield to `class`,
 * `headerClass` and `bodyClass` (e.g. bodyClass="p-0").
 */
export function Card(props: {
  title?: JSX.Element;
  action?: JSX.Element;
  class?: string;
  headerClass?: string;
  bodyClass?: string;
  id?: string;
  children?: JSX.Element;
}) {
  return (
    <div
      id={props.id}
      class={[
        'overflow-hidden weak:rounded-card border weak:border-hairline bg-surface shadow-card weak:mb-5',
        'dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),var(--shadow)]',
        '[transition:transform_0.3s_cubic-bezier(0.25,1,0.5,1),opacity_0.3s_cubic-bezier(0.25,1,0.5,1),box-shadow_0.3s_cubic-bezier(0.25,1,0.5,1),background-color_0.3s_cubic-bezier(0.25,1,0.5,1),border-color_0.3s_cubic-bezier(0.25,1,0.5,1),color_0.3s_cubic-bezier(0.25,1,0.5,1)]',
        props.class
      ]}
    >
      <Show when={props.title || props.action}>
        <div
          class={[
            'text-110 font-extrabold text-text weak:px-5 weak:pt-5 weak:pb-[5px]',
            { 'flex items-center justify-between gap-3': !!props.action },
            props.headerClass
          ]}
        >
          <Show when={props.action} fallback={props.title}>
            <div>{props.title}</div>
            {props.action}
          </Show>
        </div>
      </Show>
      <div class={['weak:px-5 weak:pt-2.5 weak:pb-5', props.bodyClass]}>{props.children}</div>
    </div>
  );
}
