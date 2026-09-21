const test = require('node:test');
const assert = require('node:assert/strict');

// Helper function representing the capacity and availability evaluation logic enforced in POST /api/mentoring/threads
function canStartMentoringThread(mentorRec, activeThreads, currentUid) {
  if (!mentorRec || mentorRec.status !== 'approved') {
    return { allowed: false, error: 'Mentor ist derzeit nicht verfügbar' };
  }
  if (mentorRec.user === currentUid) {
    return { allowed: false, error: 'Du kannst dich nicht selbst begleiten' };
  }
  if (mentorRec.is_accepting === false) {
    return { allowed: false, error: 'Dieser Mentor nimmt derzeit keine neuen Begleitungen an' };
  }
  const activeMenteesCount = activeThreads.filter(t => t.mentor === mentorRec.user && t.status !== 'closed').length;
  const maxMentees = typeof mentorRec.max_mentees === 'number' ? mentorRec.max_mentees : 3;
  if (activeMenteesCount >= maxMentees) {
    return { allowed: false, error: 'Dieser Mentor hat die maximale Anzahl an Begleitungen erreicht' };
  }
  return { allowed: true };
}

test('canStartMentoringThread rejects when mentor is not accepting new mentees', () => {
  const mentorRec = { user: 'u1', status: 'approved', is_accepting: false, max_mentees: 3 };
  const res = canStartMentoringThread(mentorRec, [], 'm1');
  assert.equal(res.allowed, false);
  assert.equal(res.error, 'Dieser Mentor nimmt derzeit keine neuen Begleitungen an');
});

test('canStartMentoringThread rejects when active mentees reach max_mentees capacity', () => {
  const mentorRec = { user: 'u1', status: 'approved', is_accepting: true, max_mentees: 2 };
  const activeThreads = [
    { mentor: 'u1', mentee: 'm1', status: 'active' },
    { mentor: 'u1', mentee: 'm2', status: 'active' }
  ];
  const res = canStartMentoringThread(mentorRec, activeThreads, 'm3');
  assert.equal(res.allowed, false);
  assert.equal(res.error, 'Dieser Mentor hat die maximale Anzahl an Begleitungen erreicht');
});

test('canStartMentoringThread allows when active mentees are below capacity and closed threads do not count', () => {
  const mentorRec = { user: 'u1', status: 'approved', is_accepting: true, max_mentees: 2 };
  const threads = [
    { mentor: 'u1', mentee: 'm1', status: 'active' },
    { mentor: 'u1', mentee: 'm2', status: 'closed' }
  ];
  const res = canStartMentoringThread(mentorRec, threads, 'm3');
  assert.equal(res.allowed, true);
});

test('canStartMentoringThread uses default max_mentees of 3 if not specified', () => {
  const mentorRec = { user: 'u1', status: 'approved', is_accepting: true };
  const threads = [
    { mentor: 'u1', mentee: 'm1', status: 'active' },
    { mentor: 'u1', mentee: 'm2', status: 'active' },
    { mentor: 'u1', mentee: 'm3', status: 'active' }
  ];
  const res = canStartMentoringThread(mentorRec, threads, 'm4');
  assert.equal(res.allowed, false);
  assert.equal(res.error, 'Dieser Mentor hat die maximale Anzahl an Begleitungen erreicht');
});
