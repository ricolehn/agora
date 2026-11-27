// Appointments and events as the server sends them (backend/routes/events.js): GET /api/events with the duties and
// the own registration, the own duty requests, the participants of an event and the people and groups a duty can go
// to. Appointments ("termin") are the community's dates; events are what members put on.

/** Where a duty stands: nobody yet, asked of someone, given to a group, taken, turned down, done. */
export type DutyStatus = 'open' | 'requested' | 'assigned' | 'confirmed' | 'declined' | 'erledigt';

/** A duty of an event (its task, who has it, who asked whom). */
export interface Duty {
  id: string;
  event?: string;
  /** The heading it is listed under. */
  section?: string;
  roleName?: string;
  assignedGroup?: string;
  assignedGroupName?: string;
  assignedUser?: string;
  assignedUserName?: string;
  requestedUser?: string;
  requestedUserName?: string;
  requestedBy?: string;
  requestedByName?: string;
  notes?: string;
  status?: DutyStatus | string;
  canEditNotes?: boolean;
  canManageDuty?: boolean;
}

/** A registration: on the list, or waiting for a place. */
export type RegistrationStatus = 'registered' | 'waitlist';

export interface AppEvent {
  id: string;
  title: string;
  /** 'YYYY-MM-DD'; a stretch of days ends on endDate. */
  date: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  description?: string;
  eventType?: 'termin' | 'event' | string;
  isPinned?: boolean;
  isOfficialTermin?: boolean;
  createdByManager?: boolean;
  isRecurring?: boolean;
  recurringRule?: string;
  /** A new series: how many dates it gets (sent when it is created). */
  recurringCount?: number;
  seriesId?: string;
  status?: 'scheduled' | 'cancelled' | string;
  requiresRegistration?: boolean;
  minParticipants?: number;
  maxParticipants?: number;
  /** The groups it is for (by name; none: everyone). */
  targetGroups?: string[];
  createdBy?: string;
  createdByName?: string;
  created?: string;
  imageUrl?: string;
  duties?: Duty[];
  registeredCount?: number;
  waitlistCount?: number;
  myRegistration?: { id?: string; status?: RegistrationStatus | string } | null;
  isFull?: boolean;
  canEdit?: boolean;
  canAccessDutyPlan?: boolean;
  /** Shared by link with people without an account (the link carries publicToken). */
  isPublic?: boolean;
  publicToken?: string;
}

/** A duty someone asked of me (GET /api/events/my-requests). */
export interface DutyRequest {
  id: string;
  eventId: string;
  eventTitle: string;
  eventDate: string;
  eventStartTime?: string;
  eventEndTime?: string;
  eventLocation?: string;
  section?: string;
  roleName?: string;
  requestedBy?: string;
  requestedByName?: string;
  notes?: string;
}

/** Someone on the list of an event: a member, or a guest who registered through the public link. */
export interface Attendee {
  id: string;
  /** The member's account, or "guest:<id>" for a guest. */
  userId: string;
  name: string;
  status: RegistrationStatus | string;
  created?: string;
  guest?: boolean;
  /** A guest's details, for those who edit the event. */
  email?: string;
  age?: number;
}

/** GET /api/events/<id>/attendees */
export interface AttendeeList {
  eventId: string;
  registered: Attendee[];
  waitlist: Attendee[];
  registeredCount: number;
  waitlistCount: number;
  maxParticipants: number;
}

/** A person a duty can be asked of (GET /api/events/candidates). */
export interface Candidate {
  id: string;
  name: string;
  email?: string;
  groups?: string[];
}

/** A shared event as visitors without an account see it (backend/eventGuests.js publicEventView). */
export interface PublicEvent {
  title: string;
  eventType: 'termin' | 'event';
  isPinned: boolean;
  date: string;
  endDate: string;
  startTime: string;
  endTime: string;
  location: string;
  description: string;
  imageUrl: string;
  status: 'scheduled' | 'cancelled';
  isPast: boolean;
  requiresRegistration: boolean;
  minParticipants: number;
  maxParticipants: number;
  registeredCount: number;
  isFull: boolean;
  registrationOpen: boolean;
}

/** What the pages of an event show of it: the same for an event of the app and for a shared one (visitors). */
export type EventFacts = Pick<
  AppEvent,
  | 'title'
  | 'eventType'
  | 'isPinned'
  | 'date'
  | 'endDate'
  | 'startTime'
  | 'endTime'
  | 'location'
  | 'description'
  | 'imageUrl'
  | 'status'
  | 'requiresRegistration'
  | 'minParticipants'
  | 'maxParticipants'
  | 'registeredCount'
  | 'isFull'
>;

/** The answer to saving an event: the saved one (a new series: its first date, and how many there are). */
export interface EventSaved {
  event?: AppEvent;
  count?: number;
}

/** The order of service of an event (GET/PUT /api/events/<id>/program). */
export interface ProgramAnswer<Item> {
  items?: Item[];
  canEdit?: boolean;
}
