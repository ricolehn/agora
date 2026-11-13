// Accounts, groups, media folder rights and everything the server keeps for itself: settings per area, secrets,
// push devices, reported content and the history of database upgrades.
const { text, integer, bool, moment, json, select, multiSelect, link, links, automaticTimes, keptTimes, keptId, original } = require('./fields');

const PERMISSIONS = [
  'view_finances', 'manage_finances', 'manage_registration_code', 'access_ai', 'manage_mentoring',
  'manage_events', 'manage_songbook', 'manage_prayers', 'manage_media'
];
const SETTING_AREAS = ['registration', 'finance', 'ai', 'media', 'push', 'compat', 'legacy'];
const SECRET_NAMES = ['aiApiKey', 'vapidPrivateKey', 'mediaPassword'];

// The users collection is PocketBase's own login table. It keeps its name and its records (the session tokens belong
// to it): the upgrade changes its fields in place, see backend/db/migrations/v4.js.
const USERS_FIELDS = [
  text('firstName', 'First name.', { presentable: true }),
  text('lastName', 'Last name.', { presentable: true }),
  bool('admin', 'Administrator of the instance.'),
  bool('owner', 'The owner of the instance (exactly one; set up the instance).'),
  bool('pays', 'Pays fees (has a member record in the books).'),
  links('groups', 'user_groups', 'The groups the person belongs to (their permissions add up).'),
  json('notificationSettings', 'Which messages the person gets, by channel: {"channels": {"push": true, "email": false}, "push": {...}, "email": {...}}.'),
  text('language', 'Language of the person\'s app (en, de; empty: the instance\'s).'),
  text('timeZone', 'Time zone of the person\'s app (IANA name).'),
  text('calendarToken', 'Secret key of the person\'s calendar feed (empty until first used).'),
  original()
];

const collections = [
  {
    name: 'user_groups',
    description: 'Groups of members. A group gives its members permissions, can be the audience of events and be given duties.',
    fields: [
      text('name', 'Name of the group.', { required: true, presentable: true }),
      multiSelect('permissions', PERMISSIONS, 'What members of the group may do.'),
      original(),
      ...automaticTimes()
    ],
    indexes: ['CREATE UNIQUE INDEX idx_user_groups_name ON user_groups (name)']
  },
  {
    name: 'media_folder_rules',
    description: 'Who may read, write or not see a folder of the media library (Nextcloud). One record per folder and group / person / everyone.',
    fields: [
      text('folder', 'Folder path in the media library ("" = the top).'),
      select('target', ['everyone', 'group', 'user'], 'Whom the rule is for.'),
      link('group', 'user_groups', 'The group (target group). Removed with the group.', { cascadeDelete: true }),
      link('user', 'users', 'The person (target user). Removed with the account.', { cascadeDelete: true }),
      select('level', ['read', 'write', 'hide'], 'read, write or hide.'),
      ...automaticTimes()
    ],
    indexes: ['CREATE UNIQUE INDEX idx_media_folder_rules_target ON media_folder_rules (folder, target, `group`, user)']
  },
  {
    name: 'system_settings',
    description: 'Settings of the instance, one record per area (registration, finance, ai, media, push; legacy: values older versions left that nothing reads any more).',
    fields: [
      select('area', SETTING_AREAS, 'Which settings.', { required: true }),
      json('value', 'The settings of the area.'),
      ...automaticTimes()
    ],
    indexes: ['CREATE UNIQUE INDEX idx_system_settings_area ON system_settings (area)']
  },
  {
    name: 'system_secrets',
    description: 'Secrets the server needs, kept apart from the settings: the API key of the AI service, the private key of web push, the password of the media account.',
    fields: [
      select('name', SECRET_NAMES, 'Which secret.', { required: true }),
      text('value', 'The secret as the server uses it (mediaPassword is encrypted with media-secret in the data folder).'),
      ...automaticTimes()
    ],
    indexes: ['CREATE UNIQUE INDEX idx_system_secrets_name ON system_secrets (name)']
  },
  {
    name: 'system_push_devices',
    description: 'Devices that get push notifications: installed web apps (web push) and the Android app (Firebase).',
    fields: [
      select('kind', ['webPush', 'fcm'], 'webPush: an installed web app; fcm: the Android app.'),
      link('user', 'users', 'Whose device. Removed with the account.', { required: true, cascadeDelete: true }),
      text('endpoint', 'Web push: the address of the push service.'),
      text('p256dh', 'Web push: the device\'s public key.'),
      text('auth', 'Web push: the device\'s secret.'),
      text('userAgent', 'Web push: the browser.'),
      bool('isInstalled', 'Web push: the web app is installed (only those get pushes).'),
      text('token', 'Android: the Firebase token.'),
      text('platform', 'Android: the platform.'),
      moment('lastSeen', 'Web push: when the web app last registered (Android: updated).'),
      original(),
      ...keptTimes()
    ],
    indexes: [
      'CREATE INDEX idx_system_push_devices_user ON system_push_devices (user)',
      "CREATE UNIQUE INDEX idx_system_push_devices_endpoint ON system_push_devices (endpoint) WHERE endpoint != ''",
      "CREATE UNIQUE INDEX idx_system_push_devices_token ON system_push_devices (token) WHERE token != ''"
    ]
  },
  {
    name: 'system_content_reports',
    description: 'AI answers and chat messages members reported, for the admins to review.',
    id: keptId(),
    fields: [
      select('type', ['ai', 'chat'], 'What was reported.'),
      text('content', 'The reported content.'),
      text('reason', 'Why it was reported.'),
      text('prompt', 'The question to the AI (type ai).'),
      link('thread', 'mentoring_threads', 'The conversation (type chat).'),
      link('reportedBy', 'users', 'Who reported it.'),
      text('reporterName', 'Name of who reported it.'),
      select('status', ['open', 'resolved'], 'open or resolved.'),
      moment('resolvedAt', 'When it was resolved.'),
      original(),
      ...keptTimes()
    ],
    indexes: ['CREATE INDEX idx_system_content_reports_created ON system_content_reports (created)']
  },
  {
    name: 'system_migrations',
    description: 'History of the upgrades of this database: what ran when, the backup taken before, and the check report.',
    id: { ...keptId(), help: 'The upgrade (e.g. v4-structure).' },
    fields: [
      select('status', ['running', 'done', 'failed', 'blocked'], 'running, done, failed (tried again at the next start) or blocked (waits; see report).'),
      integer('attempts', 'How often it was started.'),
      moment('startedAt', 'When the last attempt started.'),
      moment('finishedAt', 'When it finished.'),
      text('appVersion', 'Version of the app that ran it.'),
      text('backup', 'Name of the backup taken before (in the backups folder of the database).'),
      json('report', 'What the check and the comparison found (counts and totals; no personal data).'),
      text('error', 'Why the last attempt failed.'),
      ...automaticTimes()
    ],
    indexes: []
  }
];

module.exports = { collections, views: [], USERS_FIELDS, PERMISSIONS, SETTING_AREAS, SECRET_NAMES };
