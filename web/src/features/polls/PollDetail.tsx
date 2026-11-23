// One poll (poll-detail-modal): vote anonymously, wait for the result, or see it; the creator (and system admins)
// can end it early or delete it.
import { For, Match, Show, Switch, createEffect, createMemo, createSignal } from 'solid-js';
import { apiJson } from '../../app/api';
import { t } from '../../app/i18n';
import { closeModal } from '../../app/modals';
import { isSuperAdminUser } from '../../app/session';
import { confirmAction, showToast } from '../../app/toast';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Modal } from '../../ui/Modal';
import {
  type Poll, loadPolls, myPollChoice, openPollId, pollEndDate, pollEndTime, pollShares, polls, pollTimeLabel, pollVotes,
  rememberPollChoice, removePoll, replacePoll, scheduleNextPollEnd
} from './store';
import { DeleteButton } from '../../ui/pages';

export function PollDetailModal() {
  // A poll that was just deleted stays on screen while the dialog fades out
  const poll = createMemo<Poll | null>(prev => polls().find(p => p.id === openPollId()) ?? prev ?? null);
  return (
    <Modal
      id="poll-detail-modal"
      title={poll()?.title}
      subtitle={poll() ? `${pollTimeLabel(poll()!)} · ${pollVotes(poll()!)}` : ''}
      icon={<Icon name="poll" size={20} />}
      // The poll badge (.poll-modal-badge) is larger than the dialogs' usual one
      iconClass="!size-[42px] !rounded-[13px] !text-[1rem] bg-surface-alt text-text-secondary"
      maxWidth="520px"
    >
      <Show when={poll()}>{current => <PollBody poll={current()} />}</Show>
    </Modal>
  );
}

/** "You chose …" for polls voted on this device. */
function MyChoiceNote(props: { poll: Poll }) {
  const texts = () =>
    (myPollChoice(props.poll.id) || []).map(id => props.poll.options.find(o => o.id === id)?.text).filter(Boolean).join(', ');
  return (
    <Show when={texts()}>
      <p class="mt-2.5 mb-0 text-[0.85rem] text-text-secondary">
        {t('polls_my_choice', 'Your choice (only saved on this device): {choice}', { choice: texts() })}
      </p>
    </Show>
  );
}

