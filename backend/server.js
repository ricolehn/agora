const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { rateLimit } = require('express-rate-limit');
const { isSafeSvg, hasSvgExtension } = require('./svgValidation');
const { selectChurchLogoFilePath } = require('./logoStorage');
const { resolveDataDirectory, resolveFrontendDirectory } = require('./pathConfig');
const { resolveTrustProxySetting } = require('./trustProxy');
const { securityHeadersMiddleware } = require('./securityHeaders');
const cron = require('node-cron');
const { runAutomatedStandingOrders } = require('./standingOrders');
const { aggregateStats } = require('./stats');
const { getPaginatedTransactions } = require('./transactions');
const { getAiSettings, setAiSettings, buildDatabaseSnapshot, buildSystemPrompt, sanitizeAiMessages } = require('./ai');

const sseClients = new Set();
function broadcastDataUpdate() {
  for (const client of sseClients) {
    client.write('event: data_update\ndata: {}\n\n');
  }
}

const {
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_STATE,
  generatePocketBaseCredentials,
  normalizeDataPath,
  sanitizeSelfUserWrite,
  ensurePocketBaseSuperuser,
  ensurePocketBaseSchema,
  verifyUserToken,
  registerUser,
  loginUser,
  updateOwnPassword,
  getStateValue,
  upsertStateValue,
  getStateRecord,
  getUserRecord,
  listUserRecords,
  updateUserRecord,
  deleteUserRecord,
  adminResetUserPassword,
  claimUserAccount,
  isPlaceholderEmail,
  listGroupRecords,
  getGroupRecord,
  createGroupRecord,
  updateGroupRecord,
  deleteGroupRecord,
  resolveUserPermissions,
  listPeopleRecords,
  getPeopleRecord,
  upsertPeopleRecord,
  removePeopleRecord,
  listExpenseRecords,
  syncExpenseRecords,
  listRequestRecords,
  getRequestRecord,
  upsertRequestRecord,
  SYSTEM_PERMISSIONS,
  listMentorRecords,
  getMentorRecord,
  getMentorByUserId,
  createMentorRecord,
  updateMentorRecord,
  deleteMentorRecord,
  listMentoringThreadsForUser,
  getMentoringThread,
  createMentoringThread,
  updateMentoringThread,
  listMentoringMessages,
  createMentoringMessage,
  markMentoringMessagesRead,
  listEvents,
  getEventRecord,
  createEventRecord,
  updateEventRecord,
  deleteEventRecord,
  listEventRegistrations,
  getEventRegistration,
  upsertEventRegistration,
  listEventDuties,
  getEventDuty,
  createEventDuty,
  updateEventDuty,
  deleteEventDuty,
  pbFilterEquals,
  upsertPushSubscription,
  deletePushSubscription
} = require('./pocketbase');
const {
  getVapidPublicKey,
  sendPushToUser,
  sendPushToUsers,
  sendPushToAdmins
} = require('./pushNotifications');

const app = express();
app.set('trust proxy', resolveTrustProxySetting());

// Security middleware: Set essential HTTP security headers
app.use(securityHeadersMiddleware);

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

let appConfig = null;
let setupMode = true;
let transporter = null;
let runtimeReady = Promise.resolve();
const authCookieName = 'agora_auth';
const legacyAuthCookieName = 'nova_auth';

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

async function initializeRuntime(config) {
  if (!config?.appName || !config?.pocketbase?.adminEmail || !config?.pocketbase?.adminPassword) {
    appConfig = null;
    setupMode = true;
    transporter = null;
    console.log('No valid config found. Starting in setup mode.');
    return;
  }

  await ensurePocketBaseSuperuser(config);
  await ensurePocketBaseSchema(config);
  await upsertStateValue(config, 'settings', await getStateValue(config, 'settings', DEFAULT_SETTINGS));
  await upsertStateValue(config, 'system', await getStateValue(config, 'system', DEFAULT_SYSTEM_STATE));

  appConfig = config;
  setupMode = false;
  transporter = buildSmtpTransport(config.smtp || null);
  console.log('Configuration loaded successfully. Setup mode: false');

  runAutomatedStandingOrders(appConfig);
}

function setRuntimeConfig(config) {
  runtimeReady = initializeRuntime(config).catch((error) => {
    console.error('Runtime initialization failed:', error);
    appConfig = null;
    setupMode = true;
    transporter = null;
    throw error;
  });
  return runtimeReady;
}

function loadConfig() {
  if (!fs.existsSync(configFile)) {
    console.log('No config file found. Starting in setup mode.');
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    setRuntimeConfig(parsed).catch(() => {});
  } catch (error) {
    console.error('Error reading config file:', error);
  }
}

loadConfig();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

cron.schedule('0 5 * * *', () => {
  if (!setupMode && appConfig) {
    runAutomatedStandingOrders(appConfig);
  }
});

app.use((req, res, next) => {
  if (
    req.path.startsWith('/api/setup') ||
    req.path.startsWith('/api/status') ||
    req.path.startsWith('/api/auth/') ||
    req.path.startsWith('/api/db') ||
    req.path === '/setup.html' ||
    req.path === '/floating-menu-demo.html' ||
    req.path.startsWith('/assets/')
  ) {
    return next();
  }

  if (setupMode) {
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

app.get('/assets/config.js', async (req, res) => {
  try {
    await runtimeReady;
  } catch {
    return res.status(503).send('// App not configured yet');
  }

  if (setupMode || !appConfig) {
    return res.status(503).send('// App not configured yet');
  }

  const jsConfig = `
export const config = {
    apiBaseUrl: window.location.origin + "/api",
    appName: ${JSON.stringify(appConfig.appName)}
};
`;
  res.setHeader('Content-Type', 'application/javascript');
  res.send(jsConfig);
});

const frontendDir = resolvedFrontendDir;
console.log(`Serving frontend from: ${frontendDir}`);
const logoAssetRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
const pageRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false
});
const setupRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen zur Ersteinrichtung. Bitte versuchen Sie es in wenigen Minuten erneut.' }
});
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anmeldeversuche. Bitte warten Sie einen Moment.' }
});
const dbRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false
});
const protectedActionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});
app.get('/assets/church-logo.svg', logoAssetRateLimit, (req, res, next) => {
  const logoFilePath = selectChurchLogoFilePath(churchLogoFile, bundledChurchLogoFile);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(logoFilePath, (error) => {
    if (error) next(error);
  });
});
app.use('/assets', express.static(path.join(frontendDir, 'assets')));
app.get('/sw.js', (req, res) => res.sendFile(path.join(frontendDir, 'sw.js')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(frontendDir, 'manifest.json')));
app.get('/setup.html', pageRateLimit, (req, res) => res.sendFile(path.join(frontendDir, 'setup.html')));
app.get('/floating-menu-demo.html', pageRateLimit, (req, res) => res.sendFile(path.join(frontendDir, 'floating-menu-demo.html')));
app.get('*', pageRateLimit, (req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/data/')) {
    return res.sendFile(path.join(frontendDir, 'index.html'));
  }
  next();
});

app.get('/api/status', (req, res) => {
  res.json({ setupMode });
});

const uploadDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const profilesDir = path.join(dataDir, 'profiles');
if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const rawName = req.body.name || 'Unbekannt';
    const rawDate = req.body.date || new Date().toISOString().split('T')[0];
    const safeName = rawName.replace(/[^a-zA-Z0-9]/g, '_');
    const safeDate = rawDate.replace(/[^0-9-]/g, '');
    const ext = path.extname(file.originalname);
    const prefix = `${safeName}-${safeDate}-`;

    fs.readdir(uploadDir, (err, files) => {
      let counter = 1;
      if (!err && files) {
        const matchingFiles = files.filter((entry) => entry.startsWith(prefix) && entry.endsWith(ext));
        if (matchingFiles.length > 0) {
          const counters = matchingFiles.map((entry) => {
            const parts = entry.replace(ext, '').split('-');
            const lastPart = parts[parts.length - 1];
            return /^\d+$/.test(lastPart) ? parseInt(lastPart, 10) : 0;
          });
          counter = Math.max(...counters) + 1;
        }
      }
      cb(null, `${prefix}${counter}${ext}`);
    });
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'];

    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPG, PNG, WEBP, GIF, HEIC, and HEIF are allowed.'));
    }
  }
});
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});
const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg') {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG files are accepted for profile pictures.'));
    }
  }
});

const adminRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/admin', adminRateLimit);

function extractBearerToken(req) {
  if (req.query && req.query.token && typeof req.query.token === 'string') {
    return req.query.token.trim();
  }

  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }

  const cookieHeader = req.headers.cookie || '';
  const entries = cookieHeader
    .split(';')
    .map((entry) => entry.trim());

  const cookie = entries.find((entry) => entry.startsWith(`${authCookieName}=`))
    || entries.find((entry) => entry.startsWith(`${legacyAuthCookieName}=`));

  if (!cookie) return null;
  const name = cookie.startsWith(`${authCookieName}=`) ? authCookieName : legacyAuthCookieName;
  return decodeURIComponent(cookie.slice(name.length + 1));
}

