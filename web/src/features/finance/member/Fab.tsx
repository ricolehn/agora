// The action button of the finances tab (treasurers): record a donation, book an expense.
import type { FabItem } from '../../../app/registry';
import { t } from '../../../app/i18n';
import { Icon } from '../../../ui/Icon';
import { openDonationModal, openExpenseModal } from './api';

export const financeFabItems = (): FabItem[] => [
  {
    icon: () => <Icon name="gift" size={24} />,
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
