# GitHub Vault — LocalMedia infiltration hook
# Reads .vault-item.json sidecars written by vault Plex sync.
# Plex RestrictedPython rejects function names starting with "_".

import os

VAULT_PATH_MARKERS = ('github vault', 'github-vault', 'github_vault')
VAULT_URL_MARKERS = ('/api/files/stream/', 'vault.arktic.top', 'github-vault')


def string_has_marker(text, markers):
  if not text:
    return False
  for marker in markers:
    if marker in text:
      return True
  return False


def is_vault_path(path):
  if not path:
    return False
  normalized = path.replace('\\', '/').lower()
  return string_has_marker(normalized, VAULT_PATH_MARKERS)


def read_text_file(file_path):
  if not file_path:
    return None
  try:
    if not os.path.isfile(file_path):
      return None
    return StringFromFile(file_path)
  except Exception:
    return None


def read_strm_url(file_path):
  if not file_path or not file_path.lower().endswith('.strm'):
    return None
  try:
    text = read_text_file(file_path)
    if not text:
      return None
    url = text.strip().split('\n')[0].strip()
    return url or None
  except Exception:
    return None


def is_vault_stream_url(url):
  if not url:
    return False
  normalized = url.replace('\\', '/').lower()
  return string_has_marker(normalized, VAULT_URL_MARKERS)


def extract_file_id_from_stream_url(url):
  if not url:
    return None
  try:
    normalized = url.replace('\\', '/')
    marker = '/api/files/stream/'
    if marker not in normalized:
      return None
    tail = normalized.split(marker, 1)[1]
    file_id = tail.split('/', 1)[0].strip()
    if len(file_id) == 36:
      return file_id
  except Exception:
    pass
  return None


def is_audio_sidecar(sidecar):
  if not sidecar:
    return False
  mime = (sidecar.get('mime_type') or '').lower()
  if mime.startswith('audio/'):
    return True
  container = (sidecar.get('container') or '').lower()
  return container in ('mp3', 'm4a', 'flac', 'ogg', 'opus', 'wav', 'aac')


def resolve_vault_library_root(file_path):
  if not file_path or is_vault_stream_url(file_path):
    return None
  try:
    current = os.path.dirname(os.path.abspath(file_path))
    while current and len(current) > 3:
      if is_vault_path(current):
        return current
      parent = os.path.dirname(current)
      if parent == current:
        break
      current = parent
  except Exception:
    pass
  return None


def vault_library_root_from_media(media):
  for file_path in collect_media_part_files(media):
    root = resolve_vault_library_root(file_path)
    if root:
      return root
  return None


def has_vault_sidecar(file_path):
  if not file_path:
    return False
  base, ext = os.path.splitext(file_path)
  return os.path.isfile(base + '.vault-item.json')


def is_vault_item(file_path):
  """Public helper for GitHubVaultAgent — sidecar, folder, or vault stream URL."""
  if not file_path:
    return False
  if has_vault_sidecar(file_path):
    return True
  if is_vault_path(file_path):
    return True
  return is_vault_stream_url(read_strm_url(file_path))


def load_sidecar(file_path, library_root=None):
  if is_vault_stream_url(file_path):
    file_id = extract_file_id_from_stream_url(file_path)
    if file_id and library_root:
      candidate = os.path.join(library_root, '.vault-sidecars', file_id + '.vault-item.json')
      text = read_text_file(candidate)
      if text:
        try:
          return JSON.ObjectFromString(text)
        except Exception, err:
          Log('[GitHub Vault] sidecar read failed (%s): %s' % (candidate, err))

  base, ext = os.path.splitext(file_path)
  candidates = [
    base + '.vault-item.json',
    os.path.join(os.path.dirname(file_path), '.vault-item.json'),
  ]
  root = library_root or resolve_vault_library_root(file_path)
  file_id = extract_file_id_from_stream_url(read_strm_url(file_path) or (file_path if is_vault_stream_url(file_path) else ''))
  if file_id and root:
    candidates.insert(0, os.path.join(root, '.vault-sidecars', file_id + '.vault-item.json'))
  for candidate in candidates:
    if not os.path.isfile(candidate):
      continue
    text = read_text_file(candidate)
    if not text:
      continue
    try:
      return JSON.ObjectFromString(text)
    except Exception, err:
      Log('[GitHub Vault] sidecar read failed (%s): %s' % (candidate, err))
  return None


