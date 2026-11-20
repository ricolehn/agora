// A request with all details (request-detail-modal): amount, person, dates, text, receipts and - for those who
// decide on it - approve or reject (with an optional reason shown to the member). Members open their own requests
// here too (state and reason instead of the decision).
import type { JSX } from '@solidjs/web';
import { Show, createEffect, createMemo } from 'solid-js';
import { findPerson, isOwnRequest, requests, type FinanceRequest } from '../../../app/data';
import { dateTimeFormatter, t } from '../../../app/i18n';
import { canApproveRequests } from '../../../app/session';
import { Button } from '../../../ui/Button';
import { Input, Label } from '../../../ui/form';
import { Icon, type IconName } from '../../../ui/Icon';
import { Modal } from '../../../ui/Modal';
import { FeeResetNote } from './parts';
import { feeResetPaymentHint } from './people';
import { ReceiptList } from './Receipts';
import {
  approveRequest, confirmRejectRequest, openRequestId, rejectFormOpen, rejectReason, rejectionReasonOf, requestAmount, requestBusy,
  requestColor, requestDateLabel, requestIcon, requestPersonName, requestState, requestStateLabel, requestTypeLabel,
  setRejectReason, toggleRejectForm
} from './requests';

// The badge in the colour of the request's type (the dialog frame takes classes, so one string per type)
const BADGE: Record<string, string> = {
  payment: 'bg-[#10b981]/14 text-[#10b981]',
  expense: 'bg-[#ef4444]/14 text-[#ef4444]',
  status: 'bg-[#6366f1]/14 text-[#6366f1]',
  standing_order: 'bg-[#06b6d4]/14 text-[#06b6d4]'
};
const badgeClass = (req: FinanceRequest | undefined) => ['!size-[42px] !rounded-[13px]', BADGE[req?.type || ''] || 'bg-primary/14 text-primary'].join(' ');

/** Own request of a member who does not decide: the state instead of the name, no decision. */
const ownView = (req: FinanceRequest) => isOwnRequest(req) && !canApproveRequests();

function DetailRow(props: { icon: IconName; label: string; children: JSX.Element }) {
  return (
    <div class="grid grid-cols-[20px_auto_minmax(0,1fr)] items-start gap-2.5 bg-surface px-3.5 py-[11px] text-[0.92rem] [&+&]:border-t [&+&]:border-border-light">
      <span class="inline-flex pt-0.5 text-text-secondary">
        <Icon name={props.icon} size={16} />
      </span>
      <span class="font-semibold whitespace-nowrap text-text-secondary">{props.label}</span>
      <span class="text-right font-semibold [overflow-wrap:anywhere] whitespace-pre-wrap text-text">{props.children}</span>
    </div>
  );
}

function RequestBody(props: { req: FinanceRequest }) {
  const data = () => props.req.data || {};
  const text = () => (props.req.type === 'expense' ? data().description : data().note);
  // An open payment request dated before the fresh start: what approving it does (and does not) for the member
  const resetHint = () =>
    props.req.type === 'payment' && props.req.status === 'pending' ? feeResetPaymentHint(findPerson(props.req.personId), data().date) : '';
  return (
    <div style={{ '--req-color': requestColor(props.req) }}>
      <div class="mb-3.5 flex flex-col items-center gap-1 rounded-[18px] border border-[color-mix(in_srgb,var(--req-color)_22%,transparent)] bg-[color-mix(in_srgb,var(--req-color)_8%,var(--surface-alt))] px-3 pt-[18px] pb-5 text-center">
        <span class="text-[1.9rem] leading-[1.15] font-extrabold tracking-[-0.02em] [overflow-wrap:anywhere] text-text">{requestAmount(props.req)}</span>
        <span class="text-[0.88rem] font-semibold text-text-secondary">{requestDateLabel(props.req)}</span>
      </div>
      <div class="flex flex-col overflow-hidden rounded-[14px] border border-border-light">
        <Show when={!ownView(props.req)}>
          <DetailRow icon="person" label={t('request_detail_person', 'From')}>
            {requestPersonName(props.req)}
          </DetailRow>
        </Show>
        <Show when={text()}>
          <DetailRow
            icon={props.req.type === 'expense' ? 'receipt' : 'fileText'}
            label={props.req.type === 'expense' ? t('request_detail_purpose', 'Purpose') : t('request_detail_note', 'Note')}
          >
            {text()}
          </DetailRow>
        </Show>
        <Show when={props.req.timestamp}>
          <DetailRow icon="clock" label={t('request_detail_received', 'Received')}>
            {dateTimeFormatter.format(new Date(props.req.timestamp))}
          </DetailRow>
        </Show>
        <Show when={props.req.status !== 'pending' || !canApproveRequests()}>
          <DetailRow icon="check" label={t('request_detail_status', 'Status')}>
            <span class="font-extrabold" style={{ color: requestState(props.req)[0] }}>
              {requestStateLabel(props.req)}
            </span>
          </DetailRow>
        </Show>
        <Show when={props.req.status === 'rejected'}>
          <DetailRow icon="alert" label={t('request_detail_reason', 'Reason')}>
            {rejectionReasonOf(props.req)}
          </DetailRow>
        </Show>
      </div>
      <Show when={resetHint()}>
        <FeeResetNote text={resetHint()} class="mt-3" />
      </Show>
      <Show when={data().receipt}>
        <div class="mt-3.5 [&_img]:max-w-full [&_img]:rounded-xl">
          <ReceiptList receipt={data().receipt} variant="request" />
        </div>
      </Show>
    </div>
  );
}

