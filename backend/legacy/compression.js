// Response compression without extra dependencies (the reverse proxy in front of Agora usually does not compress):
// - static frontend files are compressed once (brotli / gzip) and kept in memory until the file changes
// - JSON / text API responses sent with res.send / res.json are gzipped on the fly
// Streams (server-sent events, file downloads via sendFile / pipe) are left untouched.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MIN_BYTES = 1024;
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/i;

function acceptedEncodings(acceptEncoding) {
  return String(acceptEncoding || '').toLowerCase().split(',').map(part => {
    const [name, q] = part.trim().split(';q=');
    return { name, q: q === undefined ? 1 : Number(q) };
  }).filter(e => e.q > 0).map(e => e.name);
}

// "br" when the client takes brotli, else "gzip", else null
function pickEncoding(acceptEncoding) {
  const accepted = acceptedEncodings(acceptEncoding);
  if (accepted.includes('br')) return 'br';
  if (accepted.includes('gzip')) return 'gzip';
  return null;
}

function compressBuffer(buffer, encoding, quality) {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(buffer, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length }
    });
  }
  return zlib.gzipSync(buffer, { level: quality });
}

function appendVary(res) {
  const current = String(res.getHeader('Vary') || '');
  if (!/accept-encoding/i.test(current)) res.setHeader('Vary', current ? `${current}, Accept-Encoding` : 'Accept-Encoding');
}

// file path -> { key (mtime + size), br, gzip }
const staticCache = new Map();

/**
 * Sends a static text file compressed (cached per file version). Returns false when it did not handle the
 * request (unknown type, missing file, client without br/gzip) so the caller can fall back to sendFile / static.
 */
function sendCompressedFile(req, res, filePath) {
  const type = STATIC_TYPES[path.extname(filePath).toLowerCase()];
  const encoding = pickEncoding(req.headers['accept-encoding']);
  if (!type || !encoding || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size < MIN_BYTES) return false;

  const key = `${stat.mtimeMs}-${stat.size}`;
  let entry = staticCache.get(filePath);
  if (!entry || entry.key !== key) {
    entry = { key };
    staticCache.set(filePath, entry);
  }
  if (!entry[encoding]) {
    // Compressed once per file version, so the better (slower) levels pay off
    entry[encoding] = compressBuffer(fs.readFileSync(filePath), encoding, 9);
  }
  const body = entry[encoding];
  const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}-${encoding}"`;

  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'public, max-age=0');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  appendVary(res);
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return true;
  }
  res.setHeader('Content-Encoding', encoding);
  res.setHeader('Content-Length', body.length);
  res.status(200).end(req.method === 'HEAD' ? undefined : body);
  return true;
}

/** Serves compressible files below [rootDir] compressed; everything else falls through to the next handler. */
function compressedStatic(rootDir, { exclude = [] } = {}) {
  const root = path.resolve(rootDir);
  return (req, res, next) => {
    let relative;
    try {
      relative = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    if (exclude.includes(relative)) return next();
    const filePath = path.resolve(root, '.' + path.posix.normalize('/' + relative));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) return next();
    if (!sendCompressedFile(req, res, filePath)) next();
  };
}

/** Gzips string / buffer bodies passed to res.send (which res.json uses) when they are large enough. */
function compressResponses(req, res, next) {
  if (!acceptedEncodings(req.headers['accept-encoding']).includes('gzip')) return next();
  const send = res.send.bind(res);
  res.send = body => {
    res.send = send;
    const isText = typeof body === 'string';
    if ((!isText && !Buffer.isBuffer(body)) || res.getHeader('Content-Encoding') || req.method === 'HEAD') return send(body);
    // Same default as express: strings without a type are HTML
    if (!res.getHeader('Content-Type')) {
      if (!isText) return send(body);
      res.type('html');
    }
    const buffer = isText ? Buffer.from(body) : body;
    if (buffer.length < MIN_BYTES || !COMPRESSIBLE.test(String(res.getHeader('Content-Type')))) return send(body);
    appendVary(res);
    res.setHeader('Content-Encoding', 'gzip');
    // Dynamic responses: fast gzip level, brotli would cost more CPU than it saves here
    return send(zlib.gzipSync(buffer, { level: 5 }));
  };
  next();
}

module.exports = { pickEncoding, sendCompressedFile, compressedStatic, compressResponses };
