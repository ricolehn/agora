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
    <Card>
      <div class="mb-[15px]">
        <div class="mb-3">
          <PasswordInput
            id="old-password"
            value={oldPassword()}
            onInput={e => setOldPassword(e.currentTarget.value)}
            placeholder={t('old_password', 'Old password')}
            aria-label={t('old_password', 'Old password')}
            autocomplete="current-password"
          />
        </div>
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
