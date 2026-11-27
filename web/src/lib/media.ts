// Media library: paths, addresses and sizes (pure functions, tested in tests/frontend.test.js).
//
// Paths are relative to the base folder the server is set up with: "" is the base folder, "Photos/2026" a folder
// in it. The server checks every path again; these helpers only build addresses and order what it sent.

/** A file as the server lists it (what these helpers read of it). */
export interface MediaFileRef {
    name?: string;
    path: string;
    etag?: string;
    kind?: string;
    contentType?: string;
}

/** "Photos/2026" → ["Photos", "Photos/2026"] with names, for the breadcrumb. */
export function breadcrumb(path: string | null | undefined): Array<{ name: string; path: string }> {
    const parts = String(path || '').split('/').filter(Boolean);
    return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
}

export const parentPath = (path: string | null | undefined) => {
    const parts = String(path || '').split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
};

/** How deep a folder lies: "" 0, "Photos" 1, "Photos/2026" 2. */
export const folderDepth = (path: string | null | undefined) => breadcrumb(path).length;

/**
 * The path from the base folder ([rootName]) down to [path] as the pills under the title, as in the Android app: all
 * steps up to three folders down; deeper, the folders between the base folder and the last two fold into one step
 * ("…", which lists them in [folded]): Media › … › Stage › Band. A step: { target, name, root, folded }.
 */
export interface PathStep {
    target: string;
    name: string;
    root: boolean;
    folded: Array<{ target: string; name: string }>;
}
export function pathSteps(path: string | null | undefined, rootName: string): PathStep[] {
    const crumbs = breadcrumb(path);
    const step = (crumb: { name: string; path: string }): PathStep => ({ target: crumb.path, name: crumb.name, root: false, folded: [] });
    const root: PathStep = { target: '', name: rootName, root: true, folded: [] };
    if (crumbs.length < 4) return [root, ...crumbs.map(step)];
    const folded = crumbs.slice(0, -2).map(crumb => ({ target: crumb.path, name: crumb.name }));
    return [root, { target: '', name: '…', root: false, folded }, ...crumbs.slice(-2).map(step)];
}

/** The page address of a folder: /media/Photos/2026 (each name encoded, so "#", "?" and "%" stay names). */
export const folderUrl = (path: string | null | undefined) => ['/media', ...String(path || '').split('/').filter(Boolean).map(encodeURIComponent)].join('/');

/** The folder of a page address's parts after /media (already decoded by the router). */
export const folderFromRoute = (parts: string[]) => parts.filter(part => part && part !== '.' && part !== '..').join('/');

/**
 * Preview sizes the server knows; asking for exactly these lets Nextcloud and the browser reuse what they made.
 * Tiles take a small one, the picture viewer the largest there is (like Nextcloud's own viewer).
 */
export const PREVIEW_SIZES = [64, 128, 256, 512, 1024, 2048, 4096];
/** The viewer asks for this and gets the server's largest preview (Nextcloud's preview_max_x/y caps it). */
export const LARGEST_PREVIEW_SIZE = 4096;
export const previewBucket = (pixels: number) => PREVIEW_SIZES.find(size => size >= pixels) || PREVIEW_SIZES[PREVIEW_SIZES.length - 1];

/** Thumbnail size for a tile of [cssPixels] on a screen with [dpr]: sharp, never more than 512. */
export const thumbSize = (cssPixels: number, dpr = 1) => Math.min(512, previewBucket(Math.ceil(cssPixels * Math.min(Math.max(dpr, 1), 3))));

/** A video's poster: the longer side of the window in device pixels, at most 2048. */
export const viewerSize = (width: number, height: number, dpr = 1) => Math.min(2048, previewBucket(Math.ceil(Math.max(width, height) * Math.min(Math.max(dpr, 1), 3))));

