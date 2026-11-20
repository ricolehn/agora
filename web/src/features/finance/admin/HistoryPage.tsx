// The finances overview: the open requests, the cash balance, and the history of all bookings (newest first, grouped
// by day, 150 at a time, searchable). A booking opens with its details.
import { For, Match, Show, Switch } from 'solid-js';
import { people, users } from '../../../app/data';
import { euro, formatDateFast, t } from '../../../app/i18n';
import { fullName } from '../../../app/util';
import { Avatar } from '../../../ui/Avatar';
import { Button } from '../../../ui/Button';
import { SearchInput, Skeleton } from '../../../ui/feedback';
import { Icon, type IconName } from '../../../ui/Icon';
import { RequestsCard } from './RequestsCard';
import { pendingRequests } from './requests';
import { openExportReport } from './report';
import {
  balance, historySearch, historyView, loadMoreHistory, setHistorySearch, transactionTotal, transactions, txColor, txSign,
  type Transaction
} from './state';
import { showTransactionDetails } from './TransactionDetailsDialog';

const TX_ICONS: Record<string, IconName> = { pay: 'person', don: 'heart', exp: 'dollar' };
const TX_TINTS: Record<string, string> = {
  pay: 'bg-[rgba(16,185,129,0.15)] text-success',
  don: 'bg-[rgba(139,92,246,0.15)] text-[#8b5cf6]',
  exp: 'bg-[rgba(239,68,68,0.15)] text-danger'
};
const txDateLabel = (tx: Transaction) => (tx.date ? formatDateFast(tx.date) : t('no_date', 'No date'));

// Expenses only store the issuer's name: the account behind it, for the profile picture
function uidForName(name: unknown): string | null {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  const person = people().find(p => p.uid && String(p.name || '').trim().toLowerCase() === wanted);
  if (person) return person.uid!;
  const account = users().find(u => String(fullName(u) || '').trim().toLowerCase() === wanted);
  return account ? account.uid || account.id : null;
}
const txAvatarUid = (tx: Transaction) => (tx.type === 'pay' ? tx.personUid : tx.type === 'exp' ? uidForName(tx.who) : null) || null;

/** The round symbol of a booking: the person's picture (initials without one), else the symbol of its kind. */
function TransactionIcon(props: { tx: Transaction }) {
  const kind = () => (TX_ICONS[props.tx.type] ? props.tx.type : 'exp');
  return (
    <Show
      when={txAvatarUid(props.tx)}
      fallback={
        <div class={['mr-4 flex size-10 shrink-0 items-center justify-center rounded-full', TX_TINTS[kind()]]}>
          <Icon name={TX_ICONS[kind()]} size={20} />
        </div>
      }
    >
      {uid => (
        <div class="relative mr-4 size-10 shrink-0">
          <Avatar uid={uid()} name={props.tx.who} size={40} initialsClass="text-[0.85rem]" />
          {/* Expenses keep a small red badge on the picture, so they stay recognisable at a glance */}
          <Show when={props.tx.type === 'exp'}>
            <span class="absolute -right-[3px] -bottom-[3px] flex size-[18px] items-center justify-center rounded-full border-2 border-surface bg-danger text-white">
              <Icon name="dollar" size={10} strokeWidth={2.8} />
            </span>
          </Show>
        </div>
      )}
    </Show>
  );
}

const TRANS_ITEM =
  'relative z-[2] mb-3 flex items-center justify-between rounded-2xl border border-hairline bg-surface p-4 text-[0.95rem] shadow-card dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),var(--shadow)]';

function TransactionRow(props: { tx: Transaction }) {
  const open = () => showTransactionDetails(props.tx.id, props.tx.type);
  return (
    <div
      class={[
        TRANS_ITEM,
        'cursor-pointer transition-[transform,opacity,box-shadow,background-color,border-color,color] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]',
        // A quiet lift on devices that hover, an honest press everywhere
        '[@media(hover:hover)]:transition-[transform,box-shadow,border-color,background-color] [@media(hover:hover)]:duration-250 [@media(hover:hover)]:ease-app',
        'hover:-translate-y-px hover:shadow-card-md active:scale-[0.985] active:duration-100'
      ]}
      role="button"
      tabindex="0"
      onClick={open}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') open();
      }}
    >
      <div class="flex min-w-0 flex-1 items-center">
        <TransactionIcon tx={props.tx} />
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate font-semibold">{props.tx.who}</span>
          <Show when={props.tx.description?.trim() || props.tx.receipt}>
            <div class="mt-1 flex min-w-0 items-center text-[0.8rem] text-text-secondary">
              <Show when={props.tx.description?.trim()}>
                <span class="min-w-0 truncate">{props.tx.description}</span>
              </Show>
              <Show when={props.tx.receipt}>
                <span class="ml-1.5 inline-flex shrink-0 items-center align-[-2px] text-primary opacity-85" title={t('report_receipt_attached', 'Receipt attached')}>
                  <Icon name="paperclip" size={14} strokeWidth={2.2} />
                </span>
              </Show>
            </div>
          </Show>
        </div>
      </div>
      <div class="ml-3 flex shrink-0 items-center">
        <div class={['text-[1.1rem] font-bold tracking-[-0.01em]', txColor(props.tx)]}>
          {txSign(props.tx)}
          {euro(props.tx.amount)}
        </div>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <For each={Array.from({ length: 15 })}>
      {() => (
        <div class={[TRANS_ITEM, 'pointer-events-none']}>
          <div class="flex flex-1 items-center">
            <Skeleton class="mr-4 size-10 shrink-0 !rounded-full" />
            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton class="h-4 w-[140px]" />
              <Skeleton class="mt-1 h-3 w-[100px]" />
            </div>
          </div>
          <Skeleton class="h-[18px] w-[70px]" />
        </div>
      )}
    </For>
  );
}

