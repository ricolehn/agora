const fs = require('fs');
const path = require('path');
const { listEvents } = require('./pocketbase');

// Event pictures are uploaded when they are cropped, before the event is saved. A picture that is removed or
// replaced, belongs to a deleted event or was never saved (dialog cancelled) has to be deleted by the server.
const EVENT_IMAGE_PATH = '/api/events/images/';
// Not linked yet is not unused: the event form may still be open
const UNLINKED_GRACE_MS = 24 * 60 * 60 * 1000;

/** File name of a picture uploaded for events ('' for none or an external address) */
function eventImageName(imageUrl) {
  const url = String(imageUrl || '');
  const index = url.indexOf(EVENT_IMAGE_PATH);
  if (index < 0) return '';
  const name = url.slice(index + EVENT_IMAGE_PATH.length).split(/[?#]/)[0];
  return name && name === path.basename(name) && name !== '.' && name !== '..' ? name : '';
}

/** File names of the pictures the events link (a recurring series shares one picture) */
function linkedEventImageNames(events) {
  return new Set((events || []).map((ev) => eventImageName(ev?.imageUrl)).filter(Boolean));
}

/**
 * Deletes the named pictures from dir unless an event links them. Only from event-images/: older pictures in
 * uploads/ sit next to the receipts and stay.
 */
async function deleteUnlinkedEventImages(dir, names, linked) {
  let deleted = 0;
  for (const name of new Set(names)) {
    if (!name || linked.has(name) || name !== path.basename(name)) continue;
    try {
      await fs.promises.unlink(path.join(dir, name));
      deleted += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[EventImages] Could not delete ${name}:`, error.message);
    }
  }
  return deleted;
}

/** Pictures in dir no event links that were uploaded longer ago than the grace period */
async function staleUnlinkedEventImages(dir, linked, now = Date.now(), graceMs = UNLINKED_GRACE_MS) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const stale = [];
  for (const entry of entries) {
    if (!entry.isFile() || linked.has(entry.name)) continue;
    const stat = await fs.promises.stat(path.join(dir, entry.name)).catch(() => null);
    if (stat && now - stat.mtimeMs > graceMs) stale.push(entry.name);
  }
  return stale;
}

/**
 * Daily cleanup: deletes pictures no event links any more (dialogs cancelled after the upload, pictures left
 * behind before the server removed them). Without the event list nothing is deleted.
 */
async function purgeUnlinkedEventImages(appConfig, dir, now = Date.now()) {
  if (!appConfig) return 0;
  try {
    const linked = linkedEventImageNames(await listEvents(appConfig));
    const deleted = await deleteUnlinkedEventImages(dir, await staleUnlinkedEventImages(dir, linked, now), linked);
    if (deleted) console.log(`[EventImages] Deleted ${deleted} picture(s) no event links`);
    return deleted;
  } catch (error) {
    console.error('[EventImages] Cleanup failed:', error.message);
    return 0;
  }
}

module.exports = {
  UNLINKED_GRACE_MS,
  eventImageName,
  linkedEventImageNames,
  deleteUnlinkedEventImages,
  staleUnlinkedEventImages,
  purgeUnlinkedEventImages
};
