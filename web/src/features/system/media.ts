// System settings: the connection to Nextcloud that holds the media library (address, account, app password, base
// folder), its test and whether Media is on.
import { createSignal } from 'solid-js';
import { apiJson, errorMessage } from '../../app/api';
import { loadMediaStatus } from '../../app/data';
import { t } from '../../app/i18n';
import { isSuperAdminUser } from '../../app/session';
import { attempt, showToast } from '../../app/toast';
import { createForm } from '../../ui/form';

export interface MediaForm {
  enabled: boolean;
  url: string;
  user: string;
  password: string;
  root: string;
}
const [mediaForm, setMediaField, setMediaForm] = createForm<MediaForm>({ enabled: false, url: '', user: '', password: '', root: '' });
export { mediaForm, setMediaField };

/** What the last test found: the folders of the base folder, or why there is no connection. */
export type MediaTestResult = { ok: true; folders: string[]; folderCount: number } | { ok: false; message: string };
const [mediaTestResult, setMediaTestResult] = createSignal<MediaTestResult | null>(null);
const [mediaTesting, setMediaTesting] = createSignal(false);
const [mediaSaving, setMediaSaving] = createSignal(false);
export { mediaTestResult, mediaTesting, mediaSaving };

const mediaConfigPayload = () => ({
  enabled: mediaForm.enabled,
  url: mediaForm.url.trim(),
  user: mediaForm.user.trim(),
  password: mediaForm.password,
  root: mediaForm.root.trim()
});

/** The Nextcloud connection as the server shows it (the password only as "***"). */
interface MediaConfigAnswer {
  enabled?: boolean;
  url?: string;
  user?: string;
  password?: string;
  root?: string;
}

export async function loadMediaConfig() {
  if (!isSuperAdminUser()) return;
  setMediaTestResult(null);
  try {
    const data = await apiJson<MediaConfigAnswer>('/admin/media-config');
    setMediaForm(form => {
      form.enabled = data.enabled === true;
      form.url = data.url || '';
      form.user = data.user || '';
      form.password = data.password || '';
      form.root = data.root ? `/${data.root}` : '';
    });
  } catch (err) {
    console.warn('Media settings could not be loaded:', err);
  }
}

export async function testMediaConfig() {
  setMediaTesting(true);
  try {
    const data = await apiJson<{ folders: string[]; folderCount: number }>('/admin/media-config/test', 'POST', mediaConfigPayload());
    setMediaTestResult({ ok: true, folders: data.folders, folderCount: data.folderCount });
  } catch (err) {
    setMediaTestResult({ ok: false, message: errorMessage(err) });
  } finally {
    setMediaTesting(false);
  }
}

export async function saveMediaConfig() {
  const payload = mediaConfigPayload();
  await attempt(
    async () => {
      await apiJson('/admin/media-config', 'PUT', payload);
      showToast(t('media_cfg_saved', 'Media settings saved'));
      await Promise.all([loadMediaConfig(), loadMediaStatus()]);
    },
    err => err.message || t('media_cfg_save_failed', 'The media settings could not be saved'),
    { setBusy: setMediaSaving }
  );
}
