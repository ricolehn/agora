// The library's files: their addresses, the texts under them and how they reach the device.
import { API } from '../../app/api';
import { formatDateFast, uiLocale } from '../../app/i18n';
import { fileUrl, formatSize, thumbSize } from '../../lib/media';
import type { MediaFile, MediaFolder } from './types';

/** Thumbnails as sharp as the tile (about a third of the screen on phones, three side by side), from the server's fixed sizes. */
export const mediaTileSize = () => thumbSize(window.innerWidth <= 600 ? Math.ceil(window.innerWidth / 3) : 200, window.devicePixelRatio || 1);

/** The file as a download (the server sends it as an attachment). */
export const downloadUrl = (file: MediaFile) => fileUrl(API, file, { download: true });

/** A folder row's line: "26/10/2026 · 0 B". */
export const folderMeta = (folder: MediaFolder) =>
  [folder.modified ? formatDateFast(folder.modified) : '', formatSize(folder.size, uiLocale())].filter(Boolean).join(' · ');

/** The viewers' line under the name: "55 KB · 26/10/2026". */
export const fileMeta = (file: MediaFile) =>
  [formatSize(file.size, uiLocale()), file.modified ? formatDateFast(file.modified) : ''].filter(Boolean).join(' · ');

/** Lets the browser save [href] (a file, a ZIP archive the server puts together) without leaving the page. */
export function saveMediaLink(href: string, name = '') {
  const link = Object.assign(document.createElement('a'), { href, download: name });
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Moves only where the device allows it (reduced motion: changes in place). */
export const motionAllowed = () =>
  typeof Element.prototype.animate === 'function' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true;

/** The app's FastOutSlowInEasing: how folders and the title move. */
export const MEDIA_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
