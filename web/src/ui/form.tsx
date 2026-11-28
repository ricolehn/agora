import type { JSX } from '@solidjs/web';
import { Show, createSignal, createStore, omit, useContext } from 'solid-js';
import { t } from '../app/i18n';
import { DialogBodyContext } from './context';
import { Icon } from './Icon';

// Named Tailwind text sizes also set a line height: only arbitrary sizes here, the line height stays the browser's.

/**
 * The fields of a form as a store, with a setter for one field (an input's change) and the store's own setter for
 * many at a time (filling the form). Like every write they show with Solid's next update.
 */
export function createForm<T extends object>(initial: T) {
  // A form is a record of values, never a function: Solid's typing of createStore cannot tell that for any T
  const [form, setForm] = createStore<T>(initial as Exclude<T, Function>);
  const setField = <K extends keyof T>(key: K, value: T[K]) => {
    setForm(draft => {
      (draft as T)[key] = value;
    });
  };
  return [form, setField, setForm] as const;
}

/** A field label (.form-label); smaller inside a dialog's body. */
export function Label(props: { for?: string; id?: string; class?: string; children?: JSX.Element }) {
  const inDialog = useContext(DialogBodyContext);
  return (
    <label
      for={props.for}
      id={props.id}
      class={['block font-semibold text-text-secondary', inDialog ? 'mb-[3px] text-[0.78rem]' : 'mb-1.5 text-[0.85rem]', props.class]}
    >
      {props.children}
    </label>
  );
}

/** A labelled form field (.form-group with .form-label): 15px below it on a page, none inside a dialog's body. */
export function Field(props: { label?: JSX.Element; for?: string; hint?: JSX.Element; class?: string; labelClass?: string; children?: JSX.Element }) {
  const inDialog = useContext(DialogBodyContext);
  return (
    <div class={[inDialog ? 'weak:mb-0' : 'weak:mb-[15px]', props.class]}>
      <Show when={props.label}>
        <Label for={props.for} class={props.labelClass}>
          {props.label}
        </Label>
      </Show>
      {props.children}
      <Show when={props.hint}>
        <div class="mt-[5px] text-[0.75rem] leading-[1.35] text-text-secondary">{props.hint}</div>
      </Show>
    </div>
  );
}

// .form-input / .form-select: a 1px hairline on the soft fill, a clear focus ring. The size and the fill are weak
// (zero specificity): a caller's class for them wins without "!"
const CONTROL =
  'weak:w-full text-text outline-none [transition:border-color_0.2s_var(--ease),box-shadow_0.2s_var(--ease),background-color_0.2s_var(--ease)] ' +
  'hover:not-focus:border-[rgba(48,38,26,0.24)] focus:border-primary dark:border-white/12 dark:hover:not-focus:border-[rgba(48,38,26,0.24)] dark:focus:border-primary';
const ON_PAGE = 'weak:rounded-[12px] border weak:border-[rgba(48,38,26,0.14)] weak:bg-surface-alt weak:p-3 weak:text-[1rem] focus:bg-surface focus:shadow-ring';
// Inside a dialog's body: smaller, on the dialog's surface, a finer ring
const IN_DIALOG =
  'weak:rounded-[9px] border-[1.5px] border-border weak:bg-surface weak:px-[11px] weak:py-2 weak:text-[0.9rem] focus:shadow-[0_0_0_2px_rgba(var(--brand-rgb),0.12)]';
// .input-error: red frame and a short shake (set it again to shake again)
const INVALID = '!border-danger !bg-[rgba(239,68,68,0.05)] animate-shake';

/** The classes of a text field (.form-input), for inputs the components below do not cover. */
export function controlClass(opts: { inDialog?: boolean; invalid?: boolean } = {}): JSX.ClassValue {
  return [CONTROL, opts.inDialog ? IN_DIALOG : ON_PAGE, { [INVALID]: !!opts.invalid }];
}

/** A symbol inside the field on the left (.input-with-icon): 20px icons, the field text starts at 56px. */
function WithIcon(props: { icon?: JSX.Element; class?: string; children: JSX.Element }) {
  return (
    <Show when={props.icon} fallback={props.children}>
      <div class={['group relative', props.class]}>
        <span class="pointer-events-none absolute top-1/2 left-3.5 z-[2] flex -translate-y-1/2 items-center justify-center text-text-secondary transition-colors duration-200 group-focus-within:text-primary">
          {props.icon}
        </span>
        {props.children}
      </div>
    </Show>
  );
}

export type InputProps = JSX.InputHTMLAttributes<HTMLInputElement> & {
  /** The red error frame (.input-error). */
  invalid?: boolean;
  /** A symbol on the left inside the field (e.g. <Icon name="mail" size={20} />). */
  icon?: JSX.Element;
  /** Classes of the wrapper when there is an icon. */
  wrapperClass?: string;
};

