// Shared by the upgrade tests: what an instance from before the upgrade answers (every read of the old API for every
// role), and an old instance ready to be upgraded.
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const {
  LEGACY_SERVER, CURRENT_SERVER, makeRoot, startPocketBase, startBackend, httpClient, superuser, stop
} = require('./instance');
const { seedOldInstance } = require('./upgradeFixture');
const { BACKEND_DIR } = require('./helpers');
const { dutyStatusOf } = require(path.join(BACKEND_DIR, 'dutyStatus'));

const ROLES = ['owner', 'treasurer', 'viewer', 'max', 'mia', 'mentor', 'mentee', null];

/** Every read of the old API the apps make (and some only the Android app makes), for every role. */
function readsOf(facts, extra) {
  const reads = [];
  const add = (who, url) => reads.push([who, url]);
  const people = Object.values(facts.people);
  for (const who of ROLES) {
    for (const url of [
      '/api/status', '/api/auth/me', '/assets/config.js',
      '/api/db?path=settings', '/api/db?path=settings&raw=1', '/api/db?path=people', '/api/db?path=people&raw=1', '/api/db?path=requests',
      '/api/db?path=donations', '/api/db?path=expenses', '/api/db?path=system', '/api/db?path=system/inviteCode', '/api/db?path=users',
      '/api/fees', '/api/fee-reset', '/api/stats', '/api/transactions?page=1&perPage=500', '/api/transactions?page=2&perPage=7&search=Beitrag',
      '/api/events', '/api/events/my-requests', '/api/events/candidates', '/api/events/settings',
      '/api/polls', '/api/songs', '/api/prayers', '/api/mentoring/mentors', '/api/mentoring/my-profile', '/api/mentoring/threads',
      '/api/groups', '/api/media/status', '/api/push/fcm', '/api/push/vapid-public-key'
    ]) add(who, url);
    for (const key of [...people, facts.paulKey, '-NalteMitgliedXY', 'geloescht-1']) add(who, `/api/db?path=people/${key}`);
    for (const uid of people) add(who, `/api/db?path=users/${uid}`);
    for (const uid of people) add(who, `/api/db?path=people&orderByChild=uid&equalTo=${uid}`);
    add(who, `/api/db?path=people&orderByChild=name&equalTo=${encodeURIComponent('Paul Papier')}`);
    for (const id of [...facts.requests, 'old-request-1']) add(who, `/api/db?path=requests/${id}`);
    for (const uid of people) add(who, `/api/db?path=requests&orderByChild=userId&equalTo=${uid}`);
    for (const id of facts.events) {
      add(who, `/api/events/${id}/program`);
      add(who, `/api/events/${id}/attendees`);
      add(who, `/api/events/${id}/export.ics`);
    }
    for (const id of facts.threads) add(who, `/api/mentoring/threads/${id}/messages`);
  }
  for (const url of ['/api/admin/system-config', '/api/admin/users', '/api/admin/permissions', '/api/admin/groups', '/api/admin/ai-config',
    '/api/admin/ai-status', '/api/admin/media-config', '/api/media/rules', '/api/admin/reports', '/api/admin/fee-reset/preview?date=2026-12-01']) {
    add('owner', url);
    add('treasurer', url);
  }
  if (facts.publicToken) add(null, `/api/public/events/${facts.publicToken}`);
  if (extra.calendarFeed) add(null, extra.calendarFeed);
  return reads;
}

