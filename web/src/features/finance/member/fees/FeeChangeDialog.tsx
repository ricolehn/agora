// Changing the monthly fees (fee-change-modal): every change says from which month it counts, the months before keep
// the old fees (backend/feeSchedule.js). Only system admins change them, in two steps: the fees and their month, then
// what that does in numbers (the server works them out for everyone) - only then it is saved. Taking a change back
// opens the second step right away.
import { For, Show, createSignal } from 'solid-js';
import { apiJson } from '../../../../app/api';
import { applyFeePlan, feePlan, loadData } from '../../../../app/data';
import { euro, formatDateFast, getStatusLabels, intlFormatter, monthText, t, uiLang } from '../../../../app/i18n';
import { closeModal, isModalOpen, openModal } from '../../../../app/modals';
import { isSuperAdminUser } from '../../../../app/session';
import { attempt, showToast } from '../../../../app/toast';
import { once, pad2, safeList } from '../../../../app/util';
import { Button } from '../../../../ui/Button';
import { Icon } from '../../../../ui/Icon';
import { MODAL_TINTS, Modal, ModalSection } from '../../../../ui/Modal';
import { Field, Input, Select } from '../../../../ui/form';
import { parseAmount } from '../../../../lib/finance';
import { ActionPair, FEE_KEYS, Facts, ImpactTile, addMonths, type FeeKey, type Fees } from './common';
import type { FeePlan } from '../../../../app/types';

type FeeDraft = {
  /** New fees from a month (not an entry being edited). */
  adding?: boolean;
  /** The fees from the beginning (no month to choose). */
  base?: boolean;
  /** The month of the entry being edited. */
  replaces?: string;
  /** Fields the admin typed in: another month leaves them as they are. */
  touched?: Set<FeeKey>;
  /** Taking the change of a month back. */
  remove?: boolean;
  /** What the second step showed, and the version of the fees its numbers are for (both go back with the save). */
  body?: Record<string, unknown>;
  version?: unknown;
};
type Stretch = { first?: string; last?: string; before?: Fees; after?: Fees };
type Impact = { stretches?: Stretch[]; more: { total: number; count: number }; less: { total: number; count: number }; inEffect?: boolean; freshStart?: string; version?: unknown };

// What the dialog is open for (stays while it fades out)
const [draft, setDraft] = createSignal<FeeDraft | null>(null);
const [step, setStep] = createSignal<'form' | 'review'>('form');
// The heading: what is done, and the month it counts from (undefined: none chosen yet)
const [mode, setMode] = createSignal<'add' | 'edit' | 'remove'>('add');
const [shownFrom, setShownFrom] = createSignal<string | null | undefined>(undefined);
const [amounts, setAmounts] = createSignal<Record<FeeKey, string>>({ vollverdiener: '', geringverdiener: '', keinverdiener: '' });
const [month, setMonth] = createSignal('01');
const [year, setYear] = createSignal('2026');
const [years, setYears] = createSignal<number[]>([]);
const [impact, setImpact] = createSignal<Impact | null>(null);
const [reviewBusy, setReviewBusy] = createSignal(false);
const [confirmBusy, setConfirmBusy] = createSignal(false);

const chosenMonth = () => `${year()}-${month()}`;
// The fees that count in [ym] as the card knows them (the entries come earliest first)
const feesOfPlanMonth = (ym: string): Fees => (feePlan()?.entries ?? []).filter(entry => !entry.from || entry.from <= ym).pop()?.fees || {};
// An amount as it is typed: "45.5" / "45,5"
const feeInputText = (amount: unknown) => String(Number(amount) || 0).replace('.', uiLang() === 'en' ? '.' : ',');

/**
 * Opens the dialog: for new fees from a month (no argument), for the entry of [from] ('YYYY-MM'), or for the fees from
 * the beginning (null).
 */
