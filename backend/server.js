const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const {
  context,
  isStarting,
  formatEventMoment,
  loadConfig,
  logoAssetRateLimit,
  pageRateLimit,
  adminRateLimit,
  churchLogoFile,
  bundledChurchLogoFile,
  resolvedFrontendDir,
  eventImagesDir
} = require('./context');

const { selectChurchLogoFilePath } = require('./logoStorage');
const { resolveTrustProxySetting } = require('./trustProxy');
const { securityHeadersMiddleware } = require('./securityHeaders');
const { runAutomatedStandingOrders } = require('./standingOrders');
const { runDutyReminders } = require('./dutyReminders');
const { purgeExpiredRequests } = require('./requestRetention');
const { purgeUnlinkedEventImages } = require('./eventImages');
const { purgeExpiredGuests, isPublicToken, linkPreviewHead } = require('./eventGuests');
const { findEventByPublicToken } = require('./pocketbase');
const { originOf } = require('./notify');
const { compressResponses, compressedStatic, sendCompressedFile } = require('./compression');
const { translateResponses, instanceLanguage } = require('./i18n');

const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const eventsRouter = require('./routes/events');
const publicEventsRouter = require('./routes/publicEvents');
const mentoringRouter = require('./routes/mentoring');
const financeRouter = require('./routes/finance');
const aiRouter = require('./routes/ai');
const systemRouter = require('./routes/system');
const pollsRouter = require('./routes/polls');
const features = require('./features');
const songbookRouter = require('./routes/songbook');
const prayersRouter = require('./routes/prayers');
const mediaRouter = require('./routes/media');

const app = express();
app.set('trust proxy', resolveTrustProxySetting());

// Security middleware: Set essential HTTP security headers
app.use(securityHeadersMiddleware);
// Gzip JSON / text responses (the reverse proxy in front usually does not compress)
app.use(compressResponses);
// Error / message texts of JSON answers in the language of the request (English in the code, see i18n.js)
app.use(translateResponses);

// Load configuration
loadConfig();

app.use(require('cors')());
app.use(express.json({ limit: '2mb' }));

// Duty reminders 3 hours before the start (dutyReminders.js)
const scheduledTasks = [];
scheduledTasks.push(cron.schedule('*/5 * * * *', () => {
  if (!context.setupMode && context.appConfig) runDutyReminders(context.appConfig);
}));

scheduledTasks.push(cron.schedule('0 5 * * *', () => {
  if (!context.setupMode && context.appConfig) {
    runAutomatedStandingOrders(context.appConfig);
    purgeExpiredRequests(context.appConfig);
    purgeUnlinkedEventImages(context.appConfig, eventImagesDir);
    purgeExpiredGuests(context.appConfig);
    // The finance change log is kept AGORA_CHANGE_LOG_YEARS (10 by default)
    require('./db/stores/finance').pruneChangeLog(context.appConfig)
      .then((removed) => { if (removed) console.log(`[Finance] Removed ${removed} change log entr${removed === 1 ? 'y' : 'ies'} past the kept years`); })
      .catch((err) => console.warn('[Finance] Pruning the change log failed:', err.message));
  }
}));

// Setup mode redirection / guard middleware
app.use((req, res, next) => {
  if (
    req.path.startsWith('/api/setup') ||
    req.path.startsWith('/api/status') ||
    req.path.startsWith('/api/auth/') ||
    req.path.startsWith('/api/db') ||
    req.path === '/setup.html' ||
    req.path === '/account-deletion' ||
    req.path === '/privacy' ||
    req.path.startsWith('/assets/')
  ) {
    return next();
  }

  if (context.setupMode) {
    if (req.path === '/' || req.path === '/index.html') {
      return res.redirect('/setup.html');
    }
    return res.status(503).json({ error: 'App is in setup mode. Please configure first.' });
  }

  // A configured instance that is starting (or upgrading its database) loads its pages as always and asks the apps to
  // try again in a moment - the same answer every restart has always given them, never the setup page
  if (isStarting() && req.path.startsWith('/api/')) {
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: 'The server is starting. Please try again in a moment.', starting: true });
  }

  if (req.path === '/setup.html') {
    return res.redirect('/');
  }

  next();
});

const frontendDir = resolvedFrontendDir;
console.log(`Serving frontend from: ${frontendDir}`);

app.get('/assets/church-logo.svg', logoAssetRateLimit, (req, res, next) => {
  const logoFilePath = selectChurchLogoFilePath(churchLogoFile, bundledChurchLogoFile);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  // Opened directly, an SVG is a document of this origin: whatever slipped through the upload check must not run
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
  res.sendFile(logoFilePath, (error) => {
    if (error) next(error);
  });
});

