# Windows Build Guide — GitHub Vault Sync

## Why the `winCodeSign` symlink error happens

electron-builder downloads `winCodeSign` (Azure Code Signing tools) when building Windows targets. The `winCodeSign-2.6.0.7z` archive contains macOS `.dylib` files with symbolic links inside. On Windows, extracting these symlinks requires **SeCreateSymbolicLinkPrivilege** — a privilege not granted to standard user accounts.

When `7z` tries to extract:
```
darwin/10.12/lib/libcrypto.dylib
darwin/10.12/lib/libssl.dylib
```
You get: `ERROR: Cannot create symbolic link : A required privilege is not held by the client`

## Quick Fix

```powershell
# 1. Clear corrupted cache
npm run cache:clean

# 2. Build unsigned unpacked (no installer, no signing)
npm run package:win:dir

# 3. Build unsigned installer
npm run package:win
```

If you still get the error:
```powershell
# Clear cache manually
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -ErrorAction SilentlyContinue

# Build again
npm run package:win
```

## Build Scripts

| Command | Output | Signing | Use case |
|---------|--------|---------|----------|
| `npm run dist:win:dir` | `release/win-unpacked/` | Unsigned | Local testing, portable |
| `npm run dist:win` | `release/GitHub Vault Sync Setup X.X.X.exe` | Unsigned | Dev installer |
| `npm run dist:win:signed` | `release/GitHub Vault Sync Setup X.X.X.exe` | Signed | Production release |
| `npm run cache:clean` | — | — | Clear corrupted caches |

Short aliases (same as above):
```
npm run package:win:dir   → unpacked
npm run package:win       → unsigned installer
```

## How unsigned builds work

The config in `package.json` (`build.win`) sets:
```json
{
  "win": {
    "sign": null,
    "signAndEditExecutable": false,
    "signDlls": false
  }
}
```

- `"sign": null` — disables code signing entirely. No `winCodeSign` download occurs.
- `CSC_IDENTITY_AUTO_DISCOVERY=false` — prevents electron-builder from hunting for code-signing certificates in the Windows certificate store.

The NSIS build still downloads `nsis` and `nsis-resources` (needed for the installer), but these are small (~2 MB total) and contain no symlinks.

## Enabling code signing for releases

When you have a valid code signing certificate:

1. Set the certificate SHA-1:
   ```powershell
   $env:CSC_KEY_PASSWORD = "your-pfx-password"
   $env:CSC_LINK = "path/to/certificate.pfx"
   ```

2. Update `package.json` build config:
   ```json
   "win": {
     "target": [{ "target": "nsis", "arch": ["x64"] }],
     "icon": "resources/icon.png",
     "sign": "./scripts/sign.js",
     "certificateFile": "path/to/cert.pfx",
     "certificatePassword": "%CSC_KEY_PASSWORD%"
   }
   ```

3. Build with signing:
   ```bash
   npm run dist:win:signed
   ```

4. You may need Windows Developer Mode enabled (Settings → Update & Security → For developers) for symlink creation during the sign tool extraction.

## Optional: Enable symlinks on Windows

If you want `winCodeSign` to extract normally:

**Option A:** Run terminal as Administrator
```
Right-click PowerShell → Run as Administrator
```

**Option B:** Enable Developer Mode
```
Settings → Update & Security → For developers → Developer Mode: On
```

**Option C:** Grant yourself symlink privilege
```powershell
# Requires admin
secedit /export /cfg secpol.cfg
# Add your user to SeCreateSymbolicLinkPrivilege in Local Security Policy
```

None of these are required for `npm run package:win` or `package:win:dir` — they only build unsigned packages.

## CI / GitHub Actions

Example workflow for unsigned Windows build:
```yaml
- name: Build Windows (unsigned)
  run: |
    npm ci
    npm run build
    npm run dist:win
  env:
    CSC_IDENTITY_AUTO_DISCOVERY: false
```

For signed production releases, add the certificate as a GitHub secret and use `dist:win:signed`.

## OneDrive Notes

If your project lives in a OneDrive folder (e.g. `OneDrive\Documents\GitHub\...`):

- **node_modules**: OneDrive may upload/download `node_modules` in the background, causing file locks during builds. Consider adding `node_modules/` to `.gitignore` (already done) and running `npm ci` fresh.
- **node-gyp**: Native modules like `better-sqlite3` compile `.node` binaries that OneDrive may sync as changed files. This is usually harmless.
- If you get `EPERM` or file-lock errors during build, move the project outside OneDrive.
