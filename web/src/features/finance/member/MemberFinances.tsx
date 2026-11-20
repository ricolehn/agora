// The finances tab of members (renderUserView): one clear state of the own fee account, the three things a member
// can submit, the own requests, then the history.
import type { JSX } from '@solidjs/web';
import { For, Match, Show, Switch, createMemo, createSignal } from 'solid-js';
import { dataLoaded, findLinkedPerson, isOwnRequest, people, requests, settings, type FinanceRequest, type Person } from '../../../app/data';
import { euro, formatDateFast, getStatusLabels, monthYearFormatter, t, tHtml, translateStatusText, type MemberStatus } from '../../../app/i18n';
import { currentUser } from '../../../app/session';
import { getTodayStr } from '../../../app/util';
import { Card } from '../../../ui/Card';
import { Icon } from '../../../ui/Icon';
import { openRequestDetail } from '../admin/api';
import { feeResetIsNews } from '../../../lib/finance.js';
import { openUserRequestModal } from './api';
import { BoldParam, REQUEST_COLORS, REQUEST_TYPES, rejectionReasonOf, requestAmount, requestTypeLabel } from './shared';
import { Timeline } from './Timeline';

// --- The state of a fee account (also the start page's payment line) ---
export type StatusMeta = { text?: string; isOverdue?: boolean; isSoonDue?: boolean; isActiveStandingOrder?: boolean };
export const statusMetaOf = (p: Person): StatusMeta => p._statusMeta || { text: t('status_unknown', 'Unknown'), isOverdue: false, isSoonDue: false };
export const paidUntilText = (p: Person) => (p._paidUntil ? monthYearFormatter.format(new Date(p._paidUntil)) : t('never_paid', 'Never'));
export const standingOrderCovers = (meta: StatusMeta) => !!meta.isActiveStandingOrder && !meta.isOverdue;
/** The own record of the signed-in member (none without finance records). */
export const ownPerson = () => (people().length > 0 ? findLinkedPerson(currentUser()?.uid) || null : null);

const STATE_LOOK = {
  overdue: { accent: 'var(--danger)', rgb: '239,68,68' },
  soon: { accent: 'var(--warning)', rgb: '245,158,11' },
  ok: { accent: 'var(--success)', rgb: '16,185,129' }
};

// The chip is a notice: it shows from the day on for about two months (lib/finance.js), the history keeps the day
function FeeResetChip(props: { person: Person }) {
  return (
    <Show when={props.person._feeReset && feeResetIsNews(props.person._feeReset, getTodayStr())}>
      <span class="col-span-full flex min-w-0 items-center justify-center gap-1.5 truncate rounded-[14px] border border-hairline bg-surface-alt px-2.5 py-[9px] text-[0.86rem] font-medium text-text-secondary [&_strong]:font-bold [&_strong]:text-text">
        <Icon name="rotate" size={13} strokeWidth={2.4} class="shrink-0 text-warning" />
        <span>
          <BoldParam text={t('fee_reset_chip', 'Fresh start on {date}')} name="date" value={formatDateFast(props.person._feeReset)} />
        </span>
      </span>
    </Show>
  );
}

