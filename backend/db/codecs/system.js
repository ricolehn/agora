// Push devices and reported content exactly as the old tables and values kept them (push_subscriptions, fcm_tokens,
// the content_reports list in app_state), and as the new tables keep them (see ../codec.js).
const { createCodec, fieldKinds: f } = require('../codec');

const recordId = { column: 'id', toColumn: (value, source, ctx) => ctx.recordId ?? String(value ?? ''), fromColumn: (stored) => stored };

/** A web push subscription (old push_subscriptions record). "created" was reset at every registration. */
const WEB_PUSH_KEYS = ['id', 'user', 'endpoint', 'p256dh', 'auth', 'userAgent', 'created', 'installed'];
const webPush = createCodec({
  fields: {
    id: recordId,
    user: f.link('user', 'users'),
    endpoint: f.text('endpoint'),
    p256dh: f.text('p256dh'),
    auth: f.text('auth'),
    userAgent: f.text('userAgent'),
    created: f.isoTime('lastSeen'),
    installed: f.bool('isInstalled')
  },
  canonicalKeys: () => WEB_PUSH_KEYS
});

/** A Firebase token of the Android app (old fcm_tokens record). */
const FCM_KEYS = ['id', 'user', 'token', 'platform', 'created', 'updated'];
const fcm = createCodec({
  fields: {
    id: recordId,
    user: f.link('user', 'users'),
    token: f.text('token'),
    platform: f.text('platform'),
    created: f.isoTime('created'),
    updated: f.isoTime('updated')
  },
  canonicalKeys: () => FCM_KEYS
});

/** A reported AI answer or chat message (an entry of the old content_reports list); "resolved" once resolved. */
const REPORT_KEYS = ['id', 'type', 'content', 'reason', 'prompt', 'threadId', 'reportedBy', 'reporterName', 'created', 'status'];
const report = createCodec({
  fields: {
    id: recordId,
    type: f.select('type', ['ai', 'chat']),
    content: f.text('content'),
    reason: f.text('reason'),
    prompt: f.text('prompt'),
    threadId: f.link('thread', 'mentoring_threads'),
    reportedBy: f.link('reportedBy', 'users'),
    reporterName: f.text('reporterName'),
    created: f.millis('created'),
    status: f.select('status', ['open', 'resolved']),
    resolved: f.millis('resolvedAt')
  },
  canonicalKeys: (row) => (row?.resolvedAt ? [...REPORT_KEYS, 'resolved'] : REPORT_KEYS)
});

module.exports = { webPush, fcm, report, WEB_PUSH_KEYS, FCM_KEYS, REPORT_KEYS };
