# GitHub Vault metadata agent — appears under Settings → Plugins


def _is_vault_media(media):
  try:
    import vault_hook
    if media.items:
      return vault_hook.is_vault_item(media.items[0].parts[0].file)
    if media.seasons:
      for season in media.seasons:
        for episode in media.seasons[season].episodes:
          part = media.seasons[season].episodes[episode].items[0].parts[0].file
          if vault_hook.is_vault_item(part):
            return True
    return False
  except Exception:
    return False


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
