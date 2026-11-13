// The upgrade of mentoring: mentors -> mentoring_mentors; mentoring_threads and mentoring_messages keep their names
// (the new ones are built next to the old ones and take the names in the cleanup). Every record keeps its id - a
// conversation's texts are encrypted with a key derived from its id - and the texts stay encrypted as they are.
const client = require('../client');
const codecs = require('../codecs/mentoring');
const store = require('../stores/mentoring');
const { linkContextOf } = require('../stores/oldTables');
const { fieldKinds } = require('../codec');
const { makeDiffer } = require('./differ');
const { table } = require('../tables');

const OLD_COLLECTIONS = ['mentors', 'mentoring_threads', 'mentoring_messages'];
const NEW_COLLECTIONS = ['mentoring_mentors', 'mentoring_threads', 'mentoring_messages'];
const KINDS = [
  { old: 'mentors', table: 'mentoring_mentors', codec: codecs.mentor, ownUpdated: true },
  { old: 'mentoring_threads', table: 'mentoring_threads', codec: codecs.thread },
  { old: 'mentoring_messages', table: 'mentoring_messages', codec: codecs.message, ownUpdated: true }
];
const isoColumn = fieldKinds.isoTime('created').toColumn;
const fieldsOf = (row) => {
  const { collectionId, collectionName, expand, ...fields } = row;
  return fields;
};

function newFindings() {
  return { linksToMissingAccounts: [], conversationsNamingAMentorRecord: [], messagesOfDeletedConversations: [], unknownStates: [], timestampsInOtherSpelling: [], valuesKeptAsWritten: [], fieldsOfOlderVersions: [] };
}

const FINDING_OF = { user: 'linksToMissingAccounts', mentee: 'linksToMissingAccounts', thread: 'messagesOfDeletedConversations', status: 'unknownStates', sender_role: 'unknownStates', created: 'timestampsInOtherSpelling', updated: 'timestampsInOtherSpelling' };

/** Works out the new records (in the order the old tables hold them) and what the check noticed. */
async function plan(appConfig) {
  const [mentors, threads, messages, users] = await Promise.all([
    ...OLD_COLLECTIONS.map((name) => client.listAllRecords(name, '', appConfig)),
    client.listAllRecords('users', '', appConfig, '', { fields: 'id' })
  ]);
  const old = { mentors, mentoring_threads: threads, mentoring_messages: messages };
  const mentorRecordIds = new Set(mentors.map((mentor) => mentor.id));
  const ctx = linkContextOf({ users: new Set(users.map((user) => user.id)), mentoring_threads: new Set(threads.map((thread) => thread.id)) });
  const findings = newFindings();
  const ops = [];
  const counts = { old: {}, new: {} };
  for (const kind of KINDS) {
    for (const row of old[kind.old]) {
      const object = fieldsOf(row);
      const { columns, original } = kind.codec.encode(object, { ...ctx, recordId: row.id });
      const body = { ...columns, original };
      // Mentors and messages had no "updated": the best the upgrade knows is when they were made
      if (kind.ownUpdated) body.updated = isoColumn(object.created);
      for (const key of Object.keys(original?.values || {})) {
        // Conversations from before they named the mentor's account name the mentor record
        if (key === 'mentor') findings[mentorRecordIds.has(object.mentor) ? 'conversationsNamingAMentorRecord' : 'linksToMissingAccounts'].push(`${kind.old}/${row.id}.mentor`);
        else findings[FINDING_OF[key] || 'valuesKeptAsWritten'].push(`${kind.old}/${row.id}.${key}`);
      }
      if (original?.keys || original?.extra) findings.fieldsOfOlderVersions.push(`${kind.old}/${row.id}`);
      ops.push({ method: 'POST', collection: table(kind.table), body: { ...body, id: row.id } });
    }
    counts.old[kind.old] = old[kind.old].length;
    counts.new[kind.table] = old[kind.old].length;
  }
  return { ops, findings, counts, totals: {} };
}

async function apply(appConfig, planned) {
  for (let start = 0; start < planned.ops.length; start += client.BATCH_MAX_REQUESTS) {
    await client.batchWrite(appConfig, planned.ops.slice(start, start + client.BATCH_MAX_REQUESTS));
  }
}

/**
 * Checks that the new tables answer exactly like the old ones, through the functions the server uses (texts
 * decrypted on both sides): every mentor, every conversation (all, per person, read alone with its summary) and
 * every conversation's messages.
 */
async function compare(appConfig, { legacy }) {
  const { differences, differ } = makeDiffer();
  // PocketBase's internal id of a table differs (a new table) - wherever a record appears; everything else must be the same
  const plain = (value) => {
    if (Array.isArray(value)) return value.map(plain);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'collectionId').map(([key, inner]) => [key, plain(inner)]));
  };
  const all = plain;
  const both = async (what, before, after) => differ(what, all(await before().catch((err) => `failed: ${err.message}`)), all(await after().catch((err) => `failed: ${err.message}`)));
  const old = legacy.store;
  const current = require('../../pocketbase');

  await both('the mentors', () => old.listMentorRecords(appConfig), () => current.listMentorRecords(appConfig));
  await both('the approved mentors', () => old.listMentorRecords(appConfig, 'status = "approved"'), () => current.listMentorRecords(appConfig, 'status = "approved"'));
  await both('the conversations', () => old.listAllMentoringThreads(appConfig), () => current.listAllMentoringThreads(appConfig));
  const [mentors, threads] = await Promise.all([client.listAllRecords('mentors', '', appConfig), client.listAllRecords('mentoring_threads', '', appConfig)]);
  for (const mentor of mentors) {
    await both(`mentor ${mentor.id}`, () => old.getMentorRecord(appConfig, mentor.id), () => current.getMentorRecord(appConfig, mentor.id));
    await both(`the mentor profile of ${mentor.id}`, () => old.getMentorByUserId(appConfig, mentor.user), () => current.getMentorByUserId(appConfig, mentor.user));
  }
  const people = [...new Set(threads.flatMap((thread) => [thread.mentor, thread.mentee]).filter(Boolean))];
  for (const person of people) {
    await both(`the conversations of ${person}`, () => old.listMentoringThreadsForUser(appConfig, person), () => current.listMentoringThreadsForUser(appConfig, person));
  }
  for (const thread of threads) {
    await both(`conversation ${thread.id}`, () => old.getMentoringThread(appConfig, thread.id), () => current.getMentoringThread(appConfig, thread.id));
    await both(`the messages of ${thread.id}`, () => old.listMentoringMessages(appConfig, thread.id), () => current.listMentoringMessages(appConfig, thread.id));
    for (const role of ['mentor', 'mentee']) {
      await both(`the summary of ${thread.id} for the ${role}`, () => old.getMentoringThreadSummary(appConfig, thread.id, role), () => current.getMentoringThreadSummary(appConfig, thread.id, role));
    }
  }
  return differences;
}

/** True for a table of the new structure (it has `original`; the old ones did not). */
const isNewShape = (collection) => (collection.fields || []).some((field) => field.name === 'original');

/** After the switch: the old tables go (the backup taken before keeps them). */
async function cleanup(appConfig) {
  for (const name of OLD_COLLECTIONS) {
    const collection = await client.getCollection(appConfig, name).catch(() => null);
    if (collection && !isNewShape(collection)) await client.deleteCollection(appConfig, name).catch((err) => { if (err.status !== 404) throw err; });
  }
}

module.exports = { key: 'mentoring', OLD_COLLECTIONS, NEW_COLLECTIONS, plan, apply, compare, cleanup };
