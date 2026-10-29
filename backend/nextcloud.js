// Talks to Nextcloud as the bot account: WebDAV for folders and files (remote.php/dav/files/<user>/…), the core
// preview endpoint for thumbnails. Paths are the clean paths of media.js, below the configured base folder.
const { Readable } = require('stream');

const LIST_TIMEOUT_MS = 20_000;
const PREVIEW_TIMEOUT_MS = 30_000;

class NextcloudError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const encodePath = (p) => String(p || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');

/** "/Agora/Photos" + "2026" → the path in the bot account, without leading slash. */
const accountPath = (settings, p) => [settings.root, p].map(encodePath).filter(Boolean).join('/');

function davUrl(settings, p) {
  const tail = accountPath(settings, p);
  return `${settings.url}/remote.php/dav/files/${encodeURIComponent(settings.user)}/${tail}`;
}

const authHeader = (settings) => `Basic ${Buffer.from(`${settings.user}:${settings.password}`, 'utf8').toString('base64')}`;

/** The error for an answer Nextcloud did not give as hoped (the bot's login, a missing folder, …). */
function failure(status, what) {
  if (status >= 300 && status < 400) return new NextcloudError('Nextcloud forwards this address elsewhere: please enter the address the browser ends up at (usually https://…).', 502);
  if (status === 401) return new NextcloudError('Nextcloud did not accept the login of the media account.', 502);
  if (status === 403) return new NextcloudError('The media account may not do this in Nextcloud.', 502);
  if (status === 404) return new NextcloudError(what === 'folder' ? 'Folder not found' : 'File not found', 404);
  if (status === 507) return new NextcloudError('The Nextcloud storage is full.', 507);
  return new NextcloudError('Nextcloud answered with an error.', 502);
}

async function request(settings, url, { method = 'GET', headers = {}, body, signal, timeout, duplex } = {}) {
  const signals = [signal, timeout ? AbortSignal.timeout(timeout) : null].filter(Boolean);
  try {
    return await fetch(url, {
      method,
      headers: { Authorization: authHeader(settings), 'OCS-APIRequest': 'true', ...headers },
      body,
      duplex,
      redirect: 'manual',
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0]
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new NextcloudError('Nextcloud cannot be reached.', 502);
  }
}

// --- PROPFIND answers (WebDAV multistatus XML): read with a few patterns, Nextcloud writes it the same way always ---

const PROPS = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:resourcetype/>
    <d:getcontenttype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:getetag/>
    <oc:fileid/>
    <oc:size/>
    <nc:has-preview/>
  </d:prop>
</d:propfind>`;

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (text) => String(text).replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (whole, code) => {
  if (code[0] !== '#') return XML_ENTITIES[code.toLowerCase()] ?? whole;
  const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
  return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
});

/** The text of the first element <prefix:name> in [xml] (any namespace prefix), or null. */
function element(xml, name) {
  const match = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>)`, 'i').exec(xml);
  if (!match) return null;
  return match[1] === undefined ? '' : unescapeXml(match[1].trim());
}

