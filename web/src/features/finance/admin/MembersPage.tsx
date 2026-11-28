// The fee list: accounts without a finance record to assign, then the paying members - overdue on the left (above on
// phones), up to date on the right - searchable by name. A member's card opens to the fee state, the standing orders,
// the actions of the treasury and the history.
import { For, Show, createMemo, createSignal } from 'solid-js';
import { db, ref, update } from '../../../app/api';
import { dataLoaded, findPerson, people, replacePersonInMemory, users, type Person } from '../../../app/data';
import { euro, formatDateFast, getStatusLabels, t, translateStatusText, type MemberStatus } from '../../../app/i18n';
import { canManageFinances } from '../../../app/session';
import { attempt, showToast } from '../../../app/toast';
import { safeList } from '../../../app/util';
import { Avatar } from '../../../ui/Avatar';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { SearchInput } from '../../../ui/feedback';
import { Select } from '../../../ui/form';
import { Icon, type IconName } from '../../../ui/Icon';
import { openChangeStatusModal, openEndStandingOrderModal, openPaymentModal, sendStatusEmail } from '../member/api';
import {
  BoldParam, FeeChip, FeeChips, PAY_ACCENT, PayStateIcon, ROW_FACTS, Row, RowButton, Rows, StatePill, TILE_SYMBOL, TINTED_TILE, currentStatusOf,
  paidUntilText, payStateOf, standingOrderCovers, statusMetaOf, type PayState
} from '../common';
import { Timeline } from '../Timeline';
import { openPersonId, peopleSearch, peopleTerm, setOpenPersonId, setPeopleSearch } from './state';
import { onActivateKey } from '../../../ui/keys';
import type { StandingOrder, User } from '../../../app/types';

/** Members without a fee (an account that does not pay, deleted ones) are not in the fee list. */
const isPayingPerson = (p: Person) => !(p.isDeleted || p.data?.isDeleted || p.pays === false || p.data?.pays === false);

// The date in the list in the colour of the state
const PAY_PILL: Record<PayState, string> = {
  ok: 'bg-[color-mix(in_srgb,var(--success)_14%,var(--surface))] text-[color-mix(in_srgb,var(--success)_85%,var(--text))]',
  soon: 'bg-[color-mix(in_srgb,var(--warning)_18%,var(--surface))] text-[color-mix(in_srgb,var(--warning)_80%,var(--text))]',
  overdue: 'bg-[color-mix(in_srgb,var(--danger)_14%,var(--surface))] text-danger'
};
const statusLabel = (status: string) => getStatusLabels(false)[status as MemberStatus] || status;

const SECTION_LABEL =
  "flex items-center gap-2 text-75 font-bold tracking-[0.1em] text-text-secondary uppercase after:h-px after:flex-1 after:bg-border after:opacity-50 after:content-['']";

// --- The opened member ---
function MemberHero(props: { person: Person }) {
  const meta = () => statusMetaOf(props.person);
  const state = () => payStateOf(props.person);
  return (
    <div
      class={[
        'mb-3 rounded-[20px] border p-4',
        'border-[color-mix(in_srgb,var(--hero-accent)_24%,transparent)] [background:radial-gradient(120%_140%_at_100%_0%,color-mix(in_srgb,var(--hero-accent)_13%,transparent)_0%,transparent_60%),var(--surface)]',
        'dark:border-[color-mix(in_srgb,var(--hero-accent)_18%,transparent)] dark:[background:radial-gradient(120%_140%_at_100%_0%,color-mix(in_srgb,var(--hero-accent)_8%,transparent)_0%,transparent_60%),var(--surface)]'
      ]}
      style={{ '--hero-accent': PAY_ACCENT[state()] }}
    >
      <div class="mb-3 flex items-center gap-3">
        <span
          class="inline-flex size-[42px] shrink-0 items-center justify-center rounded-full bg-[var(--hero-accent)] text-white dark:bg-[color-mix(in_srgb,var(--hero-accent)_85%,var(--surface))] dark:text-bg"
          aria-hidden="true"
        >
          <PayStateIcon state={state()} size={20} />
        </span>
        <div class="min-w-0">
          <div class="text-110 leading-[1.2] font-bold tracking-[-0.02em] text-[var(--hero-accent)]">{translateStatusText(meta().text)}</div>
          <div class="text-85 text-text-secondary">
            {t('paid_until', 'Paid until')} <strong class="font-[650] text-text">{paidUntilText(props.person._paidUntil)}</strong>
          </div>
        </div>
      </div>
      <Show when={meta().isOverdue}>
        <div class="mb-3 flex items-center justify-between gap-2.5 rounded-[14px] bg-[color-mix(in_srgb,var(--danger)_9%,var(--surface))] px-3.5 py-2.5 text-85 font-semibold text-danger">
          <span>{t('overdue_amount_label', 'Outstanding Amount')}</span>
          <strong class="text-115 font-[750] tracking-[-0.02em] tabular-nums">{euro(props.person._overdueAmount || 0)}</strong>
        </div>
      </Show>
      {/* Status and fee as of today (a change dated ahead shows in the history) */}
      <FeeChips person={props.person} status={<FeeChip>{statusLabel(currentStatusOf(props.person))}</FeeChip>} />
    </div>
  );
}

