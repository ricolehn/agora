// System settings: the instance's configuration (name, public address, default language, CCLI licence, SMTP) and
// its logo.
import { createStore, flush, snapshot } from 'solid-js';
import { api } from '../../app/api';
import { config, setAppName } from '../../app/config';
import { t } from '../../app/i18n';
import { isSuperAdminUser } from '../../app/session';
import { attempt, showToast } from '../../app/toast';
import { toFormData } from '../../app/util';
import { loadAiConfig } from './ai';

// Members whose app has not reported a language yet get the instance's default language (English unless chosen)
const BASE_LANGUAGE = 'en';

export interface ConfigForm {
  appName: string;
  publicUrl: string;
  defaultLanguage: string;
  ccli: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
}
const [configForm, setConfigForm] = createStore<ConfigForm>({
  appName: '', publicUrl: '', defaultLanguage: BASE_LANGUAGE, ccli: '', smtpHost: '', smtpPort: '', smtpSecure: false, smtpUser: '', smtpPass: ''
});
export { configForm };
export function setConfigField<K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) {
  setConfigForm(form => {
    form[key] = value;
  });
  // Applied at once: a save right after the change reads it
  flush();
}

// The form shows the stored configuration (every load of the data asks again: the full one refills the form, the
// configuration page does when it opens next), and the name it was stored with
let configLoaded = false;
let loadedAppName: string | null = null;
export const isSystemConfigLoaded = () => configLoaded;
export function forgetSystemConfig() {
  configLoaded = false;
  loadedAppName = null;
}

/** The error text of a failed request (the server's { error } or the plain answer). */
async function readErrorText(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data?.error) return data.error;
    if (data && Object.keys(data).length > 0) return JSON.stringify(data);
  } catch {
    /* not JSON */
  }
  return text;
}

export async function loadAdvancedSystemConfig() {
  if (!isSuperAdminUser()) return;
  await attempt(
    async () => {
      const res = await api('/admin/system-config');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      loadedAppName = data.appName || null;
      setConfigForm(form => {
        form.appName = data.appName || '';
        form.publicUrl = data.publicUrl || '';
        form.defaultLanguage = data.defaultLanguage || BASE_LANGUAGE;
        form.ccli = data.ccliLicense || '';
        form.smtpHost = data.smtp?.host || '';
        form.smtpPort = String(data.smtp?.port || '');
        form.smtpUser = data.smtp?.user || '';
        form.smtpPass = data.smtp?.pass || '';
        form.smtpSecure = !!data.smtp?.secure;
      });
      flush();
      configLoaded = true;
      await loadAiConfig();
    },
    t('toast_config_load_failed', 'Advanced configuration could not be loaded'),
    { toast: 'error' }
  );
}

export async function saveAdvancedSystemConfig() {
  if (!isSuperAdminUser()) return;
  const form = snapshot(configForm);
  await attempt(
    async () => {
      const appName = form.appName.trim() || loadedAppName || config.appName;
      if (!appName) throw new Error(t('admin_app_name_missing', 'The app name could not be determined. Configuration data may be missing. Please reload the page.'));
      const publicUrl = form.publicUrl.trim().replace(/\/+$/, '');
      if (publicUrl && !/^https?:\/\/[^\s/]+/i.test(publicUrl)) throw new Error(t('admin_public_url_invalid', 'The public address has to start with https://.'));
      const ccliLicense = form.ccli.replace(/\s+/g, '');
      if (ccliLicense && !/^\d{1,12}$/.test(ccliLicense)) throw new Error(t('admin_ccli_invalid', 'The CCLI licence number consists of digits only.'));
      const host = form.smtpHost.trim();
      let smtp: { host: string; port: number; secure: boolean; user: string; pass: string } | null = null;
      if (host) {
        const port = form.smtpPort.trim();
        smtp = {
          host,
          port: port ? parseInt(port, 10) : 465,
          secure: form.smtpSecure,
          user: form.smtpUser.trim(),
          pass: form.smtpPass
        };
        if (!smtp.port || Number.isNaN(smtp.port)) throw new Error(t('admin_smtp_port_invalid', 'The SMTP port is invalid.'));
      }
      const payload = { appName, publicUrl, defaultLanguage: form.defaultLanguage || BASE_LANGUAGE, ccliLicense, smtp };
      const res = await api('/admin/system-config', 'PUT', payload);
      if (!res.ok) throw new Error(await readErrorText(res));
      loadedAppName = appName;
      // The header, the sign-in and the window title show the new name at once
      setAppName(appName);
      showToast(t('toast_config_saved', 'System configuration saved'));
    },
    err => t('alert_config_save_failed', 'Could not save advanced configuration: ') + (err.message || t('error_unknown', 'Unknown error'))
  );
}

/** Uploads the SVG chosen in [fileInput] as the community's logo. */
export async function uploadChurchLogo(fileInput: HTMLInputElement) {
  if (!isSuperAdminUser()) return;
  const file = fileInput.files?.[0];
  if (!file) {
    showToast(t('alert_please_select_svg', 'Please select an SVG file.'), 'error');
    return;
  }
  try {
    const res = await api('/admin/logo', 'POST', toFormData({ logo: file }));
    if (!res.ok) throw new Error((await readErrorText(res)) || `HTTP ${res.status}`);
    // Every picture of the logo on the page (header, sign-in) loads the new one
    const cacheBust = `?v=${Date.now()}`;
    document.querySelectorAll<HTMLImageElement>("img[src*='church-logo.svg']").forEach(img => {
      img.src = `/assets/church-logo.svg${cacheBust}`;
    });
    fileInput.value = '';
    showToast(t('toast_logo_updated', 'Logo updated'));
  } catch (err: any) {
    const errMsg = err.message || err.code || t('error_unknown', 'Unknown error');
    console.error('Logo upload failed:', errMsg, err);
    showToast(t('toast_logo_update_failed', 'Logo could not be updated'), 'error');
  }
}
