// A fresh start of the fee accounts (fee-reset-modal): on a day the system admins choose, every fee account is settled
// and started afresh - open fees are dropped, credit is carried over, and from then on months and payments count anew
// (backend/feeReset.js). Setting or taking back a day needs the day typed again and the admin's password.
import { Show, createSignal } from 'solid-js';
import { apiJson } from '../../../../app/api';
import { applyFeeResets, loadData } from '../../../../app/data';
import { euro, formatDateFast, longDateText, longDayText, monthText, t } from '../../../../app/i18n';
import { closeModal, onModalClosed, openModal } from '../../../../app/modals';
import { isSuperAdminUser } from '../../../../app/session';
import { attempt, showToast } from '../../../../app/toast';
import { once } from '../../../../app/util';
import { Button } from '../../../../ui/Button';
import { Icon } from '../../../../ui/Icon';
import { MODAL_TINTS, Modal, ModalSection } from '../../../../ui/Modal';
import { Field, Input } from '../../../../ui/form';
import { typedDayMatches } from '../../../../lib/finance.js';
import { ActionPair, Facts, ImpactTile, type ImpactSide } from './common';

type ResetImpact = { date: string; firstMonth: string; inEffect?: boolean; behind: ImpactSide; ahead: ImpactSide };

// The day typed into the fees page's form (emptied once a fresh start is saved)
const [resetDay, setResetDay] = createSignal('');
export { resetDay, setResetDay };
const [reviewBusy, setReviewBusy] = createSignal(false);
export { reviewBusy as feeResetReviewBusy };

// What the dialog asks about: the day and whether it is taken back (null once it closed); the numbers stay shown
// while it fades out
const [draft, setDraft] = createSignal<{ date: string; remove: boolean } | null>(null);
const [shown, setShown] = createSignal<{ impact: ResetImpact; remove: boolean } | null>(null);
const [typed, setTyped] = createSignal('');
const [password, setPassword] = createSignal('');
const [confirmBusy, setConfirmBusy] = createSignal(false);

const canConfirm = () => {
  const current = draft();
  return !!current && typedDayMatches(typed(), current.date) && !!password();
};

/**
 * Opens the confirmation for the day in the form, or ([removeDate]) for taking back the fresh start of that day. What
 * the day changes comes from the server, worked out for everyone (also for an admin who does not see the finances).
 */
export async function reviewFeeReset(removeDate?: string) {
  if (!isSuperAdminUser()) return;
  const remove = typeof removeDate === 'string' && removeDate !== '';
  const date = remove ? removeDate : resetDay();
  if (!date) return showToast(t('fee_reset_choose_day', 'Please choose the day of the fresh start.'), 'error');
  const failed = t('fee_reset_load_failed', 'The fresh start could not be loaded.');
  await once('fee-reset-review', () =>
    attempt(
      async () => {
        const impact = await apiJson<ResetImpact>(`/admin/fee-reset/preview?date=${encodeURIComponent(date)}${remove ? '&remove=1' : ''}`, 'GET', undefined, failed);
        setDraft({ date: impact.date, remove });
        setShown({ impact, remove });
        setTyped('');
        setPassword('');
        openModal('fee-reset-modal');
        // Closing it (also with Escape or "back") forgets the password and what was typed
        onModalClosed('fee-reset-modal', () => {
          setDraft(null);
          setTyped('');
          setPassword('');
        });
      },
      err => err.message || failed,
      remove ? {} : { setBusy: setReviewBusy }
    )
  );
}

async function confirmFeeReset() {
  const current = draft();
  if (!current || !isSuperAdminUser()) return;
  if (!typedDayMatches(typed(), current.date)) return showToast(t('fee_reset_type_day', 'Please type the day exactly as shown.'), 'error');
  const secret = password();
  if (!secret) return showToast(t('delete_account_need_password', 'Please enter your password to confirm.'), 'error');
  const failed = t('fee_reset_save_failed', 'The fresh start could not be saved.');
  await once('fee-reset-confirm', () =>
    attempt(
      async () => {
        // The day goes twice: the server takes nothing that was not confirmed (backend/routes/finance.js)
        const data = await apiJson(current.remove ? '/admin/fee-reset/remove' : '/admin/fee-reset', 'POST', { date: current.date, confirmDate: current.date, password: secret }, failed);
        applyFeeResets(data);
        closeModal('fee-reset-modal');
        setResetDay('');
        showToast(current.remove ? t('fee_reset_removed', 'Fresh start taken back') : t('fee_reset_saved', 'Fresh start saved'));
        await loadData(true);
      },
      err => err.message || failed,
      { setBusy: setConfirmBusy }
    )
  );
}

