// Notification preferences per user: master switches per channel (push, e-mail) and per channel which kinds of
// messages arrive. Default: push on with every kind, e-mail off.
//
// Stored on the user record as notificationSettings:
//   { channels: { push, email }, push: { duties, ... }, email: { duties, ... }, duties, events, ... }
// The flat keys mirror the push choice: older app versions read and write only those.

const NOTIFICATION_TYPES = ['duties', 'events', 'messages', 'requests', 'finances', 'reports'];
const DEFAULT_CHANNELS = { push: true, email: false };

function typeMap(source, fallback = {}) {
  const input = source && typeof source === 'object' ? source : {};
  return Object.fromEntries(NOTIFICATION_TYPES.map((type) => [
    type,
    typeof input[type] === 'boolean' ? input[type] : (typeof fallback[type] === 'boolean' ? fallback[type] : true)
  ]));
}

/** Full preferences of a user record (also for records saved by older versions). */
function readNotificationSettings(user) {
  const stored = user?.notificationSettings && typeof user.notificationSettings === 'object' ? user.notificationSettings : null;
  // Old records: no settings at all and emailNotifications === false meant "nothing at all"
  const legacyAllOff = !stored && user?.emailNotifications === false;
  const channels = {
    push: typeof stored?.channels?.push === 'boolean' ? stored.channels.push : !legacyAllOff,
    email: typeof stored?.channels?.email === 'boolean' ? stored.channels.email : DEFAULT_CHANNELS.email
  };
  const push = typeMap(stored?.push, stored || {});
  const email = typeMap(stored?.email);
  return { channels, push, email };
}

/** Value to store: the result of merging a (possibly old-style) write into the existing preferences. */
function mergeNotificationSettings(existingUser, incoming) {
  const current = readNotificationSettings(existingUser);
  const input = incoming && typeof incoming === 'object' ? incoming : {};
  const channels = {
    push: typeof input.channels?.push === 'boolean' ? input.channels.push : current.channels.push,
    email: typeof input.channels?.email === 'boolean' ? input.channels.email : current.channels.email
  };
  // New clients send push/email maps; older apps send the flat keys, which mean push
  const flatGiven = NOTIFICATION_TYPES.some((type) => typeof input[type] === 'boolean');
  const push = input.push && typeof input.push === 'object'
    ? typeMap(input.push, current.push)
    : (flatGiven ? typeMap(input, current.push) : current.push);
  const email = input.email && typeof input.email === 'object' ? typeMap(input.email, current.email) : current.email;
  return { channels, push, email, ...push };
}

/** Whether [user] wants messages of [type] over [channel] ('push' or 'email'). */
function wantsNotification(user, type, channel = 'push') {
  if (!user) return false;
  const settings = readNotificationSettings(user);
  if (!settings.channels[channel]) return false;
  const map = channel === 'email' ? settings.email : settings.push;
  return map[type] !== false;
}

module.exports = {
  NOTIFICATION_TYPES,
  readNotificationSettings,
  mergeNotificationSettings,
  wantsNotification
};
