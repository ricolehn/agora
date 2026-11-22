// Media (Extras): the community's Nextcloud folder - browse, view pictures, PDFs, videos and music, add files and
// folders where allowed, and (extended media rights) set who may do what in each folder.
import './media.css';
import { loadMediaStatus } from '../../app/data';
import { registerRemoteLoader } from '../../app/live';
import { registerFab, registerRoot, registerTab } from '../../app/registry';
import { activeTab, onTabEnter, registerLevelBack, registerRouteHandler, registerSubPath } from '../../app/router';
import { mediaFabItems } from './fab';
import {
  enterMediaTab, loadMediaFolder, mediaCanAdd, mediaLevelBack, mediaSubPath, setMediaFolderFromRoute
} from './library';
import { MediaDialogs } from './MediaDialogs';
import { MediaPage } from './MediaPage';

registerTab('media', MediaPage);
registerRoot(MediaDialogs);
// Opening the tab asks for the status (is there still access?) and the open folder
onTabEnter('media', enterMediaTab);
// /media/Photos/2026: the folder, set before the tab opens
registerSubPath('media', mediaSubPath);
registerRouteHandler('media', { before: setMediaFolderFromRoute });
// Back in a folder goes to the folder above (from the base folder: Extras)
registerLevelBack(mediaLevelBack);
registerRemoteLoader('media', () => {
  void loadMediaStatus();
  if (activeTab() === 'media') void loadMediaFolder({ silent: true });
});
registerFab('media', { visible: mediaCanAdd, items: mediaFabItems });