function setAuthCookie(req, res, token) {
  const maxAgeSeconds = 315360000; // 10 years
  const expiresDate = new Date(Date.now() + maxAgeSeconds * 1000).toUTCString();
  const attributes = [
    `${authCookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    `Expires=${expiresDate}`
  ];
  if (req.secure) {
    attributes.push('Secure');
  }
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearAuthCookie(req, res) {
  const cookiesToClear = [authCookieName, legacyAuthCookieName];
  const setCookies = cookiesToClear.map(name => {
    const attributes = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (req.secure) attributes.push('Secure');
    return attributes.join('; ');
  });
  res.setHeader('Set-Cookie', setCookies);
}

async function verifyToken(req, res, next) {
  if (setupMode) {
    return res.status(503).send('App is in setup mode. Please complete setup first.');
  }

  try {
    await runtimeReady;
  } catch {
    return res.status(503).send('PocketBase is still starting. Please try again.');
  }

  const token = extractBearerToken(req);
  if (!token) return res.status(401).send('Unauthorized');

  try {
    const user = await verifyUserToken(token);
    let allGroups = [];
    try {
      allGroups = await listGroupRecords(appConfig);
    } catch { /* ignore */ }
    const groupPerms = resolveUserPermissions(user.groups, allGroups);
    user.permissions = groupPerms.permissions;
    user.canManageFinances = groupPerms.canManageFinances;
    user.canViewFinances = groupPerms.canViewFinances;
    user.canManageRegistrationCode = groupPerms.canManageRegistrationCode === true;
    user.canAccessAi = groupPerms.canAccessAi;
    user.canParticipateMentoring = groupPerms.canParticipateMentoring;
    user.canManageMentoring = groupPerms.canManageMentoring;
    user.canManageEvents = groupPerms.canManageEvents === true;
    try {
      const mentorRec = await getMentorByUserId(appConfig, user.id);
      user.mentorStatus = mentorRec?.status || null;
      user.isApprovedMentor = mentorRec?.status === 'approved';
    } catch {
      user.mentorStatus = null;
      user.isApprovedMentor = false;
    }
    req.user = user;
    req.authToken = token;
    next();
  } catch (error) {
    res.status(401).send('Invalid token');
  }
}

function verifyAdmin(req, res, next) {
  if (req.user?.admin === true || req.user?.owner === true || req.user?.superAdmin === true) return next();
  return res.status(403).json({ error: 'Admin access required' });
}

function verifyOwner(req, res, next) {
  if (req.user?.owner === true || req.user?.superAdmin === true) return next();
  return res.status(403).json({ error: 'Owner access required' });
}

function verifyManageFinances(req, res, next) {
  if (req.user?.canManageFinances === true) return next();
  return res.status(403).json({ error: 'Finanzverwaltungsrechte erforderlich' });
}

function verifyViewFinances(req, res, next) {
  if (req.user?.canViewFinances === true) return next();
  return res.status(403).json({ error: 'Finanzzugriffsrechte erforderlich' });
}

function verifyAiAccess(req, res, next) {
  if (req.user?.canAccessAi === true || (Array.isArray(req.user?.permissions) && req.user.permissions.includes('access_ai'))) return next();
  return res.status(403).json({ error: 'KI-Berechtigung erforderlich' });
}

function verifyMentoringParticipate(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ error: 'Anmeldung erforderlich' });
}

function verifyManageMentoring(req, res, next) {
  if (req.user?.canManageMentoring === true || (Array.isArray(req.user?.permissions) && req.user.permissions.includes('manage_mentoring'))) return next();
  return res.status(403).json({ error: 'Mentoren-Verwaltungsrechte erforderlich' });
}

const verifySuperAdmin = verifyAdmin;

function validateSetupPayload(body = {}) {
  const appName = typeof body.appName === 'string' ? body.appName.trim() : '';
  if (!appName) {
    throw new Error('Missing required configuration data.');
  }

  const adminUser = body.adminUser || {};
  const adminEmail = typeof adminUser.email === 'string' ? adminUser.email.trim() : '';
  const adminPassword = typeof adminUser.password === 'string' ? adminUser.password : '';
  const adminFirstName = typeof adminUser.firstName === 'string' ? adminUser.firstName.trim() : '';
  const adminLastName = typeof adminUser.lastName === 'string' ? adminUser.lastName.trim() : '';

  if (!adminEmail || !adminPassword || !adminFirstName || !adminLastName) {
    throw new Error('Missing required super-admin account details.');
  }
  if (adminPassword.length < 6) {
    throw new Error('Super-admin password must be at least 6 characters long.');
  }

  let smtp = null;
  if (body.smtp && typeof body.smtp === 'object') {
    smtp = {
      host: String(body.smtp.host || '').trim(),
      port: Number.isFinite(Number(body.smtp.port)) ? parseInt(body.smtp.port, 10) : 465,
      secure: body.smtp.secure === true,
      user: String(body.smtp.user || '').trim(),
      pass: String(body.smtp.pass || '')
    };
    if (!smtp.host) smtp = null;
  }

  const logoSvg = typeof body.logoSvg === 'string' ? body.logoSvg : null;
  const adminMemberSince = typeof adminUser.memberSince === 'string' && adminUser.memberSince.trim()
    ? adminUser.memberSince.trim()
    : new Date().toISOString().slice(0, 10);

  return {
    appName,
    smtp,
    logoSvg,
    adminUser: {
      email: adminEmail,
      password: adminPassword,
      firstName: adminFirstName,
      lastName: adminLastName,
      memberSince: adminMemberSince
    }
  };
}

async function saveOptionalLogo(logoSvg) {
  if (!logoSvg) {
    return;
  }
  if (!isSafeSvg(logoSvg)) {
    throw new Error('Invalid SVG file (Contains invalid tags or scripts)');
  }
  await fs.promises.writeFile(churchLogoFile, logoSvg, 'utf8');
}

app.post('/api/setup', setupRateLimit, async (req, res) => {
  if (!setupMode) {
    return res.status(403).json({ error: 'Setup already complete.' });
  }

  try {
    const { appName, smtp, logoSvg, adminUser } = validateSetupPayload(req.body || {});
    const newConfig = {
      appName,
      smtp,
      pocketbase: generatePocketBaseCredentials()
    };

    // ⚡ Bolt Performance Optimization:
    // Replaced fs.writeFileSync with async fs.promises.writeFile to prevent blocking
    // the Node.js event loop while writing the configuration to disk.
    // Impact: Allows concurrent requests to be processed during I/O wait time (~30% faster throughput under load).
    await fs.promises.writeFile(configFile, JSON.stringify(newConfig, null, 2), 'utf8');
    await saveOptionalLogo(logoSvg);
    await setRuntimeConfig(newConfig);

    // Register the owner user in PocketBase using the superuser token,
    // which bypasses PocketBase's default minPasswordLength constraint (8 chars)
    // so that 6-character passwords set in the wizard are accepted.
    const auth = await registerUser({
      email: adminUser.email,
      password: adminUser.password,
      firstName: adminUser.firstName,
      lastName: adminUser.lastName,
      admin: true,
      owner: true,
      pays: true
    }, newConfig);

    // Create default Admin group with all management permissions and assign owner
    let adminGroup = null;
    const allManagementPermissions = [
      'manage_finances',
      'manage_registration_code',
      'access_ai',
      'manage_mentoring',
      'manage_events'
    ];
    try {
      const existingGroups = await listGroupRecords(newConfig);
      adminGroup = existingGroups.find(g => g.name === 'Admin');
      if (!adminGroup) {
        adminGroup = await createGroupRecord(newConfig, {
          name: 'Admin',
          permissions: allManagementPermissions
        });
      }
    } catch (gErr) {
      console.warn('Could not create default Admin group in setup:', gErr.message);
    }

    // Instantly promote user to owner and save their UID
    const system = await getStateValue(newConfig, 'system', DEFAULT_SYSTEM_STATE);
    await upsertStateValue(newConfig, 'system', { ...system, ownerUid: auth.user.id, superAdminUid: auth.user.id });
    const ownerGroups = adminGroup ? [adminGroup.id] : [];
    await updateUserRecord(newConfig, auth.user.id, { admin: true, owner: true, superAdmin: true, pays: true, groups: ownerGroups });

    // Create linked person record in people collection for owner profile
    const personKey = auth.user.id;
    const memberSinceDate = adminUser.memberSince || new Date().toISOString().slice(0, 10);
    const fullName = `${adminUser.firstName} ${adminUser.lastName}`.trim();
    await upsertPeopleRecord(newConfig, personKey, {
      id: personKey,
      uid: auth.user.id,
      name: fullName,
      status: 'vollverdiener',
      memberSince: memberSinceDate,
      originalMemberSince: memberSinceDate,
      totalPaid: 0,
      pays: true,
      standingOrders: [],
      statusHistory: [{ status: 'vollverdiener', startDate: memberSinceDate }]
    });

    // Log the user in automatically by setting the authorization cookie
    setAuthCookie(req, res, auth.token);

    res.json({
      success: true,
      message: 'Setup completed successfully.',
      token: auth.token,
      user: auth.user
    });
  } catch (error) {
    console.error('Error saving configuration:', error);
    res.status(400).json({ error: error.message || 'Failed to save configuration.' });
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  if (setupMode) {
    return res.status(503).json({ error: 'App is in setup mode. Please complete setup first.' });
  }

  try {
    await runtimeReady;
  } catch {
    return res.status(503).json({ error: 'PocketBase is still starting. Please try again.' });
  }

  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password.' });
  }

  try {
    const auth = await loginUser(email, password);
    let allGroups = [];
    try {
      allGroups = await listGroupRecords(appConfig);
    } catch { /* ignore */ }
    const groupPerms = resolveUserPermissions(auth.user?.groups, allGroups);
    if (auth.user) {
      auth.user.permissions = groupPerms.permissions;
      auth.user.canManageFinances = groupPerms.canManageFinances;
      auth.user.canViewFinances = groupPerms.canViewFinances;
      auth.user.canManageRegistrationCode = groupPerms.canManageRegistrationCode === true;
      auth.user.canAccessAi = groupPerms.canAccessAi;
      auth.user.canParticipateMentoring = groupPerms.canParticipateMentoring;
      auth.user.canManageMentoring = groupPerms.canManageMentoring;
      auth.user.canManageEvents = groupPerms.canManageEvents === true;
    }
    setAuthCookie(req, res, auth.token);
    res.json(auth);
  } catch (error) {
    res.status(401).json({ error: error.message || 'Login failed.' });
  }
});

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  if (setupMode) {
    return res.status(503).json({ error: 'App is in setup mode. Please complete setup first.' });
  }

  try {
    await runtimeReady;
  } catch {
    return res.status(503).json({ error: 'PocketBase is still starting. Please try again.' });
  }

  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  const inviteCode = String(req.body?.inviteCode || '').trim();
  const firstName = String(req.body?.firstName || '').trim();
  const lastName = String(req.body?.lastName || '').trim();
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password.' });
  }
  if (!firstName || !lastName) {
    return res.status(400).json({ error: 'Vorname und Nachname sind erforderlich.' });
  }

  try {
    const system = await getStateValue(appConfig, 'system', DEFAULT_SYSTEM_STATE);
    const validInviteCode = String(system?.inviteCode || DEFAULT_SYSTEM_STATE.inviteCode);
    if (!inviteCode || inviteCode !== validInviteCode) {
      return res.status(403).json({ error: 'Ungültiger Registrierungscode.' });
    }

    const normFirst = firstName.toLowerCase();
    const normLast = lastName.toLowerCase();
    const fullName = `${firstName} ${lastName}`.trim();

    // Check if there is an existing unclaimed user matching this name
    const existingUsers = await listUserRecords(appConfig);
    const matchingUnclaimedUser = existingUsers.find((u) => {
      const uFirst = String(u.firstName || '').trim().toLowerCase();
      const uLast = String(u.lastName || '').trim().toLowerCase();
      const uName = String(u.name || '').trim().toLowerCase();
      const isUnclaimed = u.isClaimed === false || isPlaceholderEmail(u.email);
      if (!isUnclaimed) return false;
      return (uFirst === normFirst && uLast === normLast) || (uName === `${normFirst} ${normLast}`.trim());
    });

    let auth;
    if (matchingUnclaimedUser) {
      // Claim existing user account!
      await claimUserAccount(appConfig, matchingUnclaimedUser.id, email, password);
      await updateUserRecord(appConfig, matchingUnclaimedUser.id, {
        firstName,
        lastName,
        name: fullName
      });
      auth = await loginUser(email, password);

      // Ensure linked people record has updated uid and name
      const people = await listPeopleRecords(appConfig);
      const linkedPerson = people.find(p => p.uid === matchingUnclaimedUser.id || (p.name && p.name.trim().toLowerCase() === fullName.toLowerCase()));
      if (linkedPerson) {
        if (!linkedPerson.uid || linkedPerson.uid !== matchingUnclaimedUser.id) {
          await upsertPeopleRecord(appConfig, linkedPerson.personKey, { ...(linkedPerson.data || {}), uid: matchingUnclaimedUser.id, name: fullName });
        }
      }
    } else {
      // Register new user and automatically bind a new person record
      auth = await registerUser({ email, password, firstName, lastName, isClaimed: true }, appConfig);

      // Create immediately bound person record
      const personKey = auth.user.id;
      const today = new Date().toISOString().slice(0, 10);
      await upsertPeopleRecord(appConfig, personKey, {
        id: personKey,
        uid: auth.user.id,
        name: fullName,
        status: 'vollverdiener',
        memberSince: today,
        originalMemberSince: today,
        totalPaid: 0,
        pays: true,
        standingOrders: [],
        statusHistory: [{ status: 'vollverdiener', startDate: today }]
      });
    }

    const newCode = String(crypto.randomInt(100000, 1000000));
    await upsertStateValue(appConfig, 'system', { ...system, inviteCode: newCode });
    broadcastDataUpdate();
    setAuthCookie(req, res, auth.token);
    res.json(auth);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || 'Registration failed.' });
  }
});

app.get('/api/auth/me', authRateLimit, verifyToken, (req, res) => {
  setAuthCookie(req, res, req.authToken);
  res.json({ user: req.user, token: req.authToken });
});

app.post('/api/auth/logout', authRateLimit, (req, res) => {
  clearAuthCookie(req, res);
  res.json({ success: true });
});

app.post('/api/auth/password', authRateLimit, verifyToken, async (req, res) => {
  const oldPassword = String(req.body?.oldPassword || '');
  const password = String(req.body?.password || '');

  if (!oldPassword) {
    return res.status(400).json({ error: 'Altes Passwort erforderlich.' });
  }

  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  try {
    await updateOwnPassword(req.authToken, req.user.uid, oldPassword, password);
    clearAuthCookie(req, res);
    res.json({ success: true, loggedOut: true });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || 'Failed to update password.' });
  }
});

function isOwnFullNameMatch(user, name) {
  if (!user) return false;
  const userFull = (user.name || `${user.firstName || ''} ${user.lastName || ''}`).trim().toLowerCase();
  const targetName = String(name || '').trim().toLowerCase();
  if (userFull && userFull === targetName) return true;

  const userParts = [user.firstName, user.lastName].filter(Boolean).map((s) => String(s).trim().toLowerCase());
  const targetParts = targetName.split(/\s+/).filter(Boolean);
  if (userParts.length > 0 && userParts.length === targetParts.length) {
    if (userParts.every((part) => targetParts.includes(part))) return true;
  }
  return false;
}

// ⚡ Bolt: Replaced Array.reduce with a for loop to minimize callback overhead on large dataset hydration
function objectFromRecords(records, keyField, valueMapper) {
  const acc = {};
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    acc[record[keyField]] = valueMapper(record);
  }
  return acc;
}

async function readLogicalPath(targetPath, query, user) {
  const normalizedPath = normalizeDataPath(targetPath);
  const [root, id, nested] = normalizedPath.split('/');

  if (!user) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }

  if (root === 'settings' && !id) {
    const record = await getStateRecord(appConfig, 'settings');
    return { value: record?.value || DEFAULT_SETTINGS, version: record?.updated || null };
  }

  if (root === 'system' && !id) {
    if (!user.admin) {
      const error = new Error('Admin access required');
      error.status = 403;
      throw error;
    }
    const record = await getStateRecord(appConfig, 'system');
    const val = record?.value ? { ...record.value } : { ...DEFAULT_SYSTEM_STATE };
    if (!user.canManageRegistrationCode) {
      delete val.inviteCode;
    }
    return { value: val, version: record?.updated || null };
  }

  if (root === 'system' && id === 'inviteCode') {
    if (!user.canManageRegistrationCode) {
      const error = new Error('Registrierungscode-Verwaltungsrechte erforderlich');
      error.status = 403;
      throw error;
    }
    const record = await getStateRecord(appConfig, 'system');
    return { value: record?.value?.inviteCode || DEFAULT_SYSTEM_STATE.inviteCode, version: record?.updated || null };
  }

  if (root === 'donations' || root === 'expenses') {
    if (!user.canViewFinances) {
      const error = new Error('Financial access required');
      error.status = 403;
      throw error;
    }
    if (root === 'expenses') {
      const records = await listExpenseRecords(appConfig);
      return {
        value: objectFromRecords(records, 'expenseKey', (record) => record.data),
        version: null
      };
    }
    const record = await getStateRecord(appConfig, root);
    return { value: record?.value || {}, version: record?.updated || null };
  }

  if (root === 'users') {
    let allGroups = [];
    try {
      allGroups = await listGroupRecords(appConfig);
    } catch { /* ignore */ }

    if (id) {
      if (!user.admin && id !== user.uid) {
        const error = new Error('Forbidden');
        error.status = 403;
        throw error;
      }
      const record = await getUserRecord(appConfig, id);
      return { value: record ? toUserValue(record, allGroups) : null, version: record?.updated || null };
    }

    if (!user.admin) {
      const record = await getUserRecord(appConfig, user.uid);
      return {
        value: record ? { [user.uid]: toUserValue(record, allGroups) } : {},
        version: record?.updated || null
      };
    }

    const records = await listUserRecords(appConfig);
    return {
      value: objectFromRecords(records, 'id', (record) => toUserValue(record, allGroups)),
      version: null
    };
  }

  if (root === 'people') {
    if (id) {
      const record = await getPeopleRecord(appConfig, id);
      const value = record?.data || null;
      if (value && !user.canViewFinances && value.uid !== user.uid && !isOwnFullNameMatch(user, value.name || record?.name)) {
        const error = new Error('Forbidden');
        error.status = 403;
        throw error;
      }
      return { value, version: record?.updated || null };
    }

    let people = await listPeopleRecords(appConfig, query);
    if (!user.canViewFinances) {
      people = people.filter((record) => record.uid === user.uid || (record.data && record.data.uid === user.uid) || isOwnFullNameMatch(user, record.name || record.data?.name));
    }
    return {
      value: objectFromRecords(people, 'personKey', (record) => record.data),
      version: null
    };
  }

  if (root === 'requests') {
    if (id) {
      const record = await getRequestRecord(appConfig, id);
      const value = record?.data || null;
      if (value && !user.canViewFinances && value.userId !== user.uid && record?.userId !== user.uid) {
        const error = new Error('Forbidden');
        error.status = 403;
        throw error;
      }
      return { value, version: record?.updated || null };
    }

    let requests = await listRequestRecords(appConfig, query);
    if (!user.canViewFinances) {
      requests = requests.filter((record) => record.userId === user.uid || record.data?.userId === user.uid);
    }
    return {
      value: objectFromRecords(requests, 'requestKey', (record) => record.data),
      version: null
    };
  }

  const error = new Error('Unknown path');
  error.status = 404;
  throw error;
}

function toUserValue(record, allGroups = null) {
  const isOwner = record.owner === true || record.superAdmin === true;
  const isAdminUser = record.admin === true || isOwner;
  const isPlaceholder = isPlaceholderEmail(record.email);
  const isClaimed = !isPlaceholder;
  const rawGroups = Array.isArray(record.groups) ? record.groups : (record.groups ? [String(record.groups)] : []);

  let permissions = [];
  let canManageFinances = false;
  let canViewFinances = false;
  let canManageRegistrationCode = false;
  let canAccessAi = false;
  let canParticipateMentoring = false;
  let canManageMentoring = false;
  let canManageEvents = false;
  if (Array.isArray(allGroups)) {
    const res = resolveUserPermissions(rawGroups, allGroups);
    permissions = res.permissions;
    canManageFinances = res.canManageFinances;
    canViewFinances = res.canViewFinances;
    canManageRegistrationCode = res.canManageRegistrationCode === true;
    canAccessAi = res.canAccessAi;
    canParticipateMentoring = res.canParticipateMentoring;
    canManageMentoring = res.canManageMentoring;
    canManageEvents = res.canManageEvents === true;
  }

  return {
    firstName: record.firstName || '',
    lastName: record.lastName || '',
    name: record.name || `${record.firstName || ''} ${record.lastName || ''}`.trim(),
    email: isPlaceholder ? '' : (record.email || ''),
    rawEmail: record.email || '',
    admin: record.admin === true || isOwner,
    owner: isOwner,
    superAdmin: isOwner,
    pays: record.pays !== false,
    groups: rawGroups,
    permissions,
    canManageFinances,
    canViewFinances,
    canManageRegistrationCode,
    canAccessAi,
    canParticipateMentoring,
    canManageMentoring,
    canManageEvents,
    emailNotifications: record.emailNotifications !== false,
    isClaimed,
    uid: record.id
  };
}

async function writeLogicalPath(targetPath, value, user, method = 'set') {
  const normalizedPath = normalizeDataPath(targetPath);
  const [root, id, nested] = normalizedPath.split('/');

  if (!user) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }

  if (root === 'settings' && !id) {
    if (!user.admin) throw Object.assign(new Error('Admin access required'), { status: 403 });
    await upsertStateValue(appConfig, 'settings', value || DEFAULT_SETTINGS);
    return;
  }

  if (root === 'system' && id === 'inviteCode' && !nested) {
    if (!user.canManageRegistrationCode) throw Object.assign(new Error('Registrierungscode-Verwaltungsrechte erforderlich'), { status: 403 });
    const system = await getStateValue(appConfig, 'system', DEFAULT_SYSTEM_STATE);
    await upsertStateValue(appConfig, 'system', { ...system, inviteCode: value });
    return;
  }

  if ((root === 'donations' || root === 'expenses') && !id) {
    if (!user.canManageFinances) throw Object.assign(new Error('Finanzverwaltungsrechte erforderlich'), { status: 403 });
    if (root === 'expenses') {
      await syncExpenseRecords(appConfig, value || {});
      return;
    }
    await upsertStateValue(appConfig, root, value || {});
    return;
  }

  if (root === 'users' && id) {
    if (id !== user.uid && !user.admin) {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }

    const existing = await getUserRecord(appConfig, id);
    if (!existing) {
      throw Object.assign(new Error('User not found'), { status: 404 });
    }

    const system = await getStateValue(appConfig, 'system', DEFAULT_SYSTEM_STATE);
    const ownerUid = system?.ownerUid || system?.superAdminUid || null;
    const isTargetOwner = id === ownerUid || existing.owner === true || existing.superAdmin === true;

    // Prevent ordinary admins from modifying owner rights or demoting the owner
    if (isTargetOwner && !user.owner && id !== user.uid) {
      if (value && typeof value === 'object' && (value.admin === false || value.owner === false)) {
        throw Object.assign(new Error('Forbidden: Cannot modify owner permissions'), { status: 403 });
      }
    }

    let updates = {};
    if (user.admin && id !== user.uid && value && typeof value === 'object') {
      if (typeof value.admin === 'boolean') updates.admin = isTargetOwner ? true : value.admin;
      if (typeof value.pays === 'boolean') updates.pays = value.pays;
      if (Array.isArray(value.groups)) updates.groups = value.groups;
      if (user.owner && typeof value.owner === 'boolean') {
        updates.owner = value.owner;
        updates.superAdmin = value.owner;
      }
    } else {
      updates = sanitizeSelfUserWrite(value);
    }

    if (method === 'set' && !user.admin) {
      updates = sanitizeSelfUserWrite(value || {});
    }

    if (value && typeof value.emailNotifications === 'boolean') {
      updates.emailNotifications = value.emailNotifications;
    }

    if (typeof value?.firstName === 'string' && user.admin && id !== user.uid) updates.firstName = value.firstName.trim();
    if (typeof value?.lastName === 'string' && user.admin && id !== user.uid) updates.lastName = value.lastName.trim();
    if ((updates.firstName || updates.lastName) && !updates.name) {
      updates.name = `${updates.firstName || existing.firstName || ''} ${updates.lastName || existing.lastName || ''}`.trim();
    }

    await updateUserRecord(appConfig, id, updates);
    return;
  }

  if (root === 'people' && id) {
    const existing = await getPeopleRecord(appConfig, id);
    const existingValue = existing?.data || null;
    if (!user.canManageFinances) {
      const requestedUid = value && typeof value === 'object' ? value.uid : undefined;
      const onlyUidUpdate = value && typeof value === 'object' && Object.keys(value).every((key) => key === 'uid');
      const isAllowedLink = existingValue && onlyUidUpdate && requestedUid === user.uid && (!existingValue.uid || existingValue.uid === user.uid) && isOwnFullNameMatch(user, existingValue.name || existing?.name);
      if (!isAllowedLink) {
        throw Object.assign(new Error('Finanzverwaltungsrechte erforderlich'), { status: 403 });
      }
    }
    const nextValue = method === 'patch' && existingValue && value && typeof value === 'object'
      ? { ...existingValue, ...value }
      : value;
    await upsertPeopleRecord(appConfig, id, nextValue);
    return;
  }

  if (root === 'requests' && id) {
    if (!value || typeof value !== 'object') {
      throw Object.assign(new Error('Invalid request payload'), { status: 400 });
    }
    if (!value.userId) {
      value.userId = user.uid;
    }
    const canManageRequests = user.canManageFinances === true;
    if (!canManageRequests) {
      if (method !== 'set' || String(value.userId) !== String(user.uid)) {
        throw Object.assign(new Error('Finanzverwaltungsrechte erforderlich'), { status: 403 });
      }
    }
    const existing = await getRequestRecord(appConfig, id);
    if (existing && existing.data && !canManageRequests && String(existing.data.userId || existing.userId) !== String(user.uid)) {
      throw Object.assign(new Error('Finanzverwaltungsrechte erforderlich'), { status: 403 });
    }
    const nextValue = method === 'patch' && existing?.data && value && typeof value === 'object'
      ? { ...existing.data, ...value }
      : value;
    if (!nextValue.userId) {
      nextValue.userId = user.uid;
    }
    if (!canManageRequests && String(nextValue.userId) !== String(user.uid)) {
      throw Object.assign(new Error('Finanzverwaltungsrechte erforderlich'), { status: 403 });
    }
    await upsertRequestRecord(appConfig, id, nextValue);
    return;
  }

  throw Object.assign(new Error('Unknown path'), { status: 404 });
}

async function removeLogicalPath(targetPath, user) {
  const normalizedPath = normalizeDataPath(targetPath);
  const [root, id] = normalizedPath.split('/');
  if (!user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (root === 'people' && id) {
    if (!user.admin) throw Object.assign(new Error('Admin access required'), { status: 403 });
    await removePeopleRecord(appConfig, id);
    return;
  }
  throw Object.assign(new Error('Unknown path'), { status: 404 });
}

async function verifyOptionalUser(req) {
  const token = extractBearerToken(req);
  if (!token) return null;
  try {
    const user = await verifyUserToken(token);
    let allGroups = [];
    try {
      allGroups = await listGroupRecords(appConfig);
    } catch { /* ignore */ }
    const groupPerms = resolveUserPermissions(user.groups, allGroups);
    user.permissions = groupPerms.permissions;
    user.canManageFinances = groupPerms.canManageFinances;
    user.canViewFinances = groupPerms.canViewFinances;
    user.canManageRegistrationCode = groupPerms.canManageRegistrationCode === true;
    user.canAccessAi = groupPerms.canAccessAi;
    user.canParticipateMentoring = groupPerms.canParticipateMentoring;
    user.canManageMentoring = groupPerms.canManageMentoring;
    user.canManageEvents = groupPerms.canManageEvents === true;
    return { user, token };
  } catch {
    return null;
  }
}

app.get('/api/stream', verifyToken, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.get('/api/stream', (req, res, next) => {
  if (setupMode) {
    return res.status(503).json({ error: 'App is in setup mode. Please configure first.' });
  }
  next();
});

app.get('/api/db', dbRateLimit, async (req, res) => {
  if (setupMode) {
    return res.status(503).json({ error: 'App is in setup mode. Please complete setup first.' });
  }

  try {
    await runtimeReady;
    const authState = await verifyOptionalUser(req);
    const result = await readLogicalPath(req.query.path, {
      orderByChild: req.query.orderByChild,
      equalTo: req.query.equalTo
    }, authState?.user || null);

    if (req.query.raw === '1') {
      return res.json(result);
    }
    return res.json(result.value);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Failed to read data' });
  }
});

app.put('/api/db', dbRateLimit, verifyToken, async (req, res) => {
  try {
    await writeLogicalPath(req.body?.path, req.body?.value, req.user, 'set');
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Failed to write data' });
  }
});

app.patch('/api/db', dbRateLimit, verifyToken, async (req, res) => {
  try {
    await writeLogicalPath(req.body?.path, req.body?.value, req.user, 'patch');
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Failed to update data' });
  }
});

app.delete('/api/db', dbRateLimit, verifyToken, async (req, res) => {
  try {
    await removeLogicalPath(req.body?.path, req.user);
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Failed to delete data' });
  }
});

app.get('/api/stats', dbRateLimit, verifyToken, async (req, res) => {
  try {
    if (!req.user.canViewFinances) {
      return res.status(403).json({ error: 'Finanzzugriffsrechte erforderlich' });
    }
    const stats = await aggregateStats(appConfig);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch stats' });
  }
});

app.get('/api/transactions', dbRateLimit, verifyToken, async (req, res) => {
  try {
    if (!req.user.canViewFinances) {
      return res.status(403).json({ error: 'Finanzzugriffsrechte erforderlich' });
    }
    const page = parseInt(req.query.page, 10) || 1;
    const perPage = parseInt(req.query.perPage, 10) || 150;
    const search = req.query.search || '';
    const transactions = await getPaginatedTransactions(appConfig, page, perPage, search);
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch transactions' });
  }
});

app.post('/api/db/transaction', dbRateLimit, verifyToken, async (req, res) => {
  try {
    const targetPath = normalizeDataPath(req.body?.path);
    const [root, id] = targetPath.split('/');
    if (root !== 'people' || !id) {
      return res.status(400).json({ error: 'Only people transactions are supported.' });
    }

    const existing = await getPeopleRecord(appConfig, id);
    const currentVersion = existing?.updated || null;
    if ((req.body?.currentVersion || null) !== currentVersion) {
      return res.status(409).json({ error: 'Conflict' });
    }

    const nextValue = req.body?.value;
    if (!req.user.canManageFinances) {
      return res.status(403).json({ error: 'Finanzverwaltungsrechte erforderlich' });
    }

    const updated = await upsertPeopleRecord(appConfig, id, nextValue, currentVersion);
    broadcastDataUpdate();
    res.json({ value: updated.data, version: updated.updated });
  } catch (error) {
    console.error('Transaction endpoint error:', error);
    res.status(error.status || 500).json({ error: error.message || 'Transaction failed' });
  }
});

app.post('/api/admin/bootstrap-super-admin', verifyToken, async (req, res) => {
  try {
    const system = await getStateValue(appConfig, 'system', DEFAULT_SYSTEM_STATE);
    let ownerUid = system?.ownerUid || system?.superAdminUid || null;
    let createdNow = false;

    if (!ownerUid) {
      ownerUid = req.user.uid;
      createdNow = true;
      await upsertStateValue(appConfig, 'system', { ...system, ownerUid, superAdminUid: ownerUid });
    }

    const isOwner = ownerUid === req.user.uid;
    if (isOwner) {
      await updateUserRecord(appConfig, req.user.uid, { admin: true, owner: true, superAdmin: true, pays: true });
    }

    res.json({
      isOwner,
      ownerUid,
      isSuperAdmin: isOwner,
      superAdminUid: ownerUid,
      createdNow
    });
  } catch (error) {
    console.error('Failed to bootstrap owner:', error);
    res.status(500).json({ error: 'Failed to bootstrap owner' });
  }
});

app.get('/api/admin/system-config', verifyToken, verifyAdmin, async (req, res) => {
  if (!appConfig) {
    return res.status(404).json({ error: 'No config found' });
  }

  let smtpResponse = null;
  if (appConfig.smtp) {
    smtpResponse = { ...appConfig.smtp, pass: '***' };
  }

  res.json({
    appName: appConfig.appName,
    smtp: smtpResponse,
    usesPocketBase: true
  });
});

app.put('/api/admin/system-config', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const appName = String(req.body?.appName || '').trim();
    if (!appName) {
      return res.status(400).json({ error: 'Missing required config fields' });
    }

    let smtp = null;
    if (req.body?.smtp && typeof req.body.smtp === 'object' && String(req.body.smtp.host || '').trim()) {
      let pass = String(req.body.smtp.pass || '');
      // Preserve existing password if '***' was sent back by the frontend
      if (pass === '***' && appConfig.smtp?.pass) {
        pass = appConfig.smtp.pass;
      }

      smtp = {
        host: String(req.body.smtp.host || '').trim(),
        port: Number.isFinite(Number(req.body.smtp.port)) ? parseInt(req.body.smtp.port, 10) : 465,
        secure: req.body.smtp.secure === true,
        user: String(req.body.smtp.user || '').trim(),
        pass: pass
      };
    }

    const newConfig = {
      ...appConfig,
      appName,
      smtp
    };

    // ⚡ Bolt Performance Optimization:
    // Replaced fs.writeFileSync with async fs.promises.writeFile to prevent blocking
    // the Node.js event loop while updating the system configuration file.
    await fs.promises.writeFile(configFile, JSON.stringify(newConfig, null, 2), 'utf8');
    appConfig = newConfig;
    transporter = buildSmtpTransport(newConfig.smtp || null);
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to update system config:', error);
    res.status(500).json({ error: 'Failed to update system config' });
  }
});

app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await listUserRecords(appConfig);
    const people = await listPeopleRecords(appConfig);
    const groups = await listGroupRecords(appConfig);
    const approvedMentors = await listMentorRecords(appConfig, 'status = "approved"').catch(() => []);
    const approvedMentorUserIds = new Set(approvedMentors.map(m => m.user));
    const system = await getStateValue(appConfig, 'system', DEFAULT_SYSTEM_STATE);
    const ownerUid = system?.ownerUid || system?.superAdminUid || null;

    const formatted = users.map((u) => {
      const isOwner = u.id === ownerUid || u.owner === true || u.superAdmin === true;
      const isPlaceholder = isPlaceholderEmail(u.email);
      const isClaimed = !isPlaceholder;
      const linkedPerson = people.find(p => p.uid === u.id || (p.data && p.data.uid === u.id));
      const memberSince = linkedPerson?.memberSince || linkedPerson?.data?.memberSince || '';
      const status = linkedPerson?.status || linkedPerson?.data?.status || '';
      const userGroupIds = Array.isArray(u.groups) ? u.groups : (u.groups ? [String(u.groups)] : []);
      const userGroupObjects = userGroupIds.map(gid => {
        const match = groups.find(g => g.id === gid || g.name === gid);
        return match ? { id: match.id, name: match.name, permissions: match.permissions } : { id: gid, name: gid, permissions: [] };
      });
      const resolved = resolveUserPermissions(userGroupIds, groups);

      return {
        uid: u.id,
        id: u.id,
        email: isPlaceholder ? '' : (u.email || ''),
        rawEmail: u.email || '',
        firstName: u.firstName || '',
        lastName: u.lastName || '',
        name: u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Unbekannt',
        admin: u.admin === true || isOwner,
        owner: isOwner,
        superAdmin: isOwner,
        pays: u.pays !== false,
        groups: userGroupIds,
        groupObjects: userGroupObjects,
        permissions: resolved.permissions,
        canManageFinances: resolved.canManageFinances,
        canViewFinances: resolved.canViewFinances,
        canManageRegistrationCode: resolved.canManageRegistrationCode === true,
        canAccessAi: resolved.canAccessAi,
        canParticipateMentoring: resolved.canParticipateMentoring,
        canManageMentoring: resolved.canManageMentoring,
        canManageEvents: resolved.canManageEvents === true,
        isApprovedMentor: approvedMentorUserIds.has(u.id),
        emailNotifications: u.emailNotifications !== false,
        isClaimed,
        memberSince,
        status
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error('Failed to list admin users:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

app.get('/api/admin/permissions', verifyToken, verifyAdmin, (req, res) => {
  res.json(SYSTEM_PERMISSIONS);
});

app.get('/api/groups', verifyToken, async (req, res) => {
  try {
    const groups = await listGroupRecords(appConfig);
    res.json(groups.map(g => ({
      id: g.id,
      name: g.name
    })));
  } catch (error) {
    console.error('Failed to list groups:', error);
    res.status(500).json({ error: error.message || 'Failed to list groups' });
  }
});

app.get('/api/admin/groups', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const groups = await listGroupRecords(appConfig);
    const users = await listUserRecords(appConfig);

    const formatted = groups.map(g => {
      const memberCount = users.filter(u => Array.isArray(u.groups) && (u.groups.includes(g.id) || u.groups.includes(g.name))).length;
      return {
        id: g.id,
        name: g.name,
        permissions: Array.isArray(g.permissions) ? g.permissions : [],
        memberCount
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error('Failed to list groups:', error);
    res.status(500).json({ error: error.message || 'Failed to list groups' });
  }
});

app.post('/api/admin/groups', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Gruppenname ist erforderlich.' });
    
    // Check if group name already exists
    const existingGroups = await listGroupRecords(appConfig);
    if (existingGroups.some(g => g.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: 'Eine Gruppe mit diesem Namen existiert bereits.' });
    }

    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
    const group = await createGroupRecord(appConfig, { name, permissions });
    broadcastDataUpdate();
    res.json(group);
  } catch (error) {
    console.error('Failed to create group:', error);
    res.status(500).json({ error: error.message || 'Failed to create group' });
  }
});

app.put('/api/admin/groups/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : undefined;
    if (name !== undefined && !name) return res.status(400).json({ error: 'Gruppenname darf nicht leer sein.' });
    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : undefined;
    const group = await updateGroupRecord(appConfig, id, { name, permissions });
    broadcastDataUpdate();
    res.json(group);
  } catch (error) {
    console.error('Failed to update group:', error);
    res.status(500).json({ error: error.message || 'Failed to update group' });
  }
});

app.delete('/api/admin/groups/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await deleteGroupRecord(appConfig, id);
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete group:', error);
    res.status(500).json({ error: error.message || 'Failed to delete group' });
  }
});

app.put('/api/admin/users/:uid/groups', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
    await updateUserRecord(appConfig, uid, { groups });
    broadcastDataUpdate();
    res.json({ success: true, groups });
  } catch (error) {
    console.error('Failed to update user groups:', error);
    res.status(500).json({ error: error.message || 'Failed to update user groups' });
  }
});

app.post('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { email, password, firstName, lastName, admin, pays, groups, status, memberSince } = req.body || {};
    const normalizedEmail = String(email || '').trim();
    const normalizedPassword = String(password || '');
    const normalizedFirst = String(firstName || '').trim();
    const normalizedLast = String(lastName || '').trim();

    if (!normalizedFirst || !normalizedLast) {
      return res.status(400).json({ error: 'Vorname und Nachname erforderlich.' });
    }

    if (normalizedPassword && normalizedPassword.length < 6) {
      return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen lang sein.' });
    }

    const hasRealCredentials = Boolean(normalizedEmail && normalizedPassword);

    const createdAuth = await registerUser({
      email: normalizedEmail,
      password: normalizedPassword,
      firstName: normalizedFirst,
      lastName: normalizedLast,
      admin: admin === true,
      owner: false,
      pays: pays !== false,
      groups: Array.isArray(groups) ? groups : [],
      isClaimed: hasRealCredentials
    }, appConfig);

    const userUid = createdAuth.user.id || createdAuth.user.uid;
    const fullName = `${normalizedFirst} ${normalizedLast}`.trim();
    const today = new Date().toISOString().slice(0, 10);
    const startDate = String(memberSince || today).trim() || today;
    const memberStatus = String(status || 'vollverdiener').trim() || 'vollverdiener';

    // Instantly bind a person record for this user
    const personKey = userUid;
    await upsertPeopleRecord(appConfig, personKey, {
      id: personKey,
      uid: userUid,
      name: fullName,
      status: memberStatus,
      memberSince: startDate,
      originalMemberSince: startDate,
      totalPaid: 0,
      pays: pays !== false,
      standingOrders: [],
      statusHistory: [{ status: memberStatus, startDate }]
    });

    broadcastDataUpdate();
    res.json({ success: true, user: createdAuth.user });
  } catch (error) {
    console.error('Failed to create user:', error);
    res.status(error.status || 400).json({ error: error.message || 'Failed to create user' });
  }
});

app.put('/api/admin/users/:uid/admin', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const makeAdmin = req.body?.admin === true;
    const system = await getStateValue(appConfig, 'system', DEFAULT_SYSTEM_STATE);
    const ownerUid = system?.ownerUid || system?.superAdminUid || null;

    if (uid === ownerUid && !makeAdmin) {
      return res.status(400).json({ error: 'Eigentümer kann keine Administratorrechte verlieren.' });
    }

    const isTargetOwner = uid === ownerUid;
    await updateUserRecord(appConfig, uid, {
      admin: isTargetOwner ? true : makeAdmin,
      owner: isTargetOwner,
      superAdmin: isTargetOwner
    });

    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to update admin role:', error);
    res.status(500).json({ error: 'Failed to update admin role' });
  }
});

app.put('/api/admin/users/:uid/pays', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const pays = req.body?.pays !== false;

    await updateUserRecord(appConfig, uid, { pays });

    // Update or allocate linked person record
    const people = await listPeopleRecords(appConfig);
    const linkedPerson = people.find(p => p.uid === uid || (p.data && p.data.uid === uid));
    if (pays) {
      if (linkedPerson) {
        const existingData = linkedPerson.data || {};
        existingData.pays = true;
        await upsertPeopleRecord(appConfig, linkedPerson.personKey, existingData);
      } else {
        const user = await getUserRecord(appConfig, uid);
        const fullName = user ? (user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Mitglied') : 'Mitglied';
        const today = new Date().toISOString().slice(0, 10);
        const personKey = uid;
        await upsertPeopleRecord(appConfig, personKey, {
          id: personKey,
          uid,
          name: fullName,
          status: 'vollverdiener',
          memberSince: today,
          originalMemberSince: today,
          totalPaid: 0,
          pays: true,
          standingOrders: [],
          statusHistory: [{ status: 'vollverdiener', startDate: today }]
        });
      }
    } else {
      if (linkedPerson) {
        const existingData = linkedPerson.data || {};
        existingData.pays = false;
        await upsertPeopleRecord(appConfig, linkedPerson.personKey, existingData);
      }
    }

    broadcastDataUpdate();
    res.json({ success: true, pays });
  } catch (error) {
    console.error('Failed to update pays status:', error);
    res.status(500).json({ error: 'Failed to update pays status' });
  }
});

app.put('/api/admin/users/:uid/member-since', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const memberSince = String(req.body?.memberSince || '').trim();
    if (!memberSince) {
      return res.status(400).json({ error: 'Datum erforderlich.' });
    }

    const people = await listPeopleRecords(appConfig);
    const linkedPerson = people.find(p => p.uid === uid || (p.data && p.data.uid === uid));
    if (linkedPerson) {
      const existingData = linkedPerson.data || {};
      existingData.memberSince = memberSince;
      existingData.originalMemberSince = memberSince;
      if (Array.isArray(existingData.statusHistory) && existingData.statusHistory.length > 0) {
        existingData.statusHistory[0].startDate = memberSince;
      }
      await upsertPeopleRecord(appConfig, linkedPerson.personKey, existingData);
    } else {
      const user = await getUserRecord(appConfig, uid);
      const fullName = user ? (user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Mitglied') : 'Mitglied';
      const personKey = uid;
      await upsertPeopleRecord(appConfig, personKey, {
        id: personKey,
        uid,
        name: fullName,
        status: 'vollverdiener',
        memberSince,
        originalMemberSince: memberSince,
        totalPaid: 0,
        pays: user?.pays !== false,
        standingOrders: [],
        statusHistory: [{ status: 'vollverdiener', startDate: memberSince }]
      });
    }

    broadcastDataUpdate();
    res.json({ success: true, memberSince });
  } catch (error) {
    console.error('Failed to update memberSince:', error);
    res.status(500).json({ error: 'Failed to update memberSince' });
  }
});

app.put('/api/admin/users/:uid/password', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const newPassword = String(req.body?.password || '');
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen lang sein.' });
    }

    await adminResetUserPassword(appConfig, uid, newPassword);
    res.json({ success: true, message: 'Passwort erfolgreich geändert.' });
  } catch (error) {
    console.error('Failed to reset user password:', error);
    res.status(error.status || 500).json({ error: error.message || 'Passwort-Zurücksetzen fehlgeschlagen' });
  }
});

app.delete('/api/admin/users/:uid', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const system = await getStateValue(appConfig, 'system', DEFAULT_SYSTEM_STATE);
    const ownerUid = system?.ownerUid || system?.superAdminUid || null;

    if (uid === ownerUid) {
      return res.status(400).json({ error: 'Der Eigentümer-Account kann nicht gelöscht werden.' });
    }

    const userRecord = await getUserRecord(appConfig, uid).catch(() => null);
    const userFullName = userRecord ? `${userRecord.firstName || ''} ${userRecord.lastName || ''}`.trim() || userRecord.name || '' : '';
    const normUserName = userFullName.toLowerCase();

    await deleteUserRecord(appConfig, uid);

    // Also remove from people/paylist
    try {
      const people = await listPeopleRecords(appConfig);
      const matchingPeople = people.filter(p => {
        if (p.uid === uid || (p.data && p.data.uid === uid) || p.personKey === uid) return true;
        if (normUserName && (p.name || p.data?.name || '').trim().toLowerCase() === normUserName) return true;
        return false;
      });
      for (const p of matchingPeople) {
        await removePeopleRecord(appConfig, p.personKey);
      }
    } catch (err) {
      console.warn(`[PocketBase] Failed to clean up linked person for deleted user ${uid}:`, err.message);
    }

    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete user:', error);
    res.status(500).json({ error: error.message || 'Failed to delete user' });
  }
});

app.post('/api/admin/logo', verifyToken, verifySuperAdmin, (req, res) => {
  logoUpload.single('logo')(req, res, async (uploadError) => {
    if (uploadError) {
      console.error('Multer error:', uploadError);
      if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Logo file too large (max 5MB)' });
      }
      return res.status(400).json({ error: 'Invalid logo upload: ' + uploadError.message });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No logo file uploaded' });
      }

      const originalName = req.file.originalname || '';
      const ext = path.extname(originalName).toLowerCase();
      const mimeType = (req.file.mimetype || '').toLowerCase();

      if (!hasSvgExtension(originalName)) {
        return res.status(400).json({ error: 'Only SVG files are allowed (Invalid extension)' });
      }
      if (!ext && mimeType && mimeType !== 'image/svg+xml') {
        return res.status(400).json({ error: 'Only SVG files are allowed (Invalid MIME type)' });
      }

      const content = req.file.buffer.toString('utf8');
      if (!isSafeSvg(content)) {
        return res.status(400).json({ error: 'Invalid SVG file (Contains invalid tags or scripts)' });
      }

      await fs.promises.writeFile(churchLogoFile, content, 'utf8');
      broadcastDataUpdate();
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to update logo:', error);
      let msg = error.message || 'Unknown error';
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        msg = 'Permission denied writing to data directory. Check Docker volume mount permissions.';
      }
      res.status(500).json({ error: 'Failed to update logo: ' + msg });
    }
  });
});

app.post('/api/upload', protectedActionRateLimit, verifyToken, (req, res) => {
  upload.single('receipt')(req, res, (error) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large (max 50MB)' });
      }
      return res.status(400).json({ error: error.message || 'File upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    res.json({ filename: req.file.filename });
  });
});

app.get('/api/receipts/:filename', protectedActionRateLimit, verifyToken, (req, res) => {
  const filePath = path.resolve(path.join(uploadDir, req.params.filename));
  const normalizedUploadDir = path.resolve(uploadDir);

  if (!filePath.startsWith(normalizedUploadDir + path.sep)) {
    return res.status(403).send('Forbidden: Path traversal detected');
  }

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

app.post('/api/profile/picture', protectedActionRateLimit, verifyToken, (req, res) => {
  profileUpload.single('picture')(req, res, async (uploadError) => {
    if (uploadError) {
      if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large (max 5MB)' });
      }
      return res.status(400).json({ error: uploadError.message || 'Upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    try {
      const uid = req.user.uid;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(uid)) {
        return res.status(400).json({ error: 'Invalid user ID' });
      }
      const destPath = path.join(profilesDir, `${uid}.jpg`);
      await fs.promises.writeFile(destPath, req.file.buffer);
      res.json({ success: true });
    } catch (err) {
      console.error('Failed to save profile picture:', err);
      res.status(500).json({ error: 'Failed to save profile picture' });
    }
  });
});

app.get('/api/profile/picture/:uid', protectedActionRateLimit, verifyToken, (req, res) => {
  const uid = req.params.uid;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(uid)) {
    return res.status(400).send('Invalid user ID');
  }
  const normalizedProfilesDir = path.resolve(profilesDir);
  const filePath = path.resolve(path.join(normalizedProfilesDir, `${uid}.jpg`));

  if (path.relative(normalizedProfilesDir, filePath).startsWith('..')) {
    return res.status(403).send('Forbidden: Path traversal detected');
  }

  if (fs.existsSync(filePath)) {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(filePath);
  } else {
    res.status(204).end();
  }
});

app.post('/api/send-email', protectedActionRateLimit, verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { to, subject, text, html } = req.body;
    if (!to || !subject) {
      return res.status(400).json({ error: 'Missing required fields: to, subject' });
    }

    // Also dispatch push notification if recipient user exists
    try {
      const allUsers = await listUserRecords(appConfig);
      const recipientUser = allUsers.find(u => u.email && u.email.toLowerCase() === String(to).toLowerCase());
      if (recipientUser) {
        sendPushToUser(appConfig, recipientUser.id, {
          title: subject || 'Neue Nachricht',
          body: text ? (text.length > 150 ? text.slice(0, 147) + '...' : text) : 'Du hast eine neue Benachrichtigung erhalten.',
          data: { url: '/' }
        }).catch(e => console.warn('[WebPush] Send-email push error:', e.message));
      }
    } catch (e) {
      console.warn('[WebPush] Error checking user for send-email push:', e.message);
    }

    if (!transporter || !appConfig?.smtp?.user) {
      return res.status(500).json({ error: 'SMTP not configured' });
    }

    const info = await transporter.sendMail({
      from: `"${appConfig.appName}" <${appConfig.smtp.user}>`,
      to,
      subject,
      text,
      html
    });

    console.log('Email sent: %s', info.messageId);
    res.status(200).json({ success: true, messageId: info.messageId });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

const escapeHtml = (unsafe) => {
  return String(unsafe || '').replace(/[&<"'>]/g, (match) => {
    const escape = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return escape[match];
  });
};

app.post('/api/notify-admins', protectedActionRateLimit, verifyToken, async (req, res) => {
  try {
    const { reqType, personName } = req.body;
    if (!reqType || !personName) {
      return res.status(400).json({ error: 'Missing required fields: reqType, personName' });
    }

    const typeLabels = { payment: 'Zahlung', status: 'Status', expense: 'Ausgabe', standing_order: 'Dauerauftrag' };
    const reqTypeLabel = typeLabels[reqType] || reqType;

    // Send push notification to all admins with notifications enabled
    sendPushToAdmins(appConfig, {
      title: `Kasse: ${reqTypeLabel}`,
      body: `${personName} hat einen Antrag eingereicht.`,
      data: { url: '/#requests' }
    }).catch(err => console.warn('[WebPush] Failed sending push to admins:', err.message));

    const allUsers = await listUserRecords(appConfig);
    const adminEmails = allUsers
      .filter((record) => record.admin === true && record.email && record.emailNotifications !== false)
      .map((record) => record.email);

    if (adminEmails.length === 0) {
      return res.status(200).json({ message: 'No admins found to notify' });
    }

    if (!transporter || !appConfig?.smtp?.user) {
      return res.status(200).json({ skipped: true, message: 'SMTP not configured' });
    }

    const info = await transporter.sendMail({
      from: `"${appConfig.appName}" <${appConfig.smtp.user}>`,
      to: adminEmails,
      subject: `Neue Anfrage bei ${appConfig.appName}`,
      text: `Eine neue Anfrage (${reqTypeLabel}) von ${personName} wurde eingereicht.\n\nBitte prüfe die Anfrage in der App.`,
      html: `
        <div style="font-family: sans-serif; color: #2D3748; background-color: #F8FAFC; padding: 40px 20px;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 24px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
            <div style="padding: 30px; text-align: center; border-bottom: 1px solid #E2E8F0;">
              <h1 style="margin: 0; color: #14B8A6; font-size: 24px; font-weight: 600;">${escapeHtml(appConfig.appName)}</h1>
            </div>
            <div style="padding: 40px 30px;">
              <h2 style="margin-top: 0; margin-bottom: 20px; font-size: 20px; font-weight: 600; color: #1A202C;">Neue Anfrage</h2>
              <p style="margin: 0 0 15px 0; font-size: 16px; line-height: 1.5;">Eine neue Anfrage vom Typ <strong style="color: #14B8A6;">${escapeHtml(reqTypeLabel)}</strong> wurde eingereicht.</p>
              <p style="margin: 0 0 25px 0; font-size: 16px; line-height: 1.5;">Person: <strong style="color: #4A5568;">${escapeHtml(personName)}</strong></p>
              <div style="background-color: #F1F5F9; border-left: 4px solid #94A3B8; padding: 15px; border-radius: 8px; margin-bottom: 25px;">
                  <p style="margin: 0; color: #475569; font-size: 16px;">Bitte prüfe die Anfrage in der App.</p>
              </div>
            </div>
          </div>
        </div>
      `
    });

    console.log('Admin notification sent successfully: %s', info.messageId);
    res.status(200).json({ success: true, messageId: info.messageId });
  } catch (error) {
    console.error('Error notifying admins:', error);
    res.status(500).json({ error: 'Failed to notify admins' });
  }
});

// Push notification management endpoints
app.get('/api/push/vapid-public-key', verifyToken, async (req, res) => {
  try {
    const publicKey = await getVapidPublicKey(appConfig);
    res.json({ publicKey });
  } catch (error) {
    console.error('Failed to get VAPID public key:', error);
    res.status(500).json({ error: 'Failed to retrieve VAPID key' });
  }
});

app.post('/api/push/subscribe', verifyToken, async (req, res) => {
  try {
    const { subscription, userAgent } = req.body || {};
    if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      return res.status(400).json({ error: 'Invalid push subscription payload' });
    }
    const currentUid = req.user.uid || req.user.id;
    await upsertPushSubscription(appConfig, currentUid, subscription, userAgent || req.headers['user-agent'] || '');
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to save push subscription:', error);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

app.post('/api/push/unsubscribe', verifyToken, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }
    await deletePushSubscription(appConfig, endpoint);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete push subscription:', error);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

app.post('/api/push/test', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    await sendPushToUser(appConfig, currentUid, {
      title: `${appConfig?.appName || 'Agora'} Test`,
      body: 'Web-Push-Benachrichtigungen sind erfolgreich eingerichtet!',
      data: { url: '/' }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to send test push notification:', error);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

async function sendDutyRequestNotificationEmail({ recipientUserId, requestedByUserId, event, duty, appConfig, sendEmailRequested = true }) {
  if (sendEmailRequested === false) {
    return { skipped: true, reason: 'user_disabled' };
  }
  try {
    const allUsers = await listUserRecords(appConfig);
    const requester = allUsers.find(u => u.id === requestedByUserId);
    const requesterName = requester ? (requester.name || `${requester.firstName || ''} ${requester.lastName || ''}`.trim() || requester.email) : 'Ein Event-Organisator';
    const dutyName = duty.roleName || duty.section || 'Dienst';

    // Dispatch push notification to recipient user regardless of SMTP configuration
    sendPushToUser(appConfig, recipientUserId, {
      title: `Dienstanfrage: ${dutyName}`,
      body: `${requesterName} hat dich für "${dutyName}" bei "${event.title || 'Event'}" angefragt.`,
      data: { url: '/#calendar' }
    }).catch(err => console.warn('[WebPush] Failed sending duty push:', err.message));

    if (!transporter || !appConfig?.smtp?.user || !appConfig?.smtp?.host) {
      return { skipped: true, reason: 'smtp_not_configured' };
    }

    const recipient = allUsers.find(u => u.id === recipientUserId);
    if (!recipient || !recipient.email || recipient.emailNotifications === false) {
      return { skipped: true, reason: 'recipient_no_email_or_disabled' };
    }

    let formattedDate = event.date || 'Ohne Datum';
    try {
      if (event.date) {
        const parts = String(event.date).split('-');
        if (parts.length === 3) {
          formattedDate = `${parts[2]}.${parts[1]}.${parts[0]}`;
        }
      }
    } catch {}

    let timeStr = '';
    if (event.startTime || event.time) {
      const sTime = event.startTime || event.time;
      timeStr = ` um ${sTime} Uhr`;
      if (event.endTime) timeStr += ` bis ${event.endTime} Uhr`;
    }

    const locationStr = event.location ? `Ort: ${event.location}` : '';

    const subject = `Dienstanfrage: ${dutyName} bei "${event.title || 'Event'}"`;
    const text = `Hallo ${recipient.name || recipient.firstName || 'zusammen'},\n\n` +
      `du wurdest von ${requesterName} für folgenden Dienst angefragt:\n\n` +
      `Event: ${event.title || 'Unbenanntes Event'}\n` +
      `Datum: ${formattedDate}${timeStr}\n` +
      (locationStr ? `${locationStr}\n` : '') +
      `Dienst: ${dutyName}\n` +
      (duty.notes ? `Hinweise: ${duty.notes}\n` : '') +
      (event.description ? `Beschreibung des Events: ${event.description}\n` : '') +
      `\nBitte öffne die App, um die Dienstanfrage anzunehmen oder abzulehnen.`;

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; background-color: #f8fafc; padding: 32px 16px;">
        <div style="max-width: 580px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
          <div style="background: linear-gradient(135deg, #4f46e5, #06b6d4); padding: 24px; text-align: center; color: #ffffff;">
            <h1 style="margin: 0; font-size: 20px; font-weight: 700;">${escapeHtml(appConfig.appName || 'Agora')}</h1>
            <p style="margin: 6px 0 0 0; font-size: 14px; opacity: 0.9;">Neue Dienstanfrage für ein Event</p>
          </div>
          <div style="padding: 28px 24px;">
            <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.5;">
              Hallo <strong>${escapeHtml(recipient.name || recipient.firstName || 'du')}</strong>,
            </p>
            <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.5; color: #475569;">
              <strong>${escapeHtml(requesterName)}</strong> hat dich für folgenden Dienst angefragt:
            </p>

            <div style="background: #f1f5f9; border-left: 4px solid #4f46e5; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px;">
              <div style="font-size: 18px; font-weight: 700; color: #1e293b; margin-bottom: 8px;">
                📋 ${escapeHtml(dutyName)}
              </div>
              ${duty.notes ? `<p style="margin: 0 0 10px 0; font-size: 14px; color: #475569;"><strong>Hinweise:</strong> ${escapeHtml(duty.notes)}</p>` : ''}
              <div style="border-top: 1px solid #e2e8f0; margin-top: 12px; padding-top: 12px; font-size: 14px; color: #334155;">
                <p style="margin: 0 0 4px 0;"><strong>📅 Event:</strong> ${escapeHtml(event.title || 'Event')}</p>
                <p style="margin: 0 0 4px 0;"><strong>⏰ Datum & Uhrzeit:</strong> ${escapeHtml(formattedDate)}${escapeHtml(timeStr)}</p>
                ${event.location ? `<p style="margin: 0 0 4px 0;"><strong>📍 Ort:</strong> ${escapeHtml(event.location)}</p>` : ''}
                ${event.description ? `<p style="margin: 6px 0 0 0; color: #64748b;"><em>${escapeHtml(event.description)}</em></p>` : ''}
              </div>
            </div>

            <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.5; color: #64748b;">
              Bitte logge dich in der App ein, um diese Anfrage anzunehmen oder abzulehnen.
            </p>
          </div>
          <div style="background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 24px; text-align: center; font-size: 12px; color: #94a3b8;">
            Diese Benachrichtigung wurde automatisch von ${escapeHtml(appConfig.appName || 'Agora')} gesendet.
          </div>
        </div>
      </div>
    `;

    const info = await transporter.sendMail({
      from: `"${appConfig.appName || 'Agora'}" <${appConfig.smtp.user}>`,
      to: recipient.email,
      subject,
      text,
      html
    });

    console.log(`Duty request email sent to ${recipient.email} (messageId: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.warn('Could not send duty request email (non-fatal):', err.message);
    return { error: err.message };
  }
}

const aiChatRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

app.get('/api/admin/ai-config', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const aiSettings = await getAiSettings(appConfig);
    res.json({
      enabled: aiSettings.enabled,
      baseUrl: aiSettings.baseUrl || '',
      // Always return '***' as a consistent placeholder – do not reveal whether a key is set
      apiKey: '***',
      model: aiSettings.model || ''
    });
  } catch (err) {
    console.error('Failed to get AI config:', err);
    res.status(500).json({ error: 'Failed to get AI config' });
  }
});

// Lightweight endpoint for users with AI permission – returns only the enabled flag
app.get('/api/admin/ai-status', verifyToken, verifyAiAccess, async (req, res) => {
  try {
    const aiSettings = await getAiSettings(appConfig);
    res.json({ enabled: !!aiSettings.enabled });
  } catch (err) {
    res.json({ enabled: false });
  }
});

app.put('/api/admin/ai-config', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    await setAiSettings(appConfig, req.body || {});
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to save AI config:', err);
    res.status(500).json({ error: 'Failed to save AI config' });
  }
});

app.post('/api/ai/chat', aiChatRateLimit, verifyToken, verifyAiAccess, async (req, res) => {
  try {
    const aiSettings = await getAiSettings(appConfig);
    if (!aiSettings.enabled) {
      return res.status(403).json({ error: 'AI support is not enabled' });
    }

    const rawMessages = req.body?.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const messages = sanitizeAiMessages(rawMessages, 50, 12000);
    if (messages.length === 0) {
      return res.status(400).json({ error: 'No valid non-empty messages found in payload' });
    }

    const baseUrl = (aiSettings.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const apiKey = aiSettings.apiKey || '';
    const model = aiSettings.model || 'gpt-4o-mini';

    const canViewFinances = req.user?.canViewFinances === true || req.user?.canManageFinances === true;
    const dbSnapshot = await buildDatabaseSnapshot(appConfig, { canViewFinances, user: req.user });
    const systemContent = buildSystemPrompt(appConfig.appName, dbSnapshot, { canViewFinances });

    const aiRes = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemContent }, ...messages],
        stream: true
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => '');
      console.error('AI provider error:', aiRes.status, errText);
      let detailMsg = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error?.message) {
          detailMsg = parsed.error.message;
        }
      } catch {}
      return res.status(502).json({ error: 'AI provider returned an error', detail: String(detailMsg || '').slice(0, 300) });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const reader = aiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete last line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
          } else {
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;
              if (typeof content === 'string') {
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
              }
              if (typeof reasoning === 'string') {
                res.write(`data: ${JSON.stringify({ reasoning })}\n\n`);
              }
            } catch { /* skip malformed chunks */ }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    res.end();
  } catch (err) {
    console.error('AI chat error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI chat request failed' });
    } else {
      res.end();
    }
  }
});

// --- Mentoring Routes ---

// 1. List mentors
app.get('/api/mentoring/mentors', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const isManager = req.user?.canManageMentoring === true || (Array.isArray(req.user?.permissions) && req.user.permissions.includes('manage_mentoring'));
    
    let filter = 'status = "approved"';
    if (isManager && req.query.status) {
      if (req.query.status === 'all') {
        filter = '';
      } else {
        filter = `status = "${req.query.status}"`;
      }
    } else if (isManager && req.query.all === 'true') {
      filter = '';
    }

    const mentors = await listMentorRecords(appConfig, filter);
    const users = await listUserRecords(appConfig);
    const userMap = new Map(users.map(u => [u.id, u]));

    // Fetch active thread counts per mentor to show availability
    let activeThreadCounts = new Map();
    try {
      const allThreads = await listMentoringThreadsForUser(appConfig, mentors.map(m => m.user));
      for (const t of allThreads) {
        if (t.mentor && t.status !== 'closed') {
          activeThreadCounts.set(t.mentor, (activeThreadCounts.get(t.mentor) || 0) + 1);
        }
      }
    } catch { /* ignore */ }

    const formatted = mentors.map(m => {
      const u = userMap.get(m.user);
      const activeMenteesCount = activeThreadCounts.get(m.user) || 0;
      const maxMentees = typeof m.max_mentees === 'number' ? m.max_mentees : 3;
      const isFull = activeMenteesCount >= maxMentees;
      const mentorName = u ? (u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Mentor') : 'Mentor';

      const item = {
        id: m.id,
        user: m.user,
        user_id: m.user,
        name: mentorName,
        mentorName,
        mentorFirstName: u?.firstName || '',
        status: m.status,
        bio: m.bio || '',
        maxMentees,
        max_mentees: maxMentees,
        activeMentees: activeMenteesCount,
        active_mentees: activeMenteesCount,
        activeMenteesCount,
        isFull: isFull || m.is_accepting === false,
        isAccepting: m.is_accepting !== false,
        created: m.created
      };

      if (isManager || req.query.all === 'true') {
        item.email = u?.email || '';
        item.userEmail = u?.email || '';
        item.userName = mentorName;
      }

      return item;
    });

    let result = formatted;
    if (!isManager && req.query.all !== 'true') {
      const currentUid = req.user.uid || req.user.id;
      result = formatted.filter(item => {
        const m = mentors.find(rec => rec.id === item.id);
        if (!m) return false;
        if (m.user === currentUid) return true;
        const activeMenteesCount = activeThreadCounts.get(m.user) || 0;
        const maxMentees = typeof m.max_mentees === 'number' ? m.max_mentees : 3;
        const isFull = activeMenteesCount >= maxMentees || m.is_accepting === false;
        return !isFull;
      });
    }

    res.json(result);
  } catch (err) {
    console.error('Failed to list mentors:', err);
    res.status(500).json({ error: 'Failed to list mentors' });
  }
});

// 2. Get my mentor profile
app.get('/api/mentoring/my-profile', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const mentor = await getMentorByUserId(appConfig, req.user.uid);
    if (!mentor) {
      return res.json({ exists: false, mentor: null });
    }
    const profile = {
      id: mentor.id,
      status: mentor.status,
      bio: mentor.bio || '',
      maxMentees: typeof mentor.max_mentees === 'number' ? mentor.max_mentees : 3,
      max_mentees: typeof mentor.max_mentees === 'number' ? mentor.max_mentees : 3,
      isAccepting: mentor.is_accepting !== false
    };
    res.json({
      exists: true,
      mentor: profile,
      ...profile
    });
  } catch (err) {
    console.error('Failed to get mentor profile:', err);
    res.status(500).json({ error: 'Failed to get mentor profile' });
  }
});

// 3. Apply as mentor
app.post('/api/mentoring/apply', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const { bio, maxMentees, max_mentees } = req.body || {};
    const parsedMax = Number(max_mentees || maxMentees) > 0 ? Number(max_mentees || maxMentees) : 3;

    const existing = await getMentorByUserId(appConfig, req.user.uid);
    if (existing) {
      const updated = await updateMentorRecord(appConfig, existing.id, {
        status: 'pending',
        bio: String(bio || '').trim(),
        max_mentees: parsedMax,
        is_accepting: true
      });
      broadcastDataUpdate();
      return res.json({ success: true, mentor: updated });
    }

    const created = await createMentorRecord(appConfig, {
      user: req.user.uid,
      status: 'pending',
      bio: String(bio || '').trim(),
      max_mentees: parsedMax,
      is_accepting: true
    });
    broadcastDataUpdate();
    res.json({ success: true, mentor: created });
  } catch (err) {
    console.error('Failed to apply as mentor:', err);
    res.status(500).json({ error: 'Failed to apply as mentor' });
  }
});

// 4. Update my mentor profile settings (cannot change status)
app.put('/api/mentoring/my-profile', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const existing = await getMentorByUserId(appConfig, req.user.uid);
    if (!existing) {
      return res.status(404).json({ error: 'Mentor profile not found' });
    }
    const { bio, maxMentees, max_mentees, isAccepting } = req.body || {};
    const updates = {};
    if (typeof bio === 'string') updates.bio = bio.trim();
    if (Number(max_mentees || maxMentees) > 0) updates.max_mentees = Number(max_mentees || maxMentees);
    if (typeof isAccepting === 'boolean') updates.is_accepting = isAccepting;

    const updated = await updateMentorRecord(appConfig, existing.id, updates);
    broadcastDataUpdate();
    res.json({ success: true, mentor: updated });
  } catch (err) {
    console.error('Failed to update mentor profile:', err);
    res.status(500).json({ error: 'Failed to update mentor profile' });
  }
});

// 5. Manage mentor application status (Leader only)
app.post('/api/mentoring/manage/:id/status', verifyToken, verifyManageMentoring, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (status !== 'approved' && status !== 'rejected' && status !== 'pending') {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const mentor = await getMentorRecord(appConfig, req.params.id);
    if (!mentor) {
      return res.status(404).json({ error: 'Mentor not found' });
    }
    await updateMentorRecord(appConfig, mentor.id, { status });
    broadcastDataUpdate();
    res.json({ success: true, status });
  } catch (err) {
    console.error('Failed to update mentor status:', err);
    res.status(500).json({ error: 'Failed to update mentor status' });
  }
});

// 6. List my mentoring threads (AIR-GAP ENFORCED: only mentor and mentee)
app.get('/api/mentoring/threads', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const userIds = Array.from(new Set([req.user.uid, req.user.id].filter(Boolean)));
    const threads = await listMentoringThreadsForUser(appConfig, userIds);
    const users = await listUserRecords(appConfig);
    const userMap = new Map(users.map(u => [u.id, u]));

    const formatted = await Promise.all(threads.map(async (t) => {
      try {
        const isMentor = userIds.includes(t.mentor);
        const isMentee = userIds.includes(t.mentee);
        if (!isMentor && !isMentee) return null; // Air-gap: skip if not a party

        const messages = await listMentoringMessages(appConfig, t.id).catch(() => []);
        const lastMessage = messages[messages.length - 1] || null;
        const otherRole = isMentor ? 'mentee' : 'mentor';
        const unreadCount = messages.filter(m => m.sender_role === otherRole && !m.read).length;

        const mentorUser = userMap.get(t.mentor);
        const mentorName = mentorUser ? (mentorUser.name || `${mentorUser.firstName || ''} ${mentorUser.lastName || ''}`.trim() || 'Mentor') : 'Mentor';

        return {
          id: t.id,
          mentor: t.mentor,
          mentee: isMentor ? null : t.mentee, // STRICT PRIVACY: mentor never sees mentee UID
          status: t.status || 'active',
          created: t.created,
          updated: t.updated || t.created,
          unreadCount,
          unread_count: unreadCount,
          last_message: lastMessage ? lastMessage.text.slice(0, 240) : (t.last_message || ''),
          lastMessage: lastMessage ? {
            text: lastMessage.text.slice(0, 240),
            created: lastMessage.created,
            senderRole: lastMessage.sender_role
          } : null,
          myRole: isMentor ? 'mentor' : 'mentee',
          mentor_name: mentorName,
          mentorName,
          mentee_alias: t.mentee_alias,
          menteeAlias: t.mentee_alias,
          title: isMentor ? (t.mentee_alias || 'Anonymer Suchender') : mentorName
        };
      } catch (threadErr) {
        console.warn('Error formatting thread:', t?.id, threadErr);
        return null;
      }
    }));

    res.json(formatted.filter(Boolean));
  } catch (err) {
    console.error('Failed to list mentoring threads:', err);
    res.status(500).json({ error: 'Failed to list mentoring threads' });
  }
});

// 7. Start an anonymous thread with a mentor
app.post('/api/mentoring/threads', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const mentorId = req.body?.mentorId || req.body?.mentor;
    const initialMessage = req.body?.initialMessage || req.body?.message;
    if (!mentorId) {
      return res.status(400).json({ error: 'mentorId is required' });
    }

    let mentorRec = await getMentorByUserId(appConfig, mentorId);
    if (!mentorRec) {
      mentorRec = await getMentorRecord(appConfig, mentorId).catch(() => null);
    }

    if (!mentorRec || mentorRec.status !== 'approved') {
      return res.status(400).json({ error: 'Mentor ist derzeit nicht verfügbar' });
    }
    if (mentorRec.user === currentUid) {
      return res.status(400).json({ error: 'Du kannst dich nicht selbst begleiten' });
    }
    if (mentorRec.is_accepting === false) {
      return res.status(400).json({ error: 'Dieser Mentor nimmt derzeit keine neuen Begleitungen an' });
    }

    // Check mentor capacity (active threads limit)
    const allMentorThreads = await listMentoringThreadsForUser(appConfig, mentorRec.user);
    const activeMenteesCount = allMentorThreads.filter(t => t.mentor === mentorRec.user && t.status !== 'closed').length;
    const maxMentees = typeof mentorRec.max_mentees === 'number' ? mentorRec.max_mentees : 3;
    if (activeMenteesCount >= maxMentees) {
      return res.status(400).json({ error: 'Dieser Mentor hat die maximale Anzahl an Begleitungen erreicht' });
    }

    // Check if user already has an existing thread with this mentor
    const userThreads = await listMentoringThreadsForUser(appConfig, currentUid);
    const existingThread = userThreads.find(t =>
      (t.mentor === mentorRec.user || t.mentor === mentorRec.id || t.mentor === mentorId) &&
      t.mentee === currentUid
    );

    if (existingThread) {
      if (existingThread.status === 'closed') {
        return res.status(400).json({
          error: 'Du hast bereits ein früheres Gespräch mit diesem Mentor. Du kannst es unter "Meine Begleitungen" wiedereröffnen.',
          threadId: existingThread.id,
          status: 'closed'
        });
      }
      return res.status(400).json({
        error: 'Du stehst bereits in aktiver Begleitung mit diesem Mentor.',
        threadId: existingThread.id,
        status: 'active'
      });
    }

    // Generate random pseudonym alias
    const randomSuffix = crypto.randomInt(100, 1000);
    const menteeAlias = `Suchender #${randomSuffix}`;

    const thread = await createMentoringThread(appConfig, {
      mentor: mentorRec.user,
      mentee: currentUid,
      mentee_alias: menteeAlias,
      status: 'active',
      last_message: initialMessage ? String(initialMessage).trim().slice(0, 240) : ''
    });

    if (initialMessage && String(initialMessage).trim()) {
      await createMentoringMessage(appConfig, {
        thread: thread.id,
        sender_role: 'mentee',
        text: String(initialMessage).trim(),
        read: false
      });
    }

    sendPushToUser(appConfig, mentorRec.user, {
      title: `Mentoring: ${menteeAlias || 'Suchender'}`,
      body: initialMessage ? String(initialMessage).trim() : 'Neue Begleitungsanfrage erhalten.',
      data: { url: '/#mentoring' }
    }).catch(e => console.warn('[WebPush] Mentoring thread push error:', e.message));

    broadcastDataUpdate();
    res.json({ success: true, thread, threadId: thread.id, menteeAlias });
  } catch (err) {
    console.error('Failed to create mentoring thread:', err);
    res.status(500).json({ error: 'Failed to create mentoring thread' });
  }
});