export function openFeeChange(from?: string | null) {
  const plan = feePlan();
  if (!isSuperAdminUser() || !plan) return;
  const adding = from === undefined;
  const entry = adding ? null : (plan.entries.find(e => (e.from || null) === (from || null)) ?? null);
  if (!adding && !entry) return;
  // New fees count from next month unless the admin says otherwise: nobody is behind for a month that has begun
  const nextMonth = addMonths(plan.month, 1);
  const startMonth = entry ? entry.from : nextMonth;
  setDraft({ adding, base: !!entry && !entry.from, replaces: entry?.from || undefined, touched: new Set() });
  const fees: Fees = entry ? entry.fees : feesOfPlanMonth(nextMonth);
  setAmounts({ vollverdiener: feeInputText(fees.vollverdiener), geringverdiener: feeInputText(fees.geringverdiener), keinverdiener: feeInputText(fees.keinverdiener) });
  // Fifteen years back, ten ahead (as far as the server takes a month) - and the year of the entry, wherever it lies
  const thisYear = Number(plan.month.slice(0, 4));
  const choice = new Set(Array.from({ length: 26 }, (_, i) => thisYear - 15 + i));
  if (startMonth) choice.add(Number(startMonth.slice(0, 4)));
  setYears([...choice].sort((a, b) => a - b));
  setMonth((startMonth || plan.month).slice(5, 7));
  setYear((startMonth || plan.month).slice(0, 4));
  setMode(adding ? 'add' : 'edit');
  setShownFrom(entry ? entry.from || null : undefined);
  setImpact(null);
  setStep('form');
  openModal('fee-change-modal');
}

/** Asks the server what [body] does and shows it; the version of the fees the numbers are for goes back with the save. */
function previewFeeChange(body: Record<string, unknown>, withBusy: boolean) {
  const failed = t('fees_load_failed', 'The fees could not be loaded.');
  return once('fee-change-review', () =>
    attempt(
      async () => {
        const result = await apiJson<Impact>('/admin/fees/preview', 'POST', body, failed);
        setDraft(current => ({ ...current, body, version: result.version }));
        setImpact(result);
        setStep('review');
      },
      err => err.message || failed,
      withBusy ? { setBusy: setReviewBusy } : {}
    )
  );
}

async function reviewFeeChange() {
  const current = draft();
  if (!current || current.remove || !isSuperAdminUser()) return;
  const fees: Fees = {};
  for (const key of FEE_KEYS) {
    const amount = parseAmount(amounts()[key]);
    if (Number.isNaN(amount) || amount < 0) {
      document.getElementById(`fee-change-${key}`)?.focus();
      return showToast(t('alert_invalid_amount', 'Invalid amount. Please enter it like 1500 or 1,500.00.'), 'error');
    }
    fees[key] = amount;
  }
  const from = current.base ? null : chosenMonth();
  setShownFrom(from);
  await previewFeeChange({ from, fees, ...(current.replaces ? { replaces: current.replaces } : {}) }, true);
}

function backToFeeChange() {
  // Taking a change back has no first step to go back to
  const current = draft();
  if (!current || current.remove) return closeModal('fee-change-modal');
  setStep('form');
}

/** Taking back the change of [from]: straight to what that does. */
export async function reviewFeeRemoval(from: string) {
  if (!isSuperAdminUser() || !feePlan() || !from) return;
  setDraft({ remove: true });
  setMode('remove');
  setShownFrom(from);
  if (!(await previewFeeChange({ from, remove: true }, false))) return void setDraft(null);
  openModal('fee-change-modal');
}

async function confirmFeeChange() {
  const current = draft();
  if (!current?.body || !isSuperAdminUser() || !isModalOpen('fee-change-modal')) return;
  const failed = t('fees_save_failed', 'The fees could not be saved.');
  await once('fee-change-confirm', () =>
    attempt(
      async () => {
        const data = await apiJson<FeePlan>(current.remove ? '/admin/fees/remove' : '/admin/fees', 'POST', { ...current.body, version: current.version }, failed).catch(async err => {
          // Someone else changed the fees since the numbers were shown: show what is there now, nothing was saved
          if (err.status === 409) {
            applyFeePlan(await apiJson<FeePlan>('/fees').catch(() => null));
            backToFeeChange();
          }
          throw err;
        });
        applyFeePlan(data);
        closeModal('fee-change-modal');
        showToast(current.remove ? t('fees_removed', 'Change taken back') : t('fees_saved', 'Fees saved'));
        // What a month costs and what is owed are worked out by the server: fetch the records again
        await loadData(true);
      },
      err => err.message || failed,
      { setBusy: setConfirmBusy }
    )
  );
}

// New fees start out as what each status costs in the chosen month. Choosing another month takes the fields the admin
// has not typed in along - a status that is not meant to change must not fall back to an older fee by the way
function chooseMonth(nextMonth: string, nextYear: string) {
  setMonth(nextMonth);
  setYear(nextYear);
  const current = draft();
  if (!current?.adding) return;
  const fees = feesOfPlanMonth(`${nextYear}-${nextMonth}`);
  setAmounts(prev => {
    const next = { ...prev };
    for (const key of FEE_KEYS) if (!current.touched?.has(key)) next[key] = feeInputText(fees[key]);
    return next;
  });
}

