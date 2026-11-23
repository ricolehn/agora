// Small helpers without state: lists, names, dates, files. (Escaping HTML is not needed: JSX escapes text.)

export const inList = (list: unknown, item: unknown): boolean => Array.isArray(list) && list.includes(item);

/** A list from an array, an object of entries (older data) or nothing. */
export function safeList<T = any>(val: unknown): T[] {
  if (!val) return [];
  return Array.isArray(val) ? (val as T[]) : (Object.values(val as object) as T[]);
}

export const fullName = (u: { firstName?: string; lastName?: string } | null | undefined): string =>
  `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

export function getInitials(name: unknown): string {
  const parts = typeof name === 'string' ? name.trim().split(/\s+/).filter(Boolean) : [];
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || '?').slice(0, 2).toUpperCase();
}

export function groupBy<T, K>(list: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of list) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return groups;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number): (...args: A) => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

/**
 * For runs where the newest wins (a load still on its way must not overwrite what a newer one brought): each call
 * starts a run and returns whether that run is still the newest one.
 */
export function newestWins(): () => () => boolean {
  let newest = 0;
  return () => {
    const mine = ++newest;
    return () => mine === newest;
  };
}

// One run at a time per action: a double tap on a slow network sent it twice - the second failed ("not found",
// "only the requested user can answer") and its error replaced the first one's success
const runningActions = new Set<string>();
export async function once<T>(key: string, action: () => Promise<T> | T): Promise<T | undefined> {
  if (runningActions.has(key)) return undefined;
  runningActions.add(key);
  try {
    return await action();
  } finally {
    runningActions.delete(key);
  }
}
/** True while once(key, ...) runs (for a busy state on its button). */
export const isRunning = (key: string) => runningActions.has(key);

export const pad2 = (n: number) => String(n).padStart(2, '0');
export const toDateStr = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const getTodayStr = () => toDateStr(new Date());

/** UTC midnight of a 'YYYY-MM-DD' day (other forms go through Date). */
export function parseUtcDate(str: unknown): Date {
  if (!str) return new Date();
  if (str instanceof Date) return new Date(str.getTime());
  const [y, m, d] = String(str).trim().slice(0, 10).split('-').map(Number);
  return [y, m, d].some(Number.isNaN) || d === undefined ? new Date(String(str)) : new Date(Date.UTC(y, m - 1, d));
}

/** Receipt file names: a JSON list, a list, or comma separated (older records). */
export function parseReceipts(receiptField: unknown): string[] {
  if (Array.isArray(receiptField)) return receiptField.filter(Boolean);
  const trimmed = String(receiptField || '').trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      return JSON.parse(trimmed).filter(Boolean);
    } catch {
      /* fall through to CSV */
    }
  }
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}

export const isPdfReceipt = (filename: unknown) => /\.pdf$/i.test(String(filename || ''));

export const readAsDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(String(e.target?.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

export const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

export const isHeic = (name = '', type = '') => /\.hei[cf]$/i.test(name) || type === 'image/heic' || type === 'image/heif';

/** HEIC/HEIF (iPhone photos) to JPEG; the input unchanged when it is no HEIC or the conversion fails. */
export async function convertHeic<T extends Blob>(file: T, quality: number, name = (file as unknown as File).name || ''): Promise<T | File | Blob> {
  if (!isHeic(name, file.type)) return file;
  try {
    // 1.3 MB of script: loaded on first use only
    const { default: heic2any } = await import('heic2any');
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality });
    const blob = Array.isArray(out) ? out[0] : out;
    return file instanceof File ? new File([blob], file.name.replace(/\.hei[cf]$/i, '.jpg'), { type: 'image/jpeg' }) : blob;
  } catch (e) {
    console.error('HEIC conversion failed:', e);
    return file;
  }
}

/** A JPEG of an image file (large photos before upload). */
export async function compressImage(file: File, quality: number): Promise<File> {
  const img = await loadImage(await readAsDataUrl(file));
  const canvas = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  canvas.getContext('2d')!.drawImage(img, 0, 0, img.width, img.height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Canvas to Blob failed');
  return new File([blob], /\.jpe?g$/i.test(file.name) ? file.name : file.name.replace(/\.[^/.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}

export const toFormData = (fields: Record<string, string | Blob | null | undefined>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) if (value) form.append(key, value);
  return form;
};

/** Copies text; without the clipboard API (http) through a selected field. */
export async function copyText(text: string, field?: HTMLInputElement | HTMLTextAreaElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* the selected field below */
  }
  const helper = field ? null : Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
  try {
    if (helper) {
      helper.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(helper);
    }
    const target = (field || helper)!;
    target.focus();
    target.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    helper?.remove();
  }
}

/** A readable address part from a title ("Jugendfreizeit 2026" → "Jugendfreizeit_2026"). */
export const slugify = (text: unknown) =>
  String(text || '')
    .normalize('NFC')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);

export const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

/** A parameter of the page's address (?share=..., ?guest=...). */
export const linkParam = (name: string) => new URLSearchParams(window.location.search).get(name) || '';
