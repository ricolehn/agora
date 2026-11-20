// The dialog that gives an account a new password.
import { createSignal, flush } from 'solid-js';
import { apiJson } from '../../app/api';
import { t } from '../../app/i18n';
import { closeModal, openModal } from '../../app/modals';
import { attempt, showToast } from '../../app/toast';
import { Button } from '../../ui/Button';
import { Field, PasswordInput } from '../../ui/form';
import { Modal } from '../../ui/Modal';

const MODAL_ID = 'reset-password-modal';

const [target, setTarget] = createSignal<{ uid: string; name: string }>({ uid: '', name: '' });
const [password, setPassword] = createSignal('');

export function openResetPasswordModal(uid: string, name: string) {
  setTarget({ uid, name });
  setPassword('');
  flush();
  openModal(MODAL_ID);
}

async function submitResetPassword() {
  const value = password();
  if (value.length < 6) return showToast(t('setup_admin_password_invalid', 'Password must be at least 6 characters long.'), 'error');
  const { uid } = target();
  await attempt(
    async () => {
      await apiJson(`/admin/users/${uid}/password`, 'PUT', { password: value }, t('admin_password_reset_failed_short', 'Password reset failed'));
      closeModal(MODAL_ID);
      showToast(t('toast_password_reset', 'Password changed successfully'));
    },
    err => err.message || t('admin_password_reset_failed', 'Failed to reset the password')
  );
}

export function ResetPasswordDialog() {
  return (
    <Modal id={MODAL_ID} title={t('modal_reset_password_title', 'Reset Password')} maxWidth="400px">
      <form
        onSubmit={e => {
          e.preventDefault();
          void submitResetPassword();
        }}
      >
        <p class="mb-[15px] font-semibold text-text">{target().name}</p>
        <Field label={t('label_password', 'New Password')} for="reset-password-new">
          <PasswordInput
            id="reset-password-new"
            placeholder={t('new_password', 'New password')}
            minlength="6"
            required
            value={password()}
            onInput={e => setPassword(e.currentTarget.value)}
          />
        </Field>
        <div class="flex justify-end gap-2.5 pt-2.5">
          <Button variant="secondary" onClick={() => closeModal(MODAL_ID)}>
            {t('btn_cancel', 'Cancel')}
          </Button>
          <Button type="submit">{t('btn_save', 'Save')}</Button>
        </div>
      </form>
    </Modal>
  );
}
