// What goes into the report: the kind (a year, a period, a member, hand-picked bookings), its dates and how detailed
// it is.
import type { JSX } from '@solidjs/web';
import { For, Show } from 'solid-js';
import { type Person } from '../../../app/data';
import { euro, formatDateFast, t } from '../../../app/i18n';
import { Input, Select } from '../../../ui/form';
import { Icon } from '../../../ui/Icon';
import { Pill, Pills } from '../../../ui/PillTabs';
import {
  REPORT_TIER_HINTS, customFrom, customTo, personFrom, personTo, reportKey, reportPeople, reportPersonId, reportTier, reportTransactions,
  reportType, reportYear, reportYears, selectedKeys, setCustomFrom, setCustomTo, setPersonFrom, setPersonTo, setReportPersonId,
  setReportTier, setReportType, setReportYear, toggleReportTransaction, type ReportTier, type ReportType
} from './report';
import { txColor, txSign } from './state';

const TIERS: { tier: ReportTier; label: [string, string] }[] = [
  { tier: 'compact', label: ['report_tier_compact', 'Compact'] },
  { tier: 'standard', label: ['report_tier_standard', 'Standard'] },
  { tier: 'detailed', label: ['report_tier_detailed', 'Detailed'] }
];

// --- Choosing what goes into the report ---
const TYPE_CARDS: { type: ReportType; title: [string, string]; desc: [string, string]; icon: () => JSX.Element }[] = [
  {
    type: 'annual',
    title: ['report_type_annual', 'Annual overview'],
    desc: ['report_type_annual_desc', 'A whole year'],
    icon: () => <Icon name="calendar" size={18} />
  },
  {
    type: 'custom',
    title: ['report_type_custom', 'Period'],
    desc: ['report_type_custom_desc', 'From – to'],
    icon: () => <Icon name="clock" size={18} />
  },
  {
    type: 'person',
    title: ['report_type_person', 'One person'],
    desc: ['report_type_person_desc', 'Fees of one member'],
    icon: () => <Icon name="user" size={18} />
  },
  {
    type: 'manual',
    title: ['report_type_manual', 'Selection'],
    desc: ['report_type_manual_desc', 'Tick bookings'],
    icon: () => (
      <Icon name="checkBox" size={18} />
    )
  }
];

/** A part of the settings. The parts that depend on the report type are blocks, as before: their title runs inline
 *  and the controls follow without a gap. */
function Section(props: { title: string; for?: string; block?: boolean; children: JSX.Element }) {
  const titleClass = 'text-72 font-extrabold tracking-[0.06em] text-text-secondary uppercase';
  return (
    <section class={props.block ? 'block' : 'flex flex-col gap-2.5'}>
      <Show when={props.for} fallback={<span class={[titleClass, { inline: !!props.block }]}>{props.title}</span>}>
        <label class={[titleClass, { inline: !!props.block }]} for={props.for}>
          {props.title}
        </label>
      </Show>
      {props.children}
    </section>
  );
}

function DateField(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label class="flex min-w-0 flex-col gap-1 text-78 font-semibold text-text-secondary">
      <span>{props.label}</span>
      <Input type="date" class="m-0 min-w-0" value={props.value} onChange={e => props.onChange(e.currentTarget.value)} />
    </label>
  );
}

function DateRow(props: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  return (
    <div class="grid grid-cols-2 gap-2.5">
      <DateField label={t('report_from', 'From')} value={props.from} onChange={props.setFrom} />
      <DateField label={t('report_to', 'To')} value={props.to} onChange={props.setTo} />
    </div>
  );
}

function Checklist() {
  return (
    <div class="max-h-[300px] overflow-y-auto rounded-[14px] border border-border-light bg-surface-alt p-1">
      <For
        each={reportTransactions()}
        fallback={<div class="p-5 text-center text-text-secondary">{t('no_transactions', 'No transactions found.')}</div>}
      >
        {(tx, idx) => {
          const key = () => reportKey(tx, idx());
          return (
            <div
              class="flex cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-[9px] text-85 text-text hover:bg-surface"
              onClick={() => toggleReportTransaction(key())}
            >
              <input
                type="checkbox"
                class="size-4 cursor-pointer accent-primary"
                value={key()}
                checked={selectedKeys().has(key())}
                onClick={e => {
                  e.stopPropagation();
                  toggleReportTransaction(key());
                }}
              />
              <div class="flex flex-col">
                <span class="font-semibold">{tx.who}</span>
                <span class="text-75 text-text-secondary">
                  {tx.date ? formatDateFast(tx.date) : ''} &bull;{' '}
                  <span class={txColor(tx)}>
                    {txSign(tx)}
                    {euro(tx.amount)}
                  </span>
                </span>
              </div>
            </div>
          );
        }}
      </For>
    </div>
  );
}

