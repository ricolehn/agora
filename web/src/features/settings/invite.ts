// The registration code new members need (on top of the settings menu for those who manage it).
import { db, ref, set } from '../../app/api';
import { inviteCode, setInviteCode } from '../../app/data';
import { t } from '../../app/i18n';
import { canManageRegistrationCode } from '../../app/session';
import { attempt, showToast } from '../../app/toast';
import { copyText } from '../../app/util';

const refuse = () => showToast(t('alert_no_permission', "You don't have permission to manage the registration code."), 'error');

/** A new random six-digit code. */
export async function generateNewCode() {
  if (!canManageRegistrationCode()) return refuse();
  const newCode = String(100000 + (window.crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  await attempt(async () => {
    await set(ref(db, 'system/inviteCode'), newCode);
    setInviteCode(newCode);
  }, t('alert_save_code_failed', 'New code could not be saved.'));
}

export async function copyInviteCode() {
  if (!canManageRegistrationCode()) return refuse();
  const code = inviteCode();
  if (!code || code === '------') return;
  if (await copyText(code)) showToast(t('toast_code_copied', 'Code copied!'));
  else showToast(t('toast_copy_failed', 'Copy failed'), 'error');
}
