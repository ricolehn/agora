// The fee list: accounts without a finance record to assign, then the paying members - overdue on the left (above on
// phones), up to date on the right - searchable by name. A member's card opens to the fee state, the standing orders,
// the actions of the treasury and the history.
import type { JSX } from '@solidjs/web';
import { For, Show, createMemo, createSignal } from 'solid-js';
import { db, ref, update } from '../../../app/api';
import { dataLoaded, findPerson, people, replacePersonInMemory, settings, users, type Person } from '../../../app/data';
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
import { paidUntilText, standingOrderCovers } from '../common';
import { Timeline } from '../Timeline';
import { currentStatus, feeResetIsShown, isPayingPerson, personPaidUntil, statusMeta } from './people';
import { openPersonId, peopleSearch, peopleTerm, setOpenPersonId, setPeopleSearch } from './state';

/** A translation with one value set in bold ("<strong>€50.00</strong> a month"). */
function WithStrong(props: { text: string; param: string; value: JSX.Element; class?: string }) {
  const parts = () => props.text.split(`{${props.param}}`);
  return (
    <>
      {parts()[0]}
      <strong class={props.class}>{props.value}</strong>
      {parts().slice(1).join('')}
    </>
  );
}

type PayState = 'ok' | 'warn' | 'err';
const payState = (p: Person): PayState => (statusMeta(p).isOverdue ? 'err' : statusMeta(p).isSoonDue ? 'warn' : 'ok');
const PAY_PILL: Record<PayState, string> = {
  ok: 'bg-[color-mix(in_srgb,var(--success)_14%,var(--surface))] text-[color-mix(in_srgb,var(--success)_85%,var(--text))]',
  warn: 'bg-[color-mix(in_srgb,var(--warning)_18%,var(--surface))] text-[color-mix(in_srgb,var(--warning)_80%,var(--text))]',
  err: 'bg-[color-mix(in_srgb,var(--danger)_14%,var(--surface))] text-danger'
};
const HERO_ACCENT: Record<PayState, string> = { ok: 'var(--success)', warn: 'var(--warning)', err: 'var(--danger)' };
const statusLabel = (status: string) => getStatusLabels(false)[status as MemberStatus] || status;

const SECTION_LABEL =
  "flex items-center gap-2 text-[0.74rem] font-bold tracking-[0.1em] text-text-secondary uppercase after:h-px after:flex-1 after:bg-border after:opacity-50 after:content-['']";
const CHIP =
  'flex min-w-0 items-center justify-center gap-1 overflow-hidden rounded-[14px] border border-hairline bg-surface-alt px-2.5 py-[9px] text-[0.86rem] font-medium text-ellipsis whitespace-nowrap text-text-secondary';

