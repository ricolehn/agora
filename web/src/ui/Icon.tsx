import type { JSX } from '@solidjs/web';
import { ICONS, type IconName } from './icons';

export type { IconName };

export interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  class?: string;
  style?: JSX.CSSProperties;
  'aria-hidden'?: boolean;
}

/** A line icon of the app's set (ui/icons.ts). */
export function Icon(props: IconProps) {
  return (
    <svg
      width={props.size ?? 14}
      height={props.size ?? 14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={props.strokeWidth ?? 2}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      style={props.style}
      aria-hidden={props['aria-hidden'] === false ? undefined : 'true'}
      innerHTML={ICONS[props.name]}
    />
  );
}
