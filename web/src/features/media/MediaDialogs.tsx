// The library's menu and dialogs, mounted at the root (they keep the ids the app has always used).
import { MediaFolderDialog } from './MediaFolderDialog';
import { MediaMenu } from './MediaMenu';
import { MediaPdf } from './MediaPdf';
import { MediaPlayer } from './MediaPlayer';
import { MediaRightsDialogs } from './MediaRights';
import { MediaViewer } from './MediaViewer';

export function MediaDialogs() {
  return (
    <>
      <MediaMenu />
      <MediaViewer />
      <MediaPlayer />
      <MediaPdf />
      <MediaRightsDialogs />
      <MediaFolderDialog />
    </>
  );
}
