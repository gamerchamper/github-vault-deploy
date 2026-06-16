# GitHub Vault → Plex (STRM library)

Modern Plex **does not show third-party channel plugins** in **Settings → Plugins**. That page only lists built-in **metadata agents** (TheTVDB, TheMovieDB, etc.).

The channel plugin in `Plug-ins/GitHubVault.bundle` may still work on some older setups via **Plugins/Channels** in the app sidebar, but most current Plex versions have removed that UI entirely.

## Recommended: STRM library sync (works on all Plex versions)

This creates a folder of `.strm` files (one-line stream URLs). Plex scans them like normal media.

### 1. Create an API key

In GitHub Vault web UI, create an API key (`gv_…`).

### 2. Run sync

From the repo root:

```bash
npm run plex:sync -- --url https://vault.arktic.top --key gv_YOUR_KEY --out "D:/Plex/GitHub Vault"
```

Or copy `config.example.json` to `config.json`, edit it, then:

```bash
npm run plex:sync -- --config clients/plex-sync/config.json
```

Output layout:

```
GitHub Vault/
  Playlists/
    My Show/
      01 - Pilot.strm
      02 - Episode 2.strm
  Collections/
    Anime/
      Season 1/
        01 - …strm
  Continue Watching/
    …
```

### 3. Add Plex library

1. Plex → **Add library**
2. Type: **Other Videos** (or Movies / TV depending on preference)
3. Folder: your `--out` path
4. Scanner: **Plex Video Files Scanner**
5. Agent: **Personal Media** or **Local Media Assets**
6. **Scan library**

Re-run `npm run plex:sync` whenever playlists change in the vault.

## Where to put the channel plugin (optional / legacy)

User plugins belong in the **Plex data directory**, not inside the Plex program files:

| OS | Plug-ins folder |
|----|-----------------|
| Windows | `%LOCALAPPDATA%\Plex Media Server\Plug-ins\` |
| Linux | `/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Plug-ins/` |
| macOS | `~/Library/Application Support/Plex Media Server/Plug-ins/` |

**Do not** install into `Plex Media Server\Resources\Plug-ins-xxxxx\` — that folder is for Plex’s built-in bundles and updates can wipe it.

After copying `GitHubVault.bundle`:

1. Restart Plex Media Server
2. Configure under **Settings → Plugins → GitHub Vault** (if it appears)
3. Browse via **Plugins** in the sidebar (if your client still has it)

Check `Plex Media Server.log` for:

```
Scanning for plug-ins in "…/Plug-ins"
```

to confirm Plex is scanning the folder you used.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Settings → Plugins shows “No plugins installed” | Expected for channel plugins; use STRM sync instead |
| Playback fails | Ensure Plex server can reach your vault URL |
| Empty library after scan | Confirm `.strm` files exist and run **Scan library files** |
| SSL errors | Use HTTPS with a valid cert on the vault |
