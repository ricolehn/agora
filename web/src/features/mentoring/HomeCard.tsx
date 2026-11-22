// Start page: unread conversations as one card - header with the total, up to three chats, link to all (nothing
// when everything is read).
import { For, Show } from 'solid-js';
import { t, uiLocale } from '../../app/i18n';
import { switchTab } from '../../app/router';
import { canUseMentoring, currentUser, isCurrentUser } from '../../app/session';
import { Avatar } from '../../ui/Avatar';
import { Icon } from '../../ui/Icon';
import { formatBadgeCount, openChatDirect, threadPartner, threads, type Thread } from './store';

const HOME_MENTORING_ROWS = 3;

/** "14:05" today, "3 Nov" before. */
function when(iso: string | undefined) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' });
}

export function HomeMentoringCard() {
  const unread = () => (currentUser() && canUseMentoring() ? threads().filter(th => (th.unread_count || 0) > 0) : []);
  const total = () => unread().reduce((sum, th) => sum + (th.unread_count || 0), 0);
  const more = () => unread().length - HOME_MENTORING_ROWS;
  return (
    <Show when={unread().length}>
      <div id="user-mentoring-home-card" class="mb-[30px]">
        <div class="overflow-hidden rounded-[20px] border border-border-light bg-surface shadow-card">
          <div class="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5">
            <span class="inline-flex size-[34px] shrink-0 items-center justify-center rounded-[11px] bg-[rgba(124,58,237,0.12)] text-[#7c3aed]">
              <Icon name="chat" size={18} />
            </span>
            <span class="text-[1rem] font-extrabold text-text">{t('home_messages_title', 'New messages')}</span>
            <span class="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-[#7c3aed] px-[7px] text-[0.75rem] font-extrabold leading-none text-white">
              {formatBadgeCount(total())}
            </span>
            <button type="button" class="ml-auto inline-flex items-center gap-0.5 px-0.5 py-1 text-[0.85rem] font-bold text-primary" onClick={() => switchTab('mentoring')}>
              {t('home_messages_all', 'All')}
              <Icon name="chevronRight" size={14} strokeWidth={2.5} />
            </button>
          </div>
          <div class="flex flex-col">
            <For each={unread().slice(0, HOME_MENTORING_ROWS)} keyed={thread => thread.id}>
              {thread => <MessageRow thread={thread()} />}
            </For>
          </div>
          <Show when={more() > 0}>
            <div class="border-t border-border-light px-4 pt-2.5 pb-3 text-[0.8rem] text-text-secondary">
              +{more()} {t('home_mentoring_more_unread', 'more unread conversations')}
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}

function MessageRow(props: { thread: Thread }) {
  const partner = () => threadPartner(props.thread);
  return (
    <button
      type="button"
      class="flex w-full items-center gap-3 border-t border-border-light px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-alt"
      onClick={() => void openChatDirect(props.thread.id, 'home')}
    >
      {/* Seekers see their mentor's picture; mentors only know the anonymous alias */}
      <Avatar uid={isCurrentUser(props.thread.mentor) ? null : props.thread.mentor} name={partner().name} size={44} initialsClass="text-[0.95rem]" />
      <span class="flex min-w-0 flex-1 flex-col gap-px">
        <span class="flex min-w-0 items-center gap-2">
          <span class="min-w-0 flex-1 truncate font-extrabold text-text">{partner().name}</span>
          <span class="shrink-0 text-[0.75rem] font-bold text-primary">{when(props.thread.lastMessage?.created || props.thread.updated)}</span>
        </span>
        <span class="text-[0.68rem] font-extrabold uppercase tracking-[0.05em] text-text-secondary">{partner().role}</span>
        <span class="flex min-w-0 items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-[0.9rem] text-text">{props.thread.last_message || t('home_mentoring_new_message', 'New confidential message')}</span>
          <span class="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[0.7rem] font-extrabold leading-none text-white">
            {formatBadgeCount(props.thread.unread_count || 0)}
          </span>
        </span>
      </span>
    </button>
  );
}