export function ConfigPanel(props: { onTypeChange: () => void }) {
  const pick = (type: ReportType) => {
    setReportType(type);
    props.onTypeChange();
  };
  return (
    <div class="flex shrink-0 flex-col gap-[18px] overflow-y-auto border-b border-border bg-surface p-4 md:w-[340px] md:gap-[22px] md:border-r md:border-b-0 md:border-border-light md:p-5">
      <Section title={t('report_type', 'Report Type')}>
        <div class="grid grid-cols-2 gap-2.5">
          <For each={TYPE_CARDS}>
            {card => {
              const active = () => reportType() === card.type;
              return (
                <button
                  type="button"
                  class={[
                    'flex min-w-0 cursor-pointer flex-col items-start gap-0.5 rounded-[14px] border-[1.5px] p-2.5 text-left transition-[border-color,background,box-shadow] duration-150 md:p-3',
                    active()
                      ? 'border-primary bg-[color-mix(in_srgb,var(--primary)_7%,var(--surface))] shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_14%,transparent)]'
                      : 'border-border-light bg-surface hover:border-border'
                  ]}
                  onClick={() => pick(card.type)}
                >
                  <span
                    class={[
                      'mb-1 inline-flex size-7 items-center justify-center rounded-[10px] md:mb-1.5 md:size-8',
                      active() ? 'bg-primary text-white' : 'bg-surface-alt text-text-secondary'
                    ]}
                  >
                    {card.icon()}
                  </span>
                  <span class="text-90 font-bold text-text">{t(...card.title)}</span>
                  <span class="hidden text-75 leading-[1.35] text-text-secondary md:inline">{t(...card.desc)}</span>
                </button>
              );
            }}
          </For>
        </div>
      </Section>

      <Show when={reportType() === 'annual'}>
        <Section title={t('report_year', 'Year')} for="report-year-select" block>
          <Select id="report-year-select" value={reportYear()} onChange={e => setReportYear(e.currentTarget.value)}>
            <For each={reportYears()}>{year => <option value={String(year)}>{year}</option>}</For>
          </Select>
        </Section>
      </Show>

      <Show when={reportType() === 'custom'}>
        <Section title={t('report_period', 'Period')} block>
          <DateRow from={customFrom()} to={customTo()} setFrom={setCustomFrom} setTo={setCustomTo} />
        </Section>
      </Show>

      <Show when={reportType() === 'person'}>
        <Section title={t('report_person', 'Member / Person')} for="report-person-select" block>
          <Select id="report-person-select" value={reportPersonId()} onChange={e => setReportPersonId(e.currentTarget.value)}>
            <For each={reportPeople()}>{(p: Person) => <option value={String(p.id)}>{p.name}</option>}</For>
          </Select>
          <DateRow from={personFrom()} to={personTo()} setFrom={setPersonFrom} setTo={setPersonTo} />
        </Section>
      </Show>

      <Show when={reportType() === 'manual'}>
        <Section title={t('report_transactions_select', 'Select bookings')} block>
          <Checklist />
        </Section>
      </Show>

      <Section title={t('report_detail_tier', 'Level of Detail')}>
        <Pills kind="tabs" class="grid grid-cols-3 gap-0.5 rounded-xl border border-border-light bg-surface-alt p-[3px]">
          <For each={TIERS}>
            {tab => (
              <Pill
                chosen={reportTier() === tab.tier}
                class={[
                  'min-w-0 cursor-pointer truncate rounded-[9px] px-1.5 py-2 text-85 font-bold',
                  reportTier() === tab.tier ? 'bg-surface text-text shadow-[0_1px_3px_rgba(28,25,23,0.12)]' : 'bg-transparent text-text-secondary'
                ]}
                onSelect={() => setReportTier(tab.tier)}
              >
                {t(...tab.label)}
              </Pill>
            )}
          </For>
        </Pills>
        <span class="text-78 text-text-secondary">{t(...REPORT_TIER_HINTS[reportTier()])}</span>
      </Section>
    </div>
  );
}
