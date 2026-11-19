// The app's own steps back in the browser history (closing a dialog, leaving a chat or a tab) must not be handled as
// a user's back gesture. A step only counts as "ours" for a short time: if its popstate never arrives (a page pushed
// right after it can cancel the pending traversal on mobile browsers), a stale count would otherwise swallow the next
// real back.
let programmaticBacks = 0;
let programmaticBackAt = 0;
const PROGRAMMATIC_BACK_WINDOW_MS = 1000;

export function programmaticBack(steps = 1) {
  programmaticBacks++;
  programmaticBackAt = Date.now();
  history.go(-steps);
}

/** On popstate: true when the step was the app's own (and is used up), false for the user's own back. */
export function consumeProgrammaticBack(): boolean {
  if (programmaticBacks > 0 && Date.now() - programmaticBackAt < PROGRAMMATIC_BACK_WINDOW_MS) {
    programmaticBacks--;
    return true;
  }
  // Anything older was lost: this is the user's own back
  programmaticBacks = 0;
  return false;
}
