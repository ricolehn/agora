// What the member does with the library's entries: open them, download or delete one or several (right click, the
// menu key or a held finger select; Ctrl / Cmd + click and Shift + click too), and add files where they may write.
import { createSignal } from 'solid-js';
import { API, apiJson, getToken } from '../../app/api';
import { mediaStatus } from '../../app/data';
import { t, uiLang } from '../../app/i18n';
import { pushHistoryLevel } from '../../app/router';
import { attempt, confirmAction, showToast } from '../../app/toast';
import { once } from '../../app/util';
import { opensAsPdf, opensInPlayer, opensInViewer, pathSteps } from '../../lib/media.js';
import { downloadUrl, saveMediaLink } from './files';
import {
  canDeleteMediaEntry, isMediaSelected, loadMediaFolder, mediaEntry, mediaFolder, mediaListing, mediaSelected, mediaShown,
  mediaSort, openMediaCrumb, openMediaFolder, setMediaSort, toggleMediaSelected, unselectMedia
} from './library';
import { showMediaMenu, type MediaMenuItem } from './MediaMenu';
import { openMediaPdf } from './MediaPdf';
import { openMediaPlayer } from './MediaPlayer';
import { openMediaRights } from './MediaRights';
import { openMediaViewer } from './MediaViewer';
import type { MediaEntry, MediaSort } from './types';

/** Pictures in the viewer, PDFs in the PDF viewer, videos and music in the player; the rest is downloaded. */
function openMediaFile(index: number) {
  const file = mediaShown().files[index];
  if (!file) return;
  if (opensInViewer(file)) return openMediaViewer(index);
  if (opensAsPdf(file)) return openMediaPdf(file);
  if (opensInPlayer(file)) return openMediaPlayer(file);
  // Everything else is downloaded (the server only ever sends it as a download)
  saveMediaLink(downloadUrl(file), file.name);
}

/** A tap on an entry: a folder opens one level down (with its own history step), a file opens. */
export function openMediaEntry(name: string) {
  const entry = mediaEntry(name);
  if (entry?.folder) {
    pushHistoryLevel('folder');
    openMediaFolder(entry.folder.path);
  } else if (entry?.file) openMediaFile(entry.index);
}

// The selection bar waits (its buttons off) while a download is prepared or entries are deleted
const [busy, setBusy] = createSignal(false);
export { busy as mediaSelectBusy };
async function mediaBusy<T>(action: () => Promise<T>): Promise<T> {
  setBusy(true);
  try {
    return await action();
  } finally {
    setBusy(false);
  }
}

const entriesOf = (names: string[]) => names.map(mediaEntry).filter((entry): entry is MediaEntry => !!entry);

/** Whether everything selected may be deleted (files where the member may write, folders only where everywhere). */
export function mediaSelectionDeletable() {
  const entries = entriesOf([...mediaSelected()]);
  return entries.length > 0 && entries.every(canDeleteMediaEntry);
}

/** One file comes as it is; several (or a folder) as one ZIP archive the server puts together. */
export async function downloadMediaEntries(names: string[]) {
  const entries = entriesOf(names);
  if (!entries.length) return;
  const [first] = entries;
  if (entries.length === 1 && first.file) return saveMediaLink(downloadUrl(first.file), first.name);
  const folder = mediaFolder();
  await once('media-download', () =>
    mediaBusy(() =>
      attempt(
        async () => {
          showToast(t('media_download_preparing', 'Preparing the download…'));
          const ticket = await apiJson<{ id: string }>('/media/download', 'POST', { path: folder, names: entries.map(entry => entry.name) });
          saveMediaLink(`${API}/media/download/${encodeURIComponent(ticket.id)}`);
        },
        err => err?.message || t('media_download_failed', 'The download could not be prepared')
      )
    )
  );
}

export async function deleteMediaEntries(names: string[]) {
  const entries = entriesOf(names);
  if (!entries.length || !entries.every(canDeleteMediaEntry)) return;
  const [first] = entries;
  const question =
    entries.length > 1
      ? t('media_delete_confirm_many', 'Delete {count} items? Folders go with everything in them.', { count: entries.length })
      : first.folder
        ? t('media_delete_confirm_folder', 'Delete the folder "{name}" with everything in it?', { name: first.name })
        : t('media_delete_confirm_file', 'Delete "{name}"?', { name: first.name });
  if (!confirmAction(question)) return;
  const folder = mediaFolder();
  await once('media-delete', () =>
    mediaBusy(() =>
      attempt(
        async () => {
          const result = await apiJson<{ deleted?: string[]; failed?: { name: string; error: string }[] }>('/media/delete', 'POST', {
            path: folder,
            names: entries.map(entry => entry.name)
          });
          const deleted = result.deleted || [];
          unselectMedia(deleted);
          if (result.failed?.length) {
            showToast(t('media_delete_partly', '{count} could not be deleted: {error}', { count: result.failed.length, error: result.failed[0].error }), 'error');
          } else {
            showToast(deleted.length === 1 ? t('media_deleted_one', 'Deleted') : t('media_deleted', '{count} items deleted', { count: deleted.length }));
          }
          if (mediaFolder() === folder) await loadMediaFolder({ silent: true });
        },
        err => err?.message || t('media_delete_failed', 'Could not delete')
      )
    )
  );
}

// --- Menus: of an entry or the selection, of the order, of the folders folded into "…" ---