/** One glance: a big symbol, the state in plain words, then fee and status as two chips. */
function FinanceHero(props: { person: Person }) {
  const meta = () => statusMetaOf(props.person);
  const state = () => (meta().isOverdue ? 'overdue' : meta().isSoonDue ? 'soon' : 'ok');
  const currentStatus = () => props.person._currentStatus || props.person.status;
  const requestStatus = () => t('user_req_status_tooltip', 'Request status change');
  const chip = 'flex min-w-0 items-center justify-center gap-1 truncate rounded-[14px] border border-hairline bg-surface-alt px-2.5 py-[9px] text-[0.86rem]';
  return (
    <div
      class={[
        'rounded-[26px] border border-[rgba(var(--hero-rgb),0.28)] px-5 pt-5 pb-[18px] shadow-card',
        'bg-[radial-gradient(120%_140%_at_100%_0%,rgba(var(--hero-rgb),0.16)_0%,transparent_60%),var(--surface)]',
        'dark:border-[rgba(var(--hero-rgb),0.18)] dark:bg-[radial-gradient(120%_140%_at_100%_0%,rgba(var(--hero-rgb),0.09)_0%,transparent_60%),var(--surface)]'
      ]}
      style={{ '--hero-accent': STATE_LOOK[state()].accent, '--hero-rgb': STATE_LOOK[state()].rgb }}
    >
      <div class="mb-4 flex items-center gap-3.5 text-left">
        <span
          class="inline-flex size-[52px] shrink-0 items-center justify-center rounded-full bg-[var(--hero-accent)] text-white shadow-[0_6px_16px_-6px_rgba(var(--hero-rgb),0.7)] dark:shadow-none"
          aria-hidden="true"
        >
          <Switch fallback={<Icon name="check" size={28} strokeWidth={2.8} />}>
            <Match when={state() === 'overdue'}>
              <Icon name="alert" size={26} strokeWidth={2.4} />
            </Match>
            <Match when={state() === 'soon'}>
              <Icon name="clock" size={26} strokeWidth={2.4} />
            </Match>
          </Switch>
        </span>
        <div class="w-full">
          <div class="mb-0.5 text-[1.45rem] leading-[1.2] font-[750] tracking-[-0.025em] text-[var(--hero-accent)] dark:brightness-[0.92] dark:saturate-[0.75]">
            {translateStatusText(meta().text)}
          </div>
          <div class="text-[0.92rem] font-medium text-text-secondary [&_strong]:font-bold [&_strong]:text-text">
            <Show when={!standingOrderCovers(meta())} fallback={t('user_standing_order_active', 'Standing order active')}>
              {t('user_paid_until', 'Paid until')} <strong>{paidUntilText(props.person)}</strong>
            </Show>
          </div>
        </div>
      </div>
      <Show when={meta().isOverdue}>
        <div class="mb-3.5 rounded-2xl border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.1)] px-4 py-3 text-left">
          <div class="mb-1 text-[0.82rem] font-semibold text-danger">{t('user_open_amount', 'Outstanding amount')}</div>
          <div class="text-[1.6rem] font-extrabold text-danger">{euro(props.person._overdueAmount || 0)}</div>
        </div>
      </Show>
      <div class="grid grid-cols-2 gap-2 md:max-w-[420px]">
        <span class={[chip, 'font-medium text-text-secondary [&_strong]:font-bold [&_strong]:text-text']}>
          <span>
            <BoldParam
              text={t('user_fee_per_month', '{amount} a month')}
              name="amount"
              value={euro(props.person._monthlyFee ?? settings()[currentStatus()] ?? 0)}
            />
          </span>
        </span>
        <button
          type="button"
          class={[chip, 'cursor-pointer font-semibold text-text transition-colors duration-150 ease-app hover:bg-border-light [&_svg]:opacity-55']}
          title={requestStatus()}
          aria-label={requestStatus()}
          onClick={() => openUserRequestModal('status')}
        >
          {getStatusLabels(false)[currentStatus() as MemberStatus] || currentStatus()}
          <Icon name="chevronRight" size={14} strokeWidth={2.5} />
        </button>
        <FeeResetChip person={props.person} />
      </div>
    </div>
  );
}

/** An account without a fee (pays: false). */
function NonPayingCard() {
  return (
    <div class="mb-5 rounded-[20px] border-2 border-border bg-[rgba(16,185,129,0.05)] px-5 py-[25px] text-center shadow-card">
      <div class="mb-2 text-[2rem]">👤</div>
      <h2 class="mb-[5px] text-[1.25rem] font-extrabold text-text">{t('user_account_non_paying_title', 'User Account')}</h2>
      <div class="text-[0.95rem] text-text-secondary">{t('user_account_non_paying_desc', 'Active user account (No contribution required)')}</div>
    </div>
  );
}

function NoMemberRecord() {
  return (
    <div
      class="rounded-2xl border border-border bg-surface p-5 text-center text-text-secondary"
      // eslint-disable-next-line solid/no-innerhtml -- the app's own translation, its only markup is a <br>
      innerHTML={tHtml('user_no_member_found', 'No member record found.<br>Please contact an administrator.')}
    />
  );
}

// --- What a member can submit: one tile per kind ---
function TileIcon(props: { children: JSX.Element }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {props.children}
    </svg>
  );
}

const ACTIONS: Array<{ kind: string; color: string; title: [string, string]; icon: () => JSX.Element }> = [
  { kind: 'payment', color: '#10b981', title: ['req_action_payment_title', 'Report a payment'], icon: () => <Icon name="coin" size={20} /> },
  {
    kind: 'expense',
    color: '#ef4444',
    title: ['req_action_expense_title', 'Get refunded'],
    icon: () => (
      <TileIcon>
        <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
        <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
        <path d="M12 17.5v-11" />
      </TileIcon>
    )
  },
  {
    kind: 'status',
    color: '#6366f1',
    title: ['req_action_status_title', 'Change status'],
    icon: () => (
      <TileIcon>
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
        <path d="M12 7v5l4 2" />
      </TileIcon>
    )
  }
];

