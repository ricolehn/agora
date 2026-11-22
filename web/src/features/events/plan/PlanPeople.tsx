// The people of a plan entry: small pictures with first names (rows), a person with the state of the request (chips)
// and the answer to an own request right in the row.
import { For, Show } from 'solid-js';
import { t } from '../../../app/i18n';
import { isCurrentUser } from '../../../app/session';
import { Avatar } from '../../../ui/Avatar';
import { Button } from '../../../ui/Button';
import { Icon } from '../../../ui/Icon';
import { appEvents, hasDutyAssignee, respondToDutyRequest } from '../store';
import type { Duty } from './program';

const asked = (d: Duty) => d.status === 'requested' || d.status === 'declined';

/** Who stands for a duty: the group, "You", or the person asked / assigned. */
function dutyPerson(d: Duty) {
  const group: string | false = d.status === 'assigned' && (d.assignedGroupName || d.assignedGroup);
  const uid: string | undefined = asked(d) ? d.requestedUser : d.assignedUser;
  const name: string = group
    ? group
    : isCurrentUser(uid) ? t('duty_you', 'You') : (asked(d) ? d.requestedUserName : d.assignedUserName) || t('details_person', 'Person');
  const state = d.status === 'requested' ? t('duty_state_requested', 'requested') : d.status === 'declined' ? t('duty_state_declined', 'declined') : '';
  return { group: !!group, uid, name, state };
}

/** The group symbol in the colour of the roster (indigo). */
export function GroupBadge(props: { class?: string; size?: number }) {
  return (
    <span class={['inline-flex shrink-0 items-center justify-center rounded-full bg-[rgba(99,102,241,0.12)] text-[#6366f1]', props.class ?? 'size-5']}>
      <Icon name="users" size={props.size ?? 11} strokeWidth={2.5} />
    </span>
  );
}

/** A person with the state of their request ("requested" / "declined"): the chips of the entry dialog. */
export function PlanPerson(props: { duty: Duty }) {
  const person = () => dutyPerson(props.duty);
  return (
    <span class="inline-flex min-w-0 items-center gap-1.5">
      <Show when={!person().group} fallback={<GroupBadge />}>
        <Avatar uid={person().uid} name={person().name} size={20} initialsClass="text-[0.55rem]" />
      </Show>
      <span class={['truncate', { 'text-text-secondary line-through': props.duty.status === 'declined' }]}>{person().name}</span>
      <Show when={person().state}>
        <em class={['text-[0.74rem] font-bold not-italic', props.duty.status === 'declined' ? 'text-danger' : 'text-[#d97706]']}>{person().state}</em>
      </Show>
    </span>
  );
}

/** The people of a row, right under its title: small picture, first name and "requested" / "declined", or "open". */
export function PlanNames(props: { duties: Duty[] }) {
  const people = () => props.duties.filter(hasDutyAssignee);
  // More than three: the first two and "+n"
  const shown = () => (people().length > 3 ? people().slice(0, 2) : people());
  return (
    <Show when={people().length} fallback={<span class="text-[0.8rem] text-text-secondary opacity-80">{t('plan_open_short', 'open')}</span>}>
      <For each={shown()} keyed={d => d.id}>
        {d => {
          const person = () => dutyPerson(d());
          const declined = () => d().status === 'declined';
          return (
            <span
              class="inline-flex items-center gap-[5px] whitespace-nowrap text-[0.82rem] font-semibold"
              title={person().state ? `${person().name} · ${person().state}` : person().name}
            >
              <Show when={!person().group} fallback={<GroupBadge class="size-[18px]" />}>
                <Avatar uid={person().uid} name={person().name} size={18} initialsClass="text-[0.55rem]" />
              </Show>
              <span class={{ 'text-text-secondary line-through': declined() }}>{person().group ? person().name : person().name.split(/\s+/)[0]}</span>
              <Show when={person().state}>
                <em class={['text-[0.74rem] font-bold not-italic', declined() ? 'text-danger' : 'text-[#d97706]']}>{person().state}</em>
              </Show>
            </span>
          );
        }}
      </For>
      <Show when={people().length > 3}>
        <span class="inline-flex items-center whitespace-nowrap text-[0.82rem] font-semibold text-text-secondary">+{people().length - 2}</span>
      </Show>
    </Show>
  );
}

/** A request to the viewer: the answer stays right in the row. onAnswered: once the answer is saved. */
export function PlanAnswer(props: { duties: Duty[]; onAnswered?: () => void }) {
  const mine = () => props.duties.find(d => d.status === 'requested' && isCurrentUser(d.requestedUser));
  const answer = async (e: MouseEvent, dutyId: string, action: 'accept' | 'decline') => {
    e.stopPropagation();
    await respondToDutyRequest(dutyId, action);
    // Saved: the reloaded events no longer ask (a failed answer leaves the request open)
    const duty = appEvents()
      .flatMap(ev => ev.duties || [])
      .find((d: Duty) => d.id === dutyId);
    if (duty?.status !== 'requested') props.onAnswered?.();
  };
  return (
    <Show when={mine()}>
      {duty => (
        <span class="mt-1 flex flex-col items-start gap-1.5 text-[0.8rem] font-bold text-[#b45309] dark:text-[#fbbf24]">
          <span>{t('duty_you_were_requested', 'You have been requested')}</span>
          <span class="flex flex-wrap gap-1.5">
            <Button size="tiny" onClick={e => void answer(e, duty().id, 'accept')}>
              <Icon name="check" size={13} strokeWidth={2.5} />
              <span>{t('duty_btn_accept', 'Accept')}</span>
            </Button>
            <Button size="tiny" variant="secondary" onClick={e => void answer(e, duty().id, 'decline')}>
              {t('request_btn_reject', 'Reject')}
            </Button>
          </span>
        </span>
      )}
    </Show>
  );
}

/** The people chosen in the entry dialog (not asked yet): picture or group symbol and the name. */
export function ChosenPerson(props: { uid?: string; group?: boolean; label: string }) {
  return (
    <span class="inline-flex min-w-0 items-center gap-1.5">
      <Show when={!props.group} fallback={<GroupBadge />}>
        <Avatar uid={props.uid} name={props.label} size={20} initialsClass="text-[0.55rem]" />
      </Show>
      <span class="truncate">{props.label}</span>
    </span>
  );
}
