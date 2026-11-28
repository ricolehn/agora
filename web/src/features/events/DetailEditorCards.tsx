// The cards of the event editor: appointment or event, when, where, what it is about, for whom, the registration -
// with the fields and small switches they are built of.
import type { JSX } from '@solidjs/web';
import { For, Show, onSettled } from 'solid-js';
import { groupList } from '../../app/groups';
import { t } from '../../app/i18n';
import { canManageEvents } from '../../app/session';
import { Switch } from '../../ui/form';
import { Icon } from '../../ui/Icon';
import { Pill, Pills } from '../../ui/PillTabs';
import { currentDetailEvent, draft, groupChosen, setDraft, setDraftField, setDraftType, type EventKind, type RecurringRule } from './store';
import type { Group } from '../../app/types';

// --- Building blocks ---
export const CARD = 'w-full rounded-[18px] border border-border-light bg-surface p-4 shadow-[0_1px_2px_rgba(28,25,23,0.04),0_6px_18px_-14px_rgba(28,25,23,0.25)]';

export const FIELD_BG = 'bg-surface-alt dark:bg-[rgba(28,25,23,0.55)]';

// Date, time, place and numbers: white fields with a small radius
const SMALL_INPUT =
  'min-h-12 w-full max-w-full min-w-0 rounded-lg border border-border-light bg-surface text-text outline-none transition-[border-color,box-shadow,background-color] duration-150 ease-[ease] placeholder:text-text-secondary placeholder:opacity-75 focus:border-primary focus:bg-surface focus:shadow-[0_0_0_4px_rgba(var(--brand-rgb),0.16)]';

const SUB_LABEL = 'mb-1.5 block truncate text-80 font-semibold text-text-secondary';

// The series' rule and count: the editor's soft fields
const SOFT_INPUT =
  'min-h-12 rounded-[13px] border border-border-light bg-surface-alt text-100 text-text outline-none transition-[border-color,box-shadow,background-color] duration-150 ease-[ease] focus:border-primary focus:bg-surface focus:shadow-[0_0_0_4px_rgba(var(--brand-rgb),0.16)] dark:bg-[rgba(28,25,23,0.55)]';

/** The head of a group of fields: the tinted symbol and the label (of its field, [for]). */
export function FieldHead(props: { icon: JSX.Element; tint: string; for?: string; class?: string; children: JSX.Element }) {
  return (
    <label for={props.for} class={['mb-3 flex items-center gap-2.5 text-100 font-bold text-text', props.class]}>
      <span class={['flex size-[34px] shrink-0 items-center justify-center rounded-[11px]', props.tint]}>{props.icon}</span>
      <span>{props.children}</span>
    </label>
  );
}

/** "Multi-day" / "Series" as soft pills with a checkbox. */
function MiniToggle(props: { checked: boolean; onChange: (checked: boolean) => void; title: string; children: JSX.Element }) {
  return (
    <label
      class={[
        'inline-flex cursor-pointer select-none items-center gap-1.5 rounded-full border px-3 py-1.5 text-82 font-semibold transition-[transform,translate,scale,opacity,box-shadow,background-color,border-color,color] duration-150',
        FIELD_BG,
        props.checked ? 'border-primary text-primary' : 'border-border-light text-text-secondary hover:border-primary hover:text-text'
      ]}
      title={props.title}
    >
      <input type="checkbox" class="size-4 accent-primary" checked={props.checked} onChange={e => props.onChange(e.currentTarget.checked)} />
      <span>{props.children}</span>
    </label>
  );
}

