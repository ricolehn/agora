const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const vm = require('vm');
const { tempDir, BACKEND_DIR } = require('./helpers');

describe('backend sources', () => {
  // Also files no test loads (rarely used routes, scripts): a syntax error must not wait for production
  test('every backend file compiles', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(BACKEND_DIR);
    assert.ok(files.length > 20, 'found the backend files');
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8').replace(/^#!.*/, '');
      assert.doesNotThrow(() => vm.compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file }), file);
    }
  });
});

describe('i18n', () => {
  const i18n = require('../backend/i18n');

  test('languages: codes, regions and Accept-Language with quality values', () => {
    assert.equal(i18n.normalizeLanguage('de-DE'), 'de');
    assert.equal(i18n.normalizeLanguage('EN'), 'en');
    assert.equal(i18n.normalizeLanguage('xx'), null);
    assert.equal(i18n.normalizeLanguage(''), null);
    assert.equal(i18n.languageFromHeader('de-DE,de;q=0.9,en;q=0.8'), 'de');
    assert.equal(i18n.languageFromHeader('fr-FR,fr;q=0.9,en;q=0.5,de;q=0.4'), 'en', 'first supported by quality');
    assert.equal(i18n.languageFromHeader('fr, de;q=0'), null, 'q=0 means not wanted');
    assert.equal(i18n.languageFromHeader('*'), null);
    assert.equal(i18n.languageFromHeader(undefined), null);
  });

  test('English is the source: untranslated texts and unknown languages stay English, placeholders are filled', () => {
    assert.equal(i18n.translate('de', 'A text nobody translated'), 'A text nobody translated');
    assert.equal(i18n.translate('xx', 'Event not found'), 'Event not found');
    assert.equal(i18n.translate('en', 'Hello {name},', { name: 'Ada' }), 'Hello Ada,');
    assert.equal(i18n.translate('en', 'Keeps {unknown}'), 'Keeps {unknown}');
    assert.notEqual(i18n.translate('de', 'Event not found'), 'Event not found', 'translated when there is a translation');
  });

  // Translations are optional (open source practice): an entry left empty must not blank out the text
  test('a translation left empty keeps the English text', (t) => {
    const catalog = i18n.catalogs.de;
    const previous = catalog['Event not found'];
    t.after(() => { catalog['Event not found'] = previous; });
    for (const empty of ['', '   ']) {
      catalog['Event not found'] = empty;
      assert.equal(i18n.translate('de', 'Event not found'), 'Event not found');
    }
  });

  test('responses: error texts follow the request language, then the user, then English', () => {
    const answer = (headers, user) => {
      let sent;
      const res = { json: (body) => { sent = body; return res; } };
      i18n.translateResponses({ headers, user }, res, () => {});
      res.json({ error: 'Event not found', other: 'Event not found' });
      return sent;
    };
    assert.equal(answer({}, null).error, 'Event not found');
    assert.notEqual(answer({ 'accept-language': 'de-DE' }, null).error, 'Event not found');
    assert.notEqual(answer({}, { language: 'de' }).error, 'Event not found');
    assert.equal(answer({ 'accept-language': 'en' }, { language: 'de' }).error, 'Event not found', 'the app asks for English');
    assert.equal(answer({ 'accept-language': 'de' }, null).other, 'Event not found', 'only error / message are texts');
  });
});

