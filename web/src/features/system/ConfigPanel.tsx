// System settings → System configuration: the app's name, its public address, the default language, the CCLI
// licence, the logo and the SMTP server.
import { t } from '../../app/i18n';
import { Button } from '../../ui/Button';
import { Field, Input, Select, SwitchRow } from '../../ui/form';
import { Help, SettingsGroup, SUPER_ADMIN_BTN } from './parts';
import { configForm, saveAdvancedSystemConfig, setConfigField, uploadChurchLogo } from './systemConfig';

// Two fields side by side (stacked on phones); the old layout puts each label beside its field
const FIELD_ROW = 'flex w-full flex-wrap gap-2.5 max-md:flex-col max-md:gap-3';
const ROW_FIELD = 'flex justify-center';

export function ConfigPanel() {
  let logoInput!: HTMLInputElement;
  return (
    <SettingsGroup title={t('superadmin_config_title', 'System Configuration')}>
      <Field label={t('app_name_label', 'Application Name')} for="super-admin-app-name">
        <Input id="super-admin-app-name" type="text" placeholder="Agora" value={configForm.appName} onInput={e => setConfigField('appName', e.currentTarget.value)} />
        <Help>{t('app_name_desc', 'PocketBase is managed automatically in the Docker container. Here you can only change the display name and optional SMTP data.')}</Help>
      </Field>
      <Field label={t('admin_public_url_label', 'Public address (for links in e-mails)')} for="super-admin-public-url">
        <Input
          id="super-admin-public-url"
          type="url"
          placeholder="https://agora.example.org"
          inputmode="url"
          autocomplete="off"
          value={configForm.publicUrl}
          onInput={e => setConfigField('publicUrl', e.currentTarget.value)}
        />
        <Help>{t('admin_public_url_desc', 'The address the app is reachable at. Buttons in notification e-mails lead there; leave empty if e-mails should contain no links.')}</Help>
      </Field>
      <Field label={t('admin_default_language_label', 'Default language')} for="super-admin-default-language">
        <Select id="super-admin-default-language" value={configForm.defaultLanguage} onChange={e => setConfigField('defaultLanguage', e.currentTarget.value)}>
          <option value="en">English</option>
          <option value="de">Deutsch</option>
        </Select>
        <Help>{t('admin_default_language_desc', 'Language of push messages and e-mails for members whose app has not reported a language yet. Everyone else gets their own language.')}</Help>
      </Field>
      <Field label={t('admin_ccli_label', 'CCLI licence number (songbook)')} for="super-admin-ccli">
        <Input
          id="super-admin-ccli"
          type="text"
          inputmode="numeric"
          maxlength="12"
          placeholder={t('ccli_placeholder', 'e.g. 1234567')}
          autocomplete="off"
          value={configForm.ccli}
          onInput={e => setConfigField('ccli', e.currentTarget.value)}
        />
        <Help>{t('admin_ccli_desc', 'Shown at the bottom right of every song in the songbook.')}</Help>
      </Field>

      <div class="mb-[15px] mt-[25px]">
        <div class="mb-1.5 text-[1rem] font-bold">{t('superadmin_logo_title', 'Replace Logo')}</div>
        <Field label={t('superadmin_logo_desc', 'church-icon.svg / church-logo.svg (.svg format)')} for="super-admin-logo-file" class="mb-0">
          <div class="flex flex-wrap gap-2.5">
            <Input id="super-admin-logo-file" type="file" accept=".svg,image/svg+xml" class="min-w-[200px] flex-1" ref={el => (logoInput = el)} />
            <Button variant="none" class={SUPER_ADMIN_BTN} onClick={() => void uploadChurchLogo(logoInput)}>
              {t('btn_upload_logo', 'Upload Logo')}
            </Button>
          </div>
        </Field>
      </div>

      <div class="mb-[15px] mt-[25px] text-[1rem] font-bold">{t('smtp_title', 'SMTP Server (Optional)')}</div>
      <div class={FIELD_ROW}>
        <Field label={t('smtp_host', 'Host')} for="super-admin-smtp-host" class={`${ROW_FIELD} min-w-[150px] flex-[2]`}>
          <Input
            id="super-admin-smtp-host"
            type="text"
            placeholder={t('setup_smtp_host_placeholder', 'e.g., smtp.gmail.com')}
            value={configForm.smtpHost}
            onInput={e => setConfigField('smtpHost', e.currentTarget.value)}
          />
        </Field>
        <Field label={t('smtp_port', 'Port')} for="super-admin-smtp-port" class={`${ROW_FIELD} min-w-[80px] flex-1`}>
          <Input id="super-admin-smtp-port" type="number" placeholder="465" value={configForm.smtpPort} onInput={e => setConfigField('smtpPort', e.currentTarget.value)} />
        </Field>
      </div>
      <SwitchRow id="super-admin-smtp-secure" checked={configForm.smtpSecure} onChange={on => setConfigField('smtpSecure', on)} label={t('smtp_secure', 'Enable SSL/TLS')} />
      <div class={FIELD_ROW}>
        <Field label={t('smtp_user', 'Username (Email)')} for="super-admin-smtp-user" class={`${ROW_FIELD} min-w-[150px] flex-1`}>
          <Input id="super-admin-smtp-user" type="text" placeholder="mail@example.com" value={configForm.smtpUser} onInput={e => setConfigField('smtpUser', e.currentTarget.value)} />
        </Field>
        <Field label={t('smtp_pass', 'Password')} for="super-admin-smtp-pass" class={`${ROW_FIELD} min-w-[150px] flex-1`}>
          <Input id="super-admin-smtp-pass" type="password" placeholder={t('smtp_pass', 'Password')} value={configForm.smtpPass} onInput={e => setConfigField('smtpPass', e.currentTarget.value)} />
        </Field>
      </div>

      <Button variant="none" block class={`${SUPER_ADMIN_BTN} mt-[15px]`} onClick={() => void saveAdvancedSystemConfig()}>
        {t('btn_save_config', 'Save Advanced System Configuration')}
      </Button>
    </SettingsGroup>
  );
}
