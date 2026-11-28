// System settings: the AI provider (service, address, key, model, effort per question) and whether the AI is on.
import { createSignal } from 'solid-js';
import { API, apiJson, errorMessage } from '../../app/api';
import { t } from '../../app/i18n';
import { isSuperAdminUser, setAiEnabled } from '../../app/session';
import { showToast } from '../../app/toast';
import { createForm } from '../../ui/form';

export type AiProvider = 'anthropic' | 'gemini' | 'openai' | 'custom';
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const AI_EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// The AI services: the first model is the one a question goes to when none is entered (the server's default)
export const AI_PROVIDER_MODELS: Record<AiProvider, string[]> = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
  openai: ['gpt-5-mini', 'gpt-5', 'gpt-5-nano', 'gpt-4.1'],
  custom: ['gpt-4o-mini']
};
const isProvider = (value: unknown): value is AiProvider => typeof value === 'string' && Object.hasOwn(AI_PROVIDER_MODELS, value);
const isEffort = (value: unknown): value is AiEffort => AI_EFFORTS.includes(value as AiEffort);

/** The stored AI settings as the server shows them (the key only as "***"); one of an earlier version names no service. */
interface AiConfigAnswer {
  enabled?: boolean;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  effort?: string;
}

export interface AiForm {
  enabled: boolean;
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  effort: AiEffort;
}
const [aiForm, setAiField, setAiForm] = createForm<AiForm>({ enabled: false, provider: 'custom', baseUrl: '', apiKey: '', model: '', effort: 'medium' });
export { aiForm, setAiField };

// Does the server store the service and the effort level? A server of an earlier version does not - also the previous
// backend that runs while the database upgrade could not finish (backend/legacy): it answers without a service, talks
// only to the OpenAI-compatible one and ignores the choice, so the page went back to "OpenAI-compatible" after every
// save while saving said it was done
const [providersSupported, setProvidersSupported] = createSignal(true);
// Why not: the reason the database upgrade gives while the previous backend runs ('' when it names none); null: no note
const [serverNote, setServerNote] = createSignal<{ upgradeReason: string | null } | null>(null);
export { providersSupported, serverNote };

// The service the stored key and model belong to, and that model
let savedProvider: AiProvider = 'custom';
let savedModel = '';

// The admin's edits in the AI form: counted, and the count the form last showed the stored settings at. A reload in
// the background (after signing in, with the system configuration, after a change of the books) used to fill the form
// again and so threw away what the admin had just chosen - and saving then stored the old settings again.
let aiFormEdits = 0;
let aiFormCleanAt = 0;
const aiFormDirty = () => aiFormEdits !== aiFormCleanAt;
/** Every input and change inside the AI form counts as an edit. */
export function countAiEdit() {
  aiFormEdits += 1;
}
/** Signing out: the edits of the AI form are not taken over by the next person who signs in. */
export function forgetAiEdits() {
  aiFormCleanAt = aiFormEdits;
}

/** The models of the chosen service (the first is its recommended one). */
export const aiModels = () => AI_PROVIDER_MODELS[aiForm.provider];

/** Another service: its models to choose from and its own key (the address only for the OpenAI-compatible one). */
export function selectAiProvider(value: string) {
  const provider = isProvider(value) ? value : 'custom';
  setAiForm(form => {
    form.provider = provider;
    // A model of one service does not fit another: empty means the service's recommended model
    form.model = provider === savedProvider ? savedModel : '';
    if (provider !== savedProvider && form.apiKey === '***') form.apiKey = '';
    else if (provider === savedProvider && !form.apiKey) form.apiKey = '***';
  });
}

// A server of an earlier version: the service stays the OpenAI-compatible one and the effort level cannot be chosen,
// and the note says why - with the reason the database upgrade gives when the previous backend runs in its place.
// [provider]: the service the form shows (just written: the form's store shows it with Solid's next update)
async function showAiServerSupport(supported: boolean, provider = aiForm.provider) {
  setProvidersSupported(supported);
  if (!supported && provider !== 'custom') selectAiProvider('custom');
  if (supported) {
    setServerNote(null);
    return;
  }
  // The previous backend reports why the upgrade waits (/api/status → upgrade)
  const upgrade = await fetch(`${API}/status`)
    .then(res => res.json() as Promise<{ upgrade?: { reason?: string } | null } | null>)
    .then(status => status?.upgrade || null)
    .catch(() => null);
  // A newer answer came in the meantime
  if (providersSupported()) return;
  setServerNote({ upgradeReason: upgrade ? upgrade.reason || '' : null });
}

/**
 * fresh: the AI page was opened - it shows the stored settings (edits made while they load are kept). Otherwise (a
 * reload in the background) unsaved edits stay as they are.
 */
export async function loadAiConfig({ fresh = false } = {}) {
  if (!isSuperAdminUser()) return;
  try {
    const editsBefore = aiFormEdits;
    const data = await apiJson<AiConfigAnswer>('/admin/ai-config');
    setAiEnabled(!!data.enabled);
    // A server of an earlier version names no service (see providersSupported)
    const supported = typeof data.provider === 'string';
    if (aiFormDirty() && !(fresh && aiFormEdits === editsBefore)) return void showAiServerSupport(supported);
    aiFormCleanAt = aiFormEdits;
    savedProvider = isProvider(data.provider) ? data.provider : 'custom';
    savedModel = data.model || '';
    setAiForm(form => {
      form.enabled = !!data.enabled;
      form.provider = savedProvider;
      form.baseUrl = data.baseUrl || '';
      form.apiKey = data.apiKey || '';
      form.model = data.model || '';
      form.effort = isEffort(data.effort) ? data.effort : 'medium';
    });
    void showAiServerSupport(supported, savedProvider);
  } catch (err) {
    console.error('The AI settings could not be loaded:', err);
  }
}

const aiConfigPayload = () => ({
  enabled: aiForm.enabled,
  provider: aiForm.provider || 'custom',
  baseUrl: aiForm.baseUrl.trim(),
  apiKey: aiForm.apiKey,
  model: aiForm.model.trim(),
  effort: aiForm.effort || 'medium'
});

export async function saveAiConfig() {
  if (!isSuperAdminUser()) return;
  const editsSaved = aiFormEdits;
  const payload = aiConfigPayload();
  try {
    // Another service needs its own key (an empty one would replace the stored key)
    if (payload.provider !== savedProvider && !payload.apiKey.trim()) throw new Error(t('ai_key_needed', 'Please enter the API key for the chosen provider.'));
    const saved = await apiJson<AiConfigAnswer>('/admin/ai-config', 'PUT', payload);
    // What the server stored: one of an earlier version names no service - it keeps the OpenAI-compatible one. The page
    // then shows what the server has and why, instead of "saved" for a choice that is gone on the next visit
    if ((typeof saved.provider === 'string' ? saved.provider : 'custom') !== payload.provider) {
      aiFormCleanAt = aiFormEdits;
      await loadAiConfig();
      throw new Error(t('ai_provider_not_stored', 'The server runs an earlier version of Agora and did not store the provider – see the note above.'));
    }
    // Saved: the form shows the stored settings (unless the admin changed something while it was saving)
    if (aiFormEdits === editsSaved) aiFormCleanAt = editsSaved;
    savedProvider = payload.provider;
    savedModel = payload.model;
    setAiEnabled(payload.enabled);
    showToast(t('toast_ai_saved', 'AI settings saved'));
  } catch (err) {
    console.error(err);
    showToast(t('alert_ai_save_failed', 'Could not save AI settings: ') + (errorMessage(err) || t('error_unknown', 'Unknown error')), 'error');
  }
}
