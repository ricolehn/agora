// The content of the fees settings page: the monthly fees over time and the fresh starts of the fee accounts. Everyone
// on the page reads them (those who see the finances, system admins); only system admins change them.
import { For, Show } from 'solid-js';
import { feePlan, feeResetLog, feeResets } from '../../../../app/data';
import { euro, formatDateFast, getStatusLabels, longDateText, monthText, t } from '../../../../app/i18n';
import { canViewFinances, isSuperAdminUser } from '../../../../app/session';
import { safeList } from '../../../../app/util';
import { Button } from '../../../../ui/Button';
import { Card } from '../../../../ui/Card';
import { Icon } from '../../../../ui/Icon';
import { Field, Input } from '../../../../ui/form';
import {
  FEE_KEYS, FeeCardHead, FeeLog, FormHint, ROW_FACTS, Row, RowButton, Rows, StateBadge, feeListText, feeStateOf, type Fees
} from './common';
import { openFeeChange, reviewFeeRemoval } from './FeeChangeDialog';
import { feeResetReviewBusy, resetDay, reviewFeeReset, setResetDay } from './FeeResetDialog';

type PlanEntry = { from?: string | null; fees?: Fees; state?: string; setByName?: string };

/** One change of the fees: the month it counts from with what it is today, every fee it changed, who set it. */
function FeePlanRow(props: { entry: PlanEntry; previous: PlanEntry | null }) {
  const admin = () => isSuperAdminUser();
  const labels = () => getStatusLabels(false);
  const facts = () => {
    const before = props.previous;
    const changed = before ? FEE_KEYS.filter(key => (before.fees?.[key] || 0) !== (props.entry.fees?.[key] || 0)) : [];
    return [
      // The fees from the beginning with all three amounts
      ...(changed.length
        ? changed.map(key => `${labels()[key]} ${euro(before!.fees?.[key] || 0)} → ${euro(props.entry.fees?.[key] || 0)}`)
        : [feeListText(props.entry.fees)]),
      props.entry.setByName ? t('fee_reset_row_by', 'Set by {name}', { name: props.entry.setByName }) : ''
    ].filter(Boolean);
  };
  return (
    <Row ended={feeStateOf(props.entry.state) === 'ended'}>
      <div class="min-w-0 flex-auto">
        <div class="mb-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.92rem] text-text-secondary">
          <strong class="font-bold text-text">{props.entry.from ? monthText(props.entry.from) : t('fees_from_start', 'From the beginning')}</strong>
          <StateBadge state={props.entry.state} />
        </div>
        <For each={facts()}>{fact => <div class={[ROW_FACTS, 'tabular-nums']}>{fact}</div>}</For>
      </div>
      {/* Admins edit every entry and take a change back; the fees from the beginning stay */}
      <Show when={admin()}>
        <RowButton icon={<Icon name="edit" size={15} />} label={t('btn_edit', 'Edit')} onClick={() => openFeeChange(props.entry.from || null)} />
      </Show>
      <Show when={admin() && props.entry.from}>
        <RowButton icon={<Icon name="trash" size={15} />} label={t('fee_reset_remove_btn', 'Take back')} onClick={() => void reviewFeeRemoval(props.entry.from!)} />
      </Show>
    </Row>
  );
}

/** What a month costs now (and since when), the change still to come, the fees over time and who changed them. */
function FeePlanCard() {
  const admin = () => isSuperAdminUser();
  const labels = () => getStatusLabels(false);
  const entries = () => safeList<PlanEntry>(feePlan()?.entries);
  // The newest first
  const rows = () => entries().map((entry, i) => ({ entry, previous: i > 0 ? entries()[i - 1] : null })).reverse();
  const nextFees = (plan: any) => {
    const next = plan.next;
    return (
      FEE_KEYS.filter(key => (plan.current?.[key] || 0) !== (next.fees?.[key] || 0))
        .map(key => `${labels()[key]} ${euro(next.fees?.[key] || 0)}`)
        .join(', ') || feeListText(next.fees)
    );
  };
  const logText = (entry: any, name: string) =>
    entry.action === 'removed'
      ? t('fees_log_removed', '{name} took back the fees from {month}', { name, month: monthText(entry.from) })
      : entry.from
        ? t('fees_log_set', '{name} set the fees from {month}: {fees}', { name, month: monthText(entry.from), fees: feeListText(entry.fees) })
        : t('fees_log_set_start', '{name} set the fees from the beginning: {fees}', { name, fees: feeListText(entry.fees) });
  return (
    <Card id="card-rates" bodyClass="p-5">
      <FeeCardHead icon={<Icon name="coin" size={20} />} tone="success" title={t('rates_title', 'Monthly Fees')} desc={t('fees_desc', 'What a month costs, by status.')} />
      <Show when={feePlan()}>
        {plan => (
          <>
            <div class="mb-[7px] text-[0.72rem] font-[650] tracking-[0.04em] text-text-secondary uppercase">
              {plan().since ? t('fees_since', 'Since {month}', { month: monthText(plan().since) }) : t('fees_now', 'This month')}
            </div>
            {/* On phones three tiles side by side cut their labels short: one row per status, the amount on the right */}
            <div class="grid grid-cols-3 gap-2 max-[480px]:grid-cols-1 max-[480px]:gap-1.5">
              <For each={FEE_KEYS}>
                {key => (
                  <div class="flex min-w-0 flex-col gap-0.5 rounded-[14px] border border-hairline bg-surface-alt px-3.5 py-3 max-[480px]:flex-row max-[480px]:items-baseline max-[480px]:justify-between max-[480px]:gap-3 max-[480px]:py-2.5">
                    <span class="truncate text-[0.8rem] text-text-secondary max-[480px]:text-[0.88rem]">{labels()[key]}</span>
                    <span class="text-[1.3rem] font-[750] tracking-[-0.02em] text-text tabular-nums max-[480px]:shrink-0 max-[480px]:text-[1.1rem]">
                      {euro(plan().current?.[key] || 0)}
                    </span>
                  </div>
                )}
              </For>
            </div>
            {/* The change that is still to come next: only the fees that will differ */}
            <Show when={plan().next}>
              <div class="mt-2.5 flex items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] px-3 py-[9px] text-[0.84rem] leading-[1.45] text-text">
                <Icon name="calendar" size={14} strokeWidth={2.2} class="mt-[3px] shrink-0 text-warning" />
                <span>{t('fees_next', 'From {month}: {fees}', { month: monthText(plan().next.from), fees: nextFees(plan()) })}</span>
              </div>
            </Show>
            <Show when={admin()} fallback={<FormHint id="fee-plan-readonly">{t('fee_reset_readonly', 'Only system admins can change this.')}</FormHint>}>
              <div class="mt-3.5">
                <Button id="btn-fee-change" variant="secondary" block onClick={() => openFeeChange()}>
                  {t('fees_change_btn', 'Change fees…')}
                </Button>
                <FormHint>{t('fees_change_hint', 'You choose the month a change counts from – the months before keep the old fees.')}</FormHint>
              </div>
            </Show>
            {/* One fee for all time and nobody to change it: the tiles say it all */}
            <Show when={rows().length > 0 && (admin() || entries().length > 1)}>
              <div class="mt-5">
                <div class="mb-2 text-[0.86rem] font-bold text-text">{t('fees_history_title', 'Fees over time')}</div>
                <Rows>
                  <For each={rows()}>{row => <FeePlanRow entry={row.entry} previous={row.previous} />}</For>
                </Rows>
              </div>
            </Show>
            <FeeLog id="fee-plan-log" entries={safeList(plan().log)} textOf={logText} />
          </>
        )}
      </Show>
    </Card>
  );
}