function TransactionList() {
  const list = () => transactions() || [];
  return (
    <Switch>
      <Match when={historyView() === 'skeleton'}>
        <SkeletonRows />
      </Match>
      <Match when={historyView() === 'error'}>
        <div class="px-5 py-[30px] text-center text-danger">{t('error_loading_transactions', 'Error loading transactions.')}</div>
      </Match>
      <Match when={!list().length}>
        <div class="px-5 py-[30px] text-center text-text-secondary">{t('no_transactions', 'No transactions found.')}</div>
      </Match>
      <Match when={list().length}>
        <For each={list()}>
          {(tx, i) => (
            <>
              <Show when={i() === 0 || txDateLabel(list()[i() - 1]) !== txDateLabel(tx)}>
                <div class={['mb-2 ml-2.5 text-[0.9rem] font-bold tracking-[0.5px] text-text-secondary uppercase', i() === 0 ? 'mt-0' : 'mt-5']}>
                  {txDateLabel(tx)}
                </div>
              </Show>
              <TransactionRow tx={tx} />
            </>
          )}
        </For>
        <Show when={list().length < transactionTotal()}>
          <div class="p-5 text-center">
            <div class="mb-3 text-[0.85rem] text-text-secondary">
              {t('showing_transactions_count', 'Showing {count} of {total} transactions.', { count: list().length, total: transactionTotal() })}
            </div>
            <Button variant="secondary" onClick={loadMoreHistory}>
              {t('load_more_btn', 'Load more...')}
            </Button>
          </div>
        </Show>
      </Match>
    </Switch>
  );
}

/** The cash balance on the lagoon gradient, with two soft circles. */
function BalanceHero() {
  return (
    <div
      class={[
        'relative mb-[25px] cursor-default overflow-hidden rounded-[28px] bg-gradient-primary px-6 py-5 text-center text-white transition-transform duration-200 active:scale-[0.98]',
        'shadow-[0_1px_2px_rgba(48,38,26,0.08),0_12px_28px_-16px_rgba(48,38,26,0.35)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),0_14px_30px_-16px_rgba(0,0,0,0.75)]',
        "before:absolute before:-top-[50px] before:-left-[50px] before:size-[150px] before:rounded-full before:bg-white/10 before:content-['']",
        "after:absolute after:-right-5 after:-bottom-5 after:size-[100px] after:rounded-full after:bg-white/15 after:content-['']"
      ]}
    >
      <span class="mb-3 inline-block rounded-[20px] bg-black/15 px-3.5 py-1.5 text-[0.75rem] font-bold tracking-[0.08em] uppercase backdrop-blur-[6px]">
        {t('total_balance', 'Total Balance')}
      </span>
      <div class="mb-1.5 text-[2.8rem] leading-[1.1] font-extrabold tracking-[-0.03em] text-white tabular-nums">{euro(balance() ?? 0)}</div>
    </div>
  );
}

export function HistoryPage() {
  return (
    <div>
      <Show when={pendingRequests().length}>
        <div id="admin-requests-inline" class="mb-5">
          <RequestsCard context="fin" items={pendingRequests()} total={pendingRequests().length} />
        </div>
      </Show>
      <BalanceHero />
      <div class="mb-5 flex items-center justify-between">
        <h2 class="text-[1.2rem] font-extrabold">{t('nav_history', 'History')}</h2>
        <Button id="btn-open-export-report" variant="secondary" size="small" class="!gap-1.5" onClick={() => void openExportReport()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          <span>{t('btn_create_report', 'Create Report')}</span>
        </Button>
      </div>
      <SearchInput
        id="history-search"
        class="mb-[15px]"
        value={historySearch()}
        onInput={setHistorySearch}
        placeholder={t('search_placeholder', 'Search...')}
      />
      <div id="history-page-list">
        <TransactionList />
      </div>
    </div>
  );
}

