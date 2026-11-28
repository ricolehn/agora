// "Find mentors": the approved mentors as cards - contact one anonymously, go to the own conversation with them,
// or edit the own profile. Managers also see fully booked mentors and everyone's capacity.
import { Errored, For, Loading, Match, Show, Switch } from 'solid-js';
import { errorStatus } from '../../app/api';
import { t } from '../../app/i18n';
import { canManageMentoring } from '../../app/session';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import {
  isOwnMentorCard, mentorCapacity, mentorsList, openChatDirect, openMentorApplicationModal, openMentorContactModal, threadWithMentor,
  visibleMentors, type Mentor
} from './store';

export function MentorsGrid() {
  return (
    <div id="mentors-grid" class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-[18px] max-md:grid-cols-[minmax(0,1fr)]">
      {/* A refused request and no connection read differently; the next visit of "Find mentors" asks again */}
      <Errored
        fallback={err =>
          errorStatus(err()) ? (
            <div class="col-span-full p-[30px] text-center text-text-secondary">{t('mentoring_load_error', 'Mentors could not be loaded.')}</div>
          ) : (
            <div class="col-span-full p-[30px] text-center text-danger">{t('mentoring_network_error', 'Network error while loading mentors.')}</div>
          )
        }
      >
        <Loading>
          <Show
            when={visibleMentors(mentorsList()).length}
            fallback={
              <div class="col-span-full px-5 py-10 text-center text-text-secondary">
                <div class="mb-2.5 text-[2.5rem]">👥</div>
                <div class="mb-1.5 text-[1.1rem] font-semibold">{t('mentoring_no_mentors_title', 'No mentors currently available')}</div>
                <div class="text-[0.9rem]">
                  {canManageMentoring()
                    ? t('mentoring_no_mentors_desc_manager', 'Once applications are approved, mentors will appear here.')
                    : t('mentoring_no_mentors_desc_user', 'All mentors are currently fully booked or no approved profiles are available.')}
                </div>
              </div>
            }
          >
            <For each={visibleMentors(mentorsList())} keyed={mentor => mentor.id}>
              {mentor => <MentorCard mentor={mentor()} />}
            </For>
          </Show>
        </Loading>
      </Errored>
    </div>
  );
}

function MentorCard(props: { mentor: Mentor }) {
  const name = () => props.mentor.name || props.mentor.mentorName || t('mentoring_partner_mentor', 'Mentor');
  const capacity = () => mentorCapacity(props.mentor);
  return (
    <div class="flex min-w-0 flex-col gap-3.5 rounded-[18px] border border-border-light bg-surface p-5 shadow-card transition-[transform,translate,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-card-lg">
      <div class="flex min-w-0 items-center gap-3">
        <Avatar ring="mentor" size={46} uid={props.mentor.user_id} src={props.mentor.avatar_url || null} name={name()} initialsClass="text-[0.88rem]" />
        <div class="flex min-w-0 flex-col gap-0.5">
          <h3 class="m-0 text-[1.05rem] font-bold text-text [overflow-wrap:anywhere]">{name()}</h3>
          <span class="text-[0.74rem] font-bold text-primary-dark dark:text-primary">{t('mentoring_verified_badge', 'Verified Mentor')}</span>
        </div>
      </div>
      <div class="grow whitespace-pre-wrap rounded-xl border border-border-light bg-surface-alt px-3.5 py-3 text-[0.88rem] leading-normal text-text [overflow-wrap:anywhere] [word-break:break-word]">
        {props.mentor.bio || t('mentoring_no_bio', 'No description provided.')}
      </div>
      <div class="flex items-center justify-between gap-2.5 pt-1 max-md:flex-wrap">
        <Show when={canManageMentoring() || isOwnMentorCard(props.mentor)}>
          <div class="flex items-center gap-1 whitespace-nowrap text-[0.8rem] font-semibold text-text-secondary" title={t('mentoring_capacity_title', 'Capacity: mentoring relationships')}>
            <span>{t('mentoring_capacity_active', '👥 {active} / {max} active', { active: capacity().active, max: capacity().max })}</span>
            <Show when={capacity().isFull}>
              <span class="ml-1.5 inline-flex items-center rounded-md bg-[rgba(239,68,68,0.15)] px-[7px] py-0.5 text-[0.72rem] font-bold text-[#ef4444]">
                {t('mentoring_badge_full', 'Fully booked')}
              </span>
            </Show>
          </div>
        </Show>
        <CardAction mentor={props.mentor} name={name()} isFull={capacity().isFull} />
      </div>
    </div>
  );
}

// On phones the footer wraps and its button takes the free width
const FOOTER_BUTTON = 'ml-auto max-md:max-w-full max-md:flex-[1_1_auto] max-md:whitespace-normal';

function CardAction(props: { mentor: Mentor; name: string; isFull: boolean }) {
  const mentorUserId = () => props.mentor.user || props.mentor.user_id || props.mentor.id;
  return (
    <Switch
      fallback={
        <Button size="small" class={`${FOOTER_BUTTON} max-md:h-[38px] max-md:w-full`} disabled={props.isFull} onClick={() => openMentorContactModal(mentorUserId(), props.name)}>
          {props.isFull ? t('mentoring_btn_full', 'Fully booked') : t('mentoring_btn_contact', 'Contact anonymously')}
        </Button>
      }
    >
      <Match when={isOwnMentorCard(props.mentor)}>
        <Button variant="secondary" size="small" class={FOOTER_BUTTON} onClick={() => openMentorApplicationModal()}>
          {t('mentoring_btn_edit_profile', 'Edit Profile')}
        </Button>
      </Match>
      <Match when={threadWithMentor(props.mentor)}>
        {thread => (
          <Button
            variant="secondary"
            size="small"
            class={FOOTER_BUTTON}
            title={thread().status === 'closed' ? t('mentoring_btn_open_closed_chat_title', 'Show closed conversation') : t('mentoring_btn_open_chat_title', 'Open ongoing conversation')}
            onClick={() => void openChatDirect(thread().id, 'find')}
          >
            {thread().status === 'closed' ? t('mentoring_btn_open_closed_chat', '📁 Go to chat') : t('mentoring_btn_open_chat', '💬 Go to chat')}
          </Button>
        )}
      </Match>
    </Switch>
  );
}
