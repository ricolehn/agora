// The status of a duty follows who has it - the apps read it that way: a person has the duty while it is "confirmed",
// a group while it is "assigned"; "requested" and "declined" are a question to a person and its answer; nobody:
// "open". Every write that changes who has a duty works the status out here, so the two never disagree (a duty given
// to a group used to be stored as "confirmed": the app then showed "Person" instead of the group, and the group's
// members did not see it as theirs).
const DUTY_STATES = ['open', 'requested', 'assigned', 'confirmed', 'declined'];

/** The status [duty] ({ assignedUser, assignedGroup, requestedUser, status }) has by who has it. */
function dutyStatusOf(duty = {}) {
  if (duty.assignedUser) return 'confirmed';
  if (duty.assignedGroup) return 'assigned';
  if (duty.requestedUser) return duty.status === 'declined' ? 'declined' : 'requested';
  return 'open';
}

/**
 * Once: duties stored with a status that does not fit who has them (older versions) get the right one. Returns how
 * many were set right.
 */
async function repairDutyStatuses(appConfig) {
  const { stores } = require('./db/stores/events');
  const duties = await stores.duties.list(appConfig);
  let repaired = 0;
  for (const duty of duties) {
    const status = dutyStatusOf(duty);
    if (duty.status === status) continue;
    // Not via updateEventDuty: nothing changed for the people on the duty
    await stores.duties.update(appConfig, duty.id, { status });
    repaired += 1;
  }
  return repaired;
}

module.exports = { DUTY_STATES, dutyStatusOf, repairDutyStatuses };
