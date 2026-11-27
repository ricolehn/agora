// Deleting an account without the app (app store requirement): sign in with e-mail and password, then delete.
// The page is English: the server is asked for English messages as well.
const form = document.getElementById('delete-form') as HTMLFormElement;
const msg = document.getElementById('msg')!;
const submit = document.getElementById('submit') as HTMLButtonElement;
const show = (text: string, ok: boolean) => {
  msg.textContent = text;
  msg.classList.toggle('text-[#10b981]', ok);
  msg.classList.toggle('text-danger', !ok);
};
const headers = { 'Content-Type': 'application/json', 'Accept-Language': 'en' };

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!confirm('Your account and your personal data will be deleted permanently. Continue?')) return;
  submit.disabled = true;
  show('', true);
  const email = (document.getElementById('email') as HTMLInputElement).value.trim();
  const password = (document.getElementById('password') as HTMLInputElement).value;
  try {
    const login = await fetch('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ email, password }) });
    const auth = (await login.json().catch(() => ({}))) as { token?: string };
    if (!login.ok || !auth.token) throw new Error('The e-mail address or password is wrong.');
    const res = await fetch('/api/auth/delete-account', {
      method: 'POST',
      headers: { ...headers, Authorization: 'Bearer ' + auth.token },
      body: JSON.stringify({ password })
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error || 'The account could not be deleted.');
    form.reset();
    show('Your account has been deleted.', true);
  } catch (err) {
    show(err instanceof Error ? err.message : String(err), false);
  }
  submit.disabled = false;
});