// Frontend files go out compressed (cached per file version); config.js and the logo keep their own handlers
const sendPage = file => (req, res) => {
  if (!sendCompressedFile(req, res, file)) res.sendFile(file);
};
app.use('/assets', compressedStatic(path.join(frontendDir, 'assets'), { exclude: ['/config.js', '/church-logo.svg'] }));
// assets/config.js in the frontend folder is only the fallback of older images: the app name comes from the
// server configuration (route in routes/system.js), so the static copy must not answer first
const staticAssets = express.static(path.join(frontendDir, 'assets'));
app.use('/assets', (req, res, next) => (req.path === '/config.js' ? next() : staticAssets(req, res, next)));
app.get('/sw.js', sendPage(path.join(frontendDir, 'sw.js')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(frontendDir, 'manifest.json')));
app.get('/setup.html', pageRateLimit, sendPage(path.join(frontendDir, 'setup.html')));
// Public pages for app stores: delete an account without the app, privacy policy.
// Frontend volumes from older images may lack them, so fall back to the bundled copies.
const publicPage = name => [frontendDir, process.env.FRONTEND_SEED_DIR || '/app/html-seed', path.join(__dirname, '..')]
  .map(dir => path.join(dir, name))
  .find(file => fs.existsSync(file)) || path.join(frontendDir, name);
app.get('/account-deletion', pageRateLimit, (req, res) => sendPage(publicPage('account-deletion.html'))(req, res));
app.get('/privacy', pageRateLimit, (req, res) => sendPage(publicPage('privacy.html'))(req, res));

app.use('/api/admin', adminRateLimit);

// Mount API Routers
app.use(authRouter);
app.use(usersRouter);
app.use(eventsRouter);
app.use(publicEventsRouter);
app.use(mentoringRouter);
app.use(financeRouter);
app.use(aiRouter);
app.use(systemRouter);
// Polls are switched off for now (backend/features.js): without the router every /api/polls call is a 404
if (features.polls) app.use(pollsRouter);
app.use(songbookRouter);
app.use(prayersRouter);
app.use(mediaRouter);
// API v2 (docs/API_V2.md): the shapes of the new database structure
app.use(require('./routes/v2'));

// A shared event's page (the share switch is on): the app as always, its head carrying the event for link previews
app.get('/events/:slug', pageRateLimit, async (req, res, next) => {
  const token = typeof req.query.share === 'string' ? req.query.share : '';
  if (!isPublicToken(token)) return next();
  try {
    const event = await findEventByPublicToken(context.appConfig, token);
    if (!event || event.isPublic !== true) return next();
    const html = await fs.promises.readFile(path.join(frontendDir, 'index.html'), 'utf8');
    const origin = originOf(req);
    const head = linkPreviewHead(event, {
      origin,
      appName: context.appConfig?.appName || 'Agora',
      when: formatEventMoment(event, instanceLanguage()),
      url: origin ? `${origin}${req.path}?share=${encodeURIComponent(token)}` : ''
    });
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.type('html').send(html.replace(/<title>[^<]*<\/title>/, () => head));
  } catch (error) {
    console.warn('[Share] Link preview failed:', error.message);
    next();
  }
});

app.get('*', pageRateLimit, (req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/data/')) {
    return sendPage(path.join(frontendDir, 'index.html'))(req, res);
  }
  next();
});

const PORT = process.env.PORT || 3000;
const httpServer = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

/**
 * The database upgrade did not get through (backend/db/upgrade): its new tables are gone again, the old data is as it
 * was. The frozen previous backend (backend/legacy) takes over on the same port and keeps the instance running exactly
 * as before the update; /api/status tells why (upgrade). The next start tries the upgrade again.
 */
function handOverToPreviousBackend(outcome, config) {
  const notice = {
    state: outcome.status === 'waiting' ? 'waiting' : 'failed',
    reason: outcome.status === 'waiting' ? outcome.report?.reason : outcome.error?.message,
    backup: outcome.report?.backup?.name || '',
    at: new Date().toISOString()
  };
  console.error(`[Upgrade] ${notice.reason}`);
  console.error('[Upgrade] The previous version takes over and serves the unchanged data; the next start tries again.');
  for (const task of scheduledTasks) task.stop();
  const { noteFallback } = require('./pocketbase');
  const { getPocketBaseBinaryPath } = require('./db/client');
  const { resolveDataDirectory, resolvePocketBaseDirectory } = require('./pathConfig');
  // The frozen copy finds its folders relative to itself: it gets them handed over
  process.env.DATA_DIR = resolveDataDirectory();
  process.env.POCKETBASE_DIR = resolvePocketBaseDirectory();
  process.env.FRONTEND_DIR = frontendDir;
  process.env.POCKETBASE_BIN = getPocketBaseBinaryPath();
  process.env.AGORA_UPGRADE_NOTICE = JSON.stringify(notice);
  // The comparison of the upgrade used the previous backend's functions in this process: their caches go (the
  // superuser token it holds is no longer valid once that backend renews the superuser when it starts)
  const previous = require('./legacy/pocketbase');
  previous.clearSuperuserTokenCache();
  previous.invalidateReadCache();
  noteFallback(config).catch(() => {}).finally(() => {
    httpServer.close(() => require('./legacy/server.js'));
    httpServer.closeAllConnections?.();
  });
}
context.onUpgradeNotDone = handOverToPreviousBackend;
