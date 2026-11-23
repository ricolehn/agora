// Open requests as a calm list like "new messages": on the finances overview all of them, on the start page of those
// who decide on them the newest three. A tap opens the request with all details and the decision.
import { For, Show } from 'solid-js';
import type { FinanceRequest } from '../../../app/data';
import { t } from '../../../app/i18n';
import { switchTab } from '../../../app/router';
import { canApproveRequests } from '../../../app/session';
import { Avatar } from '../../../ui/Avatar';
import { Icon } from '../../../ui/Icon';
import { requestAmount, requestColor, requestTypeLabel } from '../common';
import { openRequestDetail, pendingRequests, requestDateLabel, requestPersonName, requestPersonUid } from './requests';
import { badgeText } from '../../../ui/feedback';

const HOME_REQUEST_COUNT = 3;

function RequestRow(props: { req: FinanceRequest }) {
  const data = () => props.req.data || {};
  const text = () => (props.req.type === 'expense' ? data().description : data().note) || requestDateLabel(props.req);
  return (
    <button
      type="button"
      class="flex w-full items-center gap-3 border-t border-border-light px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-alt"
      style={{ '--req-color': requestColor(props.req) }}
      onClick={() => openRequestDetail(props.req.id)}
    >
      <Avatar uid={requestPersonUid(props.req)} name={requestPersonName(props.req)} size={44} initialsClass="text-[0.95rem]" />
      <span class="flex min-w-0 flex-1 flex-col gap-px">
        <span class="flex min-w-0 items-center gap-2">
          <span class="min-w-0 flex-1 truncate font-extrabold text-text">{requestPersonName(props.req)}</span>
          <span class="shrink-0 text-[0.95rem] font-extrabold text-text">{requestAmount(props.req)}</span>
        </span>
        <span class="inline-flex items-center gap-1.5 text-[0.68rem] font-extrabold tracking-[0.05em] text-text-secondary uppercase">
          <span class="size-[7px] shrink-0 rounded-full bg-[var(--req-color)]" />
          {requestTypeLabel(props.req)}
          <Show when={data().receipt}>
            {' · '}
            <Icon name="paperclip" size={11} />
          </Show>
        </span>
        <span class="flex min-w-0 items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-[0.9rem] text-text">{text()}</span>
        </span>
      </span>
      <Icon name="chevronRight" size={16} strokeWidth={2.5} class="shrink-0 text-text-secondary opacity-60" />
    </button>
  );
}

/** The card of open requests ('fin': all on the finances overview; 'home': the newest on the start page). */
export function RequestsCard(props: { context: 'fin' | 'home'; items: FinanceRequest[]; total: number }) {
  const more = () => props.total - props.items.length;
  return (
    <div class="overflow-hidden rounded-[20px] border border-border-light bg-surface shadow-card">
      <div class="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5">
        <span class="inline-flex size-[34px] shrink-0 items-center justify-center rounded-[11px] bg-[rgba(245,158,11,0.14)] text-[#d97706] dark:text-[#fbbf24]">
          <Icon name="fileText" size={18} />
        </span>
        <span class="font-extrabold text-text">{t('requests_open_title', 'Open requests')}</span>
        <span class="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-[#f59e0b] px-[7px] text-[0.75rem] leading-none font-extrabold text-white">
          {badgeText(props.total)}
        </span>
        <Show when={props.context === 'home'}>
          <button
            type="button"
            class="ml-auto inline-flex items-center gap-0.5 px-0.5 py-1 text-[0.85rem] font-bold text-primary"
            onClick={() => switchTab('finances')}
          >
            {t('home_messages_all', 'All')}
            <Icon name="chevronRight" size={14} strokeWidth={2.5} />
          </button>
        </Show>
      </div>
      <div class="flex flex-col">
        <For each={props.items}>{req => <RequestRow req={req} />}</For>
      </div>
      <Show when={more() > 0}>
        <button
          type="button"
          class="block w-full border-t border-border-light px-4 pt-2.5 pb-3 text-left text-text-secondary hover:text-primary"
          onClick={() => switchTab('finances')}
        >
          {t('requests_more', '+{count} more requests', { count: more() })}
        </button>
      </Show>
    </div>
  );
}

/** Start page: the open requests for those who decide on them (treasurers, the owner). */
export function HomeFinanceRequests() {
  const pending = () => (canApproveRequests() ? pendingRequests() : []);
  return (
    <Show when={pending().length}>
      <div id="home-finance-requests" class="mb-[22px]">
        <RequestsCard context="home" items={pending().slice(0, HOME_REQUEST_COUNT)} total={pending().length} />
      </div>
    </Show>
  );
}
