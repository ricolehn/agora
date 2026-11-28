// Anonymous polls: the list, what this device voted, the timed end of running polls, the labels and the result
// shares. The server never links a person to an answer; what you chose is remembered on this device only.
import { action, createOptimistic, createRoot, createSignal, refresh } from 'solid-js';
import { apiJson } from '../../app/api';
import { formatDateFast, t, timeText } from '../../app/i18n';
import { serverData } from '../../app/serverData';
import { readStoredJson, store } from '../../app/storage';
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

// The polls as the server has them: loaded when the tab first shows them, again on every visit, live update, change
// and when a running poll ends (app/serverData.ts)
const serverPolls = serverData(() =>
  apiJson<Poll[]>('/polls', 'GET', undefined, t('polls_load_failed', 'Polls could not be loaded')).then(list => (Array.isArray(list) ? list : []))
);
/** Loads the polls again (the list keeps showing the last ones meanwhile). */
export const refreshPolls = () => refresh(serverPolls);
/** Whether the server's list (not what the page shows: a deletion on its way) still has the poll [id]. */
export const pollOnServer = (id: string) => serverPolls().some(p => p.id === id);

// What the page shows: the server's polls, a deletion already applied while the server is asked
const [polls, setShownPolls] = createRoot(() => createOptimistic<Poll[]>(() => serverPolls(), { lazy: true }));
export { polls };

const [pollFilter, setPollFilter] = createSignal<PollFilter>('open');
// The poll of the detail dialog
const [openPollId, setOpenPoll] = createSignal<string | null>(null);
export { pollFilter, setPollFilter, openPollId, setOpenPoll };

// True while a vote / a new poll is on its way (their buttons wait); back to false by itself when it ends
const [voting, setVoting] = createOptimistic(false);
const [creating, setCreating] = createOptimistic(false);
export { voting, creating };

/** Votes; the poll shows as voted when this resolves. */
export const votePoll = action(function* (id: string, optionIds: string[]) {
  setVoting(true);
  yield apiJson(`/polls/${encodeURIComponent(id)}/vote`, 'POST', { optionIds });
  rememberPollChoice(id, optionIds);
  yield refreshPolls();
});

/** Starts a poll; it is in the list when this resolves. */
export const createPoll = action(function* (poll: { title: string; description: string; options: string[]; multiple: boolean; endsAt: number }) {
  setCreating(true);
  yield apiJson('/polls', 'POST', poll);
  yield refreshPolls();
});

/** Ends a running poll now. */
export const endPoll = action(function* (id: string) {
  yield apiJson(`/polls/${encodeURIComponent(id)}/close`, 'POST');
  yield refreshPolls();
});

/** Deletes a poll: gone from the list at once, back when the server refuses. */
export const deletePoll = action(function* (id: string) {
  setShownPolls(list => list.filter(p => p.id !== id));
  yield apiJson(`/polls/${encodeURIComponent(id)}`, 'DELETE');
  yield refreshPolls();
});

// --- What you chose: on this device only (the server keeps no link between you and your answer) ---
const POLL_CHOICES_KEY = 'agora-poll-choices';
const readChoices = () => readStoredJson<Record<string, string[]>>(POLL_CHOICES_KEY, {});
const [choices, setChoices] = createSignal<Record<string, string[]>>(readChoices());
// A vote in another tab of the app counts here too (the previous app read the stored choices on every showing)
window.addEventListener('storage', event => {
  if (event.key === POLL_CHOICES_KEY || event.key === null) setChoices(readChoices());
});

export const myPollChoice = (id: string): string[] | null => choices()[id] || null;

function rememberPollChoice(id: string, optionIds: string[]) {
  const all = { ...readChoices(), [id]: optionIds };
  // Only polls that still exist
  const known = new Set(polls().map(p => p.id));
  for (const key of Object.keys(all)) if (!known.has(key) && key !== id) delete all[key];
  setChoices(all);
  store(POLL_CHOICES_KEY, all);
}

/** When the next running poll of [list] ends (Infinity: none runs). */
export const nextPollEnd = (list: Poll[]) => Math.min(...list.filter(p => !p.closed).map(p => p.endsAt));

// --- Labels ---
export const pollEndTime = (poll: Poll) => timeText(new Date(poll.endsAt));
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
