import type { Component } from 'solid-js';
import { Show } from 'solid-js';
import { Dynamic } from '@solidjs/web';
import { t } from '../../app/i18n';
import { settingsPages } from '../../app/registry';
import { Icon } from '../../ui/Icon';
import { SettingsMenu } from './Menu';
import { AccountPage } from './pages/AccountPage';
import { AppearancePage } from './pages/AppearancePage';
import { NotificationsPage } from './pages/NotificationsPage';
import { PasswordPage } from './pages/PasswordPage';
import { ProfilePage } from './pages/ProfilePage';
import { PAGE_TITLE_ID, closeSettingsPage, openPage, openPageDef, type SettingsPageKey } from './state';

// The pages of this feature; fees and calendar come from their features
const OWN_PAGES: Partial<Record<SettingsPageKey, Component>> = {
  profile: ProfilePage,
  notifications: NotificationsPage,
  appearance: AppearancePage,
  password: PasswordPage,
  account: AccountPage
};
const pageComponent = (key: SettingsPageKey) => OWN_PAGES[key] ?? settingsPages.get(key);

/** Back to the menu and the page's title: they stay reachable while the page scrolls (right below the app's header
 *  while it is shown). */
function PageHead() {
  return (
    <div
      class={[
        'sticky z-[7] -mx-2 mb-3 max-w-[760px] rounded-b-2xl bg-[var(--frost-bg)] p-2 [-webkit-backdrop-filter:var(--frost)] [backdrop-filter:var(--frost)]',
        'transition-[top] duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]',
        'top-[var(--mobile-header-h,68px)] header-hidden:top-0 md:top-[calc(72px-var(--desktop-header-offset))] md:header-hidden:top-[calc(0px-var(--desktop-header-offset))]'
      ]}
    >
      <div class="flex items-center gap-3">
        <button
          type="button"
          class="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border-light bg-surface text-text"
          aria-label={t('btn_back', 'Back')}
          onClick={() => closeSettingsPage()}
        >
          <Icon name="chevronLeft" size={20} strokeWidth={2.5} />
        </button>
        <h2 id={PAGE_TITLE_ID} tabindex="-1" class="m-0 text-[1.3rem] font-extrabold text-text outline-none">
          {openPageDef()?.title()}
        </h2>
      </div>
    </div>
  );
}

/** The settings tab: the menu, or one of its pages. */
export function SettingsTab() {
  return (
    <div class="md:mx-auto md:max-w-[760px]">
      <Show when={openPage()} fallback={<SettingsMenu />}>
        {key => (
          <>
            <PageHead />
            <div class="max-w-[760px]">
              <Dynamic component={pageComponent(key())} />
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
