// Media (Extras): browse, view and add to the Nextcloud folder of the community (rules and paths in media.js,
// the Nextcloud calls in nextcloud.js). Every request is checked here; Nextcloud only ever sees the bot account.
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { Readable } = require('stream');
const {
  context,
  dataDir,
  verifyToken,
  verifyAdmin,
  protectedActionRateLimit,
  broadcastDataUpdate
} = require('../context');
const { getStateValue, upsertStateValue, listGroupRecords, queueRecordWrite } = require('../pocketbase');
const { loadSecret } = require('../polls');
const media = require('../media');
const nextcloud = require('../nextcloud');

const router = express.Router();

const SETTINGS_KEY = 'media';
const RULES_KEY = 'media_rules';
const DEFAULT_SETTINGS = { enabled: false, url: '', user: '', password: '', root: '' };
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_UPLOAD_FILES = 50;
/** Nextcloud makes previews one by one per request; a grid of 200 pictures must not start 200 at once. */
const MAX_PARALLEL_PREVIEWS = 8;

let secret = null;
const mediaSecret = () => (secret ||= loadSecret(dataDir, 'media-secret'));

// Settings and rules are read for every thumbnail: kept in memory, read again after a change or a minute
const CACHE_MS = 60_000;
const cache = { settings: null, rules: null };
const cached = async (key, load) => {
  const entry = cache[key];
  if (entry && entry.expires > Date.now()) return entry.value;
  const value = await load();
  cache[key] = { value, expires: Date.now() + CACHE_MS };
  return value;
};

const storedSettings = () => cached('settings', async () => ({
  ...DEFAULT_SETTINGS,
  ...(await getStateValue(context.appConfig, SETTINGS_KEY, DEFAULT_SETTINGS))
}));
const storedRules = () => cached('rules', async () => (await getStateValue(context.appConfig, RULES_KEY, { rules: {} }))?.rules || {});

/** The connection with the plain password, or null when Media is switched off or not set up. */
async function connection() {
  const settings = await storedSettings();
  if (!settings.enabled || !settings.url || !settings.user || !settings.password) return null;
  const password = media.decryptSecret(settings.password, mediaSecret());
  if (password === null) return null;
  return { url: settings.url, user: settings.user, password, root: settings.root || '' };
}

const userId = (req) => req.user?.uid || req.user?.id;

