// The polls tab: running, finished and own polls as cards; a card opens the poll.
import { For, Match, Show, Switch, createEffect, createMemo } from 'solid-js';
import { t } from '../../app/i18n';
import { openModal } from '../../app/modals';
import { activeTab } from '../../app/router';
import { ProgressBar } from '../../ui/feedback';
import { Icon } from '../../ui/Icon';
import {
  type Poll, type PollFilter, nextPollEnd, pollEndDate, pollFilter, pollLeader, polls, pollTimeLabel, pollVotes, refreshPolls, setOpenPoll,
  setPollFilter
} from './store';
import { AppHead, FilterPills, ListEmpty, Loaded } from '../../ui/pages';

export function openPollDetail(id: string) {
  setOpenPoll(id);
  openModal('poll-detail-modal');
}

/** "Votes are only counted - nobody sees who chose what." (also under the create page). */
export function PollsNote(props: { text: string; class?: string }) {
  return (
    <p class={['m-0 mb-3.5 flex items-center gap-1.5 text-[0.8rem] text-text-secondary', props.class]}>
      <Icon name="shield" class="shrink-0 text-[#10b981]" />
      <span>{props.text}</span>
    </p>
  );
}

const FILTERS: Array<{ value: PollFilter; label: () => string }> = [
  { value: 'open', label: () => t('polls_filter_open', 'Running') },
  { value: 'closed', label: () => t('polls_filter_closed', 'Finished') },
  { value: 'mine', label: () => t('polls_filter_mine', 'Mine') }
];

export function PollsPage() {
  return (
    <>
      <AppHead title={t('polls_title', 'Anonymous polls')} />
      <PollsNote class="max-w-[760px]" text={t('polls_note', 'Votes are only counted – nobody sees who chose what.')} />
      <FilterPills value={pollFilter()} options={FILTERS} onChange={setPollFilter} />
      <div id="polls-list">
        <Loaded data={polls} icon="poll" tone="amber">
          {list => <PollList polls={list()} />}
        </Loaded>
      </div>
    </>
  );
}

/** The polls of the chosen filter. */
function PollList(props: { polls: Poll[] }) {
  const shown = () => props.polls.filter(p => (pollFilter() === 'mine' ? p.isMine : pollFilter() === 'closed' ? p.closed : !p.closed));
  // When the next running poll ends, the polls are loaded again (while shown): it turns into "Finished" with its
  // result without a manual refresh
  const nextEnd = createMemo(() => nextPollEnd(props.polls));
  createEffect(nextEnd, next => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => activeTab() === 'polls' && void refreshPolls(), Math.min(Math.max(next - Date.now() + 1500, 1000), 2147483000));
    return () => clearTimeout(timer);
  });
  const emptyTitle = () =>
    pollFilter() === 'mine'
      ? t('polls_empty_mine', 'You have not created a poll yet')
      : pollFilter() === 'closed'
        ? t('polls_empty_closed', 'No finished polls yet')
        : t('polls_empty_open', 'No poll is running right now');
  return (
    <Show
      when={shown().length}
      fallback={<ListEmpty icon="poll" tone="amber" title={emptyTitle()} hint={t('polls_empty_hint', 'Start your own poll with the plus at the bottom right.')} />}
    >
      <div class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-3.5">
        <For each={shown()} keyed={p => p.id}>{poll => <PollCard poll={poll()} />}</For>
      </div>
    </Show>
  );
}

/** One poll: state and time on top, the question, then the leading answer (finished) or what you can do. */
function PollCard(props: { poll: Poll }) {
  const leader = () => pollLeader(props.poll);
  const actionTone = () => (props.poll.closed ? 'text-text' : props.poll.hasVoted ? 'text-[#059669]' : 'text-primary');
  return (
    <button
      type="button"
      class="flex min-w-0 flex-col gap-2.5 rounded-[20px] border border-border-light bg-surface p-4 text-left text-text shadow-[0_1px_2px_rgba(28,25,23,0.04),0_8px_22px_-16px_rgba(28,25,23,0.25)] transition-[translate,box-shadow] duration-150 ease-[ease] hover:-translate-y-px hover:shadow-[0_2px_4px_rgba(28,25,23,0.05),0_12px_26px_-16px_rgba(28,25,23,0.3)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      onClick={() => openPollDetail(props.poll.id)}
    >
      <span class="flex items-center justify-between gap-2">
        <Show
          when={props.poll.closed}
          fallback={
            <span class="inline-flex items-center gap-1.5 rounded-full bg-[rgba(16,185,129,0.12)] px-2.5 py-[3px] text-[0.74rem] font-extrabold text-[#059669]">
              <span class="size-[7px] rounded-full bg-[#10b981]" />
              {t('polls_live', 'Running')}
            </span>
          }
        >
          <span class="inline-flex items-center gap-1.5 rounded-full bg-surface-alt px-2.5 py-[3px] text-[0.74rem] font-extrabold text-text-secondary">
            {t('polls_closed', 'Finished')}
          </span>
        </Show>
        <span class="whitespace-nowrap text-[0.78rem] font-semibold text-text-secondary">
          {props.poll.closed ? pollEndDate(props.poll) : pollTimeLabel(props.poll)}
        </span>
      </span>
      <span class="text-[1.08rem] leading-[1.3] font-extrabold [overflow-wrap:anywhere]">{props.poll.title}</span>
      <Show when={props.poll.description}>
        <span class="-mt-1 line-clamp-2 text-[0.86rem] leading-[1.4] text-text-secondary">{props.poll.description}</span>
      </Show>
      <Show when={leader()}>
        {lead => (
          <span class="flex flex-col gap-1.5 rounded-[14px] bg-surface-alt px-3 py-2.5">
            <span class="flex justify-between gap-2.5 text-[0.86rem] font-bold">
              <span class="min-w-0 truncate">
                {lead().tie ? `${t('polls_tie', 'Tie')}: ` : ''}
                {lead().text}
              </span>
              <strong>{lead().share}%</strong>
            </span>
            <ProgressBar track="bg-border-light" percent={lead().share} />
          </span>
        )}
      </Show>
      <span class="mt-0.5 flex items-center justify-between gap-2.5 border-t border-border-light pt-2.5">
        <span class="inline-flex min-w-0 items-center gap-1.5 text-[0.8rem] font-semibold text-text-secondary">
          <Icon name="users" />
          {pollVotes(props.poll)}
          {props.poll.isMine ? ` · ${t('polls_mine_badge', 'Yours')}` : ''}
        </span>
        <span class={['inline-flex shrink-0 items-center gap-1 text-[0.84rem] font-extrabold', actionTone()]}>
          <Switch>
            <Match when={props.poll.closed}>{props.poll.results ? t('polls_show_result', 'See result') : t('polls_closed', 'Finished')}</Match>
            <Match when={props.poll.hasVoted}>
              <Icon name="check" strokeWidth={3} /> {t('polls_voted', 'Voted')}
            </Match>
            <Match when={true}>{t('polls_vote_now', 'Vote now')}</Match>
          </Switch>
        </span>
      </span>
    </button>
  );
}
