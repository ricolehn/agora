// The financial report (export-report-modal): all bookings are loaded when it opens; what goes into the report (a year,
// a period, one member, hand-picked bookings) and how detailed it is decide the A4 preview, which becomes the PDF.
import { createSignal } from 'solid-js';
import { flushNow } from '../../../app/flush';
import { apiJson } from '../../../app/api';
import { findPerson, people, sumAmounts, type Person } from '../../../app/data';
import { formatDateFast, t } from '../../../app/i18n';
import { openModal } from '../../../app/modals';
import { showToast } from '../../../app/toast';
import { getTodayStr } from '../../../app/util';
import type { Transaction } from './state';

export type ReportType = 'annual' | 'custom' | 'person' | 'manual';
export type ReportTier = 'compact' | 'standard' | 'detailed';

export const REPORT_TIER_HINTS: Record<ReportTier, [string, string]> = {
  compact: ['report_tier_compact_hint', 'Totals and a summary by kind only'],
  standard: ['report_tier_standard_hint', 'Totals and every booking'],
  detailed: ['report_tier_detailed_hint', 'Also notes, tags and receipts']
};
export const REPORT_TYPE_LABELS: Record<string, [string, string]> = {
  pay: ['report_type_membership', 'Membership fee'],
  don: ['report_type_donation', 'Donation'],
  exp: ['report_type_expense', 'Expense']
};

const [reportStatus, setReportStatus] = createSignal<'loading' | 'ready' | 'error'>('loading');
const [reportTransactions, setReportTransactions] = createSignal<Transaction[]>([]);
const [reportType, setReportTypeSignal] = createSignal<ReportType>('annual');
const [reportTier, setReportTierSignal] = createSignal<ReportTier>('standard');
const [reportYears, setReportYears] = createSignal<number[]>([]);
const [reportYear, setReportYear] = createSignal('');
const [customFrom, setCustomFrom] = createSignal('');
const [customTo, setCustomTo] = createSignal('');
const [reportPersonId, setReportPersonId] = createSignal('');
const [personFrom, setPersonFrom] = createSignal('');
const [personTo, setPersonTo] = createSignal('');
const [selectedKeys, setSelectedKeys] = createSignal<ReadonlySet<string>>(new Set());
const [generating, setGenerating] = createSignal(false);
export {
  reportStatus, reportTransactions, reportType, reportTier, reportYears, reportYear, setReportYear, customFrom, setCustomFrom, customTo,
  setCustomTo, reportPersonId, setReportPersonId, personFrom, setPersonFrom, personTo, setPersonTo, selectedKeys, generating
};