def video_resolution(height):
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


def infer_container(sidecar, file_path):
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
  if mime.startswith('audio/') or 'mpeg' in mime or 'mp3' in mime:
    if 'mp4' in mime or 'm4a' in mime:
      return 'm4a'
    return 'mp3'

  name = os.path.basename(file_path or '').lower()
  if name.endswith('.mp3.strm') or '.mp3.' in name:
    return 'mp3'
  if name.endswith('.m4a.strm') or '.m4a.' in name:
    return 'm4a'
  if name.endswith('.mkv.strm') or '.mkv.' in name:
    return 'mkv'
  if name.endswith('.webm.strm') or '.webm.' in name:
    return 'webm'
  if name.endswith('.mp4.strm') or '.mp4.' in name:
    return 'mp4'

  url = read_strm_url(file_path)
  if url:
    url_lower = url.lower().split('?')[0]
    if url_lower.endswith('.mkv'):
      return 'mkv'
    if url_lower.endswith('.webm'):
      return 'webm'
    if url_lower.endswith('.mp4') or url_lower.endswith('.m4v'):
      return 'mp4'
    if url_lower.endswith('.mp3'):
      return 'mp3'
    if url_lower.endswith('.m4a'):
      return 'm4a'

  if is_audio_sidecar(sidecar):
    return sidecar.get('container') or 'mp3'

  return 'mp4'


def safe_attr(obj, name, default=None):
  try:
    return getattr(obj, name)
  except Exception:
    return default


def read_metadata_media(metadata):
  """Plex MetadataObject.media — use direct access; getattr often fails in RestrictedPython."""
  if not metadata:
    return None
  try:
    return metadata.media
  except Exception, err:
    Log('[GitHub Vault] metadata.media read failed: %s' % err)
  return None


def ensure_metadata_media(metadata, video_codec, video_profile, audio_codec=None, audio_only=False):
  media_kit = read_metadata_media(metadata)
  if media_kit:
    return media_kit

  if audio_only:
    codec = audio_codec or 'mp3'
    try:
      metadata.media.addAudioCodec(codec)
      media_kit = read_metadata_media(metadata)
      if media_kit:
        Log('[GitHub Vault] created metadata.media via addAudioCodec(%s)' % codec)
        return media_kit
    except Exception, err:
      Log('[GitHub Vault] addAudioCodec failed: %s' % err)
  else:
    profile = video_profile or 'high'
    codec = video_codec or 'h264'
    try:
      metadata.media.addVideoCodec(codec, profile)
      media_kit = read_metadata_media(metadata)
      if media_kit:
        Log('[GitHub Vault] created metadata.media via addVideoCodec(%s, %s)' % (codec, profile))
        return media_kit
    except Exception, err:
      Log('[GitHub Vault] addVideoCodec failed: %s' % err)

  try:
    metadata.media.add()
    media_kit = read_metadata_media(metadata)
    if media_kit:
      Log('[GitHub Vault] created metadata.media via media.add()')
      return media_kit
  except Exception, err:
    Log('[GitHub Vault] media.add failed: %s' % err)

  return None


def collect_media_part_files(media):
  """Collect local file paths from a Plex MediaTree (movie or TV)."""
  files = []
  if not media:
    return files

  parts = safe_attr(media, 'parts') or []
  try:
    for part in parts:
      if part.file:
        files.append(part.file)
  except Exception:
    pass

  items = safe_attr(media, 'items') or []
  try:
    for item in items:
      for part in item.parts or []:
        if part.file:
          files.append(part.file)
  except Exception:
    pass

  seasons = safe_attr(media, 'seasons') or {}
  try:
    for season_key in seasons:
      season = seasons[season_key]
      for episode_key in season.episodes or {}:
        episode = season.episodes[episode_key]
        for item in episode.items or []:
          for part in item.parts or []:
            if part.file:
              files.append(part.file)
  except Exception:
    pass

  return files


