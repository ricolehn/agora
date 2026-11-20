// The profile menu like the Android app's (a simple fade instead of its animation): a glass panel with 28px corners
// that hangs a little over the profile button, the same picture at its top left next to name and e-mail, then the
// entries - icons centred under the picture, labels in line with the name. The page behind is dimmed.
import type { JSX } from '@solidjs/web';
import { Show } from 'solid-js';
import { logout } from '../app/auth';
import { t } from '../app/i18n';
import { ownPicture } from '../app/pictures';
import { switchTab } from '../app/router';
import { avatarRing, currentUser, isSuperAdminUser } from '../app/session';
import { closeProfileMenu, profileMenuOpen, profileMenuPosition } from '../app/shell';
import { fullName } from '../app/util';
import { RING_FRAME, RING_GRADIENT } from '../ui/Avatar';
import { Icon, type IconName } from '../ui/Icon';

/** The own picture inside the role ring's 2px gap (or the person symbol), filling its button. */
export function ProfilePicture() {
  return (
    <Show
      when={ownPicture()}
      fallback={<Icon name="user" size={24} class="size-full rounded-full border-2 border-surface bg-surface p-[6px]" />}
    >
      {src => <img src={src()} alt={t('profile_pic_title', 'Profile Picture')} class="size-full rounded-full border-2 border-surface bg-surface object-cover" />}
    </Show>
  );
}

/** The ring and size of the profile button (38px on phones, 44px on desktop). */
export const profileRingClass = (): JSX.ClassValue => [
  'flex shrink-0 items-center justify-center size-[38px] md:size-11 text-text md:text-[var(--desktop-profile-text)]',
  RING_FRAME,
  RING_GRADIENT[avatarRing(currentUser())]
];

// Menu and dimming fade in and out together
const fade = (open: boolean) =>
  open
    ? 'visible pointer-events-auto opacity-100 [transition:opacity_0.15s_ease]'
    : 'invisible pointer-events-none opacity-0 [transition:opacity_0.15s_ease,visibility_0s_linear_0.15s]';

function MenuItem(props: { icon: IconName; danger?: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      class={[
        'flex min-h-12 w-full cursor-pointer items-center gap-[calc(var(--profile-pic)/2)] rounded-[20px] border-0 bg-transparent pr-3 pl-[calc(var(--profile-pic)/2-12px)] text-left text-[0.95rem] font-bold',
        'hover:bg-[rgba(28,25,23,0.07)] active:bg-[rgba(28,25,23,0.07)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary',
        'dark:hover:bg-white/8 dark:active:bg-white/8',
        props.danger ? 'text-danger' : 'text-text'
      ]}
      onClick={() => props.onClick()}
    >
      <Icon name={props.icon} size={24} strokeWidth={1.8} class="shrink-0" />
      <span class="min-w-0 truncate">{props.children}</span>
    </button>
  );
}

export function ProfileMenu() {
  const open = () => profileMenuOpen();
  const go = (tab: 'settings' | 'super-admin-settings') => {
    closeProfileMenu();
    switchTab(tab);
  };
  return (
    <>
      <div
        class={['fixed inset-0 z-[1100] bg-[rgba(28,25,23,0.16)] dark:bg-[rgba(0,0,0,0.42)]', fade(open())]}
        aria-hidden="true"
        onClick={() => closeProfileMenu()}
      />
      <div
        id="profileDropdown"
        class={[
          'fixed z-[1101] flex w-max max-w-[min(300px,calc(100vw-24px))] min-w-[240px] flex-col rounded-[28px] border border-transparent p-2',
          'bg-[var(--frost-surface)] shadow-[var(--shadow-lg),0_0_0_1px_var(--hairline)] [backdrop-filter:var(--frost)] [--profile-pic:38px] md:[--profile-pic:44px]',
          fade(open())
        ]}
        style={{ top: `${profileMenuPosition().top}px`, right: `${profileMenuPosition().right}px` }}
      >
        <div class="flex min-w-0 items-center gap-3">
          <span class="flex shrink-0" aria-hidden="true">
            <span class={profileRingClass()}>
              <ProfilePicture />
            </span>
          </span>
          <div class="min-w-0 flex-1 pr-2">
            <div class="truncate text-[0.95rem] font-extrabold text-text">{fullName(currentUser()) || currentUser()?.name || ''}</div>
            <div class="mt-px truncate text-[0.8rem] text-text-secondary">{currentUser()?.email || ''}</div>
          </div>
        </div>
        <div class="mt-2 mb-1 h-px bg-border-light" />
        <MenuItem icon="gear" onClick={() => go('settings')}>
          {t('nav_settings', 'Settings')}
        </MenuItem>
        <Show when={isSuperAdminUser()}>
          <MenuItem icon="shield" onClick={() => go('super-admin-settings')}>
            {t('nav_superadmin_settings', 'System Settings')}
          </MenuItem>
        </Show>
        <MenuItem icon="logout" danger onClick={() => void logout()}>
          {t('logout', 'Log Out')}
        </MenuItem>
      </div>
    </>
  );
}
