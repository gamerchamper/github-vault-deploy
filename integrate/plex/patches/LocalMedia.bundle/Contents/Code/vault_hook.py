# GitHub Vault — LocalMedia infiltration hook
# Reads .vault-item.json sidecars written by vault Plex sync.

import os
import json

VAULT_PATH_MARKERS = ('github vault', 'github-vault', 'github_vault')


def _is_vault_path(path):
  if not path:
    return False
  normalized = path.replace('\\', '/').lower()
  return any(marker in normalized for marker in VAULT_PATH_MARKERS)


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


def _apply_media_technical(metadata, sidecar):
  if not sidecar:
    return False

  container = sidecar.get('container')
  video_codec = sidecar.get('video_codec') or sidecar.get('videoCodec')
  audio_codec = sidecar.get('audio_codec') or sidecar.get('audioCodec')
  video_profile = sidecar.get('video_profile') or 'high'
  width = sidecar.get('width')
  height = sidecar.get('height')
  bitrate = sidecar.get('bitrate')
  duration = sidecar.get('duration_sec')
  video_resolution = sidecar.get('video_resolution') or _video_resolution(height)

  if not any([container, video_codec, audio_codec, width, height, duration]):
    return False

  touched = False
  media_items = list(metadata.media) if metadata.media else []

  if not media_items and video_codec:
    try:
      media_items = [metadata.media.addVideoCodec(video_codec, video_profile)]
      touched = True
    except Exception, err:
      Log('[GitHub Vault] addVideoCodec failed: %s' % err)
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


def _apply_sidecar(metadata, sidecar):
  if not sidecar:
    return

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

  if _apply_media_technical(metadata, sidecar):
    Log('[GitHub Vault] applied media technical metadata from sidecar')


def enrich_movie(metadata, media):
  try:
    part = media.items[0].parts[0]
  except Exception:
    return
  if not _is_vault_path(part.file):
    return
  sidecar = _load_sidecar(part.file)
  if sidecar:
    _apply_sidecar(metadata, sidecar)
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
      if not _is_vault_path(part.file):
        continue
      sidecar = _load_sidecar(part.file)
      if not sidecar:
        continue
      episode_metadata = metadata.seasons[season_key].episodes[episode_key]
      _apply_sidecar(episode_metadata, sidecar)
      touched = True
  if touched:
    Log('[GitHub Vault] enriched TV metadata for %s' % media.title)
