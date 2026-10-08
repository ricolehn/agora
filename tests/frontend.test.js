// Static checks of the web app (no browser): syntax, translations, inline handlers and referenced files.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO_ROOT, tempDir } = require('./helpers');

const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(REPO_ROOT, file.replace(/^\.?\//, '')));
const app = read('assets/app.js');
const html = read('index.html');
const locales = { de: JSON.parse(read('assets/locales/de.json')), en: JSON.parse(read('assets/locales/en.json')) };

/** Function names an inline handler (onclick="…", also inside app.js templates) calls. */
function handlerCalls(text) {
  const names = new Set();
  const code = text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  for (const m of code.matchAll(/\bon[a-z]+\s*=\s*(["'])([\s\S]*?)\1/g)) {
    const handler = m[2].replace(/\$\{[^}]*\}/g, '');   // template placeholders are evaluated when rendering
    for (const call of handler.matchAll(/(?:^|[^.\w$])(?:window\.)?([A-Za-z_$][\w$]*)\s*\(/g)) names.add(call[1]);
  }
  return names;
}

/** Names the page can call: exported via Object.assign(window, {...}) or window.x = …, or declared in inline scripts. */
function globalNames() {
  const names = new Set(['event', 'if', 'return', 'void', 'alert', 'confirm', 'setTimeout', 'Number', 'String', 'parseInt', 'parseFloat', 'encodeURIComponent']);
  for (const block of app.matchAll(/Object\.assign\(window,\s*\{([\s\S]*?)\}\);/g)) {
    let depth = 0;
    let token = '';
    for (const ch of block[1] + ',') {
      if ('{(['.includes(ch)) depth++;
      if ('})]'.includes(ch)) depth--;
      if (depth === 0 && ch === ',') {
        const name = token.trim().match(/^([A-Za-z_$][\w$]*)/);
        if (name) names.add(name[1]);
        token = '';
      } else if (depth === 0) token += ch;
    }
  }
  for (const m of app.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) names.add(m[1]);
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    for (const f of m[1].matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) names.add(f[1]);
  }
  return names;
}

describe('frontend', () => {
  test('app.js (ES module) and the service worker parse', (t) => {
    const copy = path.join(tempDir(t, 'agora-frontend-'), 'app.mjs');
    fs.writeFileSync(copy, app);
    for (const file of [copy, path.join(REPO_ROOT, 'sw.js')]) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${path.basename(file)}:\n${result.stderr}`);
    }
  });

  test('German and English have the same keys, no empty texts and the same placeholders', () => {
    const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    assert.deepEqual(Object.keys(locales.de).filter((k) => !(k in locales.en)), [], 'only in de.json');
    assert.deepEqual(Object.keys(locales.en).filter((k) => !(k in locales.de)), [], 'only in en.json');
    for (const [lang, texts] of Object.entries(locales)) {
      assert.deepEqual(Object.entries(texts).filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => k), [], `empty texts in ${lang}.json`);
    }
    const differing = Object.keys(locales.de).filter((k) => placeholders(locales.de[k]) !== placeholders(locales.en[k]));
    assert.deepEqual(differing, [], 'placeholders differ between de and en');
  });

  test('every translation key used in index.html and app.js exists', () => {
    const used = new Set();
    for (const m of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) used.add(m[1]);
    for (const m of app.matchAll(/\bt\(\s*'([\w.-]+)'/g)) used.add(m[1]);
    assert.ok(used.size > 100, 'found the keys');
    assert.deepEqual([...used].filter((k) => !(k in locales.de)).sort(), []);
  });

  test('inline handlers only call functions the page exposes', () => {
    const known = globalNames();
    const calls = new Set([...handlerCalls(html), ...handlerCalls(app)]);
    assert.ok(calls.size > 50, 'found the handlers');
    assert.deepEqual([...calls].filter((name) => !known.has(name)).sort(), [], 'onclick & co. call a function that is not on window');
  });

  test('files referenced by index.html, the manifest and the service worker exist', () => {
    // Only files (with an extension): extensionless links like /privacy are server routes
    const pageFiles = [...html.matchAll(/(?:src|href)="(?!https?:|data:|#|mailto:)([^"?#]+\.\w+)/g)].map((m) => m[1]);
    const manifestFiles = (JSON.parse(read('manifest.json')).icons || []).map((icon) => icon.src);
    const cached = (read('sw.js').match(/URLS_TO_CACHE\s*=\s*\[([\s\S]*?)\]/) || [, ''])[1];
    const workerFiles = [...cached.matchAll(/'([^']+\.\w+)'/g)].map((m) => m[1]);
    const all = [...pageFiles, ...manifestFiles, ...workerFiles];
    assert.ok(all.length > 10, 'found the references');
    assert.deepEqual(all.filter((file) => !exists(file)), []);
  });
});
