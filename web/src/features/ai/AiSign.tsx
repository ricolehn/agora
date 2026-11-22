// The assistant's sign (lib/aiSign.js, as in the Android app): two soft forms in lagoon and sand whose outlines slowly
// change - livelier while the AI works, at rest once a reply is complete. Used by the chat and by its tile in Extras.
import { createEffect, createMemo } from 'solid-js';
import { aiSignMarkup, setAiSignState, wakeAiSigns } from '../../lib/aiSign.js';

export type AiSignState = 'calm' | 'thinking' | 'resting';

export interface AiSignProps {
  /** Size in px. */
  size: number;
  /** Where in its motion it starts (every reply's sign starts at another moment). */
  seed?: number;
  /** Never moves (the faint sign in the corner of the AI's tile). */
  still?: boolean;
  /** The moment it is drawn at while still. */
  time?: number;
  /** Its soft light at rest (signs of 48 px and more by default). */
  glow?: boolean;
  /** What it does: 'thinking' (faster, livelier, glowing), 'calm' or 'resting' (it slows down and stops). */
  state?: AiSignState;
  /** Classes of the holder around the sign (its place in the layout). */
  class?: string;
}

export function AiSign(props: AiSignProps) {
  let holder!: HTMLSpanElement;
  // Drawn once (each sign has gradients of its own); lib/aiSign.js moves it while it is on screen
  const markup = createMemo(() => aiSignMarkup({ size: props.size, seed: props.seed, still: props.still, time: props.time, glow: props.glow }));
  createEffect(
    () => props.state ?? 'calm',
    state => {
      wakeAiSigns(holder);
      setAiSignState(holder.firstElementChild, state);
    }
  );
  // eslint-disable-next-line solid/no-innerhtml -- trusted markup of lib/aiSign.js (numbers and fixed classes only)
  return <span ref={holder} class={props.class} aria-hidden="true" innerHTML={markup()} />;
}
