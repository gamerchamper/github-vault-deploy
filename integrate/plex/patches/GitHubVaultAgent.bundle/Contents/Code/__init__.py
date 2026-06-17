# GitHub Vault metadata agent — appears in library Agent dropdown and Settings → Plugins


def Start():
  Log('[GitHub Vault] metadata agent loaded (primary provider)')


def vault_movie_search_id(media):
  try:
    return media.items[0].parts[0].hash
  except Exception:
    try:
      return str(media.id)
    except Exception:
      return 'githubvault'


def vault_tv_search_id(media):
  try:
    return str(media.id)
  except Exception:
    return 'githubvault'


def is_vault_media(media):
  try:
    import vault_hook
    if vault_hook is None:
      return False
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
    if not is_vault_media(media):
      return
    match_id = vault_movie_search_id(media)
    results.Append(MetadataSearchResult(id=match_id, name=media.name, lang=lang, score=100))

  def update(self, metadata, media, lang):
    if not is_vault_media(media):
      return
    try:
      import vault_hook
      vault_hook.enrich_movie(metadata, media)
      Log('[GitHub Vault agent] updated movie metadata (match=%s)' % vault_movie_search_id(media))
    except Exception, err:
      Log('[GitHub Vault agent] movie update failed: %s' % err)


class GitHubVaultTVAgent(Agent.TV_Shows):
  name = 'GitHub Vault Shows'
  languages = [Locale.Language.NoLanguage]
  primary_provider = True
  persist_stored_files = False
  contributes_to = None

  def search(self, results, media, lang):
    if not is_vault_media(media):
      return
    match_id = vault_tv_search_id(media)
    results.Append(MetadataSearchResult(id=match_id, name=media.show, lang=lang, score=100))

  def update(self, metadata, media, lang):
    if not is_vault_media(media):
      return
    try:
      import vault_hook
      vault_hook.enrich_tv(metadata, media)
      Log('[GitHub Vault agent] updated TV metadata (match=%s)' % vault_tv_search_id(media))
    except Exception, err:
      Log('[GitHub Vault agent] TV update failed: %s' % err)
