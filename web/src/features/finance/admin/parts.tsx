// Small pieces the finance views share: the amber note about a fresh start of the fee accounts, the header and body
// of the dialogs that carry an action beside the close button (the shared dialog frame has no place for it).
import type { JSX } from '@solidjs/web';
import { Show } from 'solid-js';
import { t } from '../../../app/i18n';
import { closeModal } from '../../../app/modals';
import { Icon } from '../../../ui/Icon';

/** A quiet amber note with the fresh-start symbol (what a payment before the fresh start does). */
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

/** The header of a dialog (badge, title, subtitle, close) with [actions] left of the close button. */
export function DialogHeader(props: {
  id: string;
  icon: JSX.Element;
  iconClass: string;
  title: JSX.Element;
  subtitle?: JSX.Element;
  actions?: JSX.Element;
}) {
  return (
    <div class="relative z-10 flex shrink-0 items-center justify-between border-b border-black/6 bg-surface px-[18px] py-3.5 dark:border-white/8">
      <div class="flex items-center gap-2.5">
        <div class={['flex size-9 shrink-0 items-center justify-center rounded-[9px] text-[1.1rem]', props.iconClass]}>{props.icon}</div>
        <div>
          <div class="text-[1.05rem] leading-[1.2] font-bold text-text">{props.title}</div>
          <Show when={props.subtitle}>
            <div class="mt-0.5 text-[0.74rem] text-text-secondary">{props.subtitle}</div>
          </Show>
        </div>
      </div>
      <div class="ml-auto flex items-center gap-3">
        {props.actions}
        <button
          type="button"
          class="flex items-center justify-center bg-transparent px-1 text-[1.8rem] leading-none text-text-secondary transition-colors duration-200 focus:text-danger focus:outline-none focus-visible:rounded focus-visible:outline-2 focus-visible:outline-danger"
          aria-label={t('btn_close', 'Close')}
          onClick={() => closeModal(props.id)}
        >
          &times;
        </button>
      </div>
    </div>
  );
}

/** The scrolling body below a DialogHeader. */
export const DIALOG_BODY = 'flex flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain px-4 pt-3.5 pb-4';

/** The tints of the dialog badges (person, donation, expense). */
export const BADGE_TINTS = {
  person: 'bg-[#eef2ff] text-[#4f46e5] dark:bg-[rgba(79,70,229,0.25)] dark:text-[#818cf8]',
  donation: 'bg-[#ecfdf5] text-[#059669] dark:bg-[rgba(16,185,129,0.25)] dark:text-[#34d399]',
  expense: 'bg-[#fff1f2] text-[#e11d48] dark:bg-[rgba(244,63,94,0.25)] dark:text-[#fb7185]'
};
