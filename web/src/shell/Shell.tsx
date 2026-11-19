// The app's frame: header with the desktop navigation and the profile button, the scrolling page with the tabs, the
// bottom navigation on phones, the floating action button, the profile menu. (First working version: the visual
// details follow the previous stylesheets in the shell components.)
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { Dynamic } from '@solidjs/web';
import { logout } from '../app/auth';
import { appName } from '../app/config';
import { t } from '../app/i18n';
import { NAV_ENTRIES } from '../app/nav';
import { ownPicture } from '../app/pictures';
import { fabs, tabs } from '../app/registry';
import { activeTab, switchTab, tabSlide, tabSwitchCount } from '../app/router';
import { currentUser, isSuperAdminUser } from '../app/session';
import {
  fabMenuOpen, headerHidden, headerScrolled, profileMenuOpen, setFabMenuOpen, setHeaderHidden, setHeaderScrolled,
  setProfileMenuOpen, setScrollContainer
} from '../app/shell';
import { HUB_TABS, type TabId } from '../app/tabs';
import { fullName } from '../app/util';
import { Icon } from '../ui/Icon';

const isActiveNav = (tab: TabId) => activeTab() === tab || (tab === 'hub' && HUB_TABS.includes(activeTab()));

function TabPanel(props: { id: TabId }) {
  // Mounted the first time the tab opens, then kept (its state survives switching tabs)
  const [visited, setVisited] = createSignal(false);
  const active = () => activeTab() === props.id;
  const mounted = createMemo(() => visited() || active());
  createEffect(active, isActive => {
    if (isActive) setVisited(true);
  });
  return (
    <Show when={mounted()}>
      <section
        id={props.id}
        role="tabpanel"
        class={['tab-content', active() ? 'block' : 'hidden']}
        data-slide={active() ? `${tabSlide()}-${tabSwitchCount()}` : undefined}
      >
        <Dynamic component={tabs.get(props.id)!.component} />
      </section>
    </Show>
  );
}

const HEADER_SCROLL_THRESHOLD = 8;

