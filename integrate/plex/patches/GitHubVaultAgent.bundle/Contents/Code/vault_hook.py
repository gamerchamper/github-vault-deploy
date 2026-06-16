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

  art = sidecar.get('art_url') or thumb
  if art:
    metadata.art = art


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
