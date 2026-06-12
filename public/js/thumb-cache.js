/**
 * Client-side LRU thumbnail cache (images, videos, PDFs).
 * Map<string, { data: string, ts: number }> with auto eviction.
 */
const ThumbCache = {
  maxSize: 100,
  map: new Map(),
  pending: new Map(),

  key(id, version) {
    return `${id}:${version || 0}`;
  },

  get(id, version) {
    const k = this.key(id, version);
    const entry = this.map.get(k);
    if (!entry) return null;
    this.map.delete(k);
    entry.ts = Date.now();
    this.map.set(k, entry);
    return entry.data;
  },

  set(id, version, data) {
    const k = this.key(id, version);
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, { data, ts: Date.now() });
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      const old = this.map.get(oldest);
      if (old?.data?.startsWith?.('blob:')) {
        try { URL.revokeObjectURL(old.data); } catch { /* ignore */ }
      }
      this.map.delete(oldest);
    }
  },

  resolveUrl(id, version) {
    const cached = this.get(id, version);
    if (cached) return cached;
    return `/api/files/thumbnail/${id}${version ? `?v=${version}` : ''}`;
  },

  async prefetch(id, version) {
    const k = this.key(id, version);
    if (this.get(id, version) || this.pending.has(k)) {
      return this.pending.get(k) || this.get(id, version);
    }
    const url = `/api/files/thumbnail/${id}${version ? `?v=${version}` : ''}`;
    const promise = fetch(url, { credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error('thumb');
        return res.blob();
      })
      .then((blob) => {
        const objUrl = URL.createObjectURL(blob);
        this.set(id, version, objUrl);
        this.pending.delete(k);
        return objUrl;
      })
      .catch(() => {
        this.pending.delete(k);
        return url;
      });
    this.pending.set(k, promise);
    return promise;
  },

  warmVisible(items) {
    if (!items?.length) return;
    const slice = items.slice(0, 40);
    for (const file of slice) {
      if (file.has_thumbnail && !file.is_folder && !file.pending) {
        this.prefetch(file.id, file.thumbVersion).catch(() => {});
      }
    }
  },
};
