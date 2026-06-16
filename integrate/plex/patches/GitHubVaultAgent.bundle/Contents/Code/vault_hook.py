# GitHub Vault — LocalMedia infiltration hook
# Reads .vault-item.json sidecars written by vault Plex sync.

import os
import json

VAULT_PATH_MARKERS = ('github vault', 'github-vault', 'github_vault')
VAULT_URL_MARKERS = ('/api/files/stream/', 'vault.arktic.top', 'github-vault')


def _is_vault_path(path):
  if not path:
    return False
  normalized = path.replace('\\', '/').lower()
  return any(marker in normalized for marker in VAULT_PATH_MARKERS)


def _read_strm_url(file_path):
  if not file_path or not file_path.lower().endswith('.strm'):
    return None
  try:
    handle = open(file_path, 'r')
    url = handle.read().strip().split('\n')[0].strip()
    handle.close()
    return url or None
  except Exception:
    return None


def _is_vault_stream_url(url):
  if not url:
    return False
  normalized = url.replace('\\', '/').lower()
  return any(marker in normalized for marker in VAULT_URL_MARKERS)


def _has_vault_sidecar(file_path):
  if not file_path:
    return False
  base, _ = os.path.splitext(file_path)
  return os.path.isfile(base + '.vault-item.json')


def is_vault_item(file_path):
  """Public helper for GitHubVaultAgent — sidecar, folder, or vault stream URL."""
  if not file_path:
    return False
  if _has_vault_sidecar(file_path):
    return True
  if _is_vault_path(file_path):
    return True
  return _is_vault_stream_url(_read_strm_url(file_path))


def _load_sidecar(file_path):
  base, _ = os.path.splitext(file_path)
  candidates = [
    base + '.vault-item.json',
    os.path.join(os.path.dirname(file_path), '.vault-item.json'),
  ]
  for candidate in candidates:
    if os.path.isfile(candidate):
      try:
        handle = open(candidate, 'r')
        data = json.load(handle)
        handle.close()
        return data
      except Exception, err:
        Log('[GitHub Vault] sidecar read failed (%s): %s' % (candidate, err))
  return None


def _video_resolution(height):
  try:
    h = int(height)
  except Exception:
    return None
  if h >= 2160:
    return '4k'
  if h >= 1440:
    return '1440'
  if h >= 1080:
    return '1080'
  if h >= 720:
    return '720'
  if h >= 576:
    return '576'
  if h >= 480:
    return '480'
  if h > 0:
    return 'sd'
  return None


def _infer_container(sidecar, file_path):
  container = sidecar.get('container') if sidecar else None
  if container:
    return container

  mime = (sidecar.get('mime_type') if sidecar else None) or ''
  mime = mime.lower()
  if 'mp4' in mime or mime == 'video/mp4':
    return 'mp4'
  if 'webm' in mime:
    return 'webm'
  if 'matroska' in mime or 'mkv' in mime:
    return 'mkv'
  if mime.startswith('video/'):
    return 'mp4'

  name = os.path.basename(file_path or '').lower()
  if name.endswith('.mkv.strm') or '.mkv.' in name:
    return 'mkv'
  if name.endswith('.webm.strm') or '.webm.' in name:
    return 'webm'
  if name.endswith('.mp4.strm') or '.mp4.' in name:
    return 'mp4'

  url = _read_strm_url(file_path)
  if url:
    url_lower = url.lower().split('?')[0]
    if url_lower.endswith('.mkv'):
      return 'mkv'
    if url_lower.endswith('.webm'):
      return 'webm'
    if url_lower.endswith('.mp4') or url_lower.endswith('.m4v'):
      return 'mp4'

  return 'mp4'


def _apply_media_technical(metadata, sidecar, file_path):
  if not sidecar:
    sidecar = {}

  container = _infer_container(sidecar, file_path)
  video_codec = sidecar.get('video_codec') or sidecar.get('videoCodec') or 'h264'
  audio_codec = sidecar.get('audio_codec') or sidecar.get('audioCodec') or 'aac'
  video_profile = sidecar.get('video_profile') or 'high'
  width = sidecar.get('width')
  height = sidecar.get('height')
  bitrate = sidecar.get('bitrate')
  duration = sidecar.get('duration_sec')
  video_resolution = sidecar.get('video_resolution') or _video_resolution(height)

  touched = False
  media_items = list(metadata.media) if metadata.media else []

  if not media_items:
    try:
      media_items = [metadata.media.addVideoCodec(video_codec, video_profile)]
      touched = True
    except Exception, err:
      Log('[GitHub Vault] addVideoCodec failed: %s' % err)
      try:
        media_items = [metadata.media.add()]
        touched = True
      except Exception, err2:
        Log('[GitHub Vault] media.add failed: %s' % err2)
        return False

  for media in media_items:
    if container:
      media.container = container
      touched = True
    if video_codec:
      media.videoCodec = video_codec
      touched = True
    if audio_codec:
      media.audioCodec = audio_codec
      touched = True
    if width:
      try:
        media.width = int(width)
        touched = True
      except Exception:
        pass
    if height:
      try:
        media.height = int(height)
        touched = True
      except Exception:
        pass
    if video_resolution:
      media.videoResolution = video_resolution
      touched = True
    if bitrate:
      try:
        media.bitrate = int(int(bitrate) / 1000)
        touched = True
      except Exception:
        pass
    if duration:
      try:
        media.duration = int(float(duration) * 1000)
        touched = True
      except Exception:
        pass
    if width and height:
      try:
        media.aspectRatio = round(float(width) / float(height), 3)
        touched = True
      except Exception:
        pass

    try:
      parts = list(media.parts) if media.parts else []
    except Exception:
      parts = []
    for part in parts:
      if container:
        part.container = container
        touched = True

  return touched


def _apply_sidecar(metadata, sidecar, file_path):
  if not sidecar:
    sidecar = {}

  title = sidecar.get('title')
  if title:
    metadata.title = title

  summary = sidecar.get('summary')
  if summary:
    metadata.summary = summary

  thumb = sidecar.get('thumbnail_url')
  if thumb:
    metadata.thumbs[thumb] = Proxy.Media(thumb)
    if not metadata.art:
      metadata.art = thumb

  duration = sidecar.get('duration_sec')
  if duration:
    try:
      metadata.duration = int(float(duration) * 1000)
    except Exception:
      pass

  art = sidecar.get('art_url') or thumb
  if art:
    metadata.art = art

  if _apply_media_technical(metadata, sidecar, file_path):
    Log('[GitHub Vault] applied media technical metadata (container=%s)' % _infer_container(sidecar, file_path))


def enrich_movie(metadata, media):
  try:
    part = media.items[0].parts[0]
  except Exception:
    return
  if not is_vault_item(part.file):
    return
  sidecar = _load_sidecar(part.file) or {}
  _apply_sidecar(metadata, sidecar, part.file)
  Log('[GitHub Vault] enriched movie metadata for %s' % part.file)


def enrich_tv(metadata, media):
  touched = False
  for season_key in media.seasons:
    for episode_key in media.seasons[season_key].episodes:
      episode_media = media.seasons[season_key].episodes[episode_key].items[0]
      try:
        part = episode_media.parts[0]
      except Exception:
        continue
      if not is_vault_item(part.file):
        continue
      sidecar = _load_sidecar(part.file) or {}
      episode_metadata = metadata.seasons[season_key].episodes[episode_key]
      _apply_sidecar(episode_metadata, sidecar, part.file)
      touched = True
  if touched:
    Log('[GitHub Vault] enriched TV metadata for %s' % media.title)
