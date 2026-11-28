// Extras, as in the Android app: one permanent navigation entry for further apps of the community. The AI chat leads
// across the full width with the assistant's sign (for those with the right); the others follow as rows, each with a
// small 3D motif in a field softly painted in its colours (lib/motifs.ts). Tiles rise in one after another; nothing in
// a row moves.
import { For, createMemo } from 'solid-js';
import { FEATURES } from '../../app/config';
import { mediaStatus } from '../../app/data';
import { t } from '../../app/i18n';
import { activeTab, pushHistoryLevel, switchTab } from '../../app/router';
import { aiEnabled, canAccessAi } from '../../app/session';
import { MOTIF_SEEDS, motifSvg, paintedField, type Motif } from '../../lib/motifs';
import { Icon } from '../../ui/Icon';
import { AiSign } from '../ai/AiSign';
import { openMediaFolder } from '../media/api';

interface HubAppBase {
  key: string;
  /** The light tone of the app and its deep one (its arrow in light mode, the field in the dark theme). */
  colors: [light: string, deep: string];
  /** A breath of a neighbouring hue in the field. */
  hint?: string;
  title: [key: string, fallback: string];
  desc: [key: string, fallback: string];
  visible?: () => boolean;
  open: () => void;
}
/** The AI chat: across the full width, with its sign and "Start chat". */
type FeaturedApp = HubAppBase & { featured: true };
/** Another app: its motif in a painted field. */
type MotifApp = HubAppBase & { featured?: false; motif: Motif };
type HubApp = FeaturedApp | MotifApp;

const HUB_APPS: HubApp[] = [
  {
    key: 'ai', featured: true, colors: ['#ebd3ae', '#2d625b'], title: ['hub_ai_title', 'AI Support'], desc: ['hub_ai_desc', 'Questions about the community, appointments and finances'],
    visible: () => aiEnabled() && canAccessAi(), open: () => switchTab('ai-chat')
  },
  {
    key: 'media', motif: 'picture', colors: ['#f6c7a4', '#e0874f'], hint: '#f9da9e', title: ['hub_media_title', 'Media'], desc: ['hub_media_desc', 'Pictures and files of the community'],
    visible: () => mediaStatus().hasAccess, open: () => openMediaFolder('')
  },
  {
    key: 'songbook', motif: 'notes', colors: ['#aed6ec', '#4a98c4'], hint: '#c9c6f3', title: ['hub_songbook_title', 'Songbook'], desc: ['hub_songbook_desc', 'Songs and lyrics for services and small groups'],
    open: () => switchTab('songbook')
  },
  {
    key: 'prayers', motif: 'heart', colors: ['#f2b5c0', '#d6667c'], hint: '#f8c6ae', title: ['hub_prayers_title', 'Prayer requests'], desc: ['hub_prayers_desc', 'Share requests and pray for each other'],
    open: () => switchTab('prayers')
  },
  {
    key: 'polls', motif: 'poll', colors: ['#acdcc7', '#479f82'], hint: '#d9eab4', title: ['hub_polls_title', 'Anonymous polls'], desc: ['hub_polls_desc', 'Ask for opinions without names'],
    visible: () => FEATURES.polls, open: () => switchTab('polls')
  }
];

/** Opening an app from Extras goes one level down: back returns to Extras. */
function openHubApp(app: HubApp) {
  const fromHub = activeTab() === 'hub';
  app.open();
  if (fromHub && activeTab() !== 'hub') pushHistoryLevel('app');
}

// A tile: a rounded card that lifts a little under the pointer. [--app-tone]: its arrow and "Start chat" - the deep
// tone in light mode, the light one in the dark
const TILE = [
  'group/tile relative isolate flex min-w-0 items-center overflow-hidden rounded-[22px] border border-hairline bg-surface text-left text-text',
  'shadow-[0_6px_14px_rgba(28,25,23,0.1)] dark:shadow-[0_6px_14px_rgba(0,0,0,0.45)] [--app-tone:var(--app-color)] dark:[--app-tone:var(--app-light)]',
  'animate-[hubTileIn_0.5s_cubic-bezier(0.4,0,0.2,1)_calc(var(--i)_*_55ms)_backwards] transition-[transform,box-shadow,border-color] duration-300 ease-app',
  'motion-safe:hover:[transform:translateY(-2px)] hover:border-[color-mix(in_srgb,var(--app-color)_28%,var(--border-light))] hover:shadow-[0_10px_22px_rgba(28,25,23,0.13)] dark:hover:shadow-[0_10px_22px_rgba(0,0,0,0.55)]',
  'active:[transform:scale(0.985)] active:duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'
];
const TEXTS = 'flex min-w-0 flex-1 flex-col gap-[3px]';