/** The menu of the entry [name] at (x, y); on a selected entry it is for the whole selection. */
export function openMediaMenu(name: string, x: number, y: number) {
  const entry = mediaEntry(name);
  if (!entry) return;
  const names = isMediaSelected(name) && mediaSelected().size > 1 ? [...mediaSelected()] : [name];
  const several = names.length > 1;
  const deletable = entriesOf(names).every(canDeleteMediaEntry);
  const items: MediaMenuItem[] = [];
  if (!several) items.push({ icon: entry.folder ? 'folder' : 'eye', label: t('media_open', 'Open'), onPick: () => openMediaEntry(name) });
  items.push({
    icon: 'download',
    label: several ? t('media_download_count', 'Download {count}', { count: names.length }) : t('media_download', 'Download'),
    onPick: () => void downloadMediaEntries(names)
  });
  items.push({ icon: 'check', label: isMediaSelected(name) ? t('media_unselect', 'Unselect') : t('media_select', 'Select'), onPick: () => toggleMediaSelected(name) });
  // Folders carry no marks of their rights: managers find them here too
  if (!several && entry.folder && mediaStatus().canManage) {
    const path = entry.folder.path;
    items.push({ icon: 'shield', label: t('media_rights_title', 'Folder rights'), onPick: () => void openMediaRights(path) });
  }
  if (mediaListing()?.access === 'write') {
    items.push({
      icon: 'trash',
      danger: true,
      disabled: !deletable,
      title: deletable ? undefined : t('media_delete_not_allowed', 'You may not delete everything in a selected folder.'),
      label: several ? t('media_delete_count', 'Delete {count}', { count: names.length }) : t('media_delete', 'Delete'),
      onPick: () => void deleteMediaEntries(names)
    });
  }
  showMediaMenu({ title: several ? t('media_selected', '{count} selected', { count: names.length }) : name, items, x, y });
}

/** Name or newest first, from the sort sign in the header. */
export function openMediaSortMenu(button: HTMLElement) {
  const rect = button.getBoundingClientRect();
  const choices: Array<[MediaSort, string]> = [['name', t('media_sort_name', 'Name')], ['newest', t('media_sort_newest', 'Newest')]];
  showMediaMenu({
    title: t('media_sort', 'Order'),
    label: t('media_sort', 'Order'),
    items: choices.map(([value, label]) => ({ radio: true, chosen: value === mediaSort(), label, onPick: () => setMediaSort(value) })),
    x: rect.right,
    y: rect.bottom + 6,
    alignEnd: true
  });
}

/** The folders folded into "…" of a deep path, each a little further in like the way down; a tap goes there. */
export function openMediaPathMenu(button: HTMLElement) {
  const folded: Array<{ target: string; name: string }> = pathSteps(mediaFolder(), '').find((step: { folded: unknown[] }) => step.folded.length)?.folded || [];
  if (!folded.length) return;
  const rect = button.getBoundingClientRect();
  showMediaMenu({
    label: t('media_path_between', 'Folders in between'),
    items: folded.map((entry, level) => ({ motif: true, indent: level, label: entry.name, onPick: () => openMediaCrumb(entry.target) })),
    x: rect.left,
    y: rect.bottom + 6
  });
}

// --- Adding files (where the member may write): the file picker, dropped files, with the upload's progress ---
let fileInput: HTMLInputElement | undefined;
export const setMediaFileInput = (el: HTMLInputElement) => {
  fileInput = el;
};

export function pickMediaFiles() {
  if (mediaListing()?.access !== 'write' || !fileInput) return;
  fileInput.value = '';
  fileInput.click();
}

/** The upload on its way: how many files and how far (null until the browser says). */
const [upload, setUpload] = createSignal<{ count: number; percent: number | null } | null>(null);
export { upload as mediaUpload };
let uploading = false;

export async function uploadMediaFiles(fileList: FileList | File[] | null | undefined) {
  const files = [...(fileList || [])];
  if (!files.length || uploading || mediaListing()?.access !== 'write') return;
  if (files.length > 50) return showToast(t('media_too_many', 'At most 50 files at once.'), 'error');
  if (files.some(file => file.size > 1024 * 1024 * 1024)) return showToast(t('media_too_large', 'A file is larger than 1 GB.'), 'error');
  const folder = mediaFolder();
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);
  uploading = true;
  setUpload({ count: files.length, percent: null });
  try {
    const token = await getToken();
    // XMLHttpRequest: fetch cannot report how far an upload is
    const result = await new Promise<{ files?: Array<{ name: string }> }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API}/media/upload?path=${encodeURIComponent(folder)}`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Accept-Language', uiLang());
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) setUpload({ count: files.length, percent: Math.round((e.loaded / e.total) * 100) });
      };
      xhr.onload = () => {
        let body: any = {};
        try {
          body = JSON.parse(xhr.responseText || '{}');
        } catch {
          /* not JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error(t('error_connection', 'Connection error')));
      xhr.send(form);
    });
    const stored = result.files || [];
    const renamed = stored.some((entry, i) => files[i] && entry.name !== files[i].name);
    const added = stored.length === 1 ? t('media_uploaded_one', '1 file added') : t('media_uploaded', '{count} files added', { count: stored.length });
    showToast(renamed ? `${added} · ${t('media_uploaded_renamed', 'Names already taken got a number.')}` : added);
    if (mediaFolder() === folder) await loadMediaFolder({ silent: true });
  } catch (err: any) {
    showToast(err?.message || t('media_upload_failed', 'The files could not be uploaded'), 'error');
    // Files stored before the cloud stopped (full, folder gone) are there all the same
    if (mediaFolder() === folder) void loadMediaFolder({ silent: true });
  } finally {
    uploading = false;
    setUpload(null);
  }
}
