// System settings → Media: the Nextcloud account the media library lives in, a test of the connection and saving it.
import { For, Show } from 'solid-js';
import { t } from '../../app/i18n';
import { Button } from '../../ui/Button';
import { Field, Input, PasswordInput } from '../../ui/form';
import { mediaForm, mediaSaving, mediaTestResult, mediaTesting, saveMediaConfig, setMediaField, testMediaConfig, type MediaTestResult } from './media';
import { Help, SettingsGroup, SUPER_ADMIN_BTN, SwitchRow } from './parts';

const MEDIA_HELP = 'mt-1 leading-[1.45]';

/** What the test found: "Connected." with the folders of the base folder, or why there is no connection. */
function TestResultText(props: { result: MediaTestResult }) {
  const connected = () => (props.result.ok ? props.result : null);
  const failure = () => (props.result.ok ? '' : props.result.message);
  return (
    <Show
      when={connected()}
      fallback={
        <>
          <strong>{t('media_cfg_test_failed', 'No connection.')}</strong> {failure()}
        </>
      }
    >
      {found => (
        <>
          <strong>{t('media_cfg_test_ok', 'Connected.')}</strong>{' '}
          <Show when={found().folderCount} fallback={t('media_cfg_test_empty', 'The base folder has no folders yet.')}>
            {found().folderCount === 1
              ? t('media_cfg_test_folders_one', '1 folder in the base folder:')
              : t('media_cfg_test_folders', '{count} folders in the base folder:', { count: found().folderCount })}
            <For each={found().folders}>
              {name => (
                <>
                  {' '}
                  <code class="rounded-[6px] bg-surface-alt px-1.5 py-px font-sans text-[0.78rem]">{name}</code>
                </>
              )}
            </For>
            {found().folderCount > found().folders.length ? ' …' : ''}
          </Show>
        </>
      )}
    </Show>
  );
}

export function MediaPanel() {
  return (
    <SettingsGroup
      title={t('superadmin_media_title', 'Media (Nextcloud)')}
      desc={t(
        'superadmin_media_desc',
        'A folder in Nextcloud becomes the media library of the community (Extras → Media). Agora signs in with one account of its own and decides itself who may see and add what: members with "Extended media rights" set this per folder and group.'
      )}
    >
      <SwitchRow id="super-admin-media-enabled" checked={mediaForm.enabled} onChange={on => setMediaField('enabled', on)} label={t('media_cfg_enabled', 'Switch on Media')} />

      <Field label={t('media_cfg_url', 'Nextcloud address')} for="super-admin-media-url">
        <Input
          id="super-admin-media-url"
          type="url"
          placeholder="https://cloud.example.org"
          autocomplete="off"
          spellcheck={false}
          value={mediaForm.url}
          onInput={e => setMediaField('url', e.currentTarget.value)}
        />
        <Help class={MEDIA_HELP}>
          {t('media_cfg_url_desc', 'With port and path if your Nextcloud needs them, e.g. https://cloud.example.org:8443/nextcloud. The address of the Files app works too.')}
        </Help>
      </Field>

      <Field label={t('media_cfg_user', 'Account (user name)')} for="super-admin-media-user">
        <Input
          id="super-admin-media-user"
          type="text"
          placeholder="agora-bot"
          autocomplete="off"
          spellcheck={false}
          autocapitalize="off"
          value={mediaForm.user}
          onInput={e => setMediaField('user', e.currentTarget.value)}
        />
      </Field>

      <Field label={t('media_cfg_password', 'App password')} for="super-admin-media-password">
        <PasswordInput
          id="super-admin-media-password"
          autocomplete="new-password"
          placeholder="xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"
          value={mediaForm.password}
          onInput={e => setMediaField('password', e.currentTarget.value)}
        />
        <Help class={MEDIA_HELP}>
          {t(
            'media_cfg_password_desc',
            'In Nextcloud signed in as this account: Settings → Security → Devices & sessions → "Create new app password". It is stored encrypted and never sent to the apps.'
          )}
        </Help>
      </Field>

      <Field label={t('media_cfg_root', 'Base folder')} for="super-admin-media-root">
        <Input
          id="super-admin-media-root"
          type="text"
          placeholder="/Agora"
          autocomplete="off"
          spellcheck={false}
          value={mediaForm.root}
          onInput={e => setMediaField('root', e.currentTarget.value)}
        />
        <Help class={MEDIA_HELP}>{t('media_cfg_root_desc', 'Only this folder of the account (and what is in it) is shown in Agora. Empty: the whole account.')}</Help>
      </Field>

      <div
        id="media-cfg-result"
        role="status"
        hidden={!mediaTestResult()}
        class={[
          'mb-3.5 mt-1 rounded-xl border px-3.5 py-3 text-[0.84rem] leading-[1.5] text-text',
          mediaTestResult()?.ok ? 'border-[rgba(16,185,129,0.35)] bg-[rgba(16,185,129,0.08)]' : 'border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.08)]'
        ]}
      >
        <Show when={mediaTestResult()}>{result => <TestResultText result={result()} />}</Show>
      </div>

      <div class="mt-1.5 flex flex-wrap gap-2.5">
        <Button
          id="media-cfg-test-btn"
          variant="secondary"
          class="min-w-[180px] flex-1"
          busy={mediaTesting()}
          busyText={t('media_cfg_testing', 'Testing…')}
          onClick={() => void testMediaConfig()}
        >
          {t('media_cfg_test', 'Test connection')}
        </Button>
        <Button
          id="media-cfg-save-btn"
          variant="secondary"
          class={`${SUPER_ADMIN_BTN} min-w-[180px] flex-1`}
          busy={mediaSaving()}
          busyText={t('setup_btn_saving', 'Saving...')}
          onClick={() => void saveMediaConfig()}
        >
          {t('media_cfg_save', 'Save media settings')}
        </Button>
      </div>
    </SettingsGroup>
  );
}
