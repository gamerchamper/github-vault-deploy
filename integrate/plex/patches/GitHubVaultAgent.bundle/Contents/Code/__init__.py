# GitHub Vault metadata agent — appears under Settings → Plugins

VAULT_MARKERS = ('github vault', 'github-vault', 'github_vault')


def _is_vault_media(media):
  try:
    if media.items:
      path = media.items[0].parts[0].file
    elif media.seasons:
      for season in media.seasons:
        for episode in media.seasons[season].episodes:
          return _is_vault_path(media.seasons[season].episodes[episode].items[0].parts[0].file)
    else:
      return False
    return _is_vault_path(path)
  except Exception:
    return False


def _is_vault_path(path):
  if not path:
    return False
  normalized = path.replace('\\', '/').lower()
  return any(marker in normalized for marker in VAULT_MARKERS)


class GitHubVaultMovieAgent(Agent.Movies):
  name = 'GitHub Vault'
  languages = [Locale.Language.NoLanguage]
  primary_provider = False
  persist_stored_files = False
  contributes_to = ['com.plexapp.agents.none']

  def search(self, results, media, lang):
    if _is_vault_media(media):
      results.Append(MetadataSearchResult(id='githubvault', score=100))

  def update(self, metadata, media, lang):
    if not _is_vault_media(media):
      return
    try:
      import vault_hook
      vault_hook.enrich_movie(metadata, media)
    except Exception, err:
      Log('[GitHub Vault agent] movie update failed: %s' % err)


class GitHubVaultTVAgent(Agent.TV_Shows):
  name = 'GitHub Vault'
  languages = [Locale.Language.NoLanguage]
  primary_provider = False
  persist_stored_files = False
  contributes_to = ['com.plexapp.agents.none']

  def search(self, results, media, lang):
    if _is_vault_media(media):
      results.Append(MetadataSearchResult(id='githubvault', score=100))

  def update(self, metadata, media, lang):
    if not _is_vault_media(media):
      return
    try:
      import vault_hook
      vault_hook.enrich_tv(metadata, media)
    except Exception, err:
      Log('[GitHub Vault agent] TV update failed: %s' % err)
