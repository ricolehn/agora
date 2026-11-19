import { Show, createSignal } from 'solid-js';
import { profilePictureSrc } from '../app/pictures';
import type { AvatarRing } from '../app/session';
import { getInitials } from '../app/util';

/**
 * A person's picture: the initials on a soft background, the picture over them (when the person has one).
 * ring: the coloured ring of mentoring managers, mentors and everyone else (omit for none).
 */
export function Avatar(props: { uid?: string | null; name?: string; size?: number; ring?: AvatarRing | null; class?: string; src?: string | null }) {
  const [failed, setFailed] = createSignal(false);
  const src = () => props.src ?? profilePictureSrc(props.uid);
  const size = () => props.size ?? 40;
  return (
    <span
      class={[
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand/12 font-bold text-brand-deep dark:text-primary',
        props.class
      ]}
      style={{ width: `${size()}px`, height: `${size()}px`, 'font-size': `${Math.round(size() * 0.38)}px` }}
      data-ring={props.ring || undefined}
    >
      <span aria-hidden="true">{getInitials(props.name || 'P')}</span>
      <Show when={src() && !failed()}>
        <img src={src()!} alt={props.name || ''} loading="lazy" class="absolute inset-0 size-full object-cover" onError={() => setFailed(true)} />
      </Show>
    </span>
  );
}