def first_media_part_file(media):
  files = collect_media_part_files(media)
  if files:
    return files[0]
  return None


def is_vault_media_tree(media):
  for file_path in collect_media_part_files(media):
    if is_vault_item(file_path):
      return True
  return False


def stream_type_value(stream):
  try:
    return int(getattr(stream, 'streamType', None) or getattr(stream, 'type', 0))
  except Exception:
    return 0


def part_stream_flags(part):
  has_video = False
  has_audio = False
  try:
    streams = list(part.streams) if part.streams else []
  except Exception:
    streams = []
  for stream in streams:
    st = stream_type_value(stream)
    if st == 1:
      has_video = True
    elif st == 2:
      has_audio = True
  return has_video, has_audio


def apply_part_streams(part, sidecar):
  if not part:
    return False

  audio_only = is_audio_sidecar(sidecar)
  has_video, has_audio = part_stream_flags(part)
  if audio_only and has_audio:
    return False
  if not audio_only and has_video and has_audio:
    return False

  video_codec = sidecar.get('video_codec') or sidecar.get('videoCodec') or 'h264'
  audio_codec = sidecar.get('audio_codec') or sidecar.get('audioCodec') or ('mp3' if audio_only else 'aac')
  video_profile = sidecar.get('video_profile') or 'high'
  audio_channels = sidecar.get('audio_channels') or 2
  width = sidecar.get('width')
  height = sidecar.get('height')
  bitrate = sidecar.get('bitrate')
  touched = False

  if not has_video and not audio_only:
    video = None
    try:
      video = part.addStream(1)
    except Exception:
      video = None
    if video is None:
      try:
        video = part.addPrimaryStream('video')
      except Exception:
        video = None
    if video is None:
      try:
        video = part.addPrimaryStream(1)
      except Exception:
        video = None
    if video is None:
      try:
        video = part.streams.add()
        video.streamType = 1
      except Exception:
        video = None
    if video is not None:
      try:
        video.codec = video_codec
        video.index = 0
        video.profile = video_profile
        if width:
          video.width = int(width)
        if height:
          video.height = int(height)
        if bitrate:
          video.bitrate = int(int(bitrate) / 1000)
        touched = True
      except Exception, err:
        Log('[GitHub Vault] video stream attrs failed: %s' % err)

  if not has_audio:
    audio = None
    try:
      audio = part.addStream(2)
    except Exception:
      audio = None
    if audio is None:
      try:
        audio = part.addPrimaryStream('audio')
      except Exception:
        audio = None
    if audio is None:
      try:
        audio = part.addPrimaryStream(2)
      except Exception:
        audio = None
    if audio is None:
      try:
        audio = part.streams.add()
        audio.streamType = 2
      except Exception:
        audio = None
    if audio is not None:
      try:
        audio.codec = audio_codec
        audio.index = 0 if audio_only else 1
        audio.channels = int(audio_channels)
        audio.selected = True
        touched = True
      except Exception, err:
        Log('[GitHub Vault] audio stream attrs failed: %s' % err)

  if touched:
    Log('[GitHub Vault] added synthetic streams (video=%s audio=%s)' % (video_codec, audio_codec))
  return touched


def media_item_parts(media_item, file_path):
  try:
    parts = list(media_item.parts) if media_item.parts else []
  except Exception:
    parts = []
  if not parts and file_path:
    try:
      part = media_item.parts.add()
      part.file = file_path
      parts = [part]
    except Exception, err:
      Log('[GitHub Vault] could not add media part for %s: %s' % (file_path, err))
  return parts


