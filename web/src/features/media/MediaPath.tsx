// The path of the open folder: pills with a small arrow between them, the open one in the library's warm colours.
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onSettled } from 'solid-js';
import { t, uiLang } from '../../app/i18n';
import { activeTab } from '../../app/router';
import { Icon } from '../../ui/Icon';
import { pathSteps, type PathStep } from '../../lib/media';
import { openMediaPathMenu } from './actions';
import { mediaFolder, openMediaCrumb } from './library';
import { MotifSvg } from './motif';

const PILL =
  'inline-flex min-h-8 max-w-[228px] items-center gap-1.5 whitespace-nowrap rounded-full border py-[5px] text-88 leading-[1.25] ' +
  '[transition:background-color_0.2s_ease,color_0.2s_ease,transform_0.2s_cubic-bezier(0.34,1.4,0.64,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const PILL_OPEN =
  'cursor-default border-white/70 font-semibold text-text bg-[linear-gradient(90deg,color-mix(in_oklab,#f6c7a4,#ffffff_38%),color-mix(in_oklab,#f6c7a4,#ffffff_12%))] ' +
  'dark:border-white/6 dark:bg-[linear-gradient(90deg,color-mix(in_oklab,var(--surface),#e0874f_34%),color-mix(in_oklab,var(--surface),#e0874f_20%))]';

const PILL_WAY = 'border-hairline bg-surface font-medium text-text-secondary hover:bg-surface-alt hover:text-text active:[transform:scale(0.96)]';

export function MediaPath() {
  let nav!: HTMLElement;
  const [edges, setEdges] = createSignal({ start: false, end: false });
  const steps = createMemo(() => pathSteps(mediaFolder(), t('media_title', 'Media')));
  const syncEdges = () => setEdges({ start: nav.scrollLeft > 1, end: nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1 });
  // A pill that comes with a new path fades in (not the first ones)
  let drawn = false;
  // The row keeps its end in sight
  createEffect(
    () => [mediaFolder(), uiLang(), activeTab() === 'media'],
    () => {
      nav.scrollLeft = nav.scrollWidth;
      syncEdges();
    }
  );
  onSettled(() => {
    drawn = true;
    window.addEventListener('resize', syncEdges);
    return () => window.removeEventListener('resize', syncEdges);
  });
  const stepKey = (step: PathStep) => (step.folded.length ? '…' : `/${step.target}`);
  return (
    <nav
      id="media-crumbs"
      ref={nav}
      aria-label={t('media_path', 'Folder path')}
      class={[
        'flex min-w-0 items-center overflow-x-auto overflow-y-hidden pt-0.5 pb-1 [scrollbar-width:none]',
        '[-webkit-mask-image:linear-gradient(to_right,transparent_0,#000_var(--fade-start),#000_calc(100%-var(--fade-end)),transparent_100%)]',
        '[mask-image:linear-gradient(to_right,transparent_0,#000_var(--fade-start),#000_calc(100%-var(--fade-end)),transparent_100%)]'
      ]}
      style={{ '--fade-start': edges().start ? '28px' : '0px', '--fade-end': edges().end ? '28px' : '0px' }}
      onScroll={syncEdges}
    >
      <For each={steps()} keyed={stepKey}>
        {(step, index) => {
          const fresh = drawn;
          return <PathPill step={step()} first={index() === 0} open={index() === steps().length - 1} compactRoot={steps().length >= 4} fresh={fresh} />;
        }}
      </For>
    </nav>
  );
}

function PathPill(props: { step: PathStep; first: boolean; open: boolean; compactRoot: boolean; fresh: boolean }) {
  const compact = () => props.step.root && props.compactRoot;
  const content = () => (
    <>
      <Show when={props.step.root}>
        <MotifSvg motif="folder" class="block size-5 shrink-0" />
      </Show>
      <Show when={!compact()}>
        <span class="min-w-0 overflow-hidden text-ellipsis">{props.step.name}</span>
      </Show>
    </>
  );
  const padding = () => [props.step.root ? 'pl-2' : 'pl-3.5', compact() ? 'pr-2' : 'pr-3.5'];
  return (
    <span class={['inline-flex shrink-0 items-center', { 'animate-[mediaFadeIn_0.18s_cubic-bezier(0,0,0.2,1)_backwards]': props.fresh }]}>
      <Show when={!props.first}>
        <span class="mx-1 inline-flex text-text-secondary opacity-50" aria-hidden="true">
          <Icon name="chevronRight" size={16} strokeWidth={2.2} />
        </span>
      </Show>
      <Switch
        fallback={
          <button
            type="button"
            class={[PILL, PILL_WAY, padding()]}
            title={props.step.name}
            aria-label={compact() ? props.step.name : undefined}
            onClick={() => openMediaCrumb(props.step.target)}
          >
            {content()}
          </button>
        }
      >
        <Match when={props.step.folded.length}>
          <button
            type="button"
            class={[PILL, PILL_WAY, 'px-2.5']}
            aria-haspopup="menu"
            title={t('media_path_between', 'Folders in between')}
            aria-label={t('media_path_between', 'Folders in between')}
            onClick={e => openMediaPathMenu(e.currentTarget)}
          >
            <Icon name="more" size={20} strokeWidth={2.6} />
          </button>
        </Match>
        {/* The open folder is where you are, not a way to go */}
        <Match when={props.open}>
          <span class={[PILL, PILL_OPEN, padding()]} aria-current="page" title={props.step.name}>
            {content()}
          </span>
        </Match>
      </Switch>
    </span>
  );
}