function AppTexts(props: { app: HubApp }) {
  return (
    <>
      <span class="overflow-hidden text-[1.02rem] font-bold tracking-[-0.015em] text-ellipsis whitespace-nowrap">{t(...props.app.title)}</span>
      <span class="text-[0.84rem] leading-[1.4] text-text-secondary">{t(...props.app.desc)}</span>
    </>
  );
}

/** The AI chat: a breath of sand from the upper right corner that fades out past the middle of the tile, the
 *  assistant's sign - and once more, still and faint, in the corner - and "Start chat" (only the arrow on phones). */
function FeaturedTile(props: { app: FeaturedApp; index: number }) {
  return (
    <button
      type="button"
      class={[
        TILE,
        'col-span-full py-4 pr-3.5 pl-4',
        "before:pointer-events-none before:absolute before:top-0 before:right-0 before:-z-2 before:aspect-square before:w-[120%] before:translate-x-1/2 before:-translate-y-1/2 before:content-['']",
        'before:bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--app-light)_20%,transparent),transparent)] dark:before:bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--app-color)_14%,transparent),transparent)]'
      ]}
      style={{ '--app-light': props.app.colors[0], '--app-color': props.app.colors[1], '--i': String(props.index) }}
      onClick={() => openHubApp(props.app)}
    >
      <AiSign size={132} still time={9} glow={false} class="pointer-events-none absolute -top-[58px] -right-[38px] -z-1 opacity-[0.08] dark:opacity-[0.07]" />
      <AiSign size={42} class="inline-grid size-[46px] shrink-0 place-items-center" />
      <span class={[TEXTS, 'px-3.5']}>
        <AppTexts app={props.app} />
      </span>
      <span class="inline-flex shrink-0 items-center gap-0.5 rounded-full text-[0.8rem] font-semibold whitespace-nowrap text-(--app-tone) transition-[transform,background-color] duration-[250ms] ease-app max-phablet:opacity-75 phablet:bg-[color-mix(in_srgb,var(--app-light)_22%,var(--surface))] phablet:py-[7px] phablet:pr-2.5 phablet:pl-3.5 phablet:group-hover/tile:[transform:translateX(3px)] phablet:group-hover/tile:bg-[color-mix(in_srgb,var(--app-light)_34%,var(--surface))] dark:phablet:bg-[color-mix(in_srgb,var(--app-light)_16%,var(--surface))]">
        <span class="max-phablet:hidden">{t('hub_ai_cta', 'Start chat')}</span>
        <Icon name="chevronRight" size={16} strokeWidth={2.6} class="max-phablet:size-[18px]" />
      </span>
    </button>
  );
}

/** Another app: its motif in a painted field, its name and what it offers, an arrow in its colour. */
function AppTile(props: { app: MotifApp; index: number }) {
  const field = () =>
    paintedField(
      { light: props.app.colors[0], deep: props.app.colors[1], hint: props.app.hint },
      MOTIF_SEEDS[props.app.motif] || 0,
      motifSvg(props.app.motif),
      'hub-app-field size-[76px] rounded-[15.2px]'
    );
  return (
    <button
      type="button"
      class={[TILE, 'p-2']}
      style={{ '--app-light': props.app.colors[0], '--app-color': props.app.colors[1], '--i': String(props.index) }}
      onClick={() => openHubApp(props.app)}
    >
      {/* eslint-disable-next-line solid/no-innerhtml -- trusted markup of lib/motifs.ts (fixed shapes, the app's own colours) */}
      <span class="contents" innerHTML={field()} />
      <span class={[TEXTS, 'pr-2 pl-3.5']}>
        <AppTexts app={props.app} />
      </span>
      <span class="mr-2 inline-flex shrink-0 text-(--app-tone) opacity-80 transition-[transform,opacity] duration-[250ms] ease-app group-hover/tile:opacity-100 motion-safe:group-hover/tile:[transform:translateX(3px)]">
        <Icon name="chevronRight" size={18} strokeWidth={2.4} />
      </span>
    </button>
  );
}

export function HubPage() {
  const apps = createMemo(() => HUB_APPS.filter(app => !app.visible || app.visible()));
  return (
    <>
      <div class="mb-5">
        <h1 class="m-0 text-[1.6rem] font-[750] text-text dark:text-[#e4ded6]">{t('hub_title', 'Extras')}</h1>
        <p class="mt-1 mb-0 text-[0.92rem] text-text-secondary">{t('hub_subtitle', 'More offers of the community in one place.')}</p>
      </div>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3.5">
        <For each={apps()}>
          {(app, index) => (app.featured ? <FeaturedTile app={app} index={index()} /> : <AppTile app={app} index={index()} />)}
        </For>
      </div>
    </>
  );
}
