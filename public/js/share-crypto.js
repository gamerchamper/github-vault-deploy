const ShareCrypto = {
  async deriveShareKey(shareToken) {
    const data = new TextEncoder().encode(`github-vault-share:${shareToken}`);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(hash);
  },

  b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },

  async importRawKey(rawKey) {
    return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  },

  async unwrapFileKey(shareMeta, shareToken) {
    const shareKeyBytes = await this.deriveShareKey(shareToken);
    const shareKey = await this.importRawKey(shareKeyBytes);
    const wrapped = this.b64ToBytes(shareMeta.wrapped_key);
    const iv = this.b64ToBytes(shareMeta.wrap_iv);
    const tag = this.b64ToBytes(shareMeta.wrap_tag);
    const combined = new Uint8Array(wrapped.length + tag.length);
    combined.set(wrapped);
    combined.set(tag, wrapped.length);
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, shareKey, combined);
    return this.importRawKey(new Uint8Array(raw));
  },

  async decryptChunk(encrypted, fileKey, ivB64, tagB64) {
    const iv = this.b64ToBytes(ivB64);
    const tag = this.b64ToBytes(tagB64);
    const enc = encrypted instanceof ArrayBuffer ? new Uint8Array(encrypted) : encrypted;
    const combined = new Uint8Array(enc.length + tag.length);
    combined.set(enc);
    combined.set(tag, enc.length);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, fileKey, combined);
    return new Uint8Array(plain);
  },
};
