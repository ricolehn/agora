import { createSignal } from 'solid-js';
import { changePassword } from '../../../app/auth';
import { t } from '../../../app/i18n';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { PasswordInput } from '../../../ui/form';

/** The old and a new password (the server signs out afterwards). */
export function PasswordPage() {
  const [oldPassword, setOldPassword] = createSignal('');
  const [newPassword, setNewPassword] = createSignal('');
  const submit = async () => {
    if (!(await changePassword(oldPassword(), newPassword()))) return;
    setOldPassword('');
    setNewPassword('');
  };
  return (
    <Card bodyClass="pt-5">
      <div class="mb-[15px]">
        <PasswordInput
          id="old-password"
          wrapperClass="mb-3"
          value={oldPassword()}
          onInput={e => setOldPassword(e.currentTarget.value)}
          placeholder={t('old_password', 'Old password')}
          aria-label={t('old_password', 'Old password')}
          autocomplete="current-password"
        />
        <PasswordInput
          id="new-password"
          value={newPassword()}
          onInput={e => setNewPassword(e.currentTarget.value)}
          placeholder={t('new_password', 'New password')}
          aria-label={t('new_password', 'New password')}
          autocomplete="new-password"
        />
      </div>
      <Button block onClick={() => void submit()}>
        {t('btn_change_password', 'Change Password')}
      </Button>
    </Card>
  );
}
