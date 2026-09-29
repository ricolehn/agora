const test = require('node:test');
const assert = require('node:assert/strict');
const { linkedPeople, freedDutyUpdate } = require('./accountDeletion');
const { buildReport } = require('./contentReports');

test('linkedPeople finds the person record of an account by uid, data.uid or personKey', () => {
  const people = [
    { personKey: 'p1', uid: 'u1' },
    { personKey: 'p2', data: { uid: 'u1' } },
    { personKey: 'u1' },
    { personKey: 'p3', uid: 'u2' }
  ];
  assert.deepEqual(linkedPeople(people, 'u1').map(p => p.personKey), ['p1', 'p2', 'u1']);
  assert.deepEqual(linkedPeople(people, 'nobody'), []);
});

test('freedDutyUpdate opens slots of the deleted user and keeps group assignments', () => {
  assert.deepEqual(freedDutyUpdate({ assignedUser: 'u1', status: 'confirmed' }, 'u1'), { assignedUser: '', status: 'open' });
  assert.deepEqual(freedDutyUpdate({ requestedUser: 'u1', status: 'requested' }, 'u1'), { requestedUser: '', status: 'open' });
  assert.deepEqual(freedDutyUpdate({ assignedGroup: 'g1', assignedUser: 'u1' }, 'u1'), { assignedUser: '' });
  // Only the requester was deleted: the requested person keeps the request
  assert.deepEqual(freedDutyUpdate({ requestedUser: 'u2', requestedBy: 'u1', status: 'requested' }, 'u1'), { requestedBy: '' });
  assert.equal(freedDutyUpdate({ assignedUser: 'u2' }, 'u1'), null);
});

test('buildReport validates type and content and keeps only the relevant context', () => {
  assert.ok(buildReport({ type: 'spam', content: 'x' }, {}).error);
  assert.ok(buildReport({ type: 'ai', content: '   ' }, {}).error);
  const { report } = buildReport(
    { type: 'ai', content: 'Antwort', prompt: 'Frage', threadId: 't1', reason: 'falsch' },
    { uid: 'u1', firstName: 'Max', lastName: 'Mitglied' },
    123
  );
  assert.equal(report.type, 'ai');
  assert.equal(report.prompt, 'Frage');
  assert.equal(report.threadId, '');
  assert.equal(report.reportedBy, 'u1');
  assert.equal(report.reporterName, 'Max Mitglied');
  assert.equal(report.created, 123);
  assert.equal(report.status, 'open');
  const chat = buildReport({ type: 'chat', content: 'Hallo', threadId: 't1', prompt: 'x' }, { uid: 'u2' }).report;
  assert.equal(chat.threadId, 't1');
  assert.equal(chat.prompt, '');
});
