// Self-service account deletion (Google Play account deletion policy, GDPR art. 17).
// Deletes the login and everything personal linked to it; bookings stay in the finance ledger
// (removePeopleRecord keeps payments + name as the bookkeeping record, like an admin deletion).
const fs = require('fs');
const path = require('path');
const {
  listAllRecords,
  deleteRecord,
  updateRecord,
  pbFilterEquals,
  listPeopleRecords,
  removePeopleRecord,
  deleteUserRecord
} = require('./pocketbase');

// Which person record belongs to the account (same matching as the admin deletion)
function linkedPeople(people, uid) {
  return (people || []).filter(p => p && (p.uid === uid || p.data?.uid === uid || p.personKey === uid));
}

// Duty slots of the user become open again; group assignments stay
function freedDutyUpdate(duty, uid) {
  const update = {};
  if (duty.assignedUser === uid) update.assignedUser = '';
  if (duty.requestedUser === uid) update.requestedUser = '';
  if (duty.requestedBy === uid) update.requestedBy = '';
  if (!Object.keys(update).length) return null;
  const stillTaken = duty.assignedGroup || (update.assignedUser === undefined && duty.assignedUser);
  if (!stillTaken && (update.assignedUser !== undefined || update.requestedUser !== undefined)) update.status = 'open';
  return update;
}

async function deleteWhere(appConfig, collection, field, value) {
  const records = await listAllRecords(collection, pbFilterEquals(field, value), appConfig).catch(() => []);
  for (const r of records) await deleteRecord(collection, r.id, appConfig).catch(() => {});
  return records;
}

/** Deletes the account of [uid] and its personal data. Returns a summary for logging. */
async function deleteAccountData(appConfig, uid, { profilesDir } = {}) {
  const summary = {};

  // Mentoring: mentor profile, own chats and their messages (private conversations)
  summary.mentorProfiles = (await deleteWhere(appConfig, 'mentors', 'user', uid)).length;
  let threads = 0;
  for (const field of ['mentor', 'mentee']) {
    const list = await listAllRecords('mentoring_threads', pbFilterEquals(field, uid), appConfig).catch(() => []);
    for (const t of list) {
      await deleteWhere(appConfig, 'mentoring_messages', 'thread', t.id);
      await deleteRecord('mentoring_threads', t.id, appConfig).catch(() => {});
      threads++;
    }
  }
  summary.mentoringThreads = threads;

  // Events: registrations go, duty slots of the user are freed
  summary.registrations = (await deleteWhere(appConfig, 'event_registrations', 'user', uid)).length;
  let duties = 0;
  for (const field of ['assignedUser', 'requestedUser', 'requestedBy']) {
    const list = await listAllRecords('event_duties', pbFilterEquals(field, uid), appConfig).catch(() => []);
    for (const d of list) {
      const update = freedDutyUpdate(d, uid);
      if (update) {
        await updateRecord('event_duties', d.id, update, appConfig).catch(() => {});
        duties++;
      }
    }
  }
  summary.duties = duties;

  // Notifications and own finance requests
  summary.pushSubscriptions = (await deleteWhere(appConfig, 'push_subscriptions', 'user', uid)).length;
  summary.fcmTokens = (await deleteWhere(appConfig, 'fcm_tokens', 'user', uid)).length;
  summary.requests = (await deleteWhere(appConfig, 'requests', 'userId', uid)).length;

  // Profile picture
  if (profilesDir && /^[a-zA-Z0-9_-]{1,64}$/.test(uid)) {
    await fs.promises.unlink(path.join(profilesDir, `${uid}.jpg`)).catch(() => {});
  }

  // Person record (keeps bookings, clears the rest) and finally the login itself
  const people = linkedPeople(await listPeopleRecords(appConfig).catch(() => []), uid);
  for (const p of people) await removePeopleRecord(appConfig, p.personKey).catch(() => {});
  summary.people = people.length;
  await deleteUserRecord(appConfig, uid).catch(err => {
    if (err?.status !== 404) throw err;
  });
  return summary;
}

module.exports = { deleteAccountData, linkedPeople, freedDutyUpdate };
