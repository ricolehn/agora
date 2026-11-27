// Sharing a prayer request (prayer-edit-modal) and the options of one (prayer-options-modal): extend and "done" for
// its owner, remove for moderators.
import { For, Show, createMemo, createSignal } from 'solid-js';
import { apiJson, errorMessage } from '../../app/api';
import { t } from '../../app/i18n';
import { closeModal, openModal, setModalCloseGuard } from '../../app/modals';
import { confirmAction, showToast } from '../../app/toast';
import { once } from '../../app/util';
import { Button } from '../../ui/Button';
import { Switch, Textarea } from '../../ui/form';
import { Icon } from '../../ui/Icon';
import { Modal, ModalPart, PART_LABEL } from '../../ui/Modal';
import { Pill, Pills } from '../../ui/PillTabs';
import {
  type Prayer, type PrayerDuration, loadPrayers, prayerDate, prayerName, prayers, removePrayer, replacePrayer, setPrayerFilter, timeAgo
} from './store';
import { flushNow } from '../../app/flush';

// --- Share a request ---
const [draft, setDraft] = createSignal('');
const [anonymous, setAnonymous] = createSignal(false);
const [duration, setDuration] = createSignal<PrayerDuration>('month');
const [sharing, setSharing] = createSignal(false);
let textField: HTMLTextAreaElement | undefined;

// Leaving with a written request asks first (Cancel, ×, Escape, the back gesture)
setModalCloseGuard('prayer-edit-modal', () => !textField?.value.trim() || confirmAction(t('prayers_discard', 'Discard your request?')));

/** The "+" of the prayers tab. */
export function openPrayerEditor() {
  setDraft('');
  setAnonymous(false);
  setDuration('month');
  flushNow();
  openModal('prayer-edit-modal');
  setTimeout(() => textField?.focus(), 150);
}

async function submitPrayer() {
  const text = draft().trim();
  if (text.length < 3) {
    showToast(t('prayers_too_short', 'Please write your request (at least 3 characters).'), 'error');
    textField?.focus();
    return;
  }
  setSharing(true);
  try {
    await apiJson('/prayers', 'POST', { text, anonymous: anonymous(), duration: duration() }, t('prayers_share_failed', 'The prayer request could not be shared'));
    closeModal('prayer-edit-modal', false, true);
    showToast(t('prayers_shared', 'Your prayer request has been shared'));
    setPrayerFilter('all');
    await loadPrayers();
  } catch (err) {
    showToast(errorMessage(err), 'error');
  } finally {
    setSharing(false);
  }
}

const DURATIONS: Array<{ value: PrayerDuration; label: () => string }> = [
  { value: 'week', label: () => t('prayers_week', '1 week') },
  { value: 'month', label: () => t('prayers_month', '1 month') },
  { value: 'quarter', label: () => t('prayers_quarter', '3 months') }
];

// The small capital labels of the sheet (.plan-sheet-label)

export function PrayerEditModal() {
  return (
    <Modal
      id="prayer-edit-modal"
      title={t('prayers_new', 'Share a prayer request')}
      maxWidth="460px"
      // The sheet's parts sit a little further apart than in other dialogs (.plan-sheet-body)
      bodyClass="!gap-3.5"
      footer={
        // Share takes the room Cancel leaves (.plan-sheet-footer)
        <div class="flex w-full items-center gap-2">
          <Button variant="secondary" class="shrink-0" onClick={() => closeModal('prayer-edit-modal')}>
            {t('btn_cancel', 'Cancel')}
          </Button>
          <Button id="prayer-submit" class="flex-auto" disabled={sharing()} onClick={() => void submitPrayer()}>
            {t('prayers_share', 'Share')}
          </Button>
        </div>
      }
    >
      <Textarea
        ref={el => (textField = el)}
        id="prayer-text"
        class="min-h-[120px] resize-y leading-[1.5]"
        rows="5"
        maxlength="1000"
        placeholder={t('prayers_text_ph', 'What can we pray for?')}
        aria-label={t('prayers_your_request', 'Your request')}
        value={draft()}
        onInput={e => setDraft(e.currentTarget.value)}
      />
      <span id="prayer-counter" class="-mt-1.5 self-end text-[0.74rem] text-text-secondary">
        {draft().length} / 1000
      </span>
      <ModalPart ruled>
        <span id="prayer-duration-label" class={PART_LABEL}>
          {t('prayers_how_long_short', 'Shown for')}
        </span>
        <Pills kind="radio" class="flex gap-1 rounded-[14px] border border-border-light bg-surface-alt p-1" aria-labelledby="prayer-duration-label">
          <For each={DURATIONS}>
            {pill => (
              <Pill
                chosen={duration() === pill.value}
                class={[
                  'inline-flex min-h-[34px] min-w-0 flex-[1_1_0] items-center justify-center gap-1.5 rounded-[10px] border-0 px-2.5 py-1.5 text-[0.84rem] font-bold transition-[background-color,color,box-shadow] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                  duration() === pill.value
                    ? 'bg-surface text-primary shadow-[0_1px_2px_rgba(28,25,23,0.08),0_4px_12px_-6px_rgba(28,25,23,0.25)] dark:bg-bg'
                    : 'bg-transparent text-text-secondary hover:text-text'
                ]}
                onSelect={() => setDuration(pill.value)}
              >
                {pill.label()}
              </Pill>
            )}
          </For>
        </Pills>
      </ModalPart>
      <ModalPart ruled>
        <div class="flex items-center justify-between gap-3">
          <label for="prayer-anonymous" class="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5">
            <span class={PART_LABEL}>{t('prayers_anonymous', 'Share anonymously')}</span>
            <span class="-mt-0.5 text-[0.78rem] text-text-secondary">{t('prayers_anonymous_desc', 'Nobody sees who it is from, not even the leaders.')}</span>
          </label>
          <Switch id="prayer-anonymous" checked={anonymous()} onChange={setAnonymous} />
        </div>
      </ModalPart>
    </Modal>
  );
}

