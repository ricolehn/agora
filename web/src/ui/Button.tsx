import type { JSX } from '@solidjs/web';
import { omit } from 'solid-js';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'premium';
export type ButtonSize = 'md' | 'small' | 'tiny';

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width. */
  block?: boolean;
  /** Shows [busyText] (or the children) and disables the button while an action runs. */
  busy?: boolean;
  busyText?: JSX.Element;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-gradient-primary text-white shadow-brand hover:brightness-104',
  secondary: 'bg-surface text-text border border-hairline shadow-card hover:bg-surface-alt',
  danger: 'bg-danger text-white',
  ghost: 'bg-transparent text-text-secondary hover:bg-surface-alt',
  premium: 'bg-surface text-text border border-hairline'
};
const SIZE: Record<ButtonSize, string> = {
  md: 'px-5 py-3 text-[0.95rem] rounded-[14px]',
  small: 'px-3 py-2 text-[0.85rem] rounded-[10px]',
  tiny: 'px-2 py-1 text-[0.75rem] rounded-[8px]'
};

/** The app's button (.btn): primary, secondary, danger, ghost; small/tiny; block; busy. */
export function Button(props: ButtonProps) {
  const rest = omit(props, 'variant', 'size', 'block', 'busy', 'busyText', 'class', 'children', 'type', 'disabled');
  return (
    <button
      type={props.type ?? 'button'}
      disabled={props.disabled || props.busy}
      class={[
        'inline-flex items-center justify-center gap-2 font-semibold transition active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed',
        VARIANT[props.variant ?? 'primary'],
        SIZE[props.size ?? 'md'],
        { 'w-full': !!props.block },
        props.class
      ]}
      {...rest}
    >
      {props.busy && props.busyText !== undefined ? props.busyText : props.children}
    </button>
  );
}
