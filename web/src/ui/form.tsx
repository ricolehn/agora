import type { JSX } from '@solidjs/web';
import { Show, createSignal, omit } from 'solid-js';
import { t } from '../app/i18n';
import { Icon } from './Icon';

/** A labelled form field (.form-group with .form-label). */
export function Field(props: { label?: JSX.Element; for?: string; hint?: JSX.Element; class?: string; children?: JSX.Element }) {
  return (
    <div class={['mb-3.5', props.class]}>
      <Show when={props.label}>
        <label for={props.for} class="mb-1.5 block text-[0.85rem] font-semibold text-text-secondary">
          {props.label}
        </label>
      </Show>
      {props.children}
      <Show when={props.hint}>
        <div class="mt-1.5 text-[0.75rem] leading-snug text-text-secondary">{props.hint}</div>
      </Show>
    </div>
  );
}

const CONTROL =
  'w-full rounded-xl border border-[rgba(48,38,26,0.14)] bg-surface px-3.5 py-3 text-[0.95rem] text-text outline-none transition ' +
  'hover:border-[rgba(48,38,26,0.24)] focus:border-primary focus:shadow-ring dark:border-white/12 placeholder:text-text-secondary/70';

/** A text input (.form-input). invalid: the red error frame. */
export function Input(props: JSX.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const rest = omit(props, 'class', 'invalid');
  return <input class={[CONTROL, { '!border-danger': !!props.invalid }, props.class]} {...rest} />;
}

/** A multi-line input (.form-input). */
export function Textarea(props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  const rest = omit(props, 'class', 'invalid');
  return <textarea class={[CONTROL, 'resize-y', { '!border-danger': !!props.invalid }, props.class]} {...rest} />;
}

/** A select (.form-select). */
export function Select(props: JSX.SelectHTMLAttributes<HTMLSelectElement>) {
  const rest = omit(props, 'class', 'children');
  return (
    <select class={[CONTROL, 'appearance-none pr-9', props.class]} {...rest}>
      {props.children}
    </select>
  );
}

/** A password input with the eye button that shows / hides it. */
export function PasswordInput(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = createSignal(false);
  const rest = omit(props, 'class', 'type');
  return (
    <div class="relative">
      <input type={visible() ? 'text' : 'password'} class={[CONTROL, 'pr-12', props.class]} {...rest} />
      <button
        type="button"
        class="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-text-secondary"
        aria-label={visible() ? t('password_hide', 'Hide password') : t('password_show', 'Show password')}
        onClick={() => setVisible(v => !v)}
      >
        <Icon name={visible() ? 'eyeOff' : 'eye'} size={20} />
      </button>
    </div>
  );
}

/** An on/off switch (.switch). */
export function Switch(props: { checked: boolean; onChange: (checked: boolean) => void; id?: string; disabled?: boolean; 'aria-label'?: string; class?: string }) {
  return (
    <label class={['relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center', { 'cursor-not-allowed opacity-60': !!props.disabled }, props.class]}>
      <input
        id={props.id}
        type="checkbox"
        class="peer sr-only"
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props['aria-label']}
        onChange={e => props.onChange(e.currentTarget.checked)}
      />
      <span class="absolute inset-0 rounded-full bg-border transition peer-checked:bg-primary" />
      <span class="absolute left-1 size-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
    </label>
  );
}
