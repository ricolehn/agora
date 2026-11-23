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

/**
 * The keys of a menu (entries with role menuitem or menuitemradio), from the onKeyDown of an element around them: the
 * arrows (and Home, End) go from entry to entry, round the menu, past disabled ones. With [close], Escape and Tab close
 * the menu (the caller puts the focus back on its button).
 */
export function onMenuKeyDown(e: KeyboardEvent & { currentTarget: HTMLElement }, close?: () => void) {
  if (close && (e.key === 'Escape' || e.key === 'Tab')) {
    e.preventDefault();
    close();
    return;
  }
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')].filter(item => !item.disabled);
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    e.key === 'ArrowDown' ? (at + 1) % items.length
    : e.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
    : e.key === 'Home' ? 0
    : e.key === 'End' ? items.length - 1
    : -1;
  if (next < 0 || !items.length) return;
  e.preventDefault();
  items[next].focus();
}
