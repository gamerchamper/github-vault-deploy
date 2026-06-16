# GitHub Vault → Plex

## Recommended: full integration

**Settings → Integrate with Plex** in the vault web app, or:

```bash
PLEX_TOKEN=your_token npm run plex:integrate
```

This patches Plex bundled plugins, installs vault agents, creates the library, and syncs automatically. See `integrate/plex/README.md`.

---

## Manual CLI sync (fallback)

```bash
npm run plex:sync -- --url https://vault.example.com --key gv_xxx --out "D:/Plex/GitHub Vault"
```

Use only when vault and Plex run on different machines.