function PollBody(props: { poll: Poll }) {
  // The ticks survive a refresh of the poll while someone is choosing; another poll starts empty
  const [ticked, setTicked] = createSignal<string[]>([]);
  const [voting, setVoting] = createSignal(false);
  const pollId = createMemo(() => props.poll.id);
  createEffect(pollId, () => {
    setTicked([]);
    setVoting(false);
  });
  const manage = () => props.poll.isMine || isSuperAdminUser();

  const tick = (id: string, on: boolean) =>
    setTicked(list => (props.poll.multiple ? (on ? [...list.filter(x => x !== id), id] : list.filter(x => x !== id)) : on ? [id] : list));

  async function vote() {
    const optionIds = props.poll.options.map(o => o.id).filter(id => ticked().includes(id));
    if (!optionIds.length) return showToast(t('polls_choose', 'Please choose an answer.'), 'error');
    setVoting(true);
    try {
      const updated = await apiJson<Poll>(`/polls/${encodeURIComponent(props.poll.id)}/vote`, 'POST', { optionIds });
      rememberPollChoice(updated.id, optionIds);
      replacePoll(updated);
      showToast(t('polls_vote_saved', 'Your vote was counted anonymously.'));
    } catch (err: any) {
      showToast(err.message, 'error');
      setVoting(false);
      // Voted on another device, or the poll just ended: show what is true now
      void loadPolls();
    }
  }

  async function endNow() {
    const tooFew = props.poll.participants < 3;
    const text = tooFew
      ? t('polls_end_confirm_few', 'End the poll now? With fewer than three votes the result stays secret for good.')
      : t('polls_end_confirm', 'End the poll now? Nobody can vote afterwards.');
    if (!confirmAction(text)) return;
    try {
      replacePoll(await apiJson<Poll>(`/polls/${encodeURIComponent(props.poll.id)}/close`, 'POST'));
      scheduleNextPollEnd();
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }

  async function remove() {
    if (!confirmAction(t('polls_delete_confirm', 'Delete the poll for good?'))) return;
    const id = props.poll.id;
    try {
      await apiJson(`/polls/${encodeURIComponent(id)}`, 'DELETE');
      closeModal('poll-detail-modal');
      removePoll(id);
      showToast(t('polls_deleted', 'Poll deleted'));
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }

  return (
    <>
      <Show when={props.poll.description}>
        <p class="mt-0 mb-3.5 text-[0.92rem] leading-normal whitespace-pre-wrap text-text-secondary [overflow-wrap:anywhere]">{props.poll.description}</p>
      </Show>
      <Switch>
        <Match when={!props.poll.closed && !props.poll.hasVoted}>
          <fieldset class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend class="sr-only">{props.poll.title}</legend>
            <For each={props.poll.options} keyed={o => o.id}>
              {option => {
                const checked = () => ticked().includes(option().id);
                return (
                  <label
                    class={[
                      'relative flex cursor-pointer items-center gap-3 rounded-[14px] border-[1.5px] px-3.5 py-3 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-primary',
                      checked() ? 'border-primary bg-[color-mix(in_srgb,var(--primary)_7%,var(--surface))]' : 'border-border-light bg-surface'
                    ]}
                  >
                    <input
                      type={props.poll.multiple ? 'checkbox' : 'radio'}
                      name="poll-choice"
                      value={option().id}
                      checked={checked()}
                      class="pointer-events-none absolute opacity-0"
                      onChange={e => tick(option().id, e.currentTarget.checked)}
                    />
                    <span
                      class={[
                        'size-5 shrink-0 border-2 transition-all duration-150',
                        props.poll.multiple ? 'rounded-md' : 'rounded-full',
                        checked() ? 'border-primary bg-primary shadow-[inset_0_0_0_3px_var(--surface)]' : 'border-border'
                      ]}
                    />
                    <span class="font-semibold [overflow-wrap:anywhere]">{option().text}</span>
                  </label>
                );
              }}
            </For>
          </fieldset>
          <Show when={props.poll.multiple}>
            <p class="mt-2 mb-0 text-[0.8rem] text-text-secondary">{t('polls_multiple_hint', 'Several answers possible.')}</p>
          </Show>
          <p class="mt-3.5 mb-0 flex items-center gap-1.5 text-[0.8rem] text-text-secondary">
            <Icon name="shield" class="text-[#10b981]" />
            {t('polls_anon_note', 'Your choice is only counted – nobody in the app can see what you chose.')}
          </p>
          <Button id="poll-vote-btn" block disabled={voting()} onClick={() => void vote()}>
            {t('polls_vote_btn', 'Vote anonymously')}
          </Button>
        </Match>
        <Match when={!props.poll.closed}>
          <div class="flex items-center gap-2.5 rounded-[14px] bg-surface-alt p-3.5 text-[0.9rem] leading-[1.45] text-text">
            <Icon name="check" size={20} strokeWidth={2.6} class="shrink-0 text-[#10b981]" />
            <span>
              {t('polls_voted_wait', 'You have voted. The result appears on {date} at {time}.', { date: pollEndDate(props.poll), time: pollEndTime(props.poll) })}
            </span>
          </div>
          <MyChoiceNote poll={props.poll} />
          <ul class="mt-3 mb-0 list-disc pl-5 text-[0.9rem] text-text-secondary">
            <For each={props.poll.options} keyed={false}>{option => <li>{option().text}</li>}</For>
          </ul>
        </Match>
        <Match when={props.poll.results}>
          {results => <PollResults poll={props.poll} counts={results().counts} />}
        </Match>
        <Match when={true}>
          <div class="flex items-center gap-2.5 rounded-[14px] bg-surface-alt p-3.5 text-[0.9rem] leading-[1.45] text-text-secondary">
            <Icon name="shield" size={20} />
            <span>{t('polls_too_few', 'Too few votes: with fewer than three votes the result stays secret so nobody can draw conclusions.')}</span>
          </div>
        </Match>
      </Switch>
      <Show when={manage()}>
        <div class="mt-[18px] flex justify-end gap-2 border-t border-border-light pt-3.5">
          <Show when={!props.poll.closed}>
            <Button variant="secondary" size="small" onClick={() => void endNow()}>
              {t('polls_end_now', 'End now')}
            </Button>
          </Show>
          <DeleteButton size="small" onClick={() => void remove()}>
            {t('polls_delete', 'Delete')}
          </DeleteButton>
        </div>
      </Show>
    </>
  );
}

/** The answers of a finished poll, the most chosen first; the own choice (this device) is marked. */
function PollResults(props: { poll: Poll; counts: Record<string, number> }) {
  const shares = () => pollShares(props.poll);
  const count = (id: string) => props.counts[id] || 0;
  const max = () => Math.max(...props.poll.options.map(o => count(o.id)));
  const mine = () => new Set(myPollChoice(props.poll.id) || []);
  const sorted = () => {
    const counts = props.counts;
    return [...props.poll.options].sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0));
  };
  return (
    <>
      <div class="flex flex-col gap-2">
        <For each={sorted()} keyed={o => o.id}>
          {option => {
            const top = () => count(option().id) === max() && count(option().id) > 0;
            return (
              <div
                class={[
                  'relative flex items-center gap-2.5 overflow-hidden rounded-[14px] bg-surface-alt px-3.5 py-3',
                  { 'shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--primary)_55%,transparent)]': mine().has(option().id) }
                ]}
              >
                <span
                  class={[
                    'absolute inset-y-0 left-0',
                    top() ? 'bg-[color-mix(in_srgb,var(--primary)_26%,transparent)]' : 'bg-[color-mix(in_srgb,var(--primary)_14%,transparent)]'
                  ]}
                  style={{ width: `${shares()[option().id]}%` }}
                />
                <span class="relative min-w-0 flex-1 font-bold [overflow-wrap:anywhere]">{option().text}</span>
                <span class={['relative shrink-0 text-[0.85rem] font-extrabold', top() ? 'text-text' : 'text-text-secondary']}>
                  {shares()[option().id]}% · {count(option().id)}
                </span>
              </div>
            );
          }}
        </For>
      </div>
      <MyChoiceNote poll={props.poll} />
      <Show when={props.poll.multiple}>
        <p class="mt-2 mb-0 text-[0.8rem] text-text-secondary">{t('polls_multiple_result_hint', 'Multiple choice: share of participants who chose the answer.')}</p>
      </Show>
    </>
  );
}
