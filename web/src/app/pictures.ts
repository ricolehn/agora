// Profile pictures. Who has a picture and its version come from the server once per load: only those are requested,
// under an address with the version, which the browser keeps until the picture changes. null = not known (yet):
// every picture is asked for like before.
import { createSignal } from 'solid-js';
import { API, api, apiJson } from './api';
import { currentUid } from './session';

const [pictureVersions, setPictureVersions] = createSignal<Record<string, string | number> | null>(null);
export { pictureVersions };

// Lists that render on their own (events, chats) can wait for it, so they never ask for every picture
let picturesReady: Promise<void> = Promise.resolve();
export const whenPicturesReady = () => picturesReady;

export function loadPictureVersions(): Promise<void> {
  picturesReady = apiJson('/profile/pictures')
    .then(data => void setPictureVersions(data || null))
    .catch(() => void setPictureVersions(null));
  return picturesReady;
}

/** The address of a person's picture ('' when they have none). Reactive: follows the loaded versions. */
export function profilePictureSrc(uid: string | null | undefined): string {
  if (!uid) return '';
  const versions = pictureVersions();
  if (versions && !versions[uid]) return '';
  const version = versions?.[uid];
  return `${API}/profile/picture/${encodeURIComponent(uid)}${version ? `?v=${version}` : ''}`;
}

async function fetchProfilePicUrl(uid: string): Promise<string | null> {
  const src = profilePictureSrc(uid);
  if (!src) return null;
  const res = await api(src.slice(API.length));
  if (res.ok && res.status === 200) {
    const blob = await res.blob();
    if (blob && blob.size > 0) return URL.createObjectURL(blob);
  }
  return null;
}

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

// The own picture (header, profile, settings): an object URL, replaced when it changes
const [ownPicture, setOwnPictureSignal] = createSignal<string | null>(null);
export { ownPicture };
export function setOwnPicture(url: string | null) {
  const previous = ownPicture();
  if (previous && previous !== url) URL.revokeObjectURL(previous);
  setOwnPictureSignal(url);
}
export async function loadCurrentProfilePicture() {
  const uid = currentUid();
  if (uid) setOwnPicture(await fetchProfilePicUrl(uid).catch(() => null));
}
