// The sign-in and registration screen. (First working version; its look follows the previous login dialog.)
import { Show, createSignal } from 'solid-js';
import { attemptLogin, attemptRegister, authError, authView, showAuthForm } from '../app/auth';
import { appName } from '../app/config';
import { t } from '../app/i18n';
import { Button } from '../ui/Button';
import { Field, Input, PasswordInput } from '../ui/form';
import { PillTabs } from '../ui/PillTabs';

export function Login() {
  const [busy, setBusy] = createSignal(false);
  let form!: HTMLFormElement;
  const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | null)?.value.trim() || '';
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (authView() === 'login') await attemptLogin(value('login-email'), (form.elements.namedItem('login-password') as HTMLInputElement).value);
      else
        await attemptRegister({
          code: value('reg-code'),
          email: value('reg-email'),
          firstName: value('reg-firstname'),
          lastName: value('reg-lastname'),
          password: (form.elements.namedItem('reg-pass1') as HTMLInputElement).value,
          password2: (form.elements.namedItem('reg-pass2') as HTMLInputElement).value
        });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div id="login-modal" class="fixed inset-0 z-[3000] flex items-center justify-center bg-bg p-5">
      <form ref={form} class="w-full max-w-[420px] rounded-[28px] bg-surface p-7 shadow-card-lg" onSubmit={submit}>
        <div class="mb-5 text-center">
          <img src="/assets/church-logo.svg" alt="" class="mx-auto mb-3 size-16" />
          <h1 class="text-2xl font-extrabold">{appName()}</h1>
          <p class="text-text-secondary">{authView() === 'login' ? t('login_subtitle', 'Sign in to continue') : t('register_subtitle', 'Create a new account')}</p>
        </div>
        <PillTabs
          class="mb-5"
          value={authView() === 'register' ? 'register' : 'login'}
          onChange={v => showAuthForm(v === 'login')}
          options={[
            { value: 'login', label: t('login_btn', 'Login') },
            { value: 'register', label: t('register_btn', 'Register') }
          ]}
        />
        <Show
          when={authView() === 'login'}
          fallback={
            <>
              <Field label={t('reg_code_label', 'Registration code')}><Input name="reg-code" inputmode="numeric" autocomplete="off" /></Field>
              <Field label={t('email', 'Email')}><Input name="reg-email" type="email" autocomplete="email" /></Field>
              <div class="grid grid-cols-2 gap-3">
                <Field label={t('first_name', 'First name')}><Input name="reg-firstname" autocomplete="given-name" /></Field>
                <Field label={t('last_name', 'Last name')}><Input name="reg-lastname" autocomplete="family-name" /></Field>
              </div>
              <Field label={t('password', 'Password')}><PasswordInput name="reg-pass1" autocomplete="new-password" /></Field>
              <Field label={t('password_repeat', 'Repeat password')}><PasswordInput name="reg-pass2" autocomplete="new-password" /></Field>
            </>
          }
        >
          <Field label={t('email', 'Email')}><Input name="login-email" type="email" autocomplete="email" /></Field>
          <Field label={t('password', 'Password')}><PasswordInput name="login-password" autocomplete="current-password" /></Field>
        </Show>
        <Show when={authError()}>
          <div id="auth-error" class="mb-3 rounded-xl bg-danger/10 p-3 text-sm text-danger">{authError()}</div>
        </Show>
        <Button type="submit" block busy={busy()} busyText={t('auth_logging_in', 'Signing in...')}>
          {authView() === 'login' ? t('login_btn', 'Login') : t('register_btn', 'Register')}
        </Button>
      </form>
    </div>
  );
}
