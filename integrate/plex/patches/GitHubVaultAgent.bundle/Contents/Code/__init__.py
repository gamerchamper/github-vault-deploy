# GitHub Vault metadata agent — appears in library Agent dropdown and Settings → Plugins


def Start():
  Log('[GitHub Vault] metadata agent loaded (primary provider)')


def is_vault_media(media):
  try:
    import vault_hook
    return vault_hook.is_vault_media_tree(media)
  except Exception, err:
    Log('[GitHub Vault agent] vault detection failed: %s' % err)
    return False


class GitHubVaultMovieAgent(Agent.Movies):
  name = 'GitHub Vault'
  languages = [Locale.Language.NoLanguage]
  primary_provider = True
  persist_stored_files = False
  contributes_to = None

  def search(self, results, media, lang):
    if is_vault_media(media):
      results.Append(MetadataSearchResult(id='githubvault', score=100))

  def update(self, metadata, media, lang):
    if not is_vault_media(media):
      return
    try:
      import vault_hook
      vault_hook.enrich_movie(metadata, media)
    except Exception, err:
      Log('[GitHub Vault agent] movie update failed: %s' % err)


class GitHubVaultTVAgent(Agent.TV_Shows):
  name = 'GitHub Vault Shows'
  languages = [Locale.Language.NoLanguage]
  primary_provider = True
  persist_stored_files = False
  contributes_to = None

  def search(self, results, media, lang):
    if is_vault_media(media):
      results.Append(MetadataSearchResult(id='githubvault', score=100))

  def update(self, metadata, media, lang):
    if not is_vault_media(media):
      return
    try:
      import vault_hook
      vault_hook.enrich_tv(metadata, media)
    except Exception, err:
      Log('[GitHub Vault agent] TV update failed: %s' % err)
