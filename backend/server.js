const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const {
  context,
  loadConfig,
  logoAssetRateLimit,
  pageRateLimit,
  adminRateLimit,
  churchLogoFile,
  bundledChurchLogoFile,
  resolvedFrontendDir
} = require('./context');

const { selectChurchLogoFilePath } = require('./logoStorage');
const { resolveTrustProxySetting } = require('./trustProxy');
const { securityHeadersMiddleware } = require('./securityHeaders');
const { runAutomatedStandingOrders } = require('./standingOrders');
const { purgeExpiredRequests } = require('./requestRetention');
const { compressResponses, compressedStatic, sendCompressedFile } = require('./compression');

const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const eventsRouter = require('./routes/events');
const mentoringRouter = require('./routes/mentoring');
const financeRouter = require('./routes/finance');
const aiRouter = require('./routes/ai');
const systemRouter = require('./routes/system');

const app = express();
app.set('trust proxy', resolveTrustProxySetting());

// Security middleware: Set essential HTTP security headers
app.use(securityHeadersMiddleware);
// Gzip JSON / text responses (the reverse proxy in front usually does not compress)
app.use(compressResponses);

// Load configuration
loadConfig();

app.use(require('cors')());
app.use(express.json({ limit: '2mb' }));

cron.schedule('0 5 * * *', () => {
  if (!context.setupMode && context.appConfig) {
    runAutomatedStandingOrders(context.appConfig);
    purgeExpiredRequests(context.appConfig);
  }
});

// Setup mode redirection / guard middleware
app.use((req, res, next) => {
  if (
    req.path.startsWith('/api/setup') ||
    req.path.startsWith('/api/status') ||
    req.path.startsWith('/api/auth/') ||
    req.path.startsWith('/api/db') ||
    req.path === '/setup.html' ||
    req.path === '/floating-menu-demo.html' ||
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
  res.sendFile(logoFilePath, (error) => {
    if (error) next(error);
  });
});

// Frontend files go out compressed (cached per file version); config.js and the logo keep their own handlers
const sendPage = file => (req, res) => {
  if (!sendCompressedFile(req, res, file)) res.sendFile(file);
};
app.use('/assets', compressedStatic(path.join(frontendDir, 'assets'), { exclude: ['/config.js', '/church-logo.svg'] }));
app.use('/assets', express.static(path.join(frontendDir, 'assets')));
app.get('/sw.js', sendPage(path.join(frontendDir, 'sw.js')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(frontendDir, 'manifest.json')));
app.get('/setup.html', pageRateLimit, sendPage(path.join(frontendDir, 'setup.html')));
app.get('/floating-menu-demo.html', pageRateLimit, (req, res) => res.sendFile(path.join(frontendDir, 'floating-menu-demo.html')));
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
app.use(mentoringRouter);
app.use(financeRouter);
app.use(aiRouter);
app.use(systemRouter);

app.get('*', pageRateLimit, (req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/data/')) {
    return sendPage(path.join(frontendDir, 'index.html'))(req, res);
  }
  next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
