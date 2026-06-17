# Future Vault

**Future Vault** is a local agent that runs on your Plex machine. It keeps your GitHub Vault library in sync, repairs Plex's database after restarts, maintains plugins, and caches catalog data so Plex still works when the remote vault server is offline.

```
┌─────────────────┐     sync (online)      ┌──────────────────┐
│  GitHub Vault   │ ◄────────────────────── │  Future Vault    │
│  (remote/cloud) │                         │  (localhost:7420)│
└─────────────────┘                         └────────┬─────────┘
        ▲                                            │
        │ fallback API                               │ STRM + sidecars
        │                                            │ DB repair
        └────────────────────────────────────────────┤
                                                     ▼
                                            ┌──────────────────┐
                                            │  Plex Media      │
                                            │  Server          │
                                            └──────────────────┘
```

## Quick start

### Native desktop app (recommended)

From the repo root:

```bash
npm run future-vault:install   # first time only
npm run future-vault:desktop
```

This opens **Future Vault** as a native app (Electron) with:

- System tray icon — stays running when you close the window
- Tray menu: Sync library, Repair Plex DB, Quit
- Single-instance — launching again focuses the existing app
- Built-in agent server on http://127.0.0.1:7420 (runs in a separate Node process so native modules like `better-sqlite3` work with Plex DB repair)

Build installers:

```bash
npm run future-vault:dist    # NSIS / DMG / AppImage in future-vault/dist/
```

### Headless agent (server only)

```bash
npm run future-vault
# or
npm run future-vault -- start
```

Open **http://127.0.0.1:7420** in a browser.

On first run, Future Vault creates:

- Config: `%LOCALAPPDATA%\Future Vault\config.json` (Windows)
- Cache: `%LOCALAPPDATA%\Future Vault\cache\`
- API key: `fv_…` (shown in terminal — paste into Plex plugin settings)

## Configure

1. Start Future Vault (`npm run future-vault`)
2. Open the dashboard → **Configuration**
3. Set **GitHub Vault URL** and **Vault API key** (`gv_…` from vault settings)
4. Set **Plex library folder** (e.g. `Plex Media Server\GitHub Vault`)
5. Optional: Plex token + section key for automatic library refresh
6. Click **Save settings**, then **Sync now**

Future Vault will:

- Pull `/api/plex/manifest` from GitHub Vault and write `.strm` + sidecars locally
- Cache hub/playlists/collections/continue for offline Plex channel browsing
- Repair Plex DB (`media_parts.file` → remote URLs) every 15s while broken
- Detect Plex restarts and re-repair after ~45s
- Keep GitHub Vault plugins installed with Future Vault prefs

## Plex plugin

The **GitHub Vault channel plugin** now talks to Future Vault first:

| Preference | Value |
|------------|--------|
| Future Vault Agent URL | `http://127.0.0.1:7420` |
| Future Vault API Key | `fv_…` from agent config |
| GitHub Vault URL | fallback when agent has no cache |
| GitHub Vault API Key | `gv_…` |

Run **Fix plugins** in the dashboard or `npm run plex:install-agent` after setting vault credentials.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run future-vault` | Start local agent + dashboard |
| `npm run future-vault:dev` | Start with file watch |
| `npm run plex:repair-db` | One-shot Plex DB repair (no agent) |

## Environment

| Variable | Default |
|----------|---------|
| `FUTURE_VAULT_PORT` | `7420` |
| `FUTURE_VAULT_DATA` | OS app data dir |
| `VAULT_URL` | Initial vault URL in config |
| `VAULT_API_KEY` | Initial vault API key |
| `PLEX_TOKEN` | Optional Plex token |

## API

Future Vault exposes GitHub Vault–compatible endpoints (Bearer `fv_…`):

- `GET /api/plex/hub`
- `GET /api/plex/playlists`
- `GET /api/plex/continue`
- `GET /health`

When GitHub Vault is offline, responses are served from local cache (`_stale: true` in JSON).
