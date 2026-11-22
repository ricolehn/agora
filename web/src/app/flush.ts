// Applying pending signal writes at once, for imperative code that reads them right after (Solid 2 batches writes
// until a microtask). Inside onSettled a flush is already running and Solid refuses a nested one: there the writes are
// applied by the running flush anyway, so that one refusal is ignored - every other error is real and passes on.
import { flush } from 'solid-js';

export function flushNow() {
  try {
    flush();
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('Cannot call flush() from inside onSettled'))) throw error;
  }
}
