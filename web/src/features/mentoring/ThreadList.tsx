// The conversations beside the chat (instead of it on phones): a filter and one card per conversation.
import { For, Show, createMemo } from 'solid-js';
import { t } from '../../app/i18n';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { CountBadge, SearchInput } from '../../ui/feedback';
import { Icon } from '../../ui/Icon';
import { onActivateKey } from '../../ui/keys';
import {
  activeThreadId, inChat, isThreadUnread, openMentoringThread, setThreadSearch, switchMentoringSubTab, threadMatches, threadRow,
  threadSearch, threads, threadsLoaded, type Thread
} from './store';

export function ThreadSidebar() {
  return (
    <div class={['flex flex-col overflow-hidden bg-transparent', inChat() ? 'max-md:hidden' : 'max-md:w-full']}>
      <SearchInput
        id="mentoring-threads-search-input"
        value={threadSearch()}
        onInput={setThreadSearch}
        placeholder={t('mentoring_search_placeholder', 'Filter contacts...')}
      />
      <div id="mentoring-threads-list" class="flex flex-1 flex-col gap-2.5 overflow-y-auto px-0.5 pt-0.5 pb-2">
        <Show when={threadsLoaded() && threads().length === 0} fallback={<For each={threads()} keyed={thread => thread.id}>{thread => <ThreadItem thread={thread()} />}</For>}>
          <EmptyThreads />
        </Show>
      </div>
    </div>
  );
}

const PILL = 'inline-flex max-w-full items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-md border px-2 py-0.5 text-[0.7rem] font-semibold leading-[1.35]';

function ThreadItem(props: { thread: Thread }) {
  const row = createMemo(() => threadRow(props.thread));
  const active = () => activeThreadId() === props.thread.id;
  const unread = () => isThreadUnread(props.thread);
  // The pill of a seeker's mentor is teal, a mentor's seeker grey; an ended conversation is stone
  const pillTone = () => {
    const { closed, isMentor } = row();
    if (closed) {
      return [
        'border-[rgba(168,162,158,0.2)] bg-[rgba(168,162,158,0.12)] text-[#78716c] dark:bg-[rgba(168,162,158,0.2)] dark:text-[#a8a29e]',
        { 'dark:border-[rgba(34,211,238,0.3)]': !isMentor }
      ];
    }
    return isMentor
      ? 'border-border-light bg-surface-alt text-text-secondary'
      : 'border-brand/22 bg-brand/10 text-primary-dark dark:border-[rgba(34,211,238,0.3)] dark:bg-[rgba(34,211,238,0.16)] dark:text-brand';
  };
  const stateClass = () =>
    active()
      ? [
          'border-primary shadow-[0_0_0_2px_rgba(var(--brand-rgb),0.22),0_6px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_2px_rgba(34,211,238,0.25),0_6px_18px_rgba(0,0,0,0.35)]',
          'before:absolute before:top-2 before:bottom-2 before:left-0 before:w-[3.5px] before:rounded-[0_3px_3px_0] before:bg-primary'
        ]
      : unread()
        ? 'border-brand/35 shadow-[0_4px_14px_rgba(var(--glow-rgb),0.10)] dark:hover:border-primary dark:hover:bg-surface-alt dark:hover:shadow-[0_8px_22px_rgba(0,0,0,0.4)]'
        : [
            'border-hairline shadow-card hover:border-brand/35 hover:shadow-[0_8px_18px_rgba(0,0,0,0.06)]',
            'dark:border-border-light dark:shadow-[0_4px_12px_rgba(0,0,0,0.25)] dark:hover:border-primary dark:hover:bg-surface-alt dark:hover:shadow-[0_8px_22px_rgba(0,0,0,0.4)]'
          ];
  return (
    <div
      class={[
        threadMatches(props.thread, threadSearch()) ? 'flex' : 'hidden',
        'relative cursor-pointer select-none items-center gap-3.5 rounded-[20px] border bg-surface px-4 py-3.5 hover:-translate-y-0.5 active:scale-[0.98]',
        'transition-[transform,translate,scale,opacity,box-shadow,background-color,border-color,color] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]',
        stateClass()
      ]}
      data-thread-id={props.thread.id}
      // A card that holds other text: a role="button" div, opened with Enter and space like a tap (as the event cards)
      role="button"
      tabindex="0"
      aria-current={active() ? 'true' : undefined}
      onClick={() => void openMentoringThread(props.thread.id)}
      onKeyDown={e => onActivateKey(e, () => void openMentoringThread(props.thread.id))}
    >
      <div class="relative shrink-0">
        <Show when={row().isMentor} fallback={<Avatar uid={props.thread.mentor} name={row().name} size={46} initialsClass="text-[0.88rem]" />}>
          <div
            class="relative flex size-[46px] items-center justify-center overflow-hidden rounded-full border border-brand/25 bg-brand/12 text-primary-dark dark:border-[rgba(34,211,238,0.35)] dark:bg-[rgba(34,211,238,0.18)] dark:text-brand"
            title={row().name}
          >
            <Icon name="shield" size={20} />
          </div>
        </Show>
        <span
          class={['absolute right-px bottom-px z-[2] size-[11px] rounded-full border-2 border-surface', row().closed ? 'bg-[#a8a29e]' : 'bg-[#10b981]']}
          title={row().closed ? row().closedLabel : t('status_active', 'Active')}
        />
      </div>
      <div class="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div class="flex items-baseline justify-between gap-2">
          <div class={['truncate text-[0.95rem] text-text', unread() ? 'font-extrabold' : 'font-bold']} title={row().name}>
            {row().name}
          </div>
          <div class="shrink-0 text-[0.75rem] font-medium text-text-secondary">{row().date}</div>
        </div>
        <div class="flex items-center gap-1.5">
          <span class={[PILL, pillTone()]}>{row().pill}</span>
        </div>
        <div class="flex items-center justify-between gap-1.5">
          <div class={['flex-1 truncate text-[0.82rem]', unread() ? 'font-semibold text-text' : 'text-text-secondary']} title={row().snippet}>
            {row().snippet}
          </div>
          <Show when={unread()}>
            <CountBadge count={props.thread.unread_count || 0} />
          </Show>
        </div>
      </div>
    </div>
  );
}

function EmptyThreads() {
  return (
    <div class="mx-auto my-2 flex w-full flex-col items-center justify-center rounded-[18px] border border-border-light bg-surface px-5 py-9 text-center text-text-secondary shadow-card">
      <div class="mb-2 text-[2.2rem] opacity-85">💬</div>
      <div class="mb-1 text-[0.95rem] font-bold text-text">{t('mentoring_no_threads_title', 'No active conversations')}</div>
      <div class="mb-3.5 max-w-[240px] text-[0.8rem] leading-[1.4] text-text-secondary">
        {t('mentoring_no_threads_desc', 'Contact a mentor to start a confidential conversation.')}
      </div>
      <Button variant="secondary" size="small" onClick={() => switchMentoringSubTab('find')}>
        {t('mentoring_tab_find', 'Find mentors')}
      </Button>
    </div>
  );
}