def apply_media_technical(metadata, sidecar, file_path):
  if not sidecar:
    sidecar = {}

  container = infer_container(sidecar, file_path)
  audio_only = is_audio_sidecar(sidecar)
  video_codec = sidecar.get('video_codec') or sidecar.get('videoCodec') or ('h264' if not audio_only else None)
  audio_codec = sidecar.get('audio_codec') or sidecar.get('audioCodec') or ('mp3' if audio_only else 'aac')
  video_profile = sidecar.get('video_profile') or 'high'
  audio_channels = sidecar.get('audio_channels') or 2
  width = sidecar.get('width')
  height = sidecar.get('height')
  bitrate = sidecar.get('bitrate')
  duration = sidecar.get('duration_sec')
  video_resolution_label = sidecar.get('video_resolution') or video_resolution(height)
  duration_ms = None
  if duration:
    try:
      duration_ms = int(float(duration) * 1000)
    except Exception:
      duration_ms = None

  media_kit = ensure_metadata_media(metadata, video_codec, video_profile, audio_codec, audio_only)
  if not media_kit:
    Log('[GitHub Vault] technical media skipped — Plex Movie agents have no metadata.media; use vault sync DB repair')
    return False

  touched = False
  try:
    media_items = list(media_kit) if media_kit else []
  except Exception:
    media_items = []

  if not media_items:
    try:
      media_items = [media_kit.add()]
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
    try:
      media.videoProfile = video_profile
      touched = True
    except Exception:
      pass
    try:
      media.audioChannels = int(audio_channels)
      touched = True
    except Exception:
      pass
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
    if video_resolution_label:
      media.videoResolution = video_resolution_label
      touched = True
    if bitrate:
      try:
        media.bitrate = int(int(bitrate) / 1000)
        touched = True
      except Exception:
        pass
    if duration_ms:
      media.duration = duration_ms
      touched = True
    if width and height:
      try:
        media.aspectRatio = round(float(width) / float(height), 3)
        touched = True
      except Exception:
        pass

    parts = media_item_parts(media, file_path)
    for part in parts:
      if container:
        part.container = container
        touched = True
      if duration_ms:
        try:
          part.duration = duration_ms
          touched = True
        except Exception:
          pass
      if apply_part_streams(part, sidecar):
        touched = True

  return touched


def apply_sidecar(metadata, sidecar, file_path):
  if not sidecar:
    sidecar = {}

  title = sidecar.get('title')
  if title:
    metadata.title = title

  summary = sidecar.get('summary')
  if summary:
    metadata.summary = summary

  duration = sidecar.get('duration_sec')
  if duration:
    try:
      metadata.duration = int(float(duration) * 1000)
    except Exception:
      pass

  technical = apply_media_technical(metadata, sidecar, file_path)
  if technical:
    Log('[GitHub Vault] applied media technical metadata (container=%s, duration=%s)' % (
      infer_container(sidecar, file_path),
      sidecar.get('duration_sec'),
    ))
  elif sidecar:
    Log('[GitHub Vault] applied descriptive metadata for %s' % (file_path or 'unknown'))


def resolve_episode_metadata(metadata, media, file_path):
  seasons = safe_attr(media, 'seasons')
  meta_seasons = safe_attr(metadata, 'seasons')
  if not seasons or not meta_seasons:
    return metadata

  try:
    for season_key in seasons:
      season = seasons[season_key]
      for episode_key in season.episodes or {}:
        episode_media = season.episodes[episode_key]
        for item in episode_media.items or []:
          for part in item.parts or []:
            if part.file == file_path:
              return meta_seasons[season_key].episodes[episode_key]
        for part in episode_media.parts or []:
          if part.file == file_path:
            return meta_seasons[season_key].episodes[episode_key]
  except Exception, err:
    Log('[GitHub Vault] episode metadata resolve failed: %s' % err)
  return metadata


def enrich_all(metadata, media, label, for_tv=False):
  touched = False
  library_root = vault_library_root_from_media(media)
  for file_path in collect_media_part_files(media):
    if not is_vault_item(file_path):
      continue
    if for_tv:
      target = resolve_episode_metadata(metadata, media, file_path)
    else:
      target = metadata
    sidecar = load_sidecar(file_path, library_root) or {}
    apply_sidecar(target, sidecar, file_path)
    touched = True
    Log('[GitHub Vault] enriched %s metadata for %s' % (label, file_path))
  if not touched:
    Log('[GitHub Vault] %s enrich skipped — no vault parts found on media tree' % label)


def enrich_movie(metadata, media):
  enrich_all(metadata, media, 'movie', for_tv=False)


def enrich_tv(metadata, media):
  enrich_all(metadata, media, 'TV', for_tv=True)
