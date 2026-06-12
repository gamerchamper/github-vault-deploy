const DisplayNames = {
  KEY: 'vault-display-names',
  _cache: null,

  _load() {
    if (this._cache) return this._cache;
    try {
      this._cache = JSON.parse(localStorage.getItem(this.KEY) || '{}');
    } catch {
      this._cache = {};
    }
    return this._cache;
  },

  _save() {
    localStorage.setItem(this.KEY, JSON.stringify(this._cache));
  },

  get(id, fallback = '') {
    const name = this._load()[id];
    return name || fallback;
  },

  set(id, name) {
    this._load()[id] = name;
    this._save();
  },

  remove(id) {
    delete this._load()[id];
    this._save();
  },

  removeMany(ids) {
    const cache = this._load();
    for (const id of ids) delete cache[id];
    this._save();
  },
};