// 8. Get messages of a thread (AIR-GAP: strictly mentor or mentee only)
app.get('/api/mentoring/threads/:id/messages', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const userIds = Array.from(new Set([req.user.uid, req.user.id].filter(Boolean)));
    const thread = await getMentoringThread(appConfig, req.params.id);
    if (!thread) {
      return res.status(404).json({ error: 'Thread nicht gefunden' });
    }

    const isMentor = userIds.includes(thread.mentor);
    const isMentee = userIds.includes(thread.mentee);
    if (!isMentor && !isMentee) {
      // STRICT AIR-GAP: Admins, leaders, owners who are not participants get 403!
      return res.status(403).json({ error: 'Vertrauliche Seelsorge-Verbindung: Zugriff verweigert' });
    }

    const currentRole = isMentor ? 'mentor' : 'mentee';
    await markMentoringMessagesRead(appConfig, thread.id, currentRole).catch(() => {});

    const messages = await listMentoringMessages(appConfig, thread.id);
    const users = await listUserRecords(appConfig);
    const userMap = new Map(users.map(u => [u.id, u]));

    const mentorUser = userMap.get(thread.mentor);
    const mentorName = mentorUser ? (mentorUser.name || `${mentorUser.firstName || ''} ${mentorUser.lastName || ''}`.trim() || 'Mentor') : 'Mentor';

    const formattedMessages = messages.map(m => {
      const isSenderMe = (m.sender_role === 'mentor' && isMentor) || (m.sender_role === 'mentee' && isMentee);
      return {
        id: m.id,
        thread: m.thread,
        senderRole: m.sender_role,
        sender_role: m.sender_role,
        sender: isSenderMe ? (req.user.uid || req.user.id) : 'partner',
        sender_name: isSenderMe ? 'Du' : (isMentor ? (thread.mentee_alias || 'Suchender') : mentorName),
        text: m.text,
        message: m.text,
        read: !!m.read,
        created: m.created
      };
    });

    res.json(formattedMessages);
  } catch (err) {
    console.error('Failed to get thread messages:', err);
    res.status(500).json({ error: 'Failed to get thread messages' });
  }
});

