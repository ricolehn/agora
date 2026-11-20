// The financial report dialog (export-report-modal): what goes into the report on the left, the A4 page it becomes on
// the right (a phone shows them one below the other), the PDF download at the bottom. The page is white paper in both
// themes and uses plain colours only: the PDF renderer (html2canvas) cannot read color-mix() or oklch().
import type { JSX } from '@solidjs/web';
import { For, Match, Show, Switch, createMemo, createSignal, onSettled } from 'solid-js';
import { appName } from '../../../app/config';
import type { Person } from '../../../app/data';
import { euro, formatDateFast, t } from '../../../app/i18n';
import { closeModal } from '../../../app/modals';
import { getTodayStr } from '../../../app/util';
import { Button } from '../../../ui/Button';
import { Spinner } from '../../../ui/feedback';
import { Input, Select } from '../../../ui/form';
import { Icon } from '../../../ui/Icon';
import { Modal } from '../../../ui/Modal';
import {
  REPORT_TIER_HINTS, REPORT_TYPE_LABELS, bookingsCount, customFrom, customTo, downloadReportPdf, generating, personFrom, personTo,
  reportKey, reportPeople, reportPersonId, reportStatus, reportTier, reportTotals, reportTransactions, reportType, reportYear, reportYears,
  selectReportTransactions, selectedKeys, setCustomFrom, setCustomTo, setPersonFrom, setPersonTo, setReportPersonId, setReportTier,
  setReportType, setReportYear, sumAmounts, toggleReportTransaction, type ReportTier, type ReportType
} from './report';
import { txColor, txSign, type Transaction } from './state';

const PAGE_WIDTH = 794;

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
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="9 11 12 14 22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    )
  }
];
const TIERS: { tier: ReportTier; label: [string, string] }[] = [
  { tier: 'compact', label: ['report_tier_compact', 'Compact'] },
  { tier: 'standard', label: ['report_tier_standard', 'Standard'] },
  { tier: 'detailed', label: ['report_tier_detailed', 'Detailed'] }
];

function Section(props: { title: string; for?: string; children: JSX.Element }) {
  const titleClass = 'text-[0.72rem] font-extrabold tracking-[0.06em] text-text-secondary uppercase';
  return (
    <section class="flex flex-col gap-2.5">
      <Show when={props.for} fallback={<span class={titleClass}>{props.title}</span>}>
        <label class={titleClass} for={props.for}>
          {props.title}
        </label>
      </Show>
      {props.children}
    </section>
  );
}

function DateField(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label class="flex min-w-0 flex-col gap-1 text-[0.78rem] font-semibold text-text-secondary">
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
              class="flex cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-[9px] text-[0.85rem] text-text hover:bg-surface"
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
                <span class="text-[0.75rem] text-text-secondary">
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

function ConfigPanel(props: { onTypeChange: () => void }) {
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
                  <span class="text-[0.9rem] font-bold text-text">{t(...card.title)}</span>
                  <span class="hidden text-[0.75rem] leading-[1.35] text-text-secondary md:inline">{t(...card.desc)}</span>
                </button>
              );
            }}
          </For>
        </div>
      </Section>

      <Show when={reportType() === 'annual'}>
        <Section title={t('report_year', 'Year')} for="report-year-select">
          <Select id="report-year-select" value={reportYear()} onChange={e => setReportYear(e.currentTarget.value)}>
            <For each={reportYears()}>{year => <option value={String(year)}>{year}</option>}</For>
          </Select>
        </Section>
      </Show>

      <Show when={reportType() === 'custom'}>
        <Section title={t('report_period', 'Period')}>
          <DateRow from={customFrom()} to={customTo()} setFrom={setCustomFrom} setTo={setCustomTo} />
        </Section>
      </Show>

      <Show when={reportType() === 'person'}>
        <Section title={t('report_person', 'Member / Person')} for="report-person-select">
          <Select id="report-person-select" value={reportPersonId()} onChange={e => setReportPersonId(e.currentTarget.value)}>
            <For each={reportPeople()}>{(p: Person) => <option value={String(p.id)}>{p.name}</option>}</For>
          </Select>
          <DateRow from={personFrom()} to={personTo()} setFrom={setPersonFrom} setTo={setPersonTo} />
        </Section>
      </Show>

      <Show when={reportType() === 'manual'}>
        <Section title={t('report_transactions_select', 'Select bookings')}>
          <Checklist />
        </Section>
      </Show>

      <Section title={t('report_detail_tier', 'Level of Detail')}>
        <div class="grid grid-cols-3 gap-0.5 rounded-xl border border-border-light bg-surface-alt p-[3px]" role="tablist">
          <For each={TIERS}>
            {tab => (
              <button
                type="button"
                role="tab"
                aria-selected={reportTier() === tab.tier ? 'true' : 'false'}
                class={[
                  'min-w-0 cursor-pointer truncate rounded-[9px] px-1.5 py-2 text-[0.84rem] font-bold',
                  reportTier() === tab.tier ? 'bg-surface text-text shadow-[0_1px_3px_rgba(28,25,23,0.12)]' : 'bg-transparent text-text-secondary'
                ]}
                onClick={() => setReportTier(tab.tier)}
              >
                {t(...tab.label)}
              </button>
            )}
          </For>
        </div>
        <span class="text-[0.78rem] text-text-secondary">{t(...REPORT_TIER_HINTS[reportTier()])}</span>
      </Section>
    </div>
  );
}

