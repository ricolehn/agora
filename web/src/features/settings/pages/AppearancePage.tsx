import { For, Show } from 'solid-js';
import { langSetting, loadLanguage, t } from '../../../app/i18n';
import { setTheme, themeSetting } from '../../../app/theme';
import { Card } from '../../../ui/Card';
import { Icon, type IconName } from '../../../ui/Icon';
import { Pill, Pills } from '../../../ui/PillTabs';

interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

/** A choice as pill tabs (like the Android app): a radio group, the arrow keys move between the choices. */
function Choice<T extends string>(props: { id: string; label: string; value: T; options: ChoiceOption<T>[]; onChange: (value: T) => void; class?: string }) {
  const choose = (value: T) => {
    if (value !== props.value) props.onChange(value);
  };
  return (
    <div class={['mb-[15px]', props.class]}>
      <div id={`${props.id}-label`} class="mb-2 text-[0.72rem] font-extrabold uppercase tracking-[0.06em] text-text-secondary">
        {props.label}
      </div>
      <Pills kind="radio" aria-labelledby={`${props.id}-label`} class="flex gap-1 rounded-[14px] border border-border-light bg-surface-alt p-1">
        {/* Keyed by value: a new language keeps the pills (and the focus on them) */}
        <For each={props.options} keyed={option => option.value}>
          {option => (
            <Pill
              chosen={props.value === option().value}
              class={[
                'inline-flex min-h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[10px] px-2.5 py-2 text-[0.88rem] font-bold',
                'transition-[background-color,color,box-shadow] duration-200 ease-[ease] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                props.value === option().value
                  ? 'bg-surface text-primary shadow-[0_1px_2px_rgba(28,25,23,0.08),0_4px_12px_-6px_rgba(28,25,23,0.25)] dark:bg-bg'
                  : 'text-text-secondary hover:text-text'
              ]}
              onSelect={() => choose(option().value)}
            >
              <Show when={option().icon}>{icon => <Icon name={icon()} size={16} />}</Show>
              <span class="truncate">{option().label}</span>
            </Pill>
          )}
        </For>
      </Pills>
    </div>
  );
}

/** Colour scheme and language. */
export function AppearancePage() {
  return (
    <Card bodyClass="pt-5">
      <Choice
        id="settings-theme"
        label={t('theme_title', 'Colour scheme')}
        value={themeSetting()}
        onChange={setTheme}
        options={[
          { value: 'system', label: t('theme_system', 'System'), icon: 'monitor' },
          { value: 'light', label: t('theme_light', 'Light'), icon: 'sun' },
          { value: 'dark', label: t('theme_dark', 'Dark'), icon: 'moon' }
        ]}
      />
      <Choice
        id="settings-language"
        class="mt-5"
        label={t('settings_language', 'Language')}
        value={langSetting()}
        onChange={lang => void loadLanguage(lang)}
        options={[
          { value: 'system', label: t('lang_system', 'System') },
          { value: 'de', label: 'Deutsch' },
          { value: 'en', label: 'English' }
        ]}
      />
    </Card>
  );
}
