import type { JSX } from '@solidjs/web';
import { Show, createEffect, createMemo, createSignal, onSettled } from 'solid-js';
import { Portal } from '@solidjs/web';
import { closeModal, isModalOpen, isTopModal, modalLayer } from '../app/modals';
import { t } from '../app/i18n';
import { DialogBodyContext } from './context';

/**
 * Tints of the round symbol left of a dialog's title (the old .badge-* classes): pass one as `iconClass`.
 * Without one the symbol has no background (the old generic dialogs and .badge-event).
 */
export const MODAL_TINTS = {
  person: 'bg-[#eef2ff] text-[#4f46e5] dark:bg-[rgba(79,70,229,0.25)] dark:text-[#818cf8]',
  donation: 'bg-[#ecfdf5] text-[#059669] dark:bg-[rgba(16,185,129,0.25)] dark:text-[#34d399]',
  expense: 'bg-[#fff1f2] text-[#e11d48] dark:bg-[rgba(244,63,94,0.25)] dark:text-[#fb7185]',
  feeReset: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-warning',
  feeChange: 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-success'
} as const;

export interface ModalProps {
  /** The dialog's id: openModal(id) / closeModal(id) (app/modals.ts). */
  id: string;
  title?: JSX.Element;
  subtitle?: JSX.Element;
  /** The symbol in the badge left of the title (an emoji or an <Icon>). */
  icon?: JSX.Element;
  /** Tint of the badge: one of MODAL_TINTS or own classes (background and colour). */
  iconClass?: string;
  /** Maximum width of the panel (CSS value), e.g. '520px'; 420px by default. */
  maxWidth?: string;
  footer?: JSX.Element;
  /** Extra classes for the panel. */
  class?: string;
  /** Extra classes for the body. */
  bodyClass?: string;
  /** No header/body/footer: the children are the whole content of the panel (custom layouts; ModalHeader,
   *  ModalBody and ModalFooter can build it). */
  plain?: boolean;
  /** The older dialog look (.modal-content with .modal-header): a sticky header with the title (an h3) and the ×,
   *  the children straight below it (panel padding 0 20px 20px), the whole panel scrolls. */
  classic?: boolean;
  /** classic: replaces the title's look (the old h3.modal-title: 1.17em, bold); e.g. "tracking-normal" keeps the
   *  header's own 1.2rem / 800 (the crop dialog's plain title). */
  titleClass?: string;
  /** A full page (the old .modal-page / .poll-editor-page / .song-page: event details, song page, editors): the page
   *  background instead of the dimmed one, a column of `maxWidth` (760px) over the whole height, no corners, shadow or
   *  movement (it fades), no close on a tap beside it. The children are the whole content (like plain) and scroll
   *  themselves. */
  page?: boolean;
  /** Replaces the panel's look (surface, size, corners, shadow, the opening movement): full-page dialogs, viewers. */
  panelClass?: string;
  /** Replaces the dimmed, blurred backdrop (with its centring): e.g. 'bg-bg items-stretch justify-center'. */
  backdropClass?: string;
  /** A tap on the backdrop closes the dialog: off by default, as in the previous app (a half-filled form stays). */
  closeOnBackdrop?: boolean;
  /** The id of the element that names the dialog, for plain and page dialogs with their own heading. */
  labelledBy?: string;
  /** Runs when the dialog has closed (any way), after its closing animation. */
  onClose?: () => void;
  children?: JSX.Element;
}

// The panel's frame: surface, 90% wide up to 420px, 20px corners, a soft large shadow (a plain border in the dark)
// The panel's size and corners are weak: a dialog's own class for them wins (the report fills the screen on phones)
const PANEL_SURFACE =
  'weak:w-[90%] weak:max-w-[420px] weak:rounded-[20px] bg-surface text-text shadow-[var(--shadow-lg),0_0_0_1px_var(--hairline)] ' +
  'dark:border dark:border-border dark:shadow-[0_20px_40px_-10px_rgba(0,0,0,0.6),0_2px_12px_rgba(0,0,0,0.35)]';
const PANEL_ENHANCED = 'flex weak:max-h-[min(90vh,660px)] flex-col overflow-hidden';
const PANEL_CLASSIC = 'block weak:max-h-[88vh] overflow-y-auto px-5 pb-5';
// It rises a little and grows into place, with a slight overshoot
const PANEL_MOTION = '[transition:translate_0.35s_cubic-bezier(0.175,0.885,0.32,1.275),scale_0.35s_cubic-bezier(0.175,0.885,0.32,1.275)]';

/** The × of a dialog (.close-btn): grey, red while it has the focus. */
export function CloseButton(props: { onClick: () => void; class?: string; label?: string }) {
  return (
    <button
      type="button"
      class={[
        'flex shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent px-1 py-0 text-[1.8rem] leading-none font-normal text-text-secondary',
        'transition-colors duration-200 focus:text-danger focus:outline-none focus-visible:rounded-[4px] focus-visible:outline-2 focus-visible:outline-danger',
        props.class
      ]}
      aria-label={props.label ?? t('btn_close', 'Close')}
      onClick={() => props.onClick()}
    >
      &times;
    </button>
  );
}

