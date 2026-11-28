// Mentoring: anonymous, confidential 1:1 support. Registers the tab, its dialogs, the start page card, its part of the
// page address, the back gesture of the open chat on phones, the live updates and the loads with the app's data.
import './mentoring.css';
import { createEffect, createRoot } from 'solid-js';
import { onSignedOut } from '../../app/auth';
import { onDataLoadStart } from '../../app/data';
import { onLanguageChange } from '../../app/i18n';
import { registerRemoteLoader } from '../../app/live';
import { setNavBadge } from '../../app/nav';
import { registerHomeCard, registerRoot, registerTab } from '../../app/registry';
import { onTabEnter, onTabLeave, registerBackFirst, registerRouteHandler, registerSubPath } from '../../app/router';
import { currentUser } from '../../app/session';
import { MentoringDialogs } from './Dialogs';
import { HomeMentoringCard } from './HomeCard';
import { MentoringPage } from './MentoringPage';
import {
  backFromMobileChat, enterMentoringTab, leaveMentoringTab, loadMentoringData, loadMentoringThreads, mentoringSubPath, openMentoringRoute,
  refreshMentoringFromRemote, stopMentoringPoll, unreadTotal
} from './store';

registerTab('mentoring', MentoringPage);
registerRoot(MentoringDialogs);
registerHomeCard(60, HomeMentoringCard);

onTabEnter('mentoring', enterMentoringTab);
onTabLeave('mentoring', leaveMentoringTab);
registerSubPath('mentoring', mentoringSubPath);
registerRouteHandler('mentoring', { after: openMentoringRoute });
registerBackFirst(backFromMobileChat);

registerRemoteLoader('mentoring', refreshMentoringFromRemote);
// The mentoring entry of both navigations follows the unread conversations (the sub-tab and the start page too)
createRoot(() => createEffect(unreadTotal, count => setNavBadge('mentoring', count)));
// A session that ended stops asking for the open conversation's messages
onSignedOut(() => stopMentoringPoll());
// The conversations (unread counts for the navigation and the start page) load with everything else
onDataLoadStart(() => void loadMentoringThreads(false));
// The lists and the server's texts in the new language
onLanguageChange(() => {
  if (currentUser()) void loadMentoringData();
});
