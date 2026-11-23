// Starting the instance with its configuration: the database (upgraded first when it is from before the new
// structure), the mail transport, the daily clean-ups. A start that fails is tried again by itself.
const fs = require('fs');
const nodemailer = require('nodemailer');
const { context, configFile } = require('./context');
const { unavailable } = require('./httpError');
const { normalizeLanguage } = require('./i18n');
const { runAutomatedStandingOrders } = require('./standingOrders');
const { purgeExpiredRequests, repairRequestAuthors } = require('./requestRetention');
const { clearDeletedFromChangeLog } = require('./db/stores/finance');
const {
  DEFAULT_SETTINGS,
  withSecureInviteCode,
  ensurePocketBaseSuperuser,
  ensurePocketBaseSchema,
  getStateValue,
  upsertStateValue,
  updateSystemState,
  pruneDeletedPeopleRecords
} = require('./pocketbase');

function buildSmtpTransport(smtp) {
  if (!smtp) return null;
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.user,
      pass: smtp.pass
    }
  });
}

/** A configuration that can start the runtime (what the setup writes). */
const isCompleteConfig = (config) => Boolean(config?.appName && config?.pocketbase?.adminEmail && config?.pocketbase?.adminPassword);

async function initializeRuntime(config) {
  if (!isCompleteConfig(config)) {
    // Not setup mode: the file exists, and a setup would replace it. Whoever runs the server restores or removes it.
    throw Object.assign(new Error(`${configFile} is incomplete. Restore it from a backup, or remove it to run the setup again.`), { permanent: true });
  }

  // Installations from before the language setting (3.0.1) spoke German: keep that as their default language
  if (!normalizeLanguage(config.defaultLanguage)) {
    config = { ...config, defaultLanguage: 'de' };
    await fs.promises.writeFile(configFile, JSON.stringify(config, null, 2), 'utf8')
      .catch((err) => console.warn('[Config] Could not store the default language:', err.message));
  }

  await ensurePocketBaseSuperuser(config);
  // An instance from before the new database structure is upgraded first (the app answers "updating" meanwhile)
  await ensurePocketBaseSchema(config, { onUpgrading: () => { context.phase = 'updating'; } });
  await upsertStateValue(config, 'settings', await getStateValue(config, 'settings', DEFAULT_SETTINGS));
  await updateSystemState(config, withSecureInviteCode);

  context.appConfig = config;
  context.setupMode = false;
  context.transporter = buildSmtpTransport(config.smtp || null);
  context.startProblem = '';
  context.phase = 'ready';
  console.log('Configuration loaded successfully. Setup mode: false');

  runAutomatedStandingOrders(context.appConfig);
  purgeExpiredRequests(context.appConfig);
  repairRequestAuthors(context.appConfig);
  pruneDeletedPeopleRecords(context.appConfig);
  // What the finance change log may no longer hold since a request or a member was deleted (db/stores/finance.js)
  clearDeletedFromChangeLog(context.appConfig);
}

// A start that failed (PocketBase not answering yet, a full disk) is tried again by itself: the instance must not stay
// down until someone restarts it - and it must not fall back into setup mode either (see context.setupMode).
const RESTART_DELAYS_MS = [10_000, 30_000, 60_000, 300_000];
let restartTimer = null;

/**
 * Starts the runtime with [config]. Until it is ready, requests that need it wait (context.runtimeReady) or are told
 * to try again (503). [retry]: try again after a failure (the setup turns that off: its own failure is answered).
 */
function setRuntimeConfig(config, { retry = true, attempt = 0 } = {}) {
  clearTimeout(restartTimer);
  context.setupMode = false;
  context.phase = 'starting';
  context.runtimeReady = initializeRuntime(config).catch((error) => {
    console.error('Runtime initialization failed:', error);
    context.appConfig = null;
    context.transporter = null;
    context.startProblem = error.publicReason || '';
    if (error.name === 'UpgradeNotDone' && typeof context.onUpgradeNotDone === 'function') {
      context.phase = 'failed';
      context.onUpgradeNotDone(error.outcome, config);
    } else if (error.permanent) {
      context.phase = 'failed';
    } else if (retry) {
      const delay = RESTART_DELAYS_MS[Math.min(attempt, RESTART_DELAYS_MS.length - 1)];
      console.log(`[Startup] Trying again in ${Math.round(delay / 1000)} s`);
      restartTimer = setTimeout(() => setRuntimeConfig(config, { retry, attempt: attempt + 1 }).catch(() => {}), delay);
      restartTimer.unref?.();
    }
    if (!retry) throw error;
    throw unavailable('The server is starting. Please try again in a moment.', { cause: error });
  });
  return context.runtimeReady;
}

/** Back to a fresh instance after a first setup that did not get through (its configuration file is removed). */
function resetToSetupMode() {
  clearTimeout(restartTimer);
  context.appConfig = null;
  context.transporter = null;
  context.setupMode = true;
  context.phase = 'setup';
  context.startProblem = '';
  context.runtimeReady = Promise.resolve();
}

function loadConfig() {
  if (!fs.existsSync(configFile)) {
    resetToSetupMode();
    console.log('No config file found. Starting in setup mode.');
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    // An unreadable file is not "no configuration": initializeRuntime refuses it, and the setup stays closed
    console.error('Error reading config file:', error);
  }
  setRuntimeConfig(parsed).catch(() => {});
}

module.exports = { buildSmtpTransport, setRuntimeConfig, resetToSetupMode, loadConfig };
