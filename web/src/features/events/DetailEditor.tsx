// The event page, edit mode (editing an event or creating one): cover picture, appointment or event, title, when,
// where, description, target groups, registration, and the save bar that sticks to the bottom.
import { Show, createSignal } from 'solid-js';
import { apiJson, errorMessage, errorStatus } from '../../app/api';
import { groupList } from '../../app/groups';
import { t } from '../../app/i18n';
import { closeModal } from '../../app/modals';
import { canManageEvents } from '../../app/session';
import { showToast } from '../../app/toast';
import { toFormData } from '../../app/util';
import { Icon } from '../../ui/Icon';
import { openImageCrop } from '../../ui/crop';
import { CoverHero } from './DetailView';
import {
  EVENT_DIALOG_ID, cancelDetailEditMode, chosenGroupNames, currentDetailEvent, draft, loadEventsData, openEventDetailModal, setDraft,
  setDraftField, type EventKind
} from './store';
import type { EventSaved } from './types';
import { CARD, DescriptionCard, FIELD_BG, FieldHead, GroupsCard, RegistrationEditCard, TypeCard, WhenCard, WhereCard } from './DetailEditorCards';

// --- Saving ---
const [saving, setSaving] = createSignal(false);

/** Saves the event (a new one: publishes it, a series of appointments: all of them) and shows it. */
async function saveDetailEditMode(focus: (field: 'title' | 'date') => void) {
  const d = draft;
  const title = d.title.trim();
  const date = d.date.trim();
  const canManage = canManageEvents();
  const eventType: EventKind = canManage ? d.eventType : 'event';
  const editing = currentDetailEvent();
  // Recurring series only for new appointments created by event managers
  const isRecurring = canManage && !editing && eventType === 'termin' && d.isRecurring;
  const recurringCount = isRecurring ? Math.min(52, Math.max(2, parseInt(d.recurringCount, 10) || 10)) : 1;
  const payload = {
    title,
    date,
    // Multi-day events have an end date but no times
    endDate: d.isMultiDay ? d.endDate.trim() : '',
    startTime: d.isMultiDay ? '' : d.startTime.trim(),
    endTime: d.isMultiDay ? '' : d.endTime.trim(),
    location: d.location.trim(),
    description: d.description.trim(),
    imageUrl: d.imageUrl.trim(),
    eventType,
    isPinned: canManage && eventType === 'event' && d.isPinned,
    requiresRegistration: d.requiresRegistration,
    minParticipants: parseInt(d.minParticipants, 10) || 0,
    maxParticipants: parseInt(d.maxParticipants, 10) || 0,
    // Without the list of groups (not loaded) the event keeps its groups: it must not turn public by accident
    targetGroups: groupList().length ? chosenGroupNames(d.targetGroups) : [...d.targetGroups],
    isRecurring,
    recurringRule: d.recurringRule || 'weekly',
    recurringCount
  };
  if (!title) {
    showToast(t('events_title_required', 'Please enter a title'), 'warning');
    return focus('title');
  }
  if (!date) {
    showToast(t('events_date_required', 'Please enter a date'), 'warning');
    return focus('date');
  }
  if (d.isMultiDay && payload.endDate && payload.endDate < date) {
    return showToast(t('events_end_before_start', 'The end date must not be before the start date'), 'warning');
  }
  setSaving(true);
  try {
    const eventId = editing ? editing.id : null;
    const saved = await apiJson<EventSaved>(eventId ? `/events/${eventId}` : '/events', eventId ? 'PATCH' : 'POST', payload, t('alert_save_error', 'Error while saving.'));
    showToast(
      eventId
        ? t('events_updated_success', 'Updated successfully!')
        : isRecurring
          ? t('events_series_created', '{count} appointments created successfully!', { count: recurringCount })
          : t('events_published_success', 'Published successfully!'),
      'success'
    );
    await loadEventsData();
    const reopenId = eventId || saved.event?.id;
    if (reopenId) await openEventDetailModal(reopenId);
    else closeModal(EVENT_DIALOG_ID, false, true);
  } catch (err) {
    console.error('saveDetailEditMode error:', err);
    showToast(errorStatus(err) ? errorMessage(err) : t('events_save_network_error', 'Connection error while saving'), 'error');
  } finally {
    setSaving(false);
  }
}

