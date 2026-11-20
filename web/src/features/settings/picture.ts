// The own profile picture: cropped to a square (256x256 JPEG) and uploaded.
import { flush } from 'solid-js';
import { apiJson } from '../../app/api';
import { t } from '../../app/i18n';
import { forgetProfilePic, loadCurrentProfilePicture, loadPictureVersions } from '../../app/pictures';
import { currentUid } from '../../app/session';
import { showToast } from '../../app/toast';
import { convertHeic, toFormData } from '../../app/util';
import { openImageCrop } from '../../ui/crop';

// A new version means a new address, so no list shows the old picture from the browser's cache: the versions come
// from the server again, then the own picture (header, settings) is fetched again
async function showNewPicture(uid: string | undefined) {
  await loadPictureVersions();
  flush();
  if (uid) forgetProfilePic(uid);
  await loadCurrentProfilePicture();
}

async function uploadProfilePicture(blob: Blob): Promise<boolean> {
  try {
    const picture = new File([blob], 'profile.jpg', { type: 'image/jpeg' });
    await apiJson('/profile/picture', 'POST', toFormData({ picture }), t('toast_upload_failed_short', 'Upload failed'));
    showToast(t('toast_profile_pic_saved', 'Profile picture saved!'), 'success');
    void showNewPicture(currentUid());
    return true;
  } catch (e: any) {
    console.error('Profile upload error:', e);
    showToast(t('toast_upload_failed', 'Upload failed: ') + e.message, 'error');
    return false;
  }
}

/** The chosen file in the crop dialog (iPhone photos become JPEG first). */
export async function openProfileCrop(file: File | undefined) {
  if (!file) return;
  openImageCrop({
    file: (await convertHeic(file, 0.9)) as File,
    shape: 'square',
    title: t('profile_crop_title', 'Crop Profile Picture'),
    subtitle: t('profile_crop_desc', 'Drag and zoom image to choose crop area'),
    confirmLabel: t('btn_save', 'Save'),
    onConfirm: uploadProfilePicture
  });
}
