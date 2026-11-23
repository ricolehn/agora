// Parts the three small apps of Extras share (polls, songbook, prayer requests): the page head with the way back to
// Extras, the filter pills, the empty / loading / error states of a list, and the editor pages that open over the app
// (a new poll, a song).
import type { JSX } from '@solidjs/web';
import { For, Show } from 'solid-js';
import { t } from '../app/i18n';
import { switchTab } from '../app/router';
import { Button } from './Button';
import { EmptyState, Spinner } from './feedback';
import { Icon, type IconName } from './Icon';
import { Modal } from './Modal';
import { Pill, Pills } from './PillTabs';

/** The round "back" button of a sub-page or a full-screen page (.hub-back-btn, .poll-editor-back). */
export function BackButton(props: { onClick: () => void; large?: boolean }) {
  return (
    <button
      type="button"
      class={[
        'inline-flex shrink-0 items-center justify-center rounded-full border border-border-light text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
        props.large ? 'size-[42px] bg-surface shadow-[0_4px_14px_rgba(28,25,23,0.12)]' : 'mr-1 size-[34px] bg-surface-alt'
      ]}
      aria-label={t('btn_back', 'Back')}
      onClick={() => props.onClick()}
    >
      <Icon name="chevronLeft" size={20} strokeWidth={2.4} />
    </button>
  );
}

/**
 * The head of an app page: back to Extras and the title (.polls-head). sticky: the songbook and the prayer requests
 * keep it in reach while scrolling, right below the app header while that shows. class: its margin below (6px).
 */
export function AppHead(props: { title: JSX.Element; sticky?: boolean; class?: string }) {
  return (
    <div
      class={[
        'flex items-center gap-3',
        props.class ?? 'mb-1.5',
        props.sticky && [
          'sticky z-[7] -mx-2 rounded-b-2xl bg-[var(--frost-bg)] p-2 backdrop-blur-[14px] backdrop-saturate-150 transition-[top] duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]',
          'top-[var(--mobile-header-h,68px)] header-hidden:top-0 md:top-[calc(72px-var(--desktop-header-offset))] md:header-hidden:top-[calc(0px-var(--desktop-header-offset))]'
        ]
      ]}
    >
      <BackButton onClick={() => switchTab('hub')} />
      <h1 class="m-0 min-w-0 flex-1 text-[1.25rem] font-extrabold text-text md:text-[1.45rem] dark:text-[#e4ded6]">{props.title}</h1>
    </div>
  );
}

export interface FilterOption<T extends string> {
  value: T;
  label: () => string;
}

/** The filter pills above a list (Running / Finished / Mine; All / Mine). */
export function FilterPills<T extends string>(props: { value: T; options: FilterOption<T>[]; onChange: (value: T) => void }) {
  return (
    <Pills kind="tabs" class="mb-3.5 inline-flex gap-0.5 rounded-full border border-hairline bg-surface-alt p-[3px]">
      <For each={props.options}>
        {option => (
          <Pill
            chosen={props.value === option.value}
            class={[
              'rounded-full px-4 py-[7px] text-[0.86rem] font-semibold',
              props.value === option.value
                ? 'bg-surface text-text shadow-[0_1px_2px_rgba(48,38,26,0.1),0_0_0_0.5px_rgba(48,38,26,0.06)]'
                : 'bg-transparent text-text-secondary'
            ]}
            onSelect={() => props.onChange(option.value)}
          >
            {option.label()}
          </Pill>
        )}
      </For>
    </Pills>
  );
}

/** The tint of the round symbol of an empty list: amber (polls), lagoon (songbook), rose (prayer requests). */
export type EmptyTone = 'amber' | 'brand' | 'rose';
const EMPTY_TONES: Record<EmptyTone, string> = {
  amber: 'bg-[rgba(245,158,11,0.13)] text-[#d97706]',
  brand: 'bg-brand/12 text-brand-deep',
  rose: 'bg-[color-mix(in_srgb,#e11d48_10%,var(--surface))] text-[#e11d48]'
};

/** An empty list (or a first load that failed, with "Try again"): the soft card with a round symbol (.polls-empty). */
export function ListEmpty(props: { icon: IconName; tone: EmptyTone; title: JSX.Element; hint?: JSX.Element; onRetry?: () => void }) {
  return (
    <EmptyState
      icon={<Icon name={props.icon} size={26} strokeWidth={1.8} />}
      iconClass={EMPTY_TONES[props.tone]}
      title={props.title}
      text={props.hint}
      action={
        <Show when={props.onRetry}>
          <Button variant="secondary" onClick={() => props.onRetry?.()}>
            {t('btn_retry', 'Try again')}
          </Button>
        </Show>
      }
    />
  );
}

