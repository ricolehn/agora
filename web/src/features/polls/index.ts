// Anonymous polls (Extras): browse running and finished polls, vote anonymously, create your own. Switched off on
// instances without polls (backend/features.js): then nothing of it is registered (the router sends /polls to Extras).
import { FEATURES } from '../../app/config';
import { registerRemoteLoader } from '../../app/live';
import { registerFab, registerRoot, registerTab } from '../../app/registry';
import { activeTab, onTabEnter } from '../../app/router';
import { currentUser } from '../../app/session';
import { PollCreateModal, openCreatePoll } from './PollCreate';
import { PollDetailModal } from './PollDetail';
import { PollsPage } from './PollsPage';
import { refreshPolls } from './store';

if (FEATURES.polls) {
  registerTab('polls', PollsPage);
  registerRoot(PollDetailModal);
  registerRoot(PollCreateModal);
  // Every visit brings the latest polls (the first one loads them: the page reads them)
  onTabEnter('polls', () => void refreshPolls());
  // The "+" opens the create page directly (one action, no menu)
  registerFab('polls', { visible: () => !!currentUser(), action: openCreatePoll });
  // A live update reloads the polls only while they are shown
  registerRemoteLoader('polls', () => (activeTab() === 'polls' ? refreshPolls() : null));
}