// --- The A4 page ---
const TYPE_PILLS: Record<string, string> = {
  pay: 'border-[#a7f3d0] bg-[#ecfdf5] text-[#059669]',
  don: 'border-[#ddd6fe] bg-[#f5f3ff] text-[#7c3aed]',
  exp: 'border-[#fecaca] bg-[#fef2f2] text-[#dc2626]'
};
const TD = 'border-b border-[#eef2f6] px-3.5 py-2.5 align-top text-[12.5px] text-[#334155]';
const TH = 'border-b border-[#e7e5e4] bg-[#f5f5f4] px-3.5 py-2.5 text-left text-[10px] font-extrabold tracking-[0.08em] text-[#78716c] uppercase';
// Even rows a breath of blue; the last row of the body has no line (the table's frame closes it)
const TR = 'break-inside-avoid even:bg-[#fbfdff] [&:last-child>td]:border-b-0';
const AMOUNT = 'text-right font-bold whitespace-nowrap tabular-nums';
// The amounts always in their colour (the cells' own text colour gives way)
const amountColor = (expense: boolean) => (expense ? '!text-[#dc2626]' : '!text-[#059669]');
const signed = (value: number) => `${value >= 0 ? '+' : ''}${euro(value)}`;

function TypePill(props: { type: string }) {
  const label = () => REPORT_TYPE_LABELS[props.type] || REPORT_TYPE_LABELS.exp;
  return (
    <span class={['inline-flex items-center rounded-full border px-[9px] py-0.5 text-[11px] font-bold whitespace-nowrap', TYPE_PILLS[props.type] || TYPE_PILLS.exp]}>
      {t(...label())}
    </span>
  );
}