function sendError(res, err, fallback) {
  if (err?.name === 'AbortError') return;
  if (/media-secret/.test(err?.message || '')) {
    console.error('[Media]', err.message);
    return res.status(503).json({ error: 'Media is not available right now.' });
  }
  if (err instanceof nextcloud.NextcloudError) {
    if (err.status >= 500) console.warn('[Media]', err.message);
    return res.status(err.status).json({ error: err.message });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

/** The request's path parameter as a clean path, or null after answering 400. */
function pathParam(req, res, value = req.query.path) {
  const clean = media.cleanPath(typeof value === 'string' ? value : '');
  if (clean === null) res.status(400).json({ error: 'Invalid path' });
  return clean;
}

/** Answers 503 when Media is not set up; else the connection and the rules. */
async function ready(res) {
  const conn = await connection();
  if (!conn) {
    res.status(503).json({ error: 'Media is not set up.' });
    return null;
  }
  return { conn, rules: await storedRules() };
}

/** A client that goes away (scrolled past a thumbnail, closed the viewer) also stops the request to Nextcloud. */
function abortOnClose(req, res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

/** Streams a fetch answer to the client (headers already set). */
async function pipeBody(upstream, res) {
  if (!upstream.body) return res.end();
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

let previewsRunning = 0;
const previewQueue = [];
async function withPreviewSlot(work) {
  if (previewsRunning >= MAX_PARALLEL_PREVIEWS) await new Promise((resolve) => previewQueue.push(resolve));
  previewsRunning += 1;
  try {
    return await work();
  } finally {
    previewsRunning -= 1;
    previewQueue.shift()?.();
  }
}

// Thumbnails: a folder of pictures asks for many at once
const mediaFileRateLimit = rateLimit({ windowMs: 60 * 1000, max: 3000, standardHeaders: true, legacyHeaders: false });

// --- For everyone: is there anything to see? ---

router.get('/api/media/status', verifyToken, async (req, res) => {
  try {
    const enabled = !!(await connection());
    const rules = enabled ? await storedRules() : {};
    res.json({
      enabled,
      canManage: media.canManageMedia(req.user),
      hasAccess: enabled && media.hasAnyAccess(rules, req.user)
    });
  } catch (err) {
    sendError(res, err, 'Media could not be loaded');
  }
});

// --- Browse ---

router.get('/api/media/list', verifyToken, async (req, res) => {
  const folder = pathParam(req, res);
  if (folder === null) return;
  try {
    const setup = await ready(res);
    if (!setup) return;
    // Not visible: the same answer as a folder that is not there
    if (!media.canSeeFolder(setup.rules, folder, req.user)) return res.status(404).json({ error: 'Folder not found' });
    const listing = await nextcloud.listFolder(setup.conn, folder, { signal: abortOnClose(req, res) });
    const view = media.filterListing(setup.rules, folder, req.user, listing);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json({
      path: folder,
      name: folder ? media.nameOf(folder) : '',
      access: view.access,
      canManage: media.canManageMedia(req.user),
      folders: view.folders.map(({ etag, fileId, ...folderEntry }) => folderEntry),
      files: view.files.map(({ fileId, ...file }) => ({ ...file, kind: media.fileKind(file.contentType, file.name) }))
    });
  } catch (err) {
    sendError(res, err, 'The folder could not be loaded');
  }
});

/** The file [p] if [req.user] may read it (in a folder they may read), else answers and returns null. */
async function readableFile(req, res) {
  const file = pathParam(req, res);
  if (file === null) return null;
  if (!file) {
    res.status(400).json({ error: 'Invalid path' });
    return null;
  }
  const setup = await ready(res);
  if (!setup) return null;
  if (media.folderAccess(setup.rules, media.parentOf(file), req.user) === 'none') {
    res.status(404).json({ error: 'File not found' });
    return null;
  }
  return { file, conn: setup.conn };
}

router.get('/api/media/preview', mediaFileRateLimit, verifyToken, async (req, res) => {
  try {
    const target = await readableFile(req, res);
    if (!target) return;
    const size = media.previewSize(req.query.size);
    const crop = req.query.crop === '1';
    const signal = abortOnClose(req, res);
    const upstream = await withPreviewSlot(() => {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return nextcloud.preview(target.conn, target.file, { size, crop, signal });
    });
    res.setHeader('Content-Type', upstream.headers.get('content-type'));
    const length = upstream.headers.get('content-length');
    if (length) res.setHeader('Content-Length', length);
    // The app adds the file's version (?v=etag): the same address always shows the same picture
    res.setHeader('Cache-Control', req.query.v ? 'private, max-age=2592000, immutable' : 'private, max-age=300');
    await pipeBody(upstream, res);
  } catch (err) {
    sendError(res, err, 'The preview could not be loaded');
  }
});

/** "Grüße.pdf" for Content-Disposition (RFC 6266 with an ASCII fallback). */
const dispositionName = (name) => `filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

router.get('/api/media/file', mediaFileRateLimit, verifyToken, async (req, res) => {
  try {
    const target = await readableFile(req, res);
    if (!target) return;
    const range = typeof req.headers.range === 'string' && /^bytes=[\d,\s-]+$/.test(req.headers.range) ? req.headers.range : null;
    const upstream = await nextcloud.download(target.conn, target.file, { range, signal: abortOnClose(req, res) });
    const type = String(upstream.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    // Pictures and PDFs open in the browser; anything else (HTML, SVG, scripts …) is only ever a download, so a
    // file in the cloud can never run as a page of the app
    const inline = media.INLINE_TYPES.has(type) && req.query.download !== '1';
    res.status(upstream.status);
    res.setHeader('Content-Type', inline ? type : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; ${dispositionName(media.nameOf(target.file))}`);
    // Opened on its own, nothing in it runs (the browsers' PDF viewers do not work with a sandbox)
    if (type !== 'application/pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, no-cache');
    for (const header of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    await pipeBody(upstream, res);
  } catch (err) {
    sendError(res, err, 'The file could not be loaded');
  }
});

// --- Add: upload files and create folders (write access); nothing is ever replaced or deleted ---

const uploadTmpDir = path.join(os.tmpdir(), 'agora-media-uploads');
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => fs.mkdir(uploadTmpDir, { recursive: true, mode: 0o700 }, (err) => cb(err, uploadTmpDir)),
    filename: (req, file, cb) => cb(null, crypto.randomUUID())
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES }
});

/** The folder [req.user] may write to, else answers and returns null. */
async function writableFolder(req, res, value) {
  const folder = pathParam(req, res, value);
  if (folder === null) return null;
  const setup = await ready(res);
  if (!setup) return null;
  const access = media.folderAccess(setup.rules, folder, req.user);
  if (access !== 'write') {
    res.status(access === 'none' && !media.canSeeFolder(setup.rules, folder, req.user) ? 404 : 403)
      .json({ error: access === 'none' ? 'Folder not found' : 'You may not add anything to this folder.' });
    return null;
  }
  return { folder, conn: setup.conn };
}

