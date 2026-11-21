// The amber note about a fresh start of the fee accounts (CALDERA): what a payment dated before it does.
import { Icon } from '../../../ui/Icon';

/** A quiet amber note with the fresh-start symbol. */
export function FeeResetNote(props: { text: string; class?: string }) {
  return (
    <div
      class={[
        'flex items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))]',
        'px-3 py-[9px] text-[0.8rem] leading-[1.45] text-text',
        props.class ?? 'mt-2'
      ]}
    >
      <Icon name="rotate" size={14} strokeWidth={2.4} class="mt-0.5 shrink-0 text-warning" />
      <span>{props.text}</span>
    </div>
  );
}
