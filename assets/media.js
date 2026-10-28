// Media library: paths, addresses and sizes (pure functions, tested in tests/frontend.test.js).
//
// Paths are relative to the base folder the server is set up with: "" is the base folder, "Photos/2026" a folder
// in it. The server checks every path again; these helpers only build addresses and order what it sent.

/** "Photos/2026" → ["Photos", "Photos/2026"] with names, for the breadcrumb. */
export function breadcrumb(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
}

export const parentPath = path => {
    const parts = String(path || '').split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
};

/** The page address of a folder: /media/Photos/2026 (each name encoded, so "#", "?" and "%" stay names). */
export const folderUrl = path => ['/media', ...String(path || '').split('/').filter(Boolean).map(encodeURIComponent)].join('/');

/** The folder of a page address's parts after /media (already decoded by the router). */
export const folderFromRoute = parts => parts.filter(part => part && part !== '.' && part !== '..').join('/');

/** Preview sizes the server knows; asking for exactly these lets Nextcloud and the browser reuse what they made. */
export const PREVIEW_SIZES = [64, 128, 256, 512, 1024, 2048];
export const previewBucket = pixels => PREVIEW_SIZES.find(size => size >= pixels) || PREVIEW_SIZES[PREVIEW_SIZES.length - 1];

/** Thumbnail size for a tile of [cssPixels] on a screen with [dpr]: sharp, never more than 512. */
export const thumbSize = (cssPixels, dpr = 1) => Math.min(512, previewBucket(Math.ceil(cssPixels * Math.min(Math.max(dpr, 1), 3))));

/** Viewer size: the longer side of the window in device pixels, up to the largest preview. */
export const viewerSize = (width, height, dpr = 1) => previewBucket(Math.ceil(Math.max(width, height) * Math.min(Math.max(dpr, 1), 3)));

const query = params => Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

/** Address of a preview; the file's version (etag) makes it cacheable for good. */
export const previewUrl = (api, file, size, { crop = false } = {}) =>
    `${api}/media/preview?${query({ path: file.path, size, crop: crop ? 1 : '', v: file.etag })}`;

export const fileUrl = (api, file, { download = false } = {}) =>
    `${api}/media/file?${query({ path: file.path, download: download ? 1 : '', v: file.etag })}`;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders and files in the chosen order: by name (numbers counted, "Bild 2" before "Bild 10") or newest first. */
export function sortEntries(entries, order = 'name') {
    const list = [...(entries || [])];
    if (order === 'newest') {
        return list.sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || '')) || collator.compare(a.name, b.name));
    }
    return list.sort((a, b) => collator.compare(a.name, b.name));
}

/** "1.4 MB" style sizes. */
export function formatSize(bytes, locale) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }
    const digits = unit === 0 || size >= 10 ? 0 : 1;
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(size)} ${units[unit]}`;
}

/** What opens in the app: pictures in the viewer, PDFs in the PDF viewer, videos and music in the player; the rest is downloaded. */
export const opensInViewer = file => file?.kind === 'image';
export const opensAsPdf = file => file?.kind === 'pdf';
export const opensInPlayer = file => file?.kind === 'video' || file?.kind === 'audio';

/** The type shown on a tile: the file's extension ("DOCX"), at most 4 letters, or nothing. */
export function typeLabel(name) {
    const match = /\.([a-z0-9]{1,4})$/i.exec(String(name || ''));
    return match ? match[1].toUpperCase() : '';
}

// --- Zooming the picture viewer. A view is { scale, x, y }: the picture is scaled around its centre and moved by
// x / y pixels; points are measured from the centre of the picture's box. ---
export const MAX_ZOOM = 6;
const clampScale = scale => Math.min(MAX_ZOOM, Math.max(1, Number.isFinite(scale) ? scale : 1));

/** Zoomed to [scale] around [point]: the spot of the picture under the point (a finger, the mouse) stays there. */
export function zoomAt(view, point, scale) {
    const next = clampScale(scale);
    const ratio = next / view.scale;
    return { scale: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}

/** Two fingers: the spot that was between them at the start follows their middle, the picture their distance. */
export function pinchView(start, startMiddle, middle, scale) {
    const next = clampScale(scale);
    const ratio = next / start.scale;
    return { scale: next, x: middle.x - (startMiddle.x - start.x) * ratio, y: middle.y - (startMiddle.y - start.y) * ratio };
}

/**
 * Keeps the picture on screen: it can only be moved as far as it is larger than its box (a picture of [natural]
 * size shown in a box of [box] size, letterboxed). Not zoomed, it sits in the middle.
 */
export function clampView(view, box, natural) {
    const scale = clampScale(view.scale);
    if (scale <= 1.001) return { scale: 1, x: 0, y: 0 };
    const fit = natural?.width && natural?.height ? Math.min(box.width / natural.width, box.height / natural.height) : 1;
    const width = (natural?.width ? natural.width * fit : box.width) * scale;
    const height = (natural?.height ? natural.height * fit : box.height) * scale;
    const maxX = Math.max(0, (width - box.width) / 2);
    const maxY = Math.max(0, (height - box.height) / 2);
    return { scale, x: Math.min(maxX, Math.max(-maxX, view.x)), y: Math.min(maxY, Math.max(-maxY, view.y)) };
}

/** Animated pictures lose their motion as previews: the viewer shows the original. */
export const viewerNeedsOriginal = file => /\.gif$/i.test(file?.name || '') || file?.contentType === 'image/gif' || file?.hasPreview === false;

/** The next picture in [list] from [index] in [direction] (wraps around), or -1 if there is none. */
export function neighbourIndex(list, index, direction) {
    if (!Array.isArray(list) || list.length < 2) return -1;
    return (index + direction + list.length) % list.length;
}

/**
 * Folder rights as the dialog shows them: all members always, then every group and person with a rule of its own
 * here or one from above (others are added when needed). A row: { id, name, kind, level ('' = from above),
 * inherited ({ level, from } or null) }.
 */
export function rightsRows(choices, folder) {
    const own = folder?.own || {};
    const inherited = folder?.inherited || {};
    return (choices || [])
        .filter(choice => choice.id === '*' || own[choice.id] || inherited[choice.id])
        .map(choice => ({ id: choice.id, name: choice.name, kind: choice.kind, level: own[choice.id] || '', inherited: inherited[choice.id] || null }));
}

/** A row can be taken out of the dialog when nothing comes from above for it (all members always stay). */
export const removableRow = row => row.id !== '*' && !row.inherited;

const searchable = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Groups and people that are not in the dialog yet and match [query] (case and accents ignored), groups first. */
export function addableTargets(choices, rows, query, limit = 8) {
    const shown = new Set((rows || []).map(row => row.id));
    const words = searchable(query).split(/\s+/).filter(Boolean);
    return (choices || [])
        .filter(choice => choice.id !== '*' && !shown.has(choice.id))
        .filter(choice => words.every(word => searchable(choice.name).includes(word)))
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'group' ? -1 : 1))
        .slice(0, limit);
}

/** The rules to save from the dialog's rows (only groups with an own level). */
export const rightsPayload = rows => Object.fromEntries(rows.filter(row => row.level).map(row => [row.id, row.level]));