/** The header of a dialog (.modal-header-enhanced): badge, title, subtitle and the ×. */
export function ModalHeader(props: {
  id?: string;
  title?: JSX.Element;
  subtitle?: JSX.Element;
  icon?: JSX.Element;
  iconClass?: string;
  onClose?: () => void;
  class?: string;
  children?: JSX.Element;
}) {
  return (
    <div
      class={[
        'relative z-10 flex shrink-0 items-center justify-between bg-surface px-[18px] py-[14px] border-b border-[rgba(0,0,0,0.06)] dark:border-white/8',
        props.class
      ]}
    >
      <div class="flex items-center gap-2.5">
        <Show when={props.icon}>
          <div class={['flex weak:size-9 shrink-0 items-center justify-center weak:rounded-[9px] weak:text-[1.1rem]', props.iconClass]}>{props.icon}</div>
        </Show>
        <div>
          <div id={props.id ? `${props.id}-title` : undefined} class="text-[1.05rem] leading-[1.2] font-bold text-text">
            {props.title}
          </div>
          <Show when={props.subtitle}>
            <div class="mt-0.5 text-[0.74rem] font-normal text-text-secondary">{props.subtitle}</div>
          </Show>
        </div>
      </div>
      {props.children}
      <Show when={props.onClose}>
        <CloseButton onClick={() => props.onClose!()} />
      </Show>
    </div>
  );
}

// Buttons placed straight in the body: one even height, a little smaller (the primary keeps its dark shadow)
const BODY_BUTTONS =
  '[&>.btn]:mt-0.5 [&>.btn]:h-10 [&>.btn]:min-h-10 [&>.btn]:rounded-[10px] [&>.btn]:text-[0.9rem] [&>.btn]:font-semibold ' +
  '[&>.btn]:shadow-[0_2px_6px_rgba(var(--glow-rgb),0.2)] dark:[&>.btn-primary]:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_1px_2px_rgba(0,0,0,0.45)]';

/** The scrolling body of a dialog (.modal-body-enhanced): fields, labels, block buttons and buttons placed straight in
 *  it are compact; 10px between its parts. */
export function ModalBody(props: { class?: string; ref?: (el: HTMLDivElement) => void; children?: JSX.Element }) {
  return (
    <div ref={props.ref} class={['flex flex-1 flex-col weak:gap-2.5 overflow-y-auto overscroll-contain px-4 pt-[14px] pb-4', BODY_BUTTONS, props.class]}>
      <DialogBodyContext value={true}>{props.children}</DialogBodyContext>
    </div>
  );
}

/** The footer of a dialog (.modal-footer-enhanced): actions on the right. */
export function ModalFooter(props: { class?: string; children?: JSX.Element }) {
  return (
    <div class={['flex shrink-0 items-center justify-end gap-2.5 bg-surface px-[18px] pt-3 pb-4 border-t border-[rgba(0,0,0,0.06)] dark:border-white/8', props.class]}>
      {props.children}
    </div>
  );
}

/**
 * A dialog of the stack (app/modals.ts): a dimmed, blurred backdrop and a centred panel that rises into place.
 * The content is only rendered while the dialog is open (and during its closing animation). Escape (app/modals.ts),
 * the ×, the back gesture and a tap on the backdrop close it. Only the dialog on top can be reached (the others are
 * inert); on opening, the focus moves into the panel (or to an element with `autofocus`).
 */
