// The sign-in and registration screen (the old #login-modal): the community's logo and name over the page's soft
// brand glow, the two forms behind pill tabs, the error below. app/auth.ts decides which form shows and does the work.
import { Show, createSignal } from 'solid-js';
import { attemptLogin, attemptRegister, authError, authView, showAuthForm } from '../app/auth';
import { appName, logoSrc } from '../app/config';
import { t } from '../app/i18n';
import { signInBack } from '../app/shell';
import { Button } from '../ui/Button';
import { Input, PasswordInput } from '../ui/form';
import { Icon } from '../ui/Icon';
import { PillTabs } from '../ui/PillTabs';

// The values as typed (the previous version did not trim them either)
const field = (form: HTMLFormElement, id: string) => (form.elements.namedItem(id) as HTMLInputElement | null)?.value ?? '';

function LoginForm() {
  const [busy, setBusy] = createSignal(false);
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    setBusy(true);
    try {
      await attemptLogin(field(form, 'login-email'), field(form, 'login-password'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form id="login-form" onSubmit={e => void submit(e)}>
      <label for="login-email" class="sr-only">
        {t('col_email', 'Email')}
      </label>
      <Input
        icon={<Icon name="mail" size={20} />}
        wrapperClass="mb-3"
        type="email"
        id="login-email"
        name="login-email"
        placeholder={t('col_email', 'Email')}
        autocomplete="username"
        required
      />
      <label for="login-password" class="sr-only">
        {t('smtp_pass', 'Password')}
      </label>
      <PasswordInput
        icon={<Icon name="lock" size={20} />}
        wrapperClass="mb-6"
        id="login-password"
        name="login-password"
        placeholder={t('smtp_pass', 'Password')}
        autocomplete="current-password"
        required
      />
      <Button type="submit" id="btn-login" block busy={busy()} busyText={t('auth_logging_in', 'Signing in...')}>
        {t('btn_login', 'Sign in')}
      </Button>
      {/* Opened from a shared event's page: back to the event without signing in */}
      <Show when={signInBack()}>
        {back => (
          <button
            type="button"
            class="mx-auto mt-3.5 flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-[0.86rem] font-bold text-primary no-underline hover:underline"
            onClick={() => back()()}
          >
            <Icon name="arrowLeft" size={15} strokeWidth={2.5} />
            <span>{t('guest_back_to_event', 'Back to the event')}</span>
          </button>
        )}
      </Show>
    </form>
  );
}

function RegisterForm() {
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const value = (id: string) => field(form, id);
    void attemptRegister({
      code: value('reg-code'),
      email: value('reg-email'),
      firstName: value('reg-firstname'),
      lastName: value('reg-lastname'),
      password: value('reg-pass1'),
      password2: value('reg-pass2')
    });
  };
  return (
    <form id="register-form" onSubmit={submit}>
      <div class="mb-4 rounded-[12px] border border-dashed border-border bg-surface-alt p-3 text-center text-[0.9rem]">
        <p id="reg-code-desc" class="text-text-secondary">
          {t('register_code_desc', 'Please enter the current 6-digit registration code.')}
        </p>
      </div>
      <label for="reg-code" class="sr-only">
        {t('invite_title', 'Registration code')}
      </label>
      <Input
        icon={<Icon name="box" size={20} />}
        wrapperClass="mb-3"
        type="text"
        id="reg-code"
        name="reg-code"
        placeholder={t('register_code_placeholder', '6-digit code')}
        maxlength={6}
        inputmode="numeric"
        pattern="[0-9]*"
        required
        autocomplete="off"
        aria-describedby="reg-code-desc"
      />
      <label for="reg-email" class="sr-only">
        {t('col_email', 'Email')}
      </label>
      <Input
        icon={<Icon name="mail" size={20} />}
        wrapperClass="mb-3"
        type="email"
        id="reg-email"
        name="reg-email"
        placeholder={t('col_email', 'Email')}
        autocomplete="username"
        required
      />
      <div class="mb-3 flex gap-3">
        <div class="flex-1">
          <label for="reg-firstname" class="sr-only">
            {t('label_first_name', 'First Name')}
          </label>
          <Input
            icon={<Icon name="user" size={20} />}
            type="text"
            id="reg-firstname"
            name="reg-firstname"
            placeholder={t('setup_admin_first_name', 'First Name')}
            autocomplete="given-name"
            required
          />
        </div>
        <div class="flex-1">
          <label for="reg-lastname" class="sr-only">
            {t('label_last_name', 'Last Name')}
          </label>
          <Input
            type="text"
            id="reg-lastname"
            name="reg-lastname"
            placeholder={t('setup_admin_last_name', 'Last Name')}
            autocomplete="family-name"
            required
          />
        </div>
      </div>
      <label for="reg-pass1" class="sr-only">
        {t('auth_password_min', 'Password (min. 6 characters)')}
      </label>
      <PasswordInput
        icon={<Icon name="lock" size={20} />}
        wrapperClass="mb-3"
        id="reg-pass1"
        name="reg-pass1"
        placeholder={t('register_pass_placeholder', 'Password (min 6)')}
        autocomplete="new-password"
        required
        minlength={6}
      />
      <label for="reg-pass2" class="sr-only">
        {t('auth_password_repeat', 'Repeat password')}
      </label>
      <PasswordInput
        icon={<Icon name="lock" size={20} />}
        wrapperClass="mb-6"
        id="reg-pass2"
        name="reg-pass2"
        placeholder={t('setup_admin_password_confirm', 'Confirm password')}
        autocomplete="new-password"
        required
        minlength={6}
      />
      <Button type="submit" block>
        {t('register_tab', 'Register')}
      </Button>
    </form>
  );
}

export function Login() {
  const isLogin = () => authView() !== 'register';
  return (
    <div
      id="login-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-app-name"
      class="fixed inset-0 flex items-center justify-center bg-bg bg-[radial-gradient(at_0%_0%,rgba(var(--brand-rgb),0.15)_0px,transparent_50%),radial-gradient(at_100%_100%,rgba(16,185,129,0.15)_0px,transparent_50%)]"
      // Over a shared event's page the sign-in comes in front of its dialog
      style={{ 'z-index': signInBack() ? '2600' : '2000' }}
    >
      <div
        class={[
          'max-h-[88vh] w-[90%] max-w-[400px] overflow-y-auto rounded-[20px] bg-surface px-5 pb-5 text-text shadow-[var(--shadow-lg),0_0_0_1px_var(--hairline)]',
          'dark:border dark:border-border dark:shadow-[0_20px_40px_-10px_rgba(0,0,0,0.6),0_2px_12px_rgba(0,0,0,0.35)]'
        ]}
      >
        <div class="mb-6 pt-2.5 text-center">
          <div class="mb-2 flex items-center justify-center gap-3">
            <img src={logoSrc()} alt="App Logo" id="login-app-logo" class="h-10 w-auto" />
            <h2 id="login-app-name" class="m-0 bg-gradient-primary bg-clip-text text-[2rem] font-extrabold [-webkit-text-fill-color:transparent]">
              {appName()}
            </h2>
          </div>
          <p id="auth-subtitle" class="m-0 text-[0.9rem] font-medium text-text-secondary">
            {isLogin() ? t('login_subtitle', 'Sign in to continue') : t('register_subtitle', 'Create a new account')}
          </p>
        </div>
        <PillTabs
          class="mb-6"
          tabClass="flex-1 p-[10px] text-[0.95rem]"
          value={isLogin() ? 'login' : 'register'}
          onChange={view => showAuthForm(view === 'login')}
          options={[
            { value: 'login', label: t('login_tab', 'Login'), id: 'btn-show-login' },
            { value: 'register', label: t('register_tab', 'Register'), id: 'btn-show-register' }
          ]}
        />
        {/* Both forms stay in the page (as before): switching between them keeps what was typed */}
        <div class={{ hidden: !isLogin() }}>
          <LoginForm />
        </div>
        <div class={{ hidden: isLogin() }}>
          <RegisterForm />
        </div>
        <Show when={authError()}>
          <div id="auth-error" class="mt-[15px] text-center font-bold text-danger">
            {authError()}
          </div>
        </Show>
      </div>
    </div>
  );
}
