// Open duty requests for me ("inbox"): on the events tab, and on the start page (onHome: a tap on the request opens
// its event).
import { For } from 'solid-js';
import { t } from '../../app/i18n';
import { Button } from '../../ui/Button';
import { formatEventDate } from './format';
import { openEventDetailModal, respondToDutyRequest } from './store';
import { onActivateKey } from '../../ui/keys';
import type { DutyRequest } from './types';

const atTime = (time: string | undefined) => (time ? ` ${t('duty_requests_at_time', 'at {time}', { time })}` : '');
const inSection = (section: string | undefined) => (section ? `${t('duty_requests_section', 'Area: {section}', { section })} • ` : '');

function DutyRequestCard(props: { request: DutyRequest; onHome?: boolean }) {
  const req = () => props.request;
  const open = () => void openEventDetailModal(req().eventId);
  const respond = (e: MouseEvent, action: 'accept' | 'decline') => {
    if (props.onHome) e.stopPropagation();
    void respondToDutyRequest(req().id, action);
  };
  return (
    <div
      id={`${props.onHome ? 'home-' : ''}duty-request-${req().id}`}
      class="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border-light bg-surface px-3 py-2.5"
    >
      <div
        class={['flex flex-col gap-0.5', { 'cursor-pointer': !!props.onHome }]}
        role={props.onHome ? 'button' : undefined}
        tabindex={props.onHome ? '0' : undefined}
        title={props.onHome ? t('duty_requests_show_details', 'Show appointment details') : undefined}
        onClick={() => props.onHome && open()}
        onKeyDown={e => onActivateKey(e, () => props.onHome && open())}
      >
        <div class="text-88 font-bold text-text">📅 {req().eventTitle || t('detail_groups_event', 'Event')}</div>
        <div class="text-78 text-text-secondary">
          <span>
            {formatEventDate(req().eventDate)}
            {atTime(req().eventStartTime)}
          </span>
        </div>
        <div class="mt-0.5 text-85 text-text">
          🛠️ <strong class="font-bold">{req().roleName}</strong>{' '}
          <span class="text-80 text-text-secondary">
            ({inSection(req().section)}
            {t('duty_requests_requested_by', 'Requested by {name}', { name: req().requestedByName || t('duty_requests_team', 'Team') })})
          </span>
        </div>
      </div>
      <div class="ml-auto flex items-center gap-1.5">
        <Button variant="primary" size="small" onClick={e => respond(e, 'accept')}>
          ✅ {t('duty_btn_accept', 'Accept')}
        </Button>
        <Button variant="danger" size="small" onClick={e => respond(e, 'decline')}>
          ❌ {t('request_btn_reject', 'Reject')}
        </Button>
      </div>
    </div>
  );
}

/** The banner with my open duty requests (the caller shows it only when there are any). */
export function DutyRequestsBanner(props: { requests: DutyRequest[]; onHome?: boolean }) {
  return (
    <div class="rounded-[14px] border border-[rgba(99,102,241,0.25)] bg-[linear-gradient(135deg,rgba(99,102,241,0.08)_0%,rgba(245,158,11,0.08)_100%)] px-4 py-3.5 shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
      <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="text-115">📬</span>
          <strong class="text-95 font-bold text-text">{t('duty_requests_title', 'Open duty requests for you ({count})', { count: props.requests.length })}</strong>
        </div>
        <span class="rounded-full bg-[#b45309] px-2 py-[3px] text-72 font-bold uppercase tracking-[0.4px] text-white">
          {t('duty_requests_badge', 'Response requested')}
        </span>
      </div>
      <div class="flex flex-col gap-2">
        <For each={props.requests} keyed={request => request.id}>
          {request => <DutyRequestCard request={request()} onHome={props.onHome} />}
        </For>
      </div>
    </div>
  );
}
