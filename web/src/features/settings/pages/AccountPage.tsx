import { Show, createSignal, onFlush } from 'solid-js';
import { deleteOwnAccount } from '../../../app/auth';
import { t } from '../../../app/i18n';
import { isOwnerUser } from '../../../app/session';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/form';
import { Icon } from '../../../ui/Icon';
import { DANGER_ROW, ROW, RowCard, RowChevron, RowIcon, RowText } from '../rows';

/** Delete account: a danger row that opens its form (a sheet in the Android app). */
function DeleteAccount() {
  const [open, setOpen] = createSignal(false);
  const [password, setPassword] = createSignal('');
  let input!: HTMLInputElement;
  const toggle = () => {
    const opening = !open();
    setOpen(opening);
    // The password field takes the cursor once it shows
    if (opening) onFlush(() => input.focus());
  };
  const remove = async () => {
    if (await deleteOwnAccount(password())) setPassword('');
  };
  return (
    <RowCard class="mb-4">
      <button type="button" class={DANGER_ROW} aria-expanded={open() ? 'true' : 'false'} aria-controls="delete-account-body" onClick={toggle}>
        <RowIcon name="trash" />
        <RowText title={t('delete_account_title', 'Delete account')} />
        <Icon
          name="chevronRight"
          size={18}
          strokeWidth={2.5}
          class={open() ? 'shrink-0 rotate-90 opacity-60 transition-transform duration-200 ease-[ease]' : 'shrink-0 opacity-60 transition-transform duration-200 ease-[ease]'}
        />
      </button>
      <div id="delete-account-body" hidden={!open()} class="border-t border-border-light px-4 pt-1 pb-4">
        <p class="my-3 text-[0.84rem] leading-[1.5] text-text-secondary">
          {t(
            'delete_account_desc',
            'Deletes your login and your personal data: profile, profile picture, registrations, mentoring conversations, open requests and notifications. Booked payments stay with your organisation for bookkeeping reasons. This cannot be undone.'
          )}
        </p>
        <div class="mb-3">
          <Input
            ref={el => (input = el)}
            type="password"
            id="delete-account-password"
            value={password()}
            onInput={e => setPassword(e.currentTarget.value)}
            placeholder={t('delete_account_password', 'Password to confirm')}
            aria-label={t('delete_account_password', 'Password to confirm')}
            autocomplete="current-password"
          />
        </div>
        <Button variant="danger" block onClick={() => void remove()}>
          {t('delete_account_btn', 'Delete account permanently')}
        </Button>
      </div>
    </RowCard>
  );
}

/** Privacy and deleting the own account. */
export function AccountPage() {
  return (
    <>
      <RowCard class="mb-4">
        <a class={[ROW, 'text-text']} style={{ '--row-color': '#0ea5e9' }} href="/privacy" target="_blank" rel="noopener">
          <RowIcon name="shield" />
          <RowText title={t('settings_privacy_title', 'Privacy')} desc={t('settings_privacy_desc', 'How Agora handles your data and what rights you have.')} />
          <RowChevron />
        </a>
      </RowCard>
      {/* The owner runs the instance and cannot delete their account (the server refuses it too) */}
      <Show when={!isOwnerUser()}>
        <DeleteAccount />
      </Show>
    </>
  );
}