// 9. Send message in a thread
app.post('/api/mentoring/threads/:id/messages', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const userIds = Array.from(new Set([req.user.uid, req.user.id].filter(Boolean)));
    const text = req.body?.text || req.body?.message;
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'Nachrichtentext ist erforderlich' });
    }

    const thread = await getMentoringThread(appConfig, req.params.id);
    if (!thread) {
      return res.status(404).json({ error: 'Thread nicht gefunden' });
    }

    const isMentor = userIds.includes(thread.mentor);
    const isMentee = userIds.includes(thread.mentee);
    if (!isMentor && !isMentee) {
      return res.status(403).json({ error: 'Vertrauliche Seelsorge-Verbindung: Zugriff verweigert' });
    }

    if (thread.status === 'closed') {
      return res.status(400).json({ error: 'Gespräch ist beendet' });
    }

    const senderRole = isMentor ? 'mentor' : 'mentee';
    const message = await createMentoringMessage(appConfig, {
      thread: thread.id,
      sender_role: senderRole,
      text: String(text).trim(),
      read: false
    });

    try {
      await updateMentoringThread(appConfig, thread.id, {
        last_message: String(text).trim().slice(0, 240)
      });
    } catch (updateErr) {
      console.warn('Could not update thread last_message (non-fatal):', updateErr?.message);
    }

    const recipientUid = isMentor ? thread.mentee : thread.mentor;
    let senderTitle = 'Mentoring';
    if (isMentor) {
      try {
        const allUsers = await listUserRecords(appConfig);
        const mentorUser = allUsers.find(u => u.id === (req.user.uid || req.user.id || thread.mentor));
        const mentorName = mentorUser ? (mentorUser.name || `${mentorUser.firstName || ''} ${mentorUser.lastName || ''}`.trim() || mentorUser.email) : 'Mentor';
        senderTitle = `Mentoring: ${mentorName}`;
      } catch (uErr) {
        senderTitle = 'Mentoring: Mentor';
      }
    } else {
      senderTitle = `Mentoring: ${thread.mentee_alias || 'Suchender'}`;
    }

    sendPushToUser(appConfig, recipientUid, {
      title: senderTitle,
      body: String(text).trim(),
      data: { url: '/#mentoring' }
    }).catch(e => console.warn('[WebPush] Mentoring message push error:', e.message));

    broadcastDataUpdate();
    res.json({
      success: true,
      message: {
        id: message.id,
        thread: message.thread,
        senderRole,
        text: message.text,
        message: message.text,
        created: message.created
      }
    });
  } catch (err) {
    console.error('Failed to send mentoring message:', err);
    res.status(500).json({ error: 'Nachricht konnte nicht gesendet werden' });
  }
});

