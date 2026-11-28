// Profile pictures. Who has a picture and its version come from the server once per load: only those are requested,
// under an address with the version, which the browser keeps until the picture changes. null = not known (yet):
// every picture is asked for like before.
import { createDeferred, createMemo, createRoot, createSignal, refresh } from 'solid-js';
import { API, api, apiJson } from './api';
import { currentUid } from './session';

const [pictureVersions, setPictureVersions] = createSignal<Record<string, string | number> | null>(null);
export { pictureVersions };

// Lists that render on their own (events, chats) can wait for it, so they never ask for every picture
let picturesReady: Promise<void> = Promise.resolve();
export const whenPicturesReady = () => picturesReady;

export function loadPictureVersions(): Promise<void> {
  picturesReady = apiJson<Record<string, string | number>>('/profile/pictures')
    .then(data => void setPictureVersions(data || null))
    .catch(() => void setPictureVersions(null));
  return picturesReady;
}

/** A new picture of [uid] (just uploaded): its new version gives it a new address, so no list shows the old one from
 *  the browser's cache. Nothing while no versions are known. */
export function setPictureVersion(uid: string, version: string | number) {
  setPictureVersions(versions => (versions ? { ...versions, [uid]: version } : versions));
}

/** The address of a person's picture ('' when they have none). Reactive: follows the loaded versions. */
export function profilePictureSrc(uid: string | null | undefined): string {
  if (!uid) return '';
  const versions = pictureVersions();
  if (versions && !versions[uid]) return '';
  const version = versions?.[uid];
  return `${API}/profile/picture/${encodeURIComponent(uid)}${version ? `?v=${version}` : ''}`;
}

// An object URL of the picture at [src] (fetched with the session; null when there is none)
async function fetchPicture(src: string): Promise<string | null> {
  if (!src) return null;
  const res = await api(src.slice(API.length));
  if (res.ok && res.status === 200) {
    const blob = await res.blob();
    if (blob && blob.size > 0) return URL.createObjectURL(blob);
  }
  return null;
}
const fetchProfilePicUrl = (uid: string) => fetchPicture(profilePictureSrc(uid));

// Cached per uid (including requests on their way) so lists fetch each picture only once
const profilePicCache = new Map<string, Promise<string | null>>();
/** An object URL of a person's picture (fetched with the session; null when there is none). */
export function getProfilePicUrl(uid: string | null | undefined): Promise<string | null> {
  if (!uid) return Promise.resolve(null);
  if (!profilePicCache.has(uid)) profilePicCache.set(uid, fetchProfilePicUrl(uid).catch(() => null));
  return profilePicCache.get(uid)!;
}
export function forgetProfilePic(uid: string) {
  profilePicCache.delete(uid);
}

// The own picture (header, profile menu, profile page): an object URL of the picture at the own address. It follows
// the account (signing in and out) and the address (a new version after an upload), the one before is released. It never
// holds anything up: until the first answer there is none (the symbol shows), while a newer one is on its way the last
// one stays.
const ownPicture = createRoot(() => {
  // The address alone: a reload of the versions that leaves it as it is fetches nothing
  const src = createMemo(() => profilePictureSrc(currentUid()));
  return createDeferred<string | null>(
    async previous => {
      const url = await fetchPicture(src()).catch(() => null);
      if (previous && previous !== url) URL.revokeObjectURL(previous);
      return url;
    },
    { loadingValue: null }
  );
});
export { ownPicture };
/** Fetches the own picture again (just uploaded: without known versions its address stays the same). */
export const refreshOwnPicture = () => void refresh(ownPicture);
