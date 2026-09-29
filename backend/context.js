const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { rateLimit } = require('express-rate-limit');
const { isSafeSvg } = require('./svgValidation');
const { resolveDataDirectory, resolveFrontendDirectory } = require('./pathConfig');
const { runAutomatedStandingOrders } = require('./standingOrders');
const { withDecisionTimestamp, isExpiredRequest, purgeExpiredRequests } = require('./requestRetention');

const {
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_STATE,
  normalizeDataPath,
  sanitizeSelfUserWrite,
  ensurePocketBaseSuperuser,
  ensurePocketBaseSchema,
  verifyUserToken,
  getStateValue,
  upsertStateValue,
  getStateRecord,
  getUserRecord,
  listUserRecords,
  updateUserRecord,
  isPlaceholderEmail,
  listGroupRecords,
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
  getMentorByUserId,
  toPublicUser,
  findUserByCalendarToken
} = require('./pocketbase');

const {
  sendPushToUser
} = require('./pushNotifications');

const sseClients = new Set();
function broadcastDataUpdate() {
  for (const client of sseClients) {
    client.write('event: data_update\ndata: {}\n\n');
  }
}

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

const profilesDir = path.join(dataDir, 'profiles');
if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir);

const context = {
  appConfig: null,
  setupMode: true,
  transporter: null,
  runtimeReady: Promise.resolve()
};

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

function userWantsNotification(user, type) {
  if (!user) return false;
  if (user.notificationSettings && typeof user.notificationSettings === 'object') {
    if (typeof user.notificationSettings[type] === 'boolean') {
      return user.notificationSettings[type];
    }
  }
  return user.emailNotifications !== false;
}

async function initializeRuntime(config) {
  if (!config?.appName || !config?.pocketbase?.adminEmail || !config?.pocketbase?.adminPassword) {
    context.appConfig = null;
    context.setupMode = true;
    context.transporter = null;
    console.log('No valid config found. Starting in setup mode.');
    return;
  }

  await ensurePocketBaseSuperuser(config);
  await ensurePocketBaseSchema(config);
  await upsertStateValue(config, 'settings', await getStateValue(config, 'settings', DEFAULT_SETTINGS));
  await upsertStateValue(config, 'system', await getStateValue(config, 'system', DEFAULT_SYSTEM_STATE));

  context.appConfig = config;
  context.setupMode = false;
  context.transporter = buildSmtpTransport(config.smtp || null);
  console.log('Configuration loaded successfully. Setup mode: false');

  runAutomatedStandingOrders(context.appConfig);
  purgeExpiredRequests(context.appConfig);
}

function setRuntimeConfig(config) {
  context.runtimeReady = initializeRuntime(config).catch((error) => {
    console.error('Runtime initialization failed:', error);
    context.appConfig = null;
    context.setupMode = true;
    context.transporter = null;
    throw error;
  });
  return context.runtimeReady;
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
const adminRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});
const aiChatRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

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
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'];
const imageFileFilter = (errorMessage) => (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (IMAGE_MIME_TYPES.includes(file.mimetype) && IMAGE_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(errorMessage));
  }
};
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: imageFileFilter('Invalid file type. Only JPG, PNG, WEBP, GIF, HEIC, and HEIF are allowed.')
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
const eventImageUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: imageFileFilter('Nur Bilddateien (JPG, PNG, WebP, HEIC) sind erlaubt.')
});

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
  const maxAgeSeconds = 315360000;
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