// --- The opened member ---
function MemberHero(props: { person: Person }) {
  const meta = () => statusMeta(props.person);
  const state = () => payState(props.person);
  const status = () => currentStatus(props.person);
  return (
    <div
      class={[
        'mb-3 rounded-[20px] border p-4',
        'border-[color-mix(in_srgb,var(--hero-accent)_24%,transparent)] [background:radial-gradient(120%_140%_at_100%_0%,color-mix(in_srgb,var(--hero-accent)_13%,transparent)_0%,transparent_60%),var(--surface)]',
        'dark:border-[color-mix(in_srgb,var(--hero-accent)_18%,transparent)] dark:[background:radial-gradient(120%_140%_at_100%_0%,color-mix(in_srgb,var(--hero-accent)_8%,transparent)_0%,transparent_60%),var(--surface)]'
      ]}
      style={{ '--hero-accent': HERO_ACCENT[state()] }}
    >
      <div class="mb-3 flex items-center gap-3">
        <span
          class="inline-flex size-[42px] shrink-0 items-center justify-center rounded-full bg-[var(--hero-accent)] text-white dark:bg-[color-mix(in_srgb,var(--hero-accent)_85%,var(--surface))] dark:text-bg"
          aria-hidden="true"
        >
          <Show when={state() !== 'ok'} fallback={<Icon name="check" size={22} strokeWidth={2.8} />}>
            <Icon name={state() === 'err' ? 'alert' : 'clock'} size={20} strokeWidth={2.4} />
          </Show>
        </span>
        <div class="min-w-0">
          <div class="text-[1.12rem] leading-[1.2] font-bold tracking-[-0.02em] text-[var(--hero-accent)]">{translateStatusText(meta().text)}</div>
          <div class="text-[0.86rem] text-text-secondary">
            {t('paid_until', 'Paid until')} <strong class="font-[650] text-text">{paidUntilText(personPaidUntil(props.person))}</strong>
          </div>
        </div>
      </div>
      <Show when={meta().isOverdue}>
        <div class="mb-3 flex items-center justify-between gap-2.5 rounded-[14px] bg-[color-mix(in_srgb,var(--danger)_9%,var(--surface))] px-3.5 py-2.5 text-[0.86rem] font-semibold text-danger">
          <span>{t('overdue_amount_label', 'Outstanding Amount')}</span>
          <strong class="text-[1.15rem] font-[750] tracking-[-0.02em] tabular-nums">{euro(props.person._overdueAmount || 0)}</strong>
        </div>
      </Show>
      <div class="grid grid-cols-2 gap-2">
        <span class={CHIP}>
          <WithStrong
            text={t('user_fee_per_month', '{amount} a month')}
            param="amount"
            value={euro(props.person._monthlyFee ?? settings()[status()] ?? 0)}
            class="font-bold text-text"
          />
        </span>
        <span class={CHIP}>{statusLabel(props.person.status || '')}</span>
        <Show when={feeResetIsShown(props.person)}>
          <span class={[CHIP, 'col-span-full gap-1.5']}>
            <Icon name="rotate" size={13} strokeWidth={2.4} class="shrink-0 text-warning" />
            <span>
              <WithStrong text={t('fee_reset_chip', 'Fresh start on {date}')} param="date" value={formatDateFast(props.person._feeReset)} class="font-bold text-text" />
            </span>
          </span>
        </Show>
      </div>
    </div>
  );
}