export function Shell() {
  let lastY = 0;
  let ticking = false;
  const onScroll = (container: HTMLElement) => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = container.scrollTop;
      const delta = y - lastY;
      setHeaderScrolled(y > 4);
      // Near the top, or while the profile menu is open, it always stays
      if (y < 72 || profileMenuOpen()) {
        setHeaderHidden(false);
        lastY = y;
        return;
      }
      if (Math.abs(delta) < HEADER_SCROLL_THRESHOLD) return;
      setHeaderHidden(delta > 0);
      lastY = y;
    });
  };
  const fab = () => fabs.get(activeTab());
  const fabVisible = () => !!fab()?.visible();
  const onFab = () => {
    const current = fab();
    if (!current) return;
    if (current.action) return current.action();
    setFabMenuOpen(!fabMenuOpen());
  };

  return (
    <div
      class={['container h-full overflow-y-auto px-[max(20px,calc((100%-800px)/2))] pt-5 pb-[100px]', { 'ai-chat-active': activeTab() === 'ai-chat' }]}
      ref={el => {
        setScrollContainer(el);
        el.addEventListener('scroll', () => onScroll(el), { passive: true });
      }}
    >
      <div class="app-layout relative">
        <header class={['header relative z-50 flex items-center justify-between pb-6 pt-[max(16px,env(safe-area-inset-top,16px))] transition-transform', { 'header-hidden': headerHidden(), 'header-scrolled': headerScrolled() }]}>
          <div class="flex items-center gap-6">
            <div class="flex items-center gap-2.5">
              <img src="/assets/church-logo.svg" alt="" class="size-9" />
              <h1 class="text-xl font-extrabold">{appName()}</h1>
            </div>
            <nav class="hidden gap-1 md:flex">
              <For each={NAV_ENTRIES}>
                {entry => (
                  <Show when={entry.visible()}>
                    <button
                      type="button"
                      class={['nav-btn flex items-center gap-2 rounded-full px-3 py-2 text-[0.9rem] font-semibold', isActiveNav(entry.tab) ? 'bg-nav-pill text-nav-pill-text' : 'text-text-secondary']}
                      aria-current={isActiveNav(entry.tab) ? 'page' : undefined}
                      onClick={() => switchTab(entry.tab, 'nav')}
                    >
                      <Icon name={entry.icon} size={18} />
                      <span>{entry.label()}</span>
                      <Show when={entry.badge?.()}>
                        <span class="rounded-full bg-danger px-1.5 text-[0.7rem] text-white">{entry.badge!()}</span>
                      </Show>
                    </button>
                  </Show>
                )}
              </For>
            </nav>
          </div>
          <button
            type="button"
            class="profile-btn flex size-11 items-center justify-center overflow-hidden rounded-full border border-hairline bg-surface"
            aria-label={t('profile_menu', 'Profile menu')}
            aria-expanded={profileMenuOpen() ? 'true' : 'false'}
            aria-haspopup="true"
            onClick={() => setProfileMenuOpen(!profileMenuOpen())}
          >
            <Show when={ownPicture()} fallback={<Icon name="user" size={24} />}>
              <img src={ownPicture()!} alt={t('profile_pic_title', 'Profile Picture')} class="size-full object-cover" />
            </Show>
          </button>
        </header>

        <main>
          <For each={[...tabs.keys()]}>{id => <TabPanel id={id} />}</For>
        </main>
      </div>

      <Show when={profileMenuOpen()}>
        <div class="fixed inset-0 z-[1500]" onClick={() => setProfileMenuOpen(false)}>
          <div class="absolute right-3 top-3 w-72 rounded-[28px] bg-surface p-3 shadow-card-lg" onClick={e => e.stopPropagation()}>
            <div class="px-3 py-2">
              <div class="font-bold">{fullName(currentUser()) || currentUser()?.name}</div>
              <div class="text-sm text-text-secondary">{currentUser()?.email}</div>
            </div>
            <button type="button" class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-alt" onClick={() => { setProfileMenuOpen(false); switchTab('settings'); }}>
              <Icon name="gear" size={20} /> {t('nav_settings', 'Settings')}
            </button>
            <Show when={isSuperAdminUser()}>
              <button type="button" class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-alt" onClick={() => { setProfileMenuOpen(false); switchTab('super-admin-settings'); }}>
                <Icon name="shield" size={20} /> {t('nav_superadmin_settings', 'System Settings')}
              </button>
            </Show>
            <button type="button" class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-danger hover:bg-surface-alt" onClick={() => void logout()}>
              <Icon name="logout" size={20} /> {t('logout', 'Log Out')}
            </button>
          </div>
        </div>
      </Show>

      <Show when={fabVisible()}>
        <button
          type="button"
          class="fixed bottom-[calc(var(--mobile-bottom-nav-offset)+16px)] right-5 z-[900] flex size-14 items-center justify-center rounded-full bg-gradient-primary text-white shadow-card-lg md:bottom-8"
          aria-label={t('fab_open_menu', 'Open action menu')}
          aria-expanded={fabMenuOpen() ? 'true' : 'false'}
          onClick={onFab}
        >
          <Icon name="plus" size={26} strokeWidth={2.5} />
        </button>
        <Show when={fabMenuOpen() && fab()?.items}>
          <div class="fixed bottom-[calc(var(--mobile-bottom-nav-offset)+88px)] right-5 z-[900] w-72 rounded-3xl bg-surface p-2 shadow-card-lg md:bottom-24">
            <For each={fab()!.items!()}>
              {item => (
                <button type="button" class="flex w-full items-center gap-3 rounded-2xl p-3 text-left hover:bg-surface-alt" onClick={() => { setFabMenuOpen(false); item.onClick(); }}>
                  <span class="flex size-10 items-center justify-center rounded-xl" style={item.tint ? { background: item.tint.background, color: item.tint.color } : undefined}>{item.icon()}</span>
                  <span>
                    <span class="block font-semibold">{item.title()}</span>
                    <span class="block text-sm text-text-secondary">{item.subtitle()}</span>
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <nav class="bottom-nav fixed inset-x-0 bottom-0 z-[800] flex h-[var(--mobile-bottom-nav-offset)] items-start justify-around border-t border-hairline bg-surface/90 pt-1.5 backdrop-blur-xl md:hidden">
        <For each={NAV_ENTRIES}>
          {entry => (
            <Show when={entry.visible()}>
              <button
                type="button"
                class={['nav-item relative flex flex-col items-center gap-0.5 px-2 text-[0.7rem] font-semibold', isActiveNav(entry.tab) ? 'text-nav-pill-text' : 'text-text-secondary']}
                aria-label={entry.bottomLabel()}
                aria-current={isActiveNav(entry.tab) ? 'page' : undefined}
                onClick={() => switchTab(entry.tab, 'nav')}
              >
                <span class={['rounded-full px-4 py-1', { 'bg-nav-pill': isActiveNav(entry.tab) }]}>
                  <Icon name={entry.icon} size={22} />
                </span>
                <span>{entry.bottomLabel()}</span>
              </button>
            </Show>
          )}
        </For>
      </nav>
    </div>
  );
}