function parseMultistatus(xml) {
  const entries = [];
  for (const [, block] of String(xml).matchAll(/<(?:[\w.-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi)) {
    const href = element(block, 'href');
    if (href === null) continue;
    // Only the properties Nextcloud found (the 404 propstat lists the ones it does not have)
    const found = [...block.matchAll(/<(?:[\w.-]+:)?propstat(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?propstat>/gi)]
      .map((m) => m[1])
      .filter((stat) => /\s200\s/.test(element(stat, 'status') || ''))
      .join('');
    const isFolder = /<(?:[\w.-]+:)?collection\b/i.test(element(found, 'resourcetype') || '');
    const size = Number(isFolder ? element(found, 'size') : element(found, 'getcontentlength'));
    const modified = Date.parse(element(found, 'getlastmodified') || '');
    let decoded;
    try {
      decoded = decodeURIComponent(href.replace(/\/+$/, ''));
    } catch {
      continue;
    }
    entries.push({
      href: decoded,
      name: decoded.slice(decoded.lastIndexOf('/') + 1).normalize('NFC'),
      isFolder,
      size: Number.isFinite(size) ? size : null,
      modified: Number.isFinite(modified) ? new Date(modified).toISOString() : null,
      contentType: isFolder ? null : (element(found, 'getcontenttype') || 'application/octet-stream'),
      etag: (element(found, 'getetag') || '').replace(/"/g, ''),
      fileId: element(found, 'fileid') || null,
      hasPreview: element(found, 'has-preview') === 'true'
    });
  }
  return entries;
}

/** The folders and files directly in [p]: { folders, files }. */
async function listFolder(settings, p, { signal } = {}) {
  const res = await request(settings, `${davUrl(settings, p)}/`, {
    method: 'PROPFIND',
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPS,
    signal,
    timeout: LIST_TIMEOUT_MS
  });
  if (res.status !== 207) {
    await res.body?.cancel();
    throw failure(res.status, 'folder');
  }
  const entries = parseMultistatus(await res.text());
  // The first answer is the folder itself
  const [self, ...children] = entries;
  if (!self?.isFolder) throw new NextcloudError('Folder not found', 404);
  const strip = ({ href, isFolder, ...entry }) => entry;
  return {
    folders: children.filter((entry) => entry.isFolder).map(({ contentType, hasPreview, ...entry }) => strip(entry)),
    files: children.filter((entry) => !entry.isFolder).map(strip)
  };
}

/** The properties of one file or folder, or null if it is not there. */
async function stat(settings, p, { signal } = {}) {
  const res = await request(settings, davUrl(settings, p), {
    method: 'PROPFIND',
    headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPS,
    signal,
    timeout: LIST_TIMEOUT_MS
  });
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  if (res.status !== 207) {
    await res.body?.cancel();
    throw failure(res.status, 'file');
  }
  return parseMultistatus(await res.text())[0] || null;
}

/**
 * A preview image of the file [p] as Nextcloud makes it ([size] pixels; [crop] fills a square, otherwise the
 * picture keeps its proportions within [size]). Returns the fetch answer; the caller streams it on.
 */
async function preview(settings, p, { size, crop = false, signal } = {}) {
  // By path, relative to the bot's files: the path that was checked, never a file id from the request
  const file = `/${[settings.root, p].filter(Boolean).join('/')}`;
  const params = new URLSearchParams({ file, x: String(size), y: String(size), a: crop ? '0' : '1', mimeFallback: 'false' });
  if (crop) params.set('mode', 'cover');
  const res = await request(settings, `${settings.url}/index.php/core/preview.png?${params}`, {
    headers: { Accept: 'image/webp,image/png,image/jpeg,image/*' },
    signal,
    timeout: PREVIEW_TIMEOUT_MS
  });
  if (res.status !== 200 || !/^image\//i.test(res.headers.get('content-type') || '')) {
    await res.body?.cancel();
    // No preview for this kind of file (or not yet): the app shows an icon
    throw new NextcloudError('No preview', res.status === 401 || res.status === 403 ? 502 : 404);
  }
  return res;
}

/** The file itself; a Range header is passed on (PDF viewers and videos read in parts). */
async function download(settings, p, { range, signal } = {}) {
  const headers = range ? { Range: range } : {};
  const res = await request(settings, davUrl(settings, p), { headers, signal });
  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel();
    throw failure(res.status === 416 ? 404 : res.status, 'file');
  }
  return res;
}

/**
 * Stores a new file; never replaces one: Nextcloud refuses with 412 when the name is taken (If-None-Match: *).
 * Returns true when stored, false when the name is taken.
 */
async function uploadNew(settings, p, { stream, size, contentType, signal }) {
  const res = await request(settings, davUrl(settings, p), {
    method: 'PUT',
    headers: {
      'If-None-Match': '*',
      'Content-Type': contentType || 'application/octet-stream',
      ...(Number.isFinite(size) ? { 'Content-Length': String(size), 'OC-Total-Length': String(size) } : {})
    },
    body: Readable.toWeb(stream),
    duplex: 'half',
    signal
  });
  await res.body?.cancel();
  if (res.status === 201 || res.status === 204) return true;
  if (res.status === 412) return false;
  // 409: the folder is gone; 423: the file is locked
  if (res.status === 409) throw new NextcloudError('Folder not found', 404);
  throw failure(res.status, 'file');
}

/** Creates the folder [p]; false when something of that name is already there. */
async function createFolder(settings, p, { signal } = {}) {
  const res = await request(settings, davUrl(settings, p), { method: 'MKCOL', signal, timeout: LIST_TIMEOUT_MS });
  await res.body?.cancel();
  if (res.status === 201) return true;
  if (res.status === 405) return false;
  if (res.status === 409) throw new NextcloudError('Folder not found', 404);
  throw failure(res.status, 'folder');
}

/**
 * Deletes the file or folder [p] (a folder with everything in it; Nextcloud moves it to its trash bin when that is
 * switched on). Returns false when it was not there (any more).
 */
async function remove(settings, p, { signal } = {}) {
  if (!accountPath({ root: '' }, p)) throw new NextcloudError('The base folder cannot be deleted.', 400);
  const res = await request(settings, davUrl(settings, p), { method: 'DELETE', signal, timeout: LIST_TIMEOUT_MS });
  await res.body?.cancel();
  if (res.status === 204 || res.status === 200) return true;
  if (res.status === 404) return false;
  // 423: locked (open somewhere, or being synced)
  if (res.status === 423) throw new NextcloudError('This is in use in Nextcloud right now. Please try again later.', 409);
  throw failure(res.status, 'file');
}

/** Checks the settings: signs in and reads the base folder. Returns the names of the folders in it. */
async function testConnection(settings) {
  const { folders } = await listFolder(settings, '');
  return folders.map((folder) => folder.name).filter((name) => !name.startsWith('.')).sort((a, b) => a.localeCompare(b));
}

module.exports = {
  NextcloudError,
  parseMultistatus,
  listFolder,
  stat,
  preview,
  download,
  uploadNew,
  createFolder,
  remove,
  testConnection
};
