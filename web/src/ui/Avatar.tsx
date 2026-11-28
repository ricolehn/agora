import { Show, createSignal } from 'solid-js';
import { profilePictureSrc } from '../app/pictures';
import type { AvatarRing } from '../app/session';
import { getInitials } from '../app/util';

/** The gradient of a role ring (.avatar-ring-*): mentoring managers, approved mentors, everyone else; calmer in the dark. */
export const RING_GRADIENT: Record<AvatarRing, string> = {
  standard: 'bg-[linear-gradient(135deg,#06b6d4,#10b981)] dark:bg-[linear-gradient(135deg,#2f9a90,#2f8f6c)]',
  mentor: 'bg-[linear-gradient(135deg,#c084fc,#7c3aed)] dark:bg-[linear-gradient(135deg,#9a7fc8,#6c4fb0)]',
  manager: 'bg-[linear-gradient(135deg,#facc15,#ef4444)] dark:bg-[linear-gradient(135deg,#c9a640,#c0574f)]'
};
/** The ring around a picture: 3px of the gradient and a soft shadow (the picture inside gets a 2px gap in the surface colour). */
export const RING_FRAME = 'rounded-full p-[3px] shadow-[0_2px_10px_rgba(48,38,26,0.16)] dark:shadow-[0_2px_10px_rgba(0,0,0,0.45)]';

/**
 * A person's picture (.avatar): the initials on a soft violet-to-teal tint, the picture over them when the person has
 * one. size: the picture's diameter in px (40); the initials are 0.34 of it (initialsClass replaces that, e.g.
 * "text-82" for the 42px finance list). ring: the role ring around it (3px + a 2px gap: the whole is size + 6px).
 */
export function Avatar(props: {
  uid?: string | null;
  name?: string;
  size?: number;
  ring?: AvatarRing | null;
  class?: string;
  initialsClass?: string;
  src?: string | null;
}) {
  // The address that could not be loaded (the initials stay): a new address - a new picture, the versions known now -
  // is tried again (the previous app drew its pictures anew with every list)
  const [failedSrc, setFailedSrc] = createSignal<string | null>(null);
  const src = () => props.src ?? profilePictureSrc(props.uid);
  const size = () => props.size ?? 40;
  const Picture = () => (
    <span
      class={[
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full text-text',
        // The fill is weak (zero specificity): a caller's class for it wins (the waiting list's amber)
        'weak:bg-surface weak:bg-[linear-gradient(135deg,rgba(124,58,237,0.16),rgba(var(--brand-rgb),0.16))]',
        { 'border-2 border-surface': !!props.ring },
        props.class
      ]}
      style={{ width: `${size()}px`, height: `${size()}px`, '--av': `${size()}px` }}
    >
      <span aria-hidden="true" class={['font-bold tracking-[0.02em] text-text select-none weak:text-[length:calc(var(--av)*0.34)]', props.initialsClass]}>
        {getInitials(props.name || 'P')}
      </span>
      <Show when={src() && src() !== failedSrc()}>
        <img
          src={src()!}
          alt={props.name || ''}
          loading="lazy"
          class="absolute inset-0 size-full rounded-[inherit] object-cover"
          onError={e => setFailedSrc(e.currentTarget.getAttribute('src'))}
        />
      </Show>
    </span>
  );
  return (
    <Show when={props.ring} fallback={<Picture />}>
      {ring => (
        <span class={['inline-flex shrink-0', RING_FRAME, RING_GRADIENT[ring()]]}>
          <Picture />
        </span>
      )}
    </Show>
  );
}
