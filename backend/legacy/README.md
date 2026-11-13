# Frozen backend (fallback during the database upgrade)

This folder is a copy of the backend as it was before the database got its new structure (commit `b5e84dc`, with the
two security fixes of that release). It reads and writes the old collections (`people`, `payments`, `app_state`, ...).

`backend/server.js` starts it **only** when the upgrade of an existing database cannot finish safely - the check found
something it may not guess, the backup could not be made, the comparison of old and new data did not match, or the
upgrade failed three times. Then the instance keeps running exactly as before the update, on its untouched old data,
and the admins see why (`/api/status` → `upgrade`, and the server log). The next start tries the upgrade again.

Rules:

- Do not change anything here. Fixes go into the new backend; this copy only has to keep the old data working until the
  upgrade has run on every installation.
- The only differences to the original are marked `LEGACY HOOK`: `/api/status` reports the waiting upgrade.
- The launcher sets `DATA_DIR`, `POCKETBASE_DIR`, `FRONTEND_DIR` and `POCKETBASE_BIN` before it starts this copy, because
  the copy resolves its default folders relative to its own location. The upgrade sets `DATA_DIR` and `POCKETBASE_DIR`
  too, before it compares with this copy's functions (`legacyModules` in `backend/db/upgrade/index.js`): without them
  the copy read the mentoring texts with a key of its own in the Docker image, and every comparison of a conversation
  failed.
- Remove the folder in a later release, once every installation has been upgraded (an instance that skips the release
  with this fallback must update to it first).
