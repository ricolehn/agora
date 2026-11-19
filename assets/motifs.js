// Small pictures in the manner of an emoji, as in the Android app (Motifs.kt): one thing each, a little
// three-dimensional through soft gradients and a little light, without a shadow - the apps in Extras, the media
// library's folders and files. Drawn as SVG in a box of 100 × 100 from the app's own shapes and colours, so they are
// sharp at every size, look the same in both apps and need no image files.
//
// A painted field holds them: a soft fall of a light colour, lighter up left, a breath of a neighbouring hue down
// right - deep and quiet in the dark theme (style.css, .painted-field) - with two still soft forms in the language of
// the AI's sign (aiSign.js). Pure functions that return markup (tested in tests/frontend.test.js).
import { fixed, softFormPath } from './aiSign.js';

/** Where the still forms of an app's field lie (the app's Motif seeds; the poll is the web's own). */
export const MOTIF_SEEDS = { picture: 0.7, notes: 2.6, heart: 5.1, folder: 1.6, document: 3.8, film: 4.4, poll: 0.3 };

// --- Colours: mixed in Oklab like the app's (Compose's lerp), so a document's lines have the same tone ---

const toLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function oklab(hex) {
    const [r, g, b] = [1, 3, 5].map(at => toLinear(parseInt(hex.slice(at, at + 2), 16) / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    ];
}

function fromOklab([lightness, a, b]) {
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    const rgb = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    ];
    return `#${rgb.map(c => Math.round(Math.min(1, Math.max(0, toGamma(c))) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** [from] moved [t] of the way to [to] (both #rrggbb). */
export function mixColor(from, to, t) {
    const a = oklab(from);
    const b = oklab(to);
    return fromOklab(a.map((value, i) => value + (b[i] - value) * t));
}

// --- Drawing helpers (all in the box of 100 × 100) ---

const stopsOf = stops => stops.map(([offset, color, opacity = 1]) => `<stop offset="${offset}" stop-color="${color}"${opacity === 1 ? '' : ` stop-opacity="${opacity}"`}/>`).join('');
const linear = (id, [x1, y1], [x2, y2], stops) =>
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fixed(x1)}" y1="${fixed(y1)}" x2="${fixed(x2)}" y2="${fixed(y2)}">${stopsOf(stops)}</linearGradient>`;
const vertical = (id, top, bottom, stops) => linear(id, [0, top], [0, bottom], stops);
const radial = (id, [cx, cy], r, stops) => `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fixed(cx)}" cy="${fixed(cy)}" r="${fixed(r)}">${stopsOf(stops)}</radialGradient>`;
/** A colour that fades from [from] to [to] (its opacity). */
const fade = (color, from, to = 0) => [[0, color, from], [1, color, to]];
const roundRect = (x, y, width, height, r, attrs) => `<rect x="${fixed(x)}" y="${fixed(y)}" width="${fixed(width)}" height="${fixed(height)}" rx="${fixed(r)}" ${attrs}/>`;

/** A closed outline through [points] whose corners are rounded with [radius] (never more than half an edge). */
export function roundedPolygon(points, radius) {
    const count = points.length;
    let d = '';
    points.forEach((corner, i) => {
        const previous = points[(i - 1 + count) % count];
        const next = points[(i + 1) % count];
        const into = Math.hypot(corner[0] - previous[0], corner[1] - previous[1]);
        const out = Math.hypot(next[0] - corner[0], next[1] - corner[1]);
        // Short edges (a tab's slope) stay whole
        const r = Math.min(radius, into / 2, out / 2);
        const from = [corner[0] - (corner[0] - previous[0]) / into * r, corner[1] - (corner[1] - previous[1]) / into * r];
        const to = [corner[0] + (next[0] - corner[0]) / out * r, corner[1] + (next[1] - corner[1]) / out * r];
        d += `${i ? 'L' : 'M'}${fixed(from[0])} ${fixed(from[1])}Q${fixed(corner[0])} ${fixed(corner[1])} ${fixed(to[0])} ${fixed(to[1])}`;
    });
    return `${d}Z`;
}

/** A soft light on a rounded surface: a small oval of white that fades out (turned by [angle]). */
const gloss = (id, [cx, cy], rx, ry, angle, alpha) => ({
    defs: radial(id, [cx, cy], rx, fade('#ffffff', alpha)),
    shape: `<ellipse cx="${fixed(cx)}" cy="${fixed(cy)}" rx="${fixed(rx)}" ry="${fixed(ry)}"${angle ? ` transform="rotate(${angle} ${fixed(cx)} ${fixed(cy)})"` : ''} fill="url(#${id})"/>`
});

// The motifs. Each gets its own prefix for its gradients ([id]), so several on one page never share them.
const MOTIFS = {
    /** A picture: a light frame, a little turned, around a warm sky with its sun and two hills. */
    picture: id => {
        const light = gloss(`${id}g`, [24, 24], 10, 3, 0, 0.45);
        const frame = attrs => roundRect(10, 17, 80, 64, 13, attrs);
        return `<defs>${linear(`${id}a`, [10, 15], [90, 85], [[0, '#ffffff'], [1, '#f3e7dc']])}`
            + vertical(`${id}b`, 55, 82, fade('#b98a66', 0, 0.25))
            + vertical(`${id}c`, 17, 81, [[0, '#ffe3c4'], [1, '#f8b385']])
            + radial(`${id}d`, [66, 38], 17, fade('#fff6dc', 0.9))
            + vertical(`${id}e`, 50, 85, [[0, '#f29a62'], [1, '#e07b42']])
            + vertical(`${id}f`, 45, 85, [[0, '#e5814a'], [1, '#c25a26']])
            + `${light.defs}<clipPath id="${id}p">${roundRect(17.5, 24.5, 65, 49, 7, '')}</clipPath></defs>`
            + `<g transform="rotate(-7 50 50)">${frame(`fill="url(#${id}a)"`)}${frame(`fill="url(#${id}b)"`)}`
            + `<g clip-path="url(#${id}p)"><rect width="100" height="100" fill="url(#${id}c)"/>`
            + `<circle cx="66" cy="38" r="17" fill="url(#${id}d)"/><circle cx="66" cy="38" r="7.5" fill="#fff4d2"/>`
            + `<path d="M35 85C50 52 60 50 95 85Z" fill="url(#${id}e)"/><path d="M0 85C22 44 36 46 70 85Z" fill="url(#${id}f)"/></g>`
            + `${light.shape}</g>`;
    },
    /** Two eighth notes under one beam, in the blue of the songbook, lighter at the top, a soft light on each head. */
    notes: id => {
        const rx = 16.5;
        const ry = 12;
        const heads = [[28, 78], [72, 70]].map(([x, y], i) => ({ x, y, light: gloss(`${id}g${i}`, [x - rx * 0.35, y - ry * 0.42], rx * 0.45, ry * 0.3, 0, 0.32) }));
        const body = `fill="url(#${id}a)"`;
        return `<defs>${linear(`${id}a`, [48, 8], [48, 95], [[0, '#92d5f8'], [0.5, '#4fa2d8'], [1, '#2b6da6']])}`
            + heads.map((head, i) => vertical(`${id}r${i}`, head.y, head.y + ry, fade('#1b4c78', 0, 0.28)) + head.light.defs).join('')
            + `</defs>${roundRect(36.8, 25, 7, 51, 3.5, body)}${roundRect(80.8, 17, 7, 51, 3.5, body)}`
            + `<path d="${roundedPolygon([[36.8, 20.5], [87.8, 11.5], [87.8, 24.5], [36.8, 33.5]], 3.5)}" ${body}/>`
            // The heads lie a little uphill, their right ends at the stems
            + heads.map(({ x, y, light }, i) => `<g transform="rotate(-24 ${x} ${y})">`
                + `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" ${body}/><ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="url(#${id}r${i})"/>`
                + `${light.shape}</g>`).join('');
    },
    /** A heart: rose to a deeper red, a little darker towards its point, a soft light up left. */
    heart: id => {
        const path = 'M50 86C17 66 5 47 9 31C13 14 36 8 50 26C64 8 87 14 91 31C95 47 83 66 50 86Z';
        const light = gloss(`${id}g`, [30, 32], 10, 6, -38, 0.32);
        return `<defs>${radial(`${id}a`, [34, 30], 78, [[0, '#ffa3b5'], [0.5, '#ee5f7c'], [1, '#c93a5a']])}`
            + `${vertical(`${id}b`, 50, 88, fade('#9e2443', 0, 0.35))}${light.defs}</defs>`
            + `<path d="${path}" fill="url(#${id}a)"/><path d="${path}" fill="url(#${id}b)"/>${light.shape}`;
    },
    /** A folder: its back with the tab in amber, a sheet of paper peeking out, the lighter front with a light along its top. */
    folder: id => {
        const back = roundedPolygon([[7, 19], [38, 19], [47, 28.5], [93, 28.5], [93, 83], [7, 83]], 7);
        const front = roundedPolygon([[7, 38.5], [93, 38.5], [93, 83], [7, 83]], 7);
        return `<defs>${vertical(`${id}a`, 19, 83, [[0, '#f0a955'], [1, '#d7833b']])}`
            + vertical(`${id}b`, 27, 46, [[0, '#ffffff'], [1, '#f2ebe3']])
            + vertical(`${id}c`, 38.5, 83, [[0, '#ffd58f'], [1, '#f3a24d']])
            + vertical(`${id}d`, 62, 83, fade('#b8642a', 0, 0.22))
            + `${vertical(`${id}e`, 38.5, 52, fade('#ffffff', 0.45))}</defs>`
            + `<path d="${back}" fill="url(#${id}a)"/>${roundRect(15, 27, 70, 43, 4, `transform="rotate(-4 50 50)" fill="url(#${id}b)"`)}`
            + `<path d="${front}" fill="url(#${id}c)"/><path d="${front}" fill="url(#${id}d)"/><path d="${front}" fill="url(#${id}e)"/>`;
    },
    /** A sheet of paper with a folded corner in [accent] and a few lines in its tone. */
    document: (id, accent) => {
        const sheet = roundedPolygon([[20, 10], [60, 10], [80, 30], [80, 90], [20, 90]], 6);
        const line = mixColor(accent, '#ffffff', 0.62);
        return `<defs>${linear(`${id}a`, [20, 10], [80, 90], [[0, '#ffffff'], [1, '#eee8e1']])}`
            + vertical(`${id}b`, 60, 90, fade('#b9ac9e', 0, 0.18))
            + `${linear(`${id}c`, [60, 30], [74, 13], [[0, mixColor(accent, '#ffffff', 0.3)], [1, accent]])}</defs>`
            + `<path d="${sheet}" fill="url(#${id}a)"/><path d="${sheet}" fill="url(#${id}b)"/>`
            + `<path d="${sheet}" fill="none" stroke="#000000" stroke-opacity="0.07" stroke-width="1.2"/>`
            + roundRect(30, 33, 20, 5.5, 2.5, `fill="${accent}" fill-opacity="0.85"`)
            + [[32, 46], [36, 58], [22, 70]].map(([width, y]) => roundRect(30, y, width, 5, 2.5, `fill="${line}"`)).join('')
            + `<path d="${roundedPolygon([[60, 10], [80, 30], [60, 30]], 2.5)}" fill="url(#${id}c)"/>`;
    },
    /** A screen in lilac with a rounded play sign in the middle, a light along its top. */
    film: id => {
        const screen = attrs => roundRect(10, 20, 80, 60, 13, attrs);
        return `<defs>${linear(`${id}a`, [10, 20], [90, 80], [[0, '#a79cf0'], [0.5, '#6a5bd0'], [1, '#4f42b0']])}`
            + `${vertical(`${id}b`, 20, 42, fade('#ffffff', 0.3))}</defs>`
            + `${screen(`fill="url(#${id}a)"`)}${screen(`fill="url(#${id}b)"`)}`
            + `<path d="${roundedPolygon([[42, 35.5], [66.5, 50], [42, 64.5]], 4)}" fill="#ffffff" fill-opacity="0.95"/>`;
    },
    /** Three bars of a count in mint and green, darker towards the ground, a light along each top (the web's polls). */
    poll: id => {
        const bars = [[14, 46], [40, 18], [66, 33]];
        return `<defs>${vertical(`${id}a`, 14, 86, [[0, '#9be6c6'], [0.5, '#4db58e'], [1, '#2e8a68']])}`
            + vertical(`${id}b`, 62, 84, fade('#1e6b50', 0, 0.22))
            + `${bars.map(([, top], i) => vertical(`${id}s${i}`, top, top + 14, fade('#ffffff', 0.4))).join('')}</defs>`
            + bars.map(([x, top], i) => ['a', 'b', `s${i}`].map(fill => roundRect(x, top, 20, 84 - top, 6, `fill="url(#${id}${fill})"`)).join('')).join('');
    }
};

let motifCount = 0;

/** A motif ([motif] one of MOTIF_SEEDS) as an SVG; [accent] colours a document's folded corner and lines. Decorative. */
export function motifSvg(motif, { accent = '#8a837a', className = 'motif' } = {}) {
    const draw = MOTIFS[motif] || MOTIFS.document;
    return `<svg class="${className}" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${draw(`motif${++motifCount}-`, accent)}</svg>`;
}

/** Where the still forms of a field lie: every name its own, as in the app ((hashCode and 0xFFFF) / 6553.5). */
export function seedOf(name) {
    const text = String(name ?? '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
    return (hash & 0xffff) / 6553.5;
}

/** The two still soft forms of a field, placed by [seed]: one in its upper right corner, one below its lower left. */
export function fieldForms(seed) {
    const r = 62;
    return {
        upper: softFormPath(100 - r * 0.3, r * 0.1, r, 9 + seed, 0.11, 2.2 + seed),
        lower: softFormPath(r * 0.15, 100 + r * 0.25, r * 0.8, 9 + seed, 0.11, 5.4 + seed)
    };
}

/**
 * A field painted in [colors] ({ light, deep, hint }: the light tone, the deep one of the dark theme and a breath of a
 * neighbouring hue) around [content]; [className] gives it its size and corners.
 */
export function paintedField(colors, seed, content = '', className = '') {
    const forms = fieldForms(seed);
    return `<span class="painted-field${className ? ` ${className}` : ''}" style="--field-light: ${colors.light}; --field-deep: ${colors.deep}; --field-hint: ${colors.hint || colors.light}">`
        + '<svg class="painted-field-forms" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">'
        + `<path class="painted-field-upper" d="${forms.upper}"/><path class="painted-field-lower" d="${forms.lower}"/></svg>${content}</span>`;
}
