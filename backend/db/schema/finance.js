// Finance: the members in the books, their payments, status periods and standing orders, donations, expenses, the
// fees over time, fresh starts, requests and the change log. Money is in whole cents everywhere.
//
// Nothing here is deleted because a login or a group is deleted: a member's link to its login is optional (it is just
// cleared), and a payment's link to its member is required - the database refuses to delete a member who still has
// payments (members are marked deleted instead, see isDeleted).
const {
  text, day, month, cents, integer, bool, moment, json, select, link,
  automaticTimes, keptId, original
} = require('./fields');

const INCOME_STATUSES = ['vollverdiener', 'geringverdiener', 'keinverdiener', 'pausiert'];
const REQUEST_TYPES = ['payment', 'expense', 'status', 'standing_order'];
const REQUEST_STATES = ['pending', 'approved', 'rejected'];
const PAYMENT_SOURCES = ['manual', 'standingOrder', 'request'];
const CHANGE_AREAS = ['fees', 'freshStart', 'payment', 'donation', 'expense', 'standingOrder', 'statusPeriod', 'member', 'request'];

const clientId = () => json('clientId', 'The id the app gave this entry (older apps address it by this id; a number or a text).');

const collections = [
  {
    name: 'finance_members',
    description: 'Everyone in the books: name, income status, membership days, and the link to their login. Payments, status periods and standing orders point here.',
    id: keptId(),
    fields: [
      text('name', 'Full name as it appears in the books.', { required: true, presentable: true }),
      link('user', 'users', 'The member\'s login account (empty: the member has no account).'),
      select('status', INCOME_STATUSES, 'Income status today; it decides the monthly fee. Earlier statuses are in finance_status_periods.'),
      day('memberSince', 'Day the (current) membership started.'),
      day('originalMemberSince', 'Day of the very first membership; the fee account counts from it.'),
      bool('pays', 'Whether the member pays fees.'),
      bool('isDeleted', 'Deleted member: only the name and the payments stay, for the books.'),
      original(),
      ...automaticTimes()
    ],
    indexes: [
      'CREATE INDEX idx_finance_members_user ON finance_members (user)',
      'CREATE INDEX idx_finance_members_name ON finance_members (name)',
      'CREATE INDEX idx_finance_members_status ON finance_members (status)'
    ]
  },
  {
    name: 'finance_payments',
    description: 'Every payment a member made toward the fees, one record each.',
    fields: [
      link('member', 'finance_members', 'Who paid. Required: a member with payments cannot be deleted.', { required: true }),
      cents('amountCents', 'Amount in cents (5000 = 50.00 €).'),
      day('date', 'Day of the payment.'),
      text('description', 'What the payment was for.'),
      text('receipt', 'File name of the receipt (receipts folder in the data directory).'),
      select('source', PAYMENT_SOURCES, 'Where it came from: booked by hand, booked by a standing order, or an approved request.'),
      link('standingOrder', 'finance_standing_orders', 'The standing order that booked it (source standingOrder).'),
      clientId(),
      original(),
      ...automaticTimes()
    ],
    indexes: [
      'CREATE INDEX idx_finance_payments_member_date ON finance_payments (member, date)',
      'CREATE INDEX idx_finance_payments_date ON finance_payments (date)'
    ]
  },
  {
    name: 'finance_status_periods',
    description: 'A member\'s income status over time: one record per period. The fee of a month follows the status of that month.',
    fields: [
      link('member', 'finance_members', 'Whose status.', { required: true, cascadeDelete: true }),
      select('status', INCOME_STATUSES, 'Income status in this period.'),
      day('startDate', 'First day of the period.'),
      day('endDate', 'Day the period ended (empty: still running).'),
      clientId(),
      original(),
      ...automaticTimes()
    ],
    indexes: ['CREATE INDEX idx_finance_status_periods_member ON finance_status_periods (member, startDate)']
  },
  {
    name: 'finance_standing_orders',
    description: 'Standing orders: a monthly amount a member pays; the server books the payments when they are due.',
    fields: [
      link('member', 'finance_members', 'Who pays.', { required: true, cascadeDelete: true }),
      cents('amountCents', 'Monthly amount in cents.'),
      day('startDate', 'Day of the first payment.'),
      day('endDate', 'Last day (empty: runs until ended).'),
      text('note', 'Note, also the description of the payments it books.'),
      day('lastAutoPayment', 'Day of the last payment it booked.'),
      integer('position', 'Order among the member\'s standing orders.'),
      clientId(),
      original(),
      ...automaticTimes()
    ],
    indexes: ['CREATE INDEX idx_finance_standing_orders_member ON finance_standing_orders (member)']
  },
  {
    name: 'finance_donations',
    description: 'Donations, one record each.',
    fields: [
      cents('amountCents', 'Amount in cents.'),
      day('date', 'Day of the donation.'),
      text('donorName', 'Who donated.', { presentable: true }),
      text('description', 'Note.'),
      integer('position', 'Order in the donation list.'),
      clientId(),
      original(),
      ...automaticTimes()
    ],
    indexes: ['CREATE INDEX idx_finance_donations_date ON finance_donations (date)']
  },
  {
    name: 'finance_expenses',
    description: 'Expenses, one record each.',
    fields: [
      cents('amountCents', 'Amount in cents.'),
      day('date', 'Day of the expense.'),
      text('issuer', 'Who paid it (and gets it back).', { presentable: true }),
      text('description', 'What it was for.'),
      text('receipt', 'File name of the receipt (receipts folder in the data directory).'),
      clientId(),
      original(),
      ...automaticTimes()
    ],
    indexes: ['CREATE INDEX idx_finance_expenses_date ON finance_expenses (date)']
  },
  {
    name: 'finance_requests',
    description: 'What members ask the treasury for: a payment to book, an expense to pay back, a status change, a standing order. Decided requests are deleted 30 days after the decision.',
    id: keptId(),
    fields: [
      select('type', REQUEST_TYPES, 'What is asked for.'),
      select('status', REQUEST_STATES, 'pending, approved or rejected.'),
      link('user', 'users', 'Who sent it.'),
      link('member', 'finance_members', 'The member it is about.'),
      text('memberName', 'The member\'s name when it was sent.', { presentable: true }),
      cents('amountCents', 'Amount in cents (payment, expense, standing order).'),
      day('date', 'Day it is about.'),
      select('newStatus', INCOME_STATUSES, 'The status asked for (type status).'),
      text('note', 'Note of the member.'),
      text('description', 'What an expense was for.'),
      text('receipt', 'File name of the receipt of an expense.'),
      text('rejectionReason', 'Why it was rejected.'),
      moment('submittedAt', 'When it was sent.'),
      moment('decidedAt', 'When it was approved or rejected.'),
      original(),
      ...automaticTimes()
    ],
    indexes: [
      'CREATE INDEX idx_finance_requests_user ON finance_requests (user)',
      'CREATE INDEX idx_finance_requests_status ON finance_requests (status)'
    ]
  },
  {
    name: 'finance_fee_changes',
    description: 'The monthly fees over time: the fees from the beginning (fromMonth empty) and every change, each with the month it counts from. A month costs the fees of the latest change at or before it.',
    fields: [
      month('fromMonth', 'First month these fees count for (empty: from the beginning).'),
      json('feesCents', 'Monthly fee per income status in cents, e.g. {"vollverdiener": 5000, "geringverdiener": 2500}.'),
      moment('setAt', 'When the change was entered.'),
      text('setBy', 'Account id of who entered it (may belong to an account deleted since).'),
      text('setByName', 'Name of who entered it.'),
      ...automaticTimes()
    ],
    indexes: ['CREATE UNIQUE INDEX idx_finance_fee_changes_from ON finance_fee_changes (fromMonth)']
  },
  {
    name: 'finance_fresh_starts',
    description: 'Fresh starts of all fee accounts: from that day on, open fees are dropped and credit is carried over.',
    fields: [
      day('day', 'The day the fee accounts start afresh.', { required: true }),
      json('feesBeforeCents', 'The fees the months before it cost when it was set (status to cents), for data from before the fees had a history.'),
      moment('setAt', 'When it was set.'),
      text('setBy', 'Account id of who set it (may belong to an account deleted since).'),
      text('setByName', 'Name of who set it.'),
      ...automaticTimes()
    ],
    indexes: ['CREATE UNIQUE INDEX idx_finance_fresh_starts_day ON finance_fresh_starts (day)']
  },
  {
    name: 'finance_changes',
    description: 'The finance change log: who changed what and when. Kept for the bookkeeping period, then removed automatically.',
    fields: [
      select('area', CHANGE_AREAS, 'What was changed.'),
      text('action', 'What happened (e.g. create, update, delete, set, removed).'),
      moment('at', 'When it happened.'),
      text('by', 'Account id of who did it (may belong to an account deleted since).'),
      text('byName', 'Name of who did it.'),
      link('member', 'finance_members', 'The member it concerns, if any.'),
      text('target', 'Id of the record that changed.'),
      json('details', 'The change: the values before and after, or the log entry of a fee change or fresh start.'),
      ...automaticTimes()
    ],
    indexes: [
      'CREATE INDEX idx_finance_changes_area_at ON finance_changes (area, at)',
      'CREATE INDEX idx_finance_changes_member ON finance_changes (member)'
    ]
  }
];

