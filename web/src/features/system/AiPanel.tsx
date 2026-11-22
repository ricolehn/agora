// System settings → AI support: on/off, the provider and its address, key and model, and the effort per question.
import { For, Show } from 'solid-js';
import { t } from '../../app/i18n';
import { Button } from '../../ui/Button';
import { Field, Input, PasswordInput, Select } from '../../ui/form';
import { Icon } from '../../ui/Icon';
import { aiForm, aiModels, countAiEdit, providersSupported, saveAiConfig, selectAiProvider, serverNote, setAiField, type AiEffort } from './ai';
import { Help, SettingsGroup, SUPER_ADMIN_BTN, SwitchRow } from './parts';

// What each effort level costs: only the explanation of the chosen one shows
const EFFORT_HINTS: Record<AiEffort, [string, string]> = {
  low: ['ai_effort_low_desc', 'Only the summary every question gets (the newest entries and the totals): one request per question, the cheapest. Questions about older single entries are answered from the totals.'],
  medium: ['ai_effort_medium_desc', 'The AI looks up the full history when a question needs it: up to 4 lookups with small results. An ordinary question costs a little more than on Low (the lookups are described with it); a question with lookups about twice as much, because it goes to the AI again with the results – with several rounds up to 5 times.'],
  high: ['ai_effort_high_desc', 'Up to 10 lookups with larger results, and more thinking for models that support it. For detailed evaluations: a question with lookups costs about 2 to 5 times as much as on Low, at most about 11 times, plus the thinking of the model.'],
  xhigh: ['ai_effort_xhigh_desc', 'Up to 15 lookups with large results, and very deep thinking (Claude and OpenAI: xhigh). For extensive evaluations; considerably more expensive than High.'],
  max: ['ai_effort_max_desc', "Up to 20 lookups with the largest results, and Claude's deepest thinking (OpenAI: xhigh). The most expensive level – for the hardest questions only."]
};

/** Why the server cannot store the provider (a server of an earlier version, or the database upgrade waits). */
function AiServerNote() {
  const text = () => {
    const note = serverNote();
    if (!note) return '';
    return note.upgradeReason !== null
      ? t(
          'ai_server_upgrade_pending',
          'The server still runs the previous version of Agora: the upgrade of its database could not finish. Until it has, only an OpenAI-compatible service can be used and the effort level is not stored. The next start of the server tries the upgrade again; the server log tells more. Reason: {reason}',
          { reason: note.upgradeReason || t('error_unknown', 'Unknown error') }
        )
      : t('ai_server_outdated', 'The server runs an earlier version of Agora: only an OpenAI-compatible service can be used and the effort level is not stored. Update the server to choose Anthropic, Google or OpenAI.');
  };
  return (
    <div
      id="super-admin-ai-server-note"
      role="status"
      hidden={!serverNote()}
      class="mb-[15px] flex items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] px-3 py-[9px] text-[0.8rem] leading-[1.45] text-text"
    >
      <Icon name="alert" size={14} strokeWidth={2.4} class="mt-0.5 shrink-0 text-warning" />
      <span>{text()}</span>
    </div>
  );
}

export function AiPanel() {
  return (
    // Every input and change in the form counts as an edit: a reload in the background keeps them (ai.ts)
    <div onInput={countAiEdit} onChange={countAiEdit}>
      <SettingsGroup
        title={t('superadmin_ai_title', 'AI Support Settings')}
        desc={t('superadmin_ai_desc', 'Connects the application to an AI provider: Anthropic (Claude), Google (Gemini), OpenAI (ChatGPT) or any OpenAI-compatible service, a local model (Ollama) too.')}
      >
        <SwitchRow id="super-admin-ai-enabled" checked={aiForm.enabled} onChange={on => setAiField('enabled', on)} label={t('ai_enabled', 'Enable AI Support')} />

        <AiServerNote />

        <Field label={t('ai_provider', 'Provider')} for="super-admin-ai-provider">
          <Select id="super-admin-ai-provider" value={aiForm.provider} disabled={!providersSupported()} onChange={e => selectAiProvider(e.currentTarget.value)}>
            <option value="anthropic">{t('ai_provider_anthropic', 'Anthropic (Claude)')}</option>
            <option value="gemini">{t('ai_provider_gemini', 'Google (Gemini)')}</option>
            <option value="openai">{t('ai_provider_openai', 'OpenAI (ChatGPT)')}</option>
            <option value="custom">{t('ai_provider_custom', 'OpenAI-compatible (own address)')}</option>
          </Select>
          <Help>
            {t(
              'ai_provider_desc',
              'Anthropic, Google and OpenAI are connected through their own interfaces, their address is already set: only the API key and the model are needed. The AI\'s thoughts show in the chat and the effort level takes full effect. "OpenAI-compatible" is for other services and local models (Ollama, LM Studio, OpenRouter …) at an address of your own.'
            )}
          </Help>
        </Field>

        <Show when={aiForm.provider === 'custom'}>
          <Field label={t('ai_base_url', 'Base URL')} for="super-admin-ai-base-url">
            <Input id="super-admin-ai-base-url" type="url" placeholder="https://api.openai.com/v1" value={aiForm.baseUrl} onInput={e => setAiField('baseUrl', e.currentTarget.value)} />
            <Help class="mt-1">{t('ai_base_url_desc', 'Leave blank for OpenAI default. For Ollama: http://localhost:11434/v1')}</Help>
          </Field>
        </Show>

        <Field label={t('ai_api_key', 'API Key')} for="super-admin-ai-api-key">
          <PasswordInput id="super-admin-ai-api-key" placeholder="sk-…" value={aiForm.apiKey} onInput={e => setAiField('apiKey', e.currentTarget.value)} />
        </Field>

        <Field label={t('ai_model', 'Model Name')} for="super-admin-ai-model">
          <Input
            id="super-admin-ai-model"
            type="text"
            placeholder={aiModels()[0]}
            list="super-admin-ai-models"
            autocomplete="off"
            value={aiForm.model}
            onInput={e => setAiField('model', e.currentTarget.value)}
          />
          <datalist id="super-admin-ai-models">
            <For each={aiModels()}>{model => <option value={model} />}</For>
          </datalist>
          <Help>{t('ai_model_desc', 'Empty: the model shown in grey, which the provider recommends.')}</Help>
        </Field>

        <Field label={t('ai_effort', 'Effort per question')} for="super-admin-ai-effort">
          <Select id="super-admin-ai-effort" value={aiForm.effort} disabled={!providersSupported()} onChange={e => setAiField('effort', e.currentTarget.value as AiEffort)}>
            <option value="low">{t('ai_effort_low', 'Low')}</option>
            <option value="medium">{t('ai_effort_medium', 'Medium (recommended)')}</option>
            <option value="high">{t('ai_effort_high', 'High')}</option>
            <option value="xhigh">{t('ai_effort_xhigh', 'Very high')}</option>
            <option value="max">{t('ai_effort_max', 'Maximum')}</option>
          </Select>
          <Help>{t(...EFFORT_HINTS[aiForm.effort])}</Help>
        </Field>

        <Button variant="none" block class={SUPER_ADMIN_BTN} onClick={() => void saveAiConfig()}>
          {t('btn_save_ai', 'Save AI Settings')}
        </Button>
      </SettingsGroup>
    </div>
  );
}