/** Appointment or event (event managers), with the highlight switch for events. */
export function TypeCard() {
  const isTermin = () => draft.eventType === 'termin';
  const option = (type: EventKind, icon: JSX.Element, iconTint: [string, string], label: () => string) => (
    <Pill
      chosen={draft.eventType === type}
      class={[
        'flex min-h-11 w-full items-center rounded-[11px] px-3 py-1.5 text-left transition-[transform,translate,scale,opacity,box-shadow,background-color,border-color,color] duration-200 ease-[ease]',
        draft.eventType === type ? 'bg-surface shadow-[0_1px_3px_rgba(28,25,23,0.12),0_4px_12px_-6px_rgba(28,25,23,0.25)] dark:bg-[#44403c]' : 'bg-transparent'
      ]}
      onSelect={() => setDraftType(type)}
    >
      <span class="flex w-full items-center justify-center gap-2">
        <span class={['inline-flex size-[22px] shrink-0 items-center justify-center rounded-md transition-[background-color,color] duration-200', draft.eventType === type ? iconTint[1] : iconTint[0]]}>{icon}</span>
        <span class={['flex-none text-95 font-bold', draft.eventType === type ? 'text-text' : 'text-text-secondary']}>{label()}</span>
      </span>
    </Pill>
  );
  return (
    <div class={CARD}>
      <Pills kind="radio" class={['grid grid-cols-2 gap-1 rounded-[14px] border border-border-light p-1', FIELD_BG]}>
        {option('termin', <Icon name="calendar" size={12} />, ['bg-brand/12 text-brand', 'bg-brand text-white'], () => t('detail_groups_termin', 'Appointment'))}
        {option('event', <Icon name="userCheck" size={12} />, ['bg-[rgba(16,185,129,0.12)] text-[#10b981]', 'bg-[#10b981] text-white'], () => t('detail_groups_event', 'Event'))}
      </Pills>
      <div class="mt-1.5 flex items-center gap-1.5 rounded-md px-1 text-85 font-medium leading-[1.45] text-text-secondary">
        <Icon name="info" size={12} class="shrink-0 text-primary" />
        <span>
          {isTermin()
            ? t('events_type_termin_desc', 'Regular appointment (e.g. bistro, prayer meeting, rehearsal) – appears in the appointment calendar.')
            : t('events_type_event_desc', 'Special event (e.g. youth night, concert, festival) – with cover image & program.')}
        </span>
      </div>
      <Show when={!isTermin()}>
        <label
          class={[
            'mt-1.5 flex cursor-pointer select-none items-center gap-3 rounded-[14px] border px-3.5 py-3 transition-[transform,translate,scale,opacity,box-shadow,background-color,border-color,color] duration-200 ease-[ease]',
            draft.isPinned ? 'border-[rgba(245,158,11,0.6)] bg-[rgba(245,158,11,0.09)]' : ['border-border-light', FIELD_BG]
          ]}
          title={t('events_pin_title', 'Feature as major event / highlight')}
        >
          <input
            type="checkbox"
            class="order-3 ml-auto size-5 cursor-pointer accent-[#f59e0b]"
            checked={draft.isPinned}
            onChange={e => setDraftField('isPinned', e.currentTarget.checked)}
          />
          <span class="flex size-[34px] shrink-0 items-center justify-center rounded-[11px] bg-[rgba(245,158,11,0.14)] text-[#d97706]">
            <Icon name="star" size={12} />
          </span>
          <span class="flex flex-col text-left">
            <span class={['text-92 font-bold', draft.isPinned ? 'text-[#b45309] dark:text-[#fbbf24]' : 'text-text']}>{t('events_pin_label', 'Pin as highlight')}</span>
            <span class="text-66 text-text-secondary">{t('events_pin_desc', 'Major event – shown large at the top of the event overview')}</span>
          </span>
        </label>
      </Show>
    </div>
  );
}

