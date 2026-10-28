// Media (Extras): a library of images and files that lives in a Nextcloud folder. Agora signs in to Nextcloud with
// one bot account (full rights there) and decides itself who may do what: rules per folder and group.
//
// A rule gives a group one of three levels on a folder: read (browse, view, download), write (read + upload files
// and create folders) or hide (the group does not see the folder). A rule applies to the folder and everything
// below it until a subfolder has its own rule for that group. Without any rule nobody sees anything. Someone in
// several groups gets the most a group of theirs gets ("*" stands for all members). Members with the manage_media
// permission see every folder, upload everywhere and set the rules. Nobody deletes, renames, moves or overwrites
// anything through Agora.
//
// Paths are relative to the configured base folder in the bot account: "" is the base folder, "Photos/2026" a
// folder below it. Only clean paths get through (no "..", no empty parts), so nothing outside the base folder can
// be reached.
const crypto = require('crypto');
const path = require('path');

const ALL_MEMBERS = '*';
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

/** What [user] may do in [folder]: 'write', 'read' or 'none'. */
function folderAccess(rules, folder, user) {
  if (canManageMedia(user)) return 'write';
  let best = 'none';
  for (const groupId of [ALL_MEMBERS, ...(Array.isArray(user?.groupIds) ? user.groupIds : [])]) {
    const level = groupLevel(rules, folder, groupId);
    if (level && level !== 'hide' && RANK[level] > RANK[best]) best = level;
  }
  return best;
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

/** Whether [user] sees [folder] at all: with access of their own, or as the way to a folder they may read. */
function canSeeFolder(rules, folder, user) {
  if (folderAccess(rules, folder, user) !== 'none') return true;
  // A passage: some rule further down gives access
  return passagesBelow(rules, folder, user).size > 0;
}

/** Whether the Media tile is offered to [user]: managers always, others with access to at least one folder. */
function hasAnyAccess(rules, user) {
  return canManageMedia(user) || canSeeFolder(rules, '', user);
}

/**
 * What [user] sees of a folder listing ({ folders, files } from Nextcloud): folders they may open (with their
 * access), files only where they may read. Names starting with a dot (.nomedia and the like) are left out.
 */
function filterListing(rules, folder, user, { folders = [], files = [] }) {
  const access = folderAccess(rules, folder, user);
  const manager = canManageMedia(user);
  const passages = access === 'none' ? passagesBelow(rules, folder, user) : null;
  const visibleFolders = [];
  for (const entry of folders) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = joinPath(folder, entry.name);
    const entryAccess = folderAccess(rules, entryPath, user);
    if (entryAccess === 'none' && !(passages ? passages.has(entry.name) : canSeeFolder(rules, entryPath, user))) continue;
    const item = { ...entry, path: entryPath, access: entryAccess };
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

/** Sets the rules of one folder ({ groupId: level }; an empty object removes them). Returns { rules } or { error }. */
function setFolderRules(rules, folder, groups, knownGroupIds) {
  const next = { ...(rules || {}) };
  const own = {};
  for (const [groupId, level] of Object.entries(groups && typeof groups === 'object' ? groups : {})) {
    if (!level) continue;
    if (!LEVELS.includes(level)) return { error: 'Unknown access level.' };
    if (groupId !== ALL_MEMBERS && !knownGroupIds.has(groupId)) return { error: 'Unknown group.' };
    own[groupId] = level;
  }
  if (Object.keys(own).length) next[folder] = own;
  else delete next[folder];
  return { rules: next };
}

/** Rules without groups that no longer exist (a deleted group must not come back with the next group of that id). */
function pruneRules(rules, knownGroupIds) {
  const next = {};
  for (const [folder, own] of Object.entries(rules || {})) {
    const kept = Object.fromEntries(Object.entries(own || {}).filter(([groupId, level]) =>
      (groupId === ALL_MEMBERS || knownGroupIds.has(groupId)) && LEVELS.includes(level)));
    if (Object.keys(kept).length) next[folder] = kept;
  }
  return next;
}

// --- What kind of file, for the viewer ---

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/heic', 'image/heif']);
/** Shown in the browser as they are; everything else (SVG, HTML, …) only goes out as a download. */
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'application/pdf']);

function fileKind(contentType, name) {
  const type = String(contentType || '').toLowerCase();
  const ext = path.extname(String(name || '')).toLowerCase();
  if (IMAGE_TYPES.has(type) || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.heic', '.heif'].includes(ext)) return 'image';
  if (type === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'other';
}

/** Preview sizes Nextcloud is asked for (a few fixed ones, so its preview cache and the browser cache are reused). */
const PREVIEW_SIZES = [64, 128, 256, 512, 1024, 2048];
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
