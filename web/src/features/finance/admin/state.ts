// State of the finances tab that lives as long as the app: the sub-page, the booked history (fetched page by page
// from /api/transactions), the cash balance (/api/stats), the searches and the member whose card is open. Writers
// apply at once (flush): the router reads the sub-page right after a switch to build the page address.
import { createSignal, flush } from 'solid-js';
import { api } from '../../../app/api';
import { activeTab, syncUrl } from '../../../app/router';
import { canViewFinances } from '../../../app/session';
import { debounce } from '../../../app/util';

export type FinanceSubpage = 'history' | 'members';

/** A booking of the history as the server lists it (payment, donation or expense). */
export interface Transaction {
  id: string;
  type: string;
  amount: number | string;
  date?: string;
  who?: string;
  name?: string;
  description?: string;
  note?: string;
  issuer?: string;
  receipt?: unknown;
  tags?: string | string[];
  personId?: string;
  personUid?: string | null;
  personName?: string;
  paymentId?: string;
  paymentIndex?: number;
  payment?: any;
  [key: string]: any;
}

/** How a booking counts: expenses go out (red), payments and donations come in (green). */
export const txSign = (tx: Transaction) => (tx.type === 'exp' ? '-' : '+');
export const txColor = (tx: Transaction) => (tx.type === 'exp' ? 'text-danger' : 'text-success');

// --- Sub-page (the overview with the history is the default, as before) ---
const [subpage, setSubpageSignal] = createSignal<FinanceSubpage>('history');
export { subpage };
export function setSubpage(page: FinanceSubpage) {
  setSubpageSignal(page);
  flush();
}

// --- The member whose card is open in the fee list (one at a time) ---
const [openPersonId, setOpenPersonIdSignal] = createSignal<string | null>(null);
export { openPersonId };
export function setOpenPersonId(id: string | null) {
  setOpenPersonIdSignal(id);
  flush();
}

// --- The member search: the typed text, and the term the list shows (300 ms later) ---
const [peopleSearch, setPeopleSearchSignal] = createSignal('');
const [peopleTerm, setPeopleTerm] = createSignal('');
export { peopleSearch, peopleTerm };
const applyPeopleSearch = debounce((text: string) => setPeopleTerm(text.toLowerCase()), 300);
export function setPeopleSearch(text: string) {
  setPeopleSearchSignal(text);
  flush();
  applyPeopleSearch(text);
}

/** Loads what the shown sub-page needs: the fee list is drawn from memory (its cards start closed), the overview
 *  fetches the history and the balance. */
export function loadSubpage() {
  if (subpage() === 'members') setOpenPersonId(null);
  else {
    void loadHistory(true);
    void loadStats();
  }
}

export function switchFinanceSubpage(page: FinanceSubpage) {
  setSubpage(page);
  loadSubpage();
  syncUrl();
}

// --- Cash balance ---
const [balance, setBalance] = createSignal<number | null>(null);
export { balance };

export async function loadStats() {
  try {
    const res = await api('/stats');
    if (!res.ok) throw new Error('Stats fetch failed');
    setBalance(Number((await res.json()).totalBalance) || 0);
  } catch (err) {
    console.error('Could not load the statistics:', err);
  }
}

// --- History ---
export const TRANSACTIONS_PER_PAGE = 150;
export type HistoryView = 'skeleton' | 'list' | 'error';

const [transactions, setTransactions] = createSignal<Transaction[] | null>(null);
const [transactionTotal, setTransactionTotal] = createSignal(0);
const [historyView, setHistoryView] = createSignal<HistoryView>('skeleton');
const [historySearch, setHistorySearchSignal] = createSignal('');
export { transactions, transactionTotal, historyView, historySearch };

// The search of the last load (a load always takes what is in the search field)
let loadedQuery = '';
let transactionPage = 1;
// A newer load replaces an older one still on its way (fast typing in the search)
let historySeq = 0;

const searchHistory = debounce((text: string) => {
  if (text.trim() !== loadedQuery) void loadHistory(true);
}, 300);
export function setHistorySearch(text: string) {
  setHistorySearchSignal(text);
  flush();
  searchHistory(text);
}

/**
 * Fetches the history: [reset] starts again at the first page (with placeholders while it loads), otherwise the next
 * page is added below. [quiet] reloads what is shown in the background (a live update): no placeholders, as many
 * bookings as were shown.
 */
export async function loadHistory(reset = true, { quiet = false } = {}) {
  const seq = ++historySeq;
  const query = (loadedQuery = historySearch().trim());
  let page = transactionPage;
  let perPage = TRANSACTIONS_PER_PAGE;
  if (quiet) {
    perPage *= transactionPage;
    page = 1;
  } else if (reset) {
    transactionPage = page = 1;
    setTransactions(null);
    setHistoryView('skeleton');
  }
  try {
    const res = await api(`/transactions?page=${page}&perPage=${perPage}${query ? `&search=${encodeURIComponent(query)}` : ''}`);
    if (!res.ok) throw new Error('Failed to fetch transactions');
    const data = await res.json();
    if (seq !== historySeq) return;
    const items: Transaction[] = Array.isArray(data.items) ? data.items : [];
    setTransactions(reset || quiet ? items : [...(transactions() || []), ...items]);
    setTransactionTotal(Number(data.totalItems) || 0);
    setHistoryView('list');
  } catch (err) {
    if (seq !== historySeq) return;
    console.error('Could not load the transactions:', err);
    setHistoryView('error');
  }
  flush();
}

export function loadMoreHistory() {
  transactionPage += 1;
  void loadHistory(false);
}

/** After bookings changed (here, in a booking dialog or elsewhere): the balance, and the history where it is on
 *  screen. [quiet]: a live update - what is shown stays until the new list is there. */
export function refreshFinanceViews({ quiet = false } = {}) {
  if (!canViewFinances()) return;
  void loadStats();
  if (activeTab() === 'finances' && subpage() === 'history') void loadHistory(true, { quiet });
}
