// The floating button in the library: upload and new folder, where the member may write.
import type { FabItem } from '../../app/registry';
import { t } from '../../app/i18n';
import { Icon } from '../../ui/Icon';
import { pickMediaFiles } from './actions';
import { openMediaFolderDialog } from './MediaFolderDialog';

export const mediaFabItems = (): FabItem[] => [
  {
    icon: () => <Icon name="upload" size={24} strokeWidth={2} />,
    tint: { background: 'rgba(37, 99, 235, 0.14)', color: '#2563eb' },
    title: () => t('media_upload', 'Upload files'),
    subtitle: () => t('media_upload_sub', 'Pictures, PDFs and other files into this folder'),
    onClick: pickMediaFiles
  },
  {
    icon: () => <Icon name="folderPlus" size={24} />,
    tint: { background: 'rgba(217, 119, 6, 0.14)', color: '#d97706' },
    title: () => t('media_new_folder', 'New folder'),
    subtitle: () => t('media_new_folder_sub', 'Inside the folder that is open'),
    onClick: openMediaFolderDialog
  }
];