export function Modal(props: ModalProps) {
  // A memo: it changes only when THIS dialog opens or closes. (The stack changes with every dialog, and an effect runs
  // its apply on every change of what it reads - an unrelated change cancelled the closing timer and the dialog stayed
  // in the page, invisible.)
  const open = createMemo(() => isModalOpen(props.id));
  // Bumped by the timer when a closing animation has ended
  const [closedTick, setClosedTick] = createSignal(0);
  // Mounted while open and during its closing animation: the tick it was last seen open at (-1: not mounted) - a
  // closed dialog stays until the timer moves the tick on
  const mountedAt = createMemo<number>(previous => {
    const tick = closedTick();
    if (open()) return tick;
    return previous === tick ? tick : -1;
  });
  const mounted = () => mountedAt() >= 0;
  // Every opening draws the dialog anew, also one reopened during its closing animation: its fields, players and
  // gestures start fresh (the previous app filled its dialogs on every opening)
  const openings = createMemo<number>(previous => (open() ? (previous ?? 0) + 1 : (previous ?? 0)));
  const drawn = () => (mounted() ? openings() : 0);
  let panel: HTMLDivElement | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let wasOpen = false;

  createEffect(open, isOpen => {
    clearTimeout(closeTimer);
    if (isOpen) {
      wasOpen = true;
      requestAnimationFrame(() => {
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
    } else if (wasOpen) {
      wasOpen = false;
      closeTimer = setTimeout(() => {
        setClosedTick(tick => tick + 1);
        props.onClose?.();
      }, 350);
    }
  });
  onSettled(() => () => clearTimeout(closeTimer));

  const custom = () => !!props.panelClass || !!props.page;
  const backdrop = () => props.backdropClass ?? (props.page ? 'items-stretch justify-center bg-bg' : undefined);
  const close = () => closeModal(props.id);

  return (
    <Show when={drawn()} keyed>
      {_opening => (
      <Portal mount={document.body}>
        <div
          id={props.id}
          role="dialog"
          aria-modal="true"
          aria-labelledby={props.labelledBy ?? (props.title && !props.plain && !props.page ? `${props.id}-title` : undefined)}
          inert={!isTopModal(props.id)}
          class={[
            'modal fixed inset-0 flex [transition:opacity_0.3s_cubic-bezier(0.25,1,0.5,1),backdrop-filter_0.3s_cubic-bezier(0.25,1,0.5,1)]',
            backdrop() ?? [
              'items-center justify-center bg-[rgba(20,16,12,0.45)]',
              { '[backdrop-filter:blur(6px)_saturate(120%)] starting:[backdrop-filter:none]': open() }
            ],
            open() ? 'opacity-100 starting:opacity-0' : 'pointer-events-none opacity-0'
          ]}
          style={{ 'z-index': String(open() ? modalLayer(props.id) : 2000) }}
          onClick={e => {
            // Like the previous app: a tap beside the panel does not close it (a half-filled form stays); opt in per dialog
            if (e.target === e.currentTarget && props.closeOnBackdrop === true) close();
          }}
        >
          <div
            ref={panel}
            tabindex="-1"
            class={[
              'modal-content relative outline-none',
              custom()
                ? props.panelClass ?? 'flex h-full w-full max-w-[760px] flex-col bg-bg text-text'
                : [
                    PANEL_SURFACE,
                    props.classic ? PANEL_CLASSIC : PANEL_ENHANCED,
                    PANEL_MOTION,
                    open() ? 'translate-y-0 scale-100 starting:translate-y-4 starting:scale-[0.96]' : 'translate-y-4 scale-[0.96]'
                  ],
              props.class
            ]}
            style={props.maxWidth ? { 'max-width': props.maxWidth } : undefined}
          >
            <Show
              when={!props.plain && !props.page}
              fallback={props.children}
            >
              <Show
                when={!props.classic}
                fallback={
                  <>
                    <div class="sticky top-0 z-10 mb-5 flex justify-between bg-[var(--frost-surface)] pt-6 text-[1.2rem] font-extrabold text-text [backdrop-filter:var(--frost)]">
                      <h3 id={`${props.id}-title`} class={props.titleClass ?? 'text-[1.17em] font-bold'}>
                        {props.title}
                      </h3>
                      <CloseButton onClick={close} />
                    </div>
                    {props.children}
                  </>
                }
              >
                <ModalHeader id={props.id} title={props.title} subtitle={props.subtitle} icon={props.icon} iconClass={props.iconClass} onClose={close} />
                <ModalBody class={props.bodyClass}>{props.children}</ModalBody>
                <Show when={props.footer}>
                  <ModalFooter>{props.footer}</ModalFooter>
                </Show>
              </Show>
            </Show>
          </div>
        </div>
      </Portal>
      )}
    </Show>
  );
}

/** The small capitalised label above a part of a dialog's body (a field, a choice). */
export const PART_LABEL = 'text-[0.72rem] font-extrabold tracking-[0.05em] text-text-secondary uppercase';

/** A part of a dialog's body without a card: its label and fields 8px apart; [ruled]: a line 14px above it. */
export function ModalPart(props: { ruled?: boolean; children: JSX.Element }) {
  return <div class={['flex flex-col gap-2', { 'border-t border-border-light pt-3.5': props.ruled }]}>{props.children}</div>;
}

/** A section of a dialog's body: a soft card with a small capitalised header (.modal-section-card / -header). */
export function ModalSection(props: { icon?: JSX.Element; title?: JSX.Element; class?: string; children?: JSX.Element }) {
  return (
    <div
      class={[
        'flex flex-col gap-2 rounded-[12px] border border-border-light bg-surface-alt px-3 py-2.5 [transition:border-color_0.2s_ease,box-shadow_0.2s_ease]',
        'focus-within:border-primary focus-within:shadow-[0_0_0_2.5px_rgba(var(--brand-rgb),0.15)] dark:border-white/8 dark:bg-white/3 dark:focus-within:border-primary',
        props.class
      ]}
    >
      <Show when={props.title || props.icon}>
        <div class="flex items-center gap-1.5 text-[0.7rem] font-bold tracking-[0.05em] text-text-secondary uppercase">
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
