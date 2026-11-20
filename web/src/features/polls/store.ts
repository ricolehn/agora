// Anonymous polls: the list, what this device voted, the timed end of running polls, the labels and the result
// shares. The server never links a person to an answer; what you chose is remembered on this device only.
import { createSignal, flush } from 'solid-js';
import { apiJson } from '../../app/api';
import { formatDateFast, t, uiLocale } from '../../app/i18n';
import { closeModal, isModalOpen } from '../../app/modals';
import { activeTab } from '../../app/router';
import { showToast } from '../../app/toast';
import { toDateStr } from '../../app/util';

export type PollOption = { id: string; text: string };
export type Poll = {
  id: string;
  title: string;
  description?: string;
  options: PollOption[];
  multiple: boolean;
  createdAt: number;
  endsAt: number;
  closed: boolean;
  participants: number;
  hasVoted: boolean;
  isMine: boolean;
  results: { counts: Record<string, number>; participants: number } | null;
  tooFewVotes?: boolean;
};
export type PollFilter = 'open' | 'closed' | 'mine';

const [polls, setPolls] = createSignal<Poll[]>([]);
const [pollsLoaded, setPollsLoaded] = createSignal(false);
// A first load that failed: its message with "Try again" (a later failed refresh keeps the list and says so)
const [pollsError, setPollsError] = createSignal('');
const [pollFilter, setPollFilterSignal] = createSignal<PollFilter>('open');
const [openPollId, setOpenPollId] = createSignal<string | null>(null);
export { polls, pollsLoaded, pollsError, pollFilter, openPollId };

export function setPollFilter(filter: PollFilter) {
  setPollFilterSignal(filter);
}

/** Puts a poll the server returned in place of the shown one. */
export function replacePoll(updated: Poll) {
  setPolls(list => list.map(p => (p.id === updated.id ? updated : p)));
  flush();
}
export function addPoll(created: Poll) {
  setPolls(list => [created, ...list]);
  flush();
}
export function removePoll(id: string) {
  setPolls(list => list.filter(p => p.id !== id));
  flush();
}
export function setOpenPoll(id: string | null) {
  setOpenPollId(id);
  flush();
}

// --- What you chose: on this device only (the server keeps no link between you and your answer) ---
const POLL_CHOICES_KEY = 'agora-poll-choices';
const readChoices = (): Record<string, string[]> => {
  try {
    return JSON.parse(localStorage.getItem(POLL_CHOICES_KEY) || '{}') || {};
  } catch {
    return {};
  }
};
const [choices, setChoices] = createSignal<Record<string, string[]>>(readChoices());

export const myPollChoice = (id: string): string[] | null => choices()[id] || null;

export function rememberPollChoice(id: string, optionIds: string[]) {
  const all = { ...readChoices(), [id]: optionIds };
  // Only polls that still exist
  const known = new Set(polls().map(p => p.id));
  for (const key of Object.keys(all)) if (!known.has(key) && key !== id) delete all[key];
  setChoices(all);
  try {
    localStorage.setItem(POLL_CHOICES_KEY, JSON.stringify(all));
  } catch {
    /* private mode */
  }
}

// --- Loading ---
let pollEndTimer: ReturnType<typeof setTimeout> | undefined;

export async function loadPolls(): Promise<void> {
  try {
    const list = await apiJson<Poll[]>('/polls', 'GET', undefined, t('polls_load_failed', 'Polls could not be loaded'));
    setPolls(Array.isArray(list) ? list : []);
    setPollsLoaded(true);
    setPollsError('');
  } catch (err: any) {
    if (pollsLoaded()) showToast(err.message, 'error');
    else setPollsError(err.message);
  }
  flush();
  scheduleNextPollEnd();
  const id = openPollId();
  // Deleted by its creator or an admin while it was open here
  if (id && isModalOpen('poll-detail-modal') && !polls().some(p => p.id === id)) {
    closeModal('poll-detail-modal');
    showToast(t('polls_gone', 'This poll was deleted.'));
  }
}

/** Reloads when the next running poll ends, so it turns into "Finished" with its result without a manual refresh. */
export function scheduleNextPollEnd() {
  clearTimeout(pollEndTimer);
  const next = Math.min(...polls().filter(p => !p.closed).map(p => p.endsAt));
  if (!Number.isFinite(next)) return;
  pollEndTimer = setTimeout(() => {
    if (activeTab() === 'polls') void loadPolls();
  }, Math.min(Math.max(next - Date.now() + 1500, 1000), 2147483000));
}

// --- Labels ---
export const pollEndTime = (poll: Poll) => new Date(poll.endsAt).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });
export const pollEndDate = (poll: Poll) => formatDateFast(toDateStr(new Date(poll.endsAt)));

export function pollTimeLabel(poll: Poll): string {
  const end = new Date(poll.endsAt);
  if (poll.closed) return t('polls_ended_on', 'Ended on {date}', { date: pollEndDate(poll) });
  const days = Math.ceil((poll.endsAt - Date.now()) / 86400000);
  if (days <= 1) {
    const when = end.toDateString() === new Date().toDateString() ? t('polls_today', 'today') : t('polls_tomorrow', 'tomorrow');
    return t('polls_ends_today', 'Ends {when} at {time}', { when, time: pollEndTime(poll) });
  }
  return t('polls_ends_in', '{days} days left', { days });
}

export const pollVotes = (poll: Poll) =>
  poll.participants === 1 ? t('polls_votes_one', '1 vote') : t('polls_votes', '{count} votes', { count: poll.participants });

/**
 * Shares in whole percent. Single choice: largest remainder, so they add up to exactly 100. Multiple choice: share of
 * the participants per answer (they add up to more than 100).
 */
export function pollShares(poll: Poll): Record<string, number> {
  const counts = poll.results?.counts || {};
  const total = Math.max(1, poll.results?.participants || 0);
  const exact = poll.options.map(o => ({ id: o.id, value: ((counts[o.id] || 0) / total) * 100 }));
  if (poll.multiple) return Object.fromEntries(exact.map(e => [e.id, Math.round(e.value)]));
  const shares: Record<string, number> = Object.fromEntries(exact.map(e => [e.id, Math.floor(e.value)]));
  const votes = exact.reduce((sum, e) => sum + (counts[e.id] || 0), 0);
  if (votes > 0) {
    let rest = 100 - Object.values(shares).reduce((a, b) => a + b, 0);
    for (const e of [...exact].sort((a, b) => (b.value % 1) - (a.value % 1))) {
      if (rest-- <= 0) break;
      shares[e.id] += 1;
    }
  }
  return shares;
}

/** The leading answer(s) of a finished poll; a tie lists all of them. */
export function pollLeader(poll: Poll): { text: string; share: number; tie: boolean } | null {
  if (!poll.results) return null;
  const counts = poll.results.counts;
  const top = Math.max(0, ...poll.options.map(o => counts[o.id] || 0));
  if (top === 0) return null;
  const leaders = poll.options.filter(o => (counts[o.id] || 0) === top);
  return { text: leaders.map(o => o.text).join(' · '), share: pollShares(poll)[leaders[0].id], tie: leaders.length > 1 };
}
