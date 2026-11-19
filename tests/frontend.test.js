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

  test('signing out leaves nothing of the session behind for the next person on the device', () => {
    const start = app.indexOf('async function logout()');
    const logout = app.slice(start, app.indexOf('\n}\n', start));
    assert.ok(start > 0, 'found logout()');
    // the AI chat, the last open conversation and the loaded lists used to stay in the page for the next account
    assert.match(logout, /location\.reload\(\)/);
    // pushes are sent per device: unsubscribed while the token still works, before signOut
    assert.ok(logout.includes('unsubscribeDevicePush()') && logout.indexOf('unsubscribeDevicePush()') < logout.indexOf('signOut('));
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

  test('semitones between two keys, like the song page counts them', async () => {
    const { keySteps } = await load();
    assert.equal(keySteps('G', 'A'), 2);
    assert.equal(keySteps('G', 'F'), -2);
    assert.equal(keySteps('A', 'Ab'), -1);
    assert.equal(keySteps('C', 'F#'), -6);
    assert.equal(keySteps('Em', 'Gm'), 3);
    assert.equal(keySteps('G', 'G'), 0);
    assert.equal(keySteps('x', 'G'), null);
  });

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

describe('AI reply steps (assets/aiReply.js)', () => {
  const load = () => import(require('url').pathToFileURL(path.join(REPO_ROOT, 'assets', 'aiReply.js')).href);

  test('the live title: the newest heading of the thoughts, else the newest sentence, without filler words', async () => {
    const { liveTitle } = await load();
    assert.equal(liveTitle('**Checking the expenses**\n\nI look at December.\n\n**Calculating monthly expenses**\n\nThe totals per'), 'Calculating monthly expenses');
    assert.equal(liveTitle('## Finding Nick in the members\nHe joined'), 'Finding Nick in the members');
    assert.equal(liveTitle('Okay, the user asks about Christmas. Let me check the December expenses.'), 'Let me check the December expenses');
    assert.equal(liveTitle('Gut, jetzt rechne ich die Monatsausgaben zusammen.'), 'Jetzt rechne ich die Monatsausgaben zusammen');
    assert.equal(liveTitle('- Check the expenses of December\n- Check the totals of every year'), 'Check the totals of every year');
    assert.equal(liveTitle('   \n '), '');
    // A sentence that says nothing gives no title: the one before it stays
    assert.equal(liveTitle('I check the books first. Hmm. Yes.'), 'I check the books first');
    const long = liveTitle(`Now I compare ${'every single payment of every member '.repeat(4)}since 2019.`);
    assert.ok(long.length <= 72 && long.endsWith('…'), long);
    assert.ok(liveTitle('Now I compare every single payment of every member since 2019.', { max: 30 }).length <= 30);
  });

  test('while the thoughts come in, only what is finished gives a title - it never writes itself letter by letter', async () => {
    const { liveTitle } = await load();
    const live = (text) => liveTitle(text, { settled: false });
    // A heading counts when its line is over
    assert.equal(live('**Und'), '');
    assert.equal(live('**Understanding the question**'), '');
    assert.equal(live('**Understanding the question**\n'), 'Understanding the question');
    assert.equal(live('**Understanding the question**\n\nThe person wants to know what the services cost. I should'), 'Understanding the question');
    assert.equal(live('**Checking the expenses**\n\nI look at December.\n\n**Calculating monthly'), 'Checking the expenses');
    assert.equal(live('## Finding Nick in the mem'), '');
    // Bold words at the start of a line are no heading
    assert.equal(live('I look at the members first.\n**Important** is the'), 'I look at the members first');
    // A sentence counts when the next one has begun
    assert.equal(live('I need the yearly'), '');
    assert.equal(live('I need the yearly totals.'), '');
    assert.equal(live('I need the yearly totals. Then I'), 'I need the yearly totals');
    assert.equal(live('I need the yearly totals. Then I compare them with the budget'), 'I need the yearly totals');
    assert.equal(live('I need the yearly totals. Then I compare them with the budget. Af'), 'Then I compare them with the budget');
    assert.equal(live('I need the yearly totals.\n'), 'I need the yearly totals');
    // A full stop inside a number or an abbreviation ends nothing
    assert.equal(live('The candles cost 3.'), '');
    assert.equal(live('The candles cost 3.50 euros, e.g. the red ones. Next'), 'The candles cost 3.50 euros, e.g. the red ones');
    // The same text as it grows: the title only changes from one finished title to the next
    const thought = 'Okay, the user asks about Christmas. Let me check the December expenses. Then I add them up per year.';
    const titles = new Set();
    for (let length = 1; length <= thought.length; length += 1) titles.add(live(thought.slice(0, length)));
    assert.deepEqual([...titles], ['', 'The user asks about Christmas', 'Let me check the December expenses']);
    assert.equal(liveTitle(thought), 'Then I add them up per year', 'complete, the last sentence counts as well');
  });

  test('the steps: thoughts per round, text before a lookup becomes a note, lookups get what they found', async () => {
    const { createReplyWork, splitAiThinking } = await load();
    const work = createReplyWork();
    for (const part of [
      { reasoning: 'Die Zusammenfassung reicht nicht.' },
      { content: 'Ich schaue nach.' },
      { lookup: { id: 1, tool: 'expenses', step: 'Suche die Weihnachtskosten' } },
      { lookupDone: { id: 1, count: 3, unit: 'entries', eur: 57.85 } },
      { reasoning: '\n\n' }, { reasoning: 'Drei Einträge.' },
      { content: '\n\n' }, { content: 'Zusammen 57,85 €.' }
    ]) work.add(part);
    assert.deepEqual(work.steps, [
      { kind: 'thought', text: 'Die Zusammenfassung reicht nicht.' },
      { kind: 'note', text: 'Ich schaue nach.' },
      { kind: 'lookup', lookup: { id: 1, tool: 'expenses', step: 'Suche die Weihnachtskosten' }, done: { id: 1, count: 3, unit: 'entries', eur: 57.85 } },
      { kind: 'thought', text: '\n\nDrei Einträge.' }
    ]);
    assert.equal(splitAiThinking(work.content).answer, 'Zusammen 57,85 €.');
    assert.equal(work.lookups, 1);

    // <think> blocks in the text (models without a reasoning field) go into the steps as thoughts
    const inline = createReplyWork();
    for (const part of [{ content: '<think>Erst nachschlagen.</think>Moment.' }, { lookup: { id: 1, tool: 'members' } }]) inline.add(part);
    assert.deepEqual(inline.steps.map((step) => [step.kind, step.text]), [['thought', 'Erst nachschlagen.'], ['note', 'Moment.'], ['lookup', undefined]]);
  });

  test('a lookup is named in the model\'s words when it gave some, else by what it reads; what it found is counted', async () => {
    const { lookupTitle, lookupWhat, lookupFound, liveLabel, createReplyWork } = await load();
    const lookup = { id: 2, tool: 'expenses', from: '2019', to: '2024', about: 'Christmas' };
    assert.equal(lookupWhat(lookup), 'expenses 2019–2024 “Christmas”');
    assert.equal(lookupWhat({ tool: 'members', from: '2019' }), 'members since 2019');
    assert.equal(lookupWhat({ tool: 'something new' }), 'data');
    assert.equal(lookupTitle(lookup), 'expenses 2019–2024 “Christmas”');
    assert.equal(lookupTitle({ ...lookup, step: '  finding   Nick in the members ' }), 'Finding Nick in the members');
    assert.equal(lookupFound({ count: 3, unit: 'entries', eur: 57.85 }), '3 entries · 57.85 €');
    assert.equal(lookupFound({ count: 1, unit: 'events', cut: true }), '1 event · shortened');
    assert.equal(lookupFound({ error: 'forbidden' }), 'not allowed');
    assert.equal(lookupFound({ error: 'something' }), 'failed');
    assert.equal(lookupFound(null), '');

    // The live line: the lookup it is on (also while it reads the result), then the newest thought - once it has a
    // finished title (the thoughts that are still coming in may be in the middle of one)
    const work = createReplyWork();
    assert.equal(liveLabel(work), '');
    work.add({ reasoning: '**Reading the question**' });
    assert.equal(liveLabel(work), '', 'the heading may still grow');
    work.add({ reasoning: '\n\nThe person asks' });
    assert.equal(liveLabel(work), 'Reading the question');
    work.add({ lookup: { ...lookup, step: 'Suche die Weihnachtskosten' } });
    assert.equal(liveLabel(work), 'Suche die Weihnachtskosten');
    work.add({ lookupDone: { id: 2, count: 3, unit: 'entries' } });
    assert.equal(liveLabel(work), 'Suche die Weihnachtskosten');
    work.add({ reasoning: 'Jetzt rechne ich die Summe pro Jahr aus.' });
    assert.equal(liveLabel(work), 'Suche die Weihnachtskosten', 'the lookup stays until the new thought has a title');
    work.add({ reasoning: ' Dann vergleiche' });
    assert.equal(liveLabel(work), 'Jetzt rechne ich die Summe pro Jahr aus');
    assert.equal(liveLabel(work, 'Prüfe die Mitglieder. Dann'), 'Prüfe die Mitglieder');
    assert.equal(liveLabel(work, 'Prüfe die Mitgl'), 'Jetzt rechne ich die Summe pro Jahr aus', 'a <think> block without a finished sentence yet');

    // Thoughts that are over count in full: a lookup or the text of the round follows them
    const over = createReplyWork();
    over.add({ reasoning: '**Reading the question**' });
    over.add({ content: 'Moment.' });
    assert.equal(liveLabel(over), 'Reading the question');
    over.add({ lookup: { id: 1, tool: 'members' } });
    over.add({ reasoning: 'Nick ist seit 2019 dabei.' });
    over.add({ content: 'Nick' });
    assert.equal(liveLabel(over), 'Nick ist seit 2019 dabei');
  });

  test('the titles of the live line are paced: each stays long enough to be read, of those in between only the newest shows', async () => {
    const { createTitlePacer, readingTime } = await load();
    // A short title stays about a second and a half, a long sentence longer - but none for ever
    assert.equal(readingTime('Adding up each year'), 1400);
    assert.ok(readingTime('I will look up the expenses from 2021 to 2025 with those words') > 2000);
    assert.equal(readingTime('x'.repeat(500)), 2600);
    // A clock of its own: [advance] lets the time pass and runs what is due
    let time = 0;
    let timers = [];
    const advance = (ms) => {
      const until = time + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        time = due.at;
        due.run();
      }
      time = until;
    };
    const clock = { now: () => time, later: (run, ms) => { const timer = { at: time + ms, run }; timers.push(timer); return timer; }, cancel: (timer) => { timers = timers.filter((entry) => entry !== timer); } };
    const shown = [];
    const pacer = createTitlePacer((title, tag) => shown.push([time, title, tag]), { minShown: 1000, ...clock });

    assert.equal(pacer.title, null);
    pacer.want('Thinking', { tag: true });
    assert.deepEqual(shown, [[0, 'Thinking', true]], 'the first title shows at once');
    assert.equal(pacer.title, 'Thinking');
    assert.equal(pacer.tag, true);

    // Titles that come faster than they can be read: the first waits its turn, the ones in between are left out
    advance(300);
    pacer.want('Reading the question', { tag: true });
    advance(300);
    pacer.want('Checking the expenses', { tag: true });
    pacer.want('Checking the expenses', { tag: true });
    advance(300);
    pacer.want('Adding up each year', { tag: true });
    assert.equal(shown.length, 1);
    advance(100);
    assert.deepEqual(shown[1], [1000, 'Adding up each year', true]);
    assert.equal(timers.length, 0);

    // After its time a title is replaced at once; asking for the one that shows changes nothing
    advance(2500);
    pacer.want('Adding up each year', { tag: true });
    pacer.want('Writing the answer', { tag: true });
    assert.deepEqual(shown[2], [3500, 'Writing the answer', true]);
    assert.equal(shown.length, 3);

    // [hold]: how long the title before stays for this one
    advance(100);
    pacer.want('Finding Nick', { tag: true, hold: 400 });
    advance(299);
    assert.equal(shown.length, 3);
    advance(1);
    assert.deepEqual(shown[3], [3900, 'Finding Nick', true]);

    // [delay]: "Thought" has to be wanted for a while - text before a lookup is no answer, and then it never shows
    advance(2000);
    pacer.want('Thought', { tag: false, delay: 700 });
    advance(500);
    pacer.want('Thought', { tag: false, delay: 700 });
    pacer.want('Looking up the members', { tag: true });
    advance(1000);
    assert.deepEqual(shown[4], [6400, 'Looking up the members', true]);
    assert.equal(shown.length, 5);
    advance(1000);
    pacer.want('Thought', { tag: false, delay: 700 });
    advance(699);
    pacer.want('Thought', { tag: false, delay: 700 });
    assert.equal(shown.length, 5, 'asked again, the wait does not start anew');
    advance(1);
    assert.deepEqual(shown[5], [9100, 'Thought', false]);
    assert.equal(pacer.tag, false);

    // The same words with another tag are another title; without a hold it shows at once (the reply is complete)
    pacer.want('Thought', { tag: true, hold: 0 });
    assert.deepEqual(shown[6], [9100, 'Thought', true]);

    // A title that waits is forgotten when the one that shows is wanted again, or when the pacer stops
    pacer.want('Something else', { tag: true });
    pacer.want('Thought', { tag: true });
    advance(5000);
    pacer.want('Too late', { tag: true });
    assert.equal(shown.length, 8);
    pacer.want('Never', { tag: true });
    pacer.stop();
    advance(5000);
    assert.equal(shown.length, 8);
    assert.equal(timers.length, 0);
  });
});

// The points of an SVG path ("M x y C x y x y x y …"): every number pair in order
const pathPoints = (d) => [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).reduce((pairs, value, i, all) => (i % 2 ? pairs : [...pairs, [value, all[i + 1]]]), []);
/** Every url(#…) of an SVG's markup points to an id of the same markup. */
const ownReferences = (markup) => [...markup.matchAll(/url\(#([^)]+)\)/g)].every((m) => markup.includes(`id="${m[1]}"`));

describe('the assistant\'s sign (assets/aiSign.js), as in the Android app', () => {
  const load = () => import(require('url').pathToFileURL(path.join(REPO_ROOT, 'assets', 'aiSign.js')).href);

  test('a soft form at rest is a true circle; moving, its points keep their directions and only move in and out', async () => {
    const { softFormPath } = await load();
    // Seven curves; at rest every point - also halfway along each curve - lies on the circle
    const still = pathPoints(softFormPath(50, 50, 40, 3.2, 0, 1.3));
    assert.equal(still.length, 1 + 7 * 3);
    const bezier = (p0, c1, c2, p3, s) => [0, 1].map((k) => (1 - s) ** 3 * p0[k] + 3 * (1 - s) ** 2 * s * c1[k] + 3 * (1 - s) * s * s * c2[k] + s ** 3 * p3[k]);
    for (let i = 0; i < 7; i += 1) {
      const [p0, c1, c2, p3] = [still[i * 3], still[i * 3 + 1], still[i * 3 + 2], still[i * 3 + 3]];
      for (const point of [p3, bezier(p0, c1, c2, p3, 0.5)]) assert.ok(Math.abs(Math.hypot(point[0] - 50, point[1] - 50) - 40) < 0.15, `curve ${i}: ${point}`);
    }
    const ends = (t) => pathPoints(softFormPath(50, 50, 40, t, 0.12, 4.1)).filter((_, i) => i === 0 || i % 3 === 0).slice(0, 7);
    const [now, later] = [ends(2), ends(2.7)];
    for (let i = 0; i < 7; i += 1) {
      const angle = (p) => Math.atan2(p[1] - 50, p[0] - 50);
      assert.ok(Math.abs(angle(now[i]) - angle(later[i])) < 0.01, `point ${i} keeps its direction`);
      for (const p of [now[i], later[i]]) assert.ok(Math.abs(Math.hypot(p[0] - 50, p[1] - 50) - 40) <= 40 * 0.12 + 0.01, `point ${i} stays near its circle`);
    }
    assert.notDeepEqual(now, later, 'the outline changes');
  });

  test('sand behind up right, lagoon in front down left; the halo only for large signs and while it thinks', async () => {
    const { signFrame } = await load();
    const middle = (form) => [(form.x1 + form.x2) / 2, (form.y1 + form.y2) / 2];
    for (const t of [0, 7.5, 33]) {
      const frame = signFrame(t);
      const [back, front] = [middle(frame.back), middle(frame.front)];
      assert.ok(back[0] > 50 && back[1] < 50, `t ${t}: sand ${back}`);
      assert.ok(front[0] < 50 && front[1] > 50, `t ${t}: lagoon ${front}`);
      // The light falls from the upper left: each form's gradient starts up left of its middle
      for (const form of [frame.back, frame.front]) assert.ok(form.x1 < form.x2 && form.y1 < form.y2);
    }
    assert.equal(signFrame(4).halo.strength, 0);
    assert.equal(signFrame(4, 0, true).halo.strength, 0.25);
    assert.ok(Math.abs(signFrame(4, 1, true).halo.strength - 1.2) < 1e-9);
    for (const energy of [0, 0.5, 1]) {
      const { stops, r } = signFrame(2.1, energy, true).halo;
      assert.ok(r > 50 && stops[0] > 0 && stops[0] < stops[1] && stops[1] < 1, `${energy}: ${stops} ${r}`);
    }
  });

  test('its pace eases: calm it runs, thinking it runs 2.4 times as fast, resting it slows down and stops', async () => {
    const { createSignMotion, fastOutSlowIn } = await load();
    assert.equal(fastOutSlowIn(0), 0);
    assert.equal(fastOutSlowIn(1), 1);
    const curve = [0.1, 0.3, 0.5, 0.7, 0.9].map(fastOutSlowIn);
    assert.ok(curve.every((y, i) => i === 0 || y > curve[i - 1]) && curve[2] > 0.7, `${curve}`);
    const motion = createSignMotion(5);
    let now = 0;
    const run = (ms) => {
      let last;
      for (let step = 0; step < ms; step += 16) last = motion.advance((now += 16));
      return last;
    };
    run(16);
    const calm = run(1000);
    assert.ok(Math.abs(calm.time - 5 - 1) < 0.05 && calm.moving && calm.energy === 0, JSON.stringify(calm));
    motion.set('thinking', now);
    const easing = run(1400);
    assert.ok(easing.energy === 1, 'lively after 0.9 s');
    const fast = run(1000);
    assert.ok(Math.abs(fast.time - easing.time - 2.4) < 0.05, `${fast.time - easing.time}`);
    motion.set('resting', now);
    const slowing = run(700);
    assert.ok(slowing.moving && slowing.energy < 1);
    const rested = run(800);
    assert.equal(rested.moving, false);
    assert.equal(run(1000).time, rested.time, 'at rest it stays');
    // Out of sight for a while: no jump when it is seen again
    motion.set('calm', now);
    run(1500);
    const before = motion.time;
    motion.advance((now += 60000));
    assert.ok(motion.time - before <= 0.1);
  });

  test('every sign has gradients of its own; still signs and glow are marked for the page', async () => {
    const { aiSignMarkup } = await load();
    const [one, two] = [aiSignMarkup({ size: 28, seed: 7.3 }), aiSignMarkup({ size: 76 })];
    for (const markup of [one, two]) assert.ok(ownReferences(markup), markup);
    const ids = (markup) => [...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(ids(one).filter((id) => ids(two).includes(id)).length, 0);
    assert.match(one, /--ai-sign-size: 28px/);
    assert.doesNotMatch(one, /data-glow/);
    assert.match(two, /data-glow/, 'large signs glow at rest');
    assert.match(aiSignMarkup({ size: 132, still: true, glow: false }), /data-still/);
  });
});

describe('motifs and painted fields (assets/motifs.js), as in the Android app', () => {
  const load = () => import(require('url').pathToFileURL(path.join(REPO_ROOT, 'assets', 'motifs.js')).href);

  test('each motif draws with its own gradients only, however many are on the page', async () => {
    const { motifSvg, MOTIF_SEEDS } = await load();
    const all = Object.keys(MOTIF_SEEDS).map((motif) => motifSvg(motif));
    for (const markup of all) {
      assert.ok(ownReferences(markup), markup.slice(0, 200));
      assert.match(markup, /^<svg class="motif" viewBox="0 0 100 100"/);
    }
    const ids = all.flatMap((markup) => [...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(motifSvg('unknown').includes('<path'), true, 'an unknown motif is a document');
  });

  test('a document takes the colour of its kind; colours mix like the app\'s (Oklab)', async () => {
    const { motifSvg, mixColor } = await load();
    assert.equal(mixColor('#000000', '#ffffff', 0.5), '#636363');
    assert.equal(mixColor('#4a7fd6', '#4a7fd6', 0.3), '#4a7fd6');
    assert.equal(mixColor('#4a7fd6', '#ffffff', 1), '#ffffff');
    const pdf = motifSvg('document', { accent: '#d6667c' });
    assert.ok(pdf.includes('fill="#d6667c"'), 'the title line');
    assert.ok(pdf.includes(`fill="${mixColor('#d6667c', '#ffffff', 0.62)}"`), 'the lines, lighter');
    assert.ok(pdf.includes(`stop-color="${mixColor('#d6667c', '#ffffff', 0.3)}"`), 'the folded corner');
  });

  test('rounded corners never take more than half an edge', async () => {
    const { roundedPolygon } = await load();
    // A tab's short slope (9 × 9.5) with corners of 7: each corner takes at most half of it
    const points = pathPoints(roundedPolygon([[38, 19], [47, 28.5], [93, 28.5], [93, 83], [7, 83], [7, 19]], 7));
    const edge = Math.hypot(9, 9.5);
    assert.ok(Math.hypot(points[2][0] - 38, points[2][1] - 19) <= edge / 2 + 0.01, `${points[2]}`);
    assert.match(roundedPolygon([[0, 0], [10, 0], [10, 10]], 2), /^M.*Q.*Z$/);
  });

  test('a painted field: its colours, its still forms placed by every name as in the app', async () => {
    const { paintedField, seedOf } = await load();
    // The app's (name.hashCode() and 0xFFFF) / 6553.5
    assert.equal(seedOf(''), 0);
    assert.ok(Math.abs(seedOf('Fotos') - 6.398870832379645) < 1e-12);
    assert.ok(Math.abs(seedOf('Sommerfest 2026') - 0.511635004196231) < 1e-12);
    assert.ok(Math.abs(seedOf('Bühne') - 1.9099717708094912) < 1e-12);
    assert.ok(Math.abs(seedOf('😀 Emoji') - 8.561074235141527) < 1e-12, 'UTF-16 like Java');
    const field = paintedField({ light: '#f6c7a4', deep: '#e0874f', hint: '#f9da9e' }, seedOf('Fotos'), '<i>x</i>', 'media-folder-field');
    assert.match(field, /^<span class="painted-field media-folder-field" style="--field-light: #f6c7a4; --field-deep: #e0874f; --field-hint: #f9da9e">/);
    assert.equal((field.match(/<path class="painted-field-(upper|lower)"/g) || []).length, 2);
    assert.ok(field.endsWith('<i>x</i></span>'));
    assert.notEqual(paintedField({ light: '#fff', deep: '#000' }, 1), paintedField({ light: '#fff', deep: '#000' }, 2), 'another seed, other forms');
    assert.match(paintedField({ light: '#aaaaaa', deep: '#000000' }, 1), /--field-hint: #aaaaaa/, 'without a hint the light tone');
  });
});

describe('donations and expenses (assets/app.js)', () => {
  /** A function of app.js as it is written there (up to the brace that closes it). */
  const take = (name) => {
    const start = app.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `found ${name}()`);
    return app.slice(start, app.indexOf('\n}\n', start) + 2);
  };
  // The web app's way of changing a list (mutateCollection) against a stand-in server: the current one, or the
  // previous version, which serves while the upgrade waits and takes transactions of people only
  function againstServer({ previous, refused = previous }) {
    const server = { list: [{ id: 1, amount: 10, name: 'Anna' }] };
    const parts = {
      db: {},
      API: '/api',
      ref: (database, name) => name,
      apiGet: async () => structuredClone(server.list),
      set: async (name, value) => { server.list = structuredClone(value); },
      runTransaction: async (name, update) => {
        if (refused) throw Object.assign(new Error('Refused (test).'), { status: 400 });
        const next = update(structuredClone(server.list));
        if (next !== undefined) server.list = next;
      },
      // The previous version's status names no API versions
      fetch: async () => ({ ok: true, json: async () => (previous ? { ready: true, upgrade: { state: 'waiting' } } : { ready: true, apiVersions: [1, 2] }) })
    };
    const code = `${app.match(/^const safeList = .*$/m)[0]}\n${take('mutateCollection')}\n${take('isPreviousServer')}\nreturn mutateCollection;`;
    return { server, mutateCollection: new Function(...Object.keys(parts), code)(...Object.values(parts)) };
  }

  test('while the upgrade waits, the previous version takes them too: added, changed and deleted', async () => {
    // It refused every change of the lists with 400 - nothing could be added, changed or deleted at all
    for (const previous of [false, true]) {
      const { server, mutateCollection } = againstServer({ previous });
      await mutateCollection('donations', (list) => [...list, { id: 2, amount: 25, name: 'Ben' }]);
      await mutateCollection('donations', (list) => list.map((entry) => (entry.id === 2 ? { ...entry, amount: 30 } : entry)));
      await mutateCollection('donations', (list) => list.filter((entry) => entry.id !== 1));
      assert.deepEqual(server.list, [{ id: 2, amount: 30, name: 'Ben' }], previous ? 'on the previous version' : 'on the current server');
    }
  });

  test('a refusal of the current server stands: the list is never written past it', async () => {
    const { server, mutateCollection } = againstServer({ previous: false, refused: true });
    await assert.rejects(mutateCollection('expenses', (list) => [...list, { id: 3, amount: 5 }]), { status: 400 });
    assert.deepEqual(server.list, [{ id: 1, amount: 10, name: 'Anna' }]);
  });
});

