const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getMentoringMasterKey,
  clearMasterKeyCache,
  deriveThreadKey,
  encryptMentoringText,
  decryptMentoringText
} = require('./mentoringCrypto');

test('encryptMentoringText and decryptMentoringText perform round-trip encryption', () => {
  clearMasterKeyCache();
  const threadId = 'thread-123';
  const plaintext = 'Hallo, das ist eine streng vertrauliche Nachricht! 🔒';

  const encrypted = encryptMentoringText(plaintext, threadId);
  assert.ok(encrypted.startsWith('enc:v1:'));
  assert.notEqual(encrypted, plaintext);

  const decrypted = decryptMentoringText(encrypted, threadId);
  assert.equal(decrypted, plaintext);
});

test('distinct messages produce unique IVs and ciphertexts', () => {
  clearMasterKeyCache();
  const threadId = 'thread-123';
  const text = 'Gleicher Text';

  const enc1 = encryptMentoringText(text, threadId);
  const enc2 = encryptMentoringText(text, threadId);

  assert.notEqual(enc1, enc2, 'Two encryptions of the same text must have different IVs and ciphertexts');
  assert.equal(decryptMentoringText(enc1, threadId), text);
  assert.equal(decryptMentoringText(enc2, threadId), text);
});

test('per-thread key derivation isolates threads from decrypting each other', () => {
  clearMasterKeyCache();
  const threadA = 'thread-aaa';
  const threadB = 'thread-bbb';
  const text = 'Geheime Information';

  const encA = encryptMentoringText(text, threadA);
  const decB = decryptMentoringText(encA, threadB);

  // Decrypting with wrong thread key should fail gracefully
  assert.equal(decB, '[Verschlüsselte Nachricht - Entschlüsselung fehlgeschlagen]');
});

test('decryptMentoringText passes through unencrypted legacy messages', () => {
  const legacyText = 'Dies ist eine alte Nachricht ohne Verschlüsselung';
  const result = decryptMentoringText(legacyText, 'any-thread');
  assert.equal(result, legacyText);
});

test('encryptMentoringText handles empty and null inputs safely', () => {
  assert.equal(encryptMentoringText(''), '');
  assert.equal(encryptMentoringText(null), '');
  assert.equal(encryptMentoringText(undefined), '');
});

test('decryptMentoringText handles empty and null inputs safely', () => {
  assert.equal(decryptMentoringText(''), '');
  assert.equal(decryptMentoringText(null), '');
  assert.equal(decryptMentoringText(undefined), '');
});

test('encryptMentoringText does not double-encrypt already encrypted text', () => {
  clearMasterKeyCache();
  const text = 'Test';
  const enc = encryptMentoringText(text, 'th-1');
  const encAgain = encryptMentoringText(enc, 'th-1');
  assert.equal(encAgain, enc);
});

test('mentoring master key persists in dataDir if env is not set', () => {
  clearMasterKeyCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-crypto-test-'));
  try {
    const key1 = getMentoringMasterKey({ dataDir: tempDir, env: {} });
    assert.equal(key1.length, 32);

    clearMasterKeyCache();
    const key2 = getMentoringMasterKey({ dataDir: tempDir, env: {} });
    assert.deepEqual(key1, key2, 'Key must be persistently read from .mentoring_key file');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    clearMasterKeyCache();
  }
});

test('mentoring master key respects MENTORING_ENCRYPTION_KEY env var', () => {
  clearMasterKeyCache();
  const customHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const key = getMentoringMasterKey({ env: { MENTORING_ENCRYPTION_KEY: customHex } });
  assert.equal(key.toString('hex'), customHex);
  clearMasterKeyCache();
});

test('mentoring master key syncs with config.json', () => {
  clearMasterKeyCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-crypto-cfg-test-'));
  const configPath = path.join(tempDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ appName: 'TestApp' }), 'utf8');

  try {
    const key1 = getMentoringMasterKey({ dataDir: tempDir, env: {} });
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(cfg.mentoringEncryptionKey, key1.toString('hex'));

    clearMasterKeyCache();
    // Delete .mentoring_key to simulate container recreation with only config.json
    fs.rmSync(path.join(tempDir, '.mentoring_key'), { force: true });
    const key2 = getMentoringMasterKey({ dataDir: tempDir, env: {} });
    assert.deepEqual(key1, key2, 'Key must be restored from config.json even if .mentoring_key was deleted');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    clearMasterKeyCache();
  }
});
