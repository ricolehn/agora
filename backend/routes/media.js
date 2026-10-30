// Media (Extras): browse, view, add to and delete from the Nextcloud folder of the community (rules and paths in media.js,
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
const { getStateValue, upsertStateValue, listGroupRecords, listUserRecords, queueRecordWrite } = require('../pocketbase');
const { loadSecret } = require('../polls');
const media = require('../media');
const nextcloud = require('../nextcloud');
const { translate, requestLanguage } = require('../i18n');
const { ZipWriter, MAX_ENTRIES: MAX_ZIP_ENTRIES, MAX_BYTES: MAX_ZIP_BYTES } = require('../zipStream');

const router = express.Router();

const SETTINGS_KEY = 'media';
const RULES_KEY = 'media_rules';
const DEFAULT_SETTINGS = { enabled: false, url: '', user: '', password: '', root: '' };
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_UPLOAD_FILES = 50;
/** Selected at once (to delete or download): a full folder of pictures. */
const MAX_SELECTED = 500;
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
    // Pictures, PDFs, video and music open in the browser; anything else (HTML, SVG, scripts …) is only ever a
    // download, so a file in the cloud can never run as a page of the app
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

// --- Add: upload files and create folders (write access); nothing is ever replaced ---

const uploadTmpDir = path.join(os.tmpdir(), 'agora-media-uploads');
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => fs.mkdir(uploadTmpDir, { recursive: true, mode: 0o700 }, (err) => cb(err, uploadTmpDir)),
    filename: (req, file, cb) => cb(null, crypto.randomUUID())
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES }
});

