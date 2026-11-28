// Songbook (Extras): songs with chords, readable while playing - transposable, with auto-scroll; managed by members
// with the songbook permission.
import './songbook.css';
import { registerRemoteLoader } from '../../app/live';
import { registerFab, registerRoot, registerTab } from '../../app/registry';
import { activeTab, onTabEnter, registerRouteHandler, registerRouteOverride } from '../../app/router';
import { SongbookPage } from './SongbookPage';
import { SongEditorModal, openSongEditor } from './SongEditor';
import { SongViewModal } from './SongView';
import { canManageSongs, refreshSongbook, songSlug } from './store';
import { openSongBySlug, shownSong } from './view';

registerTab('songbook', SongbookPage);
registerRoot(SongViewModal);
registerRoot(SongEditorModal);
// Every visit brings the latest songs (the first one loads them: the page reads them)
onTabEnter('songbook', () => void refreshSongbook());
// /songbook/<name> (old links #songbook/<id>): the song opens once the songs are loaded
registerRouteHandler('songbook', {
  before: rest => {
    if (rest[0]) void openSongBySlug(rest[0]);
  }
});
// An open song has its own address
registerRouteOverride(() => {
  const song = shownSong();
  return song ? `/songbook/${encodeURIComponent(songSlug(song))}` : null;
});
// The "+" opens the editor directly, for those who may manage songs
registerFab('songbook', { visible: () => canManageSongs(), action: () => openSongEditor() });
// A live update reloads the songs only while the songbook is shown
registerRemoteLoader('songs', () => (activeTab() === 'songbook' ? refreshSongbook() : null));