// --- The cover picture: cropped to 16:9, uploaded, then shown ---
async function uploadEventCover(blob: Blob): Promise<boolean> {
  try {
    const image = new File([blob], 'event-cover-16-9.jpg', { type: 'image/jpeg' });
    const data = await apiJson<{ url: string }>('/events/upload-image', 'POST', toFormData({ image }), t('toast_upload_failed_short', 'Upload failed'));
    setDraft(dr => {
      dr.imageUrl = data.url;
    });
    showToast(t('events_cover_applied', 'Event image applied in 16:9 format!'), 'success');
    return true;
  } catch (err) {
    console.error('Crop upload error:', err);
    showToast(errorStatus(err) ? errorMessage(err) : t('events_cover_save_error', 'Failed to save the event image'), 'error');
    return false;
  }
}

function EditTopBar(props: { onImage: boolean }) {
  const isTermin = () => draft.eventType === 'termin' && canManageEvents();
  const heading = () =>
    currentDetailEvent()
      ? isTermin()
        ? t('events_edit_termin', 'Edit appointment')
        : t('events_edit_event', 'Edit event')
      : isTermin()
        ? t('events_new_termin', 'New Appointment')
        : t('events_btn_new', 'New Event');
  return (
    <div
      class={[
        "z-10 flex items-center justify-start gap-3 before:-mr-3 before:h-[42px] before:w-0 before:shrink-0 before:content-['']",
        props.onImage
          ? 'pointer-events-none absolute left-4 right-4 top-[calc(12px+env(safe-area-inset-top,0px))] pl-11 md:top-7 md:pl-[66px]'
          : 'sticky -mx-5 -mt-[calc(12px+env(safe-area-inset-top,0px))] top-[calc(-12px-env(safe-area-inset-top,0px))] bg-bg pb-2 pl-[72px] pr-5 pt-[calc(12px+env(safe-area-inset-top,0px))] md:-top-7 md:-mt-7 md:pt-7'
      ]}
    >
      <span
        id="detail-edit-heading"
        class={[
          'self-center truncate whitespace-nowrap text-115 font-extrabold tracking-[-0.01em] text-text',
          { 'ml-2.5 rounded-full bg-[rgba(28,25,23,0.45)] px-3.5 py-2 !text-95 !text-white backdrop-blur-[10px]': props.onImage }
        ]}
      >
        {heading()}
      </span>
    </div>
  );
}

function CoverEdit(props: { onPick: () => void }) {
  const glass = 'inline-flex cursor-pointer items-center gap-1.5 rounded-[20px] border px-3 py-1.5 text-78 font-semibold text-white shadow-[0_2px_8px_rgba(0,0,0,0.25)] backdrop-blur-[8px] transition-[transform,translate,scale,opacity,box-shadow,background-color,border-color,color] duration-200 hover:-translate-y-px';
  return (
    <Show
      when={draft.imageUrl}
      fallback={
        <button
          type="button"
          class="group/strip mb-1.5 mt-1 flex min-h-[132px] w-full cursor-pointer items-center justify-center rounded-[18px] border-2 border-dashed border-border bg-surface px-4 py-3 transition-[border-color,background-color] duration-150 ease-[ease] hover:border-primary hover:bg-brand/5"
          onClick={() => props.onPick()}
        >
          <span class="flex flex-col items-center gap-2.5 text-center">
            <span class="flex size-[46px] shrink-0 items-center justify-center rounded-[14px] bg-brand/12 text-primary transition-[transform,translate,scale,background-color,color] duration-200 group-hover/strip:scale-105 group-hover/strip:bg-primary group-hover/strip:text-white">
              <Icon name="image" size={22} />
            </span>
            <span class="flex flex-col items-center">
              <span class="text-100 font-bold text-text">{t('events_cover_add', 'Add cover image')}</span>
              <span class="text-82 text-text-secondary">{t('events_cover_add_hint', 'Optional · 16:9, shown large at the top')}</span>
            </span>
          </span>
        </button>
      }
    >
      <CoverHero src={draft.imageUrl}>
        <div class="pointer-events-auto absolute bottom-3.5 right-4 z-[15] inline-flex gap-2">
          <button type="button" class={[glass, 'border-white/25 bg-[rgba(28,25,23,0.75)] hover:border-white/45 hover:bg-[rgba(28,25,23,0.9)]']} title={t('events_cover_change', 'Change image')} onClick={() => props.onPick()}>
            <Icon name="camera" size={13} />
            <span>{t('events_cover_change', 'Change image')}</span>
          </button>
          <button type="button" class={[glass, 'border-white/30 bg-[rgba(239,68,68,0.75)] hover:border-white/50 hover:bg-[rgba(239,68,68,0.95)]']} title={t('events_cover_remove', 'Remove image')} onClick={() => setDraftField('imageUrl', '')}>
            <Icon name="x" size={13} />
            <span>{t('btn_remove', 'Remove')}</span>
          </button>
        </div>
      </CoverHero>
    </Show>
  );
}

