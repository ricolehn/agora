import { Show } from 'solid-js';
import { t } from '../../../app/i18n';
import { ownPicture } from '../../../app/pictures';
import { avatarRing, currentUid, currentUser } from '../../../app/session';
import { Avatar } from '../../../ui/Avatar';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { CameraIcon } from '../icons';
import { openProfileCrop } from '../picture';
import { profileName } from '../state';

/** The big picture with the role ring, name, e-mail address and the upload of a new picture. */
export function ProfilePage() {
  let fileInput!: HTMLInputElement;
  const email = () => currentUser()?.email || '';
  const onFile = (input: HTMLInputElement) => {
    const file = input.files?.[0];
    // The same file can be chosen again
    input.value = '';
    void openProfileCrop(file);
  };
  return (
    <Card bodyClass="flex flex-col items-center px-5 pt-5 pb-6 text-center">
      <Avatar uid={currentUid()} name={profileName()} size={96} ring={avatarRing(currentUser())} src={ownPicture() ?? ''} class="text-[1.9rem]!" />
      <div class="mt-3.5 text-[1.2rem] font-extrabold text-text [overflow-wrap:anywhere]">{profileName()}</div>
      <Show when={email() !== profileName() && email()}>
        <div class="text-[0.9rem] text-text-secondary [overflow-wrap:anywhere]">{email()}</div>
      </Show>
      <Button variant="secondary" class="mt-[18px]" onClick={() => fileInput.click()}>
        <CameraIcon />
        <span>{t('btn_upload_pic', 'Upload picture')}</span>
      </Button>
      <input
        ref={el => (fileInput = el)}
        type="file"
        id="profile-pic-input"
        accept="image/*,.heic,.heif"
        class="hidden"
        onChange={e => onFile(e.currentTarget)}
      />
      <div class="mt-2 max-w-[320px] text-[0.78rem] leading-[1.45] text-text-secondary">
        {t('profile_pic_desc', 'JPG, PNG, HEIC – will be saved as 256×256 JPEG.')}
      </div>
    </Card>
  );
}