async function loadUserWithPermissions(token) {
  const user = await verifyUserToken(token);
  let allGroups = [];
  try {
    allGroups = await listGroupRecords(context.appConfig);
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
  return user;
}

async function verifyToken(req, res, next) {
  if (context.setupMode) {
    return res.status(503).send('App is in setup mode. Please complete setup first.');
  }

  try {
    await context.runtimeReady;
  } catch {
    return res.status(503).send('PocketBase is still starting. Please try again.');
  }

  const token = extractBearerToken(req);
  if (!token) return res.status(401).send('Unauthorized');

  try {
    const user = await loadUserWithPermissions(token);
    try {
      const mentorRec = await getMentorByUserId(context.appConfig, user.id);
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
  const [root, id] = normalizedPath.split('/');

  if (!user) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }

  if (root === 'settings' && !id) {
    const record = await getStateRecord(context.appConfig, 'settings');
    return { value: record?.value || DEFAULT_SETTINGS, version: record?.updated || null };
  }

  if (root === 'system' && !id) {
    if (!user.admin) {
      const error = new Error('Admin access required');
      error.status = 403;
      throw error;
    }
    const record = await getStateRecord(context.appConfig, 'system');
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
    const record = await getStateRecord(context.appConfig, 'system');
    return { value: record?.value?.inviteCode || DEFAULT_SYSTEM_STATE.inviteCode, version: record?.updated || null };
  }

  if (root === 'donations' || root === 'expenses') {
    if (!user.canViewFinances) {
      const error = new Error('Financial access required');
      error.status = 403;
      throw error;
    }
    if (root === 'expenses') {
      const records = await listExpenseRecords(context.appConfig);
      return {
        value: objectFromRecords(records, 'expenseKey', (record) => record.data),
        version: null
      };
    }
    const record = await getStateRecord(context.appConfig, root);
    return { value: record?.value || {}, version: record?.updated || null };
  }

  if (root === 'users') {
    let allGroups = [];
    try {
      allGroups = await listGroupRecords(context.appConfig);
    } catch { /* ignore */ }

    if (id) {
      if (!user.admin && id !== user.uid) {
        const error = new Error('Forbidden');
        error.status = 403;
        throw error;
      }
      const record = await getUserRecord(context.appConfig, id);
      return { value: record ? toUserValue(record, allGroups) : null, version: record?.updated || null };
    }

    if (!user.admin) {
      const record = await getUserRecord(context.appConfig, user.uid);
      return {
        value: record ? { [user.uid]: toUserValue(record, allGroups) } : {},
        version: record?.updated || null
      };
    }

    const records = await listUserRecords(context.appConfig);
    return {
      value: objectFromRecords(records, 'id', (record) => toUserValue(record, allGroups)),
      version: null
    };
  }

  if (root === 'people') {
    if (id) {
      const record = await getPeopleRecord(context.appConfig, id);
      const value = record?.data || null;
      if (value && !user.canViewFinances && value.uid !== user.uid && !isOwnFullNameMatch(user, value.name || record?.name)) {
        const error = new Error('Forbidden');
        error.status = 403;
        throw error;
      }
      return { value, version: record?.updated || null };
    }

    let people = await listPeopleRecords(context.appConfig, query);
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
      const record = await getRequestRecord(context.appConfig, id);
      const value = record?.data || null;
      if (value && !user.canViewFinances && value.userId !== user.uid && record?.userId !== user.uid) {
        const error = new Error('Forbidden');
        error.status = 403;
        throw error;
      }
      return { value, version: record?.updated || null };
    }

    // Approved / rejected requests are only shown for 30 days (the daily cleanup deletes them)
    let requests = (await listRequestRecords(context.appConfig, query)).filter((record) => !isExpiredRequest(record));
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
    await upsertStateValue(context.appConfig, 'settings', value || DEFAULT_SETTINGS);
    return;
  }

  if (root === 'system' && id === 'inviteCode' && !nested) {
    if (!user.canManageRegistrationCode) throw Object.assign(new Error('Registrierungscode-Verwaltungsrechte erforderlich'), { status: 403 });
    const system = await getStateValue(context.appConfig, 'system', DEFAULT_SYSTEM_STATE);
    await upsertStateValue(context.appConfig, 'system', { ...system, inviteCode: value });
    return;
  }

  if ((root === 'donations' || root === 'expenses') && !id) {
    if (!user.canManageFinances) throw Object.assign(new Error('Finanzverwaltungsrechte erforderlich'), { status: 403 });
    if (root === 'expenses') {
      await syncExpenseRecords(context.appConfig, value || {});
      return;
    }
    await upsertStateValue(context.appConfig, root, value || {});
    return;
  }

  if (root === 'users' && id) {
    if (id !== user.uid && !user.admin) {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }

    const existing = await getUserRecord(context.appConfig, id);
    if (!existing) {
      throw Object.assign(new Error('User not found'), { status: 404 });
    }

    const system = await getStateValue(context.appConfig, 'system', DEFAULT_SYSTEM_STATE);
    const ownerUid = system?.ownerUid || system?.superAdminUid || null;
    const isTargetOwner = id === ownerUid || existing.owner === true || existing.superAdmin === true;

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

    await updateUserRecord(context.appConfig, id, updates);
    return;
  }

  if (root === 'people' && id) {
    const existing = await getPeopleRecord(context.appConfig, id);
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
    await upsertPeopleRecord(context.appConfig, id, nextValue);
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
    const existing = await getRequestRecord(context.appConfig, id);
    if (existing && existing.data && !canManageRequests && String(existing.data.userId || existing.userId) !== String(user.uid)) {
      throw Object.assign(new Error('Finanzverwaltungsrechte erforderlich'), { status: 403 });
    }
    const mergedValue = method === 'patch' && existing?.data && value && typeof value === 'object'
      ? { ...existing.data, ...value }
      : value;
    // Remember when the request was approved or rejected (starts the 30-day retention)
    const nextValue = withDecisionTimestamp(existing?.data, mergedValue);
    if (!nextValue.userId) {
      nextValue.userId = user.uid;
    }
    if (!canManageRequests && String(nextValue.userId) !== String(user.uid)) {
      throw Object.assign(new Error('Finanzverwaltungsrechte erforderlich'), { status: 403 });
    }
    await upsertRequestRecord(context.appConfig, id, nextValue);
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
    await removePeopleRecord(context.appConfig, id);
    return;
  }
  throw Object.assign(new Error('Unknown path'), { status: 404 });
}

// Default finance record for a member who has none yet
function newPersonRecord(uid, name, memberSince, pays = true) {
  return {
    id: uid,
    uid,
    name,
    status: 'vollverdiener',
    memberSince,
    originalMemberSince: memberSince,
    totalPaid: 0,
    pays,
    standingOrders: [],
    statusHistory: [{ status: 'vollverdiener', startDate: memberSince }]
  };
}

async function verifyOptionalUser(req) {
  const token = extractBearerToken(req);
  if (!token) return null;
  try {
    const user = await loadUserWithPermissions(token);
    return { user, token };
  } catch {
    return null;
  }
}

async function sendDutyRequestNotificationEmail({ recipientUserId, requestedByUserId, event, duty, appConfig, sendEmailRequested = true }) {
  if (sendEmailRequested === false) {
    return { skipped: true, reason: 'user_disabled' };
  }
  try {
    const allUsers = await listUserRecords(appConfig);
    const requester = allUsers.find(u => u.id === requestedByUserId);
    const requesterName = requester ? (requester.name || `${requester.firstName || ''} ${requester.lastName || ''}`.trim() || requester.email) : 'Ein Event-Organisator';
    const dutyName = duty.roleName || duty.section || 'Dienst';

    const recipient = allUsers.find(u => u.id === recipientUserId);

    if (userWantsNotification(recipient, 'duties')) {
      sendPushToUser(appConfig, recipientUserId, {
        title: `Dienstanfrage: ${dutyName}`,
        body: `${requesterName} hat dich für "${dutyName}" bei "${event.title || 'Event'}" angefragt.`,
        data: { url: '/#events' }
      }).catch(err => console.warn('[WebPush] Failed sending duty push:', err.message));
    }

    if (!context.transporter || !appConfig?.smtp?.user || !appConfig?.smtp?.host) {
      return { skipped: true, reason: 'smtp_not_configured' };
    }

    if (!recipient || !recipient.email || !userWantsNotification(recipient, 'duties')) {
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

    const info = await context.transporter.sendMail({
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

function generateIcsCalendar(events, calendarName = 'Agora Events', currentUid = null, allDuties = []) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Agora//Event Calendar//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    'X-WR-TIMEZONE:Europe/Berlin',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H'
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

    let dutiesInfo = '';
    if (currentUid && Array.isArray(allDuties)) {
      const myDuties = allDuties.filter(d => d.event === ev.id && (d.assignedUser === currentUid || d.requestedUser === currentUid));
      if (myDuties.length > 0) {
        dutiesInfo = myDuties.map(d => {
          const isReq = d.requestedUser === currentUid && d.assignedUser !== currentUid;
          return `• ${d.role || 'Dienst'}${isReq ? ' (Anfrage ausstehend)' : ' (Eingeteilt)'}`;
        }).join('\n');
      }
    }

    lines.push(`SUMMARY:${escapeIcsText(ev.title || 'Event')}`);

    let descriptionText = ev.description || '';
    if (dutiesInfo) {
      descriptionText = `[MEINE DIENSTE]\n${dutiesInfo}\n\n${descriptionText}`.trim();
    }
    if (descriptionText) lines.push(`DESCRIPTION:${escapeIcsText(descriptionText)}`);
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

  if (event.createdBy === currentUid) return true;

  const canManage = user.canManageEvents === true || (Array.isArray(user.permissions) && user.permissions.includes('manage_events'));
  if (canManage) {
    return true;
  }

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

async function authenticateCalendarFeed(req, res, next) {
  if (context.setupMode) {
    return res.status(503).send('App is in setup mode');
  }

  try {
    await context.runtimeReady;
  } catch {
    return res.status(503).send('PocketBase is still starting. Please try again.');
  }

  const tokenParam = (req.query && req.query.token && typeof req.query.token === 'string') ? req.query.token.trim() : null;
  const userParam = (req.query && (req.query.user || req.query.uid) && typeof (req.query.user || req.query.uid) === 'string') ? (req.query.user || req.query.uid).trim() : null;

  let authenticatedUser = null;

  if (userParam && tokenParam) {
    try {
      const userRecord = await getUserRecord(context.appConfig, userParam);
      if (userRecord && userRecord.calendarToken && userRecord.calendarToken === tokenParam) {
        authenticatedUser = toPublicUser(userRecord);
      }
    } catch {}
  }

  if (!authenticatedUser && tokenParam) {
    try {
      const matched = await findUserByCalendarToken(context.appConfig, tokenParam);
      if (matched) {
        authenticatedUser = toPublicUser(matched);
      }
    } catch {}
  }

  if (!authenticatedUser) {
    const bearer = extractBearerToken(req);
    if (bearer) {
      try {
        authenticatedUser = await verifyUserToken(bearer);
      } catch {}
    }
  }

  if (!authenticatedUser) {
    return res.status(401).send('Unauthorized: Ungültiger oder abgelaufener Kalender-Link');
  }

  let allGroups = [];
  try {
    allGroups = await listGroupRecords(context.appConfig);
  } catch { /* ignore */ }
  const groupPerms = resolveUserPermissions(authenticatedUser.groups, allGroups);
  authenticatedUser.permissions = groupPerms.permissions;
  authenticatedUser.canManageFinances = groupPerms.canManageFinances;
  authenticatedUser.canViewFinances = groupPerms.canViewFinances;
  authenticatedUser.canManageRegistrationCode = groupPerms.canManageRegistrationCode === true;
  authenticatedUser.canAccessAi = groupPerms.canAccessAi;
  authenticatedUser.canParticipateMentoring = groupPerms.canParticipateMentoring;
  authenticatedUser.canManageMentoring = groupPerms.canManageMentoring;
  authenticatedUser.canManageEvents = groupPerms.canManageEvents === true;

  req.user = authenticatedUser;
  next();
}

module.exports = {
  context,
  sseClients,
  broadcastDataUpdate,
  dataDir,
  configFile,
  resolvedFrontendDir,
  bundledChurchLogoFile,
  churchLogoFile,
  uploadDir,
  profilesDir,
  authCookieName,
  legacyAuthCookieName,
  buildSmtpTransport,
  userWantsNotification,
  initializeRuntime,
  setRuntimeConfig,
  loadConfig,
  logoAssetRateLimit,
  pageRateLimit,
  setupRateLimit,
  authRateLimit,
  dbRateLimit,
  protectedActionRateLimit,
  adminRateLimit,
  aiChatRateLimit,
  upload,
  logoUpload,
  profileUpload,
  eventImageUpload,
  extractBearerToken,
  setAuthCookie,
  clearAuthCookie,
  verifyToken,
  verifyAdmin,
  verifyAiAccess,
  verifyMentoringParticipate,
  verifyManageMentoring,
  verifySuperAdmin,
  validateSetupPayload,
  saveOptionalLogo,
  isOwnFullNameMatch,
  objectFromRecords,
  readLogicalPath,
  toUserValue,
  writeLogicalPath,
  removeLogicalPath,
  verifyOptionalUser,
  newPersonRecord,
  sendDutyRequestNotificationEmail,
  escapeHtml,
  userMatchesTargetGroups,
  DEFAULT_EVENT_SETTINGS,
  formatIcsDateTime,
  escapeIcsText,
  generateIcsCalendar,
  canUserAccessEventDutyPlan,
  addDaysDriftFree,
  getNextRecurringDate,
  authenticateCalendarFeed
};
