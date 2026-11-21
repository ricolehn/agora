// The dialogs of the finances tab, mounted at the root (a request or a booking opens from the start page too).
import { EditPaymentDialog } from './EditPaymentDialog';
import { ReceiptPreviewDialog } from './Receipts';
import { ReportDialog } from './ReportDialog';
import { RequestDetailDialog } from './RequestDetailDialog';
import { TransactionDetailsDialog } from './TransactionDetailsDialog';

export function FinanceDialogs() {
  return (
    <>
      <RequestDetailDialog />
      <TransactionDetailsDialog />
      <EditPaymentDialog />
      <ReportDialog />
      <ReceiptPreviewDialog />
    </>
  );
}
