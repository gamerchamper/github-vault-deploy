const API = {
  async get(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    return res.json();
  },

  async post(url, body = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText || 'Request failed');
    }
    return res.json();
  },

  async put(url, body = {}) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText || 'Request failed');
    }
    return res.json();
  },

  async delete(url) {
    const res = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    return res.json();
  },

  async upload(file, path, chunkSize, convertHls, onProgress, uploadMode = 'api', uploadAccountIds = null) {
    if (uploadMode === 'seamless') {
      return SeamlessUpload.start(file, path, chunkSize, convertHls, onProgress, uploadAccountIds);
    }
    return UploadManager.start(file, path, chunkSize, convertHls, onProgress, uploadMode, uploadAccountIds);
  },

  async uploadChunk(fileId, chunkIndex, blob, taskId, uploadMode = 'api', signal) {
    const form = new FormData();
    form.append('chunk', blob, `chunk-${chunkIndex}`);
    form.append('fileId', fileId);
    form.append('chunkIndex', String(chunkIndex));
    form.append('taskId', taskId);
    form.append('uploadMode', uploadMode);

    const res = await fetch('/api/files/upload/chunk', {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
      signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Chunk upload failed' }));
      throw new Error(err.error || 'Chunk upload failed');
    }
    return res.json();
  },

  async uploadComplete(fileId, taskId, preview, uploadMode = 'api', convertHls = false) {
    console.log('[API.uploadComplete] called with convertHls=', convertHls, 'sending=', convertHls ? '1' : '0');
    const form = new FormData();
    form.append('fileId', fileId);
    form.append('taskId', taskId);
    form.append('uploadMode', uploadMode);
    form.append('convertHls', convertHls ? '1' : '0');
    if (preview) form.append('preview', preview, 'preview.bin');

    const res = await fetch('/api/files/upload/complete', {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Upload finalize failed' }));
      throw new Error(err.error || 'Upload finalize failed');
    }
    return res.json();
  },

  access: {
    status: () => API.get('/api/access/status'),
    verify: (key) => API.post('/api/access/verify', { key }),
  },

  auth: {
    me: () => API.get('/auth/me'),
    logout: () => API.post('/auth/logout'),
    apiKeys: () => API.get('/auth/api-keys'),
    createApiKey: (name) => API.post('/auth/api-keys', { name }),
    revokeApiKey: (id) => API.delete(`/auth/api-keys/${id}`),
  },

  agents: {
    list: () => API.get('/api/agents'),
    saveConfig: (id, config) => API.put(`/api/agents/${id}/config`, { config }),
    remove: (id) => API.delete(`/api/agents/${id}`),
  },

  viewQuery(view) {
    if (!view || view === 'primary') return '';
    return `?view=${encodeURIComponent(view)}`;
  },

  files: {
    list: (path, view) => {
      const params = new URLSearchParams({ path });
      if (view && view !== 'primary') params.set('view', view);
      return API.get(`/api/files/list?${params}`);
    },
    upload: (file, path, chunkSize, convertHls, onProgress, uploadMode, uploadAccountIds) =>
      API.upload(file, path, chunkSize, convertHls, onProgress, uploadMode, uploadAccountIds),
    uploadInit: (data) => API.post('/api/files/upload/init', data),
    uploadChunk: (fileId, chunkIndex, blob, taskId, uploadMode, signal) =>
      API.uploadChunk(fileId, chunkIndex, blob, taskId, uploadMode, signal),
    uploadComplete: (fileId, taskId, preview, uploadMode, convertHls) =>
      API.uploadComplete(fileId, taskId, preview, uploadMode, convertHls),
    seamlessInit: (data) => API.post('/api/files/upload/seamless/init', data),
    seamlessPart: async (fileId, partIndex, blob, taskId) => {
      const form = new FormData();
      form.append('part', blob, `part-${partIndex}`);
      form.append('fileId', fileId);
      form.append('partIndex', String(partIndex));
      form.append('taskId', taskId);
      const res = await fetch('/api/files/upload/seamless/part', {
        method: 'POST',
        body: form,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Seamless part upload failed' }));
        throw new Error(err.error || 'Seamless part upload failed');
      }
      return res.json();
    },
    seamlessComplete: (fileId, taskId, convertHls = false) =>
      API.post('/api/files/upload/seamless/complete', {
        fileId,
        taskId,
        convertHls: convertHls ? '1' : '0',
      }),
    seamlessStatus: (fileId) => API.get(`/api/files/upload/seamless/status/${fileId}`),
    seamlessResume: (fileId, taskId, convertHls = false) =>
      API.post('/api/files/upload/seamless/resume', {
        fileId,
        taskId,
        convertHls: convertHls ? '1' : '0',
      }),
    uploadCancel: (fileId, taskId) => API.post('/api/files/upload/cancel', { fileId, taskId }),
    uploadSession: (fileId) => API.get(`/api/files/upload/session/${fileId}`),
    refreshThumbnail: async (id) => {
      try {
        return await API.post(`/api/files/refresh-thumbnail/${id}`);
      } catch (err) {
        if (err.message === 'Not Found') {
          return API.post(`/api/files/thumbnail/${id}/refresh`);
        }
        throw err;
      }
    },
    uploadThumbnail: async (id, imageFile) => {
      const form = new FormData();
      form.append('thumbnail', imageFile, imageFile.name);
      const res = await fetch(`/api/files/thumbnail/${id}/upload`, {
        method: 'POST',
        body: form,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Thumbnail upload failed' }));
        throw new Error(err.error || 'Thumbnail upload failed');
      }
      return res.json();
    },
    uploadThumbnailBatch: async (form) => {
      const res = await fetch('/api/files/thumbnail-batch/upload', {
        method: 'POST',
        body: form,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Thumbnail batch upload failed' }));
        throw new Error(err.error || 'Thumbnail batch upload failed');
      }
      return res.json();
    },
    plan: (size, chunkSize, { convertHls = false, mimeType = null, fileName = null, uploadAccountIds = null } = {}) =>
      API.post('/api/files/plan', { size, chunkSize, convertHls, mimeType, fileName, uploadAccountIds }),
    uploadTargets: () => API.get('/api/files/upload-targets'),
    details: (id, view) => API.get(`/api/files/details/${id}${API.viewQuery(view)}`),
    history: (id) => API.get(`/api/files/history/${id}`),
    historyDownload: (id, versionId) => `/api/files/history/${id}/${versionId}/download`,
    historyView: (id, versionId) => `/api/files/history/${id}/${versionId}/view`,
    historyStream: (id, versionId) => `/api/files/history/${id}/${versionId}/stream`,
    historyDetails: (id, versionId) => API.get(`/api/files/history/${id}/${versionId}/details`),
    historyRestore: (id, versionId) => API.post(`/api/files/history/${id}/${versionId}/restore`),
    folderHistory: (folderId) => API.get(`/api/files/history/folder/${folderId}`),
    folderHistoryBrowse: (folderId, dayKey, parentPath) => {
      const q = parentPath ? `?parentPath=${encodeURIComponent(parentPath)}` : '';
      return API.get(`/api/files/history/folder/${folderId}/day/${dayKey}/browse${q}`);
    },
    folderHistoryRestore: (folderId, dayKey) => API.post(
      `/api/files/history/folder/${folderId}/day/${dayKey}/restore`,
    ),
    share: (id) => API.post(`/api/files/share/${id}`),
    unshare: (id) => API.delete(`/api/files/share/${id}`),
    shareSettings: () => API.get('/api/files/share/settings'),
    setShareSettings: (clientStream) => API.patch('/api/files/share/settings', { client_stream: clientStream }),
    download: (id, view) => `/api/files/download/${id}${API.viewQuery(view)}`,
    downloadPrepare: (id, view) => {
      const qs = API.viewQuery(view);
      return API.post(`/api/files/download/${id}/prepare${qs}`);
    },
    view: (id, view) => `/api/files/view/${id}${API.viewQuery(view)}`,
    stream: (id, view) => `/api/files/stream/${id}${API.viewQuery(view)}`,
    hlsPlaylist: (id, view) => `/api/files/hls/${id}/playlist.m3u8${API.viewQuery(view)}`,
    hlsUploadedPlaylist: (id, view) => `/api/files/hls/${id}/uploaded/playlist.m3u8${API.viewQuery(view)}`,
    hlsGithubPlaylist: (id) => `/api/files/hls/${id}/github-playlist`,
    status: (id) => API.get(`/api/files/status/${id}`),
    hlsConvert: (id) => API.post(`/api/files/hls-convert/${id}`),
    verifyHls: (id) => API.post(`/api/files/${id}/verify-hls`),
    verifyHlsBatch: (ids) => API.post('/api/files/verify-hls-batch', { ids }),
    verifyRepairInit: (id, body) => API.post(`/api/files/${id}/verify-repair/init`, body),
    verifyRepairChunk: async (fileId, chunkIndex, blob, taskId) => {
      const form = new FormData();
      form.append('chunk', blob, `chunk-${chunkIndex}`);
      form.append('chunkIndex', String(chunkIndex));
      if (taskId) form.append('taskId', taskId);
      const res = await fetch(`/api/files/${fileId}/verify-repair/chunk`, {
        method: 'POST',
        body: form,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Chunk repair failed' }));
        throw new Error(err.error || 'Chunk repair failed');
      }
      return res.json();
    },
    verifyRepairComplete: (id, taskId) => API.post(`/api/files/${id}/verify-repair/complete`, { taskId }),
    recent: (limit) => API.get(`/api/files/recent${limit ? '?limit=' + limit : ''}`),
    favorites: () => API.get('/api/files/favorites'),
    accessed: (id) => API.post(`/api/files/${id}/accessed`),
    favorite: (id) => API.post(`/api/files/${id}/favorite`),
    trash: (id) => API.post(`/api/files/${id}/trash`),
    trashBatch: (ids) => API.post('/api/files/trash-batch', { ids }),
    trashList: () => API.get('/api/files/trash'),
    restore: (id) => API.post(`/api/files/${id}/restore`),
    restoreBatch: (ids) => API.post('/api/files/restore-batch', { ids }),
    shared: () => API.get('/api/files/shared'),
    storageHealth: (opts = {}) => {
      const params = new URLSearchParams();
      if (opts.account_id) params.set('account_id', opts.account_id);
      if (opts.limit) params.set('limit', opts.limit);
      const qs = params.toString();
      return API.get(`/api/files/storage-health${qs ? '?' + qs : ''}`);
    },
    clearStorageBackoff: (accountId) => API.post('/api/files/storage-health/clear-backoff', { account_id: accountId }),
    search: (q, opts = {}) => {
      const params = new URLSearchParams({ q });
      if (opts.limit) params.set('limit', opts.limit);
      if (opts.sort) params.set('sort', opts.sort);
      if (opts.order) params.set('order', opts.order);
      return API.get(`/api/files/search?${params}`);
    },
    deletePermanent: (id) => API.delete(`/api/files/${id}/permanent`),
    delete: (id) => API.delete(`/api/files/${id}`),
    deleteBatch: (ids) => API.post('/api/files/delete-batch', { ids }),
    createFolder: (name, path) => API.post('/api/files/folder', { name, path }),
    move: (ids, destination) => API.post('/api/files/move', { ids, destination }),
    stats: () => API.get('/api/files/stats'),
    thumbnail: (id, version) => {
      if (typeof ThumbCache !== 'undefined') return ThumbCache.resolveUrl(id, version);
      return `/api/files/thumbnail/${id}${version ? `?v=${version}` : ''}`;
    },
  },

  playlists: {
    list: () => API.get('/api/playlists'),
    discover: (limit) => API.get(`/api/playlists/discover${limit ? '?limit=' + limit : ''}`),
    get: (id) => API.get(`/api/playlists/${id}`),
    create: (body) => API.post('/api/playlists', body),
    update: (id, body) => API.patch(`/api/playlists/${id}`, body),
    delete: (id) => API.delete(`/api/playlists/${id}`),
    duplicate: (id) => API.post(`/api/playlists/${id}/duplicate`),
    addItems: (id, fileIds, position) => API.post(`/api/playlists/${id}/items`, { file_ids: fileIds, position }),
    removeItem: (id, fileId) => API.delete(`/api/playlists/${id}/items/${fileId}`),
    removeItems: (id, fileIds) => API.post(`/api/playlists/${id}/items/remove`, { file_ids: fileIds }),
    updateItem: (id, fileId, body) => API.patch(`/api/playlists/${id}/items/${fileId}`, body),
    updateItems: (id, items) => API.patch(`/api/playlists/${id}/items`, { items }),
    reorder: (id, fileIds) => API.patch(`/api/playlists/${id}/reorder`, { file_ids: fileIds }),
    smartReorder: (id, body = {}) => API.post(`/api/playlists/${id}/reorder-smart`, body),
    linkFolder: (id, folderId, opts = {}) => API.post(`/api/playlists/${id}/folders`, {
      folder_id: folderId,
      include_subfolders: !!opts.include_subfolders,
      sort_by: opts.sort_by,
      sort_order: opts.sort_order,
    }),
    unlinkFolder: (id, folderId) => API.delete(`/api/playlists/${id}/folders/${folderId}`),
    sync: (id) => API.post(`/api/playlists/${id}/sync`),
    share: (id) => API.post(`/api/playlists/${id}/share`),
    unshare: (id) => API.delete(`/api/playlists/${id}/share`),
    saveProgress: (id, body) => API.post(`/api/playlists/${id}/progress`, body),
    getProgress: (id) => API.get(`/api/playlists/${id}/progress`),
    collections: () => API.get('/api/playlists/collections'),
    getCollection: (id) => API.get(`/api/playlists/collections/${id}`),
    createCollection: (body) => API.post('/api/playlists/collections', body),
    updateCollection: (id, body) => API.patch(`/api/playlists/collections/${id}`, body),
    deleteCollection: (id) => API.delete(`/api/playlists/collections/${id}`),
    addPlaylistToCollection: (collectionId, playlistId, position) =>
      API.post(`/api/playlists/collections/${collectionId}/playlists`, { playlist_id: playlistId, position }),
    removePlaylistFromCollection: (collectionId, playlistId) =>
      API.delete(`/api/playlists/collections/${collectionId}/playlists/${playlistId}`),
    shareCollection: (id) => API.post(`/api/playlists/collections/${id}/share`),
    publicPlaylist: (token) => API.get(`/api/public/playlist/${token}`),
    publicCollection: (token) => API.get(`/api/public/collection/${token}`),
  },

  accounts: {
    list: () => API.get('/api/accounts'),
    rateLimits: () => API.get('/api/accounts/rate-limits'),
    migrateToMysql: () => API.post('/api/accounts/migrate-mysql'),
    createLinkToken: (role) => API.post('/api/accounts/link-token', { role }),
    views: () => API.get('/api/accounts/views'),
    backupStatus: () => API.get('/api/accounts/backup-status'),
    startBackupSync: (accountId, { force = false } = {}) => API.post('/api/accounts/backup-sync', {
      account_id: accountId,
      force,
    }),
    redoBackup: (id) => API.post(`/api/accounts/${id}/redo-backup`),
    update: (id, data) => API.patch(`/api/accounts/${id}`, data),
    unlink: (id) => API.delete(`/api/accounts/${id}`),
    availableRepos: (id) => API.get(`/api/accounts/${id}/repos/available`),
  },

  async patch(url, body = {}) {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText || 'Request failed');
    }
    return res.json();
  },

  viewers: {
    live: () => API.get('/api/viewers/live'),
  },

  bandwidth: {
    summary: () => API.get('/api/bandwidth'),
    live: (seconds = 60) => API.get(`/api/bandwidth/live?seconds=${seconds}`),
  },

  repos: {
    available: () => API.get('/api/repos/available'),
    configured: () => API.get('/api/repos/configured'),
    capacity: () => API.get('/api/repos/capacity'),
    add: (full_name, linked_account_id) => API.post('/api/repos/add', { full_name, linked_account_id }),
    create: (linked_account_id) => API.post('/api/repos/create', { linked_account_id }),
    createBatch: ({ gb, count, linked_account_id } = {}) =>
      API.post('/api/repos/create-batch', { gb, count, linked_account_id }),
    remove: (id) => API.delete(`/api/repos/${id}`),
    toggle: (id, active) => API.post(`/api/repos/${id}/toggle`, { active }),
    org: () => API.get('/api/repos/org'),
    orgs: () => API.get('/api/repos/orgs'),
    setupOrg: (org, repoCount) => API.post('/api/repos/org/setup', { org, repoCount }),
    clearOrg: () => API.delete('/api/repos/org'),
    makePublic: () => API.post('/api/repos/make-public'),
  },

  cache: {
    stats: () => API.get('/api/cache/stats'),
    listEntries: () => API.get('/api/cache/entries'),
    clear: () => API.delete('/api/cache'),
    removeEntry: (id) => API.delete(`/api/cache/entries/${encodeURIComponent(id)}`),
    setConfig: ({ maxGb, idleRetentionDays } = {}) =>
      API.patch('/api/cache/config', { maxGb, idleRetentionDays }),
    setMaxGb: (maxGb) => API.patch('/api/cache/config', { maxGb }),
  },

  settings: {
    get: () => API.get('/api/settings'),
    update: (patch) => API.patch('/api/settings', patch),
  },

  plex: {
    sync: (body) => API.post('/api/plex/sync', body),
    manifest: (opts = {}) => {
      const qs = opts.prewarm ? '?prewarm=1' : '';
      return API.get(`/api/plex/manifest${qs}`);
    },
    prewarm: (body) => API.post('/api/plex/prewarm', body),
    refresh: () => API.post('/api/plex/refresh'),
    integrate: (body) => API.post('/api/plex/integrate', body),
    installAgent: (body) => API.post('/api/plex/install-agent', body),
    integrationStatus: () => API.get('/api/plex/integration-status'),
    verify: (opts = {}) => {
      const params = new URLSearchParams();
      if (opts.fileId) params.set('file_id', opts.fileId);
      if (opts.libraryPath) params.set('library_path', opts.libraryPath);
      const qs = params.toString();
      return API.get(`/api/plex/verify${qs ? `?${qs}` : ''}`);
    },
    streamTest: (fileId) => API.get(`/api/plex/stream-test/${encodeURIComponent(fileId)}`),
    test: (body) => API.post('/api/plex/test', body),
    libraries: () => API.get('/api/plex/libraries'),
  },

  tasks: {
    list: (opts = {}) => {
      const params = new URLSearchParams();
      if (opts.resumable) params.set('resumable', '1');
      if (opts.active === false) params.set('active', '0');
      const qs = params.toString();
      return API.get(`/api/tasks${qs ? `?${qs}` : ''}`);
    },
    get: (id) => API.get(`/api/tasks/${id}`),
    pause: (id, reason) => API.post(`/api/tasks/${id}/pause`, reason ? { reason } : {}),
    resume: (id) => API.post(`/api/tasks/${id}/resume`),
    cancel: (id) => API.post(`/api/tasks/${id}/cancel`),
    dismiss: (id) => API.delete(`/api/tasks/${id}`),
    clearFailed: () => API.delete('/api/tasks/failed'),
  },

  isVideoFile(fileName, mimeType) {
    return isVideoFile(fileName, mimeType);
  },
};

function driveBarClass(percent) {
  if (percent >= 90) return 'drive-bar-critical';
  if (percent >= 75) return 'drive-bar-warning';
  return 'drive-bar-healthy';
}

function renderDriveBar(vaultPercent, usedPercent) {
  const otherPercent = Math.max(0, usedPercent - vaultPercent);
  const cls = driveBarClass(usedPercent);
  return `
    <div class="drive-bar ${cls}">
      <div class="drive-bar-vault" data-bar="${vaultPercent}"></div>
      <div class="drive-bar-other" data-bar-left="${vaultPercent}" data-bar="${otherPercent}"></div>
    </div>
  `;
}

/** Apply widths/colors set via data-bar / data-bar-left / data-avatar-color (avoids inline style attributes in HTML). */
function applyDynamicStyles(root = document) {
  root.querySelectorAll('[data-bar]').forEach((el) => {
    el.style.width = `${el.dataset.bar}%`;
  });
  root.querySelectorAll('[data-bar-left]').forEach((el) => {
    el.style.left = `${el.dataset.barLeft}%`;
  });
  root.querySelectorAll('[data-avatar-color]').forEach((el) => {
    el.style.backgroundColor = el.dataset.avatarColor;
  });
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

const UploadPrefs = {
  KEY: 'vault-upload-mode',
  get() {
    const mode = localStorage.getItem(this.KEY);
    if (mode === 'git') return 'git';
    if (mode === 'api') return 'api';
    // Legacy preference from when seamless lived in the dropdown
    if (mode === 'seamless') return 'api';
    return 'api';
  },
  set(mode) {
    const stored = mode === 'git' ? 'git' : 'api';
    localStorage.setItem(this.KEY, stored);
  },
};

function isVideoFile(fileName, mimeType) {
  if (mimeType?.startsWith('video/')) return true;
  const ext = String(fileName || '').split('.').pop()?.toLowerCase();
  return ['mp4', 'webm', 'mkv', 'avi', 'mov', 'm4v', 'ogv', 'wmv'].includes(ext);
}

function getPreviewType(name, mimeType) {
  const ext = name.split('.').pop().toLowerCase();
  const images = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];
  const videos = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'm4v', 'ogv'];
  const audio = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'];
  const text = [
    'txt', 'md', 'markdown', 'json', 'xml', 'csv', 'log', 'js', 'ts', 'jsx', 'tsx',
    'py', 'rb', 'go', 'rs', 'java', 'css', 'scss', 'less', 'yaml', 'yml', 'toml',
    'ini', 'cfg', 'conf', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'dockerfile',
    'html', 'htm', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'swift', 'kt', 'r', 'lua',
    'vue', 'svelte', 'env', 'gitignore', 'dockerignore',
  ];

  if (mimeType?.startsWith('image/') || images.includes(ext)) return 'image';
  if (mimeType?.startsWith('video/') || videos.includes(ext)) return 'video';
  if (mimeType?.startsWith('audio/') || audio.includes(ext)) return 'audio';
  if (mimeType === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mimeType === 'text/html' || ext === 'html' || ext === 'htm') return 'html';
  if (
    mimeType?.startsWith('text/')
    || mimeType === 'application/json'
    || mimeType === 'application/xml'
    || text.includes(ext)
  ) return 'text';
  return null;
}

function getMediaType(name, mimeType) {
  const type = getPreviewType(name, mimeType);
  return ['image', 'video', 'audio'].includes(type) ? type : null;
}

function getFileIcon(name, isFolder) {
  if (isFolder) return '📁';
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    pdf: '📄', doc: '📝', docx: '📝', txt: '📝', md: '📝',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
    mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵',
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    js: '💛', ts: '💙', py: '🐍', html: '🌐', css: '🎨',
    json: '📋', xml: '📋', csv: '📊',
    exe: '⚙️', dmg: '💿', iso: '💿',
  };
  return icons[ext] || '📄';
}
