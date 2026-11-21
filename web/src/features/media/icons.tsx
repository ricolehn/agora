// The library's own line icons (the ones the app's icon set does not have), drawn like ui/Icon.
import type { JSX } from '@solidjs/web';

function LineIcon(props: { size: number; stroke: number; class?: string; children: JSX.Element }) {
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={props.stroke}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

/** All folder rights at a glance (a list with dots). */
export const RulesIcon = () => (
  <LineIcon size={18} stroke={2}>
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </LineIcon>
);

/** Select all / none: a ticked box. */
export const SelectAllIcon = () => (
  <LineIcon size={16} stroke={2.4}>
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="m8 12 3 3 5-6" />
  </LineIcon>
);

/** A folder with a plus (the floating button's "New folder"). */
export const FolderPlusIcon = () => (
  <LineIcon size={24} stroke={2}>
    <path d="M12 10v6" />
    <path d="M9 13h6" />
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </LineIcon>
);

/** The play sign on a video's picture (filled). */
export const PlayIcon = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5v14l11-7z" fill="currentColor" />
  </svg>
);
