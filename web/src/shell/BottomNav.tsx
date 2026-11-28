// The navigation at the bottom on phones: frosted glass, the current entry's symbol in a tinted pill.
import { For, Show } from 'solid-js';
import { NAV_ENTRIES, type NavEntry } from '../app/nav';
import { switchTab } from '../app/router';
import { CountBadge } from '../ui/feedback';
import { Icon } from '../ui/Icon';
import { isActiveNav } from './Header';

function BottomNavItem(props: { entry: NavEntry }) {
  const active = () => isActiveNav(props.entry);
  return (
    <button
      type="button"
      data-tab={props.entry.tab}
      class={[
        'nav-item group relative flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 border-0 bg-transparent px-0.5 py-1',
        '[transition:color_0.2s_ease,scale_0.15s_ease] active:scale-[0.94] focus-visible:shadow-ring focus-visible:outline-none',
        active() ? 'text-text' : 'text-text-secondary'
      ]}
      aria-label={props.entry.bottomLabel()}
      aria-current={active() ? 'page' : undefined}
      onClick={() => switchTab(props.entry.tab, 'nav')}
    >
      <Icon
        name={props.entry.icon}
        size={22}
        class={[
          'box-content shrink-0 rounded-full px-[18px] py-1 group-active:scale-[0.92]',
          '[transition:background-color_0.25s_var(--ease),stroke_0.25s_var(--ease),scale_0.25s_var(--ease)]',
          { 'bg-nav-pill stroke-nav-pill-text': active() }
        ]}
      />
      <span
        class={[
          'nav-label max-w-full overflow-hidden text-75 leading-[1.1] text-ellipsis whitespace-nowrap [transition:color_0.2s_ease,font-weight_0.2s_ease]',
          active() ? 'font-semibold text-text' : 'font-medium'
        ]}
      >
        {props.entry.bottomLabel()}
      </span>
      <CountBadge
        count={props.entry.badge?.() ?? 0}
        class="absolute top-0 left-[calc(50%+5px)] h-5 min-w-5 border-2 border-surface px-1 text-62 shadow-none"
      />
    </button>
  );
}

export function BottomNav() {
  return (
    <nav
      id="bottom-nav"
      class={[
        'bottom-nav fixed bottom-0 left-0 z-[1000] flex h-[var(--mobile-bottom-nav-offset)] w-full items-center justify-around md:hidden',
        'border-t border-hairline pt-2 pb-[calc(6px+env(safe-area-inset-bottom,0px))] dark:border-border-light',
        'bg-[var(--frost-surface)] [backdrop-filter:var(--frost)]'
      ]}
    >
      <For each={NAV_ENTRIES}>
        {entry => (
          <Show when={entry.visible()}>
            <BottomNavItem entry={entry} />
          </Show>
        )}
      </For>
    </nav>
  );
}
