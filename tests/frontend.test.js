// Static checks of the web app (web/, no browser): texts, the page shell, the service worker and referenced files;
// and the pure modules the app shares with these tests (web/src/lib). The app's TypeScript, its Solid rules and its
// build are checked by `npm run check`, `npm run lint` and `npm run build` in web/ (CI runs them).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { REPO_ROOT, tempDir } = require('./helpers');

const WEB = path.join(REPO_ROOT, 'web');
const read = (file) => fs.readFileSync(path.join(WEB, file), 'utf8');
const lib = (name) => import(pathToFileURL(path.join(WEB, 'src', 'lib', name)).href);

/** Every source file of the app (TypeScript and JavaScript under web/src). */
function sourceFiles(dir = path.join(WEB, 'src')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(tsx?|jsx?)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}
/** The app's stylesheets (Tailwind entry and the few feature stylesheets). */
function cssFiles(dir = path.join(WEB, 'src')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? cssFiles(full) : entry.name.endsWith('.css') ? [full] : [];
  });
}
const sources = sourceFiles().map((file) => ({ file: path.relative(WEB, file), text: fs.readFileSync(file, 'utf8') }));
const html = read('index.html');

// en.json must be valid; translations are optional and only used to spot translated text in the code
const locales = { en: JSON.parse(read('src/locales/en.json')) };
for (const file of fs.readdirSync(path.join(WEB, 'src', 'locales')).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
  try { locales[path.basename(file, '.json')] = JSON.parse(read(`src/locales/${file}`)); } catch { /* a broken translation is not the tests' business */ }
}