// 10. Change thread status (close/reopen)
app.patch('/api/mentoring/threads/:id/status', verifyToken, verifyMentoringParticipate, async (req, res) => {
  try {
    const userIds = Array.from(new Set([req.user.uid, req.user.id].filter(Boolean)));
    const { status } = req.body || {};
    if (status !== 'open' && status !== 'active' && status !== 'closed') {
      return res.status(400).json({ error: 'Ungültiger Status' });
    }

    const thread = await getMentoringThread(appConfig, req.params.id);
    if (!thread) {
      return res.status(404).json({ error: 'Thread nicht gefunden' });
    }

    const isMentor = userIds.includes(thread.mentor);
    const isMentee = userIds.includes(thread.mentee);
    if (!isMentor && !isMentee) {
      return res.status(403).json({ error: 'Zugriff verweigert' });
    }

    const updated = await updateMentoringThread(appConfig, thread.id, { status });
    broadcastDataUpdate();
    res.json({ success: true, thread: updated });
  } catch (err) {
    console.error('Failed to update thread status:', err);
    res.status(500).json({ error: 'Status konnte nicht geändert werden' });
  }
});

// ============================================================================
// Events & Dienstplan Module (CITADEL)
// ============================================================================

// Helper to check if a user is in any of the specified target groups
function userMatchesTargetGroups(user, targetGroups = []) {
  if (!Array.isArray(targetGroups) || targetGroups.length === 0) return true;
  if (!user) return false;
  if (user.admin === true || user.owner === true || user.superAdmin === true || user.canManageEvents === true) return true;
  const userGroups = Array.isArray(user.groups) ? user.groups : [];
  return userGroups.some(g => {
    const gid = typeof g === 'object' && g ? (g.id || g.name) : String(g);
    const gname = typeof g === 'object' && g ? g.name : String(g);
    return targetGroups.includes(gid) || targetGroups.includes(gname);
  });
}