function BookingRows(props: { tx: Transaction; tier: ReportTier }) {
  const isExp = () => props.tx.type === 'exp';
  const kind = () => t(...(REPORT_TYPE_LABELS[props.tx.type] || REPORT_TYPE_LABELS.exp));
  const partner = () =>
    props.tx.type === 'pay' ? props.tx.who : props.tx.type === 'don' ? props.tx.who || kind() : props.tx.description || props.tx.who || kind();
  const issuer = () => (isExp() && props.tx.description && props.tx.who && props.tx.who !== props.tx.description ? props.tx.who : '');
  const notes = () => (!isExp() ? props.tx.description || props.tx.note || '' : '');
  const tags = () => (props.tx.tags ? (Array.isArray(props.tx.tags) ? props.tx.tags : [props.tx.tags]) : []);
  return (
    <>
      <tr class={TR}>
        <td class={[TD, 'whitespace-nowrap !text-[#64748b] tabular-nums']}>{props.tx.date ? formatDateFast(props.tx.date) : ''}</td>
        <td class={TD}>
          <TypePill type={props.tx.type} />
        </td>
        <td class={[TD, 'font-semibold !text-[#0f172a]']}>
          {partner()}
          <Show when={issuer()}>
            <span class="block text-[11px] font-medium text-[#94a3b8]">{issuer()}</span>
          </Show>
        </td>
        <td class={[TD, AMOUNT, amountColor(isExp())]}>
          {txSign(props.tx)}
          {euro(props.tx.amount)}
        </td>
      </tr>
      <Show when={props.tier === 'detailed' && (notes() || props.tx.receipt || tags().length > 0)}>
        <tr class={[TR, 'bg-[#fafaf9]']}>
          <td class={[TD, 'pt-1 pb-2']} />
          <td class={[TD, 'pt-1 pb-2']} colspan={3}>
            <Show when={notes()}>
              <div class="mb-1 italic">„{notes()}“</div>
            </Show>
            <Show when={tags().length}>
              <div>
                <For each={tags()}>
                  {tag => <span class="mr-[5px] inline-block rounded px-1.5 py-0.5 text-[0.75rem] bg-[#e0f2fe] text-[#0369a1]">{tag}</span>}
                </For>
              </div>
            </Show>
            <Show when={props.tx.receipt}>
              <div class="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-[#0d9488]">
                <Icon name="paperclip" size={12} strokeWidth={2.5} />
                <span>{t('report_receipt_attached', 'Receipt attached')}</span>
              </div>
            </Show>
          </td>
        </tr>
      </Show>
    </>
  );
}