/** Under the month: what choosing it means - a month still to come moves nothing yet, one that has passed reaches back. */
function monthHint(): { text: string; warning: boolean } {
  const current = draft();
  const plan = feePlan();
  if (!current || current.remove || !plan) return { text: '', warning: false };
  const ym = chosenMonth();
  const first = plan.entries.find(entry => entry.from)?.from;
  const taken = !current.base && ym !== current.replaces && plan.entries.some(entry => entry.from === ym);
  const text = current.base
    ? first
      ? t('fees_hint_start_until', 'Counts for every month before {month}.', { month: monthText(first) })
      : t('fees_hint_start', 'Counts for every month.')
    : taken
      ? t('fees_hint_taken', 'There are fees from {month} already: these replace them.', { month: monthText(ym) })
      : ym > plan.month
        ? t('fees_hint_later', 'Nothing changes before {month}.', { month: monthText(ym) })
        : ym === plan.month
          ? t('fees_hint_now', 'Counts from this month on.')
          : t('fees_hint_back', 'Reaches back: the months since {month} cost these fees too.', { month: monthText(ym) });
  return { text, warning: !current.base && ym < plan.month };
}

function FeeChangeForm() {
  const labels = () => getStatusLabels(false);
  const monthName = (m: number) => intlFormatter(Intl.DateTimeFormat, { month: 'long', timeZone: 'UTC' }).format(new Date(`2024-${pad2(m)}-01T00:00:00Z`));
  const onEnter = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void reviewFeeChange();
  };
  return (
    <div id="fee-change-form" class="flex flex-col gap-2.5">
      <ModalSection icon="💶" title={t('fees_form_amounts', 'Fee per month')}>
        <div class="grid grid-cols-3 gap-2.5 max-mini:grid-cols-1">
          <For each={FEE_KEYS}>
            {key => (
              <Field class="min-w-0" for={`fee-change-${key}`} label={<span class="block truncate">{`${labels()[key]} (€)`}</span>}>
                <Input
                  type="text"
                  inputmode="decimal"
                  id={`fee-change-${key}`}
                  autocomplete="off"
                  value={amounts()[key]}
                  onInput={e => {
                    const value = e.currentTarget.value;
                    draft()?.touched?.add(key);
                    setAmounts(prev => ({ ...prev, [key]: value }));
                  }}
                  onKeyDown={onEnter}
                />
              </Field>
            )}
          </For>
        </div>
      </ModalSection>
      <ModalSection icon="📅" title={t('fees_form_from', 'Counts from')}>
        <Show when={!draft()?.base}>
          <div class="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-2.5">
            <Select id="fee-change-month" aria-label={t('fees_form_month', 'Month')} value={month()} onChange={e => chooseMonth(e.currentTarget.value, year())}>
              <For each={Array.from({ length: 12 }, (_, i) => i + 1)}>{m => <option value={pad2(m)}>{monthName(m)}</option>}</For>
            </Select>
            <Select id="fee-change-year" aria-label={t('fees_form_year', 'Year')} value={year()} onChange={e => chooseMonth(month(), e.currentTarget.value)}>
              <For each={years()}>{y => <option value={String(y)}>{y}</option>}</For>
            </Select>
          </div>
        </Show>
        <p
          id="fee-change-hint"
          class={['mt-2 text-82 leading-[1.45]', monthHint().warning ? 'text-[color-mix(in_srgb,var(--warning)_70%,var(--text))]' : 'text-text-secondary']}
        >
          {monthHint().text}
        </p>
      </ModalSection>
      <ActionPair>
        <Button variant="secondary" onClick={() => closeModal('fee-change-modal')}>
          {t('btn_cancel', 'Cancel')}
        </Button>
        <Button id="btn-fee-change-review" busy={reviewBusy()} busyText={t('btn_loading', 'Loading...')} onClick={() => void reviewFeeChange()}>
          {t('fee_reset_review_btn', 'Review…')}
        </Button>
      </ActionPair>
    </div>
  );
}

const stretchWhen = (stretch: Stretch) =>
  !stretch.first && !stretch.last
    ? t('fees_stretch_all', 'Every month')
    : !stretch.first
      ? t('fees_stretch_until', 'Until {month}', { month: monthText(stretch.last!) })
      : !stretch.last
        ? t('fees_stretch_from', 'From {month}', { month: monthText(stretch.first) })
        : stretch.first === stretch.last
          ? monthText(stretch.first)
          : t('fees_stretch_range', '{from} to {to}', { from: monthText(stretch.first), to: monthText(stretch.last) });