// Views: read-only tables the database computes when they are read (nothing stored, never out of date)
const views = [
  {
    name: 'finance_ledger',
    description: 'All money in one list (read-only view): member payments and donations come in, expenses go out.',
    viewQuery: `SELECT id, kind, date, amountCents, who, description, member, receipt FROM (
SELECT ('p' || p.id) AS id, 'memberPayment' AS kind, p.date AS date, p.amountCents AS amountCents, m.name AS who, p.description AS description, p.member AS member, p.receipt AS receipt FROM finance_payments p LEFT JOIN finance_members m ON m.id = p.member
UNION ALL SELECT ('d' || d.id) AS id, 'donation' AS kind, d.date AS date, d.amountCents AS amountCents, d.donorName AS who, d.description AS description, '' AS member, '' AS receipt FROM finance_donations d
UNION ALL SELECT ('e' || e.id) AS id, 'expense' AS kind, e.date AS date, e.amountCents AS amountCents, e.issuer AS who, e.description AS description, '' AS member, e.receipt AS receipt FROM finance_expenses e
)`
  },
  {
    name: 'finance_monthly_totals',
    description: 'Money per month and kind (read-only view): the sum and the number of entries.',
    viewQuery: `SELECT (substr(date, 1, 7) || '-' || kind) AS id, substr(date, 1, 7) AS month, kind, SUM(amountCents) AS totalCents, COUNT(*) AS entries FROM (
SELECT date, 'memberPayment' AS kind, amountCents FROM finance_payments
UNION ALL SELECT date, 'donation' AS kind, amountCents FROM finance_donations
UNION ALL SELECT date, 'expense' AS kind, amountCents FROM finance_expenses
) WHERE date != '' GROUP BY substr(date, 1, 7), kind`
  }
];

module.exports = { collections, views, INCOME_STATUSES, REQUEST_TYPES, REQUEST_STATES, PAYMENT_SOURCES, CHANGE_AREAS };