function SaveBar(props: { onSave: () => void }) {
  const button = 'flex min-h-[50px] w-full items-center justify-center gap-1 rounded-[15px] px-3 py-[7px] text-100 transition-[transform,translate,scale,opacity,box-shadow,background-color,border-color,color,filter] duration-150 disabled:cursor-not-allowed disabled:opacity-60';
  return (
    <div class="sticky bottom-[calc(-32px-env(safe-area-inset-bottom,0px))] z-20 -mx-5 -mb-[calc(32px+env(safe-area-inset-bottom,0px))] mt-2 flex flex-col gap-[7px] border-t border-border-light bg-[var(--frost-bg)] px-5 pb-[calc(12px+env(safe-area-inset-bottom,0px))] pt-3 backdrop-blur-[14px] backdrop-saturate-150 md:bottom-4 md:mx-0 md:mb-0 md:rounded-[20px] md:border md:p-2.5 md:shadow-[0_12px_30px_-16px_rgba(28,25,23,0.35)]">
      <div class="grid w-full grid-cols-[1fr_1.6fr] gap-2.5">
        <button type="button" class={[button, 'border border-border-light bg-surface font-semibold text-text-secondary hover:border-text-secondary hover:text-text']} onClick={cancelDetailEditMode}>
          <Icon name="x" size={16} class="shrink-0" />
          <span>{t('btn_cancel', 'Cancel')}</span>
        </button>
        <button
          type="button"
          class={[button, 'border-0 bg-gradient-primary font-bold text-white shadow-[0_4px_12px_rgba(var(--glow-rgb),0.25)] enabled:hover:-translate-y-px enabled:hover:shadow-[0_6px_16px_rgba(var(--glow-rgb),0.35)] enabled:hover:brightness-108']}
          disabled={saving()}
          onClick={() => props.onSave()}
        >
          <Icon name="check" size={16} class="shrink-0" />
          <span>{saving() ? t('saving_short', 'Saving...') : currentDetailEvent() ? t('btn_save', 'Save') : t('events_btn_publish_short', 'Publish')}</span>
        </button>
      </div>
    </div>
  );
}

export function DetailEditor() {
  let fileInput!: HTMLInputElement;
  let titleInput!: HTMLInputElement;
  let dateInput!: HTMLInputElement;
  const pickImage = () => {
    fileInput.value = '';
    fileInput.click();
  };
  const onFile = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    openImageCrop({
      file,
      shape: 'wide',
      title: t('event_crop_title', 'Crop event image'),
      subtitle: t('event_crop_subtitle', '16:9 banner format for a consistent look'),
      confirmLabel: t('crop_apply', 'Apply crop'),
      onConfirm: uploadEventCover
    });
    fileInput.value = '';
  };
  const save = () => void saveDetailEditMode(field => (field === 'title' ? titleInput : dateInput).focus());
  return (
    <>
      <Show when={draft.imageUrl}>
        <CoverEdit onPick={pickImage} />
      </Show>
      <EditTopBar onImage={!!draft.imageUrl} />
      <Show when={!draft.imageUrl}>
        <CoverEdit onPick={pickImage} />
      </Show>
      <input ref={fileInput} type="file" accept="image/*" class="hidden" onChange={e => onFile(e.currentTarget.files)} />
      <div class="flex flex-col gap-4">
        <Show when={canManageEvents()}>
          <TypeCard />
        </Show>
        <div class={CARD}>
          <FieldHead icon={<Icon name="pen" size={16} />} tint="bg-brand/12 text-brand-deep dark:text-brand" for="detail-edit-title">
            {t('events_field_title', 'Title')} <span class="text-danger">*</span>
          </FieldHead>
          <input
            ref={titleInput}
            id="detail-edit-title"
            type="text"
            required
            class={[
              'min-h-[54px] w-full rounded-[13px] border border-border-light px-3.5 text-115 font-bold tracking-[-0.01em] text-text outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-text-secondary placeholder:opacity-75 focus:border-primary focus:bg-surface focus:shadow-[0_0_0_4px_rgba(var(--brand-rgb),0.16)]',
              FIELD_BG
            ]}
            placeholder={t('events_title_placeholder', 'e.g. bistro evening, youth night, prayer meeting...')}
            value={draft.title}
            onInput={e => setDraftField('title', e.currentTarget.value)}
          />
        </div>
      </div>
      <div class="flex flex-col gap-4">
        <WhenCard dateRef={el => (dateInput = el)} />
        <WhereCard />
      </div>
      <DescriptionCard />
      <GroupsCard />
      <RegistrationEditCard />
      <SaveBar onSave={save} />
    </>
  );
}
