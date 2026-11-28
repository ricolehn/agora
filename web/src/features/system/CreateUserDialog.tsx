// The dialog that creates an account (with or without a login) and, for members who pay, their finance record.
import { Show } from 'solid-js';
import { apiJson } from '../../app/api';
import { loadData } from '../../app/data';
import { t } from '../../app/i18n';
import { closeModal, openModal } from '../../app/modals';
import { attempt, showToast } from '../../app/toast';
import { getTodayStr } from '../../app/util';
import { Button } from '../../ui/Button';
import { Field, Input, PasswordInput, Select, SwitchRow, createForm } from '../../ui/form';
import { Modal } from '../../ui/Modal';

const MODAL_ID = 'create-user-modal';

interface NewUser {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  pays: boolean;
  status: string;
  memberSince: string;
  admin: boolean;
}
const empty = (): NewUser => ({ firstName: '', lastName: '', email: '', password: '', pays: true, status: 'vollverdiener', memberSince: getTodayStr(), admin: false });
const [form, setField, setForm] = createForm<NewUser>(empty());

export function openCreateUserModal() {
  setForm(draft => {
    Object.assign(draft, empty());
  });
  openModal(MODAL_ID);
}

async function submitCreateUser() {
  const firstName = form.firstName.trim();
  const lastName = form.lastName.trim();
  const email = form.email.trim();
  const password = form.password;
  if (!firstName || !lastName) return showToast(t('admin_user_name_required', 'Please enter first and last name.'), 'error');
  if (password && password.length < 6) return showToast(t('setup_admin_password_invalid', 'Password must be at least 6 characters long.'), 'error');
  const account = {
    firstName, lastName, email, password,
    pays: form.pays,
    admin: form.admin,
    status: form.status || 'vollverdiener',
    memberSince: form.memberSince || getTodayStr(),
    groups: ['Standard']
  };
  await attempt(
    async () => {
      await apiJson('/admin/users', 'POST', account, t('admin_user_create_failed_short', 'Creation failed'));
      await loadData();
      closeModal(MODAL_ID);
      showToast(t('toast_user_created', 'User created successfully'));
    },
    err => err.message || t('admin_user_create_failed', 'Failed to create the user')
  );
}

export function CreateUserDialog() {
  return (
    <Modal id={MODAL_ID} classic title={t('modal_create_user_title', 'Create New User')} maxWidth="480px">
      <form
        onSubmit={e => {
          e.preventDefault();
          void submitCreateUser();
        }}
      >
        <div class="flex gap-2.5">
          <Field label={t('label_first_name', 'First Name')} for="new-user-first-name" class="flex-1">
            <Input id="new-user-first-name" type="text" placeholder={t('label_first_name', 'First Name')} required value={form.firstName} onInput={e => setField('firstName', e.currentTarget.value)} />
          </Field>
          <Field label={t('label_last_name', 'Last Name')} for="new-user-last-name" class="flex-1">
            <Input id="new-user-last-name" type="text" placeholder={t('label_last_name', 'Last Name')} required value={form.lastName} onInput={e => setField('lastName', e.currentTarget.value)} />
          </Field>
        </div>
        <Field label={t('label_email_optional', 'Email Address (Optional)')} for="new-user-email">
          <Input id="new-user-email" type="email" placeholder="mail@example.com" value={form.email} onInput={e => setField('email', e.currentTarget.value)} />
        </Field>
        <Field label={t('label_password_optional', 'Password (Optional, min. 6 chars)')} for="new-user-password">
          <PasswordInput
            id="new-user-password"
            placeholder={t('admin_password_optional_placeholder', 'Password (optional)')}
            minlength="6"
            value={form.password}
            onInput={e => setField('password', e.currentTarget.value)}
          />
        </Field>
        <SwitchRow id="new-user-pays" class="my-[15px]" checked={form.pays} onChange={on => setField('pays', on)} label={t('label_pays', 'Pays membership fee (member)')} />
        <Show when={form.pays}>
          <div class="mt-2.5">
            <Field label={t('modal_person_status', 'Status')} for="new-user-status">
              <Select id="new-user-status" value={form.status} onChange={e => setField('status', e.currentTarget.value)}>
                <option value="vollverdiener">{t('status_vollverdiener', 'Full earner')}</option>
                <option value="geringverdiener">{t('status_geringverdiener', 'Low earner')}</option>
                <option value="keinverdiener">{t('status_keinverdiener', 'Non-earner')}</option>
                <option value="pausiert">{t('status_pausiert', 'Paused')}</option>
              </Select>
            </Field>
            <Field label={t('modal_person_start', 'Member Since')} for="new-user-start">
              <Input id="new-user-start" type="date" value={form.memberSince} onInput={e => setField('memberSince', e.currentTarget.value)} />
            </Field>
          </div>
        </Show>
        <SwitchRow id="new-user-admin" class="mb-5 mt-2.5" checked={form.admin} onChange={on => setField('admin', on)} label={t('label_system_admin', 'System Admin privileges')} />
        <div class="flex justify-end gap-2.5 pt-2.5">
          <Button variant="secondary" onClick={() => closeModal(MODAL_ID)}>
            {t('btn_cancel', 'Cancel')}
          </Button>
          <Button type="submit">{t('btn_create', 'Create User')}</Button>
        </div>
      </form>
    </Modal>
  );
}