/** t('key', 'fallback') and tHtml('key', 'fallback') calls in the code: [key, fallback (or null), file]. */
function textCalls() {
  const calls = [];
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/\bt(?:Html)?\(\s*(['"`])([\w.-]+)\1(?:\s*,\s*(['"])((?:(?!\3)[^\\]|\\.)*)\3)?/g)) {
      calls.push([m[2], m[4] === undefined ? null : m[4].replace(/\\(.)/g, '$1'), file]);
    }
  }
  return calls;
}

describe('web app', () => {
  test('the service worker template parses once the build filled it in', (t) => {
    const worker = read('sw.template.js').replace('__CACHE_VERSION__', 'test').replace('__PRECACHE_LIST__', JSON.stringify(['./', './index.html']));
    const copy = path.join(tempDir(t, 'agora-frontend-'), 'sw.js');
    fs.writeFileSync(copy, worker);
    const result = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(worker, /\/api\//, 'API answers are never cached');
  });

  // English (en.json) is the source of truth and has to be complete. Translations are not checked: like in most
  // open source projects they may be partial, untranslated texts are simply left empty and show in English.
  test('English, the source language, has a text for every key and no key twice', () => {
    assert.deepEqual(Object.entries(locales.en).filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => k), [], 'empty texts in en.json');
    const counts = {};
    for (const m of read('src/locales/en.json').matchAll(/^\s*"((?:[^"\\]|\\.)+)"\s*:/gm)) counts[m[1]] = (counts[m[1]] || 0) + 1;
    assert.deepEqual(Object.keys(counts).filter((key) => counts[key] > 1), [], 'keys that appear twice in en.json (JSON.parse keeps only the last one)');
  });

  test('every translation key used in the code exists in English (the source language)', () => {
    const used = new Set(textCalls().map(([key]) => key));
    assert.ok(used.size > 100, 'found the keys');
    assert.deepEqual([...used].filter((k) => !(k in locales.en)).sort(), []);
  });

  test('the code is written in English: fallbacks are the English texts', () => {
    // t('key', 'fallback') is what readers of the code see (a fallback that lags behind an edited English text is
    // fine; one in another language is not)
    const translated = [];
    for (const [key, fallback, file] of textCalls()) {
      if (fallback === null) continue;
      for (const [lang, texts] of Object.entries(locales)) {
        if (lang !== 'en' && texts[key] === fallback && locales.en[key] !== fallback) translated.push(`${file}: ${key} (${lang}): ${fallback}`);
      }
    }
    assert.deepEqual(translated, [], 't() fallbacks must be the English text');
    assert.match(html, /<html[^>]*\slang="en"/);
  });

  test('the page: base address for deep paths, one title (link previews replace it), the theme before the first paint', () => {
    assert.ok(html.includes('<base href="/">'), 'pages have their own paths (/events/...): files are found from the root');
    assert.equal((html.match(/<title>[^<]*<\/title>/g) || []).length, 1, 'backend/server.js replaces the title of a shared event');
    const themeScript = html.indexOf("localStorage.getItem('agora-theme')");
    assert.ok(themeScript > 0 && themeScript < html.indexOf('</head>'), 'the dark theme is set before the body is painted');
    assert.ok(html.includes('/assets/config.js'), 'the instance configuration is loaded beside the app');
  });

  test('signing out leaves nothing of the session behind for the next person on the device', () => {
    const auth = read('src/app/auth.ts');
    const start = auth.indexOf('export async function logout()');
    const logout = auth.slice(start, auth.indexOf('\n}\n', start));
    assert.ok(start > 0, 'found logout()');
    // the AI chat, the last open conversation and the loaded lists used to stay in the page for the next account
    assert.match(logout, /location\.reload\(\)/);
    // pushes are sent per device: unsubscribed while the token still works, before signOut
    assert.ok(logout.indexOf('beforeSignOutHooks') > 0 && logout.indexOf('beforeSignOutHooks') < logout.indexOf('signOut('));
    assert.ok(sources.some(({ text }) => /onBeforeSignOut\(/.test(text) && /unsubscribe/i.test(text)), 'this device\'s push subscription is removed before signing out');
  });

  test('files referenced by the page and the manifest exist', () => {
    const exists = (file) => {
      const clean = file.replace(/^\.?\//, '');
      return [path.join(WEB, clean), path.join(WEB, 'public', clean)].some((candidate) => fs.existsSync(candidate));
    };
    // Only files (with an extension); /assets/config.js is written by the server for each instance
    const pageFiles = [...html.matchAll(/(?:src|href)="(?!https?:|data:|#|mailto:)([^"?#]+\.\w+)/g)].map((m) => m[1]).filter((file) => file !== '/assets/config.js');
    const manifestFiles = (JSON.parse(read('public/manifest.json')).icons || []).map((icon) => icon.src);
    const all = [...pageFiles, ...manifestFiles];
    assert.ok(all.length > 4, 'found the references');
    assert.deepEqual(all.filter((file) => !exists(file)), []);
  });
});

describe('songbook (web/src/lib/songbook.js)', () => {
  const load = () => lib('songbook.js');

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

describe('AI reply steps (web/src/lib/aiReply.js)', () => {
  const load = () => lib('aiReply.js');

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

describe('the assistant\'s sign (web/src/lib/aiSign.js), as in the Android app', () => {
  const load = () => lib('aiSign.js');

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
    // The halo: plain numbers every browser draws - its stops at full strength (polish.css), the circle's opacity how
    // much of it shows (no calc() in stop-opacity, which not every browser takes there)
    const haloOpacity = (markup) => Number(/class="ai-sign-halo"[^>]* opacity="([\d.]+)"/.exec(markup)[1]);
    assert.equal(haloOpacity(one), 0, 'a small sign at rest has no halo');
    assert.equal(haloOpacity(two), 0.21, 'a large one a soft one (0.25 of 1.2)');
    const styled = sources.map(({ text }) => text).concat(cssFiles().map((file) => fs.readFileSync(file, 'utf8'))).filter((text) => text.includes('ai-sign-halo'));
    assert.ok(styled.length > 0, 'found the styles of the sign');
    for (const text of styled) assert.doesNotMatch(text, /stop-opacity:\s*calc/);
  });
});

describe('motifs and painted fields (web/src/lib/motifs.js), as in the Android app', () => {
  const load = () => lib('motifs.js');

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

describe('donations and expenses (web/src/lib/collections.js)', () => {
  // The web app's way of changing a list (mutateCollection) against a stand-in server: the current one, or the
  // previous version, which serves while the upgrade waits and takes transactions of people only
  async function againstServer({ previous, refused = previous }) {
    const { createMutateCollection, createIsPreviousServer } = await lib('collections.js');
    const server = { list: [{ id: 1, amount: 10, name: 'Anna' }] };
    const parts = {
      db: {},
      ref: (database, name) => name,
      apiGet: async () => structuredClone(server.list),
      set: async (name, value) => { server.list = structuredClone(value); },
      runTransaction: async (name, update) => {
        if (refused) throw Object.assign(new Error('Refused (test).'), { status: 400 });
        const next = update(structuredClone(server.list));
        if (next !== undefined) server.list = next;
      },
      // The previous version's status names no API versions
      isPreviousServer: createIsPreviousServer({
        api: '/api',
        fetch: async () => ({ ok: true, json: async () => (previous ? { ready: true, upgrade: { state: 'waiting' } } : { ready: true, apiVersions: [1, 2] }) })
      })
    };
    return { server, mutateCollection: createMutateCollection(parts) };
  }

  test('while the upgrade waits, the previous version takes them too: added, changed and deleted', async () => {
    // It refused every change of the lists with 400 - nothing could be added, changed or deleted at all
    for (const previous of [false, true]) {
      const { server, mutateCollection } = await againstServer({ previous });
      await mutateCollection('donations', (list) => [...list, { id: 2, amount: 25, name: 'Ben' }]);
      await mutateCollection('donations', (list) => list.map((entry) => (entry.id === 2 ? { ...entry, amount: 30 } : entry)));
      await mutateCollection('donations', (list) => list.filter((entry) => entry.id !== 1));
      assert.deepEqual(server.list, [{ id: 2, amount: 30, name: 'Ben' }], previous ? 'on the previous version' : 'on the current server');
    }
  });

  test('a refusal of the current server stands: the list is never written past it', async () => {
    const { server, mutateCollection } = await againstServer({ previous: false, refused: true });
    await assert.rejects(mutateCollection('expenses', (list) => [...list, { id: 3, amount: 5 }]), { status: 400 });
    assert.deepEqual(server.list, [{ id: 1, amount: 10, name: 'Anna' }]);
  });

  test('the app saves its lists this way', () => {
    assert.match(read('src/app/data.ts'), /export const mutateCollection = createMutateCollection\(/);
  });
});
