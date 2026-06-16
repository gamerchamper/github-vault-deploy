const playlists = require('./playlists');
const appUrl = require('./app-url');

function mediaBase(req) {
  return appUrl.getAppUrl(req);
}

function thumbUrl(req, fileId) {
  if (!fileId) return null;
  return `${mediaBase(req)}/api/files/thumbnail/${fileId}`;
}

function streamUrl(req, fileId) {
  return `${mediaBase(req)}/api/files/stream/${fileId}`;
}

function hlsUrl(req, fileId) {
  return `${mediaBase(req)}/api/files/hls/${fileId}/playlist.m3u8`;
}

function mapPlaylistSummary(playlist, req) {
  const coverId = playlist.cover_thumbnail_id || playlist.cover_file_id;
  return {
    id: playlist.id,
    title: playlist.title,
    summary: playlist.description || '',
    item_count: playlist.item_count || 0,
    visibility: playlist.visibility,
    share_url: playlist.share_url || null,
    thumbnail_url: thumbUrl(req, coverId),
  };
}

function mapCollectionSummary(collection, req) {
  const coverId = collection.cover_thumbnail_id || collection.cover_file_id;
  return {
    id: collection.id,
    title: collection.title,
    summary: collection.description || '',
    playlist_count: collection.playlist_count || 0,
    visibility: collection.visibility,
    share_url: collection.share_url || null,
    thumbnail_url: thumbUrl(req, coverId),
  };
}

function mapItem(item, req) {
  const title = item.display_name || item.name;
  const isVideo = (item.mime_type || '').startsWith('video/');
  const isAudio = (item.mime_type || '').startsWith('audio/');
  return {
    id: item.id,
    title,
    summary: item.path || item.parent_path || '',
    mime_type: item.mime_type,
    media_type: isVideo ? 'video' : isAudio ? 'audio' : 'other',
    size: item.size,
    duration_sec: item.hls_duration_sec || null,
    has_hls: !!item.has_hls,
    position: item.position,
    progress_pct: item.progress_pct,
    completed: item.completed,
    position_seconds: item.position_seconds,
    stream_url: streamUrl(req, item.id),
    hls_url: item.has_hls ? hlsUrl(req, item.id) : null,
    thumbnail_url: item.has_thumbnail ? thumbUrl(req, item.id) : null,
  };
}

function mapContinueEntry(entry, req) {
  return {
    ...mapItem({
      id: entry.file_id,
      name: entry.file_name,
      display_name: entry.file_name,
      mime_type: entry.mime_type,
      has_thumbnail: entry.has_thumbnail,
      has_hls: entry.has_hls,
      hls_duration_sec: entry.hls_duration_sec,
      progress_pct: entry.progress_pct,
      completed: entry.completed,
      position_seconds: entry.position_seconds,
      path: entry.playlist_title ? `From ${entry.playlist_title}` : '',
    }, req),
    playlist_id: entry.playlist_id || null,
    playlist_title: entry.playlist_title || null,
  };
}

function getHub(userId, req, { limit = 12 } = {}) {
  const capped = Math.min(Math.max(1, limit), 50);

  return {
    vault_url: mediaBase(req),
    user: { id: userId },
    continue_watching: playlists.getContinueWatching(userId, capped).map((entry) => mapContinueEntry(entry, req)),
    recent_playlists: playlists.getRecentPlaylists(userId, capped).map((p) => mapPlaylistSummary(p, req)),
    playlists: playlists.listPlaylists(userId, req).map((p) => mapPlaylistSummary(p, req)),
    collections: playlists.listCollections(userId, req).map((c) => mapCollectionSummary(c, req)),
  };
}

function getPlaylist(userId, playlistId, req) {
  const playlist = playlists.getPlaylist(userId, playlistId, req);
  return {
    ...mapPlaylistSummary(playlist, req),
    items: (playlist.items || []).map((item) => mapItem(item, req)),
    folder_links: playlist.folder_links || [],
  };
}

function getCollection(userId, collectionId, req) {
  const collection = playlists.getCollection(userId, collectionId, req);
  return {
    ...mapCollectionSummary(collection, req),
    playlists: (collection.playlists || []).map((p) => mapPlaylistSummary(p, req)),
  };
}

module.exports = {
  getHub,
  getPlaylist,
  getCollection,
  mapItem,
  mapContinueEntry,
  mapPlaylistSummary,
  mapCollectionSummary,
};