/** Stores [file] in [folder] under its name, or "name (2)" … when that is taken. Returns the name used. */
async function storeUpload(conn, folder, file, name) {
  for (let number = 1; number <= 100; number += 1) {
    const candidate = number === 1 ? name : media.numberedName(name, number);
    const stored = await nextcloud.uploadNew(conn, media.joinPath(folder, candidate), {
      stream: fs.createReadStream(file.path),
      size: file.size,
      contentType: file.mimetype
    });
    if (stored) return candidate;
  }
  throw new nextcloud.NextcloudError('There are too many files with this name already.', 409);
}

// The folder comes in the address (?path=…): checked before a single byte of the files is taken in
router.post('/api/media/upload', protectedActionRateLimit, verifyToken, async (req, res) => {
  let target;
  try {
    target = await writableFolder(req, res, req.query.path);
  } catch (err) {
    return sendError(res, err, 'The files could not be uploaded');
  }
  if (!target) return;
  mediaUpload.array('files', MAX_UPLOAD_FILES)(req, res, async (uploadError) => {
    const files = Array.isArray(req.files) ? req.files : [];
    const cleanup = () => Promise.all(files.map((file) => fs.promises.rm(file.path, { force: true })));
    try {
      if (uploadError) {
        const tooBig = uploadError.code === 'LIMIT_FILE_SIZE';
        const tooMany = uploadError.code === 'LIMIT_FILE_COUNT';
        return res.status(tooBig ? 413 : 400).json({
          error: tooBig ? 'A file is larger than 1 GB.' : tooMany ? 'At most 50 files at once.' : 'The upload could not be read.'
        });
      }
      if (!files.length) return res.status(400).json({ error: 'No files selected' });
      const stored = [];
      for (const file of files) {
        // Browsers send the name as UTF-8 in a field multer reads as latin1
        const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const name = media.cleanName(original);
        if (!name || name.startsWith('.')) return res.status(400).json({ error: 'Invalid file name', stored });
        const used = await storeUpload(target.conn, target.folder, file, name);
        stored.push({ name: used, path: media.joinPath(target.folder, used) });
      }
      console.log(`[Media] ${userId(req)} added ${stored.length} file(s) to "/${target.folder}"`);
      broadcastDataUpdate('media');
      res.status(201).json({ files: stored });
    } catch (err) {
      sendError(res, err, 'The files could not be uploaded');
    } finally {
      await cleanup().catch(() => {});
    }
  });
});

router.post('/api/media/folder', protectedActionRateLimit, verifyToken, async (req, res) => {
  try {
    const name = media.cleanName(req.body?.name);
    if (!name || name.startsWith('.')) return res.status(400).json({ error: 'Invalid folder name' });
    const target = await writableFolder(req, res, req.body?.path);
    if (!target) return;
    const folderPath = media.joinPath(target.folder, name);
    if (!(await nextcloud.createFolder(target.conn, folderPath))) {
      return res.status(409).json({ error: 'There is already something with this name.' });
    }
    broadcastDataUpdate('media');
    res.status(201).json({ name, path: folderPath });
  } catch (err) {
    sendError(res, err, 'The folder could not be created');
  }
});

// --- Rules: members with extended media rights decide who may do what in which folder ---

function verifyManageMedia(req, res, next) {
  if (media.canManageMedia(req.user)) return next();
  return res.status(403).json({ error: 'Extended media rights required' });
}

const groupChoices = (groups) => [
  { id: media.ALL_MEMBERS, name: '' },
  ...groups.map((group) => ({ id: group.id, name: group.name })).sort((a, b) => a.name.localeCompare(b.name))
];

/** The rules of [folder] and what each group gets there from a folder above ({ level, from }). */
function folderRules(rules, folder) {
  const own = rules[folder] || {};
  const inherited = {};
  if (folder) {
    const parent = media.parentOf(folder);
    const groupIds = new Set(Object.values(rules).flatMap((entry) => Object.keys(entry)));
    for (const groupId of groupIds) {
      const level = media.groupLevel(rules, parent, groupId);
      if (!level) continue;
      let from = parent;
      while (!rules[from]?.[groupId]) from = media.parentOf(from);
      inherited[groupId] = { level, from };
    }
  }
  return { path: folder, own, inherited };
}