function Breakdown(props: { filtered: Transaction[] }) {
  const kinds = () =>
    ['pay', 'don', 'exp']
      .map(type => ({ type, items: props.filtered.filter(tx => (tx.type === 'exp' ? 'exp' : tx.type) === type) }))
      .filter(kind => kind.items.length);
  return (
    <table class="preview-table mt-[15px] w-full border-separate border-spacing-0 overflow-hidden rounded-xl border border-[#e2e8f0]">
      <thead>
        <tr class="break-inside-avoid">
          <th class={TH}>{t('report_table_type', 'Kind')}</th>
          <th class={TH}>{t('report_table_count', 'Count')}</th>
          <th class={TH} style={{ 'text-align': 'right' }}>
            {t('report_table_amount', 'Amount')}
          </th>
        </tr>
      </thead>
      <tbody>
        <For each={kinds()}>
          {kind => (
            <tr class={TR}>
              <td class={TD}>
                <TypePill type={kind.type} />
              </td>
              <td class={[TD, '!text-[#64748b]']}>{bookingsCount(kind.items.length)}</td>
              <td class={[TD, AMOUNT, amountColor(kind.type === 'exp')]}>
                {kind.type === 'exp' ? '-' : '+'}
                {euro(sumAmounts(kind.items))}
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}

const STAT_BARS: Record<string, string> = {
  income: 'before:bg-[#10b981]',
  expense: 'before:bg-[#ef4444]',
  balance: 'before:bg-[#0891b2]'
};
const STAT_VALUES: Record<string, string> = { income: 'text-[#10b981]', expense: 'text-[#ef4444]', balance: 'text-[#0f172a]' };

function StatCard(props: { label: string; kind: 'income' | 'expense' | 'balance'; value: string; note?: string; text?: boolean }) {
  return (
    <div
      class={[
        'preview-stat-card relative break-inside-avoid overflow-hidden rounded-[14px] border border-[#e7e5e4] bg-[#fafaf9] px-[18px] pt-4 pb-3.5 text-left',
        "before:absolute before:top-0 before:bottom-0 before:left-0 before:w-1 before:content-['']",
        STAT_BARS[props.kind]
      ]}
    >
      <div class="mb-[5px] text-[10px] font-extrabold tracking-[0.08em] text-[#64748b] uppercase">{props.label}</div>
      <div
        class={[
          'mt-1 font-extrabold tracking-[-0.01em]',
          props.text ? 'text-[17px] leading-[1.3]' : 'text-[22px]',
          STAT_VALUES[props.kind]
        ]}
      >
        {props.value}
      </div>
      <Show when={props.note}>
        <div class="mt-0.5 text-[11px] font-semibold text-[#a8a29e]">{props.note}</div>
      </Show>
    </div>
  );
}

function ReportPage(props: { selection: ReturnType<typeof selectReportTransactions> }) {
  const filtered = () => props.selection.filtered;
  const totals = () => reportTotals(filtered());
  const countOf = (list: Transaction[]) => bookingsCount(list.length);
  const kindTitle = () =>
    ({
      annual: t('report_kind_annual', 'Annual overview'),
      custom: t('report_kind_custom', 'Overview for a period'),
      manual: t('report_kind_manual', 'Selected bookings'),
      person: t('report_kind_person', 'Overview for one member')
    })[reportType()] || '';
  const overdue = () => props.selection.person?._overdueAmount || 0;
  return (
    <>
      <div class="-mx-12 mb-[34px] h-2 bg-[linear-gradient(90deg,#06b6d4,#10b981)]" />
      <div class="preview-header flex items-center justify-between border-b border-[#e2e8f0] pb-[18px] mb-[26px]">
        <div class="flex items-center gap-3 text-[20px] font-extrabold text-[#1e3a8a]">
          <img class="size-10 object-contain" src="/assets/church-logo.svg" alt="" onError={e => e.currentTarget.remove()} />
          <span>{appName()}</span>
        </div>
        <div class="text-right text-[0.85rem] text-[#718096]">
          <div class="text-[10px] font-bold tracking-[0.08em] text-[#94a3b8] uppercase">{t('report_created_on', 'Created on')}</div>
          <div class="text-[13px] font-bold text-[#334155]">{formatDateFast(getTodayStr())}</div>
        </div>
      </div>
      <div class="preview-title-block mb-6">
        <div class="text-[11px] font-extrabold tracking-[0.1em] text-[#0891b2] uppercase">{kindTitle()}</div>
        <h2 class="mt-1 mb-0.5 text-[30px] font-extrabold tracking-[-0.02em] text-[#0f172a]">{t('report_financial_report', 'Financial Report')}</h2>
        <div class="text-[14px] font-semibold text-[#64748b]">{props.selection.description}</div>
      </div>
      <div class="mb-[30px] grid grid-cols-3 gap-3.5">
        <StatCard label={t('nav_income', 'Income')} kind="income" value={`+${euro(totals().income)}`} note={countOf(filtered().filter(tx => tx.type !== 'exp'))} />
        <StatCard label={t('nav_expenses', 'Expenses')} kind="expense" value={`-${euro(totals().expenses)}`} note={countOf(filtered().filter(tx => tx.type === 'exp'))} />
        <Switch>
          <Match when={reportType() !== 'person'}>
            <StatCard label={t('report_balance', 'Balance')} kind="balance" value={signed(totals().net)} note={countOf(filtered())} />
          </Match>
          <Match when={overdue() > 0}>
            <StatCard label={t('report_outstanding_till_today', 'Outstanding (to date)')} kind="expense" value={euro(overdue())} />
          </Match>
          <Match when={reportType() === 'person'}>
            <StatCard label={t('status_label', 'Status')} kind="income" value={t('report_status_good', 'No arrears')} text />
          </Match>
        </Switch>
      </div>
      <div class="mb-2.5 text-[11px] font-extrabold tracking-[0.1em] text-[#64748b] uppercase">
        {reportTier() === 'compact' ? t('report_by_kind', 'By kind') : t('report_bookings', 'Bookings')}
      </div>
      <Show when={reportTier() !== 'compact'} fallback={<Breakdown filtered={filtered()} />}>
        <table class="preview-table mt-[15px] w-full border-separate border-spacing-0 overflow-hidden rounded-xl border border-[#e2e8f0]">
          <thead>
            <tr class="break-inside-avoid">
              <th class={TH}>{t('report_table_date', 'Date')}</th>
              <th class={TH}>{t('report_table_type', 'Kind')}</th>
              <th class={TH}>{t('report_table_desc', 'Description / Partner')}</th>
              <th class={TH} style={{ 'text-align': 'right' }}>
                {t('report_table_amount', 'Amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={filtered()}>{tx => <BookingRows tx={tx} tier={reportTier()} />}</For>
          </tbody>
          <tfoot>
            <tr class="break-inside-avoid">
              <td class="border-t-[1.5px] border-b border-t-[#e2e8f0] border-b-[#eef2f6] bg-[#f8fafc] px-3.5 py-3 align-top text-[13px] font-extrabold text-[#0f172a]" colspan={3}>
                {t('report_balance', 'Balance')}
              </td>
              <td class={['border-t-[1.5px] border-b border-t-[#e2e8f0] border-b-[#eef2f6] bg-[#f8fafc] px-3.5 py-3 align-top text-[13px] font-extrabold', AMOUNT, amountColor(totals().net < 0)]}>
                {signed(totals().net)}
              </td>
            </tr>
          </tfoot>
        </table>
      </Show>
      <div class="pv-footer mt-7 flex justify-between gap-3 border-t border-[#e7e5e4] pt-3 text-[10.5px] text-[#a8a29e]">
        <span>
          {appName()} · {t('report_financial_report', 'Financial Report')}
        </span>
        <span>{props.selection.description}</span>
      </div>
    </>
  );
}

function Placeholder(props: { icon: JSX.Element; text: string; danger?: boolean }) {
  return (
    <div class={['flex min-h-[400px] flex-col items-center justify-center p-10 text-center', props.danger ? 'text-danger' : 'text-[#a8a29e]']}>
      {props.icon}
      <p class="m-0 font-semibold">{props.text}</p>
    </div>
  );
}

const placeholderIcon = (icon: JSX.Element) => <div class="mb-[15px] text-[0px] text-[#d6d3d1]">{icon}</div>;

/** The dialog's content: mounted while it is open (the page is measured and scaled while it is on screen). */
function ReportContent() {
  let viewport!: HTMLDivElement;
  let canvas!: HTMLDivElement;
  const [scale, setScale] = createSignal(1);
  const [pageHeight, setPageHeight] = createSignal(1120);
  const selection = createMemo(selectReportTransactions);
  const ready = () => reportStatus() === 'ready';
  const count = () => (ready() ? selection().filtered.length : 0);

  // The page keeps its A4 width and is scaled down to the space there is
  onSettled(() => {
    const observer = new ResizeObserver(() => {
      setScale(Math.min(1, (viewport.clientWidth - 40) / PAGE_WIDTH));
      setPageHeight(canvas.offsetHeight || 1120);
    });
    observer.observe(viewport);
    observer.observe(canvas);
    return () => observer.disconnect();
  });

  return (
    <>
      <div class="flex items-center gap-3.5 border-b border-border-light bg-surface px-4 py-3.5 md:px-[22px] md:py-[18px]">
        <span class="inline-flex size-[42px] shrink-0 items-center justify-center rounded-[13px] bg-gradient-primary text-white">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="13" y2="17" />
          </svg>
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="text-[1.15rem] font-extrabold text-text">{t('report_modal_title', 'Create financial report')}</span>
          <span class="hidden text-[0.85rem] text-text-secondary md:block">
            {t('report_modal_subtitle', 'Choose the period and level of detail – the preview shows the PDF.')}
          </span>
        </span>
        <button
          type="button"
          class="flex shrink-0 items-center justify-center bg-transparent px-1 text-[1.8rem] leading-none text-text-secondary transition-colors duration-200 focus:text-danger focus:outline-none focus-visible:rounded focus-visible:outline-2 focus-visible:outline-danger"
          aria-label={t('btn_close', 'Close')}
          onClick={() => closeModal('export-report-modal')}
        >
          &times;
        </button>
      </div>

      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg md:flex-row md:overflow-hidden">
        <ConfigPanel onTypeChange={() => viewport && (viewport.scrollTop = 0)} />
        <div
          ref={viewport}
          class="flex flex-1 flex-col items-center justify-start gap-3 overflow-visible bg-bg px-4 pt-3.5 pb-5 md:overflow-x-hidden md:overflow-y-auto md:px-6 md:pt-[18px] md:pb-7"
        >
          <div class="flex items-center justify-between self-stretch text-[0.72rem] font-extrabold tracking-[0.06em] text-text-secondary uppercase">
            <span>{t('report_preview', 'Preview')}</span>
            <span class="rounded-full border border-border-light bg-surface px-2 py-0.5 tracking-[0.04em]">A4</span>
          </div>
          <div
            class="shrink-0 overflow-hidden transition-[width,height] duration-150 ease-[ease] [color-scheme:light]"
            style={{ width: `${PAGE_WIDTH * scale()}px`, height: `${pageHeight() * scale()}px` }}
          >
            <div
              class="w-[794px] min-w-[794px] origin-top-left rounded-md bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_18px_40px_-16px_rgba(15,23,42,0.35)] transition-transform duration-150 ease-[ease]"
              style={{ transform: `scale(${scale()})` }}
            >
              <div
                id="report-print-preview"
                ref={canvas}
                class="relative box-border min-h-[1120px] bg-white px-12 pb-10 font-sans text-[13px] leading-[1.5] text-[#334155] [color-scheme:light]"
              >
                <Switch>
                  <Match when={reportStatus() === 'loading'}>
                    <Placeholder icon={<Spinner class="mx-auto mb-[15px]" />} text={t('loading', 'Loading data...')} />
                  </Match>
                  <Match when={reportStatus() === 'error'}>
                    <Placeholder icon={placeholderIcon('⚠️')} text={t('alert_error_loading_data', 'Failed to load data. Please reload the page.')} danger />
                  </Match>
                  <Match when={!count()}>
                    <Placeholder
                      icon={placeholderIcon(<Icon name="fileText" size={40} strokeWidth={1.6} />)}
                      text={
                        reportType() === 'manual'
                          ? t('report_pick_bookings', 'Tick the bookings on the left that should go into the report.')
                          : t('report_no_data', 'No data found for the selected period')
                      }
                    />
                  </Match>
                  <Match when={count()}>
                    <ReportPage selection={selection()} />
                  </Match>
                </Switch>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="flex flex-col items-stretch gap-2.5 border-t border-border-light bg-surface px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] md:flex-row md:items-center md:justify-between md:gap-3 md:px-[22px] md:py-3.5">
        <span class="min-w-0 text-center text-[0.82rem] font-bold text-text-secondary md:text-left md:text-[0.88rem]">
          {count() ? `${bookingsCount(count())} · ${t('report_balance', 'Balance')} ${signed(reportTotals(selection().filtered).net)}` : ''}
        </span>
        <div class="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-2.5 md:flex">
          <Button variant="secondary" class="min-h-[46px] !px-3 whitespace-nowrap md:min-h-0 md:!px-5" onClick={() => closeModal('export-report-modal')}>
            {t('btn_cancel', 'Cancel')}
          </Button>
          <Button
            class="min-h-[46px] !px-3 whitespace-nowrap md:min-h-0 md:!px-5"
            disabled={!count()}
            busy={generating()}
            busyText={t('report_generating', 'Generating...')}
            onClick={() => void downloadReportPdf(canvas, appName())}
          >
            <Icon name="download" size={18} />
            <span>{t('report_download_pdf', 'Download PDF')}</span>
          </Button>
        </div>
      </div>
    </>
  );
}

export function ReportDialog() {
  return (
    <Modal
      id="export-report-modal"
      plain
      maxWidth="1240px"
      class="!h-[100dvh] !max-h-[100dvh] !w-screen !rounded-none md:!h-[88vh] md:!max-h-[88vh] md:!w-[90vw] md:!rounded-[24px]"
    >
      <ReportContent />
    </Modal>
  );
}