describe('pathConfig', () => {
  const { resolveDataDirectory, resolvePocketBaseDirectory, resolveFrontendDirectory } = require('../backend/pathConfig');

  test('resolveDataDirectory defaults to the persistent /app/data-compatible path', () => {
    assert.equal(resolveDataDirectory({ env: {} }), path.join(__dirname, '..', 'data'));
  });

  test('resolveDataDirectory honors DATA_DIR overrides', () => {
    assert.equal(resolveDataDirectory({ env: { DATA_DIR: '/tmp/agora-data' } }), path.resolve('/tmp/agora-data'));
  });

  test('resolvePocketBaseDirectory honors POCKETBASE_DIR overrides', () => {
    assert.equal(resolvePocketBaseDirectory({
      env: { POCKETBASE_DIR: '/tmp/agora-db' }
    }), path.resolve('/tmp/agora-db'));
  });

  test('resolvePocketBaseDirectory honors DB_DIR overrides', () => {
    assert.equal(resolvePocketBaseDirectory({
      env: { DB_DIR: '/tmp/agora-db' }
    }), path.resolve('/tmp/agora-db'));
  });

  test('resolvePocketBaseDirectory uses bundled /app/db when available', () => {
    assert.equal(resolvePocketBaseDirectory({
      env: {},
      existsSync: (candidate) => candidate === path.join(__dirname, '..', 'db')
    }), path.join(__dirname, '..', 'db'));
  });

  test('resolvePocketBaseDirectory falls back to the data directory for local development', () => {
    assert.equal(resolvePocketBaseDirectory({
      env: {},
      existsSync: () => false
    }), path.join(__dirname, '..', 'data', 'pocketbase'));
  });

  test('resolveFrontendDirectory prefers FRONTEND_DIR overrides', () => {
    assert.equal(resolveFrontendDirectory({
      env: { FRONTEND_DIR: '/tmp/agora-html' }
    }), path.resolve('/tmp/agora-html'));
  });

  test('resolveFrontendDirectory uses bundled /app/html when available', () => {
    assert.equal(resolveFrontendDirectory({
      env: {},
      existsSync: (candidate) => candidate === path.join(__dirname, '..', 'html')
    }), path.join(__dirname, '..', 'html'));
  });

  test('resolveFrontendDirectory falls back to the repository root for local development', () => {
    assert.equal(resolveFrontendDirectory({
      env: {},
      existsSync: () => false
    }), path.join(__dirname, '..'));
  });
});

describe('logoStorage', () => {
  const { selectChurchLogoFilePath } = require('../backend/logoStorage');

  test('selectChurchLogoFilePath prefers uploaded logo when present', (t) => {
    const dir = tempDir(t, 'agora-logo-');
    const uploaded = path.join(dir, 'uploaded-church-logo.svg');
    const bundled = path.join(dir, 'bundled-church-logo.svg');
    fs.writeFileSync(uploaded, '<svg></svg>', 'utf8');
    fs.writeFileSync(bundled, '<svg></svg>', 'utf8');
    assert.equal(selectChurchLogoFilePath(uploaded, bundled), uploaded);
  });

  test('selectChurchLogoFilePath falls back to bundled logo when upload is absent', (t) => {
    const dir = tempDir(t, 'agora-logo-');
    const uploaded = path.join(dir, 'uploaded-church-logo.svg');
    const bundled = path.join(dir, 'bundled-church-logo.svg');
    fs.writeFileSync(bundled, '<svg></svg>', 'utf8');
    assert.equal(selectChurchLogoFilePath(uploaded, bundled), bundled);
  });
});

describe('compression', () => {
  const { pickEncoding, sendCompressedFile, compressedStatic, compressResponses } = require('../backend/compression');

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

  test('sendCompressedFile compresses text files, answers 304 and skips other files', (t) => {
    const dir = tempDir(t, 'agora-compress-');
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
  });

  test('compressedStatic stays inside its root and honours excludes', (t) => {
    const dir = tempDir(t, 'agora-static-');
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
});

describe('securityHeaders', () => {
  const { securityHeadersMiddleware } = require('../backend/securityHeaders');

  test('sets required security headers on response object for plain HTTP requests', () => {
    const headers = {};
    const res = {
      setHeader(name, value) {
        headers[name] = value;
      }
    };
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };

    const req = { secure: false, headers: {} };
    securityHeadersMiddleware(req, res, next);

    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN');
    assert.equal(headers['X-XSS-Protection'], '0');
    assert.equal(headers['Strict-Transport-Security'], undefined);
    assert.equal(nextCalled, true);
  });

  test('sets Strict-Transport-Security header when request is HTTPS via req.secure', () => {
    const headers = {};
    const res = {
      setHeader(name, value) {
        headers[name] = value;
      }
    };
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };

    const req = { secure: true, headers: {} };
    securityHeadersMiddleware(req, res, next);

    assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
    assert.equal(nextCalled, true);
  });

  test('sets Strict-Transport-Security header when request is HTTPS via x-forwarded-proto header', () => {
    const headers = {};
    const res = {
      setHeader(name, value) {
        headers[name] = value;
      }
    };
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };

    const req = { secure: false, headers: { 'x-forwarded-proto': 'https' } };
    securityHeadersMiddleware(req, res, next);

    assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
    assert.equal(nextCalled, true);
  });
});

