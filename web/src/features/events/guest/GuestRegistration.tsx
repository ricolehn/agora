// The registration card of a guest: the places taken, their own places on this device (cancel), then the form or why
// it is closed.
import { For, Show, createEffect, createSignal } from 'solid-js';
import { t } from '../../../app/i18n';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/form';
import { Icon } from '../../../ui/Icon';
import { RegBanner, RegBannerAction, RegistrationHead } from '../Registration';
import { GUEST_RETENTION_DAYS, cancelGuestRegistration, openGuestForm, submitGuestRegistration, type GuestView } from './guest';

/** The quiet text buttons of the page ("Member? Sign in", "Sign up another person"). */
export const GUEST_LINK =
  'inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-[0.86rem] font-bold text-primary no-underline hover:underline';

/** focus: opened with "Sign up another person" (the cursor goes to the name). */
function GuestForm(props: { full: boolean; focus: boolean }) {
  let form!: HTMLFormElement;
  let nameInput: HTMLInputElement | undefined;
  createEffect(
    () => props.focus,
    focus => {
      if (focus) nameInput?.focus();
    }
  );
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const field = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    setError(await submitGuestRegistration({ name: field('guest-reg-name'), email: field('guest-reg-email'), age: field('guest-reg-age'), website: field('guest-reg-hp') }));
    setBusy(false);
  };
  const label = 'flex min-w-0 flex-col gap-[5px] text-[0.74rem] font-bold text-text-secondary';
  return (
    <form ref={form} class="m-0 flex flex-col gap-2.5" onSubmit={e => void submit(e)}>
      <Show when={props.full}>
        <p class="m-0 flex items-center gap-1.5 text-[0.82rem] font-semibold text-[#d97706]">
          <Icon name="clock" size={14} />
          <span>{t('guest_reg_full', 'Fully booked: you can join the waiting list.')}</span>
        </p>
      </Show>
      <label class={label}>
        <span>{t('guest_reg_name', 'Full name')}</span>
        <Input
          ref={nameInput}
          name="guest-reg-name"
          id="guest-reg-name"
          class="font-medium"
          autocomplete="name"
          maxlength={100}
          required
          placeholder={t('guest_reg_name_ph', 'First and last name')}
        />
      </label>
      <div class="grid grid-cols-[minmax(0,1fr)_92px] gap-2.5">
        <label class={label}>
          <span>{t('guest_reg_email', 'E-mail address')}</span>
          <Input name="guest-reg-email" type="email" class="font-medium" autocomplete="email" maxlength={254} required />
        </label>
        <label class={label}>
          <span>{t('guest_reg_age', 'Age')}</span>
          <Input name="guest-reg-age" type="number" class="font-medium" inputmode="numeric" min="0" max="120" step="1" required />
        </label>
      </div>
      <input type="text" name="guest-reg-hp" class="pointer-events-none absolute -left-[10000px] size-px opacity-0" tabindex="-1" autocomplete="off" aria-hidden="true" />
      <Show when={error()}>
        <p class="m-0 text-[0.84rem] font-semibold text-danger" role="alert">
          {error()}
        </p>
      </Show>
      <p class="m-0 text-[0.76rem] leading-[1.45] text-text-secondary">
        {t('guest_reg_note', 'Your details are only used for this event and deleted {days} days after it.', { days: GUEST_RETENTION_DAYS })}{' '}
        <a href="/privacy" target="_blank" rel="noopener" class="font-semibold text-primary underline">
          {t('guest_privacy', 'Privacy')}
        </a>
      </p>
      <Button type="submit" block variant={props.full ? 'secondary' : 'primary'} disabled={busy()} class="gap-2">
        <Icon name={props.full ? 'clock' : 'check'} size={15} strokeWidth={2.5} />
        <span>{props.full ? t('events_reg_join_waitlist', 'Join the waiting list') : t('events_reg_register', 'Register')}</span>
      </Button>
    </form>
  );
}

export function GuestRegistration(props: { view: GuestView }) {
  const ev = () => props.view.event;
  return (
    <div class="rounded-[20px] border border-border-light bg-surface px-4 py-3.5 shadow-card">
      <RegistrationHead event={ev()} />
      <div class="mt-3.5 flex flex-col gap-2.5">
        <For each={props.view.mine}>
          {reg => (
            <RegBanner
              kind={reg.status === 'waitlist' ? 'waitlist' : 'registered'}
              icon={reg.status === 'waitlist' ? 'clock' : 'check'}
              title={reg.status === 'waitlist' ? t('guest_reg_waitlist', '{name} is on the waiting list', { name: reg.name }) : t('guest_reg_registered', '{name} is registered', { name: reg.name })}
              sub={reg.status === 'waitlist' ? t('events_reg_waitlist_hint', 'You will move up as soon as a place becomes free.') : t('events_reg_looking_forward', 'We look forward to seeing you!')}
              action={
                <Show when={!ev().isPast}>
                  <RegBannerAction onClick={() => void cancelGuestRegistration(reg.key)}>{t('events_reg_unregister', 'Unregister')}</RegBannerAction>
                </Show>
              }
            />
          )}
        </For>
        <Show
          when={ev().status !== 'cancelled'}
          fallback={<RegBanner kind="past" icon="x" title={t('guest_event_cancelled', 'This event was cancelled.')} />}
        >
          <Show
            when={!ev().isPast}
            fallback={<RegBanner kind="past" icon="clock" title={t('events_reg_closed', 'Registration has closed')} sub={t('events_reg_event_over', 'The event is over.')} />}
          >
            {/* The link was switched off: own places only, nobody new */}
            <Show when={props.view.token}>
              <Show
                when={!props.view.mine.length || props.view.formOpen}
                fallback={
                  <button type="button" class={[GUEST_LINK, 'self-start py-1']} onClick={openGuestForm}>
                    <Icon name="plus" size={15} strokeWidth={2.5} />
                    <span>{t('guest_reg_another', 'Sign up another person')}</span>
                  </button>
                }
              >
                <GuestForm full={!!ev().isFull} focus={props.view.formOpen} />
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