function StandingOrders(props: { person: Person }) {
  const orders = () => safeList<any>(props.person.standingOrders);
  return (
    <Show when={orders().length}>
      <div class="mb-3.5">
        <div class={[SECTION_LABEL, 'mb-2.5']}>{t('modal_standing_order', 'Standing Order')}</div>
        <div class="overflow-hidden rounded-2xl border border-hairline bg-surface">
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
                <div class={['flex items-center gap-3 py-[11px] pr-3 pl-3.5 [&+&]:border-t [&+&]:border-hairline', { 'opacity-60': ended() }]}>
                  <span
                    class="inline-flex size-[34px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--brand)_12%,var(--surface))] text-primary"
                    aria-hidden="true"
                  >
                    <Icon name="rotate" size={16} strokeWidth={2.2} />
                  </span>
                  <div class="min-w-0 flex-auto">
                    <div class="text-[0.92rem] text-text-secondary">
                      <WithStrong text={t('user_fee_per_month', '{amount} a month')} param="amount" value={euro(so.amount)} class="font-bold text-text" />
                    </div>
                    <div class="line-clamp-2 text-[0.78rem] text-text-secondary">{facts()}</div>
                  </div>
                  <span
                    class={[
                      'shrink-0 rounded-full px-[9px] py-[3px] text-[0.72rem] font-[650]',
                      ended()
                        ? 'bg-surface-alt text-text-secondary'
                        : 'bg-[color-mix(in_srgb,var(--success)_13%,var(--surface))] text-[color-mix(in_srgb,var(--success)_85%,var(--text))]'
                    ]}
                  >
                    {ended() ? t('status_ended', 'Ended') : t('status_active', 'Active')}
                  </span>
                  <Show when={canManageFinances()}>
                    <button
                      type="button"
                      class="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-hairline bg-surface-alt text-text-secondary hover:bg-border-light hover:text-text"
                      title={t('edit_end_title', 'Edit/End')}
                      aria-label={t('edit_end_title', 'Edit/End')}
                      onClick={() => openEndStandingOrderModal(props.person.id, so.id)}
                    >
                      <Icon name="edit" size={15} />
                    </button>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
}

// Actions like the member finance page: a tinted tile, a round symbol, a short title
function MemberAction(props: { icon: IconName; color: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class={[
        'flex w-full min-w-0 cursor-pointer items-center justify-center gap-[7px] rounded-[14px] border px-2 py-[9px] text-center shadow-card transition-[transform,border-color,box-shadow] duration-150 active:scale-[0.96]',
        'border-[color-mix(in_srgb,var(--req-color)_16%,var(--border-light))] bg-[color-mix(in_srgb,var(--req-color)_5%,var(--surface))]',
        'hover:border-[color-mix(in_srgb,var(--req-color)_28%,var(--border-light))] hover:bg-[color-mix(in_srgb,var(--req-color)_9%,var(--surface))] hover:shadow-card-md',
        'dark:border-[color-mix(in_srgb,var(--req-color)_20%,var(--border-light))] dark:bg-[color-mix(in_srgb,var(--req-color)_7%,var(--surface))]'
      ]}
      style={{ '--req-color': props.color }}
      onClick={() => props.onClick()}
    >
      <span class="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--req-color)_14%,var(--surface))] text-[var(--req-color)] max-[380px]:hidden dark:bg-[color-mix(in_srgb,var(--req-color)_20%,var(--surface))]">
        <Icon name={props.icon} size={15} />
      </span>
      <span class="flex min-w-0 flex-1 basis-0 flex-col items-center gap-0.5">
        <span class="text-left text-[0.8rem] leading-[1.15] font-[650] tracking-[-0.01em] text-text">{props.label}</span>
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
  const meta = () => statusMeta(props.person);
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
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <div class="flex w-full items-center justify-start gap-3">
          <Avatar uid={props.person.uid || props.person.data?.uid} name={props.person.name} size={42} initialsClass="text-[0.82rem]" />
          <div class="flex min-w-0 flex-auto flex-col gap-0.5">
            <div class="line-clamp-2 text-[0.98rem] leading-[1.25] font-[650] tracking-[-0.01em] [overflow-wrap:anywhere] text-text">{props.person.name}</div>
            <span class="text-[0.8rem] font-medium text-text-secondary">{statusLabel(currentStatus(props.person))}</span>
          </div>
          <div class="flex max-w-[34%] min-w-0 flex-none flex-col items-end gap-[3px]">
            <Show when={!covered()}>
              <span class={['inline-block rounded-[99px] px-2.5 py-[3px] text-[0.76rem] font-[650] whitespace-nowrap', PAY_PILL[payState(props.person)]]}>
                {paidUntilText(personPaidUntil(props.person))}
              </span>
            </Show>
            {/* Phones: the coloured date already tells the state, so its repeat in words gives way to the name */}
            <span
              class={[
                'max-w-full overflow-hidden text-right text-[0.76rem] leading-[1.25] font-medium text-ellipsis text-text-secondary',
                { 'max-[480px]:hidden': !covered() }
              ]}
            >
              {translateStatusText(meta().text)}
            </span>
          </div>
          <span
            class={[
              'inline-block shrink-0 text-[1.25rem] leading-none transition-transform duration-300 ease-[ease]',
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
          class="mx-0.5 mt-3.5 mb-2.5 flex items-center gap-2 text-[0.74rem] font-bold tracking-[0.1em] uppercase after:h-px after:flex-1 after:bg-hairline after:content-['']"
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

function UnlinkedUser(props: { user: any; options: Person[] }) {
  const [choice, setChoice] = createSignal('');
  return (
    <div class="mb-2.5 flex flex-wrap items-center gap-2.5">
      <div class="min-w-[200px] flex-1">
        <div class="font-bold">
          {props.user.firstName || '?'} {props.user.lastName || ''}
        </div>
        <div class="text-[0.85rem] text-text-secondary">{props.user.email || ''}</div>
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
  const overdue = createMemo(() => paying().filter(p => statusMeta(p).isOverdue && matches(p)).sort(byName));
  const current = createMemo(() => paying().filter(p => !statusMeta(p).isOverdue && matches(p)).sort(byName));
  return (
    <div>
      <div class="mb-5 flex items-center justify-between">
        <h2 class="text-[1.2rem] font-extrabold">{t('nav_people', 'Members')}</h2>
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
          <p class="my-2 px-3 py-6 text-center text-[0.9rem] text-text-secondary">{t('people_no_match', 'No member matches your search.')}</p>
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
