// A new folder in the open one (where the member may write).
import { createSignal } from 'solid-js';
import { apiJson } from '../../app/api';
import { t } from '../../app/i18n';
import { closeModal, openModal } from '../../app/modals';
import { attempt, showToast } from '../../app/toast';
import { once } from '../../app/util';
import { Input } from '../../ui/form';
import { Modal } from '../../ui/Modal';
import { loadMediaFolder, mediaFolder, mediaListing } from './library';
import { SheetFooter } from './SheetFooter';

const ID = 'media-folder-modal';
const [creating, setCreating] = createSignal(false);
// The name field of the open dialog (drawn anew, empty, every time it opens)
let nameInput: HTMLInputElement | undefined;

export function openMediaFolderDialog() {
  if (mediaListing()?.access !== 'write') return;
  openModal(ID);
}

async function createMediaFolder() {
  const name = (nameInput?.value || '').trim();
  if (!name) return void nameInput?.focus();
  await once('media-folder', () =>
    attempt(
      async () => {
        await apiJson('/media/folder', 'POST', { path: mediaFolder(), name });
        closeModal(ID, false, true);
        showToast(t('media_folder_created', 'Folder created'));
        await loadMediaFolder({ silent: true });
      },
      err => err?.message,
      { setBusy: setCreating }
    )
  );
}

export function MediaFolderDialog() {
  return (
    <Modal
      id={ID}
      title={t('media_new_folder', 'New folder')}
      maxWidth="460px"
      bodyClass="gap-3.5"
      footer={<SheetFooter modal={ID} id="media-folder-create" label={t('media_create', 'Create')} busy={creating()} onConfirm={() => void createMediaFolder()} />}
    >
      <label for="media-folder-name" class="text-[0.72rem] font-extrabold tracking-[0.05em] text-text-secondary uppercase">
        {t('media_folder_name', 'Name')}
      </label>
      <Input
        type="text"
        id="media-folder-name"
        maxlength="200"
        autocomplete="off"
        autofocus
        ref={el => (nameInput = el)}
        onKeyDown={e => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          void createMediaFolder();
        }}
      />
    </Modal>
  );
}
