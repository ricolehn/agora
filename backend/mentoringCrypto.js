const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveDataDirectory } = require('./pathConfig');

let cachedMasterKey = null;

function getMentoringMasterKey({ dataDir = null, env = process.env } = {}) {
  // 1. Environment variable override
  if (env.MENTORING_ENCRYPTION_KEY) {
    const rawKey = String(env.MENTORING_ENCRYPTION_KEY).trim();
    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      return Buffer.from(rawKey, 'hex');
    }
    return crypto.createHash('sha256').update(rawKey).digest();
  }

  // 2. In-process cache
  if (cachedMasterKey) {
    return cachedMasterKey;
  }

  const resolvedDataDir = dataDir || resolveDataDirectory({ env });
  const keyFilePath = path.join(resolvedDataDir, '.mentoring_key');
  const configFilePath = path.join(resolvedDataDir, 'config.json');

  // 3. Try reading from config.json
  if (fs.existsSync(configFilePath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
      if (cfg?.mentoringEncryptionKey && /^[0-9a-fA-F]{64}$/.test(cfg.mentoringEncryptionKey)) {
        cachedMasterKey = Buffer.from(cfg.mentoringEncryptionKey, 'hex');
        // Ensure .mentoring_key file is also synced
        try {
          if (!fs.existsSync(keyFilePath)) {
            fs.writeFileSync(keyFilePath, cfg.mentoringEncryptionKey, { mode: 0o600 });
          }
        } catch {}
        return cachedMasterKey;
      }
    } catch {}
  }

  // 4. Try reading from .mentoring_key
  if (fs.existsSync(keyFilePath)) {
    try {
      const content = fs.readFileSync(keyFilePath, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(content)) {
        cachedMasterKey = Buffer.from(content, 'hex');
        // Sync to config.json if present
        syncKeyToConfig(configFilePath, content);
        return cachedMasterKey;
      }
    } catch (err) {
      console.warn('[MentoringCrypto] Could not read existing key file:', err.message);
    }
  }

  // 5. Generate and persist new 256-bit key
  const newKey = crypto.randomBytes(32);
  const newKeyHex = newKey.toString('hex');

  try {
    if (!fs.existsSync(resolvedDataDir)) {
      fs.mkdirSync(resolvedDataDir, { recursive: true });
    }
    fs.writeFileSync(keyFilePath, newKeyHex, { mode: 0o600 });
    cachedMasterKey = newKey;
  } catch (err) {
    console.warn('[MentoringCrypto] Could not persist .mentoring_key:', err.message);
    cachedMasterKey = newKey;
  }

  // Also sync into config.json
  syncKeyToConfig(configFilePath, newKeyHex);

  return cachedMasterKey;
}

function syncKeyToConfig(configFilePath, keyHex) {
  if (!fs.existsSync(configFilePath)) return;
  try {
    const raw = fs.readFileSync(configFilePath, 'utf8');
    const cfg = JSON.parse(raw);
    if (!cfg.mentoringEncryptionKey || cfg.mentoringEncryptionKey !== keyHex) {
      cfg.mentoringEncryptionKey = keyHex;
      fs.writeFileSync(configFilePath, JSON.stringify(cfg, null, 2), 'utf8');
    }
  } catch (err) {
    console.warn('[MentoringCrypto] Could not sync key to config.json:', err.message);
  }
}

function clearMasterKeyCache() {
  cachedMasterKey = null;
}

function deriveThreadKey(masterKey, threadId = '') {
  const salt = Buffer.from(String(threadId || ''));
  const info = Buffer.from('agora-mentoring-thread-v1');
  return crypto.hkdfSync('sha256', masterKey, salt, info, 32);
}

function encryptMentoringText(plaintext, threadId = '', options = {}) {
  if (plaintext === null || plaintext === undefined || plaintext === '') {
    return '';
  }
  const str = String(plaintext);
  if (str.startsWith('enc:v1:')) {
    return str;
  }

  const masterKey = getMentoringMasterKey(options);
  const threadKey = deriveThreadKey(masterKey, threadId);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', threadKey, iv);
  const ciphertext = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `enc:v1:${iv.toString('base64url')}:${authTag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function decryptMentoringText(encryptedText, threadId = '', options = {}) {
  if (encryptedText === null || encryptedText === undefined || encryptedText === '') {
    return '';
  }
  const str = String(encryptedText);
  if (!str.startsWith('enc:v1:')) {
    return str;
  }

  const parts = str.split(':');
  if (parts.length !== 5) {
    return str;
  }

  const [, , ivB64, tagB64, dataB64] = parts;

  try {
    const masterKey = getMentoringMasterKey(options);
    const threadKey = deriveThreadKey(masterKey, threadId);
    const iv = Buffer.from(ivB64, 'base64url');
    const authTag = Buffer.from(tagB64, 'base64url');
    const ciphertext = Buffer.from(dataB64, 'base64url');

    const decipher = crypto.createDecipheriv('aes-256-gcm', threadKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    console.warn('[MentoringCrypto] Decryption failed for thread:', threadId, err.message);
    return '[Verschlüsselte Nachricht - Entschlüsselung fehlgeschlagen]';
  }
}

module.exports = {
  getMentoringMasterKey,
  clearMasterKeyCache,
  deriveThreadKey,
  encryptMentoringText,
  decryptMentoringText
};
