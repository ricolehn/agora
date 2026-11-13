// Mentoring: mentors, conversations and their messages exactly as the old tables kept them (snake_case fields, texts
// encrypted with a key per conversation), and as the new tables keep them (see ../codec.js).
const { createCodec, fieldKinds: f } = require('../codec');
const { MENTOR_STATES, THREAD_STATES, SENDER_ROLES } = require('../schema/mentoring');

const recordId = { column: 'id', toColumn: (value, source, ctx) => ctx.recordId ?? String(value ?? ''), fromColumn: (stored) => stored };

const MENTOR_KEYS = ['id', 'user', 'status', 'bio', 'max_mentees', 'is_accepting', 'created'];
const mentor = createCodec({
  fields: {
    id: recordId,
    user: f.link('user', 'users'),
    status: f.select('status', MENTOR_STATES),
    bio: f.text('bio'),
    max_mentees: f.number('maxMentees'),
    is_accepting: f.bool('isAccepting'),
    created: f.isoTime('created')
  },
  canonicalKeys: () => MENTOR_KEYS
});

const THREAD_KEYS = ['id', 'mentor', 'mentee', 'mentee_alias', 'status', 'last_message', 'created', 'updated'];
const thread = createCodec({
  fields: {
    id: recordId,
    mentor: f.link('mentor', 'users'),
    mentee: f.link('mentee', 'users'),
    mentee_alias: f.text('menteeAlias'),
    status: f.select('status', THREAD_STATES),
    last_message: f.text('lastMessage'),
    created: f.isoTime('created'),
    updated: f.isoTime('updated')
  },
  canonicalKeys: () => THREAD_KEYS
});

const MESSAGE_KEYS = ['id', 'thread', 'sender_role', 'text', 'read', 'created'];
const message = createCodec({
  fields: {
    id: recordId,
    thread: f.link('thread', 'mentoring_threads'),
    sender_role: f.select('senderRole', SENDER_ROLES),
    text: f.text('text'),
    read: f.bool('isRead'),
    created: f.isoTime('created')
  },
  canonicalKeys: () => MESSAGE_KEYS
});

module.exports = { mentor, thread, message, MENTOR_KEYS, THREAD_KEYS, MESSAGE_KEYS };