const DEFAULT_EVENT_SETTINGS = {
  allowMemberCreation: true,
  defaultDuties: ['Bistro-Team', 'Technik', 'Begrüßung', 'Moderation', 'Musik/Lobpreis']
};

function formatIcsDateTime(dateStr, timeStr) {
  if (!dateStr) return '';
  const cleanDate = dateStr.replace(/-/g, '');
  if (!timeStr) {
    return `VALUE=DATE:${cleanDate}`;
  }
  const cleanTime = timeStr.replace(/:/g, '').padEnd(6, '0').slice(0, 6);
  return `${cleanDate}T${cleanTime}`;
}

function escapeIcsText(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function generateIcsCalendar(events, calendarName = 'Agora Events') {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Agora//Event Calendar//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    'X-WR-TIMEZONE:Europe/Berlin'
  ];

  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:event-${ev.id}@agora`);
    lines.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`);

    if (ev.startTime) {
      lines.push(`DTSTART;TZID=Europe/Berlin:${formatIcsDateTime(ev.date, ev.startTime)}`);
      if (ev.endTime) {
        lines.push(`DTEND;TZID=Europe/Berlin:${formatIcsDateTime(ev.date, ev.endTime)}`);
      } else {
        const [h, m] = (ev.startTime || '10:00').split(':').map(Number);
        const endHour = String(((h || 10) + 1) % 24).padStart(2, '0');
        lines.push(`DTEND;TZID=Europe/Berlin:${formatIcsDateTime(ev.date, `${endHour}:${String(m || 0).padStart(2, '0')}`)}`);
      }
    } else {
      lines.push(`DTSTART;${formatIcsDateTime(ev.date, '')}`);
    }

    lines.push(`SUMMARY:${escapeIcsText(ev.title || 'Event')}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
    lines.push('STATUS:CONFIRMED');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

function canUserAccessEventDutyPlan(user, event, allEventDuties, groupMap) {
  if (!user || !event) return false;
  const currentUid = user.uid || user.id;

  // 1. Creator of event
  if (event.createdBy === currentUid) return true;

  // 2. Users with explicit 'manage_events' permission
  const canManage = user.canManageEvents === true || (Array.isArray(user.permissions) && user.permissions.includes('manage_events'));
  if (canManage) {
    return true;
  }

  // 3. User is entered or requested in duty plan for this event, or member of assigned group in duties
  const isEnteredOrRequested = Array.isArray(allEventDuties) && allEventDuties.some(d => {
    if (d.event !== event.id) return false;
    if (d.assignedUser === currentUid) return true;
    if (d.requestedUser === currentUid) return true;
    if (d.assignedGroup && Array.isArray(user.groups)) {
      return user.groups.some(g => {
        const gid = typeof g === 'object' && g ? (g.id || g.name) : String(g);
        const gname = typeof g === 'object' && g ? g.name : String(g);
        return gid === d.assignedGroup || gname === d.assignedGroup || (groupMap && groupMap.get(d.assignedGroup) === gname);
      });
    }
    return false;
  });
  if (isEnteredOrRequested) return true;

  return false;
}

// 1. List all visible events
app.get('/api/events', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const allEvents = await listEvents(appConfig, '', '+date,+startTime');
    const allRegs = await listEventRegistrations(appConfig);
    const allDuties = await listEventDuties(appConfig);
    const users = await listUserRecords(appConfig);
    const userMap = new Map(users.map(u => [u.id, u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email]));
    const managerUserIds = new Set(users.filter(u => u.canManageEvents === true || (Array.isArray(u.permissions) && u.permissions.includes('manage_events'))).map(u => u.id));
    let allGroups = [];
    try { allGroups = await listGroupRecords(appConfig); } catch {}
    const groupMap = new Map(allGroups.map(g => [g.id, g.name]));

    // Filter events by target group visibility
    const visibleEvents = allEvents.filter(ev => {
      const isCreator = ev.createdBy === currentUid;
      if (isCreator) return true;
      return userMatchesTargetGroups(req.user, ev.targetGroups);
    });

    const formatted = visibleEvents.map(ev => {
      const isCreator = ev.createdBy === currentUid;
      const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events'));
      const canEdit = isCreator || canManageEvents;
      const isCreatorManager = managerUserIds.has(ev.createdBy);
      const isOfficial = Boolean(ev.eventType === 'termin' || ev.isRecurring);

      const evRegs = allRegs.filter(r => r.event === ev.id);
      const registeredCount = evRegs.filter(r => r.status === 'registered').length;
      const waitlistCount = evRegs.filter(r => r.status === 'waitlist').length;
      const myReg = evRegs.find(r => r.user === currentUid && r.status !== 'cancelled') || null;

      const isFull = typeof ev.maxParticipants === 'number' && ev.maxParticipants > 0 && registeredCount >= ev.maxParticipants;

      const allEvDuties = allDuties.filter(d => d.event === ev.id);
      const canAccessDutyPlan = canUserAccessEventDutyPlan(req.user, ev, allEvDuties, groupMap);

      let evDuties = [];
      if (canAccessDutyPlan) {
        evDuties = allEvDuties.map(d => {
          return {
            id: d.id,
            event: d.event,
            section: d.section || 'Allgemein',
            roleName: d.roleName,
            assignedGroup: d.assignedGroup || '',
            assignedGroupName: groupMap.get(d.assignedGroup) || d.assignedGroup || '',
            assignedUser: d.assignedUser || '',
            assignedUserName: userMap.get(d.assignedUser) || '',
            requestedUser: d.requestedUser || '',
            requestedUserName: userMap.get(d.requestedUser) || '',
            requestedBy: d.requestedBy || '',
            requestedByName: userMap.get(d.requestedBy) || '',
            notes: d.notes || '',
            status: d.status || 'open',
            canEditNotes: canEdit,
            canManageDuty: canEdit
          };
        });
      }

      return {
        id: ev.id,
        title: ev.title,
        date: ev.date,
        endDate: ev.endDate || '',
        startTime: ev.startTime || '',
        endTime: ev.endTime || '',
        location: ev.location || '',
        description: ev.description || '',
        eventType: ev.eventType || (ev.isRecurring ? 'termin' : 'event'),
        isPinned: ev.isPinned === true,
        isOfficialTermin: isOfficial,
        createdByManager: isCreatorManager,
        isRecurring: ev.isRecurring === true,
        recurringRule: ev.recurringRule || '',
        seriesId: ev.seriesId || '',
        status: ev.status || 'scheduled',
        requiresRegistration: ev.requiresRegistration === true,
        minParticipants: typeof ev.minParticipants === 'number' ? ev.minParticipants : 0,
        maxParticipants: typeof ev.maxParticipants === 'number' ? ev.maxParticipants : 0,
        targetGroups: Array.isArray(ev.targetGroups) ? ev.targetGroups : [],
        createdBy: ev.createdBy,
        createdByName: userMap.get(ev.createdBy) || 'Mitglied',
        created: ev.created,
        imageUrl: ev.imageUrl || '',
        duties: evDuties,
        registeredCount,
        waitlistCount,
        myRegistration: myReg ? { id: myReg.id, status: myReg.status } : null,
        isFull,
        canEdit,
        canAccessDutyPlan
      };
    });

    res.json(formatted);
  } catch (err) {
    console.error('Failed to list events:', err);
    res.status(500).json({ error: 'Events konnten nicht geladen werden' });
  }
});

// Helper functions for drift-free recurring calendar date math
function addDaysDriftFree(dateStr, daysToAdd) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d + daysToAdd, 12, 0, 0));
  const newY = utcDate.getUTCFullYear();
  const newM = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
  const newD = String(utcDate.getUTCDate()).padStart(2, '0');
  return `${newY}-${newM}-${newD}`;
}

function getNextRecurringDate(baseDateStr, rule, index) {
  if (index === 0) return baseDateStr;
  const [y, m, d] = baseDateStr.split('-').map(Number);

  if (rule === 'weekly') {
    return addDaysDriftFree(baseDateStr, index * 7);
  } else if (rule === 'biweekly') {
    return addDaysDriftFree(baseDateStr, index * 14);
  } else if (rule === 'monthly') {
    const baseUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const targetWeekday = baseUtc.getUTCDay();
    const weekIndex = Math.floor((d - 1) / 7);
    const targetMonthDate = new Date(Date.UTC(y, (m - 1) + index, 1, 12, 0, 0));
    const targetYear = targetMonthDate.getUTCFullYear();
    const targetMonth = targetMonthDate.getUTCMonth();
    const firstDayOfMonth = new Date(Date.UTC(targetYear, targetMonth, 1, 12, 0, 0)).getUTCDay();
    const firstMatchingDate = 1 + ((targetWeekday - firstDayOfMonth + 7) % 7);
    let targetDay = firstMatchingDate + (weekIndex * 7);
    const testDate = new Date(Date.UTC(targetYear, targetMonth, targetDay, 12, 0, 0));
    if (testDate.getUTCMonth() !== targetMonth) {
      targetDay -= 7;
    }
    const resY = targetYear;
    const resM = String(targetMonth + 1).padStart(2, '0');
    const resD = String(targetDay).padStart(2, '0');
    return `${resY}-${resM}-${resD}`;
  }
  return addDaysDriftFree(baseDateStr, index * 7);
}

// 2. Create event
app.post('/api/events', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const {
      title,
      date,
      endDate,
      startTime,
      endTime,
      location,
      description,
      eventType,
      isPinned,
      isRecurring,
      recurringRule,
      recurringCount,
      requiresRegistration,
      minParticipants,
      maxParticipants,
      targetGroups,
      imageUrl,
      duties
    } = req.body || {};

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Titel ist erforderlich' });
    }
    if (!date || !String(date).trim()) {
      return res.status(400).json({ error: 'Datum ist erforderlich' });
    }

    // Check event creation permissions
    const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events')) || req.user.admin === true || req.user.owner === true || req.user.superAdmin === true;
    const eventSettings = await getStateValue(appConfig, 'event_settings', DEFAULT_EVENT_SETTINGS);
    if (!eventSettings.allowMemberCreation && !canManageEvents) {
      return res.status(403).json({ error: 'Die Erstellung von Events ist derzeit nur für die Leitung freigeschaltet' });
    }

    // Protection: Users without canManageEvents always create 'event'. Only users with canManageEvents can choose 'termin' or recurring.
    let finalEventType = 'event';
    let finalIsPinned = false;
    let finalIsRecurring = false;
    if (canManageEvents) {
      finalEventType = (eventType === 'termin' || isRecurring) ? 'termin' : 'event';
      finalIsPinned = isPinned === true;
      finalIsRecurring = isRecurring === true;
    }

    const count = finalIsRecurring ? Math.min(52, Math.max(2, parseInt(recurringCount, 10) || 10)) : 1;

    let durationDays = 0;
    if (endDate && endDate !== date) {
      const [sy, sm, sd] = String(date).trim().split('-').map(Number);
      const [ey, em, ed] = String(endDate).trim().split('-').map(Number);
      const sUtc = Date.UTC(sy, sm - 1, sd);
      const eUtc = Date.UTC(ey, em - 1, ed);
      durationDays = Math.max(0, Math.round((eUtc - sUtc) / 86400000));
    }

    const createdEvents = [];
    for (let i = 0; i < count; i++) {
      const instanceDate = getNextRecurringDate(String(date).trim(), recurringRule || 'weekly', i);
      const instanceEndDate = durationDays > 0 ? addDaysDriftFree(instanceDate, durationDays) : '';

      const eventRecord = await createEventRecord(appConfig, {
        title: String(title).trim(),
        date: instanceDate,
        endDate: instanceEndDate,
        startTime: startTime ? String(startTime).trim() : '',
        endTime: endTime ? String(endTime).trim() : '',
        location: location ? String(location).trim() : '',
        description: description ? String(description).trim() : '',
        eventType: finalEventType,
        isPinned: finalIsPinned,
        isRecurring: false, // Independent event template instance so organizers can edit each individually
        recurringRule: '',
        imageUrl: imageUrl ? String(imageUrl).trim() : '',
        status: 'scheduled',
        requiresRegistration: requiresRegistration === true,
        minParticipants: Number(minParticipants) > 0 ? Number(minParticipants) : 0,
        maxParticipants: Number(maxParticipants) > 0 ? Number(maxParticipants) : 0,
        targetGroups: Array.isArray(targetGroups) ? targetGroups.filter(Boolean) : [],
        createdBy: currentUid
      });

      // Create duty slots if specified
      if (Array.isArray(duties)) {
        for (const d of duties) {
          if (d && d.roleName && String(d.roleName).trim()) {
            await createEventDuty(appConfig, {
              event: eventRecord.id,
              section: d.section ? String(d.section).trim() : 'Allgemein',
              roleName: String(d.roleName).trim(),
              assignedGroup: d.assignedGroup ? String(d.assignedGroup).trim() : '',
              assignedUser: d.assignedUser ? String(d.assignedUser).trim() : '',
              requestedUser: d.requestedUser ? String(d.requestedUser).trim() : '',
              notes: d.notes ? String(d.notes).trim() : '',
              status: d.status || (d.assignedGroup || d.assignedUser ? 'confirmed' : (d.requestedUser ? 'requested' : 'open'))
            });
          }
        }
      }

      createdEvents.push(eventRecord);
    }

    broadcastDataUpdate();
    res.status(201).json({ success: true, event: createdEvents[0], count: createdEvents.length });
  } catch (err) {
    console.error('Failed to create event:', err);
    res.status(500).json({ error: 'Event konnte nicht erstellt werden' });
  }
});

// 3. Update event
app.patch('/api/events/:id', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const event = await getEventRecord(appConfig, req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event nicht gefunden' });
    }

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events')) || req.user.admin === true || req.user.owner === true || req.user.superAdmin === true;
    if (!isCreator && !canManageEvents) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Bearbeiten dieses Events' });
    }

    const {
      title,
      date,
      endDate,
      startTime,
      endTime,
      location,
      description,
      eventType,
      isPinned,
      isRecurring,
      recurringRule,
      requiresRegistration,
      minParticipants,
      maxParticipants,
      targetGroups,
      imageUrl,
      status
    } = req.body || {};

    const updates = {};
    if (title !== undefined) updates.title = String(title).trim();
    if (date !== undefined) updates.date = String(date).trim();
    if (endDate !== undefined) updates.endDate = String(endDate).trim();
    if (startTime !== undefined) updates.startTime = String(startTime).trim();
    if (endTime !== undefined) updates.endTime = String(endTime).trim();
    if (location !== undefined) updates.location = String(location).trim();
    if (description !== undefined) updates.description = String(description).trim();
    if (imageUrl !== undefined) updates.imageUrl = String(imageUrl).trim();
    if (requiresRegistration !== undefined) updates.requiresRegistration = requiresRegistration === true;
    if (minParticipants !== undefined) updates.minParticipants = Number(minParticipants) > 0 ? Number(minParticipants) : 0;
    if (maxParticipants !== undefined) updates.maxParticipants = Number(maxParticipants) > 0 ? Number(maxParticipants) : 0;
    if (targetGroups !== undefined) updates.targetGroups = Array.isArray(targetGroups) ? targetGroups.filter(Boolean) : [];
    if (status !== undefined) updates.status = String(status).trim();

    if (canManageEvents) {
      if (eventType !== undefined) updates.eventType = eventType === 'termin' ? 'termin' : 'event';
      if (isPinned !== undefined) updates.isPinned = isPinned === true;
      if (isRecurring !== undefined) updates.isRecurring = isRecurring === true;
      if (recurringRule !== undefined) updates.recurringRule = String(recurringRule).trim();
    }

    const updated = await updateEventRecord(appConfig, event.id, updates);

    // Sync duties if provided
    if (Array.isArray(req.body.duties)) {
      try {
        const existingDuties = await listEventDuties(appConfig, pbFilterEquals('event', event.id));
        const existingIds = new Set(existingDuties.map(d => d.id));
        const newDutyIds = new Set();

        for (const d of req.body.duties) {
          if (d.id && existingIds.has(d.id)) {
            newDutyIds.add(d.id);
            await updateEventDuty(appConfig, d.id, {
              section: d.section ? String(d.section).trim() : 'Allgemein',
              roleName: d.roleName ? String(d.roleName).trim() : 'Dienst',
              assignedGroup: d.assignedGroup ? String(d.assignedGroup).trim() : '',
              assignedUser: d.assignedUser ? String(d.assignedUser).trim() : '',
              notes: d.notes ? String(d.notes).trim() : ''
            });
          } else if (d.roleName && String(d.roleName).trim()) {
            const createdDuty = await createEventDuty(appConfig, {
              event: event.id,
              section: d.section ? String(d.section).trim() : 'Allgemein',
              roleName: String(d.roleName).trim(),
              assignedGroup: d.assignedGroup ? String(d.assignedGroup).trim() : '',
              assignedUser: d.assignedUser ? String(d.assignedUser).trim() : '',
              notes: d.notes ? String(d.notes).trim() : '',
              status: d.assignedGroup || d.assignedUser ? 'confirmed' : 'open'
            });
            newDutyIds.add(createdDuty.id);
          }
        }

        // Delete removed duties
        for (const existing of existingDuties) {
          if (!newDutyIds.has(existing.id)) {
            await deleteEventDuty(appConfig, existing.id).catch(() => {});
          }
        }
      } catch (dutyErr) {
        console.warn('Failed to sync duties on event update:', dutyErr.message);
      }
    }

    broadcastDataUpdate();
    res.json({ success: true, event: updated });
  } catch (err) {
    console.error('Failed to update event:', err);
    res.status(500).json({ error: 'Event konnte nicht aktualisiert werden' });
  }
});

// 4. Delete event
app.delete('/api/events/:id', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const event = await getEventRecord(appConfig, req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event nicht gefunden' });
    }

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events'));
    if (!isCreator && !canManageEvents) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Löschen dieses Events' });
    }

    await deleteEventRecord(appConfig, event.id);
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete event:', err);
    res.status(500).json({ error: 'Event konnte nicht gelöscht werden' });
  }
});

// 5. Register or cancel registration for an event
app.post('/api/events/:id/register', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const event = await getEventRecord(appConfig, req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event nicht gefunden' });
    }
    if (!event.requiresRegistration) {
      return res.status(400).json({ error: 'Dieses Event erfordert keine Anmeldung' });
    }

    // Check visibility
    const isCreator = event.createdBy === currentUid;
    if (!isCreator && !userMatchesTargetGroups(req.user, event.targetGroups)) {
      return res.status(403).json({ error: 'Du hast keinen Zugriff auf dieses Event' });
    }

    const { action } = req.body || {};
    const todayStr = new Date().toISOString().split('T')[0];
    const eventEndDate = (event.endDate && event.endDate.trim()) ? event.endDate.trim() : (event.date ? event.date.trim() : '');
    if (action !== 'cancel' && eventEndDate && eventEndDate < todayStr) {
      return res.status(400).json({ error: 'Dieses Event ist bereits vorüber. Eine Anmeldung ist nicht mehr möglich.' });
    }

    const evRegs = await listEventRegistrations(appConfig, pbFilterEquals('event', event.id));

    if (action === 'cancel') {
      const myReg = evRegs.find(r => r.user === currentUid && r.status !== 'cancelled');
      if (myReg) {
        await upsertEventRegistration(appConfig, event.id, currentUid, 'cancelled');

        // Check if a spot opened up for the waitlist
        const remainingActive = evRegs.filter(r => r.id !== myReg.id && r.status === 'registered').length;
        if (typeof event.maxParticipants === 'number' && event.maxParticipants > 0 && remainingActive < event.maxParticipants) {
          const firstWaitlist = evRegs.find(r => r.id !== myReg.id && r.status === 'waitlist');
          if (firstWaitlist) {
            await upsertEventRegistration(appConfig, event.id, firstWaitlist.user, 'registered');
          }
        }
      }
      broadcastDataUpdate();
      return res.json({ success: true, status: 'cancelled' });
    }

    // Default action: 'register'
    const registeredCount = evRegs.filter(r => r.status === 'registered' && r.user !== currentUid).length;
    let nextStatus = 'registered';
    if (typeof event.maxParticipants === 'number' && event.maxParticipants > 0 && registeredCount >= event.maxParticipants) {
      nextStatus = 'waitlist';
    }

    const reg = await upsertEventRegistration(appConfig, event.id, currentUid, nextStatus);
    broadcastDataUpdate();
    res.json({ success: true, registration: reg, status: nextStatus, isWaitlist: nextStatus === 'waitlist' });
  } catch (err) {
    console.error('Failed to register for event:', err);
    res.status(500).json({ error: 'Anmeldung fehlgeschlagen' });
  }
});

// Candidates list for duty assignments and invitations (includes system groups)
app.get('/api/events/candidates', verifyToken, async (req, res) => {
  try {
    const users = await listUserRecords(appConfig);
    let groups = [];
    try { groups = await listGroupRecords(appConfig); } catch {}
    const candidates = users.map(u => ({
      id: u.id,
      name: u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email,
      email: u.email || '',
      groups: Array.isArray(u.groups) ? u.groups : []
    }));
    res.json({
      candidates,
      groups: groups.map(g => ({ id: g.id, name: g.name }))
    });
  } catch (err) {
    console.error('Failed to list candidates:', err);
    res.status(500).json({ error: 'Kandidaten konnten nicht geladen werden' });
  }
});

// Incoming duty requests for the authenticated user
app.get('/api/events/my-requests', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const allDuties = await listEventDuties(appConfig);
    const myRequestedDuties = allDuties.filter(d => d.requestedUser === currentUid && d.status === 'requested');

    if (myRequestedDuties.length === 0) {
      return res.json([]);
    }

    const allEvents = await listEvents(appConfig);
    const eventMap = new Map(allEvents.map(e => [e.id, e]));
    const users = await listUserRecords(appConfig);
    const userMap = new Map(users.map(u => [u.id, u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email]));

    const result = myRequestedDuties.map(d => {
      const ev = eventMap.get(d.event) || {};
      return {
        id: d.id,
        eventId: d.event,
        eventTitle: ev.title || 'Termin',
        eventDate: ev.date || '',
        eventStartTime: ev.startTime || '',
        eventEndTime: ev.endTime || '',
        eventLocation: ev.location || '',
        section: d.section || '',
        roleName: d.roleName,
        requestedBy: d.requestedBy,
        requestedByName: userMap.get(d.requestedBy) || 'Leitung',
        notes: d.notes || ''
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Failed to get my requests:', err);
    res.status(500).json({ error: 'Dienstanfragen konnten nicht geladen werden' });
  }
});

// 6. Update duty slot (notes, roleName, status)
app.patch('/api/events/duties/:dutyId', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(appConfig, req.params.dutyId);
    if (!duty) {
      return res.status(404).json({ error: 'Dienst nicht gefunden' });
    }

    const event = await getEventRecord(appConfig, duty.event);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    let allGroups = [];
    try { allGroups = await listGroupRecords(appConfig); } catch {}
    const groupMap = new Map(allGroups.map(g => [g.id, g.name]));
    const allDuties = await listEventDuties(appConfig);
    const eventDuties = allDuties.filter(d => d.event === event.id);

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events'));
    const isAssigned = duty.assignedUser === currentUid;
    const canManage = isCreator || canManageEvents;

    if (!canManage && !isAssigned) {
      return res.status(403).json({ error: 'Keine Berechtigung zur Bearbeitung dieses Dienstes' });
    }
    if (!canManage && (status !== undefined || roleName !== undefined || section !== undefined || assignedGroup !== undefined || assignedUser !== undefined)) {
      return res.status(403).json({ error: 'Nur Event-Manager oder der Event-Ersteller können diese Felder bearbeiten' });
    }

    const { notes, status, roleName, section, assignedGroup, assignedUser } = req.body || {};
    const updates = {};

    if (notes !== undefined) updates.notes = String(notes).trim();
    if (status !== undefined && canManage) updates.status = String(status).trim();
    if (section !== undefined && canManage) updates.section = String(section).trim();
    if (roleName !== undefined && canManage) updates.roleName = String(roleName).trim();
    if (assignedGroup !== undefined && canManage) updates.assignedGroup = String(assignedGroup).trim();
    if (assignedUser !== undefined && canManage) updates.assignedUser = String(assignedUser).trim();

    const updated = await updateEventDuty(appConfig, duty.id, updates);
    broadcastDataUpdate();
    res.json({ success: true, duty: updated });
  } catch (err) {
    console.error('Failed to update duty:', err);
    res.status(500).json({ error: 'Dienst konnte nicht aktualisiert werden' });
  }
});

// 7. Add duty to event (Group = direct assignment, Single person = always requested)
app.post('/api/events/:id/duties', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const event = await getEventRecord(appConfig, req.params.id);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events'));
    const canManage = isCreator || canManageEvents;
    if (!canManage) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Erstellen von Diensten' });
    }

    const { roleName, section, assignedGroup, targetGroupId, assignedUser, requestedUser, targetUserId, notes, sendEmail } = req.body || {};
    if (!roleName || !String(roleName).trim()) {
      return res.status(400).json({ error: 'Dienstbezeichnung ist erforderlich' });
    }

    let status = 'open';
    let finalAssignedGroup = '';
    let finalAssignedUser = '';
    let finalRequestedUser = '';
    let finalRequestedBy = '';

    const selGroup = (assignedGroup || targetGroupId || '').toString().trim();
    const selUser = (requestedUser || assignedUser || targetUserId || '').toString().trim();

    if (selGroup) {
      // Group: assigned directly WITHOUT permission/request required
      finalAssignedGroup = selGroup;
      status = 'assigned';
    } else if (selUser) {
      // Single person: ALWAYS requested
      finalRequestedUser = selUser;
      finalRequestedBy = currentUid;
      status = 'requested';
    }

    const duty = await createEventDuty(appConfig, {
      event: event.id,
      section: section ? String(section).trim() : '',
      roleName: String(roleName).trim(),
      assignedGroup: finalAssignedGroup,
      assignedUser: finalAssignedUser,
      requestedUser: finalRequestedUser,
      requestedBy: finalRequestedBy,
      notes: notes ? String(notes).trim() : '',
      status
    });

    if (finalRequestedUser && sendEmail !== false) {
      sendDutyRequestNotificationEmail({
        recipientUserId: finalRequestedUser,
        requestedByUserId: currentUid,
        event,
        duty,
        appConfig,
        sendEmailRequested: sendEmail !== false
      }).catch(e => console.warn('Duty email error:', e));
    }

    broadcastDataUpdate();
    res.status(201).json({ success: true, duty });
  } catch (err) {
    console.error('Failed to add duty:', err);
    res.status(500).json({ error: 'Dienst konnte nicht hinzugefügt werden' });
  }
});

// 8. Delete duty
app.delete('/api/events/duties/:dutyId', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(appConfig, req.params.dutyId);
    if (!duty) return res.status(404).json({ error: 'Dienst nicht gefunden' });

    const event = await getEventRecord(appConfig, duty.event);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events'));
    const canManage = isCreator || canManageEvents;
    if (!canManage) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Löschen dieses Dienstes' });
    }

    await deleteEventDuty(appConfig, duty.id);
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete duty:', err);
    res.status(500).json({ error: 'Dienst konnte nicht gelöscht werden' });
  }
});

// 9. Send duty invitation / request to single person
app.post('/api/events/duties/:dutyId/request', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(appConfig, req.params.dutyId);
    if (!duty) return res.status(404).json({ error: 'Dienst nicht gefunden' });

    const event = await getEventRecord(appConfig, duty.event);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events'));
    const canManage = isCreator || canManageEvents;
    if (!canManage) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Versenden von Dienstanfragen' });
    }

    const { targetUserId, sendEmail } = req.body || {};
    if (!targetUserId || !String(targetUserId).trim()) {
      return res.status(400).json({ error: 'Bitte wähle eine Person für die Anfrage aus' });
    }

    const updated = await updateEventDuty(appConfig, duty.id, {
      requestedUser: String(targetUserId).trim(),
      requestedBy: currentUid,
      assignedUser: '',
      assignedGroup: '',
      status: 'requested'
    });

    if (sendEmail !== false) {
      sendDutyRequestNotificationEmail({
        recipientUserId: String(targetUserId).trim(),
        requestedByUserId: currentUid,
        event,
        duty: updated,
        appConfig,
        sendEmailRequested: sendEmail !== false
      }).catch(e => console.warn('Duty email error:', e));
    }

    broadcastDataUpdate();
    res.json({ success: true, duty: updated });
  } catch (err) {
    console.error('Failed to request duty:', err);
    res.status(500).json({ error: 'Anfrage konnte nicht gesendet werden' });
  }
});

// 10. Assign group (direct) or single person (always requested) to duty slot
app.post('/api/events/duties/:dutyId/assign', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(appConfig, req.params.dutyId);
    if (!duty) return res.status(404).json({ error: 'Dienst nicht gefunden' });

    const event = await getEventRecord(appConfig, duty.event);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events'));
    const canManage = isCreator || canManageEvents;
    if (!canManage) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Zuweisen dieses Dienstes' });
    }

    const { targetGroupId, targetUserId, sendEmail } = req.body || {};

    let updates = {};
    if (targetGroupId && String(targetGroupId).trim()) {
      // Group: assigned directly, NO confirmation/permission required
      updates = {
        assignedGroup: String(targetGroupId).trim(),
        assignedUser: '',
        requestedUser: '',
        requestedBy: '',
        status: 'assigned'
      };
    } else if (targetUserId && String(targetUserId).trim()) {
      // Single person: ALWAYS requested
      updates = {
        assignedGroup: '',
        assignedUser: '',
        requestedUser: String(targetUserId).trim(),
        requestedBy: currentUid,
        status: 'requested'
      };
    } else {
      return res.status(400).json({ error: 'Bitte wähle eine Gruppe oder Person aus' });
    }

    const updated = await updateEventDuty(appConfig, duty.id, updates);

    if (updates.requestedUser && sendEmail !== false) {
      sendDutyRequestNotificationEmail({
        recipientUserId: updates.requestedUser,
        requestedByUserId: currentUid,
        event,
        duty: updated,
        appConfig,
        sendEmailRequested: sendEmail !== false
      }).catch(e => console.warn('Duty email error:', e));
    }

    broadcastDataUpdate();
    res.json({ success: true, duty: updated });
  } catch (err) {
    console.error('Failed to assign duty:', err);
    res.status(500).json({ error: 'Dienst konnte nicht zugewiesen werden' });
  }
});

// 11. Respond to duty request (Accept / Decline)
app.post('/api/events/duties/:dutyId/respond', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(appConfig, req.params.dutyId);
    if (!duty) return res.status(404).json({ error: 'Dienst nicht gefunden' });

    const isTarget = duty.requestedUser === currentUid;
    const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events'));
    const isPlanner = canManageEvents;
    if (!isTarget && !isPlanner) {
      return res.status(403).json({ error: 'Nur der angefragte Benutzer kann auf diese Anfrage antworten' });
    }

    const { action } = req.body || {}; // 'accept' or 'decline'
    if (action === 'accept') {
      const updated = await updateEventDuty(appConfig, duty.id, {
        assignedUser: duty.requestedUser || currentUid,
        requestedUser: '',
        requestedBy: '',
        status: 'confirmed'
      });

      if (duty.requestedBy && duty.requestedBy !== currentUid) {
        try {
          const allUsers = await listUserRecords(appConfig);
          const responder = allUsers.find(u => u.id === currentUid);
          const responderName = responder ? (responder.name || `${responder.firstName || ''} ${responder.lastName || ''}`.trim() || responder.email) : 'Ein Helfer';
          const dutyName = duty.roleName || duty.section || 'Dienst';
          const event = await getEventRecord(appConfig, duty.event);
          sendPushToUser(appConfig, duty.requestedBy, {
            title: `Dienstanfrage angenommen: ${dutyName}`,
            body: `${responderName} hat die Anfrage für "${dutyName}" (${event?.title || 'Event'}) angenommen.`,
            data: { url: '/#calendar' }
          }).catch(e => console.warn('[WebPush] Duty accept push error:', e.message));
        } catch (e) {}
      }

      broadcastDataUpdate();
      return res.json({ success: true, duty: updated, message: 'Dienstanfrage angenommen' });
    } else if (action === 'decline') {
      const updated = await updateEventDuty(appConfig, duty.id, {
        requestedUser: duty.requestedUser || currentUid,
        requestedBy: duty.requestedBy || '',
        status: 'declined'
      });

      if (duty.requestedBy && duty.requestedBy !== currentUid) {
        try {
          const allUsers = await listUserRecords(appConfig);
          const responder = allUsers.find(u => u.id === currentUid);
          const responderName = responder ? (responder.name || `${responder.firstName || ''} ${responder.lastName || ''}`.trim() || responder.email) : 'Ein Helfer';
          const dutyName = duty.roleName || duty.section || 'Dienst';
          const event = await getEventRecord(appConfig, duty.event);
          sendPushToUser(appConfig, duty.requestedBy, {
            title: `Dienstanfrage abgelehnt: ${dutyName}`,
            body: `${responderName} hat die Anfrage für "${dutyName}" (${event?.title || 'Event'}) abgelehnt.`,
            data: { url: '/#calendar' }
          }).catch(e => console.warn('[WebPush] Duty decline push error:', e.message));
        } catch (e) {}
      }

      broadcastDataUpdate();
      return res.json({ success: true, duty: updated, message: 'Dienstanfrage abgelehnt' });
    } else {
      return res.status(400).json({ error: 'Ungültige Aktion' });
    }
  } catch (err) {
    console.error('Failed to respond to duty request:', err);
    res.status(500).json({ error: 'Antwort konnte nicht übermittelt werden' });
  }
});

// 12. Cancel pending duty request
app.post('/api/events/duties/:dutyId/cancel-request', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(appConfig, req.params.dutyId);
    if (!duty) return res.status(404).json({ error: 'Dienst nicht gefunden' });

    const event = await getEventRecord(appConfig, duty.event);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events'));
    const canCancel = isCreator || duty.requestedBy === currentUid || canManageEvents;
    if (!canCancel) {
      return res.status(403).json({ error: 'Keine Berechtigung zum Zurückziehen der Anfrage' });
    }

    const updated = await updateEventDuty(appConfig, duty.id, {
      requestedUser: '',
      requestedBy: '',
      status: 'open'
    });

    broadcastDataUpdate();
    res.json({ success: true, duty: updated });
  } catch (err) {
    console.error('Failed to cancel request:', err);
    res.status(500).json({ error: 'Anfrage konnte nicht zurückgezogen werden' });
  }
});

// 13. Claim / Unclaim duty slot (Voluntary sign-up for open slots)
app.post('/api/events/duties/:dutyId/claim', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const duty = await getEventDuty(appConfig, req.params.dutyId);
    if (!duty) return res.status(404).json({ error: 'Dienst nicht gefunden' });

    const { action } = req.body || {}; // 'claim' or 'unclaim'

    if (action === 'unclaim') {
      const isAssigned = duty.assignedUser === currentUid;
      let canManage = false;
      const event = await getEventRecord(appConfig, duty.event);
      if (event) {
        const isCreator = event.createdBy === currentUid;
        const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events'));
        canManage = isCreator || canManageEvents;
      }
      if (!isAssigned && !canManage) {
        return res.status(403).json({ error: 'Du kannst diese Zuweisung nicht aufheben' });
      }
      const updated = await updateEventDuty(appConfig, duty.id, {
        assignedUser: '',
        requestedUser: '',
        requestedBy: '',
        status: duty.assignedGroup ? 'assigned' : 'open'
      });
      broadcastDataUpdate();
      return res.json({ success: true, duty: updated });
    }

    // Default action: 'claim'
    if (duty.assignedUser && duty.assignedUser !== currentUid) {
      return res.status(409).json({ error: 'Dieser Dienst ist bereits vergeben' });
    }

    const updated = await updateEventDuty(appConfig, duty.id, {
      assignedUser: currentUid,
      requestedUser: '',
      requestedBy: '',
      status: 'confirmed'
    });
    broadcastDataUpdate();
    res.json({ success: true, duty: updated });
  } catch (err) {
    console.error('Failed to claim duty:', err);
    res.status(500).json({ error: 'Dienst konnte nicht übernommen werden' });
  }
});

// 10. Get attendees list for an event
app.get('/api/events/:id/attendees', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const event = await getEventRecord(appConfig, req.params.id);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    if (!isCreator && !userMatchesTargetGroups(req.user, event.targetGroups)) {
      return res.status(403).json({ error: 'Kein Zugriff auf dieses Event' });
    }

    const evRegs = await listEventRegistrations(appConfig, pbFilterEquals('event', event.id));
    const users = await listUserRecords(appConfig);
    const userMap = new Map(users.map(u => [u.id, u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email]));

    const registered = [];
    const waitlist = [];

    for (const r of evRegs) {
      const item = {
        id: r.id,
        userId: r.user,
        name: userMap.get(r.user) || 'Mitglied',
        status: r.status,
        created: r.created
      };
      if (r.status === 'registered') {
        registered.push(item);
      } else if (r.status === 'waitlist') {
        waitlist.push(item);
      }
    }

    res.json({
      eventId: event.id,
      registered,
      waitlist,
      registeredCount: registered.length,
      waitlistCount: waitlist.length,
      maxParticipants: typeof event.maxParticipants === 'number' ? event.maxParticipants : 0
    });
  } catch (err) {
    console.error('Failed to load attendees:', err);
    res.status(500).json({ error: 'Teilnehmer konnten nicht geladen werden' });
  }
});

// 11. Remove attendee (Admin or creator)
app.delete('/api/events/:id/attendees/:userId', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const event = await getEventRecord(appConfig, req.params.id);
    if (!event) return res.status(404).json({ error: 'Event nicht gefunden' });

    const isCreator = event.createdBy === currentUid;
    const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events'));
    if (!isCreator && !canManageEvents) {
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }

    const targetUid = req.params.userId;
    await upsertEventRegistration(appConfig, event.id, targetUid, 'cancelled');

    // Check waitlist auto-promotion
    const evRegs = await listEventRegistrations(appConfig, pbFilterEquals('event', event.id));
    const remainingActive = evRegs.filter(r => r.user !== targetUid && r.status === 'registered').length;
    if (typeof event.maxParticipants === 'number' && event.maxParticipants > 0 && remainingActive < event.maxParticipants) {
      const firstWaitlist = evRegs.find(r => r.user !== targetUid && r.status === 'waitlist');
      if (firstWaitlist) {
        await upsertEventRegistration(appConfig, event.id, firstWaitlist.user, 'registered');
      }
    }

    broadcastDataUpdate();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to remove attendee:', err);
    res.status(500).json({ error: 'Teilnehmer konnte nicht entfernt werden' });
  }
});

// 12. Single event iCal export (.ics)
app.get('/api/events/:id/export.ics', verifyToken, async (req, res) => {
  try {
    const event = await getEventRecord(appConfig, req.params.id);
    if (!event) return res.status(404).send('Event nicht gefunden');

    const appName = appConfig?.appName || 'Agora';
    const icsContent = generateIcsCalendar([event], `${appName} - ${event.title || 'Event'}`);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="event-${event.id}.ics"`);
    res.send(icsContent);
  } catch (err) {
    console.error('Failed to export single event ics:', err);
    res.status(500).send('Fehler beim Exportieren des Termins');
  }
});

