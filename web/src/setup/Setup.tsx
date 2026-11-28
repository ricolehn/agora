import { For, Show, createSignal, onSettled } from 'solid-js';
import { t, uiLang } from '../app/i18n';
import { setSignedIn, store } from '../app/storage';
import { Button } from '../ui/Button';
import { Field, Input, Switch } from '../ui/form';
import './setup.css';
import { errorMessage } from '../app/api';

const TOTAL_STEPS = 3;

/** A short explanation under a field (the setup page's own size). */
function Hint(props: { children: string }) {
  return <div class="mt-[5px] mb-[15px] text-85 text-text-secondary">{props.children}</div>;
}
const today = () => new Date().toISOString().slice(0, 10);

interface AdminUser {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  memberSince: string;
}

/** The setup wizard: three steps, then POST /api/setup; the owner is signed in right away. */
export function Setup() {
  const [step, setStep] = createSignal(1);
  const [error, setError] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [smtpSecure, setSmtpSecure] = createSignal(true);
  let form!: HTMLFormElement;
  const field = (id: string) => form.elements.namedItem(id) as HTMLInputElement;

  onSettled(() => {
    document.title = t('setup_title', 'Setup - Agora');
  });

  function validateAppName(onError: (message: string) => void): string | null {
    const input = field('appName');
    input.setCustomValidity('');
    const appName = input.value.trim();
    if (!appName) {
      onError(t('setup_err_app_name', 'Please enter a name for the application.'));
      return null;
    }
    return appName;
  }

  function validateAdminUser(onError: (message: string) => void): AdminUser | null {
    const inputs = ['adminFirstName', 'adminLastName', 'adminEmail', 'adminPassword', 'adminPasswordConfirm', 'adminMemberSince'].map(field);
    const [firstInput, lastInput, emailInput, passInput, confirmInput, memberSinceInput] = inputs;
    inputs.forEach(input => input.setCustomValidity(''));
    const refuse = (input: HTMLInputElement, message: string, validity = message) => {
      onError(message);
      input.setCustomValidity(validity);
      input.reportValidity();
      return null;
    };
    const first = firstInput.value.trim();
    const last = lastInput.value.trim();
    const email = emailInput.value.trim();
    const password = passInput.value;
    if (!first) return refuse(firstInput, t('setup_err_first_name', 'Please enter the first name of the admin account.'));
    if (!last) return refuse(lastInput, t('setup_err_last_name', 'Please enter the last name of the admin account.'));
    if (!email || !emailInput.checkValidity()) return refuse(emailInput, t('setup_err_email', 'Please enter a valid email address for the admin account.'));
    if (!password || password.length < 6) return refuse(passInput, t('setup_err_password_len', 'Password must be at least 6 characters long.'));
    if (password !== confirmInput.value) return refuse(confirmInput, t('setup_err_password_match', 'Passwords do not match.'));
    return { firstName: first, lastName: last, email, password, memberSince: memberSinceInput.value.trim() || today() };
  }

  async function readOptionalLogoSvg(): Promise<string | null> {
    const file = field('setupLogo').files?.[0];
    if (!file) return null;
    const name = (file.name || '').toLowerCase();
    const type = (file.type || '').toLowerCase();
    if (!(name.endsWith('.svg') || type === 'image/svg+xml')) throw new Error(t('setup_err_svg_only', 'Please only upload SVG files.'));
    return file.text();
  }

  function nextStep() {
    if (step() === 1) {
      const ok = validateAppName(message => {
        const input = field('appName');
        input.setCustomValidity(message);
        input.reportValidity();
      });
      if (!ok) return;
    } else if (step() === 2) {
      // The messages show as the fields' own validity bubbles
      if (!validateAdminUser(() => {})) return;
    }
    if (step() < TOTAL_STEPS) setStep(step() + 1);
  }

  function prevStep() {
    if (step() > 1) {
      setStep(step() - 1);
      setError('');
    }
  }

  async function submitSetup() {
    const appName = validateAppName(setError);
    if (!appName) return setStep(1);
    const adminUser = validateAdminUser(setError);
    if (!adminUser) return setStep(2);
    const smtpHost = field('smtpHost').value.trim();
    const smtp = smtpHost
      ? {
          host: smtpHost,
          port: parseInt(field('smtpPort').value || '465', 10),
          secure: smtpSecure(),
          user: field('smtpUser').value.trim(),
          pass: field('smtpPass').value.trim()
        }
      : null;
    setSaving(true);
    setError('');
    try {
      const logoSvg = await readOptionalLogoSvg();
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Language': uiLang() },
        body: JSON.stringify({ appName, smtp, logoSvg, adminUser, defaultLanguage: uiLang() })
      });
      const data = (await res.json()) as { success?: boolean; token?: string; user?: unknown; error?: string };
      if (res.ok && data.success) {
        // The owner is signed in when the app opens
        if (data.token && data.user) {
          // Without storage the sign-in shows
          store('agora_auth_session', { token: data.token, user: data.user });
          setSignedIn(true);
        }
        window.location.href = '/';
        return;
      }
      throw new Error(data.error || t('setup_err_unknown', 'An unknown error has occurred.'));
    } catch (err) {
      setError(errorMessage(err) || t('setup_err_network', 'Network error while saving.'));
      setSaving(false);
    }
  }

  const stepClass = (n: number) => (step() === n ? 'block animate-[setup-in_0.3s_ease-in-out]' : 'hidden');

  return (
    <div class="mx-auto my-10 max-w-[600px] p-5">
      <div class="mb-[30px] text-center">
        <img src="/assets/church-logo.svg" alt="Logo" class="mx-auto mb-2.5 size-[60px]" />
        <h1 class="text-200 font-extrabold">{t('setup_heading', 'Initial Setup')}</h1>
        <p class="text-text-secondary">{t('setup_subheading', 'Agora configures PocketBase automatically in a Docker container.')}</p>
      </div>

      <div class="mb-[30px] flex justify-center gap-2.5" aria-hidden="true">
        <For each={[1, 2, 3]}>
          {n => (
            <div
              class={[
                'size-3 rounded-full transition-all duration-300',
                step() === n ? 'scale-[1.2] bg-primary' : n < step() ? 'bg-success' : 'bg-border'
              ]}
            />
          )}
        </For>
      </div>

      <form
        ref={form}
        novalidate
        onSubmit={e => {
          e.preventDefault();
          nextStep();
        }}
      >
        <div class={stepClass(1)}>
          <h2 class="mb-5 text-2xl font-bold">{t('setup_step1_title', '1. General Information')}</h2>
          <Field label={t('setup_app_name', 'Application Name')} for="appName">
            <Input type="text" id="appName" name="appName" placeholder={t('setup_app_name_placeholder', 'e.g., Agora...')} required />
            <Hint>{t('setup_app_name_desc', 'This name will be displayed in the app and in emails.')}</Hint>
          </Field>
          <Field label={t('setup_logo', 'Custom Logo (SVG, optional)')} for="setupLogo">
            <Input type="file" id="setupLogo" name="setupLogo" accept=".svg,image/svg+xml" />
            <Hint>{t('setup_logo_desc', 'Optionally, you can save your own SVG logo directly in the initial setup.')}</Hint>
          </Field>
          <Button type="submit" block class="mt-[30px]">
            {t('setup_btn_next', 'Next')}
          </Button>
        </div>

        <div class={stepClass(2)}>
          <h2 class="mb-5 text-2xl font-bold">{t('setup_step2_title', '2. Create Administrator Account (Owner)')}</h2>
          <p class="mb-5 text-90 text-text-secondary">{t('setup_step2_desc', 'This user is automatically created as Owner and System Administrator.')}</p>
          <div class="flex gap-[15px]">
            <Field class="flex-1" label={t('setup_admin_first_name', 'First Name')} for="adminFirstName">
              <Input type="text" id="adminFirstName" name="adminFirstName" placeholder={t('setup_admin_first_name_placeholder', 'e.g., John')} required />
            </Field>
            <Field class="flex-1" label={t('setup_admin_last_name', 'Last Name')} for="adminLastName">
              <Input type="text" id="adminLastName" name="adminLastName" placeholder={t('setup_admin_last_name_placeholder', 'e.g., Doe')} required />
            </Field>
          </div>
          <Field label={t('setup_admin_email', 'Email Address')} for="adminEmail">
            <Input type="email" id="adminEmail" name="adminEmail" placeholder={t('setup_admin_email_placeholder', 'e.g., admin@example.com')} required />
          </Field>
          <Field label={t('setup_admin_password', 'Password (min. 6 characters)')} for="adminPassword">
            <Input type="password" id="adminPassword" name="adminPassword" placeholder={t('setup_admin_password_placeholder', 'Enter password')} minlength="6" required autocomplete="new-password" />
          </Field>
          <Field label={t('setup_admin_password_confirm', 'Confirm password')} for="adminPasswordConfirm">
            <Input type="password" id="adminPasswordConfirm" name="adminPasswordConfirm" placeholder={t('setup_admin_password_confirm_placeholder', 'Confirm password')} minlength="6" required autocomplete="new-password" />
          </Field>
          <Field label={t('setup_admin_member_since', 'Member since')} for="adminMemberSince">
            <Input type="date" id="adminMemberSince" name="adminMemberSince" value={today()} required />
            <Hint>{t('setup_admin_member_since_desc', 'Date from which the membership is effective for the profile.')}</Hint>
          </Field>
          <div class="mt-[30px] flex gap-2.5">
            <Button variant="secondary" class="flex-1" onClick={prevStep}>
              {t('setup_btn_back', 'Back')}
            </Button>
            <Button type="submit" class="flex-[2]">
              {t('setup_btn_next', 'Next')}
            </Button>
          </div>
        </div>

        <div class={stepClass(3)}>
          <h2 class="mb-5 text-2xl font-bold">{t('setup_step3_title', '3. Email Settings (Optional)')}</h2>
          <p class="mb-5 text-90 text-text-secondary">{t('setup_step3_desc', 'These settings are required for email notifications. You can skip this step.')}</p>
          <Field label={t('setup_smtp_host', 'SMTP Server')} for="smtpHost">
            <Input type="text" id="smtpHost" name="smtpHost" placeholder={t('setup_smtp_host_placeholder', 'e.g., smtp.gmail.com')} />
          </Field>
          <div class="flex gap-[15px]">
            <Field class="flex-1" label={t('setup_smtp_port', 'Port')} for="smtpPort">
              <Input type="number" id="smtpPort" name="smtpPort" placeholder={t('setup_smtp_port_placeholder', 'e.g., 465')} />
            </Field>
            <div class="mb-3.5 flex flex-1 items-end gap-2.5 pb-2.5">
              <Switch id="smtpSecure" checked={smtpSecure()} onChange={setSmtpSecure} />
              <label for="smtpSecure" class="cursor-pointer font-semibold">
                {t('setup_smtp_secure', 'SSL/TLS')}
              </label>
            </div>
          </div>
          <Field label={t('setup_smtp_user', 'Username (email)')} for="smtpUser">
            <Input type="email" id="smtpUser" name="smtpUser" placeholder={t('setup_smtp_user_placeholder', 'e.g., no-reply@example.com')} autocomplete="off" />
          </Field>
          <Field label={t('setup_smtp_pass', 'Password')} for="smtpPass">
            <Input type="password" id="smtpPass" name="smtpPass" placeholder={t('setup_smtp_pass_placeholder', 'App password')} autocomplete="off" />
            <Hint>{t('setup_smtp_pass_desc', 'For Gmail, an app password is highly recommended.')}</Hint>
          </Field>
          <Show when={error()}>
            <div role="alert" class="mt-[15px] text-center font-bold text-danger">
              {error()}
            </div>
          </Show>
          <div class="mt-[30px] flex gap-2.5">
            <Button variant="secondary" class="flex-1" onClick={prevStep}>
              {t('setup_btn_back', 'Back')}
            </Button>
            <Button class="flex-[2]" busy={saving()} busyText={t('setup_btn_saving', 'Saving...')} onClick={() => void submitSetup()}>
              {t('setup_btn_save_start', 'Save & Start')}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