function RequestActions(props: { class?: string }) {
  return (
    <section class={['mt-[22px] mb-6', props.class]} aria-labelledby="req-actions-title">
      <h2 id="req-actions-title" class="mb-2.5 ml-0.5 text-[1.05rem] font-bold tracking-[-0.015em] text-text">
        {t('req_actions_title', 'What would you like to submit?')}
      </h2>
      <div class="grid grid-cols-3 gap-2.5">
        <For each={ACTIONS}>
          {action => (
            <button
              type="button"
              class={[
                'flex min-h-[108px] w-full min-w-0 cursor-pointer flex-col items-center justify-start gap-[9px] rounded-[22px] px-1.5 pt-3.5 pb-3 text-center text-inherit shadow-card',
                'border border-[color-mix(in_srgb,var(--req-color)_16%,var(--border-light))] bg-[color-mix(in_srgb,var(--req-color)_5%,var(--surface))]',
                'transition-[transform,border-color,box-shadow] duration-150 ease-[ease] active:scale-[0.96]',
                'hover:border-[color-mix(in_srgb,var(--req-color)_28%,var(--border-light))] hover:bg-[color-mix(in_srgb,var(--req-color)_9%,var(--surface))] hover:shadow-card-md',
                'dark:border-[color-mix(in_srgb,var(--req-color)_20%,var(--border-light))] dark:bg-[color-mix(in_srgb,var(--req-color)_7%,var(--surface))]',
                'md:min-h-0 md:flex-row md:gap-3 md:px-3.5 md:py-3 md:text-left'
              ]}
              style={{ '--req-color': action.color }}
              onClick={() => openUserRequestModal(action.kind)}
            >
              <span class="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--req-color)_14%,var(--surface))] text-[var(--req-color)] dark:bg-[color-mix(in_srgb,var(--req-color)_16%,var(--surface))] dark:[&_svg]:opacity-85">
                {action.icon()}
              </span>
              <span class="flex min-w-0 flex-1 flex-col items-center gap-0.5 md:items-start">
                <span class="text-[0.8rem] leading-[1.25] font-[650] tracking-[-0.01em] text-text md:text-[0.9rem]">{t(...action.title)}</span>
              </span>
            </button>
          )}
        </For>
      </div>
    </section>
  );
}

// --- The own requests: calm rows like the treasurers' list; a tap opens the request (state, reason) ---
const REQUEST_STATES: Record<string, [string, string, string]> = {
  pending: ['#f59e0b', 'req_status_pending', 'Pending'],
  approved: ['#10b981', 'req_status_approved', 'Approved'],
  rejected: ['#ef4444', 'req_status_rejected', 'Rejected']
};
const stateOf = (req: FinanceRequest) => REQUEST_STATES[req.status || ''] || REQUEST_STATES.pending;
const MY_REQUESTS_SHOWN = 3;
const badgeCount = (count: number) => (count > 99 ? '99+' : String(count));

function MyRequestRow(props: { req: FinanceRequest }) {
  const data = () => props.req.data || {};
  // A second line only where it helps: why it was rejected, or what an expense was for
  const text = () =>
    props.req.status === 'rejected'
      ? t('user_request_reason', 'Reason: {reason}', { reason: rejectionReasonOf(props.req) })
      : (props.req.type === 'expense' ? data().description : '') || '';
  return (
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-3 border-t border-border-light px-4 py-[11px] text-left transition-colors duration-150 ease-[ease] hover:bg-surface-alt"
      style={{ '--req-color': REQUEST_COLORS[props.req.type || ''] || 'var(--primary)', '--state-color': stateOf(props.req)[0] }}
      onClick={() => openRequestDetail(props.req.id)}
    >
      <span class="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--req-color)_13%,transparent)] text-[var(--req-color)]">
        <Icon name={REQUEST_TYPES[props.req.type || '']?.icon || 'file'} size={18} strokeWidth={2.2} />
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-px">
        <span class="flex min-w-0 items-center gap-2">
          <span class="min-w-0 flex-1 truncate font-extrabold text-text">{requestTypeLabel(props.req)}</span>
          <span class="shrink-0 text-[0.95rem] font-extrabold text-text">{requestAmount(props.req)}</span>
        </span>
        <span class="inline-flex items-center gap-1.5 text-[0.72rem] font-extrabold text-[var(--state-color)]">
          <span class="size-[7px] shrink-0 rounded-full bg-[var(--state-color)]" />
          {t(stateOf(props.req)[1], stateOf(props.req)[2])}
          {props.req.timestamp ? ` · ${formatDateFast(props.req.timestamp)}` : ''}
          <Show when={data().receipt}>
            {' · '}
            <Icon name="paperclip" size={11} />
          </Show>
        </span>
        <Show when={text()}>
          <span class="flex min-w-0 items-center gap-2">
            <span class={['min-w-0 flex-1 truncate text-[0.9rem]', props.req.status === 'rejected' ? 'text-danger' : 'text-text']}>{text()}</span>
          </span>
        </Show>
      </span>
      <Icon name="chevronRight" size={16} strokeWidth={2.5} class="shrink-0 text-text-secondary opacity-60" />
    </button>
  );
}

