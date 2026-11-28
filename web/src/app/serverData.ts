// Data of the server as an async value (Solid's createDeferred): loaded when a page first reads it, again with
// refresh() - a visit of its tab, a live update, after a change - without holding anything up: the last answer stays on
// screen until the new one is there. A failed first load throws to the page's <Errored> (ui/pages.tsx: Loaded, with
// "Try again"); a failed refresh keeps what is shown and says so.
//
// Data that other parts read on the way (the songs in an event's plan) takes a placeholder instead: it is shown until
// the first answer - nothing waits for it - and a failed first load becomes a value too (the page offers "Try again"
// itself), so no reader ever gets an error it has no boundary for.
//
// Changes that show at once go through an optimistic layer over the data (createOptimistic) inside an action: the
// action asks the server and refreshes the data before it ends, so the change never flickers back; when the server
// refuses, the layer falls away and the data shows as it is.
import { createDeferred, createRoot, untrack } from 'solid-js';
import { errorMessage } from './api';
import { showToast } from './toast';

export interface Placeholder<T> {
  /** Shown until the first answer (instead of waiting at a <Loading> boundary). */
  loadingValue: T;
  /** What a failed first load shows. */
  failed: (err: unknown) => T;
}

export function serverData<T>(load: () => Promise<T>, placeholder?: Placeholder<T>) {
  // Whether an answer came in: until then a failure is the first load's (later ones keep what is shown)
  let answered = false;
  return createRoot(() =>
    createDeferred<T>(
      async previous => {
        try {
          // The loader runs untracked: what it reads on the way (a text, a permission) does not load the data again
          const data = await untrack(load);
          answered = true;
          return data;
        } catch (err) {
          if (!answered) {
            if (placeholder) return placeholder.failed(err);
            throw err;
          }
          showToast(errorMessage(err), 'error');
          return previous as T;
        }
      },
      placeholder ? { lazy: true, loadingValue: placeholder.loadingValue } : { lazy: true }
    )
  );
}