/** The folder [req.user] may write to, else answers and returns null. */
async function writableFolder(req, res, value, refusal = 'You may not add anything to this folder.') {
  const folder = pathParam(req, res, value);
  if (folder === null) return null;
  const setup = await ready(res);
  if (!setup) return null;
  const access = media.folderAccess(setup.rules, folder, req.user);
  if (access !== 'write') {
    // Managers see folders hidden from them (to set their rules), but may not add to them either
    const unseen = access === 'none' && !media.canSeeFolder(setup.rules, folder, req.user);
    res.status(unseen ? 404 : 403).json({ error: unseen ? 'Folder not found' : refusal });
    return null;
  }
  return { folder, conn: setup.conn, rules: setup.rules };
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
    const stored = [];
    try {
      if (uploadError) {
        const tooBig = uploadError.code === 'LIMIT_FILE_SIZE';
        const tooMany = uploadError.code === 'LIMIT_FILE_COUNT';
        return res.status(tooBig ? 413 : 400).json({
          error: tooBig ? 'A file is larger than 1 GB.' : tooMany ? 'At most 50 files at once.' : 'The upload could not be read.'
        });
      }
      if (!files.length) return res.status(400).json({ error: 'No files selected' });
      // Browsers send the name as UTF-8 in a field multer reads as latin1. All names are checked before the first
      // file is stored: a bad name further down used to leave the files before it in the cloud behind an error
      const names = files.map((file) => media.cleanName(Buffer.from(file.originalname, 'latin1').toString('utf8')));
      if (names.some((name) => !name || name.startsWith('.'))) return res.status(400).json({ error: 'Invalid file name' });
      for (const [index, file] of files.entries()) {
        const used = await storeUpload(target.conn, target.folder, file, names[index]);
        stored.push({ name: used, path: media.joinPath(target.folder, used) });
      }
      console.log(`[Media] ${userId(req)} added ${stored.length} file(s) to "/${target.folder}"`);
      broadcastDataUpdate('media');
      res.status(201).json({ files: stored });
    } catch (err) {
      // Nextcloud stopped half-way (full, gone): what is stored already shows on the other devices too
      if (stored.length) broadcastDataUpdate('media');
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

// --- Several at once: the app selects entries of one folder ({ path, names }) to delete or to download ---

/** The selected names (each one part of a path, no duplicates), or null after answering 400. */
function selectedNames(req, res) {
  const raw = Array.isArray(req.body?.names) ? req.body.names : null;
  if (!raw || !raw.length) {
    res.status(400).json({ error: 'Nothing selected' });
    return null;
  }
  if (raw.length > MAX_SELECTED) {
    res.status(400).json({ error: 'At most 500 at once.' });
    return null;
  }
  const names = [...new Set(raw.map((name) => (typeof name === 'string' ? media.cleanPath(name) : null)))];
  if (names.some((name) => !name || name.includes('/'))) {
    res.status(400).json({ error: 'Invalid path' });
    return null;
  }
  return names;
}

/** What is in [folder] by name: { isFolder, size, modified } (not the hidden names the app never shows). */
async function entriesByName(conn, folder) {
  const { folders, files } = await nextcloud.listFolder(conn, folder);
  return new Map([
    ...folders.map((entry) => [entry.name, { ...entry, isFolder: true }]),
    ...files.map((entry) => [entry.name, { ...entry, isFolder: false }])
  ].filter(([name]) => !name.startsWith('.')));
}

// Delete: files where the member may write, folders only when they may write everywhere in them
router.post('/api/media/delete', protectedActionRateLimit, verifyToken, async (req, res) => {
  try {
    const names = selectedNames(req, res);
    if (!names) return;
    const target = await writableFolder(req, res, req.body?.path, 'You may not delete anything in this folder.');
    if (!target) return;
    const tr = (text) => translate(requestLanguage(req), text);
    const deleted = [];
    const failed = [];
    const deletedFolders = [];
    const present = await entriesByName(target.conn, target.folder);
    for (const name of names) {
      const entryPath = media.joinPath(target.folder, name);
      const entry = present.get(name);
      // Already gone (deleted on another device): what was asked for is done
      if (!entry) {
        deleted.push(name);
        continue;
      }
      if (entry.isFolder && !media.canDeleteFolder(target.rules, entryPath, req.user)) {
        failed.push({ name, status: 403, error: tr('You may not delete everything in this folder.') });
        continue;
      }
      try {
        await nextcloud.remove(target.conn, entryPath);
        deleted.push(name);
        if (entry.isFolder) deletedFolders.push(entryPath);
      } catch (err) {
        if (!(err instanceof nextcloud.NextcloudError)) throw err;
        failed.push({ name, status: err.status, error: tr(err.message) });
      }
    }
    // A new folder of the same name starts without the rights of the deleted one
    if (deletedFolders.length) {
      await queueRecordWrite(RULES_KEY, async () => {
        const current = (await getStateValue(context.appConfig, RULES_KEY, { rules: {} }))?.rules || {};
        const next = deletedFolders.reduce((rules, folder) => media.rulesWithout(rules, folder), current);
        if (Object.keys(next).length !== Object.keys(current).length) await upsertStateValue(context.appConfig, RULES_KEY, { rules: next });
        cache.rules = null;
      });
    }
    if (deleted.length) {
      console.log(`[Media] ${userId(req)} deleted ${deleted.length} item(s) in "/${target.folder}"`);
      broadcastDataUpdate('media');
    }
    const failures = failed.map(({ status, ...entry }) => entry);
    if (!deleted.length && failed.length) return res.status(failed[0].status || 502).json({ error: failed[0].error, failed: failures });
    res.json({ deleted, failed: failures });
  } catch (err) {
    sendError(res, err, 'Could not delete');
  }
});

/**
 * What a download of [names] in [folder] holds for [user]: the files (with their place in the archive) and the
 * folders, walking down into folders as far as the member may see them (like in the app). Throws a NextcloudError
 * (413) when it does not fit in one archive.
 */
async function downloadEntries(conn, rules, user, folder, names) {
  const entries = [];
  let bytes = 0;
  const add = (entry) => {
    entries.push(entry);
    bytes += (entry.size || 0) + 2 * (Buffer.byteLength(entry.name) + 46);
    if (entries.length > MAX_ZIP_ENTRIES || bytes > MAX_ZIP_BYTES) {
      throw new nextcloud.NextcloudError('That is too much for one download (at most 4 GB). Please select less.', 413);
    }
  };
  const walk = async (folderPath, zipName, modified) => {
    add({ name: zipName, folder: true, modified });
    const view = media.filterListing(rules, folderPath, user, await nextcloud.listFolder(conn, folderPath));
    for (const file of view.files) add({ name: `${zipName}/${file.name}`, path: file.path, size: file.size, modified: file.modified });
    for (const sub of view.folders) await walk(sub.path, `${zipName}/${sub.name}`, sub.modified);
  };
  const present = await entriesByName(conn, folder);
  for (const name of names) {
    const entryPath = media.joinPath(folder, name);
    const entry = present.get(name);
    if (!entry) continue;
    if (entry.isFolder) {
      if (media.canSeeFolder(rules, entryPath, user)) await walk(entryPath, name, entry.modified);
    } else if (media.folderAccess(rules, folder, user) !== 'none') {
      add({ name, path: entryPath, size: entry.size, modified: entry.modified });
    }
  }
  return entries;
}

// A download is asked for with a POST (the selection can be long) and fetched with a GET the browser saves itself
// (streamed, never held in the page): the GET address works for its member for a few minutes
const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
const downloads = new Map();
function keepDownload(ticket) {
  const now = Date.now();
  for (const [id, entry] of downloads) if (entry.expires <= now) downloads.delete(id);
  if (downloads.size >= 200) downloads.delete(downloads.keys().next().value);
  const id = crypto.randomBytes(18).toString('base64url');
  downloads.set(id, { ...ticket, expires: now + DOWNLOAD_TTL_MS });
  return id;
}

router.post('/api/media/download', protectedActionRateLimit, verifyToken, async (req, res) => {
  const folder = pathParam(req, res, req.body?.path);
  if (folder === null) return;
  const names = selectedNames(req, res);
  if (!names) return;
  try {
    const setup = await ready(res);
    if (!setup) return;
    if (!media.canSeeFolder(setup.rules, folder, req.user)) return res.status(404).json({ error: 'Folder not found' });
    const entries = await downloadEntries(setup.conn, setup.rules, req.user, folder, names);
    if (!entries.some((entry) => !entry.folder)) return res.status(404).json({ error: 'There is nothing to download here.' });
    // One folder: the archive is named after it; several entries after the folder they are in
    const base = names.length === 1 && entries[0].folder ? names[0] : (folder ? media.nameOf(folder) : 'Media');
    const id = keepDownload({ uid: userId(req), entries, name: `${base}.zip` });
    res.json({ id, url: `/api/media/download/${id}`, files: entries.filter((entry) => !entry.folder).length });
  } catch (err) {
    sendError(res, err, 'The download could not be prepared');
  }
});

router.get('/api/media/download/:id', mediaFileRateLimit, verifyToken, async (req, res) => {
  const ticket = downloads.get(String(req.params.id));
  if (!ticket || ticket.expires <= Date.now() || ticket.uid !== userId(req)) {
    return res.status(404).json({ error: 'This download is no longer available. Please start it again.' });
  }
  let setup;
  try {
    setup = await ready(res);
    if (!setup) return;
  } catch (err) {
    return sendError(res, err, 'The download could not be prepared');
  }
  const signal = abortOnClose(req, res);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; ${dispositionName(ticket.name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  const zip = new ZipWriter(res);
  try {
    for (const entry of ticket.entries) {
      if (entry.folder) {
        await zip.addFolder(entry.name, entry.modified);
        continue;
      }
      // The rights may have changed since the download was asked for
      if (media.folderAccess(setup.rules, media.parentOf(entry.path), req.user) === 'none') continue;
      let upstream;
      try {
        upstream = await nextcloud.download(setup.conn, entry.path, { signal });
      } catch (err) {
        // Deleted in the meantime: left out
        if (err instanceof nextcloud.NextcloudError && err.status === 404) continue;
        throw err;
      }
      await zip.addFile(entry.name, entry.modified, upstream.body ? Readable.fromWeb(upstream.body) : []);
    }
    await zip.finish();
    res.end();
  } catch (err) {
    if (err?.name !== 'AbortError' && !signal.aborted) console.warn('[Media] download stopped:', err.message);
    // Headers are out: a cut archive is the only way to say it went wrong
    res.destroy();
  }
});

// --- Rules: members with extended media rights decide who may do what in which folder ---

function verifyManageMedia(req, res, next) {
  if (media.canManageMedia(req.user)) return next();
  return res.status(403).json({ error: 'Extended media rights required' });
}

const personName = (user) => `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.name || user.email || user.id;

/**
 * Who rules can be for: all members, the groups and every person with an account ({ id, name, kind }), and the
 * set of ids that exist (rules of deleted groups and accounts are dropped).
 */
async function ruleTargets() {
  const [groups, users] = await Promise.all([listGroupRecords(context.appConfig), listUserRecords(context.appConfig)]);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const choices = [
    { id: media.ALL_MEMBERS, name: '', kind: 'all' },
    ...groups.map((group) => ({ id: group.id, name: group.name, kind: 'group' })).sort(byName),
    ...users.map((user) => ({ id: media.personKey(user.id), name: personName(user), kind: 'person' })).sort(byName)
  ];
  return { choices, known: new Set(choices.map((choice) => choice.id)) };
}

/** The rules of [folder] and what each group or person gets there from a folder above ({ level, from }). */
function folderRules(rules, folder) {
  const own = rules[folder] || {};
  const inherited = {};
  if (folder) {
    const parent = media.parentOf(folder);
    const ids = new Set(Object.values(rules).flatMap((entry) => Object.keys(entry)));
    for (const id of ids) {
      const level = media.groupLevel(rules, parent, id);
      if (!level) continue;
      let from = parent;
      while (!rules[from]?.[id]) from = media.parentOf(from);
      inherited[id] = { level, from };
    }
  }
  return { path: folder, own, inherited };
}

router.get('/api/media/rules', verifyToken, verifyManageMedia, async (req, res) => {
  try {
    const [rules, { choices, known }] = await Promise.all([storedRules(), ruleTargets()]);
    const current = media.pruneRules(rules, known);
    const body = {
      choices,
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
    const { known } = await ruleTargets();
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