function MyRequests(props: { class?: string }) {
  const [showAll, setShowAll] = createSignal(false);
  const mine = createMemo(() => (currentUser() ? requests().filter(isOwnRequest).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)) : []));
  const shown = () => (showAll() ? mine() : mine().slice(0, MY_REQUESTS_SHOWN));
  return (
    <div id="user-requests-list" class={['mb-[22px]', props.class]}>
      <Show
        when={mine().length > 0}
        fallback={
          <div class="flex flex-col items-center gap-1.5 rounded-[18px] border border-dashed border-border bg-surface px-[18px] py-[22px] text-center text-text-secondary">
            <Icon name="fileText" size={22} />
            <span class="font-extrabold text-text">{t('user_no_requests_title', 'No requests yet')}</span>
            <span class="max-w-[360px] text-[0.88rem]">{t('user_no_requests_hint', 'Above you can report a payment, submit an expense or change your status.')}</span>
          </div>
        }
      >
        <div class="overflow-hidden rounded-[22px] border border-hairline bg-surface shadow-card">
          <div class="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5">
            <span class="inline-flex size-[34px] shrink-0 items-center justify-center rounded-[11px] bg-[rgba(245,158,11,0.14)] text-[#d97706] dark:text-[#fbbf24]">
              <Icon name="fileText" size={18} />
            </span>
            <span class="font-extrabold text-text">{t('user_requests_title', 'My Requests')}</span>
            <span class="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-text-secondary px-[7px] text-[0.75rem] leading-none font-extrabold text-white">
              {badgeCount(mine().length)}
            </span>
          </div>
          <div class="flex flex-col">
            <For each={shown()}>{req => <MyRequestRow req={req} />}</For>
          </div>
          <Show when={mine().length > MY_REQUESTS_SHOWN}>
            <button
              type="button"
              class="block w-full cursor-pointer border-t border-border-light px-4 pt-2.5 pb-3 text-left text-text-secondary hover:text-primary"
              onClick={() => setShowAll(on => !on)}
            >
              {showAll() ? t('user_requests_show_less', 'Show less') : t('user_requests_show_all', 'Show all {count}', { count: mine().length })}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// Wide screens: status, actions and requests on the left, the history on the right
const LEFT = 'min-w-0 min-[1100px]:col-start-1';

/** The members' finances tab. */
export function MemberFinancesPage() {
  const nonPaying = () => currentUser()?.pays === false;
  return (
    <div class="min-[1100px]:grid min-[1100px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] min-[1100px]:items-start min-[1100px]:gap-x-6">
      <div id="user-finances-status-card" class={['mb-5', LEFT]}>
        <Show when={dataLoaded()}>
          <Switch fallback={<NoMemberRecord />}>
            <Match when={nonPaying()}>
              <NonPayingCard />
            </Match>
            <Match when={ownPerson()}>{person => <FinanceHero person={person()} />}</Match>
          </Switch>
        </Show>
      </div>
      <RequestActions class={LEFT} />
      <MyRequests class={LEFT} />
      <Card title={t('user_history_title', 'History')} class="min-w-0 min-[1100px]:col-start-2 min-[1100px]:row-span-3 min-[1100px]:row-start-1">
        <div id="user-payment-history">
          <Show when={dataLoaded() && !nonPaying()}>
            <Show
              when={people().length > 0}
              fallback={<div class="rounded-xl border border-border bg-surface p-5 text-center text-text-secondary">{t('user_no_history', 'No entries yet')}</div>}
            >
              <Show when={ownPerson()}>{person => <Timeline person={person()} />}</Show>
            </Show>
          </Show>
        </div>
      </Card>
    </div>
  );
}
