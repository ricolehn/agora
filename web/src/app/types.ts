// The community's data as the server sends it: accounts, groups, the members' fee accounts with their payments, the
// requests, the fees over time and the fresh starts of the fee accounts. Fields the server works out about a fee
// account start with "_" (backend/derivedData.js); old records may still carry their values in an inner "data"
// object (from the Firebase days), so the readers look there too.

/** A member's status: what they pay depends on it. */
export const MEMBER_STATUSES = ['vollverdiener', 'geringverdiener', 'keinverdiener', 'pausiert'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];
export const isMemberStatus = (value: unknown): value is MemberStatus => (MEMBER_STATUSES as readonly unknown[]).includes(value);

// --- Accounts and groups ---
/** A permission a group gives (backend/permissions.js SYSTEM_PERMISSIONS). */
export type PermissionId =
  | 'view_finances'
  | 'manage_finances'
  | 'manage_registration_code'
  | 'access_ai'
  | 'manage_mentoring'
  | 'manage_events'
  | 'manage_songbook'
  | 'manage_prayers'
  | 'manage_media';

/** The flags of the old API on an account (backend/permissions.js permissionFlags). */
export type PermissionFlag =
  | 'canManageFinances'
  | 'canViewFinances'
  | 'canManageRegistrationCode'
  | 'canAccessAi'
  | 'canParticipateMentoring'
  | 'canManageMentoring'
  | 'canManageEvents';

/** A permission with its name and description in the reader's language (GET /api/admin/permissions). */
export interface Permission {
  id: string;
  name: string;
  description?: string;
}

/** A group: its permissions, and for system admins how many accounts are in it. */
export interface Group {
  id: string;
  name: string;
  permissions?: string[];
  memberCount?: number;
}

/** The kinds of messages a person can choose per channel. */
export type NotificationKind = 'duties' | 'events' | 'messages' | 'requests' | 'finances' | 'reports';

/**
 * The channels and the kinds of messages per channel as stored (backend notificationPrefs.js); the flat keys repeat
 * the push choices for older apps.
 */
export interface NotificationSettingsWire extends Partial<Record<NotificationKind, boolean>> {
  channels?: { push?: boolean; email?: boolean };
  push?: Partial<Record<NotificationKind, boolean>>;
  email?: Partial<Record<NotificationKind, boolean>>;
}

/**
 * An account: the signed-in person (GET /api/auth/me), a row of the system settings (GET /api/admin/users) or an
 * entry of the accounts list the treasury sees. What only one of them carries is optional.
 */
export interface User extends Partial<Record<PermissionFlag, boolean>> {
  uid: string;
  id?: string;
  email?: string;
  rawEmail?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  role?: string;
  admin?: boolean;
  owner?: boolean;
  superAdmin?: boolean;
  /** Pays the membership fee (false: an account without a fee). */
  pays?: boolean;
  /** The groups by id (very old accounts: by name). */
  groups?: string[];
  groupIds?: string[];
  groupNames?: string[];
  /** The groups with their names and permissions (system settings). */
  groupObjects?: Group[];
  permissions?: string[];
  emailNotifications?: boolean;
  notificationSettings?: NotificationSettingsWire;
  /** False while the account has a placeholder address (made by an admin, not signed in yet). */
  isClaimed?: boolean;
  calendarToken?: string;
  language?: string;
  timeZone?: string;
  mentorStatus?: string | null;
  isApprovedMentor?: boolean;
  /** From the linked fee account (system settings). */
  memberSince?: string;
  status?: string;
}

/** The signed-in account as the server confirms it (GET /api/auth/me), with a fresh token. */
export interface SessionAnswer {
  user?: User;
  token?: string;
}

// --- Fee accounts ---
/** A payment booked on a fee account; old amounts can be texts like "50,00", old payments have no id. */
export interface Payment {
  id?: string | number;
  amount: number | string;
  date: string;
  description?: string;
  /** Booked by a standing order. */
  isAuto?: boolean;
  /** The receipts as a JSON list of file names. */
  receipt?: string | null;
  tags?: string | string[];
}

/** A stretch of time with one status; the last one has no end. */
export interface StatusEntry {
  status: MemberStatus | string;
  startDate: string;
  endDate?: string;
}

/** A standing order: the amount each month from its start (to its end), booked up to today. */
export interface StandingOrder {
  id: string;
  amount: number | string;
  startDate: string;
  endDate?: string | null;
  note?: string;
  lastAutoPayment?: string | null;
}

/** The state of a fee account in fixed German words (the apps translate them) and what it means. */
export interface StatusMeta {
  text: string;
  isOverdue: boolean;
  isSoonDue: boolean;
  isActiveStandingOrder?: boolean;
}

/** What a record held before the move to PocketBase (some fields are still read from there). */
export interface LegacyPersonData {
  uid?: string;
  isDeleted?: boolean;
  memberSince?: string;
  originalMemberSince?: string;
  status?: string;
  pays?: boolean;
}