describe('trustProxy', () => {
  const { resolveTrustProxySetting } = require('../backend/trustProxy');

  test('defaults to local and private proxy ranges when TRUST_PROXY is unset', () => {
    assert.equal(resolveTrustProxySetting(undefined), 'loopback, linklocal, uniquelocal');
  });

  test('accepts boolean trust proxy values from the environment', () => {
    assert.equal(resolveTrustProxySetting('true'), true);
    assert.equal(resolveTrustProxySetting('false'), false);
  });

  test('accepts numeric hop counts from the environment', () => {
    assert.equal(resolveTrustProxySetting('1'), 1);
  });

  test('preserves explicit proxy range strings', () => {
    assert.equal(resolveTrustProxySetting('loopback, linklocal'), 'loopback, linklocal');
  });
});

describe('svgValidation', () => {
  const { isSafeSvg, hasSvgExtension } = require('../backend/svgValidation');

  test('hasSvgExtension accepts svg extension in lowercase', () => {
    assert.equal(hasSvgExtension('church-logo.svg'), true);
  });

  test('hasSvgExtension accepts svg extension in uppercase', () => {
    assert.equal(hasSvgExtension('church-logo.SVG'), true);
  });

  test('hasSvgExtension accepts files without extension when browser omits it', () => {
    assert.equal(hasSvgExtension('church-logo'), true);
  });

  test('hasSvgExtension rejects non-svg extensions', () => {
    assert.equal(hasSvgExtension('church-logo.png'), false);
  });

  test('accepts normal svg content', () => {
    const svg = '<?xml version="1.0" encoding="utf-8"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
    assert.equal(isSafeSvg(svg), true);
  });

  test('accepts attributes that include "on" in the middle of words', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g data-configuration="default"></g></svg>';
    assert.equal(isSafeSvg(svg), true);
  });

  test('rejects script tags', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    assert.equal(isSafeSvg(svg), false);
  });

  test('rejects inline event handlers', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>';
    assert.equal(isSafeSvg(svg), false);
  });

  test('rejects uppercase inline event handlers', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" ONLOAD="alert(1)"></svg>';
    assert.equal(isSafeSvg(svg), false);
  });

  test('rejects foreignObject elements', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject></foreignObject></svg>';
    assert.equal(isSafeSvg(svg), false);
  });

  test('rejects javascript URLs', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)">x</a></svg>';
    assert.equal(isSafeSvg(svg), false);
  });

  test('rejects javascript URLs with encoded separators', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#x09;script:alert(1)">x</a></svg>';
    assert.equal(isSafeSvg(svg), false);
  });

  test('rejects javascript URLs with uppercase hex entities', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#x0A;script:alert(1)">x</a></svg>';
    assert.equal(isSafeSvg(svg), false);
  });

  test('rejects javascript URLs with entities missing semicolon', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#x09script:alert(1)">x</a></svg>';
    assert.equal(isSafeSvg(svg), false);
  });

  // One line per known trick: a new bypass only needs a new row here
  const svg = (inner, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${attrs}>${inner}</svg>`;
  const ATTACKS = {
    'script with a namespace prefix': svg('<svg:script>alert(1)</svg:script>'),
    'script in CDATA': svg('<script><![CDATA[alert(1)]]></script>'),
    'handler on the root element': svg('<rect/>', ' onload="alert(1)"'),
    'handler after a line break': svg('<rect onload\n="alert(1)"/>'),
    'handler after a slash': svg('<rect/onload="alert(1)"/>'),
    'handler on an animation': svg('<animate onbegin="alert(1)" attributeName="x"/>'),
    'xlink:href javascript': svg('<a xlink:href="javascript:alert(1)"><text>x</text></a>'),
    'javascript with a tab': svg('<a href="java\tscript:alert(1)"><text>x</text></a>'),
    'javascript with a decimal entity': svg('<a href="&#106;avascript:alert(1)"><text>x</text></a>'),
    'javascript with a hex entity': svg('<a href="&#x6A;avascript:alert(1)"><text>x</text></a>'),
    'javascript via &colon;': svg('<a href="javascript&colon;alert(1)"><text>x</text></a>'),
    'html document as data URL': svg('<a href="data:text/html;base64,PHNjcmlwdD4="><text>x</text></a>'),
    'svg document as data URL': svg('<image href="data:image/svg+xml;base64,PHN2Zz4="/>'),
    'animation that sets a javascript link': svg('<a><set attributeName="href" to="javascript:alert(1)"/><text>x</text></a>'),
    'iframe': svg('<iframe src="https://evil.example"></iframe>'),
    'embed': svg('<embed src="https://evil.example/x"/>'),
    'object': svg('<object data="https://evil.example"></object>'),
    'external use reference': svg('<use href="https://evil.example/sprite.svg#x"/>'),
    'external image': svg('<image href="https://evil.example/track.png"/>'),
    'css @import': svg('<style>@import url("https://evil.example/x.css");</style>'),
    'css url to another host': svg('<rect style="fill:url(https://evil.example/x)"/>'),
    'entity declaration (XXE)': '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + svg('<text>&x;</text>'),
    'xml stylesheet instruction': '<?xml-stylesheet href="https://evil.example/x.xsl" type="text/xsl"?>' + svg('<rect/>')
  };
  const HARMLESS = {
    'shapes and text': svg('<circle cx="5" cy="5" r="4" fill="#123456"/><text x="1" y="9" font-family="Montserrat">Agora</text>'),
    'gradients and internal references': svg('<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient><path id="p" d="M0 0h10"/></defs><use xlink:href="#p"/><rect fill="url(#g)" style="stroke:url(#g)" width="10" height="10"/>'),
    'embedded raster picture': svg('<image href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/>'),
    'attribute names containing "on"': svg('<text class="iconic" data-version="1" font-weight="bold">ok</text>'),
    'xml declaration and doctype without entities': '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">' + svg('<rect width="1" height="1"/>')
  };

  for (const [name, content] of Object.entries(ATTACKS)) {
    test(`blocks: ${name}`, () => assert.equal(isSafeSvg(content), false));
  }
  for (const [name, content] of Object.entries(HARMLESS)) {
    test(`allows: ${name}`, () => assert.equal(isSafeSvg(content), true));
  }

  test('the bundled default logo passes', () => {
    assert.equal(isSafeSvg(fs.readFileSync(path.join(__dirname, '..', 'assets', 'church-logo.svg'), 'utf8')), true);
  });
});

// docker-entrypoint.sh is a POSIX shell script: runs on Linux / macOS and in CI, skipped on Windows
describe('dockerEntryPoint', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, () => {
  const repoRoot = path.join(__dirname, '..');
  const entrypoint = path.join(repoRoot, 'docker-entrypoint.sh');

  function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'docker-entrypoint-'));
  }

  function cleanupTempDir(dir) {
    try {
      if (fs.existsSync(dir)) {
        spawnSync('rm', ['-rf', dir]);
      }
    } catch (_) {}
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (_) {}
  }

  function formatFailure(result) {
    return `exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  }

  test('docker entrypoint populates an empty frontend directory from the seed copy', () => {
    const tempRoot = makeTempDir();
    try {
      const dataDir = path.join(tempRoot, 'data');
      const dbDir = path.join(tempRoot, 'db');
      const frontendDir = path.join(tempRoot, 'html');
      const seedDir = path.join(tempRoot, 'html-seed');

      fs.mkdirSync(seedDir, { recursive: true });
      fs.writeFileSync(path.join(seedDir, 'index.html'), '<!doctype html>');
      fs.mkdirSync(path.join(seedDir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(seedDir, 'assets', 'style.css'), 'body {}');

      const result = spawnSync(entrypoint, ['/bin/sh', '-c', 'exit 0'], {
        env: {
          ...process.env,
          POCKETBASE_BIN: '/nonexistent/pocketbase', // CI sets a real binary for api.test.js; the entrypoint must not start one here
          DATA_DIR: dataDir,
          DB_DIR: dbDir,
          FRONTEND_DIR: frontendDir,
          FRONTEND_SEED_DIR: seedDir
        },
        encoding: 'utf8'
      });

      assert.equal(result.status, 0, formatFailure(result));
      assert.equal(fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8'), '<!doctype html>');
      assert.equal(fs.readFileSync(path.join(frontendDir, 'assets', 'style.css'), 'utf8'), 'body {}');
    } finally {
      cleanupTempDir(tempRoot);
    }
  });

  test('docker entrypoint preserves an existing frontend directory', () => {
    const tempRoot = makeTempDir();
    try {
      const dataDir = path.join(tempRoot, 'data');
      const dbDir = path.join(tempRoot, 'db');
      const frontendDir = path.join(tempRoot, 'html');
      const seedDir = path.join(tempRoot, 'html-seed');

      fs.mkdirSync(frontendDir, { recursive: true });
      fs.writeFileSync(path.join(frontendDir, 'index.html'), 'custom frontend');
      fs.mkdirSync(seedDir, { recursive: true });
      fs.writeFileSync(path.join(seedDir, 'index.html'), 'seed frontend');

      const result = spawnSync(entrypoint, ['/bin/sh', '-c', 'exit 0'], {
        env: {
          ...process.env,
          POCKETBASE_BIN: '/nonexistent/pocketbase', // CI sets a real binary for api.test.js; the entrypoint must not start one here
          DATA_DIR: dataDir,
          DB_DIR: dbDir,
          FRONTEND_DIR: frontendDir,
          FRONTEND_SEED_DIR: seedDir
        },
        encoding: 'utf8'
      });

      assert.equal(result.status, 0, formatFailure(result));
      // The entrypoint now always syncs seed files so upgrades take effect
      assert.equal(fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8'), 'seed frontend');
    } finally {
      cleanupTempDir(tempRoot);
    }
  });

  test('docker entrypoint updates stale frontend files on image upgrade', () => {
    const tempRoot = makeTempDir();
    try {
      const dataDir = path.join(tempRoot, 'data');
      const dbDir = path.join(tempRoot, 'db');
      const frontendDir = path.join(tempRoot, 'html');
      const seedDir = path.join(tempRoot, 'html-seed');

      // Simulate an existing volume from a previous image version
      fs.mkdirSync(path.join(frontendDir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(frontendDir, 'index.html'), 'old version');
      fs.writeFileSync(path.join(frontendDir, 'assets', 'app.js'), 'old app code');

      // Simulate a new image with updated seed files
      fs.mkdirSync(path.join(seedDir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(seedDir, 'index.html'), 'new version');
      fs.writeFileSync(path.join(seedDir, 'assets', 'app.js'), 'new app code');
      fs.writeFileSync(path.join(seedDir, 'assets', 'new-file.css'), 'added in upgrade');

      const result = spawnSync(entrypoint, ['/bin/sh', '-c', 'exit 0'], {
        env: {
          ...process.env,
          POCKETBASE_BIN: '/nonexistent/pocketbase', // CI sets a real binary for api.test.js; the entrypoint must not start one here
          DATA_DIR: dataDir,
          DB_DIR: dbDir,
          FRONTEND_DIR: frontendDir,
          FRONTEND_SEED_DIR: seedDir
        },
        encoding: 'utf8'
      });

      assert.equal(result.status, 0, formatFailure(result));
      // Existing files should be overwritten with seed content
      assert.equal(fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8'), 'new version');
      assert.equal(fs.readFileSync(path.join(frontendDir, 'assets', 'app.js'), 'utf8'), 'new app code');
      // New files from seed should appear in the frontend directory
      assert.equal(fs.readFileSync(path.join(frontendDir, 'assets', 'new-file.css'), 'utf8'), 'added in upgrade');
    } finally {
      cleanupTempDir(tempRoot);
    }
  });

  test('docker entrypoint removes stale files that no longer exist in the seed', () => {
    const tempRoot = makeTempDir();
    try {
      const dataDir = path.join(tempRoot, 'data');
      const dbDir = path.join(tempRoot, 'db');
      const frontendDir = path.join(tempRoot, 'html');
      const seedDir = path.join(tempRoot, 'html-seed');

      // Simulate an existing volume with files from a previous image version
      fs.mkdirSync(path.join(frontendDir, 'assets'), { recursive: true });
      fs.mkdirSync(path.join(frontendDir, 'old-dir'), { recursive: true });
      fs.writeFileSync(path.join(frontendDir, 'index.html'), 'old index');
      fs.writeFileSync(path.join(frontendDir, 'assets', 'app.js'), 'old app');
      fs.writeFileSync(path.join(frontendDir, 'assets', 'removed.css'), 'will be removed');
      fs.writeFileSync(path.join(frontendDir, 'old-dir', 'legacy.js'), 'will be removed');

      // New image seed no longer includes removed.css, old-dir/legacy.js
      fs.mkdirSync(path.join(seedDir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(seedDir, 'index.html'), 'new index');
      fs.writeFileSync(path.join(seedDir, 'assets', 'app.js'), 'new app');

      const result = spawnSync(entrypoint, ['/bin/sh', '-c', 'exit 0'], {
        env: {
          ...process.env,
          POCKETBASE_BIN: '/nonexistent/pocketbase', // CI sets a real binary for api.test.js; the entrypoint must not start one here
          DATA_DIR: dataDir,
          DB_DIR: dbDir,
          FRONTEND_DIR: frontendDir,
          FRONTEND_SEED_DIR: seedDir
        },
        encoding: 'utf8'
      });

      assert.equal(result.status, 0, formatFailure(result));
      // Updated files should reflect the new seed content
      assert.equal(fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8'), 'new index');
      assert.equal(fs.readFileSync(path.join(frontendDir, 'assets', 'app.js'), 'utf8'), 'new app');
      // Stale files that no longer exist in the seed should be removed
      assert.equal(fs.existsSync(path.join(frontendDir, 'assets', 'removed.css')), false);
      assert.equal(fs.existsSync(path.join(frontendDir, 'old-dir', 'legacy.js')), false);
      // Empty directory should also be cleaned up
    } finally {
      cleanupTempDir(tempRoot);
    }
  });

  test('docker entrypoint supports a dedicated PocketBase database directory', () => {
    const tempRoot = makeTempDir();
    try {
      const dataDir = path.join(tempRoot, 'data');
      const dbDir = path.join(tempRoot, 'db');
      const frontendDir = path.join(tempRoot, 'html');
      const seedDir = path.join(tempRoot, 'html-seed');

      fs.mkdirSync(seedDir, { recursive: true });
      fs.writeFileSync(path.join(seedDir, 'index.html'), '<!doctype html>');

      const result = spawnSync(entrypoint, ['/bin/sh', '-c', 'exit 0'], {
        env: {
          ...process.env,
          POCKETBASE_BIN: '/nonexistent/pocketbase', // CI sets a real binary for api.test.js; the entrypoint must not start one here
          DATA_DIR: dataDir,
          DB_DIR: dbDir,
          FRONTEND_DIR: frontendDir,
          FRONTEND_SEED_DIR: seedDir
        },
        encoding: 'utf8'
      });

      assert.equal(result.status, 0, formatFailure(result));
      assert.equal(fs.existsSync(dbDir), true);
    } finally {
      cleanupTempDir(tempRoot);
    }
  });
});
