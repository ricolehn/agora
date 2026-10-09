// Songbook text and chords (pure functions, tested in tests/frontend.test.js).
//
// Songs are written ChordPro style: "[G]Amazing [D/F#]grace" puts a chord above the syllable it stands in front
// of, "# Chorus" (or {c: Chorus}, {start_of_chorus}) starts a section, "> twice" is a note for the musicians.
// Only real chords are transposed: "[Bridge]" or "[N.C.]" stay as they are. German songbooks write H for B and B
// for Bb; a song that uses H keeps that notation.

const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, H: 11 };
// Major keys written with flats (index of the tonic): F, Bb, Eb, Ab, Db; Gb/F# follows the original spelling
const FLAT_MAJOR_KEYS = new Set([5, 10, 3, 8, 1]);

// Root, accidental, quality / extensions, optional bass note. The quality only allows chord vocabulary, so words
// starting with A-H ("Bridge", "Chorus", "End") are not chords.
const CHORD = /^([A-H])(#|b)?((?:maj|min|dim|aug|sus|add|alt|no|m|M|Δ|°|ø|\+|-|[0-9]|[#b](?=[0-9])|\(|\)|,|\.)*)(?:\/([A-H])(#|b)?)?$/;

/** The parts of a chord like "F#m7/C#", or null if [text] is not a chord. */
function parseChord(text) {
    const value = String(text || '').trim();
    if (!value || value.length > 24) return null;
    const match = CHORD.exec(value);
    if (!match) return null;
    return { root: match[1], accidental: match[2] || '', quality: match[3] || '', bass: match[4] ? { root: match[4], accidental: match[5] || '' } : null };
}

/** Pitch class 0-11 of a note; in German notation B is Bb and H is B. */
function noteIndex(root, accidental, german) {
    const base = german && root === 'B' ? 10 : NATURAL[root];
    return (base + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0) + 12) % 12;
}

function noteName(index, flats, german) {
    const name = (flats ? FLATS : SHARPS)[((index % 12) + 12) % 12];
    if (!german) return name;
    // German: Bb is written B, B is written H
    if (name === 'Bb' || name === 'A#') return 'B';
    if (name === 'B') return 'H';
    return name;
}

/** Whether a song is written in German notation (it uses H). */
function isGerman(chords) {
    return chords.some((chord) => /^H/.test(chord) || /\/H/.test(chord));
}

/**
 * The key of a song: its "key" field, else the first chord (minor if it is one). Returns
 * { index, minor } or null.
 */
function songKey(declared, chords, german) {
    const source = parseChord(declared) || chords.map(parseChord).find(Boolean);
    if (!source) return null;
    return { index: noteIndex(source.root, source.accidental, german), minor: /^m(?!aj)/.test(source.quality) };
}

/** Flats or sharps in the target key (minor keys follow their relative major). */
function prefersFlats(key, steps, originalFlats) {
    if (!key) return originalFlats;
    const tonic = (key.index + steps + 120) % 12;
    const major = key.minor ? (tonic + 3) % 12 : tonic;
    if (major === 6) return originalFlats; // F# / Gb: keep what the song used
    return FLAT_MAJOR_KEYS.has(major);
}

/** One chord moved by [steps] semitones (unchanged for non-chords and steps 0). */
function transposeChord(text, steps, { flats = false, german = false } = {}) {
    if (!steps) return text;
    const chord = parseChord(text);
    if (!chord) return text;
    const root = noteName(noteIndex(chord.root, chord.accidental, german) + steps, flats, german);
    const bass = chord.bass ? `/${noteName(noteIndex(chord.bass.root, chord.bass.accidental, german) + steps, flats, german)}` : '';
    return `${root}${chord.quality}${bass}`;
}

/** Spelling rules for one song at [steps]: { flats, german }. */
function spellingFor(content, declaredKey, steps) {
    const chords = [...String(content || '').matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]).filter((c) => parseChord(c));
    const german = isGerman(chords) || /^H/.test(String(declaredKey || ''));
    const originalFlats = chords.some((c) => /^[A-G]b/.test(c)) || /^[A-G]b/.test(String(declaredKey || ''));
    return { german, flats: prefersFlats(songKey(declaredKey, chords, german), steps, originalFlats) };
}

/** The key label shown above the song, transposed like its chords. */
function transposedKey(declaredKey, content, steps) {
    if (!declaredKey) return '';
    return transposeChord(declaredKey, steps, spellingFor(content, declaredKey, steps));
}

/**
 * A ChordPro directive "{name: value}" without regular expressions (a crafted line must not hang the browser).
 * Returns { name, value } or null.
 */
function directive(line) {
    if (!line.startsWith('{') || !line.endsWith('}')) return null;
    const inner = line.slice(1, -1);
    const colon = inner.indexOf(':');
    const name = (colon < 0 ? inner : inner.slice(0, colon)).trim().toLowerCase();
    if (!/^[a-z_]{1,24}$/.test(name)) return null;
    return { name, value: colon < 0 ? '' : inner.slice(colon + 1).trim() };
}

const SECTION_DIRECTIVES = {
    start_of_chorus: 'chorus', soc: 'chorus',
    start_of_verse: 'verse', sov: 'verse',
    start_of_bridge: 'bridge', sob: 'bridge',
    start_of_tab: 'tab', sot: 'tab'
};