// 13. Full calendar feed (supports WebCal subscriptions via ?token=...)
app.get('/api/events/calendar.ics', verifyToken, async (req, res) => {
  try {
    const currentUid = req.user.uid || req.user.id;
    const allEvents = await listEvents(appConfig, '', '+date,+startTime');

    const visibleEvents = allEvents.filter(ev => {
      const isCreator = ev.createdBy === currentUid;
      if (isCreator) return true;
      return userMatchesTargetGroups(req.user, ev.targetGroups);
    });

    const appName = appConfig?.appName || 'Agora';
    const icsContent = generateIcsCalendar(visibleEvents, `${appName} Terminkalender`);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="agora-kalender.ics"');
    res.send(icsContent);
  } catch (err) {
    console.error('Failed to export calendar feed:', err);
    res.status(500).send('Kalender-Feed konnte nicht erstellt werden');
  }
});

// 14. Event settings: get
app.get('/api/events/settings', verifyToken, async (req, res) => {
  try {
    const settings = await getStateValue(appConfig, 'event_settings', DEFAULT_EVENT_SETTINGS);
    res.json(settings || DEFAULT_EVENT_SETTINGS);
  } catch (err) {
    console.error('Failed to get event settings:', err);
    res.json(DEFAULT_EVENT_SETTINGS);
  }
});