/** The days all fee accounts were started afresh; system admins set a day or take one back. */
function FeeResetCard() {
  const admin = () => isSuperAdminUser();
  // The newest first: the day and who set it (what the months cost is the card above's business)
  const resets = () => [...feeResets()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const logText = (entry: any, name: string) =>
    entry.action === 'set'
      ? t('fee_reset_log_set', '{name} set a fresh start for {date}', { name, date: formatDateFast(entry.date) })
      : t('fee_reset_log_removed', '{name} took back the fresh start of {date}', { name, date: formatDateFast(entry.date) });
  return (
    // Treasurers see the days their lists count from; only system admins get the controls
    <Show when={admin() || feeResets().length > 0}>
      <Card id="card-fee-reset" class="mt-4" bodyClass="p-5">
        <FeeCardHead
          icon={<Icon name="rotate" size={20} />}
          tone="warning"
          title={t('fee_reset_title', 'Fresh start for the fees')}
          desc={t('fee_reset_desc', 'On the chosen day, open fees are dropped and credit is carried over.')}
        />
        <div id="fee-reset-list">
          <Show when={resets().length > 0} fallback={<p class="m-0 mb-3.5 text-[0.86rem] text-text-secondary">{t('fee_reset_none', 'No fresh start yet.')}</p>}>
            <Rows class="mb-3.5">
              <For each={resets()}>
                {reset => (
                  <Row ended={feeStateOf(reset.state) === 'ended'}>
                    <div class="min-w-0 flex-auto">
                      <div class="text-[0.92rem] text-text-secondary">
                        <strong class="font-bold text-text">{longDateText(reset.date)}</strong>
                      </div>
                      <Show when={reset.setByName}>
                        <div class={[ROW_FACTS, 'line-clamp-2']}>{t('fee_reset_row_by', 'Set by {name}', { name: reset.setByName })}</div>
                      </Show>
                    </div>
                    <StateBadge state={reset.state} />
                    <Show when={admin()}>
                      <RowButton icon={<Icon name="trash" size={15} />} label={t('fee_reset_remove_btn', 'Take back')} onClick={() => void reviewFeeReset(reset.date)} />
                    </Show>
                  </Row>
                )}
              </For>
            </Rows>
          </Show>
        </div>
        <Show when={admin()} fallback={<FormHint id="fee-reset-readonly">{t('fee_reset_readonly', 'Only system admins can change this.')}</FormHint>}>
          <Field class="mb-0" for="fee-reset-date" label={t('fee_reset_date_label', 'Day of the fresh start')}>
            <div class="flex gap-2">
              <Input
                type="date"
                id="fee-reset-date"
                class="min-w-0 flex-1"
                value={resetDay()}
                onInput={e => setResetDay(e.currentTarget.value)}
                onKeyDown={e => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  void reviewFeeReset();
                }}
              />
              <Button
                id="btn-fee-reset-review"
                variant="secondary"
                class="shrink-0"
                busy={feeResetReviewBusy()}
                busyText={t('btn_loading', 'Loading...')}
                onClick={() => void reviewFeeReset()}
              >
                {t('fee_reset_review_btn', 'Review…')}
              </Button>
            </div>
            <FormHint>{t('fee_reset_form_hint', "Past or future – you'll see what changes before anything happens.")}</FormHint>
          </Field>
        </Show>
        <FeeLog id="fee-reset-log" entries={feeResetLog()} textOf={logText} />
      </Card>
    </Show>
  );
}

/** The fees settings page (its frame and title belong to the settings). */
export function FeesPage() {
  return (
    <Show when={canViewFinances() || isSuperAdminUser()}>
      <FeePlanCard />
      <FeeResetCard />
    </Show>
  );
}
