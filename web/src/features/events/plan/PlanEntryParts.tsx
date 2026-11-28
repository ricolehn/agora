// The parts of the plan entry's sheet: what (a task or a song, with suggestions while typing), who (people and groups
// asked for it), where in the order of service, and when (a duration or a time).
import { For, Show, createEffect } from 'solid-js';
import { t } from '../../../app/i18n';
import { Avatar } from '../../../ui/Avatar';
import { SearchInput } from '../../../ui/feedback';
import { Input } from '../../../ui/form';
import { Icon } from '../../../ui/Icon';
import { ModalPart, PART_LABEL } from '../../../ui/Modal';
import { Pill, Pills } from '../../../ui/PillTabs';
import {
  PLAN_DURATIONS, candidatesLoading, choosePlanSong, chosenSong, clearPlanPerson, clearPlanSong, entry, keepPlanTask, minutes, name, note,
  pickPlanPerson, pickerOpen, planDuties, planEntryName, planOrder, removePlanPerson, setMinutes, setName, setNote, setPlanMinutes,
  setPlanPlace, setPlanWhen, setSongKey, setWhoSearch, songKey, songSuggestions, togglePlanWho, whoOptions, whoSearch
} from './entry';
import { ProgramKey } from './EventPlan';
import { ChosenPerson, GroupBadge, PlanPerson } from './PlanPeople';
import { programItemTitle } from './program';

// The plan's fields are 40px high (the dialog's body gives them the compact look)
const PLAN_INPUT = 'h-10';

// The name field of the open dialog: the cursor goes there for a new entry, after "x" on a song and when it is missing
export let nameField: HTMLInputElement | undefined;

export const focusName = () => queueMicrotask(() => nameField?.focus());

/** The "x" that takes something back. */
function RemoveButton(props: { label: string; onClick: () => void; class?: string; iconClass?: string; size?: number; strokeWidth?: number }) {
  return (
    <button
      type="button"
      class={['inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-text-secondary hover:text-danger', props.class]}
      aria-label={props.label}
      title={props.label}
      onClick={() => props.onClick()}
    >
      <Icon name="x" size={props.size ?? 12} strokeWidth={props.strokeWidth ?? 2.6} class={props.iconClass} />
    </button>
  );
}

export function WhatSection() {
  return (
    <ModalPart>
      <label class={PART_LABEL} for="plan-entry-name">
        {t('plan_what', 'What?')}
      </label>
      <Show when={chosenSong()}>
        {song => (
          <div class="flex min-h-10 items-center gap-2 rounded-xl bg-brand/10 py-1.5 pr-1.5 pl-3 font-extrabold text-text">
            <Icon name="music" size={15} class="shrink-0 text-brand-deep" />
            <span class="min-w-0 flex-1 truncate">{song().title}</span>
            <Show when={song().key}>
              <ProgramKey value={song().key!} />
            </Show>
            <RemoveButton
              label={t('btn_remove', 'Remove')}
              class="size-7 hover:bg-surface-alt"
              // The song's symbols keep their colour (the old box coloured every symbol in it)
              iconClass="text-brand-deep"
              size={14}
              strokeWidth={2.5}
              onClick={() => {
                clearPlanSong();
                focusName();
              }}
            />
          </div>
        )}
      </Show>
      <Show when={!chosenSong()}>
        <Input
          ref={el => (nameField = el)}
          id="plan-entry-name"
          class={PLAN_INPUT}
          maxlength={80}
          autocomplete="off"
          placeholder={t('plan_what_ph', 'A task, or the title of a song')}
          value={name()}
          onInput={e => setName(e.currentTarget.value)}
        />
      </Show>
      <Show when={songSuggestions().length}>
        <div class="-mt-0.5 flex flex-col overflow-hidden rounded-xl border border-border-light">
          <For each={songSuggestions()}>
            {song => (
              <SuggestOption song onClick={() => choosePlanSong(song.id)} title={song.title} songKey={song.key} sub={[t('plan_kind_song', 'Song'), song.artist].filter(Boolean).join(' · ')} />
            )}
          </For>
          <SuggestOption
            onClick={() => {
              keepPlanTask();
              focusName();
            }}
            title={t('plan_as_task', '"{name}" as a task', { name: name().trim() })}
          />
        </div>
      </Show>
    </ModalPart>
  );
}

