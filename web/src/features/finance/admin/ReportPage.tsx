// The report's A4 page as it is previewed and becomes the PDF: the bookings, their breakdown and the totals, in print
// colours (the app's dark theme does not reach it).
import { For, Match, Show, Switch } from 'solid-js';
import { appName } from '../../../app/config';
import { sumAmounts } from '../../../app/data';
import { euro, formatDateFast, t } from '../../../app/i18n';
import { getTodayStr } from '../../../app/util';
import { Icon } from '../../../ui/Icon';
import { REPORT_TYPE_LABELS, bookingsCount, reportTier, reportTotals, reportType, selectReportTransactions, type ReportTier } from './report';
import { txSign, type Transaction } from './state';

// --- The A4 page ---
const TYPE_PILLS: Record<string, string> = {
  pay: 'border-[#a7f3d0] bg-[#ecfdf5] text-[#059669]',
  don: 'border-[#ddd6fe] bg-[#f5f3ff] text-[#7c3aed]',
  exp: 'border-[#fecaca] bg-[#fef2f2] text-[#dc2626]'
};

const STAT_BARS: Record<string, string> = {
  income: 'before:bg-[#10b981]',
  expense: 'before:bg-[#ef4444]',
  balance: 'before:bg-[#0891b2]'
};

const STAT_VALUES: Record<string, string> = { income: 'text-[#10b981]', expense: 'text-[#ef4444]', balance: 'text-[#0f172a]' };

const TD = 'border-b border-[#eef2f6] px-3.5 py-2.5 align-top text-[12.5px] text-[#334155]';

const TH = 'border-b border-[#e7e5e4] bg-[#f5f5f4] px-3.5 py-2.5 text-left text-[10px] font-extrabold tracking-[0.08em] text-[#78716c] uppercase';

// Even rows a breath of blue; the last row of the body has no line (the table's frame closes it)
const TR = 'break-inside-avoid even:bg-[#fbfdff] [&:last-child>td]:border-b-0';

const AMOUNT = 'text-right font-bold whitespace-nowrap tabular-nums';

// The amounts always in their colour (the cells' own text colour gives way)
const amountColor = (expense: boolean) => (expense ? '!text-[#dc2626]' : '!text-[#059669]');

export const signed = (value: number) => `${value >= 0 ? '+' : ''}${euro(value)}`;

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
                  {tag => <span class="mr-[5px] inline-block rounded px-1.5 py-0.5 text-75 bg-[#e0f2fe] text-[#0369a1]">{tag}</span>}
                </For>
              </div>
            </Show>
            <Show when={props.tx.receipt}>
              <div class="inline-flex items-center gap-1 text-75 font-semibold text-[#0d9488]">
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

export function ReportPage(props: { selection: ReturnType<typeof selectReportTransactions> }) {
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
        <div class="text-right text-85 text-[#718096]">
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
