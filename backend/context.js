// The instance as the server runs it: its state (set up? starting? ready? its configuration and mail transport,
// which runtime.js sets) and the folders it keeps its data in. Every module may read it at the top: it requires
// nothing of the server itself.
const fs = require('fs');
const path = require('path');
const { resolveDataDirectory, resolveFrontendDirectory } = require('./pathConfig');

const context = {
  appConfig: null,
  // setupMode: there is no configuration yet, so the first setup is open (and nothing else). An instance that has a
  // configuration is never in setup mode again - also not while it starts or after a start that failed: setup would
  // write a new configuration over it and make whoever sends it the owner of the existing data.
  setupMode: true,
  // 'setup' (see above), 'starting' (configured, the runtime is coming up or waits to try again), 'updating' (the
  // database is being upgraded), 'ready'
  phase: 'setup',
  transporter: null,
  // Why a start keeps being tried again, where that may be told (/api/status): the cleanup after the database upgrade
  startProblem: '',
  runtimeReady: Promise.resolve()
};

/** True while the runtime of a configured instance is not ready yet (starting, updating or waiting to retry). */
const isStarting = () => !context.setupMode && context.phase !== 'ready';

const dataDir = resolveDataDirectory();
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

try {
  fs.accessSync(dataDir, fs.constants.W_OK);
} catch {
  console.warn(`Warning: Data directory is not writable: ${dataDir}. Check volume mount permissions.`);
}

const configFile = path.join(dataDir, 'config.json');
const resolvedFrontendDir = resolveFrontendDirectory();
const bundledChurchLogoFile = path.join(resolvedFrontendDir, 'assets', 'church-logo.svg');
const churchLogoFile = path.join(dataDir, 'church-logo.svg');

const uploadDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Event pictures are public, receipts are not: separate folders (older event pictures may still be in uploads/,
// routes/events.js serves those only when an event links them)
const eventImagesDir = path.join(dataDir, 'event-images');
if (!fs.existsSync(eventImagesDir)) fs.mkdirSync(eventImagesDir);

const profilesDir = path.join(dataDir, 'profiles');
if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir);

module.exports = {
  context,
  isStarting,
  dataDir,
  configFile,
  resolvedFrontendDir,
  bundledChurchLogoFile,
  churchLogoFile,
  uploadDir,
  eventImagesDir,
  profilesDir
};
