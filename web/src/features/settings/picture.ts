// The own profile picture: cropped to a square (256x256 JPEG) and uploaded.
import { apiJson, errorMessage } from '../../app/api';
import { t } from '../../app/i18n';
import { forgetProfilePic, refreshOwnPicture, setPictureVersion } from '../../app/pictures';
import { currentUid } from '../../app/session';
import { showToast } from '../../app/toast';
import { toFormData } from '../../app/util';
import { openImageCrop } from '../../ui/crop';

async function uploadProfilePicture(blob: Blob): Promise<boolean> {
  try {
    const picture = new File([blob], 'profile.jpg', { type: 'image/jpeg' });
    const saved = await apiJson<{ version?: number }>('/profile/picture', 'POST', toFormData({ picture }), t('toast_upload_failed_short', 'Upload failed'));
    showToast(t('toast_profile_pic_saved', 'Profile picture saved!'), 'success');
    // A new version: a new address, so no list shows the old picture from the browser's cache
    const uid = currentUid();
    if (uid) {
      setPictureVersion(uid, saved?.version || Date.now());
      forgetProfilePic(uid);
    }
    refreshOwnPicture();
    return true;
  } catch (e) {
    console.error('Profile upload error:', e);
    showToast(t('toast_upload_failed', 'Upload failed: ') + errorMessage(e), 'error');
    return false;
  }
}

/** The chosen file in the crop dialog (the round frame; saved as 256x256 JPEG). */
export function openProfileCrop(file: File | undefined) {
  if (!file) return;
  openImageCrop({ file, shape: 'square', title: t('profile_crop_title', 'Crop Profile Picture'), onConfirm: uploadProfilePicture });
}