const query = (params: Record<string, string | number | null | undefined>) => Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value as string | number)}`)
    .join('&');

/** Address of a preview; the file's version (etag) makes it cacheable for good. */
export const previewUrl = (api: string, file: MediaFileRef, size: number, { crop = false } = {}) =>
    `${api}/media/preview?${query({ path: file.path, size, crop: crop ? 1 : '', v: file.etag })}`;

export const fileUrl = (api: string, file: MediaFileRef, { download = false } = {}) =>
    `${api}/media/file?${query({ path: file.path, download: download ? 1 : '', v: file.etag })}`;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders and files in the chosen order: by name (numbers counted, "Bild 2" before "Bild 10") or newest first. */
export function sortEntries<E extends { name: string; modified?: string }>(entries: readonly E[] | null | undefined, order = 'name'): E[] {
    const list = [...(entries || [])];
    if (order === 'newest') {
        return list.sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || '')) || collator.compare(a.name, b.name));
    }
    return list.sort((a, b) => collator.compare(a.name, b.name));
}

/** "1.4 MB" style sizes. */
export function formatSize(bytes: unknown, locale?: string): string {
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
export const opensInViewer = (file: MediaFileRef | null | undefined) => file?.kind === 'image';
export const opensAsPdf = (file: MediaFileRef | null | undefined) => file?.kind === 'pdf';
export const opensInPlayer = (file: MediaFileRef | null | undefined) => file?.kind === 'video' || file?.kind === 'audio';

/** The type shown on a tile: the file's extension ("DOCX"), at most 4 letters, or nothing. */
export function typeLabel(name: string | null | undefined): string {
    const match = /\.([a-z0-9]{1,4})$/i.exec(String(name || ''));
    return match ? match[1].toUpperCase() : '';
}

/** A file's name as its tile shows it: without the type its tile names ("Gemeindebrief.pdf" → "Gemeindebrief"). */
export function shownName(name: string | null | undefined): string {
    const text = String(name || '');
    const type = typeLabel(text);
    const shown = type ? text.slice(0, -(type.length + 1)) : text;
    return shown.trim() ? shown : text;
}

/** The library's warm colours (its tile in Extras): the painted field of its folders and pictures. */
/** The colours of a painted field: its light and deep tone and the hint of a third. */
export interface FieldColors {
    light: string;
    deep: string;
    hint: string;
}
export const MEDIA_FIELD: FieldColors = { light: '#f6c7a4', deep: '#e0874f', hint: '#f9da9e' };
const FILE_FIELDS: Record<string, FieldColors> = {
    pdf: { light: '#f2b5c0', deep: '#d6667c', hint: '#f8c6ae' },
    audio: { light: '#aed6ec', deep: '#4a98c4', hint: '#c9c6f3' },
    video: { light: '#cfc8f3', deep: '#7c6fd6', hint: '#f0c6e6' },
    text: { light: '#b9ccf2', deep: '#4a7fd6', hint: '#c3e2f0' },
    table: { light: '#b5dec6', deep: '#3e9b6a', hint: '#d9eab4' },
    slides: { light: '#f7c9a8', deep: '#e07b42', hint: '#f6dd9e' },
    other: { light: '#e3dcd3', deep: '#8a837a', hint: '#ede3cf' }
};
const DOCUMENT_TYPES: Record<string, string[]> = {
    text: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages'],
    table: ['xls', 'xlsx', 'ods', 'csv', 'numbers'],
    slides: ['ppt', 'pptx', 'odp', 'key']
};

/**
 * How a file's tile looks, as in the Android app: the painted field in the colours of its kind - pictures in the
 * library's warm colours, PDFs rose, music blue, videos lilac, other documents by their type (text blue, tables green,
 * slides orange) - and its motif (motifs.ts: a picture, two notes, a screen, a document).
 */
export function fileLook(file: MediaFileRef | null | undefined): { colors: FieldColors; motif: string } {
    const kind = file?.kind || '';
    const motif = kind === 'image' ? 'picture' : kind === 'audio' ? 'notes' : kind === 'video' ? 'film' : 'document';
    if (kind === 'image') return { colors: MEDIA_FIELD, motif };
    if (FILE_FIELDS[kind] && kind !== 'other') return { colors: FILE_FIELDS[kind], motif };
    const type = typeLabel(file?.name).toLowerCase();
    const group = Object.keys(DOCUMENT_TYPES).find(key => DOCUMENT_TYPES[key].includes(type));
    return { colors: FILE_FIELDS[group || 'other'], motif };
}

// --- Zooming the picture viewer. A view is { scale, x, y }: the picture is scaled around its centre and moved by
// x / y pixels; points are measured from the centre of the picture's box. ---
export const MAX_ZOOM = 6;
export interface ZoomView {
    scale: number;
    x: number;
    y: number;
}
type Point = { x: number; y: number };
type Size = { width: number; height: number };
const clampScale = (scale: number) => Math.min(MAX_ZOOM, Math.max(1, Number.isFinite(scale) ? scale : 1));

/** Zoomed to [scale] around [point]: the spot of the picture under the point (a finger, the mouse) stays there. */
export function zoomAt(view: ZoomView, point: Point, scale: number): ZoomView {
    const next = clampScale(scale);
    const ratio = next / view.scale;
    return { scale: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}

/** Two fingers: the spot that was between them at the start follows their middle, the picture their distance. */
export function pinchView(start: ZoomView, startMiddle: Point, middle: Point, scale: number): ZoomView {
    const next = clampScale(scale);
    const ratio = next / start.scale;
    return { scale: next, x: middle.x - (startMiddle.x - start.x) * ratio, y: middle.y - (startMiddle.y - start.y) * ratio };
}

/**
 * Keeps the picture on screen: it can only be moved as far as it is larger than its box (a picture of [natural]
 * size shown in a box of [box] size, letterboxed). Not zoomed, it sits in the middle.
 */
export function clampView(view: ZoomView, box: Size, natural: Partial<Size> | null | undefined): ZoomView {
    const scale = clampScale(view.scale);
    if (scale <= 1.001) return { scale: 1, x: 0, y: 0 };
    const fit = natural?.width && natural?.height ? Math.min(box.width / natural.width, box.height / natural.height) : 1;
    const width = (natural?.width ? natural.width * fit : box.width) * scale;
    const height = (natural?.height ? natural.height * fit : box.height) * scale;
    const maxX = Math.max(0, (width - box.width) / 2);
    const maxY = Math.max(0, (height - box.height) / 2);
    return { scale, x: Math.min(maxX, Math.max(-maxX, view.x)), y: Math.min(maxY, Math.max(-maxY, view.y)) };
}

/**
 * Whether the browser can show the file itself (JPEG, PNG, WebP …): only then is the original opened, and only
 * when Nextcloud has no preview of it at all. Camera formats (DNG, RAW, HEIC, TIFF …) are only ever shown as previews.
 */
export const browserShowsOriginal = (file: MediaFileRef | null | undefined) => /^image\/(jpeg|png|gif|webp|avif|bmp)$/i.test(file?.contentType || '');

/** The next picture in [list] from [index] in [direction] (wraps around), or -1 if there is none. */
export function neighbourIndex(list: readonly unknown[] | null | undefined, index: number, direction: number): number {
    if (!Array.isArray(list) || list.length < 2) return -1;
    return (index + direction + list.length) % list.length;
}

// --- Folder rights ---
/** A level of a folder right ('' = what comes from above). */
export type RightsLevel = '' | 'read' | 'write' | 'hide';
/** All members ('*'), a group or a person the rights dialog can name. */
export interface RightsChoice {
    id: string;
    name: string;
    kind: 'all' | 'group' | 'person';
}
/** The rights of a folder: its own, and what comes from the folders above it (with the folder it comes from). */
export interface FolderRules {
    own?: Record<string, Exclude<RightsLevel, ''>>;
    inherited?: Record<string, { level: Exclude<RightsLevel, ''>; from: string }>;
}
export interface RightsRow extends RightsChoice {
    /** The folder's own level ('' = follows what comes from above). */
    level: RightsLevel;
    inherited: { level: Exclude<RightsLevel, ''>; from: string } | null;
}

/**
 * Folder rights as the dialog shows them: all members always, then every group and person with a rule of its own
 * here or one from above (others are added when needed). A row: { id, name, kind, level ('' = from above),
 * inherited ({ level, from } or null) }.
 */
export function rightsRows(choices: readonly RightsChoice[] | null | undefined, folder: FolderRules | null | undefined): RightsRow[] {
    const own = folder?.own || {};
    const inherited = folder?.inherited || {};
    return (choices || [])
        .filter(choice => choice.id === '*' || own[choice.id] || inherited[choice.id])
        .map(choice => ({ id: choice.id, name: choice.name, kind: choice.kind, level: own[choice.id] || '', inherited: inherited[choice.id] || null }));
}

/** A row can be taken out of the dialog when nothing comes from above for it (all members always stay). */
export const removableRow = (row: RightsRow) => row.id !== '*' && !row.inherited;

const searchable = (text: unknown) => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Groups and people that are not in the dialog yet and match [query] (case and accents ignored), groups first. */
export function addableTargets(choices: readonly RightsChoice[] | null | undefined, rows: readonly RightsRow[] | null | undefined, query: string, limit = 8): RightsChoice[] {
    const shown = new Set((rows || []).map(row => row.id));
    const words = searchable(query).split(/\s+/).filter(Boolean);
    return (choices || [])
        .filter(choice => choice.id !== '*' && !shown.has(choice.id))
        .filter(choice => words.every(word => searchable(choice.name).includes(word)))
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'group' ? -1 : 1))
        .slice(0, limit);
}

/** The rules to save from the dialog's rows (only groups with an own level). */
export const rightsPayload = (rows: readonly RightsRow[]) => Object.fromEntries(rows.filter(row => row.level).map(row => [row.id, row.level]));