function StandingOrders(props: { person: Person }) {
  const orders = () => safeList<StandingOrder>(props.person.standingOrders);
  return (
    <Show when={orders().length}>
      <div class="mb-3.5">
        <div class={[SECTION_LABEL, 'mb-2.5']}>{t('modal_standing_order', 'Standing Order')}</div>
        <Rows>
          <For each={orders()}>
            {so => {
              const ended = () => !!so.endDate && new Date(so.endDate) < new Date();
              const facts = () => {
                const note = so.note?.trim();
                return [
                  t('so_chip_start', 'Start: {date}', { date: formatDateFast(so.startDate) }),
                  so.endDate ? t('so_chip_end', 'End: {date}', { date: formatDateFast(so.endDate) }) : '',
                  note && note !== 'Ohne Notiz' && note !== 'No note' ? note : ''
                ]
                  .filter(Boolean)
                  .join(' · ');
              };
              return (
                <Row ended={ended()} class="pl-3.5">
                  <span
                    class="inline-flex size-[34px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--brand)_12%,var(--surface))] text-primary"
                    aria-hidden="true"
                  >
                    <Icon name="rotate" size={16} strokeWidth={2.2} />
                  </span>
                  <div class="min-w-0 flex-auto">
                    <div class="text-92 text-text-secondary">
                      <BoldParam text={t('user_fee_per_month', '{amount} a month')} name="amount" value={euro(so.amount)} class="font-bold text-text" />
                    </div>
                    <div class={[ROW_FACTS, 'line-clamp-2']}>{facts()}</div>
                  </div>
                  <StatePill look={ended() ? 'ended' : 'active'}>{ended() ? t('status_ended', 'Ended') : t('status_active', 'Active')}</StatePill>
                  <Show when={canManageFinances()}>
                    <RowButton
                      icon={<Icon name="edit" size={15} />}
                      label={t('edit_end_title', 'Edit/End')}
                      onClick={() => openEndStandingOrderModal(props.person.id, so.id)}
                    />
                  </Show>
                </Row>
              );
            }}
          </For>
        </Rows>
      </div>
    </Show>
  );
}

// Actions like the member finance page: a tinted tile, a round symbol, a short title
function MemberAction(props: { icon: IconName; color: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class={[TINTED_TILE, 'flex w-full min-w-0 cursor-pointer items-center justify-center gap-[7px] rounded-[14px] px-2 py-[9px] text-center']}
      style={{ '--req-color': props.color }}
      onClick={() => props.onClick()}
    >
      <span class={[TILE_SYMBOL, 'size-7 max-[380px]:hidden dark:bg-[color-mix(in_srgb,var(--req-color)_20%,var(--surface))]']}>
        <Icon name={props.icon} size={15} />
      </span>
      <span class="flex min-w-0 flex-1 basis-0 flex-col items-center gap-0.5">
        <span class="text-left text-80 leading-[1.15] font-[650] tracking-[-0.01em] text-text">{props.label}</span>
      </span>
    </button>
  );
}