// --- The options of one request ---
const [optionsId, setOptionsId] = createSignal<string | null>(null);

/** The options of a request: extend and "done" for its owner, remove for moderators. */
export function openPrayerOptions(id: string) {
  const p = prayers().find(item => item.id === id);
  if (!p || !(p.isMine || p.canDelete)) return;
  setOptionsId(id);
  flushNow();
  openModal('prayer-options-modal');
}

function extendPrayer(id: string) {
  return once(`prayer:${id}`, async () => {
    try {
      replacePrayer(await apiJson<Prayer>(`/prayers/${encodeURIComponent(id)}`, 'PATCH', { extend: 'month' }, t('prayers_save_failed', 'The prayer request could not be saved')));
      closeModal('prayer-options-modal');
      showToast(t('prayers_extended', 'Shown for another month'));
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  });
}

/** Done (own request) or removed by a moderator; only a moderator's removal asks first. */
function deletePrayer(id: string) {
  return once(`prayer:${id}`, async () => {
    const mine = prayers().find(p => p.id === id)?.isMine;
    if (!mine && !confirmAction(t('prayers_remove_confirm', 'Remove this prayer request for everyone?'))) return;
    try {
      await apiJson(`/prayers/${encodeURIComponent(id)}`, 'DELETE', undefined, t('prayers_delete_failed', 'The prayer request could not be deleted'));
      closeModal('prayer-options-modal');
      removePrayer(id);
      showToast(mine ? t('prayers_done_toast', 'Removed - thank you for sharing') : t('prayers_deleted', 'Prayer request deleted'));
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  });
}

// Full width, the symbol close to the text (.prayer-options-actions .btn)
const ACTION = 'w-full !gap-1.5';

export function PrayerOptionsModal() {
  // A request that was just removed stays on screen while the dialog fades out
  const prayer = createMemo<Prayer | null>(prev => prayers().find(p => p.id === optionsId()) ?? prev ?? null);
  const subtitle = () => {
    const p = prayer();
    if (!p) return '';
    if (!p.isMine) return timeAgo(p.createdAt);
    return p.expired
      ? t('prayers_expired_hint', 'No longer shown - extend it to show it again')
      : t('prayers_until', 'Shown until {date}', { date: prayerDate(p.expiresAt) });
  };
  return (
    <Modal
      id="prayer-options-modal"
      title={prayer() ? (prayer()!.isMine ? t('prayers_yours', 'Your prayer request') : prayerName(prayer()!)) : ''}
      subtitle={subtitle()}
      maxWidth="440px"
      footer={
        <Show when={prayer()}>
          {p => (
            <div class="flex w-full flex-col-reverse gap-2">
              <Show
                when={p().isMine}
                fallback={
                  <Button variant="danger" class={ACTION} onClick={() => void deletePrayer(p().id)}>
                    <Icon name="trash" size={15} />
                    <span>{t('prayers_remove', 'Remove')}</span>
                  </Button>
                }
              >
                <Button variant="secondary" class={ACTION} onClick={() => void extendPrayer(p().id)}>
                  <Icon name="clock" size={15} />
                  <span>{t('prayers_extend_month', 'One more month')}</span>
                </Button>
                <Button class={ACTION} onClick={() => void deletePrayer(p().id)}>
                  <Icon name="check" size={15} strokeWidth={2.6} />
                  <span>{t('prayers_done', 'Done - remove')}</span>
                </Button>
              </Show>
            </div>
          )}
        </Show>
      }
    >
      <p class="m-0 text-[0.95rem] leading-[1.55] whitespace-pre-wrap text-text [overflow-wrap:anywhere]">{prayer()?.text}</p>
    </Modal>
  );
}
