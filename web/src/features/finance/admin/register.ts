// The finances tab of those who see the books (overview with the history, fee list), the open requests on the start
// page, and the dialogs of requests, bookings and the report.
import './finances.css';
import { onDataLoaded } from '../../../app/data';
import { registerHomeCard, registerRoot, registerTab } from '../../../app/registry';
import { onTabEnter, registerRouteHandler, registerSubPath, takeFinanceSubpageRequest } from '../../../app/router';
import { FinanceDialogs } from './Dialogs';
import { FinancesPage } from './FinancesPage';
import { HomeFinanceRequests } from './RequestsCard';
import { loadSubpage, refreshFinanceViews, setSubpage, subpage, switchFinanceSubpage } from './state';

registerTab('finances', FinancesPage);

// /finances is the overview, /finances/members the fee list
registerSubPath('finances', () => (subpage() === 'members' ? 'members' : ''));
registerRouteHandler('finances', {
  after: rest => {
    if (rest[0] === 'members') switchFinanceSubpage('members');
  }
});

// Every visit loads what the shown sub-page needs; an old tab id may ask for a sub-page ('overview', 'people-view')
onTabEnter('finances', () => {
  const requested = takeFinanceSubpageRequest();
  if (requested) setSubpage(requested);
  loadSubpage(requested ?? subpage());
});

// A load of the data (a live update after a booking here or elsewhere): the balance, and the history on screen
onDataLoaded(() => refreshFinanceViews({ quiet: true }));

registerHomeCard(30, HomeFinanceRequests);
registerRoot(FinanceDialogs);
