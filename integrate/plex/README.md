# Plex full integration

Vault installs directly into Plex — no manual STRM CLI, no separate library folder setup.

## What it does

1. **Deploys plugins** to `%LOCALAPPDATA%\Plex Media Server\Plug-ins\`
   - `GitHubVaultAgent.bundle` — appears under **Settings → Plugins**
   - `GitHubVault.bundle` — channel bridge (legacy clients)

2. **Infiltrates bundled Plex plugins** (Program Files / repo `Resources/Plug-ins-*`)
   - `LocalMedia.bundle` — reads `.vault-item.json` sidecars for thumbs/titles
   - `Scanners.bundle` — adds **GitHub Vault Scanner**

3. **Writes Plex data files**
   - `Plug-in Support/Preferences/com.githubvault.plex.*.xml` — vault URL + API key
   - `GitHub Vault/.vault-plex-integration.json` — integration manifest

4. **Creates Plex library** via official API (`GitHub Vault` → show library)

5. **Syncs playlists** into `{Plex Data}/GitHub Vault/` and refreshes the library

## From vault UI

**Settings → Integrate with Plex** (paste Plex token first) → restart Plex.

## CLI

```bash
set PLEX_TOKEN=your_token
npm run plex:integrate
```

Optional env:

| Variable | Purpose |
|----------|---------|
| `PLEX_DATA_DIR` | Override Plex data folder |
| `PLEX_RESOURCES_DIR` | Override `…/Plex Media Server/Resources` for bundled patches |
| `PLEX_SERVER_URL` | Default `http://127.0.0.1:32400` |

## After Plex updates

Re-run **Integrate with Plex** to re-apply bundled plugin patches (LocalMedia/Scanners). User plugins in `Plug-ins/` persist across updates.

## Repo copy

This repo includes a full Plex tree with patches pre-applied under `Plex Media Server/Resources/Plug-ins-563d026ea/`.
