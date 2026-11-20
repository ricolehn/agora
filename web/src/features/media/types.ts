// What the server sends for the media library (backend/routes/media.js).

/** What the member may do in a folder: look, also add and delete, or not see its files. */
export type MediaAccess = 'read' | 'write' | 'none';

export interface MediaFolder {
  name: string;
  path: string;
  size?: number;
  modified?: string;
  /** Whether the member may write everywhere in it (only then it can be deleted). */
  canDelete?: boolean;
}

export interface MediaFile {
  name: string;
  path: string;
  size?: number;
  modified?: string;
  contentType?: string;
  /** The file's version: previews and downloads are cached under it. */
  etag?: string;
  hasPreview?: boolean;
  /** image, pdf, video, audio or other (media.fileKind on the server). */
  kind: string;
}

export interface MediaListing {
  path: string;
  name: string;
  access: MediaAccess;
  canManage?: boolean;
  folders: MediaFolder[];
  files: MediaFile[];
}

/** A folder or file of the open folder by its name (index: its place among the files shown). */
export type MediaEntry =
  | { name: string; folder: MediaFolder; file?: undefined; index?: undefined }
  | { name: string; file: MediaFile; index: number; folder?: undefined };

export type MediaSort = 'name' | 'newest';