function PersonDetails(props: { person: Person }) {
  const id = () => props.person.id;
  return (
    <div class="p-3.5">
      <MemberHero person={props.person} />
      <StandingOrders person={props.person} />
      <Show when={canManageFinances()}>
        <div class="mb-3.5 grid grid-cols-3 gap-2">
          <MemberAction icon="coin" color="#10b981" label={t('record_payment_btn', 'Book Payment')} onClick={() => openPaymentModal(id())} />
          <MemberAction icon="refresh" color="#6366f1" label={t('status_btn', 'Status')} onClick={() => openChangeStatusModal(id())} />
          <MemberAction icon="mail" color="#0891b2" label={t('email_btn', 'Email')} onClick={() => void sendStatusEmail(id())} />
        </div>
      </Show>
      <div class={[SECTION_LABEL, 'mt-[25px] mb-2.5']}>{t('history_label', 'History')}</div>
      <Timeline person={props.person} />
    </div>
  );
}

// --- A member in the list ---
function PersonCard(props: { person: Person }) {
  const open = () => openPersonId() === props.person.id;
  // The details are drawn the first time the card opens (most cards are never opened)
  const drawn = createMemo<boolean>(prev => !!prev || open());
  const meta = () => statusMetaOf(props.person);
  const covered = () => standingOrderCovers(meta());
  const toggle = () => setOpenPersonId(open() ? null : props.person.id);
  return (
    <div
      class={[
        'mb-2.5 transition-[transform,opacity,box-shadow,background-color,border-color,color] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)]',
        { 'overflow-hidden rounded-[18px] border border-hairline bg-surface shadow-card-md': open() }
      ]}
    >
      <div
        class={[
          'relative z-[2] cursor-pointer bg-surface px-3.5 py-3 transition-[transform,opacity,box-shadow,background-color,border-color,color] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] focus:outline-none active:scale-[0.97]',
          open() ? 'rounded-t-[18px] border-b border-border-light' : 'rounded-[18px] border border-hairline shadow-card'
        ]}
        role="button"
        tabindex="0"
        aria-expanded={open() ? 'true' : 'false'}
        onClick={toggle}
        onKeyDown={e => onActivateKey(e, () => toggle())}
      >
        <div class="flex w-full items-center justify-start gap-3">
          <Avatar uid={props.person.uid || props.person.data?.uid} name={props.person.name} size={42} initialsClass="text-82" />
          <div class="flex min-w-0 flex-auto flex-col gap-0.5">
            <div class="line-clamp-2 text-100 leading-[1.25] font-[650] tracking-[-0.01em] [overflow-wrap:anywhere] text-text">{props.person.name}</div>
            <span class="text-80 font-medium text-text-secondary">{statusLabel(currentStatusOf(props.person))}</span>
          </div>
          <div class="flex max-w-[34%] min-w-0 flex-none flex-col items-end gap-[3px]">
            <Show when={!covered()}>
              <span class={['inline-block rounded-[99px] px-2.5 py-[3px] text-75 font-[650] whitespace-nowrap', PAY_PILL[payStateOf(props.person)]]}>
                {paidUntilText(props.person._paidUntil)}
              </span>
            </Show>
            {/* Phones: the coloured date already tells the state, so its repeat in words gives way to the name */}
            <span
              class={[
                'max-w-full overflow-hidden text-right text-75 leading-[1.25] font-medium text-ellipsis text-text-secondary',
                { 'max-mini:hidden': !covered() }
              ]}
            >
              {translateStatusText(meta().text)}
            </span>
          </div>
          <span
            class={[
              'inline-block shrink-0 text-125 leading-none transition-transform duration-300 ease-[ease]',
              open() ? 'rotate-90 text-primary opacity-100' : 'text-text-secondary opacity-55'
            ]}
            aria-hidden="true"
          >
            ›
          </span>
        </div>
      </div>
      <div
        class={[
          'relative z-[1] grid transition-[grid-template-rows,opacity] duration-[400ms,300ms] ease-[cubic-bezier(0.25,1,0.5,1),ease]',
          open() ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        ]}
        inert={!open()}
      >
        <div class="min-h-0 overflow-hidden">
          <Show when={drawn()}>
            <PersonDetails person={props.person} />
          </Show>
        </div>
      </div>
    </div>
  );
}

function PeopleColumn(props: { people: Person[]; title: string; color: string }) {
  return (
    <div>
      <Show when={props.people.length}>
        <h3
          class="mx-0.5 mt-3.5 mb-2.5 flex items-center gap-2 text-75 font-bold tracking-[0.1em] uppercase after:h-px after:flex-1 after:bg-hairline after:content-['']"
          style={{ color: props.color }}
        >
          {props.title} (<span>{props.people.length}</span>)
        </h3>
      </Show>
      <For each={props.people} keyed={p => p.id}>
        {person => <PersonCard person={person()} />}
      </For>
    </div>
  );
}

