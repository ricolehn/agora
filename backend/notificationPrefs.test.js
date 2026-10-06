const test = require('node:test');
const assert = require('node:assert/strict');
const { readNotificationSettings, mergeNotificationSettings, wantsNotification } = require('./notificationPrefs');

test('default: push with every kind, e-mail off', () => {
  const user = { id: 'u1' };
  assert.equal(wantsNotification(user, 'duties', 'push'), true);
  assert.equal(wantsNotification(user, 'requests', 'push'), true);
  assert.equal(wantsNotification(user, 'duties', 'email'), false);
});

test('old records: flat keys are the push choice, emailNotifications=false without settings means nothing', () => {
  assert.equal(wantsNotification({ notificationSettings: { events: false } }, 'events', 'push'), false);
  assert.equal(wantsNotification({ notificationSettings: { events: false } }, 'duties', 'push'), true);
  assert.equal(wantsNotification({ emailNotifications: false }, 'duties', 'push'), false);
});

test('e-mail channel with its own kinds', () => {
  const user = { notificationSettings: { channels: { push: false, email: true }, email: { events: false } } };
  assert.equal(wantsNotification(user, 'duties', 'push'), false);
  assert.equal(wantsNotification(user, 'duties', 'email'), true);
  assert.equal(wantsNotification(user, 'events', 'email'), false);
});

test('a write with only flat keys (older app) keeps channels and e-mail kinds', () => {
  const existing = { notificationSettings: { channels: { push: true, email: true }, push: { messages: true }, email: { events: false } } };
  const merged = mergeNotificationSettings(existing, { duties: true, events: true, messages: false, finances: true });
  assert.deepEqual(merged.channels, { push: true, email: true });
  assert.equal(merged.push.messages, false);
  assert.equal(merged.messages, false);
  assert.equal(merged.email.events, false);
});

test('a full write replaces channels and both maps', () => {
  const merged = mergeNotificationSettings({}, { channels: { push: false, email: true }, push: { duties: false }, email: { reports: false } });
  assert.deepEqual(merged.channels, { push: false, email: true });
  assert.equal(merged.push.duties, false);
  assert.equal(merged.email.reports, false);
  assert.equal(readNotificationSettings({ notificationSettings: merged }).email.duties, true);
});
