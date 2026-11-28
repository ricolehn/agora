// Data of the server as an async value (Solid's createDeferred): loaded when a page first reads it, again with
// refresh() - a visit of its tab, a live update, after a change - without holding anything up: the last answer stays on
// screen until the new one is there. A failed first load throws to the page's <Errored> (ui/pages.tsx: Loaded, with
// "Try again"); a failed refresh keeps what is shown and says so.
//
// Changes that show at once go through an optimistic layer over the data (createOptimistic) inside an action: the
// action asks the server and refreshes the data before it ends, so the change never flickers back; when the server
// refuses, the layer falls away and the data shows as it is.
import { createDeferred, createRoot, untrack } from 'solid-js';
import { errorMessage } from './api';
import { showToast } from './toast';

export function serverData<T>(load: () => Promise<T>) {
  return createRoot(() =>
    createDeferred<T>(
      async previous => {
        try {
          // The loader runs untracked: what it reads on the way (a text, a permission) does not load the data again
          return await untrack(load);
        } catch (err) {
          if (previous === undefined) throw err;
          showToast(errorMessage(err), 'error');
          return previous;
        }
      },
      { lazy: true }
    )
  );
}
