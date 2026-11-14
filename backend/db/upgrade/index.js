// The upgrade of an existing database to the new structure (schema/). It runs when the server starts:
//
//   1. check    every old record is read and turned into its new records in memory; what is odd is noted
//   2. backup   a full PocketBase backup (pre-v4-<time>.zip in the database's backups folder) - no backup, no upgrade
//   3. copy     the new tables are built next to the old ones; the old ones are not touched
//   4. compare  the new tables must answer exactly like the old ones (every member with balance, paid until, ...)
//   5. switch   one write marks the upgrade done
//   6. cleanup  the old tables go (the backup keeps them); after a crash the next start finishes it
//
// If 1-4 fail or the server stops on the way, the new tables are removed again: the database is as it was, and the
// server starts the frozen previous backend (backend/legacy) on it - the instance keeps running exactly as before.
// The next start tries again, at most three times in a row (AGORA_UPGRADE_RETRY=1 allows three more).
//
// Once 5 is written, nothing is ever undone: the old tables are going, the new ones are the only copy. A cleanup that
// fails (PocketBase did not answer, a table could not be removed) leaves everything as it is and is tried again -
// in a moment by the same server, and at every start - until it gets through.
const fs = require('fs');
const path = require('path');
const client = require('../client');
const schemaApply = require('../schemaApply');
const schema = require('../schema');

const AREAS = [require('./accounts'), require('./finance'), require('./community'), require('./events'), require('./mentoring'), require('./system')];
const tables = require('../tables');
const UPGRADE_ID = 'v4-structure';
const MAX_ATTEMPTS = 3;
// Raised with every correction of the upgrade itself: an instance where an earlier revision failed (three times, too)
// tries the corrected one on its own, with three attempts of its own, instead of waiting for AGORA_UPGRADE_RETRY=1.
// 2: the comparison read the mentoring texts with a wrong key in the Docker image (legacyModules)
// 3: ids written as text that is JSON ("1771345242762", the web app's standing orders) came back as numbers (client.js)
// 4: a cleanup that failed after the switch removed the new tables (see undoneAfterSwitch); nothing is undone any more
const UPGRADE_REVISION = 4;
const BACKUP_PREFIX = 'pre-v4-';
// The fields of users the cleanup removes (upgrade/accounts.js)
const { REMOVED_USER_FIELDS } = require('./accounts');
const KEEP_BACKUPS = 3;
const MIGRATIONS = 'system_migrations';

const now = () => new Date().toISOString();

// For the tests only: AGORA_TEST_UPGRADE_FAIL=<step> makes the upgrade fail after that step (plan, backup, apply,
// compare, cleanup - in the middle of it, the old tables of the books are gone), once:<step> only the first time this
// server gets there, crash:<step> stops the whole server there (as a power cut would)
const hooksHit = new Set();
function testHook(step) {
  const failAt = process.env.AGORA_TEST_UPGRADE_FAIL || '';
  if (failAt === step || (failAt === `once:${step}` && !hooksHit.has(step))) {
    hooksHit.add(step);
    throw new Error(`The upgrade was made to fail after "${step}" (test).`);
  }
  if (failAt === `crash:${step}`) process.exit(70);
}
/** True for a table of the new structure (every one has `original`; the old ones did not). */
const isNewShape = (collection) => (collection.fields || []).some((field) => field.name === 'original');
const newCollections = () => [...new Set(['system_settings', ...AREAS.flatMap((area) => area.NEW_COLLECTIONS)])];
const oldCollections = () => AREAS.flatMap((area) => area.OLD_COLLECTIONS);

async function getState(appConfig) {
  return client.getRecord(MIGRATIONS, UPGRADE_ID, appConfig).catch(() => null);
}

async function setState(appConfig, patch) {
  const existing = await getState(appConfig);
  if (existing) return client.updateRecord(MIGRATIONS, UPGRADE_ID, patch, appConfig);
  return client.createRecord(MIGRATIONS, { id: UPGRADE_ID, attempts: 0, ...patch }, appConfig);
}

