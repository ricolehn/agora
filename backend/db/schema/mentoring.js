// Mentoring: mentors, conversations and their messages. Message texts are encrypted with a key per conversation that
// is derived from the conversation's id - that is why conversations keep their ids through every upgrade.
const { text, integer, bool, select, link, keptTimes, original } = require('./fields');

const MENTOR_STATES = ['pending', 'approved', 'rejected'];
const THREAD_STATES = ['active', 'open', 'closed', 'blocked_mentor', 'blocked_mentee'];
const SENDER_ROLES = ['mentor', 'mentee'];

// Links are optional: older data can name an account that was deleted without its records (kept in `original`)
const collections = [
  {
    name: 'mentoring_mentors',
    description: 'Members who offer mentoring (after a mentoring manager approved them).',
    fields: [
      link('user', 'users', 'The mentor\'s account.'),
      select('status', MENTOR_STATES, 'pending, approved or rejected.'),
      text('bio', 'What the mentor writes about themselves.'),
      integer('maxMentees', 'How many conversations the mentor takes at most.'),
      bool('isAccepting', 'Takes new conversations.'),
      original(),
      ...keptTimes()
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_mentoring_mentors_user ON mentoring_mentors (user) WHERE user != ''",
      'CREATE INDEX idx_mentoring_mentors_status ON mentoring_mentors (status)'
    ]
  },
  {
    name: 'mentoring_threads',
    description: 'Conversations between a mentor and a mentee. The mentee stays anonymous to the mentor (alias).',
    fields: [
      link('mentor', 'users', 'The mentor\'s account.'),
      link('mentee', 'users', 'The mentee\'s account (never shown to the mentor).'),
      text('menteeAlias', 'The name the mentor sees.', { presentable: true }),
      select('status', THREAD_STATES, 'State of the conversation.'),
      text('lastMessage', 'The beginning of the newest message (encrypted).'),
      original(),
      ...keptTimes()
    ],
    indexes: [
      'CREATE INDEX idx_mentoring_threads_mentor ON mentoring_threads (mentor)',
      'CREATE INDEX idx_mentoring_threads_mentee ON mentoring_threads (mentee)'
    ]
  },
  {
    name: 'mentoring_messages',
    description: 'Messages of a conversation (texts encrypted). Deleted with the conversation.',
    fields: [
      link('thread', 'mentoring_threads', 'The conversation.', { cascadeDelete: true }),
      select('senderRole', SENDER_ROLES, 'Who wrote it: mentor or mentee.'),
      text('text', 'The message (encrypted).'),
      bool('isRead', 'Read by the other side.'),
      original(),
      ...keptTimes()
    ],
    indexes: [
      'CREATE INDEX idx_mentoring_messages_thread ON mentoring_messages (thread, created)',
      'CREATE INDEX idx_mentoring_messages_unread ON mentoring_messages (thread, isRead)'
    ]
  }
];

module.exports = { collections, views: [], MENTOR_STATES, THREAD_STATES, SENDER_ROLES };