/** What may differ after the upgrade: internal ids of PocketBase's tables, the moment a calendar file was made. */
function normalize(url, res) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'collectionId') continue;
        out[key] = walk(inner);
      }
      return out;
    }
    if (typeof value === 'string' && value.startsWith('BEGIN:VCALENDAR')) return value.replace(/^DTSTAMP:.*$/gm, 'DTSTAMP:-');
    return value;
  };
  let body = walk(res.body);
  // The status names the API versions since v4 (an addition older apps do not read)
  if (url === '/api/status' && body && typeof body === 'object') body = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'apiVersions'));
  // The AI settings name their effort level since v4 (an addition older apps do not read)
  if (url === '/api/admin/ai-config' && body && typeof body === 'object' && !Array.isArray(body)) body = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'effort'));
  // A duty's status follows who has it since v4 (a group's duty used to be stored "confirmed"; backend/dutyStatus.js
  // repairs them once) - compared by that rule on both sides; the upgrade's own comparison checks them exactly
  // createdByManager was always false before v4 (a bug): left out on both sides, tested on its own in api.test.js
  if (url === '/api/events' && Array.isArray(body)) {
    body = body.map((event) => {
      if (!event || typeof event !== 'object') return event;
      const { createdByManager, ...rest } = event;
      return Array.isArray(rest.duties) ? { ...rest, duties: rest.duties.map((duty) => ({ ...duty, status: dutyStatusOf(duty) })) } : rest;
    });
  }
  // The version a raw read hands out is the record's "updated" time: every record is written anew by the upgrade
  if (/[?&]raw=1/.test(url) && body && typeof body === 'object' && 'version' in body) body = { ...body, version: body.version ? '<version>' : body.version };
  return { status: res.status, body };
}

async function recordAll(http, reads) {
  const answers = [];
  for (const [who, url] of reads) answers.push(normalize(url, await http.call(who, 'GET', url)));
  return answers;
}

/** The first place two answers differ, as a path. */
function firstDifference(a, b, path = '') {
  if (isDeepStrictEqual(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      const inner = firstDifference(a[key], b[key], `${path}.${key}`);
      if (inner) return inner;
    }
  }
  return `${path || '(root)'}: ${JSON.stringify(a)?.slice(0, 300)} → ${JSON.stringify(b)?.slice(0, 300)}`;
}

/** An instance from before the upgrade (old server stopped) and the answers it gave. */
async function oldInstance() {
  const root = makeRoot('agora-upgrade-');
  const pocketbase = await startPocketBase(root);
  let backend = await startBackend(root, pocketbase.port, { entry: LEGACY_SERVER, label: 'old backend' });
  const http = httpClient(backend.base);
  const facts = await seedOldInstance({ http, su: () => superuser(root, pocketbase.port) });
  await stop(backend.process);
  backend = await startBackend(root, pocketbase.port, { entry: LEGACY_SERVER, port: backend.port, label: 'old backend' });
  const reads = readsOf(facts, {}).filter(([, url]) => url !== '/api/status');
  await recordAll(http, reads);
  const answers = await recordAll(http, reads);
  await stop(backend.process);
  const su = await superuser(root, pocketbase.port);
  return {
    root, pocketbase, http, reads, answers, su, facts, port: backend.port,
    start: (env = {}, options = {}) => startBackend(root, pocketbase.port, { entry: CURRENT_SERVER, port: backend.port, label: 'new backend', env, ...options }),
    collections: async () => new Set((await su.collections()).map((collection) => collection.name)),
    upgradeState: async () => (await su.list('system_migrations')).find((record) => record.id === 'v4-structure'),
    backups: async () => (await su.request('GET', '/api/backups')).map((backup) => backup.key).filter((key) => key.startsWith('pre-v4-')).sort(),
    sameAnswers: async () => {
      const now = await recordAll(http, reads);
      return reads.map(([who, url], index) => [who, url, firstDifference(answers[index], now[index])]).filter(([, , difference]) => difference)
        .map(([who, url, difference]) => `${who || 'nobody'} GET ${url}: ${difference}`);
    },
    close: async () => {
      await stop(pocketbase.process);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };
}

async function exited(child, timeoutMs = 60000) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('the server did not stop')), timeoutMs))
  ]);
}

const OLD_TABLES = ['people', 'payments', 'status_history', 'expenses', 'requests'];


module.exports = { ROLES, readsOf, normalize, recordAll, firstDifference, oldInstance, exited, OLD_TABLES };