/** Removes the new tables (and views) an attempt built - in the order nothing still links to them. */
async function dropNewCollections(appConfig) {
  const existing = new Set((await client.listCollections(appConfig)).map((collection) => collection.name));
  for (const view of schema.allViews()) if (existing.has(view.name)) await client.deleteCollection(appConfig, view.name);
  const names = new Set(newCollections());
  const order = schema.creationOrder(schema.allCollections()).filter((spec) => names.has(spec.name)).reverse();
  for (const spec of order) {
    const stored = schemaApply.buildingName(spec.name);
    for (const name of [stored, spec.name]) if (existing.has(name) && !oldCollections().includes(name)) await client.deleteCollection(appConfig, name);
  }
}

/** Bytes used by the database files (the backup and the new tables need room next to them). */
function databaseSize(dir) {
  let total = 0;
  for (const file of ['data.db', 'data.db-wal', 'auxiliary.db', 'auxiliary.db-wal']) {
    try { total += fs.statSync(path.join(dir, file)).size; } catch { /* not there */ }
  }
  return total;
}

/**
 * A full backup taken right before the upgrade. The one of the last attempt is used again while the old server has
 * not run since (nothing can have changed); there must be room for it; only the newest three of these are kept.
 */
async function ensureBackup(appConfig, state) {
  const backups = (await client.listBackups(appConfig)).filter((backup) => backup.key.startsWith(BACKUP_PREFIX))
    .sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  const report = state?.report || {};
  if (state?.backup && backups.some((backup) => backup.key === state.backup) && !(report.fallbackAt && report.fallbackAt > (report.backupAt || ''))) {
    return { name: state.backup, reused: true, at: report.backupAt || null };
  }
  const dir = client.getPocketBaseDataDir();
  if (fs.existsSync(dir) && typeof fs.statfsSync === 'function') {
    const needed = databaseSize(dir) * 2.5 + 50 * 1024 * 1024;
    const stats = fs.statfsSync(dir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (free < needed) {
      throw Object.assign(new Error(`Not enough free disk space for the backup and the upgrade: ${Math.round(free / 1048576)} MB free, about ${Math.round(needed / 1048576)} MB needed.`), { code: 'disk' });
    }
  }
  const stamp = now().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `${BACKUP_PREFIX}${stamp}.zip`;
  await client.createBackup(appConfig, name);
  const made = (await client.listBackups(appConfig)).find((backup) => backup.key === name);
  if (!made || !(made.size > 0)) throw new Error(`The backup ${name} could not be made.`);
  for (const old of backups.slice(KEEP_BACKUPS - 1)) await client.deleteBackup(appConfig, old.key).catch(() => {});
  return { name, size: made.size, at: now(), reused: false };
}

/**
 * The frozen previous backend's own functions (they read the old tables): the other side of the comparison. The copy
 * finds its folders relative to itself (backend/legacy/../data) unless DATA_DIR and POCKETBASE_DIR name them, so they
 * are set to this server's folders first - as the hand-over to the copy does (server.js). The Docker image sets
 * neither: the copy looked for the key of the mentoring texts in /app/backend/data, made a new one there and read
 * every conversation as "decryption failed" - the comparison failed on every instance with conversations.
 */
function legacyModules() {
  const { resolveDataDirectory, resolvePocketBaseDirectory } = require('../../pathConfig');
  process.env.DATA_DIR = resolveDataDirectory();
  process.env.POCKETBASE_DIR = resolvePocketBaseDirectory();
  return {
    store: require('../../legacy/pocketbase'),
    stats: require('../../legacy/stats'),
    transactions: require('../../legacy/transactions'),
    itemStore: require('../../legacy/itemStore')
  };
}

/** What a report keeps of the findings: how many of each kind and the first record ids (no names, no amounts). */
function summarizeFindings(findings) {
  return Object.fromEntries(Object.entries(findings).map(([kind, list]) => [kind, { count: list.length, records: list.slice(0, 100) }]));
}

/**
 * Collections that are not Agora's own (made on PocketBase's admin page) and depend on something the upgrade removes:
 * PocketBase refuses to delete a table another collection links to or a view reads, and a field a view reads. Found
 * by the check, before anything is changed - after the switch it would stop the cleanup for good.
 */
async function foreignDependencies(appConfig) {
  const collections = await client.listCollections(appConfig);
  const own = new Set(['users', MIGRATIONS, ...oldCollections(), ...newCollections(), ...newCollections().map(schemaApply.buildingName), ...schema.allViews().map((view) => view.name)]);
  const old = new Map(collections.filter((collection) => oldCollections().includes(collection.name)).map((collection) => [collection.id, collection.name]));
  const mentions = (query, name) => new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`, 'i').test(query);
  const found = [];
  for (const collection of collections) {
    if (own.has(collection.name) || collection.system || collection.name.startsWith('_')) continue;
    for (const field of collection.fields || []) {
      if (field.type === 'relation' && old.has(field.collectionId)) found.push(`the field ${collection.name}.${field.name} links to the table ${old.get(field.collectionId)}`);
    }
    if (collection.type !== 'view') continue;
    const query = String(collection.viewQuery || '');
    const tables = [...old.values()].filter((name) => mentions(query, name));
    if (tables.length) found.push(`the view ${collection.name} reads the table ${tables.join(', ')}`);
    else if (mentions(query, 'users') && REMOVED_USER_FIELDS.some((name) => mentions(query, name))) found.push(`the view ${collection.name} reads fields of users that the upgrade removes`);
  }
  // An index someone added to users over a field the cleanup removes: PocketBase refuses to remove the field
  const users = collections.find((collection) => collection.name === 'users');
  for (const index of users?.indexes || []) {
    const columns = /\bON\s+\S+\s*\(([^)]*)\)/i.exec(index)?.[1] || '';
    const fields = REMOVED_USER_FIELDS.filter((name) => mentions(columns, name));
    if (fields.length) found.push(`the index ${/INDEX\s+(?:IF NOT EXISTS\s+)?[\`"']?(\w+)/i.exec(index)?.[1] || ''} of users uses the field ${fields.join(', ')}`);
  }
  return found;
}

/**
 * Revisions 1-3 answered a cleanup that failed after the switch like a failed attempt: they removed the new tables -
 * while the cleanup had already taken fields off users and removed old tables. Such a database is neither the old
 * nor the new one, and nothing here can put it right: only the backup taken before the upgrade holds everything.
 * The sign of it: the upgrade is not marked done, yet users already links its groups (which only the cleanup does).
 */
async function undoneAfterSwitch(appConfig) {
  const users = await client.getCollection(appConfig, 'users');
  return (users?.fields || []).some((field) => field.name === 'groups' && field.type === 'relation');
}

/**
 * The old tables go and the new ones take their names. Only ever after the switch, and safe to run again from any
 * point it stopped at (every step looks at what is there). It never starts without every new table in place: the old
 * tables must not go while they could be the only copy.
 */
async function runCleanup(appConfig) {
  const before = new Set((await client.listCollections(appConfig)).map((collection) => collection.name));
  const missing = newCollections().filter((name) => !before.has(name) && !before.has(schemaApply.buildingName(name)));
  if (missing.length) throw new Error(`The new tables are not complete (${missing.join(', ')} missing): the old tables are left as they are.`);
  for (const area of AREAS) {
    await area.cleanup(appConfig);
    if (area.key === 'finance') testHook('cleanup');
  }
  const existing = new Set((await client.listCollections(appConfig)).map((collection) => collection.name));
  // New tables built under another name while the old one existed get their name
  for (const name of newCollections()) {
    const stored = schemaApply.buildingName(name);
    if (existing.has(stored) && !existing.has(name)) await client.updateCollection(appConfig, stored, { name });
  }
  await schemaApply.applyViews(appConfig);
}

/** Thrown when the cleanup after the switch did not get through: nothing is undone, the start is tried again. */
class CleanupNotDone extends Error {
  constructor(cause) {
    super(`The database has its new structure, but removing the old tables did not get through: ${cause.message} Nothing was undone and nothing is lost; it is tried again.`);
    this.name = 'CleanupNotDone';
    this.cause = cause;
    // What /api/status may tell while the server keeps trying (no personal data: PocketBase's own message)
    this.publicReason = this.message;
  }
}

/** The cleanup after the switch ([report]: the upgrade's report so far), then the note that it is done. */
async function finishCleanup(appConfig, report) {
  try {
    await runCleanup(appConfig);
  } catch (error) {
    await setState(appConfig, { report: { ...report, cleanupPending: true, cleanupError: String(error.message).slice(0, 2000), cleanupFailedAt: now() } }).catch(() => {});
    throw new CleanupNotDone(error);
  }
  tables.useFinalNames();
  const { cleanupError, cleanupFailedAt, ...rest } = report;
  await setState(appConfig, { report: { ...rest, cleanupPending: false } });
}

/**
 * Brings the database to the current structure. Returns { status, report }: status 'current' (nothing to do),
 * 'fresh' (a new instance got the structure), 'upgraded', 'dry-run' (dryRun: checked and compared, nothing kept),
 * 'failed' (this attempt did not get through; the old data is as it was) or 'waiting' (three attempts failed).
 * Throws CleanupNotDone when the switch is written and the cleanup after it did not get through (it is tried again).
 * [rehearseCleanup] (with dryRun, only on a copy that is thrown away): the cleanup runs too, the new tables stay.
 */
async function upgradeDatabase(appConfig, { dryRun = false, rehearseCleanup = false, onUpgrading = () => {}, retry = process.env.AGORA_UPGRADE_RETRY === '1', appVersion = '' } = {}) {
  await client.ensureBatchSettings(appConfig);
  await schemaApply.createCollections(appConfig, [MIGRATIONS]);
  let state = await getState(appConfig);
  // A table the new structure has under the same name (events, ...) is old only while it has the old shape
  const hasOld = (await client.listCollections(appConfig)).some((collection) => oldCollections().includes(collection.name)
    && !(newCollections().includes(collection.name) && isNewShape(collection)));

  if (state?.status === 'done') {
    // The switch was written, the cleanup after it was not finished (the server stopped, or it failed): finished now
    if (state.report?.cleanupPending) await finishCleanup(appConfig, state.report);
    return { status: 'current' };
  }
  if (!hasOld) {
    await schemaApply.createCollections(appConfig, newCollections());
    await require('./accounts').ensureUsersSchema(appConfig);
    await schemaApply.applyViews(appConfig);
    if (!dryRun) await setState(appConfig, { status: 'done', finishedAt: now(), appVersion, report: { fresh: true } });
    return { status: 'fresh' };
  }

  if (state?.status === 'running' && !dryRun) {
    state = await setState(appConfig, { status: 'failed', error: 'The previous attempt was interrupted (the server stopped during it).' });
  }
  // A corrected upgrade starts its own attempts (every attempt notes the revision that made it)
  const corrected = (state?.report?.revision || 1) < UPGRADE_REVISION;
  const attempts = retry || corrected ? 0 : (state?.attempts || 0);
  if (attempts >= MAX_ATTEMPTS && !dryRun) {
    return { status: 'waiting', report: { reason: `The upgrade failed ${attempts} times; it is tried again when the server starts with AGORA_UPGRADE_RETRY=1.`, lastError: state?.error || '' } };
  }

  onUpgrading();
  const startedAt = now();
  if (!dryRun) state = await setState(appConfig, { status: 'running', attempts: attempts + 1, startedAt, finishedAt: '', error: '', appVersion, report: { ...(state?.report || {}), revision: UPGRADE_REVISION } });
  const report = { startedAt, appVersion, revision: UPGRADE_REVISION, areas: {} };
  let details = [];
  try {
    // Before anything is removed: a database an earlier revision left half switched is not touched again
    if (await undoneAfterSwitch(appConfig)) {
      throw Object.assign(new Error(`An earlier attempt of the upgrade was undone after its switch, when the old tables were already going (a fault of the first releases of this upgrade): this database is no longer complete. Restore the backup ${state?.backup || `${BACKUP_PREFIX}….zip`} (PocketBase's admin page, Settings, Backups) and start the server again - the upgrade then runs anew.`), { untouched: true });
    }
    // Leftovers of an earlier attempt: first the fields it added (they link to its new tables), then the tables
    for (const area of AREAS) if (area.rollback) await area.rollback(appConfig);
    await dropNewCollections(appConfig);
    // New tables whose name an old one still holds are built under another name; so are new fields of users
    const stillOld = new Set((await client.listCollections(appConfig)).map((collection) => collection.name).filter((name) => oldCollections().includes(name)));
    tables.useBuildingNames(
      Object.fromEntries(newCollections().filter((name) => stillOld.has(name)).map((name) => [name, schemaApply.buildingName(name)])),
      Object.assign({}, ...AREAS.map((area) => area.BUILDING_FIELDS || {}))
    );
    const plans = {};
    for (const area of AREAS) {
      plans[area.key] = await area.plan(appConfig);
      report.areas[area.key] = { counts: plans[area.key].counts, totals: plans[area.key].totals, findings: summarizeFindings(plans[area.key].findings) };
    }
    const foreign = await foreignDependencies(appConfig);
    if (foreign.length) {
      report.foreignDependencies = foreign;
      throw new Error(`Something that is not part of Agora depends on tables the upgrade replaces: ${foreign.join('; ')}. Remove it on PocketBase's admin page (the backup keeps the old tables), then start the server again.`);
    }
    testHook('plan');
    if (!dryRun) {
      report.backup = await ensureBackup(appConfig, state);
      report.backupAt = report.backup.at;
      // Kept at once: a server that stops during the copy uses this backup again at its next attempt
      await setState(appConfig, { backup: report.backup.name, report: { ...(state?.report || {}), backupAt: report.backupAt } });
      testHook('backup');
    }
    // Only a name an old table still holds is taken (decided after the leftovers of an earlier attempt are gone)
    await schemaApply.createCollections(appConfig, newCollections(), { tableNameOf: tables.table });
    for (const area of AREAS) await area.apply(appConfig, plans[area.key]);
    testHook('apply');
    const legacy = legacyModules();
    for (const area of AREAS) details.push(...(await area.compare(appConfig, { legacy })));
    report.differences = details.map(({ what, path: where }) => ({ what, path: where }));
    testHook('compare');
    if (details.length) throw new Error(`The new tables answered differently from the old ones in ${details.length} place(s) - nothing was switched.`);
    report.finishedAt = now();
    if (dryRun) {
      const findings = Object.fromEntries(Object.entries(plans).map(([key, planned]) => [key, planned.findings]));
      // On a copy that is thrown away afterwards (dryRun.js): the cleanup is tried too - the one step nothing can undo
      if (rehearseCleanup) {
        try {
          await runCleanup(appConfig);
        } catch (error) {
          tables.useFinalNames();
          report.failedAt = now();
          report.error = `The cleanup after the switch would not get through: ${error.message}`;
          return { status: 'failed', error: new Error(report.error), report, details, findings };
        }
        tables.useFinalNames();
        report.cleanupRehearsed = true;
        return { status: 'dry-run', report, details, findings };
      }
      tables.useFinalNames();
      for (const area of AREAS) if (area.rollback) await area.rollback(appConfig);
      await dropNewCollections(appConfig);
      return { status: 'dry-run', report, details, findings };
    }
    // The switch: from this write on, the new tables are the database
    await setState(appConfig, { status: 'done', finishedAt: report.finishedAt, error: '', backup: report.backup.name, report: { ...report, cleanupPending: true } });
  } catch (error) {
    report.failedAt = now();
    report.error = error.message;
    // Whether the switch was written decides what happens next, and only the database knows for sure (its answer to
    // the write can get lost). Switched: nothing is undone. Unknown: nothing is touched either - the start is tried again
    if (!dryRun) {
      const stored = await client.getRecord(MIGRATIONS, UPGRADE_ID, appConfig);
      if (stored?.status === 'done') return finishSwitched(appConfig, report);
    }
    tables.useFinalNames();
    if (!error.untouched) {
      for (const area of AREAS) if (area.rollback) await area.rollback(appConfig).catch((err) => console.error(`[Upgrade] Undoing ${area.key} failed:`, err.message));
      await dropNewCollections(appConfig).catch((err) => console.error('[Upgrade] Removing the new tables failed:', err.message));
    }
    if (!dryRun) await setState(appConfig, { status: 'failed', finishedAt: report.failedAt, error: String(error.message).slice(0, 9000), backup: report.backup?.name || state?.backup || '', report }).catch(() => {});
    return { status: 'failed', error, report, details };
  }
  return finishSwitched(appConfig, report);
}

/** After the switch: the cleanup. Whatever fails from here on is never answered by undoing anything (finishCleanup). */
async function finishSwitched(appConfig, report) {
  const { failedAt, error, ...switched } = report;
  await finishCleanup(appConfig, { ...switched, cleanupPending: true });
  return { status: 'upgraded', report: switched };
}

/** Notes that the previous backend served the instance (its data may change: the next attempt makes a new backup). */
async function noteFallback(appConfig) {
  const state = await getState(appConfig);
  if (state) await setState(appConfig, { report: { ...(state.report || {}), fallbackAt: now() } }).catch(() => {});
}

module.exports = { UPGRADE_ID, AREAS, upgradeDatabase, noteFallback, newCollections, oldCollections, getState, foreignDependencies, CleanupNotDone };