/** The numbers as tiles - who owes less or more with the fresh start than without it - and a short line each. */
function ResetEffects(props: { impact: ResetImpact; remove: boolean }) {
  const facts = () =>
    props.remove
      ? [
          props.impact.inEffect
            ? t('fee_reset_undo_fact_all', 'Accounts are calculated as if it never happened.')
            : t('fee_reset_undo_fact_planned', "Its day hasn't come yet – nothing was dropped or carried over."),
          // Every month costs the same either way, so taking it back takes no credit away
          props.impact.inEffect && props.impact.ahead.count
            ? t('fee_reset_undo_fact_ahead', 'The credit carried over ({amount}) stays.', { amount: euro(props.impact.ahead.total) })
            : '',
          t('fee_reset_fact_untouched', 'Payments, history and cash balance stay as they are.')
        ]
      : [
          // A day still to come: the numbers count the payments booked so far
          props.impact.inEffect
            ? t('fee_reset_fact_now', 'Takes effect right away.')
            : t('fee_reset_fact_later', 'Takes effect on {date} – the numbers can still change until then.', { date: longDateText(props.impact.date) }),
          t('fee_reset_fact_fees', 'Fees count anew from {month}.', { month: monthText(props.impact.firstMonth) }),
          t('fee_reset_fact_untouched', 'Payments, history and cash balance stay as they are.')
        ];
  return (
    <ModalSection icon="📋" title={t('fee_reset_modal_effects', 'What happens')}>
      <Show
        when={props.remove}
        fallback={
          <div class="flex gap-2">
            <ImpactTile side={props.impact.behind} label={t('fee_reset_tile_dropped', 'open fees dropped')} tone="warning" />
            <ImpactTile side={props.impact.ahead} label={t('fee_reset_tile_carried', 'credit carried over')} tone="success" />
          </div>
        }
      >
        {/* A planned one that changes nothing needs no "nobody" tile: its line says so */}
        <Show when={props.impact.inEffect || props.impact.behind.count}>
          <div class="flex gap-2">
            <ImpactTile side={props.impact.behind} label={t('fee_reset_tile_more', 'more to pay')} tone="danger" />
          </div>
        </Show>
      </Show>
      <Facts facts={facts()} />
    </ModalSection>
  );
}

export function FeeResetDialog() {
  return (
    <Modal
      id="fee-reset-modal"
      title={shown()?.remove ? t('fee_reset_remove_title', 'Take back the fresh start?') : t('fee_reset_set_title', 'Start the fees afresh?')}
      subtitle={shown() ? longDayText(shown()!.impact.date) : ''}
      icon={<Icon name="rotate" size={18} strokeWidth={2.4} />}
      iconClass={MODAL_TINTS.feeReset}
      class="!max-h-[min(90vh,760px)]"
    >
      <Show when={shown()}>{view => <ResetEffects impact={view().impact} remove={view().remove} />}</Show>
      <ModalSection icon="✍️" title={t('fee_reset_modal_confirm', 'Confirm')}>
        <Field for="fee-reset-typed" label={t('fee_reset_type_label', 'Type {date} to confirm', { date: formatDateFast(shown()?.impact.date) })}>
          <Input
            type="text"
            id="fee-reset-typed"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            value={typed()}
            onInput={e => setTyped(e.currentTarget.value)}
          />
        </Field>
        <Field class="mt-2.5" for="fee-reset-password" label={t('fee_reset_password_label', 'Your password')}>
          <Input
            type="password"
            id="fee-reset-password"
            autocomplete="current-password"
            value={password()}
            onInput={e => setPassword(e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              void confirmFeeReset();
            }}
          />
        </Field>
      </ModalSection>
      <ActionPair>
        <Button variant="secondary" onClick={() => closeModal('fee-reset-modal')}>
          {t('btn_cancel', 'Cancel')}
        </Button>
        <Button
          id="btn-fee-reset-confirm"
          variant="danger"
          // Only once the day is typed and the password given: the full red of a dangerous step
          class="enabled:bg-danger enabled:text-white"
          disabled={!canConfirm()}
          busy={confirmBusy()}
          busyText={t('setup_btn_saving', 'Saving...')}
          onClick={() => void confirmFeeReset()}
        >
          {shown()?.remove ? t('fee_reset_remove_btn', 'Take back') : t('fee_reset_set_btn', 'Start afresh')}
        </Button>
      </ActionPair>
    </Modal>
  );
}
