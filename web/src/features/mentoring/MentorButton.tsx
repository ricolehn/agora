// The mentoring's own primary button (.btn-mentor-primary): apply as a mentor, contact a mentor.
import type { JSX } from '@solidjs/web';
import { omit } from 'solid-js';

/** The mentoring's call to action (apply, contact a mentor): a pill in the brand gradient. */
export function MentorButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const rest = omit(props, 'class', 'type', 'children');
  return (
    <button
      type={props.type ?? 'button'}
      class={[
        'inline-flex min-w-0 items-center justify-center gap-2 rounded-full border-none bg-gradient-primary px-[22px] py-[11px] text-[0.9rem] font-[650] text-white',
        '[text-shadow:0_1px_1px_rgba(6,70,62,0.18)] shadow-[inset_0_1px_0_rgba(255,255,255,0.18),var(--shadow-brand)]',
        'dark:[text-shadow:none] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_1px_2px_rgba(0,0,0,0.45)]',
        '[transition:transform_0.15s_var(--ease),translate_0.15s_var(--ease),scale_0.15s_var(--ease),box-shadow_0.2s_var(--ease),background-color_0.2s_var(--ease),border-color_0.2s_var(--ease),filter_0.2s_var(--ease)]',
        'hover:-translate-y-px hover:bg-gradient-hover hover:[filter:brightness(1.04)_saturate(1.05)] enabled:active:scale-[0.97]',
        'focus-visible:shadow-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
        props.class
      ]}
      {...rest}
    >
      {props.children}
    </button>
  );
}
