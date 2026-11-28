// Create a poll (poll-create-modal): a page like the event editor - the question, two to ten answers, the end.
// Nobody sees who created it.
import { For, Show, createSignal } from 'solid-js';
import { errorMessage } from '../../app/api';
import { t } from '../../app/i18n';
import { closeModal, openModal } from '../../app/modals';
import { showToast } from '../../app/toast';
import { pad2, toDateStr } from '../../app/util';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { PollsNote } from './PollsPage';
import { createPoll, creating, setPollFilter } from './store';
import { EDITOR_INPUT, EditorCard, EditorField, EditorPage, TEXT_AREA, TITLE_INPUT } from '../../ui/pages';

const DURATIONS: Array<{ days: number; label: () => string }> = [
  { days: 1, label: () => t('polls_1d', '1 day') },
  { days: 3, label: () => t('polls_3d', '3 days') },
  { days: 7, label: () => t('polls_7d', '1 week') },
  { days: 14, label: () => t('polls_14d', '2 weeks') }
];

const [question, setQuestion] = createSignal('');
const [description, setDescription] = createSignal('');
const [options, setOptions] = createSignal<string[]>(['', '']);
const [multiple, setMultiple] = createSignal(false);
const [endDate, setEndDate] = createSignal('');
const [endTime, setEndTime] = createSignal('');
// The duration chip the end was set with (a date or time typed by hand no longer matches one)
const [durationDays, setDurationDays] = createSignal<number | null>(null);
const [dateLimits, setDateLimits] = createSignal({ min: '', max: '' });

function setPollDuration(days: number) {
  const end = new Date(Date.now() + days * 86400000);
  setEndDate(toDateStr(end));
  setEndTime(`${pad2(end.getHours())}:${pad2(end.getMinutes())}`);
  setDurationDays(days);
}

/** The "+" of the polls tab: an empty page, ending in a week. */
export function openCreatePoll() {
  setQuestion('');
  setDescription('');
  setMultiple(false);
  setOptions(['', '']);
  setPollDuration(7);
  // The end lies between today and one year ahead (the server checks the exact limits)
  setDateLimits({ min: toDateStr(new Date()), max: toDateStr(new Date(Date.now() + 365 * 86400000)) });
  openModal('poll-create-modal');
}

function submitPoll() {
  const date = endDate();
  const time = endTime() || '23:59';
  const endsAt = date ? new Date(`${date}T${time}`).getTime() : NaN;
  const payload = {
    title: question(),
    description: description(),
    options: options().map(v => v.trim()).filter(Boolean),
    multiple: multiple(),
    endsAt
  };
  // A poll the server refuses keeps the page open with what was typed
  createPoll(payload).then(
    () => {
      closeModal('poll-create-modal');
      setPollFilter('open');
      showToast(t('polls_created', 'Poll started'));
    },
    err => showToast(errorMessage(err), 'error')
  );
}

