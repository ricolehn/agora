// A song as it is read and played: sections, notes for the musicians, and lines with each chord above its syllable.
// The lines come from lib/songbook.js (parseSong); a line wraps between words, a chord never leaves its syllable.
import { For, Match, Show, Switch, createMemo } from 'solid-js';
import { parseSong } from '../../lib/songbook.js';
import { songSectionLabels } from './store';

type Segment = { chord: string | null; text: string };
type Line = { type: 'gap' | 'section' | 'note' | 'text' | 'chords'; text?: string; label?: 'chorus' | 'verse' | 'bridge' | 'tab'; words?: Segment[][] };

export function SongLines(props: { content: string; steps?: number; declaredKey?: string; chords?: boolean }) {
  const lines = createMemo(
    () => parseSong(props.content, { steps: props.steps ?? 0, declaredKey: props.declaredKey ?? '', chords: props.chords ?? true }) as Line[]
  );
  return (
    <For each={lines()} keyed={false}>
      {line => (
        <Switch>
          <Match when={line().type === 'gap'}>
            <div class="h-[0.9em]" />
          </Match>
          <Match when={line().type === 'section'}>
            <div data-song-section class="mt-[18px] mb-1.5 text-[0.78em] font-extrabold tracking-[0.08em] text-primary uppercase first:mt-0">
              {line().text || (line().label ? songSectionLabels()[line().label!] : '')}
            </div>
          </Match>
          <Match when={line().type === 'note'}>
            <div class="my-1 text-text-secondary italic">{line().text}</div>
          </Match>
          <Match when={line().type === 'text'}>
            <div data-song-line class="whitespace-pre-wrap [overflow-wrap:anywhere]">
              <span class="whitespace-pre">{line().text}</span>
            </div>
          </Match>
          <Match when={line().words}>{words => <ChordLine words={words()} />}</Match>
        </Switch>
      )}
    </For>
  );
}

function ChordLine(props: { words: Segment[][] }) {
  // A line of chords alone ("[G] [D] [Em]") has no lyric row
  const chordsOnly = () => props.words.every(word => word.every(seg => !seg.text.trim()));
  return (
    <div data-song-line class="mt-[0.15em] flex flex-wrap items-end whitespace-pre-wrap [overflow-wrap:anywhere]">
      <For each={props.words} keyed={false}>
        {word => (
          <span class="inline-flex items-end">
            <For each={word()} keyed={false}>
              {seg => (
                <span class={['inline-flex flex-col whitespace-pre', { 'mr-[0.9em]': chordsOnly() }]}>
                  <span data-song-chord class="min-h-[1.2em] pr-[0.35em] text-[0.86em] leading-[1.2] font-extrabold text-brand-deep dark:text-brand">
                    {seg().chord || ''}
                  </span>
                  <Show when={!chordsOnly()}>
                    {/* Empty parts keep the height of filled ones, so chords and words stay on one baseline */}
                    <span class={['whitespace-pre', { 'min-h-[1.5em]': !seg().text }]}>{seg().text}</span>
                  </Show>
                </span>
              )}
            </For>
          </span>
        )}
      </For>
    </div>
  );
}