/** A list that is still loading for the first time. */
export function ListLoading() {
  return (
    <div class="flex justify-center py-12">
      <Spinner />
    </div>
  );
}

/**
 * An editor that fills the window (new poll, a song): the back button and the heading stay on top, one card per part,
 * the buttons in a bar at the bottom (.poll-editor).
 */
export function EditorPage(props: {
  id: string;
  title: JSX.Element;
  onBack: () => void;
  savebar: JSX.Element;
  /** Columns of the save bar (two buttons by default). */
  savebarClass?: string;
  children: JSX.Element;
}) {
  const titleId = () => `${props.id.replace(/-modal$/, '')}-title`;
  return (
    <Modal id={props.id} page labelledBy={titleId()}>
      <div class="flex h-full w-full flex-col gap-4 overflow-y-auto px-5 pt-[calc(12px+env(safe-area-inset-top,0px))] [--pe-field:var(--surface-alt)] dark:[--pe-field:rgba(28,25,23,0.55)]">
        <div class="sticky top-[calc(-12px-env(safe-area-inset-top,0px))] z-[5] -mx-5 -mt-3 flex items-center gap-3 bg-[var(--frost-bg)] px-5 pt-3 pb-2 backdrop-blur-[14px] backdrop-saturate-150">
          <BackButton large onClick={() => props.onBack()} />
          <h2 id={titleId()} class="m-0 text-[1.15rem] font-extrabold text-text">
            {props.title}
          </h2>
        </div>
        {props.children}
        <div
          class={[
            'sticky bottom-0 -mx-5 mt-auto grid gap-2.5 border-t border-border-light bg-[var(--frost-bg)] px-5 pt-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))] backdrop-blur-[14px] backdrop-saturate-150',
            props.savebarClass || 'grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]'
          ]}
        >
          {props.savebar}
        </div>
      </div>
    </Modal>
  );
}

export type ChipTone = 'cyan' | 'indigo' | 'amber';
const CHIP_TONES: Record<ChipTone, string> = {
  cyan: 'bg-brand/12 text-brand-deep',
  indigo: 'bg-[rgba(99,102,241,0.12)] text-[#6366f1]',
  amber: 'bg-[rgba(245,158,11,0.13)] text-[#d97706]'
};

/** One part of an editor page: a card with a tinted symbol and its name (.poll-editor-card). */
export function EditorCard(props: { icon: JSX.Element; tone: ChipTone; label: JSX.Element; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-3 rounded-[18px] border border-border-light bg-surface p-4 shadow-[0_1px_2px_rgba(28,25,23,0.04),0_6px_18px_-14px_rgba(28,25,23,0.25)]">
      <div class="flex items-center gap-2.5 text-[0.98rem] font-bold text-text">
        <span class={['inline-flex size-[34px] shrink-0 items-center justify-center rounded-[11px]', CHIP_TONES[props.tone]]}>{props.icon}</span>
        <span>{props.label}</span>
      </div>
      {props.children}
    </section>
  );
}

/**
 * The fields of an editor page (.poll-editor-input): EDITOR_INPUT a line, TITLE_INPUT the large first line, TEXT_AREA
 * longer text; EDITOR_FIELD is the common look for fields of their own size.
 */
export const EDITOR_FIELD =
  'm-0 w-full rounded-[13px] border-[1.5px] border-border-light bg-[var(--pe-field)] px-3.5 text-text transition-[border-color,box-shadow,background-color] duration-150 ease-[ease] ' +
  'placeholder:text-text-secondary placeholder:opacity-75 focus:border-primary focus:bg-surface focus:shadow-[0_0_0_4px_rgba(var(--brand-rgb),0.16)] focus:outline-none';
export const EDITOR_INPUT = `${EDITOR_FIELD} min-h-12 text-[1rem]`;
export const TITLE_INPUT = `${EDITOR_FIELD} min-h-[54px] text-[1.15rem] font-bold`;
export const TEXT_AREA = `${EDITOR_FIELD} min-h-24 resize-y py-3 text-[1rem] leading-[1.55]`;

/** A labelled field of an editor page (.poll-field). */
export function EditorField(props: { label: JSX.Element; children: JSX.Element }) {
  return (
    <label class="flex min-w-0 flex-col gap-1.5 text-[0.8rem] font-semibold text-text-secondary">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

/** The red outlined "Delete" of a poll or a song (.poll-delete-btn). */
export function DeleteButton(props: { id?: string; size?: 'md' | 'small'; class?: string; onClick: () => void; children: JSX.Element }) {
  return (
    <Button
      id={props.id}
      variant="none"
      size={props.size}
      class={['border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-transparent text-danger', props.class]}
      onClick={() => props.onClick()}
    >
      {props.children}
    </Button>
  );
}
