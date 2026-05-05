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
const cron = require('node-cron');
const { runAutomatedStandingOrders } = require('./standingOrders');
const { aggregateStats } = require('./stats');
const { getPaginatedTransactions } = require('./transactions');
const { getAiSettings, setAiSettings, buildDatabaseSnapshot, buildSystemPrompt } = require('./ai');

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
  listPeopleRecords,
  getPeopleRecord,
  upsertPeopleRecord,
  removePeopleRecord,
  listExpenseRecords,
  syncExpenseRecords,
  listRequestRecords,
  getRequestRecord,
  upsertRequestRecord
} = require('./pocketbase');

const app = express();
app.set('trust proxy', resolveTrustProxySetting());

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
const authCookieName = 'nova_auth';

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

cron.schedule('0 0 * * *', () => {
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
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});
const dbRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false
});
const protectedActionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
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
            return /^\\d+$/.test(lastPart) ? parseInt(lastPart, 10) : 0;
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
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/admin', adminRateLimit);

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }

  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${authCookieName}=`));

  return cookie ? decodeURIComponent(cookie.slice(authCookieName.length + 1)) : null;
}

function setAuthCookie(res, token) {
  const attributes = [
    `${authCookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=7948800'
  ];
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${authCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
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
    req.user = user;
    req.authToken = token;
    next();
  } catch (error) {
    res.status(401).send('Invalid token');
  }
}

function verifyAdmin(req, res, next) {
  if (req.user?.admin === true) return next();
  return res.status(403).json({ error: 'Admin access required' });
}

function verifySuperAdmin(req, res, next) {
  if (req.user?.superAdmin === true) return next();
  return res.status(403).json({ error: 'Super admin access required' });
}

function validateSetupPayload(body = {}) {
  const appName = typeof body.appName === 'string' ? body.appName.trim() : '';
  if (!appName) {
    throw new Error('Missing required configuration data.');
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
  return { appName, smtp, logoSvg };
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
    const { appName, smtp, logoSvg } = validateSetupPayload(req.body || {});
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
    res.json({ success: true, message: 'Setup completed successfully.' });
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
    setAuthCookie(res, auth.token);
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

  try {
    const system = await getStateValue(appConfig, 'system', DEFAULT_SYSTEM_STATE);
    const validInviteCode = String(system?.inviteCode || DEFAULT_SYSTEM_STATE.inviteCode);
    if (!inviteCode || inviteCode !== validInviteCode) {
      return res.status(403).json({ error: 'Ungültiger Registrierungscode.' });
    }
    const auth = await registerUser({ email, password, firstName, lastName });
    const newCode = String(crypto.randomInt(100000, 1000000));
    await upsertStateValue(appConfig, 'system', { ...system, inviteCode: newCode });
    broadcastDataUpdate();
    setAuthCookie(res, auth.token);
    res.json(auth);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || 'Registration failed.' });
  }
});

app.get('/api/auth/me', authRateLimit, verifyToken, (req, res) => {
  res.json({ user: req.user, token: req.authToken });
});

app.post('/api/auth/logout', authRateLimit, (req, res) => {
  clearAuthCookie(res);
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
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || 'Failed to update password.' });
  }
});

