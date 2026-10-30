// Media (Extras): a library of images and files that lives in a Nextcloud folder. Agora signs in to Nextcloud with
// one bot account (full rights there) and decides itself who may do what: rules per folder and group.
//
// A rule gives all members ("*"), a group (its id) or one person ("user:<id>") one of three levels on a folder:
// read (browse, view, download), write (read + upload files and create folders) or hide (no access: does not see
// the folder). A rule applies to the folder and everything below it until a subfolder has its own rule for the same
// group or person. Without any rule nobody sees anything.
//
// The most specific rule decides: a rule for the person themself goes before the rules of their groups, a group rule
// goes before the rule for all members (so one person or group can be given more, or less, than the others; "no
// access" for a group also holds when all members may read). Someone in several groups with rules gets the most one
// of these groups gets. Whoever has no access to the base folder does not see the media library at all, whatever
// the folders below say. Members with the manage_media permission set the rules, and the rules hold for them too: they
// see every folder (to set its rules, also one hidden from them), but its files only where the rules let them read,
// and upload or delete only where they let them write. Write access also allows deleting (in Nextcloud it goes to the trash bin): a file where one may write in its
// folder, a folder only when one may write in it, in the folder around it and in every folder below it (nobody
// deletes what they cannot see or change). Nobody renames, moves or overwrites anything through Agora.
//
// Paths are relative to the configured base folder in the bot account: "" is the base folder, "Photos/2026" a
// folder below it. Only clean paths get through (no "..", no empty parts), so nothing outside the base folder can
// be reached.
const crypto = require('crypto');
const path = require('path');

const ALL_MEMBERS = '*';
const PERSON_PREFIX = 'user:';
const personKey = (uid) => `${PERSON_PREFIX}${uid}`;
const LEVELS = ['read', 'write', 'hide'];
const RANK = { none: 0, read: 1, write: 2 };
const MAX_PATH = 1024;
const MAX_NAME = 200;

const canManageMedia = (user) => Array.isArray(user?.permissions) && user.permissions.includes('manage_media');

/** Whether [name] can be one part of a path (no separators, "..", control characters). */
const isValidName = (name) => !!name && name.length <= MAX_NAME && name !== '.' && name !== '..'
  && !/[/\\\u0000-\u001f\u007f]/.test(name);

/** A new file or folder name (trimmed), or null if it may not be used. */
function cleanName(value) {
  const name = String(value ?? '').normalize('NFC').trim();
  return isValidName(name) ? name : null;
}

/** A path below the base folder ("" for the base folder itself), or null if it is not a clean path. */
function cleanPath(value) {
  const raw = String(value ?? '').normalize('NFC');
  if (raw.length > MAX_PATH) return null;
  // Names are taken as they are (an existing folder may end with a space), only checked
  const parts = raw.split('/').filter((part) => part !== '');
  return parts.every(isValidName) ? parts.join('/') : null;
}

const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const joinPath = (folder, name) => (folder ? `${folder}/${name}` : name);

/** The folder itself and every folder above it, the folder first and the base folder ("") last. */
function selfAndAncestors(p) {
  const result = [p];
  let current = p;
  while (current) {
    current = parentOf(current);
    result.push(current);
  }
  return result;
}

/** The level a group has on a folder: its own rule, else the nearest folder above with a rule for the group. */
function groupLevel(rules, folder, groupId) {
  for (const p of selfAndAncestors(folder)) {
    const level = rules?.[p]?.[groupId];
    if (level) return level;
  }
  return null;
}

const asAccess = (level) => (level === 'read' || level === 'write' ? level : 'none');

/** What the rules give [user] in [folder] on their own: the person's rule, else their groups', else all members'. */
function ruleAccess(rules, folder, user) {
  const uid = user?.uid || user?.id;
  const personal = uid ? groupLevel(rules, folder, personKey(uid)) : null;
  if (personal) return asAccess(personal);
  const groupLevels = (Array.isArray(user?.groupIds) ? user.groupIds : [])
    .filter((groupId) => groupId !== ALL_MEMBERS)
    .map((groupId) => groupLevel(rules, folder, groupId))
    .filter(Boolean);
  if (groupLevels.length) {
    return groupLevels.map(asAccess).reduce((best, level) => (RANK[level] > RANK[best] ? level : best), 'none');
  }
  return asAccess(groupLevel(rules, folder, ALL_MEMBERS));
}

