// Who asks: the session token (the Authorization header, the cookie, or the query of the live-update stream), its
// account with what the account's groups give (permissions.js), kept a few seconds per token - and the guards of the
// routes.
const { context } = require('./context');
const { runAs } = require('./actor');
const { isAdmin, can, resolveUserPermissions } = require('./permissions');
const { verifyUserToken, listGroupRecords, getMentorByUserId, getUserRecord, findUserByCalendarToken, toPublicUser } = require('./pocketbase');

const authCookieName = 'agora_auth';
const legacyAuthCookieName = 'nova_auth';

function extractBearerToken(req) {
  // In the query string (ends up in logs and Referer headers) only for the live-update stream, where an
  // EventSource cannot send headers; every client sends a cookie or Authorization header everywhere else
  const isStream = (req.path || req.originalUrl || '').split('?')[0] === '/api/stream';
  if (isStream && req.query && req.query.token && typeof req.query.token === 'string') {
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

/** [user] with what their groups give (permissions.js); while the groups cannot be read, nothing. */
async function withGroupPermissions(user) {
  const groups = await listGroupRecords(context.appConfig).catch(() => []);
  return Object.assign(user, resolveUserPermissions(user.groups, groups));
}

async function loadUserWithPermissions(token) {
  return withGroupPermissions(await verifyUserToken(token));
}

// verifyToken needs three PocketBase lookups per request, and clients send bursts (a page load is ~25 requests).
// The resolved user is kept for a few seconds per token; any write request or data broadcast clears the cache,
// so changed permissions, passwords or deleted accounts apply immediately.
const AUTH_CACHE_TTL_MS = 5000;
const AUTH_CACHE_MAX = 500;
const authCache = new Map();

function invalidateAuthCache() {
  authCache.clear();
}

async function resolveRequestUser(token) {
  const user = await loadUserWithPermissions(token);
  try {
    const mentorRec = await getMentorByUserId(context.appConfig, user.id);
    user.mentorStatus = mentorRec?.status || null;
    user.isApprovedMentor = mentorRec?.status === 'approved';
  } catch {
    user.mentorStatus = null;
    user.isApprovedMentor = false;
  }
  return user;
}

function cachedRequestUser(token) {
  const now = Date.now();
  let entry = authCache.get(token);
  if (!entry || entry.expires <= now) {
    if (authCache.size >= AUTH_CACHE_MAX) authCache.clear();
    entry = { expires: now + AUTH_CACHE_TTL_MS, promise: resolveRequestUser(token) };
    entry.promise.catch(() => {
      if (authCache.get(token) === entry) authCache.delete(token);
    });
    authCache.set(token, entry);
  }
  // Every request gets its own copy: routes may change req.user
  return entry.promise.then(user => structuredClone(user));
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
    // Writes always resolve the user freshly and drop the cache once they are done
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (!isRead) res.on('finish', invalidateAuthCache);
    const user = isRead ? await cachedRequestUser(token) : await resolveRequestUser(token);
    req.user = user;
    req.authToken = token;
    // Everything this request does is done by this person (the finance change log records it)
    return runAs(user, () => next());
  } catch (error) {
    res.status(401).send('Invalid token');
  }
}

/** Middleware: the request goes on when [allowed](the person asking), else 403 with [text]. */
const requires = (allowed, text) => (req, res, next) => (allowed(req.user) ? next() : res.status(403).json({ error: text }));
const verifyAdmin = requires(isAdmin, 'Admin access required');
const verifyAiAccess = requires((user) => can(user, 'access_ai'), 'AI permission required');
const verifyManageMentoring = requires((user) => can(user, 'manage_mentoring'), 'Mentor management rights required');


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
    return res.status(401).send('Unauthorized: invalid or expired calendar link');
  }

  req.user = await withGroupPermissions(authenticatedUser);
  next();
}

module.exports = {
  setAuthCookie,
  clearAuthCookie,
  withGroupPermissions,
  invalidateAuthCache,
  resolveRequestUser,
  verifyToken,
  verifyOptionalUser,
  authenticateCalendarFeed,
  requires,
  verifyAdmin,
  verifyAiAccess,
  verifyManageMentoring
};
