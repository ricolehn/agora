// The header: the community's logo and name, the main navigation on desktop, the profile button. On phones it sticks
// to the top of the page on frosted glass; on desktop it is a fixed bar. It slides away while scrolling down.
import { For, Show } from 'solid-js';
import { appName } from '../app/config';
import { t } from '../app/i18n';
import { NAV_ENTRIES, type NavEntry } from '../app/nav';
import { activeTab, switchTab } from '../app/router';
import { closeProfileMenu, headerHidden, headerScrolled, openProfileMenu, profileMenuOpen } from '../app/shell';
import { HUB_TABS } from '../app/tabs';
import { CountBadge } from '../ui/feedback';
import { Icon } from '../ui/Icon';
import { ProfilePicture, profileRingClass } from './ProfileMenu';

/** Whether a navigation entry is the current page (the apps inside Extras keep its entry highlighted). */
export const isActiveNav = (entry: NavEntry) => activeTab() === entry.tab || (entry.tab === 'hub' && HUB_TABS.includes(activeTab()));

function DesktopNavButton(props: { entry: NavEntry }) {
  const active = () => isActiveNav(props.entry);
  return (
    <button
      type="button"
      data-tab={props.entry.tab}
      class={[
        'nav-btn inline-flex h-10 cursor-pointer items-center gap-2 self-center rounded-full border-0 px-[14px] text-[0.95rem] whitespace-nowrap',
        '[transition:background-color_0.2s_ease,color_0.2s_ease,box-shadow_0.2s_ease,border-color_0.2s_ease,opacity_0.2s_ease,transform_0.2s_ease]',
        'focus-visible:shadow-ring focus-visible:outline-none',
        active() ? 'bg-nav-pill font-semibold text-nav-pill-text' : 'bg-transparent font-medium text-[var(--desktop-nav-text)] hover:bg-surface-alt hover:text-text'
      ]}
      aria-current={active() ? 'page' : undefined}
      onClick={() => switchTab(props.entry.tab, 'nav')}
    >
      <Icon name={props.entry.icon} size={18} class="shrink-0" />
      <span class="nav-label">{props.entry.label()}</span>
      <CountBadge count={props.entry.badge?.() ?? 0} class="ml-0.5" />
    </button>
  );
}

export function Header() {
  return (
    <header
      class={[
        'header relative z-50 flex items-center justify-between will-change-transform',
        '[transition:translate_0.28s_cubic-bezier(0.2,0.8,0.2,1),box-shadow_0.2s_ease]',
        // The glass sits on its own layer: a backdrop filter on the header itself would stop the profile button's ring
        // and anything else inside from blurring the page below
        "before:pointer-events-none before:absolute before:inset-0 before:z-[-1] before:bg-[var(--frost-bg)] before:[backdrop-filter:var(--frost)] before:content-[''] md:before:bg-[var(--frost-surface)]",
        'max-md:sticky max-md:top-0 max-md:z-[900] max-md:-mx-5 max-md:px-5 max-md:pt-[max(14px,env(safe-area-inset-top,14px))] max-md:pb-4',
        'md:fixed md:inset-x-0 md:top-0 md:z-[1100] md:h-[72px] md:w-full md:border-b md:border-hairline md:px-[var(--page-gutter)]',
        'md:shadow-[0_1px_0_rgba(48,38,26,0.02),0_8px_24px_-16px_rgba(48,38,26,0.18)]',
        {
          'header-hidden -translate-y-[110%]': headerHidden(),
          'header-scrolled max-md:shadow-[0_8px_18px_-12px_rgba(28,25,23,0.3)] dark:max-md:shadow-[0_8px_18px_-10px_rgba(0,0,0,0.7)]': headerScrolled()
        }
      ]}
    >
      <div class="flex min-w-0 items-center gap-3 max-md:h-[38px] md:h-full md:flex-1 md:gap-7 md:overflow-hidden">
        <div class="flex shrink-0 items-center gap-3 max-md:h-[38px] md:h-full">
          <img src="/assets/church-logo.svg" alt={`${appName()} Logo`} class="h-[38px] w-auto shrink-0 object-contain max-md:w-[38px]" />
          <h1 class="m-0 flex items-center bg-gradient-primary bg-clip-text text-[1.85rem] leading-none font-extrabold tracking-[-0.022em] [-webkit-text-fill-color:transparent] max-md:h-[38px]">
            {appName()}
          </h1>
        </div>
        <nav id="desktop-nav" class="hidden md:flex md:h-full md:max-w-full md:items-center md:gap-1 md:overflow-x-auto">
          <For each={NAV_ENTRIES}>
            {entry => (
              <Show when={entry.visible()}>
                <DesktopNavButton entry={entry} />
              </Show>
            )}
          </For>
        </nav>
      </div>
      <div class="flex shrink-0 items-center max-md:h-[38px] md:ml-5 md:h-full">
        <div class="relative max-md:flex max-md:h-[38px] max-md:items-center">
          <button
            type="button"
            class={[
              profileRingClass(),
              'profile-btn cursor-pointer border-0 active:scale-95 aria-expanded:invisible',
              '[transition:scale_0.3s_ease,opacity_0.3s_ease,box-shadow_0.3s_ease,background-color_0.3s_ease,border-color_0.3s_ease,color_0.3s_ease]'
            ]}
            aria-label={t('profile_menu', 'Profile menu')}
            aria-expanded={profileMenuOpen() ? 'true' : 'false'}
            aria-haspopup="true"
            onClick={e => (profileMenuOpen() ? closeProfileMenu() : openProfileMenu(e.currentTarget))}
          >
            <ProfilePicture />
          </button>
        </div>
      </div>
    </header>
  );
}
