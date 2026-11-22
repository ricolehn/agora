// The payment state on the start page (renderHomePaymentStatus): nothing when all is paid; a slim amber line at the
// end of the page when a payment is due soon; a clear red card with the open amount right after the greeting when a
// payment is overdue. Only for an own fee account (not for accounts without a fee).
import { Show, createMemo } from 'solid-js';
import { dataLoaded } from '../../../app/data';
import { euro, t, translateStatusText } from '../../../app/i18n';
import { switchTab } from '../../../app/router';
import { currentUser } from '../../../app/session';
import { Icon } from '../../../ui/Icon';
import { paidUntilText, standingOrderCovers } from '../common';
import { ownPerson, statusMetaOf } from './MemberFinances';

function HomePayment(props: { overdue: boolean }) {
  const state = createMemo(() => {
    if (!dataLoaded() || !currentUser() || currentUser()!.pays === false) return null;
    const person = ownPerson();
    if (!person) return null;
    const meta = statusMetaOf(person);
    if (!meta.isOverdue && !meta.isSoonDue) return null;
    return { person, meta, overdue: !!meta.isOverdue };
  });
  // Overdue comes first after the greeting, otherwise it closes the page
  const shown = () => {
    const current = state();
    return current && current.overdue === props.overdue ? current : null;
  };
  const open = () => switchTab('user-finances');
  return (
    <Show when={shown()}>
      {current => (
        <div id="user-status-card" class="mb-[30px]">
          <div
            role="button"
            tabindex="0"
            class={[
              'flex cursor-pointer items-center gap-3 rounded-[18px] text-text-secondary transition-transform duration-150 ease-[ease]',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.98]',
              current().overdue
                ? 'border-[1.5px] border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)] px-4 py-3.5'
                : 'border border-[rgba(245,158,11,0.35)] bg-surface px-3.5 py-3'
            ]}
            onClick={open}
            onKeyDown={e => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              open();
            }}
          >
            <span class={['inline-flex size-[34px] shrink-0 items-center justify-center rounded-full text-white', current().overdue ? 'bg-[#ef4444]' : 'bg-[#f59e0b]']}>
              <Icon name="alert" size={18} strokeWidth={2.5} />
            </span>
            <span class="flex min-w-0 flex-1 flex-col">
              <span class={['text-[0.95rem] font-bold', current().overdue ? 'text-[#dc2626] dark:text-[#f87171]' : 'text-text']}>
                {current().overdue
                  ? translateStatusText(current().meta.text)
                  : standingOrderCovers(current().meta)
                    ? t('user_standing_order_active', 'Standing order active')
                    : `${t('user_paid_until', 'Paid until')} ${paidUntilText(current().person._paidUntil)}`}
              </span>
              <span class={current().overdue ? 'text-[0.88rem] font-bold text-text' : 'text-[0.78rem] text-text-secondary'}>
                {current().overdue ? `${euro(current().person._overdueAmount || 0)} ${t('home_fee_open', 'open')}` : translateStatusText(current().meta.text)}
              </span>
            </span>
            <Show when={current().overdue} fallback={<Icon name="chevronRight" size={16} strokeWidth={2.5} />}>
              <span class="shrink-0 rounded-full bg-[#ef4444] px-3.5 py-[7px] text-[0.82rem] font-bold text-white">{t('home_fee_details', 'View')}</span>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

/** The start page, right after the greeting: an overdue payment. */
export const HomePaymentOverdue = () => <HomePayment overdue={true} />;
/** The start page, at the end: a payment due soon. */
export const HomePaymentDue = () => <HomePayment overdue={false} />;
