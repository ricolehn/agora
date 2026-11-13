// Events: the calendar with sign-ups, guests (people without an account), the duty roster and the order of service.
// Everything that belongs to an event is deleted with it.
const {
  text, day, timeOfDay, integer, bool, moment, json, select, link, links,
  automaticTimes, keptTimes, original
} = require('./fields');

const REGISTRATION_STATES = ['registered', 'waitlist', 'cancelled'];
const GUEST_STATES = ['registered', 'waitlist'];
const DUTY_STATES = ['open', 'requested', 'assigned', 'confirmed', 'declined'];
const EVENT_TYPES = ['event', 'termin'];

// Links here are optional: older data can point to an event or an account that was deleted without its records -
// such a link stays in `original` (nothing is lost) and everything that belongs to an event is deleted with it.
const collections = [
  {
    name: 'events',
    description: 'Events and appointments in the calendar.',
    fields: [
      text('title', 'Title.', { required: true, presentable: true }),
      day('date', 'Day it takes place (the first day of a longer event).', { required: true }),
      day('endDate', 'Last day of an event that lasts several days (empty: one day).'),
      timeOfDay('startTime', 'Start time HH:mm (empty: all day).'),
      timeOfDay('endTime', 'End time HH:mm.'),
      text('location', 'Where.'),
      text('description', 'Description (formatted text).'),
      select('eventType', EVENT_TYPES, 'event: an event of the community; termin: an appointment.'),
      text('status', 'State of the event (scheduled unless an app set something else).'),
      bool('isRecurring', 'Marked as a recurring event.'),
      text('recurringRule', 'The repetition it was created with.'),
      bool('requiresRegistration', 'Members (and guests) sign up for it.'),
      integer('minParticipants', 'Least number of participants (0: none).'),
      integer('maxParticipants', 'Places (0: no limit); who signs up later is on the waiting list.'),
      links('targetGroups', 'user_groups', 'Only these groups see the event (empty and no unmatchedTargetGroups: everyone).'),
      json('unmatchedTargetGroups', 'Target groups named in older data that match no group (they still match a group of that name; the event stays hidden from everyone else).'),
      bool('isPinned', 'Pinned to the top.'),
      text('imageUrl', 'Picture (/api/events/images/... or a web address).'),
      link('createdBy', 'users', 'Who created it.'),
      bool('isPublic', 'Shared: people without an account can open it through its link.'),
      text('publicToken', 'The key in the share link (kept when sharing is switched off and on again).'),
      moment('programUpdated', 'When the order of service was last saved.'),
      original(),
      ...keptTimes()
    ],
    indexes: [
      'CREATE INDEX idx_events_date ON events (date)',
      'CREATE INDEX idx_events_status ON events (status)',
      'CREATE INDEX idx_events_created_by ON events (createdBy)',
      "CREATE UNIQUE INDEX idx_events_public_token ON events (publicToken) WHERE publicToken != ''"
    ]
  },
  {
    name: 'event_registrations',
    description: 'Members who signed up for an event (or cancelled).',
    fields: [
      link('event', 'events', 'The event.', { cascadeDelete: true }),
      link('user', 'users', 'Who signed up.'),
      select('status', REGISTRATION_STATES, 'registered, waitlist or cancelled.'),
      moment('queuedAt', 'Place in the queue: when the person signed up (again after cancelling).'),
      original(),
      ...keptTimes()
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_event_registrations_event_user ON event_registrations (event, user) WHERE event != '' AND user != ''",
      'CREATE INDEX idx_event_registrations_user ON event_registrations (user)'
    ]
  },
  {
    name: 'event_guests',
    description: 'People without an account who signed up through a shared event\'s link. Deleted 30 days after the event.',
    fields: [
      link('event', 'events', 'The event.', { cascadeDelete: true }),
      text('name', 'Full name.', { required: true, presentable: true }),
      text('email', 'E-mail address (only for the event\'s organisers).'),
      integer('age', 'Age.'),
      select('status', GUEST_STATES, 'registered or waitlist (a cancelled place is deleted).'),
      text('key', 'The guest\'s own secret key (in their browser and e-mails): see or cancel the place.', { required: true }),
      text('language', 'Language of the guest\'s e-mails.'),
      moment('queuedAt', 'Place in the queue (shared with the members\' sign-ups).'),
      original(),
      ...keptTimes()
    ],
    indexes: [
      'CREATE INDEX idx_event_guests_event ON event_guests (event)',
      'CREATE UNIQUE INDEX idx_event_guests_key ON event_guests (key)'
    ]
  },
  {
    name: 'event_duties',
    description: 'The duty roster: tasks of an event, given to a group or a person.',
    fields: [
      link('event', 'events', 'The event.', { cascadeDelete: true }),
      text('section', 'Section of the roster.'),
      text('roleName', 'The task.', { required: true, presentable: true }),
      link('assignedGroup', 'user_groups', 'The group that has the task.'),
      link('assignedUser', 'users', 'The person who has the task.'),
      link('requestedUser', 'users', 'The person asked to take it.'),
      link('requestedBy', 'users', 'Who asked.'),
      text('notes', 'Notes.'),
      select('status', DUTY_STATES, 'open, requested, assigned, confirmed or declined.'),
      json('reminded', 'Per person the start of the event they were reminded of (account id → "YYYY-MM-DD HH:mm").'),
      original(),
      ...keptTimes()
    ],
    indexes: [
      'CREATE INDEX idx_event_duties_event ON event_duties (event)',
      'CREATE INDEX idx_event_duties_assigned_user ON event_duties (assignedUser)',
      'CREATE INDEX idx_event_duties_requested_user ON event_duties (requestedUser)',
      'CREATE INDEX idx_event_duties_requested_by ON event_duties (requestedBy)'
    ]
  },
  {
    name: 'event_program_items',
    description: 'The order of service of an event, one record per item in order.',
    fields: [
      link('event', 'events', 'The event.', { cascadeDelete: true }),
      integer('position', 'Place in the order (0 = first).'),
      text('itemId', 'The item\'s own id (the apps address items by it; unique within the event).'),
      text('title', 'Title of the item.', { presentable: true }),
      integer('minutes', 'Duration in minutes (0: none given).'),
      text('who', 'Who does it.'),
      text('note', 'Note.'),
      link('song', 'community_songs', 'The song from the songbook.'),
      text('songKey', 'The key it is sung in (empty: the song\'s own).'),
      original(),
      ...automaticTimes()
    ],
    indexes: ['CREATE INDEX idx_event_program_items_event ON event_program_items (event, position)']
  }
];

module.exports = { collections, views: [], REGISTRATION_STATES, GUEST_STATES, DUTY_STATES, EVENT_TYPES };