export function WhenCard(props: { dateRef: (el: HTMLInputElement) => void }) {
  const canManage = () => canManageEvents();
  const isTermin = () => canManage() && draft.eventType === 'termin';
  // A series only for new appointments of event managers
  const seriesAvailable = () => isTermin() && !currentDetailEvent();
  const setMultiDay = (on: boolean) =>
    setDraft(d => {
      d.isMultiDay = on;
      if (on && !d.endDate && d.date) d.endDate = d.date;
    });
  return (
    <div class={[CARD, 'grid grid-cols-[34px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-3']}>
      <div class="col-start-1 row-start-1 flex size-[34px] items-center justify-center rounded-[11px] bg-[rgba(139,92,246,0.12)] text-[#7c3aed] dark:bg-[rgba(167,139,250,0.16)] dark:text-[#a78bfa]">
        <Icon name="calendar" size={14} />
      </div>
      <div class="col-start-2 row-start-1 flex items-center justify-between gap-2">
        <span class="text-100 font-bold leading-[1.15] text-text">{t('detail_groups_termin', 'Appointment')}</span>
        <div class="inline-flex items-center gap-1.5">
          <MiniToggle checked={draft.isMultiDay} onChange={setMultiDay} title={t('events_multiday_title', 'Multi-day event (no time)')}>
            {t('events_multiday', 'Multi-day')}
          </MiniToggle>
          <Show when={seriesAvailable()}>
            <MiniToggle checked={draft.isRecurring} onChange={on => setDraftField('isRecurring', on)} title={t('events_series_title', 'Repeat regularly on the same weekday')}>
              {t('events_series', 'Series')}
            </MiniToggle>
          </Show>
        </div>
      </div>
      <div class="col-span-full flex flex-col gap-3">
        <div class={['grid gap-2.5', draft.isMultiDay ? 'grid-cols-2' : 'grid-cols-1']}>
          <div class="flex min-w-0 flex-col gap-[3px]">
            <label class={SUB_LABEL} for="detail-edit-date">{draft.isMultiDay ? t('modal_date_start', 'Start Date') : t('modal_date', 'Date')}</label>
            <input
              ref={props.dateRef}
              id="detail-edit-date"
              type="date"
              required
              class={[SMALL_INPUT, 'px-2.5 py-[7px] text-100']}
              title={t('modal_date_start', 'Start Date')}
              value={draft.date}
              onInput={e => setDraftField('date', e.currentTarget.value)}
            />
          </div>
          <Show when={draft.isMultiDay}>
            <div class="flex min-w-0 flex-col gap-[3px]">
              <label class={SUB_LABEL} for="detail-edit-end-date">{t('modal_end_so_date', 'End Date')}</label>
              <input
                id="detail-edit-end-date"
                type="date"
                class={[SMALL_INPUT, 'px-2.5 py-[7px] text-100']}
                title={t('modal_end_so_date', 'End Date')}
                value={draft.endDate}
                onInput={e => setDraftField('endDate', e.currentTarget.value)}
              />
            </div>
          </Show>
        </div>
        <Show
          when={!draft.isMultiDay}
          fallback={
            <div class="flex items-center gap-1.5 rounded-xl bg-brand/8 px-3 py-[9px] text-82 leading-[1.25] text-primary">
              <Icon name="info" size={12} class="shrink-0" />
              <span>{t('events_multiday_hint', 'Multi-day appointment – no time')}</span>
            </div>
          }
        >
          <div class="grid grid-cols-2 gap-2.5">
            <div class="flex min-w-0 flex-col gap-[3px]">
              <label class={SUB_LABEL} for="detail-edit-start-time">{t('events_time_from_label', 'From (time)')}</label>
              <input
                id="detail-edit-start-time"
                type="time"
                class={[SMALL_INPUT, 'px-2.5 py-[7px] text-100']}
                title={t('events_input_start', 'Start Time')}
                value={draft.startTime}
                onInput={e => setDraftField('startTime', e.currentTarget.value)}
              />
            </div>
            <div class="flex min-w-0 flex-col gap-[3px]">
              <label class={SUB_LABEL} for="detail-edit-end-time">{t('events_time_to_label', 'Until (optional)')}</label>
              <input
                id="detail-edit-end-time"
                type="time"
                class={[SMALL_INPUT, 'px-2.5 py-[7px] text-100']}
                title={t('events_end_time', 'End time')}
                value={draft.endTime}
                onInput={e => setDraftField('endTime', e.currentTarget.value)}
              />
            </div>
          </div>
        </Show>
        <Show when={seriesAvailable() && draft.isRecurring}>
          <div class="mt-1 w-full rounded-[10px] border border-border-light bg-surface px-3 py-2.5">
            <div class="grid grid-cols-[1fr_auto] items-end gap-2.5">
              <div class="flex min-w-0 flex-col gap-[3px]">
                <label class={SUB_LABEL} for="detail-edit-recurring-rule">{t('events_recurring_rule_short', 'Repeat')}</label>
                <select
                  id="detail-edit-recurring-rule"
                  class={[SOFT_INPUT, 'w-full min-w-0 px-3.5']}
                  value={draft.recurringRule}
                  onChange={e => setDraftField('recurringRule', e.currentTarget.value as RecurringRule)}
                >
                  <option value="weekly">{t('events_rule_weekly_same_day', 'Weekly (on the same weekday)')}</option>
                  <option value="biweekly">{t('events_rule_biweekly', 'Bi-weekly')}</option>
                  <option value="monthly">{t('events_rule_monthly', 'Monthly')}</option>
                </select>
              </div>
              <div class="flex flex-col gap-[3px]">
                <label class={SUB_LABEL} for="detail-edit-recurring-count">{t('events_recurring_count', 'Count')}</label>
                <div class="flex items-center gap-[5px]">
                  <input
                    id="detail-edit-recurring-count"
                    type="number"
                    min="2"
                    max="52"
                    class={[SOFT_INPUT, 'w-[55px] px-1 py-1.5 text-center']}
                    value={draft.recurringCount}
                    onInput={e => setDraftField('recurringCount', e.currentTarget.value)}
                  />
                  <span class="text-75 text-text-secondary">{t('events_tab_termine', 'Appointments')}</span>
                </div>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}

export function WhereCard() {
  return (
    <div class={[CARD, 'grid grid-cols-[34px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-3']}>
      <div class="col-start-1 row-start-1 flex size-[34px] items-center justify-center rounded-[11px] bg-[rgba(16,185,129,0.12)] text-[#059669] dark:bg-[rgba(52,211,153,0.16)] dark:text-[#34d399]">
        <Icon name="location" size={14} />
      </div>
      <label class="col-start-2 row-start-1 text-100 font-bold leading-[1.15] text-text" for="detail-edit-location">
        {t('events_where', 'Where / Address')}
      </label>
      <input
        id="detail-edit-location"
        type="text"
        class={[SMALL_INPUT, 'col-span-full mt-1 px-3 py-2 text-85']}
        placeholder={t('events_location_placeholder', 'Enter place or address...')}
        value={draft.location}
        onInput={e => setDraftField('location', e.currentTarget.value)}
      />
    </div>
  );
}

export function DescriptionCard() {
  let area!: HTMLTextAreaElement;
  const autoResize = () => {
    area.style.height = 'auto';
    area.style.height = `${Math.min(300, Math.max(85, area.scrollHeight))}px`;
  };
  onSettled(autoResize);
  return (
    <div class={CARD}>
      <FieldHead icon={<Icon name="text" size={16} />} tint="bg-[rgba(245,158,11,0.13)] text-[#d97706] dark:text-[#fbbf24]" for="detail-edit-description">
        {t('events_input_desc', 'Description')}
      </FieldHead>
      <textarea
        ref={area}
        id="detail-edit-description"
        rows="4"
        class={[
          'm-0 block max-h-[300px] min-h-[120px] w-full resize-y rounded-[13px] border border-border-light px-3.5 py-3 text-100 leading-[1.55] text-text outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-text-secondary placeholder:opacity-75 focus:border-primary focus:bg-surface focus:shadow-[0_0_0_4px_rgba(var(--brand-rgb),0.16)]',
          FIELD_BG
        ]}
        placeholder={t('events_desc_placeholder', 'Write a description (Markdown supported: **bold**, *italic*, lists...)...')}
        value={draft.description}
        onInput={e => {
          setDraftField('description', e.currentTarget.value);
          autoResize();
        }}
      />
    </div>
  );
}

export function GroupsCard() {
  const toggle = (g: Group) =>
    setDraft(d => {
      d.targetGroups = groupChosen(d.targetGroups, g) ? d.targetGroups.filter(entry => entry !== (g.name || g.id) && entry !== g.id) : [...d.targetGroups, g.name || g.id];
    });
  return (
    <div class={CARD}>
      <div class="flex flex-col">
        <FieldHead icon={<Icon name="users" size={16} />} tint="bg-[rgba(99,102,241,0.12)] text-[#6366f1] dark:text-[#a5b4fc]" class="!mb-1.5">
          {t('events_target_groups', 'Target groups')}
        </FieldHead>
        <span class="mb-3 text-85 leading-[1.45] text-text-secondary">
          {t('events_target_groups_desc', 'Only the selected groups see this entry. Without a selection, all members see it.')}
        </span>
      </div>
      <div class="flex flex-wrap gap-2">
        <Show when={groupList().length} fallback={<span class="text-78 text-text-secondary">{t('events_public_all_members', 'Public for all members')}</span>}>
          <For each={groupList()} keyed={group => group.id || group.name}>
            {group => <GroupChip group={group()} onToggle={toggle} />}
          </For>
        </Show>
      </div>
    </div>
  );
}

function GroupChip(props: { group: Group; onToggle: (g: Group) => void }) {
  const chosen = () => groupChosen(draft.targetGroups, props.group);
  return (
    <button
      type="button"
      class={[
        'inline-flex min-h-[38px] cursor-pointer select-none items-center gap-1.5 rounded-full border px-3.5 text-90 font-semibold transition-[transform,translate,scale,opacity,box-shadow,background-color,border-color,color] duration-150',
        chosen() ? 'border-primary bg-brand/12 text-brand-deep dark:bg-[rgba(34,211,238,0.14)] dark:text-[#67e8f9]' : ['border-border-light text-text hover:border-primary', FIELD_BG]
      ]}
      aria-pressed={chosen() ? 'true' : 'false'}
      onClick={() => props.onToggle(props.group)}
    >
      <Show when={chosen()}>
        <Icon name="check" size={14} strokeWidth={3} />
      </Show>
      <span>{props.group.name || props.group.id}</span>
    </button>
  );
}

export function RegistrationEditCard() {
  return (
    <div class={[CARD, 'max-w-full overflow-hidden', { '!border-[rgba(var(--brand-rgb),0.55)]': draft.requiresRegistration }]}>
      <div class="flex items-center justify-between gap-3">
        <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5" for="detail-edit-requires-reg">
          <span class="flex size-[34px] shrink-0 items-center justify-center rounded-[11px] bg-brand/12 text-primary">
            <Icon name="users" size={16} />
          </span>
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-100 font-bold text-text">{t('events_reg_required', 'Registration required')}</span>
            <span class="break-words text-82 leading-[1.25] text-text-secondary">
              {t('events_reg_required_desc', 'Members must register for this appointment in advance')}
            </span>
          </span>
        </label>
        <Switch id="detail-edit-requires-reg" size="sm" checked={draft.requiresRegistration} onChange={on => setDraftField('requiresRegistration', on)} />
      </div>
      <Show when={draft.requiresRegistration}>
        <div class="mt-3.5 w-full border-t border-border-light pt-3.5">
          <div class="grid w-full grid-cols-1 gap-3 min-[521px]:grid-cols-2">
            <div class="flex w-full flex-col gap-1">
              <label class={SUB_LABEL} for="detail-edit-max-participants">{t('events_max_places', 'Max. places')}</label>
              <input
                id="detail-edit-max-participants"
                type="number"
                min="0"
                class={[SMALL_INPUT, 'px-2.5 py-[7px] text-85']}
                placeholder={t('events_max_places_placeholder', '0 = unlimited')}
                value={draft.maxParticipants}
                onInput={e => setDraftField('maxParticipants', e.currentTarget.value)}
              />
              <span class="mt-1 text-75 text-text-secondary opacity-80">{t('events_max_places_hint', '0 = no limit')}</span>
            </div>
            <div class="flex w-full flex-col gap-1">
              <label class={SUB_LABEL} for="detail-edit-min-participants">{t('events_min_participants', 'Min. Participants')}</label>
              <input
                id="detail-edit-min-participants"
                type="number"
                min="0"
                class={[SMALL_INPUT, 'px-2.5 py-[7px] text-85']}
                placeholder={t('events_min_places_placeholder', '0 = any')}
                value={draft.minParticipants}
                onInput={e => setDraftField('minParticipants', e.currentTarget.value)}
              />
              <span class="mt-1 text-75 text-text-secondary opacity-80">{t('events_min_places_hint', '0 = no minimum')}</span>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
