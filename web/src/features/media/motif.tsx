// The library's small pictures as in the Android app (lib/motifs.ts): a motif (a folder, a picture, notes, a
// screen, a document) in a field softly painted in its colours - lighter up left, a breath of a neighbouring hue down
// right, two still soft forms - deep and quiet in the dark theme.
import type { JSX } from '@solidjs/web';
import { fieldForms, motifSvg } from '../../lib/motifs';

/** A motif as an <svg> of its own; [accent] colours a document's folded corner and lines. Decorative. */
export function MotifSvg(props: { motif: string; accent?: string; class?: JSX.ClassValue }) {
  // The drawing's inside (its gradients carry ids of their own, so several on one page never share them)
  const inner = () => motifSvg(props.motif, { accent: props.accent }).replace(/^<svg[^>]*>|<\/svg>$/g, '');
  // eslint-disable-next-line solid/no-innerhtml -- the app's own drawing code (lib/motifs.ts), no names or data in it
  return <svg class={props.class} viewBox="0 0 100 100" aria-hidden="true" innerHTML={inner()} />;
}

const FIELD =
  'relative isolate inline-grid shrink-0 place-items-center overflow-hidden ' +
  '[background:radial-gradient(55%_55%_at_8%_0%,rgba(255,255,255,0.8),rgba(255,255,255,0)),radial-gradient(62%_62%_at_95%_100%,color-mix(in_srgb,var(--field-hint)_60%,transparent),transparent),linear-gradient(135deg,color-mix(in_oklab,var(--field-light),#ffffff_50%),color-mix(in_oklab,var(--field-light),#ffffff_8%))] ' +
  'dark:[background:radial-gradient(55%_55%_at_8%_0%,color-mix(in_srgb,var(--field-light)_14%,transparent),transparent),radial-gradient(62%_62%_at_95%_100%,color-mix(in_srgb,var(--field-hint)_16%,transparent),transparent),linear-gradient(135deg,color-mix(in_oklab,var(--surface),var(--field-deep)_38%),color-mix(in_oklab,var(--surface),var(--field-deep)_16%))] ' +
  // A fine light edge over everything in it
  "after:pointer-events-none after:absolute after:inset-0 after:z-[3] after:rounded-[inherit] after:content-['']";
const EDGE = 'after:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.6)] dark:after:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]';
const RING = 'after:shadow-[inset_0_0_0_2.5px_var(--primary)]';

/**
 * A field painted in [colors] ({ light, deep, hint }: the light tone, the deep one of the dark theme and a breath of
 * a neighbouring hue) around its content; [seed] places its two soft forms, [ring] frames it (selected).
 */
export function PaintedField(props: {
  colors: { light: string; deep: string; hint?: string };
  seed: number;
  ring?: boolean;
  class?: JSX.ClassValue;
  children?: JSX.Element;
}) {
  const forms = () => fieldForms(props.seed);
  return (
    <span
      class={[FIELD, props.ring ? RING : EDGE, props.class]}
      style={{ '--field-light': props.colors.light, '--field-deep': props.colors.deep, '--field-hint': props.colors.hint || props.colors.light }}
    >
      <svg class="absolute inset-0 -z-1 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path class="fill-white [fill-opacity:0.3] dark:[fill-opacity:0.035]" d={forms().upper} />
        <path class="fill-(--field-deep) [fill-opacity:0.07] dark:fill-(--field-light) dark:[fill-opacity:0.06]" d={forms().lower} />
      </svg>
      {props.children}
    </span>
  );
}