function SuggestOption(props: { song?: boolean; title: string; songKey?: string; sub?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class="flex cursor-pointer items-center gap-2.5 border-t border-border-light bg-surface px-2.5 py-2 text-left text-text first:border-t-0 hover:bg-surface-alt focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
      onClick={() => props.onClick()}
    >
      <span
        class={[
          'inline-flex size-7 shrink-0 items-center justify-center rounded-lg',
          props.song ? 'bg-[rgba(245,158,11,0.14)] text-[#b45309] dark:text-[#fbbf24]' : 'bg-brand/10 text-brand-deep'
        ]}
      >
        <Icon name={props.song ? 'music' : 'plus'} size={15} strokeWidth={props.song ? 2 : 2.5} />
      </span>
      <span class="flex min-w-0 flex-col">
        <span class="flex min-w-0 items-center gap-1.5 text-90 font-bold">
          <span class="truncate">{props.title}</span>
          <Show when={props.songKey}>
            <ProgramKey value={props.songKey!} />
          </Show>
        </span>
        <Show when={props.sub}>
          <span class="text-75 text-text-secondary">{props.sub}</span>
        </Show>
      </span>
    </button>
  );
}

export function WhoSection(props: { ruled: boolean }) {
  const editing = () => entry()?.mode === 'edit';
  const existing = () => (editing() ? planDuties() : []);
  const assignees = () => entry()?.assignees || [];
  const hasChips = () => existing().length > 0 || assignees().length > 0 || !pickerOpen();
  return (
    <ModalPart ruled={props.ruled}>
      <span class={PART_LABEL}>{t('plan_who', 'Who?')}</span>
      <Show when={hasChips()}>
        <div id="plan-entry-person" class="flex flex-wrap gap-1.5">
          <For each={existing()} keyed={duty => duty.id}>
            {duty => (
              <span class="inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border border-border-light bg-surface-alt py-[3px] pr-[3px] pl-1.5 text-85 font-semibold text-text">
                <PlanPerson duty={duty()} />
                <RemoveButton label={t('duty_remove_entry', 'Remove entry')} class="size-6 hover:bg-surface" onClick={() => void removePlanPerson(duty().id)} />
              </span>
            )}
          </For>
          <For each={assignees()}>
            {(a, i) => (
              <span class="inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border border-brand/30 bg-brand/10 py-[3px] pr-[3px] pl-1.5 text-85 font-semibold text-text">
                <ChosenPerson uid={a.data.targetUserId} group={!!a.data.targetGroupId} label={a.label} />
                <RemoveButton label={t('btn_remove', 'Remove')} class="size-6 hover:bg-surface" onClick={() => clearPlanPerson(i())} />
              </span>
            )}
          </For>
          <Show when={!pickerOpen()}>
            <button
              type="button"
              class="inline-flex min-h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] border-dashed border-border bg-transparent py-[3px] pr-3 pl-2.5 text-85 font-bold text-primary hover:border-primary hover:bg-brand/6"
              onClick={() => pickPlanPerson()}
            >
              <Icon name="plus" size={13} strokeWidth={2.6} />
              <span>{existing().length || assignees().length ? t('plan_ask_more', 'Ask someone else') : t('plan_ask_person', 'Ask a person or group')}</span>
            </button>
          </Show>
        </div>
      </Show>
      <Show when={pickerOpen()}>
        <div class="flex flex-col gap-1.5">
          <SearchInput
            // Opened by "+ Ask …": the cursor goes to the search
            ref={el => queueMicrotask(() => el.focus())}
            id="plan-who-search"
            class="mb-0"
            placeholder={t('plan_who_search', 'Search a person or group')}
            value={whoSearch()}
            onInput={setWhoSearch}
          />
          <div id="plan-who-list" class="flex max-h-[220px] flex-col overflow-y-auto">
            <Show when={!candidatesLoading()} fallback={<div class="p-3 text-center text-82 text-text-secondary">{t('loading_short', 'Loading...')}</div>}>
              {/* Keyed by person or group: choosing one keeps the list (and the keyboard's place in it) */}
              <For each={whoOptions()} keyed={o => o.key} fallback={<div class="p-3 text-center text-82 text-text-secondary">{t('plan_who_none', 'Nobody found')}</div>}>
                {option => (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={option().chosen ? 'true' : 'false'}
                    disabled={option().done}
                    class="flex w-full cursor-pointer items-center gap-2.5 rounded-none border-b border-border-light bg-transparent px-1 py-[7px] text-left text-text last:border-b-0 hover:enabled:bg-surface-alt focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary disabled:cursor-default disabled:opacity-60"
                    onClick={() => togglePlanWho(option())}
                  >
                    <Show when={!option().group} fallback={<GroupBadge class="size-8 dark:text-[#a5b4fc]" size={15} />}>
                      <Avatar uid={option().data.targetUserId} name={option().label} size={32} initialsClass="text-72" />
                    </Show>
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate text-90 font-semibold">{option().label}</span>
                      <span class="text-75 text-text-secondary">{option().done ? t('plan_who_already', 'Already on this entry') : option().sub}</span>
                    </span>
                    <span
                      class={[
                        'inline-flex size-[22px] shrink-0 items-center justify-center rounded-full border-2',
                        option().chosen ? 'border-primary bg-primary text-white' : 'border-border text-transparent'
                      ]}
                    >
                      <Icon name="check" size={13} strokeWidth={3} />
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </ModalPart>
  );
}

function OrderList() {
  let box: HTMLDivElement | undefined;
  let slot: HTMLDivElement | undefined;
  // The slot stays in sight when the order is longer than its box
  createEffect(
    () => planOrder()?.place,
    () => {
      if (box && slot && box.scrollHeight > box.clientHeight) box.scrollTop = slot.offsetTop - (box.clientHeight - slot.offsetHeight) / 2;
    }
  );
  const places = () => Array.from({ length: (planOrder()?.others.length ?? 0) + 1 }, (_, p) => p);
  return (
    <div ref={box} id="plan-entry-order" class="relative flex max-h-[230px] flex-col overflow-y-auto py-0.5">
      <For each={places()}>
        {p => (
          <>
            <Show
              when={p === planOrder()!.place}
              fallback={
                <button
                  type="button"
                  class="group relative mr-3 ml-16 flex h-4 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-primary before:absolute before:inset-x-0 before:top-1/2 before:border-t-[1.5px] before:border-dashed before:border-brand/35 before:content-[''] focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
                  aria-label={p === 0 ? t('plan_at_start', 'At the start') : t('plan_after', 'After “{name}”', { name: programItemTitle(planOrder()!.others[p - 1]) })}
                  title={p === 0 ? t('plan_at_start', 'At the start') : t('plan_after', 'After “{name}”', { name: programItemTitle(planOrder()!.others[p - 1]) })}
                  onClick={() => setPlanPlace(p)}
                >
                  <span class="relative inline-flex size-[18px] items-center justify-center rounded-full border-[1.5px] border-brand/50 bg-surface group-hover:border-primary group-hover:bg-primary group-hover:text-white">
                    <Icon name="plus" size={11} strokeWidth={3} />
                  </span>
                </button>
              }
            >
              <div
                ref={slot}
                class="flex min-h-[38px] items-center gap-2.5 rounded-xl border-2 border-dashed border-primary bg-brand/8 px-2.5 text-85 font-bold text-primary-dark"
              >
                <span class="w-[42px] shrink-0 font-extrabold text-[#0284c7] tabular-nums dark:text-[#38bdf8]">{planOrder()!.when(planOrder()!.place)}</span>
                <span class="min-w-0 flex-1 truncate">{planEntryName() || t('plan_this_entry', 'This entry')}</span>
                <span class="text-78 font-bold">{t('plan_here', 'here')}</span>
              </div>
            </Show>
            <Show when={p < planOrder()!.others.length}>
              <div class="flex min-h-[30px] items-center gap-2.5 px-3 text-85 text-text-secondary">
                <span class="w-[42px] shrink-0 font-extrabold text-[#0284c7] tabular-nums dark:text-[#38bdf8]">{planOrder()!.when(p < planOrder()!.place ? p : p + 1)}</span>
                <span class="min-w-0 flex-1 truncate">{programItemTitle(planOrder()!.others[p])}</span>
              </div>
            </Show>
          </>
        )}
      </For>
    </div>
  );
}

/** "During the event" / "In the order". */
function WhenTab(props: { order: boolean; label: string }) {
  const on = () => !!entry()?.inProgram === props.order;
  return (
    <Pill
      chosen={on()}
      class={[
        'flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-82 whitespace-nowrap transition-[transform,opacity,box-shadow,background-color,border-color,color] duration-150',
        on()
          ? 'bg-surface font-bold text-primary-dark shadow-[0_1px_3px_rgba(0,0,0,0.08)] dark:bg-[#44403c] dark:shadow-[0_1px_3px_rgba(0,0,0,0.35)]'
          : 'font-semibold text-text-secondary'
      ]}
      onSelect={() => setPlanWhen(props.order)}
    >
      {props.label}
    </Pill>
  );
}

/** A duration pill: again on the chosen one takes it back; "Other" types it. */
function DurationPill(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={props.active ? 'true' : 'false'}
      class={[
        'h-[34px] min-w-11 cursor-pointer rounded-full border-[1.5px] px-3 text-85 font-semibold',
        props.active ? 'border-primary bg-brand/10 text-primary-dark' : 'border-border-light bg-surface text-text hover:border-border'
      ]}
      onClick={() => props.onClick()}
    >
      {props.label}
    </button>
  );
}

export function WhenSection() {
  let minutesInput: HTMLInputElement | undefined;
  return (
    <ModalPart ruled>
      <span class={PART_LABEL} id="plan-when-label">
        {t('plan_when', 'When?')}
      </span>
      <Pills kind="radio" id="plan-entry-when" class="flex gap-[3px] rounded-[10px] border border-border-light bg-surface-alt p-[3px]" aria-labelledby="plan-when-label">
        <WhenTab order={false} label={t('plan_when_event', 'During the event')} />
        <WhenTab order label={t('plan_when_order', 'In the order')} />
      </Pills>
      <Show when={entry()?.inProgram && planOrder()}>
        {order => (
          <div class="flex flex-col gap-2">
            <OrderList />
            <span class={[PART_LABEL, 'mt-1']}>{t('plan_how_long', 'How long (min)?')}</span>
            <div class="flex flex-wrap gap-1.5">
              <For each={PLAN_DURATIONS}>{m => <DurationPill label={String(m)} active={!order().custom && m === order().minutes} onClick={() => setPlanMinutes(m)} />}</For>
              <DurationPill
                label={t('plan_minutes_other', 'Other')}
                active={order().custom}
                onClick={() => {
                  setPlanMinutes('other');
                  queueMicrotask(() => minutesInput?.focus());
                }}
              />
            </div>
            <Show when={order().custom}>
              <Input
                ref={minutesInput}
                type="number"
                inputmode="numeric"
                min="0"
                max="600"
                class={[PLAN_INPUT, '!w-[120px]']}
                placeholder={t('plan_minutes_ph', 'Minutes')}
                aria-label={t('plan_duration', 'Duration (min)')}
                value={minutes()}
                onInput={e => setMinutes(e.currentTarget.value)}
              />
            </Show>
            <Show when={order().hint}>
              <p class="-mt-0.5 text-78 text-text-secondary">{order().hint}</p>
            </Show>
            <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-2.5 gap-y-2">
              <Show when={entry()?.songId}>
                <label class="flex min-w-0 flex-col gap-1 text-75 font-bold text-text-secondary">
                  <span>{t('songbook_key_label', 'Key')}</span>
                  <Input class={PLAN_INPUT} maxlength={3} value={songKey()} onInput={e => setSongKey(e.currentTarget.value)} />
                </label>
              </Show>
              <Input
                class={[PLAN_INPUT, 'col-span-full']}
                maxlength={300}
                placeholder={t('program_note_ph', 'Note (optional)')}
                aria-label={t('program_note_ph', 'Note (optional)')}
                value={note()}
                onInput={e => setNote(e.currentTarget.value)}
              />
            </div>
          </div>
        )}
      </Show>
    </ModalPart>
  );
}
