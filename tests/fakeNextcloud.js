// A small stand-in for Nextcloud in the API tests: WebDAV (PROPFIND, GET with ranges, PUT, MKCOL) below
// /remote.php/dav/files/<user>/ and the preview endpoint, on a free local port, with files kept in memory.
const http = require('http');
const crypto = require('crypto');

const xmlEscape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function startFakeNextcloud({ user = 'bot', password = 'app-pass', previewImage = null } = {}) {
  // path in the account ("Agora/Fotos/a.jpg") → { dir: true } or { data, type, etag, id }
  const nodes = new Map([['', { dir: true, id: 1 }]]);
  let nextId = 2;
  const requests = [];

  const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const addDir = (p) => {
    if (p && !nodes.has(parentOf(p))) addDir(parentOf(p));
    if (!nodes.has(p)) nodes.set(p, { dir: true, id: nextId++ });
  };
  const addFile = (p, data, type) => {
    addDir(parentOf(p));
    nodes.set(p, { data: Buffer.from(data), type, etag: crypto.randomBytes(6).toString('hex'), id: nextId++ });
  };

  const propResponse = (href, p, node) => `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop>
<d:resourcetype>${node.dir ? '<d:collection/>' : ''}</d:resourcetype>
${node.dir ? `<oc:size>${0}</oc:size>` : `<d:getcontentlength>${node.data.length}</d:getcontentlength><d:getcontenttype>${node.type}</d:getcontenttype>`}
<d:getlastmodified>Mon, 26 Oct 2026 10:00:00 GMT</d:getlastmodified>
<d:getetag>&quot;${node.etag || 'dir'}&quot;</d:getetag><oc:fileid>${node.id}</oc:fileid>
${node.dir ? '' : `<nc:has-preview>${node.type.startsWith('image/') ? 'true' : 'false'}</nc:has-preview>`}
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
${node.dir ? '<d:propstat><d:prop><d:getcontenttype/><nc:has-preview/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>' : ''}</d:response>`;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
      const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Nextcloud"' });
        return res.end();
      }

      if (url.pathname === '/index.php/core/preview.png') {
        const p = String(url.searchParams.get('file') || '').replace(/^\/+/, '');
        const node = nodes.get(p);
        if (!node || node.dir || !node.type.startsWith('image/') || node.type === 'image/svg+xml') {
          res.writeHead(404);
          return res.end();
        }
        // previewImage(path, size, crop) can hand real pictures (a demo); the tests only need to know it was asked
        const image = previewImage?.(p, Number(url.searchParams.get('x')), url.searchParams.get('a') === '0');
        res.writeHead(200, { 'Content-Type': image ? 'image/jpeg' : 'image/png', 'X-Preview': `${url.searchParams.get('x')}x${url.searchParams.get('y')} a=${url.searchParams.get('a')}` });
        return res.end(image || Buffer.from('preview-of-' + p));
      }

      const prefix = `/remote.php/dav/files/${encodeURIComponent(user)}`;
      if (!url.pathname.startsWith(prefix)) {
        res.writeHead(404);
        return res.end();
      }
      const p = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/^\/+|\/+$/g, '');
      const node = nodes.get(p);
      const hrefOf = (path) => `${prefix}/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}${nodes.get(path)?.dir ? '/' : ''}`;

      switch (req.method) {
        case 'PROPFIND': {
          if (!node) {
            res.writeHead(404);
            return res.end();
          }
          const entries = [[p, node]];
          if (node.dir && req.headers.depth === '1') {
            for (const [childPath, child] of nodes) if (childPath && parentOf(childPath) === p) entries.push([childPath, child]);
          }
          res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
          return res.end(`<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">${entries.map(([path, n]) => propResponse(hrefOf(path), path, n)).join('')}</d:multistatus>`);
        }
        case 'GET': {
          if (!node || node.dir) {
            res.writeHead(404);
            return res.end();
          }
          const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
          if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Number(range[2]) : node.data.length - 1;
            res.writeHead(206, { 'Content-Type': node.type, 'Content-Range': `bytes ${start}-${end}/${node.data.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
            return res.end(node.data.subarray(start, end + 1));
          }
          res.writeHead(200, { 'Content-Type': node.type, 'Content-Length': node.data.length, 'Accept-Ranges': 'bytes', ETag: `"${node.etag}"` });
          return res.end(node.data);
        }
        case 'PUT': {
          if (!nodes.get(parentOf(p))?.dir) {
            res.writeHead(409);
            return res.end();
          }
          if (node && req.headers['if-none-match'] === '*') {
            res.writeHead(412);
            return res.end();
          }
          addFile(p, body, String(req.headers['content-type'] || 'application/octet-stream'));
          res.writeHead(201);
          return res.end();
        }
        case 'MKCOL': {
          if (node) {
            res.writeHead(405);
            return res.end();
          }
          if (!nodes.get(parentOf(p))?.dir) {
            res.writeHead(409);
            return res.end();
          }
          addDir(p);
          res.writeHead(201);
          return res.end();
        }
        default:
          res.writeHead(405);
          return res.end();
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        user,
        password,
        nodes,
        requests,
        addDir,
        addFile,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

module.exports = { startFakeNextcloud };
