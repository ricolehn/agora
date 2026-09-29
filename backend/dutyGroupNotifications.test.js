const test = require('node:test');
const assert = require('node:assert/strict');
const { isGroupMember, groupDutyRecipients, buildGroupDutyPush } = require('./dutyGroupNotifications');

test('isGroupMember matches group ids, names and {id, name} objects', () => {
  assert.equal(isGroupMember({ groups: ['g1'] }, 'g1', 'Technik'), true);
  assert.equal(isGroupMember({ groups: ['Technik'] }, 'g1', 'Technik'), true);
  assert.equal(isGroupMember({ groups: [{ id: 'g1', name: 'Technik' }] }, 'g1', 'Technik'), true);
  assert.equal(isGroupMember({ groups: ['g2'] }, 'g1', 'Technik'), false);
  assert.equal(isGroupMember({}, 'g1', 'Technik'), false);
});

test('groupDutyRecipients: members only (admins are not implied), without the assigner and opt-outs', () => {
  const users = [
    { id: 'a', groups: ['g1'] },
    { id: 'b', groups: ['Technik'], notificationSettings: { duties: false } },
    { id: 'c', groups: ['g1'], emailNotifications: false, notificationSettings: { duties: true } },
    { id: 'boss', owner: true, groups: [] },
    { id: 'me', groups: ['g1'] },
    { id: 'd', groups: ['g2'] }
  ];
  assert.deepEqual(groupDutyRecipients(users, 'g1', 'Technik', 'me'), ['a', 'c']);
});

test('buildGroupDutyPush names group, duty, event and date', () => {
  const push = buildGroupDutyPush({
    groupName: 'Technik',
    event: { id: 'e1', title: 'Gottesdienst', date: '2026-09-30', startTime: '10:00' },
    duty: { id: 'd1', roleName: 'Ton' }
  });
  assert.equal(push.title, 'Dienst für Technik: Ton');
  assert.equal(push.body, 'Deine Gruppe „Technik“ ist bei „Gottesdienst“ am 30.09. um 10:00 Uhr für „Ton“ eingeteilt.');
  assert.deepEqual(push.data, { url: '/#events', eventId: 'e1' });
  assert.equal(push.tag, 'agora-duty-d1');
});