router.get('/api/media/rules', verifyToken, verifyManageMedia, async (req, res) => {
  try {
    const [rules, groups] = await Promise.all([storedRules(), listGroupRecords(context.appConfig)]);
    const known = new Set(groups.map((group) => group.id));
    const current = media.pruneRules(rules, known);
    const body = {
      groups: groupChoices(groups),
      rules: Object.keys(current).sort((a, b) => a.localeCompare(b)).map((folder) => ({ path: folder, groups: current[folder] }))
    };
    if (typeof req.query.path === 'string') {
      const folder = pathParam(req, res);
      if (folder === null) return;
      body.folder = folderRules(current, folder);
    }
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json(body);
  } catch (err) {
    sendError(res, err, 'The folder rights could not be loaded');
  }
});

router.put('/api/media/rules', protectedActionRateLimit, verifyToken, verifyManageMedia, async (req, res) => {
  const folder = pathParam(req, res, req.body?.path);
  if (folder === null) return;
  try {
    const groups = await listGroupRecords(context.appConfig);
    const known = new Set(groups.map((group) => group.id));
    const result = await queueRecordWrite(RULES_KEY, async () => {
      const current = media.pruneRules((await getStateValue(context.appConfig, RULES_KEY, { rules: {} }))?.rules || {}, known);
      const next = media.setFolderRules(current, folder, req.body?.groups, known);
      if (next.error) return next;
      await upsertStateValue(context.appConfig, RULES_KEY, { rules: next.rules });
      cache.rules = null;
      return next;
    });
    if (result.error) return res.status(400).json({ error: result.error });
    console.log(`[Media] ${userId(req)} set the rights of "/${folder}"`);
    broadcastDataUpdate('media');
    res.json({ folder: folderRules(result.rules, folder) });
  } catch (err) {
    sendError(res, err, 'The folder rights could not be saved');
  }
});

// --- System settings: the connection to Nextcloud (administrators) ---

router.get('/api/admin/media-config', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const settings = await storedSettings();
    res.json({
      enabled: settings.enabled === true,
      url: settings.url || '',
      user: settings.user || '',
      password: settings.password ? '***' : '',
      root: settings.root || ''
    });
  } catch (err) {
    sendError(res, err, 'The media settings could not be loaded');
  }
});

/**
 * The settings from the form, checked; the stored password ('***') only goes to the address and account it was
 * entered for. Returns { settings, password } or { error }.
 */
async function settingsFromBody(body = {}) {
  const current = await storedSettings();
  const url = media.cleanServerUrl(body.url);
  if (url === null) return { error: 'The Nextcloud address must start with http:// or https://.' };
  const user = String(body.user ?? '').trim();
  if (user.length > 200 || /[\u0000-\u001f\u007f]/.test(user)) return { error: 'Invalid user name' };
  const root = media.cleanPath(body.root);
  if (root === null) return { error: 'Invalid base folder' };
  let password = typeof body.password === 'string' ? body.password : '***';
  if (password === '***') {
    if (current.password && (url !== current.url || user !== current.user)) {
      return { error: 'Please enter the password again for a new address or account.' };
    }
    password = current.password ? media.decryptSecret(current.password, mediaSecret()) : '';
    if (password === null) return { error: 'Please enter the password again.' };
  }
  return { settings: { enabled: body.enabled === true, url, user, root }, password };
}

router.put('/api/admin/media-config', protectedActionRateLimit, verifyToken, verifyAdmin, async (req, res) => {
  try {
    const parsed = await settingsFromBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { settings, password } = parsed;
    if (settings.enabled && (!settings.url || !settings.user || !password)) {
      return res.status(400).json({ error: 'Address, account and app password are needed to switch Media on.' });
    }
    await upsertStateValue(context.appConfig, SETTINGS_KEY, {
      ...settings,
      password: password ? media.encryptSecret(password, mediaSecret()) : ''
    });
    cache.settings = null;
    broadcastDataUpdate('media');
    res.json({ success: true });
  } catch (err) {
    sendError(res, err, 'The media settings could not be saved');
  }
});

router.post('/api/admin/media-config/test', protectedActionRateLimit, verifyToken, verifyAdmin, async (req, res) => {
  try {
    const parsed = await settingsFromBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { settings, password } = parsed;
    if (!settings.url || !settings.user || !password) {
      return res.status(400).json({ error: 'Address, account and app password are needed for the test.' });
    }
    const folders = await nextcloud.testConnection({ ...settings, password });
    res.json({ success: true, folders: folders.slice(0, 50), folderCount: folders.length });
  } catch (err) {
    if (err instanceof nextcloud.NextcloudError && err.status === 404) {
      return res.status(400).json({ error: 'The base folder does not exist in the Nextcloud account.' });
    }
    sendError(res, err, 'The connection could not be tested');
  }
});

module.exports = router;
