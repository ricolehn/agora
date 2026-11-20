// What the two cards of the fees page and their dialogs share: the fees in the order of the settings, the state of a
// change or a fresh start, the rows, the log of who changed what, and the numbers of a dialog as tiles.
import type { JSX } from '@solidjs/web';
import { For, Show } from 'solid-js';
import { dateTimeFormatter, euro, t } from '../../../../app/i18n';
import { pad2 } from '../../../../app/util';

export const FEE_KEYS = ['vollverdiener', 'geringverdiener', 'keinverdiener'] as const;
export type FeeKey = (typeof FEE_KEYS)[number];
export type Fees = Partial<Record<FeeKey, number>>;

/** "50,00 € / 25,00 € / 10,00 €": the monthly fees in the order of the fee settings. */
export const feeListText = (fees: Fees | undefined) =>
  FEE_KEYS.filter(key => typeof fees?.[key] === 'number').map(key => euro(fees![key])).join(' / ');

/** 'YYYY-MM' with [count] months added. */
export function addMonths(month: string, count: number) {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + count;
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
}

// A fresh start and a change of the fees say what they are today with the same three words
export type FeeState = 'active' | 'planned' | 'ended';
const STATES: Record<string, FeeState> = { active: 'active', current: 'active', scheduled: 'planned', planned: 'planned', replaced: 'ended', past: 'ended' };
export const feeStateOf = (state: string | undefined): FeeState => STATES[state || ''] || 'ended';
export function feeStateLabel(state: string | undefined) {
  if (['active', 'current'].includes(state || '')) return t('fee_reset_state_active', 'In effect');
  if (['scheduled', 'planned'].includes(state || '')) return t('fee_reset_state_scheduled', 'Planned');
  return t('fee_reset_state_replaced', 'Replaced');
}

/** The state as a small pill (.so-row-state). */
export function StateBadge(props: { state: string | undefined }) {
  return (
    <span
      class={[
        'shrink-0 rounded-full px-[9px] py-[3px] text-[0.72rem] font-[650]',
        {
          active: 'bg-[color-mix(in_srgb,var(--success)_13%,var(--surface))] text-[color-mix(in_srgb,var(--success)_85%,var(--text))]',
          planned: 'bg-[color-mix(in_srgb,var(--warning)_15%,var(--surface))] text-[color-mix(in_srgb,var(--warning)_70%,var(--text))]',
          ended: 'bg-surface-alt text-text-secondary'
        }[feeStateOf(props.state)]
      ]}
    >
      {feeStateLabel(props.state)}
    </span>
  );
}

/** The rows of a card (.so-rows) and one row (.so-row.fee-reset-row): a replaced one is quieter. */
export function Rows(props: { class?: string; children?: JSX.Element }) {
  return <div class={['overflow-hidden rounded-2xl border border-hairline bg-surface [&>*+*]:border-t [&>*+*]:border-hairline', props.class]}>{props.children}</div>;
}
export function Row(props: { ended: boolean; children?: JSX.Element }) {
  return <div class={['flex items-center gap-3 py-[11px] pr-3 pl-4', { 'opacity-60': props.ended }]}>{props.children}</div>;
}
export const ROW_FACTS = 'text-[0.78rem] text-text-secondary';

/** The round button at the end of a row (.so-row-edit): edit or take back. */
export function RowButton(props: { icon: JSX.Element; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-hairline bg-surface-alt text-text-secondary hover:bg-border-light hover:text-text [&+&]:-ml-1"
      title={props.label}
      aria-label={props.label}
      onClick={() => props.onClick()}
    >
      {props.icon}
    </button>
  );
}

/** The head of a card: its symbol in a tinted square, the title and a line about it (.fee-reset-head). */
export function FeeCardHead(props: { icon: JSX.Element; tone: 'success' | 'warning'; title: string; desc: string }) {
  return (
    <div class="mb-3.5 flex items-start gap-3">
      <span
        class={[
          'inline-flex size-10 shrink-0 items-center justify-center rounded-xl',
          props.tone === 'success'
            ? 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-success'
            : 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-warning'
        ]}
        aria-hidden="true"
      >
        {props.icon}
      </span>
      <div class="min-w-0">
        <h3 class="m-0 mb-[3px] text-base font-bold tracking-[-0.01em] text-text">{props.title}</h3>
        <p class="m-0 text-[0.84rem] leading-normal text-text-secondary">{props.desc}</p>
      </div>
    </div>
  );
}

/** The quiet line below a card's controls (.fee-reset-form-hint). */
export function FormHint(props: { id?: string; children?: JSX.Element }) {
  return (
    <p id={props.id} class="mt-2 text-[0.8rem] leading-[1.45] text-text-secondary">
      {props.children}
    </p>
  );
}

/** Who set or took back what, the newest first (the last ten), folded away below a card. */
export function FeeLog(props: { id: string; entries: any[]; textOf: (entry: any, name: string) => string }) {
  const lines = () => [...props.entries].reverse().slice(0, 10);
  return (
    <Show when={lines().length > 0}>
      <details id={props.id} class="mt-3.5 text-[0.8rem] text-text-secondary">
        <summary class="cursor-pointer font-semibold">{t('fee_reset_log_title', 'Changes')}</summary>
        <ul class="mt-2 flex flex-col gap-1.5 p-0">
          <For each={lines()}>
            {entry => (
              <li class="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                {props.textOf(entry, entry.byName || t('status_unknown', 'Unknown'))}
                <Show when={entry.at}>
                  <span class="whitespace-nowrap opacity-75">{dateTimeFormatter.format(new Date(entry.at))}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </details>
    </Show>
  );
}

// --- The numbers of a dialog as tiles: the amount, what it is, how many members ---
export type ImpactSide = { total: number; count: number };
const membersText = (count: number) =>
  count === 1 ? t('fee_reset_members_one', '1 member') : count ? t('fee_reset_members', '{count} members', { count }) : t('fee_reset_members_none', 'Nobody');

/** One tile; without members it stays grey (nothing to look at there). */
export function ImpactTile(props: { side: ImpactSide; label: string; tone: 'danger' | 'success' | 'warning' }) {
  return (
    <div
      class={[
        'flex min-w-0 flex-[1_1_0] flex-col gap-px rounded-xl border px-3 py-2.5',
        props.side.count
          ? 'border-[color-mix(in_srgb,var(--tone)_26%,transparent)] bg-[color-mix(in_srgb,var(--tone)_9%,var(--surface))]'
          : 'border-hairline bg-surface'
      ]}
      style={{ '--tone': props.side.count ? `var(--${props.tone})` : 'var(--text-secondary)' }}
    >
      <span class="text-[1.2rem] font-[750] tracking-[-0.02em] text-[color-mix(in_srgb,var(--tone)_78%,var(--text))] tabular-nums">{euro(props.side.total)}</span>
      <span class="text-[0.8rem] font-semibold text-text">{props.label}</span>
      <span class="text-[0.76rem] text-text-secondary">{membersText(props.side.count)}</span>
    </div>
  );
}

/** A few short lines below the numbers (.fee-reset-facts). */
export function Facts(props: { facts: string[] }) {
  return (
    <ul class="mt-0.5 flex list-disc flex-col gap-[5px] pl-[18px] text-[0.84rem] leading-[1.45] text-text-secondary">
      <For each={props.facts.filter(Boolean)}>{fact => <li>{fact}</li>}</For>
    </ul>
  );
}

/** Cancel and the action of a dialog side by side (.fee-reset-actions). */
export function DialogActions(props: { children?: JSX.Element }) {
  return <div class="flex gap-2.5 [&>*]:flex-1">{props.children}</div>;
}
