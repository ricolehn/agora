// The members' finances tab, the finance dialogs (bookings by the treasury, the members' requests, donations and
// expenses, the fees and the fresh starts), the payment state on the start page, the fees settings page and the
// finances tab's action button.
import { registerFab, registerHomeCard, registerRoot, registerSettingsPage, registerTab } from '../../../app/registry';
import { canManageFinances } from '../../../app/session';
import { DonationDialog } from './dialogs/DonationDialog';
import { ExpenseDialog } from './dialogs/ExpenseDialog';
import { PaymentDialog } from './dialogs/PaymentDialog';
import { RequestDialog } from './dialogs/RequestDialog';
import { StandingOrderDialog } from './dialogs/StandingOrderDialog';
import { StatusDialog } from './dialogs/StatusDialog';
import { financeFabItems } from './Fab';
import { FeeChangeDialog } from './fees/FeeChangeDialog';
import { FeeResetDialog } from './fees/FeeResetDialog';
import { FeesPage } from './fees/FeesPage';
import { HomePaymentDue, HomePaymentOverdue } from './HomePayment';
import { MemberFinancesPage } from './MemberFinances';

registerTab('user-finances', MemberFinancesPage);

// The payment state: a slim line at the end of the start page, moved up after the greeting only when overdue
registerHomeCard(10, HomePaymentOverdue);
registerHomeCard(90, HomePaymentDue);

registerSettingsPage('fees', FeesPage);

registerFab('finances', { visible: () => canManageFinances(), items: financeFabItems });

// The dialogs (mounted at the root: they open from any tab)
for (const dialog of [PaymentDialog, StatusDialog, StandingOrderDialog, DonationDialog, ExpenseDialog, RequestDialog, FeeChangeDialog, FeeResetDialog]) {
  registerRoot(dialog);
}
