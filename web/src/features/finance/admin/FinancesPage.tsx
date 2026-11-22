// The finances tab of those who see the books: the overview with the history (/finances) and the fee list
// (/finances/members), switched with the pill tabs at the top.
import { Match, Switch } from 'solid-js';
import { t } from '../../../app/i18n';
import { Icon } from '../../../ui/Icon';
import { PillTabs } from '../../../ui/PillTabs';
import { HistoryPage } from './HistoryPage';
import { MembersPage } from './MembersPage';
import { subpage, switchFinanceSubpage, type FinanceSubpage } from './state';

export function FinancesPage() {
  return (
    <div>
      <PillTabs<FinanceSubpage>
        class="mb-5 md:max-w-[460px]"
        value={subpage()}
        onChange={switchFinanceSubpage}
        options={[
          { value: 'history', label: t('finances_sub_history', 'Overview'), icon: <Icon name="clock" size={15} /> },
          { value: 'members', label: t('finances_sub_members', 'Fee List'), icon: <Icon name="users" size={15} /> }
        ]}
      />
      <Switch>
        <Match when={subpage() === 'members'}>
          <MembersPage />
        </Match>
        <Match when={subpage() === 'history'}>
          <HistoryPage />
        </Match>
      </Switch>
    </div>
  );
}
