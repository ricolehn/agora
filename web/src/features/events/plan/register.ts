// The plan (duty roster, order of service), sharing, the page for visitors and the start page's event parts
import { onSignedIn, onSignedOut } from '../../../app/auth';
import { onDataLoaded } from '../../../app/data';
import { registerHomeCard, registerRoot } from '../../../app/registry';
import { registerBackFirst } from '../../../app/router';
import { hasGuestLink } from '../guest/api';
import { backOnGuestPage, endGuestPage, openGuestEvent } from '../guest/guest';
import { GuestPage } from '../guest/GuestPage';
import { HomeDuties, HomeDutyRequests, HomeGreeting, HomeUpcoming, refreshGreeting } from '../home/HomeCards';
import { ShareDialog } from '../share/ShareDialog';
import { PlanEntryDialog } from './PlanEntryDialog';

registerHomeCard(0, HomeGreeting);
registerHomeCard(20, HomeDutyRequests);
registerHomeCard(40, HomeUpcoming);
registerHomeCard(50, HomeDuties);

registerRoot(PlanEntryDialog);
registerRoot(ShareDialog);
registerRoot(GuestPage);

// The greeting follows the time of day with every load of the data
onDataLoaded(() => refreshGreeting());

// Signed in from a shared event's page: the app takes over (the address opens the event as a member)
onSignedIn(() => endGuestPage());
// A shared event's link: visitors without an account see the event (members can sign in from there)
onSignedOut(() => {
  if (!hasGuestLink()) return false;
  void openGuestEvent(true);
  return true;
});
// Signed out, the back gesture keeps the visitor on the shared event's page
registerBackFirst(backOnGuestPage);
