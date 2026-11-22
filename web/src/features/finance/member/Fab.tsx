// The action button of the finances tab (treasurers): record a donation, book an expense.
import type { FabItem } from '../../../app/registry';
import { t } from '../../../app/i18n';
import { Icon } from '../../../ui/Icon';
import { openDonationModal, openExpenseModal } from './api';

function GiftIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="20 12 20 22 4 22 4 12" />
      <rect x="2" y="7" width="20" height="5" />
      <line x1="12" y1="22" x2="12" y2="7" />
      <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
      <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
    </svg>
  );
}

export const financeFabItems = (): FabItem[] => [
  {
    icon: () => <GiftIcon />,
    title: () => t('action_capture_donation', 'Record Donation'),
    subtitle: () => t('action_capture_donation_sub', 'Book an income.'),
    onClick: openDonationModal
  },
  {
    icon: () => <Icon name="dollar" size={24} />,
    title: () => t('action_book_expense', 'Book Expense'),
    subtitle: () => t('action_book_expense_sub', 'Release a payment.'),
    onClick: openExpenseModal
  }
];
