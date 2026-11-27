// The stack of open dialogs, with the browser history: an open dialog has a history entry, so the back gesture
// closes it (nested dialogs share one entry). Only the dialog on top can be reached by keyboard and screen readers.
// The dialog frame (ui/Modal.tsx) reads this state; features open and close dialogs by id.
//
// The stack is kept twice: a plain list, always current, for the opening and closing itself (two dialogs opened in
// one go both stay), and a signal the pages are drawn from - Solid applies it with its next update, and what needs
// the page drawn first (the focus going back) runs from there.
import { createEffect, createRoot, createSignal } from 'solid-js';
import { programmaticBack } from './history';

let stack: string[] = [];
const [modalStack, setModalStack] = createSignal<string[]>([]);
export { modalStack };
const setStack = (next: string[]) => {
  stack = next;
  setModalStack(next);
};

/** Whether the dialog [id] is open (reactive). */
export const isModalOpen = (id: string) => modalStack().includes(id);
/** Whether [id] is the dialog on top (reactive). */
export const isTopModal = (id: string) => {
  const open = modalStack();
  return open[open.length - 1] === id;
};
export const anyModalOpen = () => modalStack().length > 0;
/** The layer of an open dialog (later ones above earlier ones). */
export const modalLayer = (id: string) => 2000 + (modalStack().indexOf(id) + 1) * 10;
/** The dialog on top right now, for the back gesture and Escape (not reactive: handlers act on what is open). */
export const topModal = (): string | undefined => stack[stack.length - 1];

// Where the focus was when a dialog opened: it goes back there when the dialog closes
const returnFocus = new Map<string, Element | null>();
// A dialog can refuse to close (unsaved changes): the guard returns false
const closeGuards = new Map<string, () => boolean>();
// Run once when the dialog closes the next time (a dialog opened for one purpose cleans up after itself)
const closeCallbacks = new Map<string, Array<() => void>>();

/** [guard] returns false to keep the dialog open (it asks the person itself); null removes it. */
export function setModalCloseGuard(id: string, guard: (() => boolean) | null) {
  if (guard) closeGuards.set(id, guard);
  else closeGuards.delete(id);
}

/** Runs [fn] once, when the dialog [id] closes the next time. */
export function onModalClosed(id: string, fn: () => void) {
  const list = closeCallbacks.get(id) || [];
  list.push(fn);
  closeCallbacks.set(id, list);
}

export function openModal(id: string) {
  if (stack.includes(id)) return;
  returnFocus.set(id, document.activeElement);
  setStack([...stack, id]);
  history[history.state?.isModal ? 'replaceState' : 'pushState']({ isModal: true, modalId: id }, '');
}

function restoreFocus(el: Element | null | undefined) {
  if (el && document.body.contains(el)) {
    try {
      (el as HTMLElement).focus();
    } catch {
      /* element no longer focusable */
    }
  }
}

// The element the focus goes back to once the closed dialog is gone from the page (the effect below)
let focusAfterClose: Element | null | undefined;
createRoot(() =>
  createEffect(modalStack, () => {
    const target = focusAfterClose;
    focusAfterClose = undefined;
    restoreFocus(target);
  })
);

function runCloseCallbacks(id: string) {
  const list = closeCallbacks.get(id);
  closeCallbacks.delete(id);
  for (const fn of list || []) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Closes the dialog [id]. fromPopstate: the back gesture already left the dialog's history entry (if the guard keeps
 * the dialog open, the entry is added again). force: closes without asking the guard.
 */
export function closeModal(id: string, fromPopstate = false, force = false) {
  if (!stack.includes(id)) return;
  const guard = closeGuards.get(id);
  if (!force && guard && !guard()) {
    if (fromPopstate) history.pushState({ isModal: true, modalId: id }, '');
    return;
  }
  setStack(stack.filter(entry => entry !== id));
  if (!fromPopstate && history.state?.isModal) programmaticBack();
  focusAfterClose = returnFocus.get(id);
  returnFocus.delete(id);
  runCloseCallbacks(id);
}

/** Closes several dialogs at once (they share one history entry: one step back at most). */
export function closeMultipleModals(ids: string[]) {
  const closing = ids.filter(id => stack.includes(id));
  if (!closing.length) return;
  let finalFocus: Element | null | undefined = null;
  for (const id of closing) {
    const focus = returnFocus.get(id);
    if (focus && !closing.some(other => document.getElementById(other)?.contains(focus))) finalFocus = focus;
    returnFocus.delete(id);
  }
  setStack(stack.filter(id => !closing.includes(id)));
  focusAfterClose = finalFocus;
  if (history.state?.isModal) programmaticBack();
  for (const id of closing) runCloseCallbacks(id);
}

// Escape closes only the dialog on top
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const top = topModal();
  if (top) closeModal(top);
});
