/**
 * The keyboard of an element that acts as a button (role="button", tabindex="0"), from its onKeyDown:
 * `onKeyDown={e => onActivateKey(e, open)}`. Enter and Space run [action], Space without scrolling the page; keys
 * pressed on a control inside it (a button, a link) stay that control's own.
 */
export function onActivateKey(e: KeyboardEvent, action: () => unknown) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
    e.preventDefault();
    action();
  }
}
