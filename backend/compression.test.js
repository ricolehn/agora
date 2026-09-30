const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pickEncoding, sendCompressedFile, compressedStatic, compressResponses } = require('./compression');

function fakeRes() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    type(value) { headers['content-type'] = value === 'html' ? 'text/html; charset=utf-8' : value; return this; },
    status(code) { this.statusCode = code; return this; },
    end(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  };
}
const req = (acceptEncoding, { headers = {}, ...rest } = {}) => ({ method: 'GET', path: '/', ...rest, headers: { 'accept-encoding': acceptEncoding, ...headers } });

test('pickEncoding prefers brotli, falls back to gzip and honours q=0', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'br');
  assert.equal(pickEncoding('gzip, deflate'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(undefined), null);
});

test('sendCompressedFile compresses text files, answers 304 and skips other files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-compress-'));
  const file = path.join(dir, 'app.js');
  const content = 'const answer = 42;\n'.repeat(200);
  fs.writeFileSync(file, content);
  fs.writeFileSync(path.join(dir, 'small.js'), 'x');
  fs.writeFileSync(path.join(dir, 'image.png'), Buffer.alloc(4096));

  const res = fakeRes();
  assert.equal(sendCompressedFile(req('br'), res, file), true);
  assert.equal(res.headers['content-encoding'], 'br');
  assert.match(res.headers.vary, /Accept-Encoding/);
  assert.equal(zlib.brotliDecompressSync(res.body).toString(), content);
  assert.ok(res.body.length < content.length / 5);

  const notModified = fakeRes();
  assert.equal(sendCompressedFile(req('br', { headers: { 'if-none-match': res.headers.etag } }), notModified, file), true);
  assert.equal(notModified.statusCode, 304);
  assert.equal(notModified.headers['content-encoding'], undefined);

  // A changed file gets a new ETag and new content
  const changed = content + '// more\n';
  fs.writeFileSync(file, changed);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const again = fakeRes();
  sendCompressedFile(req('gzip'), again, file);
  assert.equal(zlib.gunzipSync(again.body).toString(), changed);
  assert.notEqual(again.headers.etag, res.headers.etag);

  assert.equal(sendCompressedFile(req(''), fakeRes(), file), false, 'client without compression');
  assert.equal(sendCompressedFile(req('br'), fakeRes(), path.join(dir, 'small.js')), false, 'tiny file');
  assert.equal(sendCompressedFile(req('br'), fakeRes(), path.join(dir, 'image.png')), false, 'binary type');
  assert.equal(sendCompressedFile(req('br'), fakeRes(), path.join(dir, 'missing.js')), false, 'missing file');
  assert.equal(sendCompressedFile({ ...req('br'), method: 'POST' }, fakeRes(), file), false, 'not a GET');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compressedStatic stays inside its root and honours excludes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-static-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'style.css'), 'body { margin: 0; }\n'.repeat(200));
  fs.writeFileSync(path.join(dir, 'assets', 'config.js'), 'export const config = {};\n'.repeat(100));
  fs.writeFileSync(path.join(dir, 'secret.js'), 'const secret = 1;\n'.repeat(200));
  const middleware = compressedStatic(path.join(dir, 'assets'), { exclude: ['/config.js'] });
  const run = p => {
    const res = fakeRes();
    let passed = false;
    middleware({ ...req('br'), path: p }, res, () => { passed = true; });
    return { res, passed };
  };
  assert.equal(run('/style.css').passed, false);
  assert.equal(run('/style.css').res.headers['content-encoding'], 'br');
  assert.equal(run('/config.js').passed, true, 'excluded file goes to the next handler');
  assert.equal(run('/../secret.js').passed, true, 'path traversal is not served');
  assert.equal(run('/%2e%2e/secret.js').passed, true, 'encoded traversal is not served');
  assert.equal(run('/%E0%A4%A').passed, true, 'malformed path');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compressResponses gzips large JSON / text bodies only', () => {
  const big = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'Mitglied ' + i })) });
  const send = (acceptEncoding, body, type) => {
    const res = fakeRes();
    if (type) res.setHeader('Content-Type', type);
    compressResponses(req(acceptEncoding), res, () => {});
    res.send(body);
    return res;
  };
  const json = send('gzip, br', big, 'application/json; charset=utf-8');
  assert.equal(json.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(json.body).toString(), big);

  assert.equal(send('gzip', '{"ok":true}', 'application/json').headers['content-encoding'], undefined, 'small body');
  assert.equal(send('br', big, 'application/json').headers['content-encoding'], undefined, 'client without gzip');
  assert.equal(send('gzip', Buffer.alloc(5000), 'image/jpeg').headers['content-encoding'], undefined, 'binary type');
  assert.equal(send('gzip', Buffer.alloc(5000)).headers['content-encoding'], undefined, 'buffer without a type');
  const html = send('gzip', '<p>hallo</p>'.repeat(200));
  assert.equal(html.headers['content-encoding'], 'gzip');
  assert.match(html.headers['content-type'], /text\/html/);

  // Already encoded responses are left alone
  const res = fakeRes();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Encoding', 'br');
  compressResponses(req('gzip'), res, () => {});
  res.send(big);
  assert.equal(res.body, big);
});