export const reportKey = (tx: Transaction, idx: number) => String(tx.id || tx.paymentId || `tx_${idx}`);
export const reportPeople = () => [...people()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
export const bookingsCount = (count: number) =>
  count === 1 ? t('report_bookings_one', '1 booking') : t('report_bookings_count', '{count} bookings', { count });

export function setReportType(type: ReportType) {
  setReportTypeSignal(type);
  flushNow();
}
export function setReportTier(tier: ReportTier) {
  setReportTierSignal(tier);
  flushNow();
}
export function toggleReportTransaction(key: string) {
  const next = new Set(selectedKeys());
  if (!next.delete(key)) next.add(key);
  setSelectedKeys(next);
  flushNow();
}

/** Loads every booking (page by page) and opens the report as an annual overview of the latest year. */
export async function openExportReport() {
  setReportStatus('loading');
  flushNow();
  openModal('export-report-modal');
  try {
    let all: Transaction[] = [];
    for (let page = 1, totalPages = 1; page <= totalPages; page++) {
      const data = await apiJson(`/transactions?page=${page}&perPage=500`);
      all = all.concat(data.items || []);
      totalPages = data.totalPages || 1;
    }
    const years = new Set(all.map(tx => parseInt((tx.date || '').slice(0, 4), 10)).filter(y => !Number.isNaN(y)));
    if (years.size === 0) years.add(new Date().getFullYear());
    const sortedYears = [...years].sort((a, b) => b - a);
    const yearStart = `${new Date().getFullYear()}-01-01`;
    setReportTransactions(all);
    setReportYears(sortedYears);
    setReportYear(String(sortedYears[0]));
    setCustomFrom(yearStart);
    setPersonFrom(yearStart);
    setCustomTo(getTodayStr());
    setPersonTo(getTodayStr());
    setReportPersonId(String(reportPeople()[0]?.id ?? ''));
    setSelectedKeys(new Set<string>());
    setReportTypeSignal('annual');
    setReportStatus('ready');
  } catch (err) {
    console.error('Could not load the report transactions:', err);
    setReportStatus('error');
  }
  flushNow();
}

const inDateRange = (tx: Transaction, from: string, to: string) => {
  const d = (tx.date || '').slice(0, 10);
  return !(from && d < from) && !(to && d > to);
};

export interface ReportSelection {
  filtered: Transaction[];
  description: string;
  person?: Person;
}

/** The bookings of the chosen report (oldest first) and how its period reads. */
export function selectReportTransactions(): ReportSelection {
  const all = reportTransactions();
  const type = reportType();
  let selection: ReportSelection;
  if (type === 'annual') {
    const year = reportYear();
    selection = { filtered: all.filter(tx => (tx.date || '').slice(0, 4) === year), description: `${t('report_year_filter', 'Year:')} ${year}` };
  } else if (type === 'custom') {
    const from = customFrom();
    const to = customTo();
    const [fromText, toText] = [from, to].map(d => (d ? formatDateFast(d) : ''));
    selection = {
      filtered: all.filter(tx => inDateRange(tx, from, to)),
      description:
        fromText && toText
          ? `${fromText} - ${toText}`
          : fromText
            ? t('report_from_date', 'From {date}', { date: fromText })
            : toText
              ? t('report_until_date', 'Until {date}', { date: toText })
              : t('report_all_transactions', 'All transactions')
    };
  } else if (type === 'manual') {
    const keys = selectedKeys();
    selection = { filtered: all.filter((tx, idx) => keys.has(reportKey(tx, idx))), description: t('report_manual_selection', 'Manual Selection') };
  } else {
    const personId = reportPersonId();
    const person = findPerson(personId);
    const name = person ? String(person.name || '') : '';
    const from = personFrom();
    const to = personTo();
    const filtered = all.filter(tx => {
      const matchesId = String(tx.personId) === String(personId) || (tx.personUid && person && tx.personUid === person.uid);
      const matchesName = tx.who && name && tx.who.trim().toLowerCase() === name.trim().toLowerCase();
      return (matchesId || matchesName) && inDateRange(tx, from, to);
    });
    selection = { filtered, person, description: `${name}${from || to ? `: ${from ? formatDateFast(from) : ''} - ${to ? formatDateFast(to) : ''}` : ''}` };
  }
  selection.filtered.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return selection;
}

/** The totals of a selection: income (payments, donations), expenses and what is left. */
export function reportTotals(filtered: Transaction[]) {
  const income = sumAmounts(filtered.filter(tx => tx.type !== 'exp'));
  const expenses = sumAmounts(filtered.filter(tx => tx.type === 'exp'));
  return { income, expenses, net: income - expenses };
}

/** The preview as a PDF: an unscaled A4-wide copy off-screen (a scaled one gave a blank first page). */
export async function downloadReportPdf(element: HTMLElement | undefined, appName: string) {
  if (!element) return;
  setGenerating(true);
  flushNow();
  let html2pdf: any = null;
  try {
    ({ default: html2pdf } = await import('html2pdf.js'));
  } catch (err) {
    console.error(err);
  }
  if (typeof html2pdf !== 'function') {
    setGenerating(false);
    return showToast(t('report_pdf_lib_error', 'PDF library failed to load.'), 'error');
  }
  const printContainer = document.createElement('div');
  printContainer.style.cssText = 'position: absolute; left: 0; top: 0; width: 794px; pointer-events: none; z-index: -9999; background: #ffffff;';
  const clone = element.cloneNode(true) as HTMLElement;
  clone.style.cssText += 'transform: none; min-height: auto; width: 794px; margin: 0; box-sizing: border-box; background: #ffffff;';
  // The canvas draws digits proportionally: tabular ones on the page left gaps behind narrow digits ("01 /01")
  for (const el of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) el.style.fontVariantNumeric = 'normal';
  printContainer.appendChild(clone);
  document.body.appendChild(printContainer);
  const done = () => {
    setGenerating(false);
    printContainer.remove();
  };
  html2pdf()
    .set({
      margin: 0,
      filename: `${appName.replace(/[^a-zA-Z0-9]/g, '_')}_${t('report_file_name', 'Financial_Report')}_${getTodayStr()}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, logging: false, scrollY: 0, scrollX: 0 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: ['.preview-stat-card', '.preview-header', '.preview-title-block', '.pv-footer', 'tr'] }
    })
    .from(clone)
    .save()
    .then(done)
    .catch((err: unknown) => {
      console.error('PDF generation failed:', err);
      done();
      showToast(t('report_pdf_error', 'Failed to generate PDF.'), 'error');
    });
}
