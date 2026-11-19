import type { JSX } from '@solidjs/web';
import { Show, createEffect, createSignal, onSettled } from 'solid-js';
import { Portal } from '@solidjs/web';
import { closeModal, isModalOpen, isTopModal, modalLayer } from '../app/modals';
import { t } from '../app/i18n';

export interface ModalProps {
  /** The dialog's id: openModal(id) / closeModal(id) (app/modals.ts). */
  id: string;
  title?: JSX.Element;
  subtitle?: JSX.Element;
  /** The symbol in the round badge left of the title (an emoji or an <Icon>). */
  icon?: JSX.Element;
  /** Tint of the badge (classes, e.g. 'bg-emerald-500/15 text-emerald-600'). */
  iconClass?: string;
  /** Maximum width of the panel (CSS value), e.g. '520px'. */
  maxWidth?: string;
  footer?: JSX.Element;
  /** Extra classes for the panel. */
  class?: string;
  /** Extra classes for the body. */
  bodyClass?: string;
  /** No header/body frame: the children are the whole panel content (viewers, special layouts). */
  plain?: boolean;
  /** Runs when the dialog is closed (any way). */
  onClose?: () => void;
  children?: JSX.Element;
}

/**
 * A dialog of the stack (app/modals.ts): a dimmed, blurred backdrop and a panel (a sheet from the bottom on phones).
 * The content is only rendered while the dialog is open (and during its closing fade).
 * Tap on the backdrop, Escape, the × and the back gesture close it.
 */
export function Modal(props: ModalProps) {
  const open = () => isModalOpen(props.id);
  // Stays mounted for the closing fade
  const [mounted, setMounted] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  let panel: HTMLDivElement | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  createEffect(open, isOpen => {
    clearTimeout(closeTimer);
    if (isOpen) {
      setMounted(true);
      requestAnimationFrame(() => {
        setShown(true);
        // Keyboard and screen readers start inside the dialog (its panel: no keyboard pops up on phones)
        const target = (panel?.querySelector('[autofocus]') as HTMLElement | null) || panel;
        if (target && !(panel?.contains(document.activeElement) && document.activeElement !== panel)) {
          try {
            target.focus({ preventScroll: true });
          } catch {
            /* not focusable */
          }
        }
      });
    } else {
      setShown(false);
      closeTimer = setTimeout(() => {
        setMounted(false);
        props.onClose?.();
      }, 250);
    }
  });
  onSettled(() => () => clearTimeout(closeTimer));

  return (
    <Show when={mounted()}>
      <Portal mount={document.body}>
        <div
          id={props.id}
          role="dialog"
          aria-modal="true"
          inert={!isTopModal(props.id)}
          class={[
            'modal fixed inset-0 flex items-end justify-center bg-[rgba(20,16,12,0.45)] transition-opacity duration-200 md:items-center',
            shown() ? 'opacity-100 backdrop-blur-[6px]' : 'pointer-events-none opacity-0'
          ]}
          style={{ 'z-index': String(open() ? modalLayer(props.id) : 2000) }}
          onClick={e => {
            if (e.target === e.currentTarget) closeModal(props.id);
          }}
        >
          <div
            ref={panel}
            tabindex="-1"
            class={[
              'modal-content relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-surface text-text shadow-card-lg outline-none',
              'rounded-t-[28px] md:max-w-[520px] md:rounded-[28px]',
              props.class
            ]}
            style={props.maxWidth ? { 'max-width': props.maxWidth } : undefined}
          >
            <Show
              when={!props.plain}
              fallback={props.children}
            >
              <div class="flex items-center justify-between gap-3 border-b border-hairline px-5 py-4">
                <div class="flex min-w-0 items-center gap-3">
                  <Show when={props.icon}>
                    <div class={['flex size-10 shrink-0 items-center justify-center rounded-xl text-lg', props.iconClass || 'bg-brand/12 text-brand']}>{props.icon}</div>
                  </Show>
                  <div class="min-w-0">
                    <div class="truncate text-[1.05rem] font-bold">{props.title}</div>
                    <Show when={props.subtitle}>
                      <div class="truncate text-[0.8rem] text-text-secondary">{props.subtitle}</div>
                    </Show>
                  </div>
                </div>
                <button
                  type="button"
                  class="flex size-9 shrink-0 items-center justify-center rounded-full text-2xl leading-none text-text-secondary hover:bg-surface-alt"
                  aria-label={t('btn_close', 'Close')}
                  onClick={() => closeModal(props.id)}
                >
                  &times;
                </button>
              </div>
              <div class={['flex-1 overflow-y-auto px-5 py-4', props.bodyClass]}>{props.children}</div>
              <Show when={props.footer}>
                <div class="flex justify-end gap-2.5 border-t border-hairline px-5 py-3">{props.footer}</div>
              </Show>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

/** A section of a dialog's body: a soft card with a small header (.modal-section-card). */
export function ModalSection(props: { icon?: JSX.Element; title?: JSX.Element; class?: string; children?: JSX.Element }) {
  return (
    <div class={['mb-3 rounded-2xl border border-hairline bg-surface-alt/60 p-3.5', props.class]}>
      <Show when={props.title || props.icon}>
        <div class="mb-2 flex items-center gap-1.5 text-[0.8rem] font-semibold text-text-secondary">
          <Show when={props.icon}>
            <span>{props.icon}</span>
          </Show>
          <span>{props.title}</span>
        </div>
      </Show>
      {props.children}
    </div>
  );
}
