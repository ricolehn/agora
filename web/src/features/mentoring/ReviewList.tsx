// Review of the mentor applications (mentoring managers): filter by status, approve or reject.
import { Errored, For, Loading, Show, isPending } from 'solid-js';
import { t, uiLocale } from '../../app/i18n';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Icon } from '../../ui/Icon';
import { Select } from '../../ui/form';
import { refreshReview, reviewFilter, reviewList, setMentorStatus, setReviewFilter, type Mentor, type ReviewFilter } from './store';

// Tint, text key and English text of each status
const STATUS_STYLES: Record<string, [string, string, string]> = {
  pending: ['bg-[rgba(234,179,8,0.15)] text-[#eab308]', 'mentoring_filter_pending', 'Pending'],
  approved: ['bg-[rgba(16,185,129,0.15)] text-[#10b981]', 'mentoring_filter_approved', 'Approved'],
  rejected: ['bg-[rgba(239,68,68,0.15)] text-[#ef4444]', 'mentoring_filter_rejected', 'Rejected']
};

export function ReviewList() {
  const loadingText = () => <div class="p-5 text-center text-text-secondary">{t('mentoring_review_loading', 'Loading applications...')}</div>;
  return (
    <Card class="rounded-[18px] border-border-light" bodyClass="p-0">
      <div class="flex flex-wrap items-center justify-between gap-2.5 px-5 py-[18px]">
        <div class="flex items-center gap-2 text-[1.05rem] font-bold">
          <Icon name="shield" size={20} />
          <span>{t('mentoring_review_title', 'Review Mentor Applications')}</span>
        </div>
        <div class="flex items-center gap-2">
          <Select
            id="mentor-review-filter"
            class="w-auto px-3 py-[5px] text-[0.85rem]"
            value={reviewFilter()}
            onChange={e => setReviewFilter(e.currentTarget.value as ReviewFilter)}
          >
            <option value="pending">{t('mentoring_filter_pending', 'Pending')}</option>
            <option value="approved">{t('mentoring_filter_approved', 'Approved')}</option>
            <option value="rejected">{t('mentoring_filter_rejected', 'Rejected')}</option>
            <option value="all">{t('mentoring_filter_all', 'All')}</option>
          </Select>
          <Button variant="secondary" size="small" onClick={() => void refreshReview()}>
            {t('mentoring_btn_refresh', 'Refresh')}
          </Button>
        </div>
      </div>
      <div id="mentoring-review-list" class="p-4">
        {/* A failed load says so ("Refresh" asks again); another filter shows "Loading" until its applications are there */}
        <Errored fallback={<div class="p-5 text-center text-danger">{t('mentoring_review_load_error', 'Failed to load applications.')}</div>}>
          <Loading fallback={loadingText()}>
            <Show when={!isPending(() => reviewList())} fallback={loadingText()}>
              <Show
                when={reviewList().list.length}
                fallback={
                  <div class="p-[30px] text-center text-text-secondary">
                    {t('mentoring_review_none', 'No applications with status "{status}" found.', {
                      status: t(`mentoring_filter_${reviewList().status}`, reviewList().status)
                    })}
                  </div>
                }
              >
                <For each={reviewList().list} keyed={mentor => mentor.id}>
                  {mentor => <Application mentor={mentor()} />}
                </For>
              </Show>
            </Show>
          </Loading>
        </Errored>
      </div>
    </Card>
  );
}

function Application(props: { mentor: Mentor }) {
  const status = () => props.mentor.status || 'pending';
  const style = () => STATUS_STYLES[status()] || STATUS_STYLES.pending;
  const email = () => props.mentor.email || props.mentor.userEmail || '';
  const submitted = () =>
    props.mentor.created ? new Date(props.mentor.created).toLocaleDateString(uiLocale(), { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  return (
    <Card class="mb-3 rounded-xl border-border" bodyClass="p-4">
      <div class="mb-2.5 flex flex-wrap items-start justify-between gap-2.5">
        <div>
          <div class="flex items-center gap-2 text-[1.05rem] font-bold">
            <span>{props.mentor.name || props.mentor.mentorName || t('mentoring_applicant_fallback', 'Applicant')}</span>
            <span class={['rounded-full px-2 py-0.5 text-[0.75rem] font-bold', style()[0]]}>{t(style()[1], style()[2])}</span>
          </div>
          <div class="mt-0.5 text-[0.85rem] text-text-secondary">
            {email() ? `${email()} • ` : ''}
            {t('mentoring_review_submitted', 'Submitted: {date} • Capacity: max. {max} mentees', { date: submitted(), max: props.mentor.max_mentees || 3 })}
          </div>
        </div>
        <div class="flex gap-2">
          <Show when={status() !== 'approved'}>
            <Button size="small" onClick={() => void setMentorStatus(props.mentor.id, 'approved')}>
              {t('mentoring_btn_approve', '✓ Approve')}
            </Button>
          </Show>
          <Show when={status() !== 'rejected'}>
            <Button variant="secondary" size="small" class="text-danger" onClick={() => void setMentorStatus(props.mentor.id, 'rejected')}>
              {t('mentoring_btn_reject', '✗ Reject')}
            </Button>
          </Show>
        </div>
      </div>
      <div class="rounded-lg bg-surface-alt px-3.5 py-3 text-[0.92rem] leading-normal">
        <div class="mb-1 text-[0.8rem] font-semibold uppercase tracking-[0.5px] text-text-secondary">{t('mentoring_review_bio_label', 'About me / Self-description:')}</div>
        {props.mentor.bio || t('mentoring_no_bio', 'No description provided.')}
      </div>
    </Card>
  );
}