/** A text input (.form-input). */
export function Input(props: InputProps) {
  const inDialog = useContext(DialogBodyContext);
  const rest = omit(props, 'class', 'invalid', 'icon', 'wrapperClass');
  return (
    <WithIcon icon={props.icon} class={props.wrapperClass}>
      <input class={[controlClass({ inDialog, invalid: props.invalid }), { 'pl-14': !!props.icon }, props.class]} {...rest} />
    </WithIcon>
  );
}

/** A multi-line input (.form-input). */
export function Textarea(props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  const inDialog = useContext(DialogBodyContext);
  const rest = omit(props, 'class', 'invalid');
  return <textarea class={[controlClass({ inDialog, invalid: props.invalid }), 'resize', props.class]} {...rest} />;
}

/** A select (.form-select) with the browser's own arrow, as before. */
export function Select(props: JSX.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  const inDialog = useContext(DialogBodyContext);
  const rest = omit(props, 'class', 'children', 'invalid');
  return (
    <select class={[controlClass({ inDialog, invalid: props.invalid }), props.class]} {...rest}>
      {props.children}
    </select>
  );
}

/** A password input with the eye button that shows / hides it (.password-wrapper, .password-toggle). */
export function PasswordInput(props: Omit<InputProps, 'type'>) {
  const inDialog = useContext(DialogBodyContext);
  const [visible, setVisible] = createSignal(false);
  const rest = omit(props, 'class', 'invalid', 'icon', 'wrapperClass');
  return (
    <div class={['relative', { group: !!props.icon }, props.wrapperClass]}>
      <Show when={props.icon}>
        <span class="pointer-events-none absolute top-1/2 left-3.5 z-[2] flex -translate-y-1/2 items-center justify-center text-text-secondary transition-colors duration-200 group-focus-within:text-primary">
          {props.icon}
        </span>
      </Show>
      <input
        type={visible() ? 'text' : 'password'}
        class={[controlClass({ inDialog, invalid: props.invalid }), 'pr-10', { 'pl-14': !!props.icon }, props.class]}
        {...rest}
      />
      <button
        type="button"
        class="absolute top-1/2 right-3 z-[2] flex -translate-y-1/2 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-text-secondary"
        aria-label={visible() ? t('password_hide', 'Hide password') : t('password_show', 'Show password')}
        onClick={() => setVisible(v => !v)}
      >
        <Icon name={visible() ? 'eyeOff' : 'eye'} size={20} />
      </button>
    </div>
  );
}

/** An on/off switch (.switch with its .slider); size "sm" is the one in dialog rows (.modal-switch-row). */
/**
 * A switch with its label beside it (a .form-group row); [small]: the small switch and label of the finance dialogs.
 * The space below it yields to `class` (15px; none when small).
 */
export function SwitchRow(props: { id: string; checked: boolean; onChange: (checked: boolean) => void; label: JSX.Element; small?: boolean; class?: string }) {
  return (
    <div class={['flex items-center', props.small ? 'gap-2 py-0.5' : 'gap-2.5', props.class ?? (props.small ? '' : 'mb-[15px]')]}>
      <Switch id={props.id} size={props.small ? 'sm' : undefined} checked={props.checked} onChange={checked => props.onChange(checked)} />
      <label for={props.id} class={['m-0 cursor-pointer font-semibold', { 'text-[0.85rem] text-text': props.small }]}>
        {props.label}
      </label>
    </div>
  );
}

export function Switch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
  name?: string;
  disabled?: boolean;
  size?: 'md' | 'sm';
  'aria-label'?: string;
  'aria-labelledby'?: string;
  class?: string;
}) {
  const small = () => props.size === 'sm';
  return (
    // Disabled looks the same, as before (it was only disabled for the moment a change is saved)
    <label class={['relative weak:inline-block shrink-0', small() ? 'h-6 w-[42px]' : 'h-7 w-[50px]', props.class]}>
      <input
        id={props.id}
        name={props.name}
        type="checkbox"
        role="switch"
        class="peer absolute size-0 opacity-0"
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        onChange={e => props.onChange(e.currentTarget.checked)}
      />
      <span class="absolute inset-0 cursor-pointer rounded-[34px] bg-border transition-all duration-[400ms] ease-[ease] peer-checked:bg-transparent peer-checked:bg-gradient-primary peer-focus-visible:shadow-ring" />
      <span
        class={[
          'pointer-events-none absolute rounded-full bg-white transition-all duration-[400ms] ease-[ease]',
          small() ? 'bottom-[3px] left-[3px] size-[18px] peer-checked:translate-x-[18px]' : 'bottom-1 left-1 size-5 peer-checked:translate-x-[22px]'
        ]}
      />
    </label>
  );
}
