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
// en.json must be valid; translations are optional and only used to spot translated text in the code
const locales = { en: JSON.parse(read('assets/locales/en.json')) };
for (const file of fs.readdirSync(path.join(REPO_ROOT, 'assets', 'locales')).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
  try { locales[path.basename(file, '.json')] = JSON.parse(read(`assets/locales/${file}`)); } catch { /* a broken translation is not the tests' business */ }
}

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

  // English (en.json) is the source of truth and has to be complete. Translations are not checked: like in most
  // open source projects they may be partial, untranslated texts are simply left empty and show in English.
  test('English, the source language, has a text for every key and no key twice', () => {
    assert.deepEqual(Object.entries(locales.en).filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => k), [], 'empty texts in en.json');
    const counts = {};
    for (const m of read('assets/locales/en.json').matchAll(/^\s*"((?:[^"\\]|\\.)+)"\s*:/gm)) counts[m[1]] = (counts[m[1]] || 0) + 1;
    assert.deepEqual(Object.keys(counts).filter((key) => counts[key] > 1), [], 'keys that appear twice in en.json (JSON.parse keeps only the last one)');
  });

  test('element ids in index.html are unique (getElementById only finds the first)', () => {
    const counts = {};
    for (const m of html.matchAll(/\sid="([^"${}]+)"/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
    assert.ok(Object.keys(counts).length > 100, 'found the ids');
    assert.deepEqual(Object.keys(counts).filter((id) => counts[id] > 1), []);
  });

  test('every translation key used in the pages and app.js exists in English (the source language)', () => {
    const used = new Set();
    for (const page of [html, read('setup.html')]) {
      for (const m of page.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) used.add(m[1]);
      for (const m of page.matchAll(/\bt\(\s*'([\w.-]+)'/g)) used.add(m[1]);
    }
    for (const m of app.matchAll(/\bt\(\s*'([\w.-]+)'/g)) used.add(m[1]);
    assert.ok(used.size > 100, 'found the keys');
    assert.deepEqual([...used].filter((k) => !(k in locales.en)).sort(), []);
  });

  test('the code is written in English: fallbacks and page defaults are the English texts', () => {
    // t('key', 'fallback') and the default text of data-i18n elements are what readers of the code see
    // (a fallback that lags behind an edited English text is fine; one in another language is not)
    const translated = [];
    for (const source of [app, read('setup.html')]) {
      for (const m of source.matchAll(/\bt\(\s*'([\w.-]+)'\s*,\s*'((?:[^'\\]|\\.)*)'/g)) {
        const [key, fallback] = [m[1], m[2].replace(/\\(.)/g, '$1')];
        for (const [lang, texts] of Object.entries(locales)) {
          if (lang !== 'en' && texts[key] === fallback && locales.en[key] !== fallback) translated.push(`${key} (${lang}): ${fallback}`);
        }
      }
    }
    assert.deepEqual(translated, [], 't() fallbacks must be the English text');
    assert.match(html, /<html[^>]*\slang="en"/);
    assert.match(read('setup.html'), /<html[^>]*\slang="en"/);
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

describe('songbook (assets/songbook.js)', () => {
  const load = () => import(require('url').pathToFileURL(path.join(REPO_ROOT, 'assets', 'songbook.js')).href);

  test('only real chords are chords: words in brackets stay text', async () => {
    const { parseChord } = await load();
    for (const chord of ['G', 'F#m7', 'D/F#', 'Gsus4', 'Cmaj7', 'Bbm', 'A7(b9)', 'Cm(maj7)', 'H7', 'Ddim', 'E5', 'Gadd9']) {
      assert.ok(parseChord(chord), chord);
    }
    for (const text of ['Bridge', 'Chorus', 'N.C.', 'End', 'x', '', 'A'.repeat(40)]) assert.equal(parseChord(text), null, text);
  });

  test('transposing spells the target key: flats for flat keys, sharps otherwise, bass notes too', async () => {
    const { transposeChord, spellingFor, transposedKey } = await load();
    const up = (chord, content, key, steps) => transposeChord(chord, steps, spellingFor(content, key, steps));
    assert.deepEqual(['D', 'G', 'A', 'Bm'].map((c) => up(c, '[D]a', 'D', 1)), ['Eb', 'Ab', 'Bb', 'Cm']);
    assert.deepEqual(['G', 'C', 'D'].map((c) => up(c, '[G]a', 'G', 2)), ['A', 'D', 'E']);
    assert.equal(up('D/F#', '[D]a', 'D', 2), 'E/G#');
    assert.equal(up('Em', '[Em]a', 'Em', 3), 'Gm');
    assert.equal(transposeChord('Bridge', 2, {}), 'Bridge');
    // The key label always matches the chords below it
    assert.equal(transposedKey('G', '[G]x', 1), 'Ab');
    assert.equal(transposedKey('', '[G]x', 1), '');
  });

  test('German notation: B is Bb, H is B, and stays German', async () => {
    const { transposeChord, spellingFor } = await load();
    const spelling = spellingFor('[F]a [B]b [H]c', 'F', 2);
    assert.deepEqual(['F', 'B', 'C', 'H'].map((c) => transposeChord(c, 2, spelling)), ['G', 'C', 'D', 'C#']);
    assert.equal(transposeChord('C', 11, spellingFor('[C]a [H]b', 'C', 11)), 'H');
  });

  test('lines: sections, ChordPro directives, notes, chord-only lines and words that keep their chord', async () => {
    const { parseSong } = await load();
    const song = '# Verse 1\n[G]Amazing [D]grace\n\n\n[Bridge]\n{capo: 2}\n{c: Chorus}\n{soc}\n> twice\n[G] [D]';
    assert.deepEqual(parseSong(song).map((l) => l.type), ['section', 'chords', 'gap', 'section', 'section', 'section', 'note', 'chords']);
    // Without chords a line of chords alone disappears; {capo} never becomes a heading
    assert.deepEqual(parseSong(song, { chords: false }).map((l) => l.type), ['section', 'text', 'gap', 'section', 'section', 'section', 'note']);
    assert.deepEqual(parseSong('Ama[G]zing [D]grace')[0].words, [[{ chord: null, text: 'Ama' }, { chord: 'G', text: 'zing ' }], [{ chord: 'D', text: 'grace' }]]);
  });

  test('rendering escapes everything and a crafted line cannot hang the page', async () => {
    const { renderSongHtml } = await load();
    const html = renderSongHtml('[G]<img src=x onerror=alert(1)> & [C]"x"\n# <b>\n{c: <i>}');
    assert.ok(!html.includes('<img') && !html.includes('<b>') && !html.includes('<i>'));
    const started = Date.now();
    renderSongHtml(`{c${' '.repeat(19990)}x\n[${'A'.repeat(19990)}]\n${' '.repeat(19990)}x`);
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
  });

  test('search ignores chords, case and accents', async () => {
    const { searchText, normalizeSearch } = await load();
    const text = searchText({ title: 'Herr, ich komme zu Dir', artist: 'Zoë Müller', content: '[G]Amazing [D]grace', ccli: '22025' });
    for (const query of ['Amazing grace', 'ZOE MULLER', 'zoë', '22025', 'komme zu dir']) assert.ok(text.includes(normalizeSearch(query)), query);
    assert.ok(!text.includes('[g]'));
  });
});
