import type { JSX } from '@solidjs/web';
import { omit, useContext } from 'solid-js';
import { DialogBodyContext } from './context';

/**
 * primary (.btn-primary), secondary (.btn-secondary), danger (.btn-danger: a red tint with red text), danger-solid
 * (the red button of the delete confirmations: .btn-danger made solid there), ghost (.btn-ghost), premium
 * (.btn-premium-action: the invite card's quiet actions), none (only the .btn base: colours from `class`).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'danger-solid' | 'ghost' | 'premium' | 'none';
/** md (.btn), small (.btn-small), tiny (.btn-tiny). */
export type ButtonSize = 'md' | 'small' | 'tiny';

export interface ButtonLook {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width (.btn-block). */
  block?: boolean;
  /** The compact dialog button (40px high, smaller type): automatic for block buttons in a dialog's body. */
  compact?: boolean;
}

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement>, ButtonLook {
  /** Shows [busyText] (or the children) and disables the button while an action runs. */
  busy?: boolean;
  busyText?: JSX.Element;
}

// .btn: the press, the keyboard ring, the disabled state (a disabled button still gives a little when pressed)
const BASE =
  'inline-flex items-center justify-center gap-2 font-semibold cursor-pointer ' +
  '[transition:transform_0.15s_var(--ease),scale_0.15s_var(--ease),translate_0.15s_var(--ease),box-shadow_0.2s_var(--ease),background-color_0.2s_var(--ease),border-color_0.2s_var(--ease),color_0.2s_var(--ease),filter_0.2s_var(--ease)] ' +
  'active:enabled:scale-[0.97] active:disabled:scale-95 focus-visible:outline-none focus-visible:shadow-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const SIZE: Record<ButtonSize, string> = {
  md: 'px-5 py-3 text-[0.95rem]',
  small: 'px-4 py-2 text-[0.85rem]',
  tiny: 'px-1.5 py-0.5 text-[0.74rem]'
};

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-gradient-primary text-white [text-shadow:0_1px_1px_rgba(6,70,62,0.18)] hover:enabled:brightness-[1.04] hover:enabled:saturate-[1.05] ' +
    'dark:[text-shadow:none]',
  secondary: 'border border-hairline bg-surface text-text shadow-card hover:enabled:bg-surface-alt',
  danger: 'bg-[rgba(239,68,68,0.1)] text-danger',
  'danger-solid': 'bg-danger text-white',
  ghost: 'bg-transparent text-text shadow-none hover:bg-surface-alt',
  premium:
    'border border-border bg-surface text-text shadow-card hover:-translate-y-px hover:border-primary hover:bg-surface-alt hover:text-primary ' +
    'hover:shadow-[0_4px_10px_rgba(0,0,0,0.06)] dark:border-white/10 dark:bg-[rgba(41,37,36,0.6)] dark:hover:border-primary dark:hover:bg-surface-alt ' +
    '[&_svg]:transition-transform [&_svg]:duration-200 hover:[&_svg]:scale-[1.08]',
  none: ''
};

// The primary button's light edge and soft shadow (in the dark: a plain shadow)
const PRIMARY_SHADOW = 'shadow-[inset_0_1px_0_rgba(255,255,255,0.18),var(--shadow-brand)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_1px_2px_rgba(0,0,0,0.45)]';
// A block button in a dialog's body: one even height, a little smaller (the primary keeps its dark shadow)
const COMPACT = 'h-10 min-h-10 px-5 py-3 text-[0.9rem] rounded-[10px] mt-0.5';
const COMPACT_SHADOW = 'shadow-[0_2px_6px_rgba(var(--glow-rgb),0.2)]';

/** The classes of a button (for links and labels that look like one: <a class={buttonClass({ variant: 'secondary' })}>). */
export function buttonClass(look: ButtonLook = {}): JSX.ClassValue {
  const variant = look.variant ?? 'primary';
  if (variant === 'premium') return ['btn btn-premium', BASE, VARIANT.premium, 'rounded-[10px] px-4 py-2.5 text-[0.88rem]', { 'w-full': !!look.block }];
  return [
    // .btn / .btn-<variant>: markers only (a dialog's body compacts the buttons placed straight in it)
    `btn btn-${variant}`,
    BASE,
    VARIANT[variant],
    look.compact ? COMPACT : [SIZE[look.size ?? 'md'], 'rounded-[12px]'],
    look.compact ? (variant === 'primary' ? [COMPACT_SHADOW, 'dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_1px_2px_rgba(0,0,0,0.45)]'] : COMPACT_SHADOW) : variant === 'primary' && PRIMARY_SHADOW,
    { 'w-full': !!look.block }
  ];
}

/** The app's button (.btn): primary, secondary, danger, ghost, premium; small/tiny; block; busy. Type "button" by default. */
export function Button(props: ButtonProps) {
  const inDialogBody = useContext(DialogBodyContext);
  const rest = omit(props, 'variant', 'size', 'block', 'compact', 'busy', 'busyText', 'class', 'children', 'type', 'disabled');
  return (
    <button
      type={props.type ?? 'button'}
      disabled={props.disabled || props.busy}
      class={[
        buttonClass({ variant: props.variant, size: props.size, block: props.block, compact: props.compact ?? (inDialogBody && !!props.block) }),
        props.class
      ]}
      {...rest}
    >
      {props.busy && props.busyText !== undefined ? props.busyText : props.children}
    </button>
  );
}