/** Whether [user] may use the media library at all: managers always, others with access to the base folder. */
const canUseMedia = (rules, user) => canManageMedia(user) || ruleAccess(rules, '', user) !== 'none';

/** What [user] may do in [folder]: 'write', 'read' or 'none' (managers too: the rules hold for them as well). */
function folderAccess(rules, folder, user) {
  if (folder && ruleAccess(rules, '', user) === 'none') return 'none';
  return ruleAccess(rules, folder, user);
}

/**
 * The child folders of [folder] that lead to a folder [user] may read further down (folders without access of their
 * own that the member still has to pass through), by name.
 */
function passagesBelow(rules, folder, user) {
  const names = new Set();
  const prefix = folder ? `${folder}/` : '';
  for (const rulePath of Object.keys(rules || {})) {
    if (!rulePath || (folder && !rulePath.startsWith(prefix))) continue;
    if (folderAccess(rules, rulePath, user) === 'none') continue;
    names.add(rulePath.slice(prefix.length).split('/')[0]);
  }
  return names;
}

/**
 * Whether [user] sees [folder] at all: with access of their own, or as the way to a folder they may read. Managers
 * see every folder (they set its rules), not its files.
 */
function canSeeFolder(rules, folder, user) {
  if (canManageMedia(user)) return true;
  if (!canUseMedia(rules, user)) return false;
  if (folderAccess(rules, folder, user) !== 'none') return true;
  // A passage: some rule further down gives access
  return passagesBelow(rules, folder, user).size > 0;
}

/**
 * Whether [user] may delete the folder [folder] (with everything in it): write access to it, to the folder around
 * it and to every folder below it with rules of its own (only there can access change). Never the base folder.
 */
function canDeleteFolder(rules, folder, user) {
  if (!folder) return false;
  if (folderAccess(rules, parentOf(folder), user) !== 'write' || folderAccess(rules, folder, user) !== 'write') return false;
  const prefix = `${folder}/`;
  return Object.keys(rules || {}).every((rulePath) => !rulePath.startsWith(prefix) || folderAccess(rules, rulePath, user) === 'write');
}

/** Whether [user] may delete the file [file]: write access to its folder. */
const canDeleteFile = (rules, file, user) => !!file && folderAccess(rules, parentOf(file), user) === 'write';

/** The rules without those of [folder] and the folders below it (a deleted folder leaves no rules behind). */
function rulesWithout(rules, folder) {
  const prefix = `${folder}/`;
  return Object.fromEntries(Object.entries(rules || {}).filter(([rulePath]) => rulePath !== folder && !rulePath.startsWith(prefix)));
}

/** Whether the Media tile is offered to [user]: managers always, others with access to the base folder. */
const hasAnyAccess = canUseMedia;

/**
 * What [user] sees of a folder listing ({ folders, files } from Nextcloud): folders they may open (with their
 * access; managers every folder), files only where they may read. Names starting with a dot (.nomedia and the like)
 * are left out.
 */
function filterListing(rules, folder, user, { folders = [], files = [] }) {
  const access = folderAccess(rules, folder, user);
  const manager = canManageMedia(user);
  const passages = access === 'none' && !manager ? passagesBelow(rules, folder, user) : null;
  const visibleFolders = [];
  for (const entry of folders) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = joinPath(folder, entry.name);
    const entryAccess = folderAccess(rules, entryPath, user);
    if (entryAccess === 'none' && !manager && !(passages ? passages.has(entry.name) : canSeeFolder(rules, entryPath, user))) continue;
    const item = { ...entry, path: entryPath, access: entryAccess, canDelete: canDeleteFolder(rules, entryPath, user) };
    if (manager) {
      const own = rules?.[entryPath];
      item.hasRules = !!own && Object.keys(own).length > 0;
      item.hiddenFor = own ? Object.keys(own).filter((groupId) => own[groupId] === 'hide') : [];
    }
    visibleFolders.push(item);
  }
  const visibleFiles = access === 'none' ? [] : files
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => ({ ...entry, path: joinPath(folder, entry.name) }));
  return { access, folders: visibleFolders, files: visibleFiles };
}

/**
 * Sets the rules of one folder ({ "*" | groupId | "user:<id>": level }; an empty object removes them). [knownIds]
 * holds the group ids and person keys that exist. Returns { rules } or { error }.
 */
