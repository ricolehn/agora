import { For, Show } from 'solid-js';
import { logout } from '../../app/auth';
import { t } from '../../app/i18n';
import { avatarRing, canManageRegistrationCode, currentUid, currentUser } from '../../app/session';
import { Avatar } from '../../ui/Avatar';
import { InviteCard } from './InviteCard';
import { DANGER_ROW, ROW, RowCard, RowChevron, RowIcon, RowText } from './rows';
import { MENU_ID, availablePages, openSettingsPage, profileName, type SettingsPageDef } from './state';

/** The own picture with the role ring, the name and the e-mail address. */
function ProfileRow() {
  return (
    <button type="button" data-key="profile" class={[ROW, 'text-text']} onClick={() => openSettingsPage('profile')}>
      <Avatar uid={currentUid()} name={profileName()} size={40} ring={avatarRing(currentUser())} initialsClass="text-85" />
      <RowText title={profileName()} desc={currentUser()?.email} />
      <RowChevron />
    </button>
  );
}

function PageRow(props: { page: SettingsPageDef }) {
  return (
    <button
      type="button"
      data-key={props.page.key}
      class={[ROW, 'text-text']}
      style={{ '--row-color': props.page.color }}
      onClick={() => openSettingsPage(props.page.key)}
    >
      <RowIcon name={props.page.icon!} />
      <RowText title={props.page.title()} desc={props.page.desc?.()} />
      <RowChevron />
    </button>
  );
}

/** The menu: the registration code on top (for those who manage it), the pages, signing out. */
export function SettingsMenu() {
  return (
    <div class="max-w-[760px]">
      <Show when={canManageRegistrationCode()}>
        <InviteCard />
      </Show>
      <div id={MENU_ID} class="flex flex-col gap-3.5">
        <RowCard>
          <For each={availablePages()}>{page => (page.key === 'profile' ? <ProfileRow /> : <PageRow page={page} />)}</For>
        </RowCard>
        <RowCard>
          <button type="button" class={DANGER_ROW} onClick={() => void logout()}>
            <RowIcon name="logout" />
            <RowText title={t('logout', 'Sign out')} />
          </button>
        </RowCard>
      </div>
    </div>
  );
}