/**
 * The song as lines: { type: 'gap' | 'section' | 'note' | 'text' | 'chords', text?, label?, words? }.
 * 'chords' lines carry words: [[{ chord, text }]] - one inner list per word, so a line can wrap between words
 * while every chord stays above its syllable.
 */
function parseSong(content, { steps = 0, declaredKey = '', chords = true } = {}) {
    const spelling = spellingFor(content, declaredKey, steps);
    const lines = [];
    for (const raw of String(content || '').split('\n')) {
        // trimEnd, not a regex: a line of thousands of spaces must not take quadratic time
        const line = raw.trimEnd();
        const trimmed = line.trim();
        if (!trimmed) {
            // At most one gap in a row
            if (lines.length && lines[lines.length - 1].type !== 'gap') lines.push({ type: 'gap' });
            continue;
        }
        if (trimmed.startsWith('#')) {
            lines.push({ type: 'section', text: trimmed.replace(/^#+\s*/, '') });
            continue;
        }
        const command = directive(trimmed);
        if (command) {
            if (command.name === 'c' || command.name === 'comment' || command.name === 'ci' || command.name === 'comment_italic') {
                lines.push({ type: 'section', text: command.value });
            } else if (SECTION_DIRECTIVES[command.name]) {
                lines.push({ type: 'section', text: command.value, label: SECTION_DIRECTIVES[command.name] });
            }
            // Everything else ({title}, {key}, {capo}, {end_of_chorus}, …) is not shown
            continue;
        }
        if (trimmed.startsWith('>')) {
            lines.push({ type: 'note', text: trimmed.replace(/^>\s*/, '') });
            continue;
        }
        // "[Bridge]" alone on a line is a section name, not a chord
        const bracketed = /^\[([^\]]+)\]$/.exec(trimmed);
        if (bracketed && !parseChord(bracketed[1])) {
            lines.push({ type: 'section', text: bracketed[1].trim() });
            continue;
        }
        const hasChords = /\[[^\]]+\]/.test(line);
        const lyrics = line.replace(/\[[^\]]*\]/g, '');
        if (!hasChords || !chords) {
            // A line of chords only says nothing without its chords
            if (!lyrics.trim()) continue;
            lines.push({ type: 'text', text: lyrics });
            continue;
        }
        lines.push({ type: 'chords', words: splitWords(line, steps, spelling) });
    }
    while (lines.length && lines[lines.length - 1].type === 'gap') lines.pop();
    return lines;
}

/** "[G]Amazing [D]grace" → [[{chord:'G',text:'Amazing '}], [{chord:'D',text:'grace'}]]. */
function splitWords(line, steps, spelling) {
    const segments = [];
    let pending = null;
    for (const part of line.split(/(\[[^\]]+\])/)) {
        if (!part) continue;
        const chord = /^\[([^\]]+)\]$/.exec(part);
        if (chord) {
            if (pending !== null) segments.push({ chord: pending, text: '' });
            pending = transposeChord(chord[1], steps, spelling);
        } else {
            segments.push({ chord: pending, text: part });
            pending = null;
        }
    }
    if (pending !== null) segments.push({ chord: pending, text: '' });
    // Break segments after spaces; a word that continues across a chord ("Ama[G]zing") stays one word
    const words = [];
    let word = [];
    for (const segment of segments) {
        if (segment.text === '') {
            word.push({ chord: segment.chord, text: '' });
            continue;
        }
        segment.text.split(/(?<=\s)/).forEach((piece, i) => {
            word.push({ chord: i === 0 ? segment.chord : null, text: piece });
            if (/\s$/.test(piece)) {
                words.push(word);
                word = [];
            }
        });
    }
    if (word.length) words.push(word);
    return words;
}

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

/** HTML of a song (all text escaped); [labels] names the ChordPro sections: { chorus, verse, bridge, tab }. */
function renderSongHtml(content, { steps = 0, declaredKey = '', chords = true, labels = {} } = {}) {
    return parseSong(content, { steps, declaredKey, chords }).map((line) => {
        switch (line.type) {
            case 'gap': return '<div class="song-gap"></div>';
            case 'section': return `<div class="song-section">${escape(line.text || labels[line.label] || '')}</div>`;
            case 'note': return `<div class="song-note">${escape(line.text)}</div>`;
            case 'text': return `<div class="song-line"><span class="song-lyric">${escape(line.text)}</span></div>`;
            // A line of chords alone ("[G] [D] [Em]") has no lyric row
            default: return `<div class="song-line has-chords${line.words.every((word) => word.every((seg) => !seg.text.trim())) ? ' chords-only' : ''}">${line.words.map((word) => `<span class="song-word">${word.map((seg) =>
                `<span class="song-seg"><span class="song-chord">${seg.chord ? escape(seg.chord) : ''}</span><span class="song-lyric">${seg.text ? escape(seg.text) : ''}</span></span>`
            ).join('')}</span>`).join('')}</div>`;
        }
    }).join('');
}

/** Text to search in: title, writers, CCLI number and the lyrics without chords; lower case, no accents. */
function searchText(song) {
    const lyrics = String(song?.content || '').replace(/\[[^\]]*\]/g, '').replace(/^\s*[#>{].*$/gm, ' ');
    return normalizeSearch([song?.title, song?.artist, song?.ccli, song?.copyright, lyrics].filter(Boolean).join(' '));
}

const normalizeSearch = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').toLowerCase();

export { parseChord, transposeChord, transposedKey, spellingFor, parseSong, renderSongHtml, searchText, normalizeSearch };