/** The second step: which months cost something else, who owes more or less today (as tiles), and a few short lines. */
function FeeChangeReview(props: { impact: Impact }) {
  const labels = () => getStatusLabels(false);
  const stretches = () => safeList<Stretch>(props.impact.stretches);
  const facts = () => {
    const firstMonth = stretches()[0]?.first;
    return [
      !props.impact.inEffect && firstMonth
        ? t('fees_hint_later', 'Nothing changes before {month}.', { month: monthText(firstMonth) })
        : props.impact.more.count || props.impact.less.count
          ? t('fees_fact_now', 'Shows in the accounts right away.')
          : t('fees_fact_now_none', 'No account changes today.'),
      props.impact.freshStart
        ? t('fees_fact_fresh_start', 'Reaches back before the fresh start of {date}: what was dropped or carried over then is worked out again.', {
            date: formatDateFast(props.impact.freshStart)
          })
        : '',
      t('fee_reset_fact_untouched', 'Payments, history and cash balance stay as they are.')
    ];
  };
  return (
    <div id="fee-change-review" class="flex flex-col gap-2.5">
      <ModalSection icon="📋" title={t('fee_reset_modal_effects', 'What happens')}>
        <Show when={stretches().length > 0}>
          <div class="mb-2.5 flex flex-col gap-2">
            <For each={stretches()}>
              {stretch => (
                <div class="flex flex-col gap-0.5 rounded-xl border border-hairline bg-surface px-3 py-2.5">
                  <strong class="mb-px text-90 font-bold text-text">{stretchWhen(stretch)}</strong>
                  {/* Every fee that differs on a line of its own - "Full earner   €50.00 → €60.00" */}
                  <For each={FEE_KEYS.filter(key => (stretch.before?.[key] || 0) !== (stretch.after?.[key] || 0))}>
                    {key => (
                      <span class="flex justify-between gap-3 text-85 leading-[1.45] text-text-secondary">
                        {labels()[key]}
                        <b class="shrink-0 font-semibold text-text tabular-nums">{`${euro(stretch.before?.[key] || 0)} → ${euro(stretch.after?.[key] || 0)}`}</b>
                      </span>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>
        {/* A change still to come moves no account today: no tiles, its line says so */}
        <Show when={props.impact.more.count || props.impact.less.count}>
          <div class="mb-2.5 flex gap-2">
            <Show when={props.impact.more.count}>
              <ImpactTile side={props.impact.more} label={t('fee_reset_tile_more', 'more to pay')} tone="danger" />
            </Show>
            <Show when={props.impact.less.count}>
              <ImpactTile side={props.impact.less} label={t('fee_reset_tile_less', 'less to pay')} tone="success" />
            </Show>
          </div>
        </Show>
        <Facts facts={facts()} />
      </ModalSection>
      <ActionPair>
        <Button id="btn-fee-change-back" variant="secondary" onClick={() => backToFeeChange()}>
          {mode() === 'remove' ? t('btn_cancel', 'Cancel') : t('btn_back', 'Back')}
        </Button>
        <Button id="btn-fee-change-confirm" busy={confirmBusy()} busyText={t('setup_btn_saving', 'Saving...')} onClick={() => void confirmFeeChange()}>
          {mode() === 'remove' ? t('fee_reset_remove_btn', 'Take back') : t('btn_save', 'Save')}
        </Button>
      </ActionPair>
    </div>
  );
}

export function FeeChangeDialog() {
  const title = () =>
    ({ add: t('fees_change_title', 'Change the fees'), edit: t('fees_edit_title', 'Edit the fees'), remove: t('fees_remove_title', 'Take back this change?') })[mode()];
  const subtitle = () => {
    const from = shownFrom();
    if (from === undefined) return '';
    return from ? t('fees_stretch_from', 'From {month}', { month: monthText(from) }) : t('fees_from_start', 'From the beginning');
  };
  return (
    <Modal
      id="fee-change-modal"
      title={title()}
      subtitle={subtitle()}
      icon={<Icon name="coin" size={18} strokeWidth={2.2} />}
      iconClass={MODAL_TINTS.feeChange}
      class="!max-h-[min(90vh,760px)]"
    >
      <Show when={step() === 'review' && impact()} fallback={<FeeChangeForm />}>
        {shown => <FeeChangeReview impact={shown()} />}
      </Show>
    </Modal>
  );
}
