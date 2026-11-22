// Prayer requests (Extras): share what is on your heart, with your name or anonymously, and pray for each other.
import { registerRemoteLoader } from '../../app/live';
import { registerFab, registerRoot, registerTab } from '../../app/registry';
import { activeTab, onTabEnter } from '../../app/router';
import { currentUser } from '../../app/session';
import { PrayerEditModal, PrayerOptionsModal, openPrayerEditor } from './PrayerDialogs';
import { PrayersPage } from './PrayersPage';
import { loadPrayers } from './store';

registerTab('prayers', PrayersPage);
registerRoot(PrayerEditModal);
registerRoot(PrayerOptionsModal);
onTabEnter('prayers', () => void loadPrayers());
// The "+" opens the editor directly (one action, no menu)
registerFab('prayers', { visible: () => !!currentUser(), action: openPrayerEditor });
// A live update reloads the requests only while they are shown
registerRemoteLoader('prayers', () => (activeTab() === 'prayers' ? loadPrayers() : null));
