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

/** What opens in the app: pictures in the viewer, PDFs in the PDF viewer, the rest is downloaded. */
export const opensInViewer = file => file?.kind === 'image';
export const opensAsPdf = file => file?.kind === 'pdf';

/** Animated pictures lose their motion as previews: the viewer shows the original. */
export const viewerNeedsOriginal = file => /\.gif$/i.test(file?.name || '') || file?.contentType === 'image/gif' || file?.hasPreview === false;

/** The next picture in [list] from [index] in [direction] (wraps around), or -1 if there is none. */
export function neighbourIndex(list, index, direction) {
    if (!Array.isArray(list) || list.length < 2) return -1;
    return (index + direction + list.length) % list.length;
}

/**
 * Folder rights as the dialog shows them: one row per group with its own level ('' = from above) and what it
 * would get from the folders above ({ level, from } or null).
 */
export function rightsRows(groups, folder) {
    const own = folder?.own || {};
    const inherited = folder?.inherited || {};
    return (groups || []).map(group => ({
        id: group.id,
        name: group.name,
        level: own[group.id] || '',
        inherited: inherited[group.id] || null
    }));
}

/** The rules to save from the dialog's rows (only groups with an own level). */
export const rightsPayload = rows => Object.fromEntries(rows.filter(row => row.level).map(row => [row.id, row.level]));