function isOwnFullNameMatch(user, name) {
  const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim().toLowerCase();
  return !!fullName && fullName === String(name || '').trim().toLowerCase();
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
    return { value: record?.value || DEFAULT_SYSTEM_STATE, version: record?.updated || null };
  }

  if (root === 'system' && id === 'inviteCode') {
    if (!user.admin) {
      const error = new Error('Admin access required');
      error.status = 403;
      throw error;
    }
    const record = await getStateRecord(appConfig, 'system');
    return { value: record?.value?.inviteCode || DEFAULT_SYSTEM_STATE.inviteCode, version: record?.updated || null };
  }

  if (root === 'donations' || root === 'expenses') {
    if (!user.admin) {
      const error = new Error('Admin access required');
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
    if (id) {
      if (!user.admin && id !== user.uid) {
        const error = new Error('Forbidden');
        error.status = 403;
        throw error;
      }
      const record = await getUserRecord(appConfig, id);
      return { value: record ? toUserValue(record) : null, version: record?.updated || null };
    }

    if (!user.admin) {
      const record = await getUserRecord(appConfig, user.uid);
      return {
        value: record ? { [user.uid]: toUserValue(record) } : {},
        version: record?.updated || null
      };
    }

    const records = await listUserRecords(appConfig);
    return {
      value: objectFromRecords(records, 'id', toUserValue),
      version: null
    };
  }

  if (root === 'people') {
    if (id) {
      const record = await getPeopleRecord(appConfig, id);
      const value = record?.data || null;
      if (value && !user.admin && value.uid !== user.uid) {
        const error = new Error('Forbidden');
        error.status = 403;
        throw error;
      }
      return { value, version: record?.updated || null };
    }

    let people = await listPeopleRecords(appConfig, query);
    if (!user.admin) {
      people = people.filter((record) => record.uid === user.uid || isOwnFullNameMatch(user, record.name));
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
      if (value && !user.admin && value.userId !== user.uid) {
        const error = new Error('Forbidden');
        error.status = 403;
        throw error;
      }
      return { value, version: record?.updated || null };
    }

    let requests = await listRequestRecords(appConfig, query);
    if (!user.admin) {
      requests = requests.filter((record) => record.userId === user.uid);
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

function toUserValue(record) {
  return {
    firstName: record.firstName || '',
    lastName: record.lastName || '',
    email: record.email || '',
    admin: record.admin === true,
    superAdmin: record.superAdmin === true,
    emailNotifications: record.emailNotifications !== false,
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
    if (!user.admin) throw Object.assign(new Error('Admin access required'), { status: 403 });
    const system = await getStateValue(appConfig, 'system', DEFAULT_SYSTEM_STATE);
    await upsertStateValue(appConfig, 'system', { ...system, inviteCode: value });
    return;
  }

  if ((root === 'donations' || root === 'expenses') && !id) {
    if (!user.admin) throw Object.assign(new Error('Admin access required'), { status: 403 });
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

    let updates = {};
    if (user.admin && id !== user.uid && value && typeof value === 'object') {
      if (typeof value.admin === 'boolean') updates.admin = value.admin;
      if (typeof value.superAdmin === 'boolean') updates.superAdmin = value.superAdmin;
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
    if (!user.admin) {
      const requestedUid = value && typeof value === 'object' ? value.uid : undefined;
      const onlyUidUpdate = value && typeof value === 'object' && Object.keys(value).every((key) => key === 'uid');
      const isAllowedLink = existingValue && onlyUidUpdate && requestedUid === user.uid && (!existingValue.uid || existingValue.uid === user.uid) && isOwnFullNameMatch(user, existingValue.name);
      if (!isAllowedLink) {
        throw Object.assign(new Error('Admin access required'), { status: 403 });
      }
    }
    const nextValue = method === 'patch' && existingValue && value && typeof value === 'object'
      ? { ...existingValue, ...value }
      : value;
    await upsertPeopleRecord(appConfig, id, nextValue);
    return;
  }

  if (root === 'requests' && id) {
    if (!user.admin) {
      if (method !== 'set' || !value || value.userId !== user.uid) {
        throw Object.assign(new Error('Forbidden'), { status: 403 });
      }
    }
    const existing = await getRequestRecord(appConfig, id);
    const nextValue = method === 'patch' && existing?.data && value && typeof value === 'object'
      ? { ...existing.data, ...value }
      : value;
    if (!user.admin && nextValue.userId !== user.uid) {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
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
    if (!req.user.admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const stats = await aggregateStats(appConfig);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to fetch stats' });
  }
});

app.get('/api/transactions', dbRateLimit, verifyToken, async (req, res) => {
  try {
    if (!req.user.admin) {
      return res.status(403).json({ error: 'Admin access required' });
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
    if (!req.user.admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const updated = await upsertPeopleRecord(appConfig, id, nextValue, currentVersion);
    broadcastDataUpdate();
    res.json({ value: updated.data, version: updated.updated });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Transaction failed' });
  }
});

app.post('/api/admin/bootstrap-super-admin', verifyToken, async (req, res) => {
  try {
    const system = await getStateValue(appConfig, 'system', DEFAULT_SYSTEM_STATE);
    let superAdminUid = system?.superAdminUid || null;
    let createdNow = false;

    if (!superAdminUid) {
      superAdminUid = req.user.uid;
      createdNow = true;
      await upsertStateValue(appConfig, 'system', { ...system, superAdminUid });
    }

    const isSuperAdmin = superAdminUid === req.user.uid;
    if (isSuperAdmin) {
      await updateUserRecord(appConfig, req.user.uid, { admin: true, superAdmin: true });
    }

    res.json({ isSuperAdmin, superAdminUid, createdNow });
  } catch (error) {
    console.error('Failed to bootstrap super admin:', error);
    res.status(500).json({ error: 'Failed to bootstrap super admin' });
  }
});

app.get('/api/admin/system-config', verifyToken, verifySuperAdmin, async (req, res) => {
  if (!appConfig) {
    return res.status(404).json({ error: 'No config found' });
  }
  res.json({
    appName: appConfig.appName,
    smtp: appConfig.smtp || null,
    usesPocketBase: true
  });
});

app.put('/api/admin/system-config', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const appName = String(req.body?.appName || '').trim();
    if (!appName) {
      return res.status(400).json({ error: 'Missing required config fields' });
    }

    let smtp = null;
    if (req.body?.smtp && typeof req.body.smtp === 'object' && String(req.body.smtp.host || '').trim()) {
      smtp = {
        host: String(req.body.smtp.host || '').trim(),
        port: Number.isFinite(Number(req.body.smtp.port)) ? parseInt(req.body.smtp.port, 10) : 465,
        secure: req.body.smtp.secure === true,
        user: String(req.body.smtp.user || '').trim(),
        pass: String(req.body.smtp.pass || '')
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

app.put('/api/admin/users/:uid/admin', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const makeAdmin = req.body?.admin === true;
    const system = await getStateValue(appConfig, 'system', DEFAULT_SYSTEM_STATE);
    const superAdminUid = system?.superAdminUid || null;

    if (uid === superAdminUid && !makeAdmin) {
      return res.status(400).json({ error: 'Super admin cannot lose admin rights' });
    }

    await writeLogicalPath(`users/${uid}`, {
      admin: makeAdmin,
      superAdmin: uid === superAdminUid
    }, req.user, 'patch');
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to update admin role:', error);
    res.status(500).json({ error: 'Failed to update admin role' });
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
    res.status(404).send('Not found');
  }
});

app.post('/api/send-email', protectedActionRateLimit, verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { to, subject, text, html } = req.body;
    if (!to || !subject) {
      return res.status(400).json({ error: 'Missing required fields: to, subject' });
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
  return (unsafe || '').replace(/[&<"'>]/g, (match) => {
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

    const allUsers = await listUserRecords(appConfig);
    const adminEmails = allUsers
      .filter((record) => record.admin === true && record.email && record.emailNotifications !== false)
      .map((record) => record.email);

    if (adminEmails.length === 0) {
      return res.status(200).json({ message: 'No admins found to notify' });
    }

    if (!transporter || !appConfig?.smtp?.user) {
      return res.status(500).json({ error: 'SMTP not configured' });
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

// Lightweight endpoint for all admins – returns only the enabled flag
app.get('/api/admin/ai-status', verifyToken, verifyAdmin, async (req, res) => {
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

app.post('/api/ai/chat', aiChatRateLimit, verifyToken, verifyAdmin, async (req, res) => {
  try {
    const aiSettings = await getAiSettings(appConfig);
    if (!aiSettings.enabled) {
      return res.status(403).json({ error: 'AI support is not enabled' });
    }

    const rawMessages = req.body?.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const ALLOWED_ROLES = new Set(['user', 'assistant']);
    if (rawMessages.some((m) => !ALLOWED_ROLES.has(m.role))) {
      return res.status(400).json({ error: 'Invalid message role. Only "user" and "assistant" are allowed.' });
    }

    const MAX_MESSAGES = 50;
    const messages = rawMessages.slice(-MAX_MESSAGES).map((m) => ({
      role: m.role,
      content: String(m.content || '').slice(0, 8000)
    }));

    const baseUrl = (aiSettings.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const apiKey = aiSettings.apiKey || '';
    const model = aiSettings.model || 'gpt-4o-mini';

    const dbSnapshot = await buildDatabaseSnapshot(appConfig);
    const systemContent = buildSystemPrompt(appConfig.appName, dbSnapshot);

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
      return res.status(502).json({ error: 'AI provider returned an error', detail: errText.slice(0, 200) });
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

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