function setFolderRules(rules, folder, groups, knownIds) {
  const next = { ...(rules || {}) };
  const own = {};
  for (const [id, level] of Object.entries(groups && typeof groups === 'object' ? groups : {})) {
    if (!level) continue;
    if (!LEVELS.includes(level)) return { error: 'Unknown access level.' };
    if (id !== ALL_MEMBERS && !knownIds.has(id)) return { error: 'Unknown group or person.' };
    own[id] = level;
  }
  if (Object.keys(own).length) next[folder] = own;
  else delete next[folder];
  return { rules: next };
}

/** Rules without groups or people that no longer exist (deleted groups and accounts leave nothing behind). */
function pruneRules(rules, knownIds) {
  const next = {};
  for (const [folder, own] of Object.entries(rules || {})) {
    const kept = Object.fromEntries(Object.entries(own || {}).filter(([id, level]) =>
      (id === ALL_MEMBERS || knownIds.has(id)) && LEVELS.includes(level)));
    if (Object.keys(kept).length) next[folder] = kept;
  }
  return next;
}

// --- What kind of file, for the viewer ---

/**
 * Shown or played in the browser as they are (pictures, PDFs, video and music: nothing in them runs as a page);
 * everything else (SVG, HTML, …) only goes out as a download.
 */
const INLINE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'application/pdf',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-m4v',
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/wav',
  'audio/x-wav', 'audio/wave', 'audio/webm', 'audio/flac', 'audio/x-flac'
]);

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.heic', '.heif', '.dng', '.tif', '.tiff', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.psd']);

function fileKind(contentType, name) {
  const type = String(contentType || '').toLowerCase();
  const ext = path.extname(String(name || '')).toLowerCase();
  // SVG is never shown as a picture (it could run as a page); every other picture opens in the viewer as a preview
  if (type === 'image/svg+xml' || ext === '.svg') return 'other';
  if (type.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (type === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'other';
}

/**
 * Preview sizes Nextcloud is asked for (a few fixed ones, so its preview cache and the browser cache are reused):
 * up to 512 for tiles, 1024 / 2048 for the viewer, 4096 when zoomed in (instead of the original, which may be a
 * format the browser cannot show, like DNG or HEIC).
 */
const PREVIEW_SIZES = [64, 128, 256, 512, 1024, 2048, 4096];
const previewSize = (value) => PREVIEW_SIZES.find((size) => size >= (Number(value) || 0)) || PREVIEW_SIZES[PREVIEW_SIZES.length - 1];

/** "photo.jpg" → "photo (2).jpg": the next free name when a file of that name is already there. */
function numberedName(name, number) {
  const ext = path.extname(name);
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${base} (${number})${base === name ? '' : ext}`;
}

// --- The bot's password: encrypted with a key in the data folder, so it is not readable in the database ---

const encryptionKey = (secret) => crypto.createHash('sha256').update(`media-password:${secret}`).digest();

function encryptSecret(plain, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** The plain password, or null if it cannot be read (other key, damaged value). */
function decryptSecret(sealed, secret) {
  const [version, iv, tag, data] = String(sealed || '').split(':');
  if (version !== 'v1' || !iv || !tag || data === undefined) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** The Nextcloud address as entered ("cloud.example.org:8443/nextcloud" gets https://), or null if it is none. */
function cleanServerUrl(value) {
  let text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return null;
  // Pasted from the browser: the address of the Files app or the WebDAV address, cut back to the server
  const pathname = url.pathname.replace(/\/(index\.php|remote\.php)(\/.*)?$/, '').replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${pathname}`;
}

module.exports = {
  ALL_MEMBERS,
  personKey,
  LEVELS,
  INLINE_TYPES,
  PREVIEW_SIZES,
  canManageMedia,
  cleanName,
  cleanPath,
  parentOf,
  nameOf,
  joinPath,
  groupLevel,
  folderAccess,
  canSeeFolder,
  canDeleteFolder,
  canDeleteFile,
  rulesWithout,
  canUseMedia,
  hasAnyAccess,
  filterListing,
  setFolderRules,
  pruneRules,
  fileKind,
  previewSize,
  numberedName,
  encryptSecret,
  decryptSecret,
  cleanServerUrl
};
