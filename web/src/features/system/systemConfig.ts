// System settings: the instance's configuration (name, public address, default language, CCLI licence, SMTP) and
// its logo.
import { snapshot } from 'solid-js';
import { apiJson, asFailure } from '../../app/api';
import { bumpLogoVersion, config, setAppName } from '../../app/config';
import { t } from '../../app/i18n';
import { isSuperAdminUser } from '../../app/session';
import { attempt, showToast } from '../../app/toast';
import { toFormData } from '../../app/util';
import { createForm } from '../../ui/form';
import { loadAiConfig } from './ai';
import { flushNow } from '../../app/flush';

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
const [configForm, setConfigField, setConfigForm] = createForm<ConfigForm>({
  appName: '', publicUrl: '', defaultLanguage: BASE_LANGUAGE, ccli: '', smtpHost: '', smtpPort: '', smtpSecure: false, smtpUser: '', smtpPass: ''
});
export { configForm, setConfigField };

// The form shows the stored configuration (every load of the data asks again: the full one refills the form, the
// configuration page does when it opens next), and the name it was stored with
let configLoaded = false;
let loadedAppName: string | null = null;
export const isSystemConfigLoaded = () => configLoaded;
export function forgetSystemConfig() {
  configLoaded = false;
  loadedAppName = null;
}

/** The instance's configuration as the server shows it (GET /api/admin/system-config; the SMTP password only as "***"). */
interface SystemConfigAnswer {
  appName?: string;
  publicUrl?: string;
  defaultLanguage?: string;
  ccliLicense?: string;
  smtp?: { host?: string; port?: number | string; user?: string; pass?: string; secure?: boolean };
}

export async function loadAdvancedSystemConfig() {
  if (!isSuperAdminUser()) return;
  await attempt(
    async () => {
      const data = await apiJson<SystemConfigAnswer>('/admin/system-config');
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
      flushNow();
      configLoaded = true;
      await loadAiConfig();
    },
    t('toast_config_load_failed', 'Advanced configuration could not be loaded')
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
      await apiJson('/admin/system-config', 'PUT', payload);
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
    await apiJson('/admin/logo', 'POST', toFormData({ logo: file }));
    // Every picture of the logo (header, sign-in) loads the new one
    bumpLogoVersion();
    fileInput.value = '';
    showToast(t('toast_logo_updated', 'Logo updated'));
  } catch (err) {
    const { message, code } = asFailure(err);
    const errMsg = message || code || t('error_unknown', 'Unknown error');
    console.error('Logo upload failed:', errMsg, err);
    showToast(t('toast_logo_update_failed', 'Logo could not be updated'), 'error');
  }
}