// Symbols of the parts (as drawn in the previous version)
export function PollCreateModal() {
  const setOption = (index: number, value: string) => setOptions(list => list.map((v, i) => (i === index ? value : v)));
  const timeInput = (value: string, set: (v: string) => void) => {
    set(value);
    setDurationDays(null);
  };
  return (
    <EditorPage
      id="poll-create-modal"
      title={t('polls_new', 'New poll')}
      onBack={() => closeModal('poll-create-modal')}
      savebar={
        <>
          <Button variant="secondary" class="m-0 min-h-12" onClick={() => closeModal('poll-create-modal')}>
            {t('btn_cancel', 'Cancel')}
          </Button>
          <Button id="poll-submit" class="m-0 min-h-12" disabled={creating()} onClick={submitPoll}>
            {t('polls_publish', 'Start poll')}
          </Button>
        </>
      }
    >
      <EditorCard tone="cyan" icon={<Icon name="question" size={16} />} label={t('polls_question', 'Question')}>
        <input
          type="text"
          id="poll-question"
          class={TITLE_INPUT}
          maxlength="120"
          placeholder={t('polls_question_ph', 'What would you like to know?')}
          value={question()}
          onInput={e => setQuestion(e.currentTarget.value)}
        />
        <textarea
          id="poll-description"
          class={TEXT_AREA}
          rows="3"
          maxlength="1000"
          placeholder={t('polls_description_ph2', 'Description (optional)')}
          value={description()}
          onInput={e => setDescription(e.currentTarget.value)}
        />
      </EditorCard>
      <EditorCard tone="indigo" icon={<Icon name="list" size={16} />} label={t('polls_options', 'Answers')}>
        <div id="poll-options" class="flex flex-col gap-2">
          <For each={options()} keyed={false}>
            {(value, index) => (
              <div class="flex items-center gap-2">
                <input
                  type="text"
                  class={[EDITOR_INPUT, 'min-w-0 flex-1']}
                  maxlength="100"
                  placeholder={t('polls_option_ph', 'Answer {n}', { n: index + 1 })}
                  value={value()}
                  onInput={e => setOption(index, e.currentTarget.value)}
                />
                <Show when={options().length > 2}>
                  <button
                    type="button"
                    class="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-border-light bg-surface text-text-secondary"
                    aria-label={t('btn_remove', 'Remove')}
                    onClick={() => setOptions(list => list.filter((_, i) => i !== index))}
                  >
                    <Icon name="x" size={16} strokeWidth={2.5} />
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
        <Show when={options().length < 10}>
          <button
            type="button"
            id="poll-add-option"
            class="inline-flex min-h-[46px] items-center justify-center gap-1.5 rounded-[13px] border-[1.5px] border-dashed border-border bg-transparent text-[0.92rem] font-bold text-text-secondary hover:border-primary hover:text-primary"
            onClick={() => setOptions(list => [...list, ''])}
          >
            <Icon name="plus" size={16} strokeWidth={2.5} />
            <span>{t('polls_add_option2', 'Add answer')}</span>
          </button>
        </Show>
        <label class="inline-flex cursor-pointer items-center gap-2 self-start rounded-full bg-[var(--pe-field)] px-3.5 py-[7px] text-[0.86rem] font-semibold text-text">
          <input
            type="checkbox"
            id="poll-multiple"
            class="m-0 size-4 accent-primary"
            checked={multiple()}
            onChange={e => setMultiple(e.currentTarget.checked)}
          />
          <span>{t('polls_multiple', 'Allow several answers')}</span>
        </label>
      </EditorCard>
      <EditorCard tone="amber" icon={<Icon name="clock" size={16} />} label={t('polls_end', 'End')}>
        <div class="flex flex-wrap gap-1.5">
          <For each={DURATIONS}>
            {chip => (
              <button
                type="button"
                class={[
                  'rounded-full border px-3.5 py-[7px] text-[0.84rem] font-bold',
                  durationDays() === chip.days ? 'border-primary bg-primary text-white' : 'border-border-light bg-[var(--pe-field)] text-text-secondary'
                ]}
                onClick={() => setPollDuration(chip.days)}
              >
                {chip.label()}
              </button>
            )}
          </For>
        </div>
        <div class="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2.5">
          <EditorField label={t('polls_end_date', 'Date')}>
            <input
              type="date"
              id="poll-end-date"
              class={EDITOR_INPUT}
              min={dateLimits().min}
              max={dateLimits().max}
              value={endDate()}
              onInput={e => timeInput(e.currentTarget.value, setEndDate)}
            />
          </EditorField>
          <EditorField label={t('polls_end_time', 'Time')}>
            <input type="time" id="poll-end-time" class={EDITOR_INPUT} value={endTime()} onInput={e => timeInput(e.currentTarget.value, setEndTime)} />
          </EditorField>
        </div>
      </EditorCard>
      <PollsNote text={t('polls_create_sub', 'Nobody sees who created it.')} />
    </EditorPage>
  );
}