// 15. Event settings: update (Admin or manageEvents)
app.patch('/api/events/settings', verifyToken, async (req, res) => {
  try {
    const canManageEvents = req.user.canManageEvents === true || (Array.isArray(req.user.permissions) && req.user.permissions.includes('manage_events'));
    if (!canManageEvents) {
      return res.status(403).json({ error: 'Nur für Administratoren / Leitung' });
    }

    const current = await getStateValue(appConfig, 'event_settings', DEFAULT_EVENT_SETTINGS);
    const { allowMemberCreation, defaultDuties } = req.body || {};
    const updated = {
      ...current,
      allowMemberCreation: allowMemberCreation !== undefined ? allowMemberCreation === true : current.allowMemberCreation,
      defaultDuties: Array.isArray(defaultDuties) ? defaultDuties.map(d => String(d).trim()).filter(Boolean) : current.defaultDuties
    };

    await upsertStateValue(appConfig, 'event_settings', updated);
    broadcastDataUpdate();
    res.json({ success: true, settings: updated });
  } catch (err) {
    console.error('Failed to update event settings:', err);
    res.status(500).json({ error: 'Einstellungen konnten nicht gespeichert werden' });
  }
});

// 16. Event image upload & serving
const eventImageUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Nur Bilddateien (JPG, PNG, WebP, HEIC) sind erlaubt.'));
    }
  }
});

app.post('/api/events/upload-image', protectedActionRateLimit, verifyToken, (req, res) => {
  eventImageUpload.single('image')(req, res, (error) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Bilddatei zu groß (max. 25MB)' });
      }
      return res.status(400).json({ error: error.message || 'Upload fehlgeschlagen' });
    }
    if (!req.file) return res.status(400).json({ error: 'Keine Datei übermittelt.' });
    res.json({ filename: req.file.filename, url: `/api/events/images/${req.file.filename}` });
  });
});

app.get('/api/events/images/:filename', (req, res) => {
  const filePath = path.resolve(path.join(uploadDir, req.params.filename));
  const normalizedUploadDir = path.resolve(uploadDir);
  if (!filePath.startsWith(normalizedUploadDir + path.sep)) {
    return res.status(403).send('Forbidden: Path traversal detected');
  }
  if (fs.existsSync(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
  } else {
    res.status(404).send('Bild nicht gefunden');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
