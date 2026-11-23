// The menu of an entry (right click, the menu key or Shift + F10), of the order and of the folders folded into "…":
// placed at the pointer (or under its button) and kept on screen. Any tap elsewhere, scrolling or resizing closes it.
import { For, Show, createEffect, createSignal, onSettled } from 'solid-js';
import { Icon, type IconName } from '../../ui/Icon';
import { onMenuKeyDown } from '../../ui/keys';
import { MotifSvg } from './motif';

export interface MediaMenuItem {
  label: string;
  /** A choice of the order (a check after the chosen one). */
  radio?: boolean;
  chosen?: boolean;
  /** A line icon before the label, or the folder motif (folded path). */
  icon?: IconName;
  motif?: boolean;
  /** Folders folded into "…": each a little further in, like the way down. */
  indent?: number;
  danger?: boolean;
  disabled?: boolean;
  /** Why it is disabled. */
  title?: string;
  onPick: () => void;
}

export interface MediaMenuState {
  title?: string;
  /** What the menu is (for screen readers). */
  label?: string;
  items: MediaMenuItem[];
  x: number;
  y: number;
  /** x is the menu's right edge (a button at the end of a row). */
  alignEnd?: boolean;
}

const [menu, setMenu] = createSignal<MediaMenuState | null>(null);
export const mediaMenuOpen = () => !!menu();
export const showMediaMenu = (state: MediaMenuState) => setMenu(state);
export function closeMediaMenu() {
  if (menu()) setMenu(null);
}

const ITEM =
  'flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-[9px] text-left text-[0.88rem] font-semibold ' +
  'enabled:hover:bg-surface-alt focus-visible:bg-surface-alt focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ' +
  'disabled:cursor-not-allowed disabled:opacity-45';

export function MediaMenu() {
  let el: HTMLDivElement | undefined;
  const [place, setPlace] = createSignal<{ left: number; top: number } | null>(null);

  // Once drawn it is measured and kept 8px inside the window; the first item takes the focus
  createEffect(menu, state => {
    setPlace(null);
    if (!state || !el) return;
    const rect = el.getBoundingClientRect();
    const left = state.alignEnd ? state.x - rect.width : state.x;
    setPlace({
      left: Math.max(8, Math.min(left, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(state.y, window.innerHeight - rect.height - 8))
    });
    el.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  });

  onSettled(() => {
    const outside = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.('#media-menu')) closeMediaMenu();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', closeMediaMenu, true);
    window.addEventListener('resize', closeMediaMenu);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', closeMediaMenu, true);
      window.removeEventListener('resize', closeMediaMenu);
    };
  });

  return (
    <Show when={menu()}>
      {state => (
        <div
          id="media-menu"
          ref={el}
          role="menu"
          aria-label={state().label || undefined}
          // The arrows go from entry to entry (Escape: MediaPage; a tap elsewhere, scrolling: see above)
          onKeyDown={e => onMenuKeyDown(e)}
          class={[
            'fixed z-[3000] max-w-[min(300px,calc(100vw-16px))] min-w-[210px] rounded-2xl border border-hairline bg-surface p-1.5 text-text',
            'animate-[mediaMenuIn_0.14s_var(--ease)] shadow-[0_18px_40px_-12px_rgba(28,25,23,0.35),0_2px_6px_rgba(28,25,23,0.08)] dark:shadow-[0_18px_40px_-12px_rgba(0,0,0,0.7)]'
          ]}
          style={{ left: `${place()?.left ?? state().x}px`, top: `${place()?.top ?? state().y}px` }}
        >
          <Show when={state().title}>
            <div class="mb-1 truncate border-b border-border-light px-2.5 pt-1.5 pb-2 text-[0.76rem] font-bold text-text-secondary">{state().title}</div>
          </Show>
          <For each={state().items}>
            {item => (
              <button
                type="button"
                role={item.radio ? 'menuitemradio' : 'menuitem'}
                aria-checked={item.radio ? (item.chosen ? 'true' : 'false') : undefined}
                class={[ITEM, item.danger ? 'text-danger' : 'text-text']}
                style={item.indent !== undefined ? { 'padding-left': `${10 + item.indent * 12}px` } : undefined}
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  closeMediaMenu();
                  item.onPick();
                }}
              >
                <Show when={item.motif}>
                  <MotifSvg motif="folder" class="block size-5 shrink-0" />
                </Show>
                <Show when={item.icon}>
                  {name => <Icon name={name()} size={16} strokeWidth={2.2} class={item.danger ? 'shrink-0 text-danger' : 'shrink-0 text-text-secondary'} />}
                </Show>
                <span class="min-w-0 flex-1 truncate">{item.label}</span>
                <Show when={item.chosen}>
                  <Icon name="check" size={16} strokeWidth={2.6} class="shrink-0 text-primary" />
                </Show>
              </button>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}