const DECISION_BTN = 'min-h-[46px] w-full min-w-0 !gap-1.5 !rounded-[13px] !font-bold';

function Decision(props: { req: FinanceRequest }) {
  let reasonInput: HTMLInputElement | undefined;
  const canDecide = () => canApproveRequests() && props.req.status === 'pending';
  createEffect(rejectFormOpen, open => {
    if (open) reasonInput?.focus();
  });
  return (
    <div class="mt-[18px]">
      <Show when={canDecide() && !rejectFormOpen()}>
        <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2.5">
          <Button variant="secondary" class={DECISION_BTN} disabled={requestBusy()} onClick={() => toggleRejectForm(true)}>
            <Icon name="x" size={16} strokeWidth={2.5} />
            <span>{t('request_btn_reject', 'Reject')}</span>
          </Button>
          <Button class={DECISION_BTN} disabled={requestBusy()} onClick={() => void approveRequest()}>
            <Icon name="check" size={16} strokeWidth={2.5} />
            <span>{t('request_btn_approve', 'Approve')}</span>
          </Button>
        </div>
      </Show>
      <Show when={rejectFormOpen()}>
        <div class="flex flex-col gap-2.5">
          <Label for="reqd-reject-reason" class="!mb-0">
            {t('request_reject_reason_label', 'Reason for rejecting')}
          </Label>
          <Input
            ref={el => (reasonInput = el)}
            type="text"
            id="reqd-reject-reason"
            maxlength={200}
            placeholder={t('request_reject_placeholder', 'Optional – shown to the member')}
            value={rejectReason()}
            onInput={e => setRejectReason(e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void confirmRejectRequest();
              }
            }}
          />
          <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2.5">
            <Button variant="secondary" class={DECISION_BTN} disabled={requestBusy()} onClick={() => toggleRejectForm(false)}>
              {t('btn_cancel', 'Cancel')}
            </Button>
            <Button variant="danger-solid" class={`${DECISION_BTN} hover:brightness-106`} disabled={requestBusy()} onClick={() => void confirmRejectRequest()}>
              {t('request_btn_reject_confirm', 'Reject request')}
            </Button>
          </div>
        </div>
      </Show>
    </div>
  );
}

export function RequestDetailDialog() {
  // The request as it is now (live updates); one that vanished meanwhile stays as it was last seen
  const req = createMemo<FinanceRequest | undefined>(prev => {
    const id = openRequestId();
    return requests().find(r => r.id === id) ?? (prev?.id === id ? prev : undefined);
  });
  return (
    <Modal
      id="request-detail-modal"
      maxWidth="460px"
      title={req() ? requestTypeLabel(req()!) : t('user_request_modal_title', 'Request')}
      subtitle={req() ? (ownView(req()!) ? requestStateLabel(req()!) : requestPersonName(req()!)) : undefined}
      icon={<Icon name={req() ? requestIcon(req()!) : 'file'} size={20} strokeWidth={2.2} />}
      iconClass={badgeClass(req())}
    >
      <Show when={req()}>
        {shown => (
          <>
            <RequestBody req={shown()} />
            <Decision req={shown()} />
          </>
        )}
      </Show>
    </Modal>
  );
}
