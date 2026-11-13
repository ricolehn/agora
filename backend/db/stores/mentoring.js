// Mentoring in the new structure (mentoring_mentors, mentoring_threads, mentoring_messages), behind the shape of the
// old tables (mentors, mentoring_threads, mentoring_messages): every record comes back exactly as the old table gave
// it, snake_case fields and encrypted texts included (codecs/mentoring.js) - encrypting and decrypting stays in
// pocketbase.js. Conversations keep their ids: the key of a conversation's texts is derived from it.
const client = require('../client');
const codecs = require('../codecs/mentoring');
const { recordStore } = require('./oldTables');
const links = require('../links');

const OLD_FIELDS = {
  mentors: [['user', 'text', true], ['status', 'text', true], ['bio', 'text'], ['max_mentees', 'number'], ['is_accepting', 'bool'], ['created', 'text']],
  mentoring_threads: [['mentor', 'text', true], ['mentee', 'text', true], ['mentee_alias', 'text', true], ['status', 'text', true], ['last_message', 'text'],
    ['created', 'text'], ['updated', 'text']],
  mentoring_messages: [['thread', 'text', true], ['sender_role', 'text', true], ['text', 'text', true], ['read', 'bool'], ['created', 'text']]
};

// The old tables of mentors and messages had no "updated": the new tables' own is set when a record is written
const mentors = recordStore({
  kind: 'mentors', tableName: 'mentoring_mentors', codec: codecs.mentor, fields: OLD_FIELDS.mentors, links: { user: 'users' },
  columns: { max_mentees: 'maxMentees', is_accepting: 'isAccepting' }, ownUpdated: true
});
const threads = recordStore({
  kind: 'mentoring_threads', codec: codecs.thread, fields: OLD_FIELDS.mentoring_threads, links: { mentor: 'users', mentee: 'users' },
  columns: { mentee_alias: 'menteeAlias', last_message: 'lastMessage' },
  // A mentor whose account is gone still has their conversations counted (the table is small: no index needed)
  exact: ['mentor', 'mentee']
});
const messages = recordStore({
  kind: 'mentoring_messages', codec: codecs.message, fields: OLD_FIELDS.mentoring_messages, links: { thread: 'mentoring_threads' },
  columns: { sender_role: 'senderRole', read: 'isRead' }, ownUpdated: true
});

// An account that is deleted: the conversations and the mentor profile keep naming it, as they always did
links.holdLinks('users', async (appConfig, uid) => {
  const is = (field) => client.pbFilterEquals(field, uid);
  await mentors.letGo(appConfig, is('user'), 'users', uid);
  await threads.letGo(appConfig, `${is('mentor')} || ${is('mentee')}`, 'users', uid);
});

/** Deletes a conversation; its messages go with it (one transaction). */
async function deleteThread(appConfig, id) {
  await links.keepLinksTo(appConfig, 'mentoring_threads', id);
  await threads.remove(appConfig, id);
}

module.exports = { OLD_FIELDS, mentors, threads, messages, deleteThread };
