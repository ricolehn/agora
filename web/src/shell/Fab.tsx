// The floating action button of the open tab (app/registry.ts registerFab): one action runs directly, several open a
// menu above the button. The menu closes on a tap outside, Escape (app/shell.ts), a pick, and with another tab.
import { For, Show, onSettled } from 'solid-js';
import { t } from '../app/i18n';
import { fabs } from '../app/registry';
import { activeTab } from '../app/router';
import { closeFabMenu, fabMenuOpen, setFabMenuOpen } from '../app/shell';
import { Icon } from '../ui/Icon';

// The entries rise one after the other, the lowest first
const ITEM_DELAY = ['0.1s', '0.05s'];

export function FloatingAction() {
  const fab = () => fabs.get(activeTab());
  const visible = () => !!fab()?.visible();
  const items = () => (visible() ? fab()?.items?.() ?? [] : []);
  let menu: HTMLDivElement | undefined;
  let button: HTMLButtonElement | undefined;

  onSettled(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (fabMenuOpen() && !menu?.contains(target) && !button?.contains(target)) closeFabMenu();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  });

  const onFab = () => {
    const current = fab();
    if (!current) return;
    if (current.action) return current.action();
    setFabMenuOpen(!fabMenuOpen());
  };

  return (
    <Show when={visible()}>
      <Show when={fab()?.items}>
        <div
          ref={menu}
          id="fabMenu"
          class={[
            'fixed right-4 bottom-[calc(var(--mobile-bottom-nav-offset)+76px)] z-[1002] flex w-max max-w-[calc(100vw-32px)] flex-col gap-4',
            'rounded-[20px] border border-border bg-surface p-4 shadow-[0_15px_30px_rgba(0,0,0,0.15)]',
            'md:right-[30px] md:bottom-[100px] md:max-w-[360px] md:gap-[22px] md:rounded-[28px] md:p-6',
            fabMenuOpen()
              ? 'visible pointer-events-auto translate-y-0 opacity-100 [transition:opacity_0.3s_cubic-bezier(0.25,1,0.5,1),translate_0.3s_cubic-bezier(0.25,1,0.5,1),visibility_0s]'
              : 'invisible pointer-events-none translate-y-5 opacity-0 [transition:opacity_0.3s_cubic-bezier(0.25,1,0.5,1),translate_0.3s_cubic-bezier(0.25,1,0.5,1),visibility_0s_linear_0.3s]'
          ]}
        >
          <div>
            <For each={items()}>
              {(item, i) => (
                <button
                  type="button"
                  class={[
                    'group flex w-full cursor-pointer items-center rounded-[14px] border-0 bg-[var(--frost-surface)] p-1 text-left outline-none [backdrop-filter:var(--frost)] [&+&]:mt-1',
                    '[transition:opacity_0.3s_cubic-bezier(0.25,1,0.5,1),translate_0.3s_cubic-bezier(0.25,1,0.5,1),scale_0.3s_cubic-bezier(0.25,1,0.5,1)] focus-visible:shadow-ring',
                    fabMenuOpen() ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-[15px] scale-95 opacity-0'
                  ]}
                  style={{ 'transition-delay': fabMenuOpen() ? ITEM_DELAY[i()] ?? '0s' : '0s' }}
                  onClick={() => {
                    closeFabMenu();
                    item.onClick();
                  }}
                >
                  <span
                    class={[
                      'flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-surface-alt text-primary [transition:background-color_0.2s,color_0.2s]',
                      'group-hover:bg-gradient-primary group-hover:text-white md:size-12 md:rounded-[16px] [&_svg]:size-5 md:[&_svg]:size-6'
                    ]}
                    style={item.tint ? { background: item.tint.background, color: item.tint.color } : undefined}
                  >
                    {item.icon()}
                  </span>
                  <span class="ml-3 flex flex-col md:ml-4">
                    <span class="text-[16px] leading-[1.2] font-bold text-text md:text-[18px]">{item.title()}</span>
                    <span class="mt-0.5 text-[12px] font-normal text-text-secondary md:text-[14px]">{item.subtitle()}</span>
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
      <button
        ref={button}
        type="button"
        id="desktop-fab"
        class={[
          'fixed right-4 bottom-[calc(var(--mobile-bottom-nav-offset)+16px)] z-[1002] flex size-[52px] cursor-pointer items-center justify-center rounded-[16px] border-0',
          'bg-gradient-primary shadow-[0_8px_20px_rgba(0,0,0,0.3)] will-change-transform [transition:scale_0.3s_cubic-bezier(0.4,0,0.2,1)] active:scale-95',
          'dark:shadow-[0_8px_20px_rgba(0,0,0,0.45)] md:right-[30px] md:bottom-[30px] md:size-[60px] md:rounded-[18px]'
        ]}
        aria-label={t('fab_open_menu', 'Open action menu')}
        aria-expanded={fab()?.items ? (fabMenuOpen() ? 'true' : 'false') : undefined}
        onClick={onFab}
      >
        <Icon
          name="plus"
          size={32}
          class={['size-7 stroke-white will-change-transform [transition:rotate_0.3s_cubic-bezier(0.4,0,0.2,1)] md:size-8', { 'rotate-45': fabMenuOpen() }]}
        />
      </button>
    </Show>
  );
}
