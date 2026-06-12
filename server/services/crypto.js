const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

function generateKey() {
  return crypto.randomBytes(KEY_LENGTH);
}

function getMasterKey(user) {
  if (user.master_key) {
    return Buffer.from(user.master_key, 'base64');
  }
  throw new Error('Master encryption key not initialized');
}

function encryptBuffer(buffer, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { encrypted, iv, authTag };
}

function decryptBuffer(encrypted, key, iv, authTag) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function wrapKey(dataKey, masterKey) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return {
    wrapped_key: wrapped.toString('base64'),
    wrap_iv: iv.toString('base64'),
    wrap_tag: cipher.getAuthTag().toString('base64'),
  };
}

function unwrapKey(wrappedKey, wrapIv, wrapTag, masterKey) {
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, Buffer.from(wrapIv, 'base64'));
  decipher.setAuthTag(Buffer.from(wrapTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(wrappedKey, 'base64')),
    decipher.final(),
  ]);
}

function serializeEncryption(dataKey, iv, authTag, masterKey) {
  const wrapped = wrapKey(dataKey, masterKey);
  return {
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    auth_tag: authTag.toString('base64'),
    ...wrapped,
  };
}

function deserializeEncryption(meta, masterKey) {
  return unwrapKey(meta.wrapped_key, meta.wrap_iv, meta.wrap_tag, masterKey);
}

function encryptChunk(buffer, key) {
  return encryptBuffer(buffer, key);
}

function decryptChunk(encrypted, key, iv, authTag) {
  return decryptBuffer(encrypted, key, iv, authTag);
}

function wrapFileKey(fileKey, masterKey) {
  const wrapped = wrapKey(fileKey, masterKey);
  return {
    algorithm: ALGORITHM,
    mode: 'chunk',
    ...wrapped,
  };
}

function deriveShareKey(shareToken) {
  return crypto.createHash('sha256').update(`github-vault-share:${shareToken}`).digest();
}

function wrapKeyForShare(fileKey, shareToken) {
  return wrapKey(fileKey, deriveShareKey(shareToken));
}

function unwrapKeyForShare(meta, shareToken) {
  const shareKey = deriveShareKey(shareToken);
  return unwrapKey(meta.wrapped_key, meta.wrap_iv, meta.wrap_tag, shareKey);
}

module.exports = {
  generateKey,
  getMasterKey,
  encryptBuffer,
  decryptBuffer,
  encryptChunk,
  decryptChunk,
  serializeEncryption,
  deserializeEncryption,
  wrapFileKey,
  deriveShareKey,
  wrapKeyForShare,
  unwrapKeyForShare,
};
