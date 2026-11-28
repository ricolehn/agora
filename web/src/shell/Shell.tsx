// The app's frame: the scrolling page with the header and the tabs, the bottom navigation on phones, the floating
// action button and the profile menu.
import { Errored, For, Show, createMemo } from 'solid-js';
import { Dynamic } from '@solidjs/web';
import { tabs } from '../app/registry';
import { activeTab, tabSlide } from '../app/router';
import { headerHidden, profileMenuOpen, setHeaderHidden, setHeaderScrolled, setScrollContainer } from '../app/shell';
import type { TabId } from '../app/tabs';
import { BottomNav } from './BottomNav';
import { FloatingAction } from './Fab';
import { Header } from './Header';
import { ProfileMenu } from './ProfileMenu';
import { Failed } from '../ui/pages';

/**
 * A tab's page (.tab-content): mounted the first time the tab opens, then kept (its state survives switching tabs).
 * It slides in from the side its tab lies on (classes slide-in-left / slide-in-right while shown); the AI chat does
 * not move as a whole (its fixed input bar would jump), its parts animate themselves. A page that fails while it is
 * drawn says so with "Try again" - the rest of the app goes on (an error no boundary catches stops all of Solid).
 */
function TabPanel(props: { id: TabId }) {
  const active = () => activeTab() === props.id;
  // Once shown, it stays (the memo keeps its previous answer)
  const mounted = createMemo<boolean>(visited => !!visited || active());
  return (
    <Show when={mounted()}>
      <section
        id={props.id}
        role="tabpanel"
        class={[
          'tab-content',
          active()
            ? [
                'block',
                tabSlide() === 'left' ? 'slide-in-left' : 'slide-in-right',
                props.id !== 'ai-chat' && (tabSlide() === 'left' ? 'animate-slide-in-left' : 'animate-slide-in-right')
              ]
            : 'hidden'
        ]}
      >
        <Errored fallback={(err, retry) => <Failed error={err()} onRetry={retry} />}>
          <Dynamic component={tabs.get(props.id)!.component} />
        </Errored>
      </section>
    </Show>
  );
}

// The header goes after this much scrolling in one direction (small jitters do nothing)
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

  return (
    <>
      <div
        class={[
          'h-full overflow-y-auto scroll-smooth px-5 pt-0 pb-[100px] md:px-[var(--page-gutter)] md:pt-[var(--desktop-header-offset)]',
          { 'ai-chat-active': activeTab() === 'ai-chat' }
        ]}
        data-header={headerHidden() ? 'hidden' : 'shown'}
        ref={el => {
          setScrollContainer(el);
          el.addEventListener('scroll', () => onScroll(el), { passive: true });
        }}
      >
        <div class="app-layout relative">
          <Header />
          <main>
            <For each={[...tabs.keys()]}>{id => <TabPanel id={id} />}</For>
          </main>
        </div>
      </div>
      <FloatingAction />
      <BottomNav />
      <ProfileMenu />
    </>
  );
}