// --- Accounts without a finance record: the treasury assigns them to a member ---
async function assignUserToPerson(uid: string, personId: string) {
  if (!personId) return showToast(t('unlinked_alert_select_person', 'Please select a person.'), 'error');
  const person = findPerson(personId);
  if (!person) return showToast(t('toast_person_not_found', 'Person not found.'), 'error');
  await attempt(async () => {
    await update(ref(db, 'people/' + personId), { uid });
    replacePersonInMemory({ ...person, uid });
    showToast(t('toast_assignment_saved', 'Assignment saved'));
  }, t('unlinked_alert_failed', 'Assignment failed. Please try again.'));
}

function UnlinkedUser(props: { user: User; options: Person[] }) {
  const [choice, setChoice] = createSignal('');
  return (
    <div class="mb-2.5 flex flex-wrap items-center gap-2.5">
      <div class="min-w-[200px] flex-1">
        <div class="font-bold">
          {props.user.firstName || '?'} {props.user.lastName || ''}
        </div>
        <div class="text-85 text-text-secondary">{props.user.email || ''}</div>
      </div>
      <Select id={`link-select-${props.user.uid}`} class="min-w-[220px] flex-1" value={choice()} onChange={e => setChoice(e.currentTarget.value)}>
        <option value="">{t('unlinked_select_person', 'Select Person')}</option>
        <For each={props.options}>{p => <option value={String(p.id)}>{p.name}</option>}</For>
      </Select>
      <Button size="small" class="w-auto" onClick={() => void assignUserToPerson(props.user.uid, choice())}>
        {t('unlinked_assign_btn', 'Assign')}
      </Button>
    </div>
  );
}

function UnlinkedUsers() {
  const unlinked = createMemo(() => {
    const linked = new Set(people().filter(p => p.uid).map(p => p.uid));
    return users().filter(u => !linked.has(u.uid));
  });
  const options = createMemo(() => people().filter(p => !p.uid));
  return (
    <Show when={unlinked().length && canManageFinances()}>
      <Card title={t('unlinked_title', '🧩 Unlinked Users ({count})', { count: unlinked().length })}>
        <For each={unlinked()}>{user => <UnlinkedUser user={user} options={options()} />}</For>
      </Card>
    </Show>
  );
}

export function MembersPage() {
  const paying = createMemo(() => people().filter(isPayingPerson));
  const byName = (a: Person, b: Person) => String(a.name || '').localeCompare(String(b.name || ''));
  const matches = (p: Person) => String(p.name || '').toLowerCase().includes(peopleTerm());
  // Search: the counts in the headings follow what is shown, an empty group hides, and nothing found says so
  const overdue = createMemo(() => paying().filter(p => statusMetaOf(p).isOverdue && matches(p)).sort(byName));
  const current = createMemo(() => paying().filter(p => !statusMetaOf(p).isOverdue && matches(p)).sort(byName));
  return (
    <div>
      <div class="mb-5 flex items-center justify-between">
        <h2 class="text-120 font-extrabold">{t('nav_people', 'Members')}</h2>
      </div>
      <SearchInput
        id="people-search"
        class="mb-[15px]"
        value={peopleSearch()}
        onInput={setPeopleSearch}
        placeholder={t('search_placeholder', 'Search...')}
      />
      <UnlinkedUsers />
      <Show when={paying().length}>
        <div id="peopleList" class="flex flex-col gap-5 md:grid md:grid-cols-2 md:items-start md:gap-[30px]">
          <PeopleColumn people={overdue()} title={t('overdue_header', 'Overdue')} color="var(--danger)" />
          <PeopleColumn people={current()} title={t('current_members_header', 'Current Members')} color="var(--success)" />
        </div>
        <Show when={peopleTerm() && !overdue().length && !current().length}>
          <p class="my-2 px-3 py-6 text-center text-90 text-text-secondary">{t('people_no_match', 'No member matches your search.')}</p>
        </Show>
      </Show>
      <Show when={dataLoaded() && !paying().length}>
        <div class="p-10 text-center text-text-secondary">
          <div class="mb-2.5 text-[3rem]">👥</div>
          <p>{t('no_members_yet', 'No members yet.')}</p>
        </div>
      </Show>
    </div>
  );
}
