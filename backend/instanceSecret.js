// The instance's own secrets, one file per purpose in the data folder (polls-secret, prayers-secret, media-secret). A
// missing file is made once; a damaged one is an error and never silently replaced - a new secret would undo what the
// old one protects: who voted or made a poll, whose anonymous prayer request it is, the stored Nextcloud password.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { unavailable } = require('./httpError');

/** The secret [name] in [dataDir]: made when it is missing, an error when it is damaged. */
function loadSecret(dataDir, name = 'polls-secret') {
  const file = path.join(dataDir, name);
  let existing = null;
  try {
    existing = fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (existing !== null) {
    if (existing.length >= 32) return existing;
    throw new Error(`${file} is damaged; restore it from the backup (${name.replace('-secret', '')} cannot be used until then)`);
  }
  const secret = crypto.randomBytes(32).toString('hex');
  // 'wx': never overwrite a file another process created a moment ago
  fs.writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return secret;
}

/**
 * The secret [name] of [dataDir], read once, for a feature's routes: while it is damaged the feature answers 503 with
 * [message] (an error meant for the person who asked); why it is damaged goes to the log.
 */
function instanceSecret(dataDir, name, message) {
  let secret = null;
  return () => {
    if (secret) return secret;
    try {
      secret = loadSecret(dataDir, name);
      return secret;
    } catch (err) {
      console.error(`[${name}]`, err.message);
      throw unavailable(message);
    }
  };
}

/** A keyed hash of [uid] for [purpose] and the record [id]: links them only for who has the secret. */
const keyedHash = (secret, purpose, id, uid) => crypto.createHmac('sha256', secret).update(`${purpose}:${id}:${uid}`).digest('hex');

module.exports = { loadSecret, instanceSecret, keyedHash };