/** A member's fee account (people/<id>) as the app keeps it: lists are lists, the total is worked out. */
export interface Person {
  id: string;
  /** The account it belongs to (none for a member without an account). */
  uid?: string;
  name: string;
  status?: MemberStatus | string;
  memberSince: string;
  originalMemberSince: string;
  pays?: boolean;
  payments: Payment[];
  totalPaid: number;
  statusHistory: StatusEntry[];
  standingOrders?: StandingOrder[];
  isDeleted?: boolean;
  data?: LegacyPersonData;
  // Worked out by the server
  _paidUntil?: string | null;
  _statusMeta?: StatusMeta;
  _overdueAmount?: number;
  _currentStatus?: string;
  _currentBalance?: number;
  _anticipatedPayment?: number;
  _overpayment?: number;
  /** The fresh start the account counts from ('YYYY-MM-DD'), with the credit taken along or the fees dropped then. */
  _feeReset?: string | null;
  _feeCarriedOver?: number;
  _feeWrittenOff?: number;
  _monthlyFee?: number;
}

/** A fee account as the server stores it: the lists may be missing or objects keyed by id. */
export type PersonRecord = Omit<Person, 'payments' | 'statusHistory' | 'totalPaid' | 'memberSince' | 'originalMemberSince'> & {
  payments?: Payment[] | Record<string, Payment>;
  statusHistory?: StatusEntry[] | Record<string, StatusEntry>;
  totalPaid?: number;
  memberSince?: string;
  originalMemberSince?: string;
};

// --- Requests ---
export type RequestType = 'payment' | 'standing_order' | 'status' | 'expense';
export type RequestState = 'pending' | 'approved' | 'rejected';

/** What a request asks for; which fields it has depends on its type. */
export interface RequestData {
  /** A payment, a standing order, an expense: the amount as a plain number text ("1500", "12.5"). */
  amount?: string | number;
  /** The day of a payment or an expense, the start of a standing order, the day a new status counts from. */
  date?: string;
  note?: string;
  description?: string;
  newStatus?: MemberStatus | string;
  /** An expense's receipts as a JSON list of file names. */
  receipt?: string | null;
}

/** A member's request (requests/<id>): the treasury approves or rejects it. */
export interface FinanceRequest {
  id: string;
  type: RequestType | string;
  status: RequestState | string;
  userId?: string;
  personId?: string;
  personName?: string;
  data?: RequestData;
  timestamp?: number;
  rejectionReason?: string;
}

// --- Donations and expenses (stored as whole lists) ---
export interface Donation {
  id: string | number;
  amount: number | string;
  name: string;
  date: string;
  description?: string;
  tags?: string | string[];
}
export interface Expense {
  id: string | number;
  amount: number | string;
  issuer: string;
  description?: string;
  date: string;
  receipt?: string | null;
  tags?: string | string[];
}

/** The lists stored whole, by name (lib/collections.ts changes them). */
export interface Collections {
  donations: Donation;
  expenses: Expense;
}

/** A booking of any kind as the history lists it: what a payment, a donation or an expense can hold. */
export interface BookingFields {
  id?: string | number;
  amount: number | string;
  date?: string;
  description?: string;
  /** An expense's issuer (who was paid). */
  issuer?: string;
  /** A donation's donor. */
  name?: string;
  note?: string;
  receipt?: string | null;
  tags?: string | string[];
  isAuto?: boolean;
}

// --- Fees ---
/** The monthly fee by status (the settings also keep the day reports start from). */
export interface FeeSettings {
  vollverdiener: number;
  geringverdiener: number;
  keinverdiener: number;
  pausiert: number;
  reportStartDate: string | null;
}

/** The fees of the paying statuses, as a change of the fees sets them. */
export type Fees = Partial<Record<'vollverdiener' | 'geringverdiener' | 'keinverdiener', number>>;

/** The fees from a month on ('YYYY-MM'; null: from the beginning) with what that is today. */
export interface FeePlanEntry {
  from: string | null;
  fees: Fees;
  state: 'current' | 'planned' | 'past' | string;
  setAt?: number;
  setByName?: string;
}

/** A line of the log of the fees: who set or took back which fees. */
export interface FeeLogEntry {
  action: 'set' | 'removed' | string;
  from: string | null;
  fees?: Fees;
  movedFrom?: string | null;
  by?: string;
  byName?: string;
  at?: number;
}

/** The fees over time (GET /api/fees): this month's, the next change, all of them, and for insiders the log. */
export interface FeePlan {
  today: string;
  month: string;
  current: Fees;
  since: string | null;
  next: { from: string; fees: Fees } | null;
  entries: FeePlanEntry[];
  log?: FeeLogEntry[];
  version?: string;
}

/** A day all fee accounts were started afresh, with what it is today. */
export interface FeeReset {
  date: string;
  state: 'active' | 'scheduled' | 'replaced' | string;
  feesBefore?: Fees;
  setAt?: number;
  setByName?: string;
}

/** A line of the log of the fresh starts. */
export interface FeeResetLogEntry {
  action: 'set' | 'removed' | string;
  date: string;
  by?: string;
  byName?: string;
  at?: number;
}

// --- Media ---
/** Whether the library is on, and what the signed-in person may do there (GET /api/media/status). */
export interface MediaStatus {
  enabled: boolean;
  canManage: boolean;
  hasAccess: boolean;
}
