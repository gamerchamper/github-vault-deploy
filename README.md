# GitHub Vault

Distributed file storage across multiple GitHub repositories. Upload files, split them into chunks distributed across your repos, and download them reassembled — like a personal unlimited storage vault powered by GitHub.

## Features

- **GitHub OAuth** — Sign in with your GitHub account
- **Multi-repo storage** — Split files across multiple repositories for distributed storage
- **Chunk-based splitting** — Files are split into ~900KB chunks and round-robin distributed
- **Metadata tracking** — SQLite database tracks where every chunk lives
- **Torrent-like downloads** — Chunks are fetched from multiple repos and reassembled on download
- **Windows Explorer UI** — Familiar file manager interface with drag-and-drop upload

## Setup

### 1. Create a GitHub OAuth App

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click **New OAuth App**
3. Fill in:
   - **Application name**: GitHub Vault
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:3000/auth/github/callback`
4. Copy the **Client ID** and generate a **Client Secret**

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your GitHub OAuth credentials:

```
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
SESSION_SECRET=some_random_secret_string
APP_URL=http://localhost:3000
```

### 3. Install & Run

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

1. **Sign in** with your GitHub account
2. **Add storage repos** — Click "Repos" in the toolbar to add existing repos or create new private ones
3. **Upload files** — Drag and drop or click Upload; files are automatically split and distributed
4. **Browse** — Navigate folders like Windows Explorer
5. **Download** — Select files and click Download; chunks are fetched and reassembled

## How It Works

```
Upload:  file.bin → [chunk0, chunk1, chunk2, ...] → distributed across repos
         repo-A/.vault/chunks/{id}/00000.bin
         repo-B/.vault/chunks/{id}/00001.bin
         repo-C/.vault/chunks/{id}/00002.bin

Download: fetch all chunks by metadata → concatenate → original file
```

Metadata (file names, paths, chunk locations, SHAs) is stored locally in SQLite. Chunk data lives in your GitHub repos under `.vault/chunks/`.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CHUNK_SIZE` | 921600 (900KB) | Size of each chunk in bytes |
| `PORT` | 3000 | Server port |
| `APP_URL` | http://localhost:3000 | Must match OAuth callback base URL |

## Docker

Build and run with Docker Compose:

```bash
docker compose up -d
```

The server listens on `http://localhost:3000`. Data persists in a named volume (`vault-data`). Health checks run every 30s via `/health`.

## Desktop Client

The CLI upload client supports resumable chunked uploads, API key auth, and auto-retry on network failures.

```bash
npm run client:install
npm run client:help
npm run client:desktop  # Electron native window
npm run client:ui        # Browser fallback
```

**Packaging** (requires `npm run client:install` first):

```bash
npm run client:pack                    # Unpacked directory
npm run client:dist                    # Installer (.exe/.dmg/.AppImage)
```

## TypeScript Migration Plan

The codebase is plain JavaScript with no static type checking. A safe migration path:

1. Add JSDoc type annotations to function signatures (`@param`, `@returns`) — works with existing JS tooling
2. Add TypeScript as a dev dependency
3. Configure `tsconfig.json` with `allowJs: true` and `checkJs: false`
4. Add `tsc --noEmit` to a lint step for early feedback without affecting runtime
5. Convert files one at a time, starting with pure utility modules (no DB/IO dependencies)
6. Enable `strict: true` once all files are converted

**Estimated effort**: 2-3 weeks for full migration. Start with JSDoc annotations for immediate IDE benefits.

## MySQL Runtime

SQLite is the default storage backend. MySQL migration support exists but the server still uses synchronous SQLite calls at runtime. A full MySQL runtime requires:

1. Replace all synchronous `db.prepare().get|all|run` calls with async equivalents
2. All call sites must become `async/await` or use `.then()` callbacks
3. Files affected: `storage.js`, `tasks.js`, `metadata.js`, `accounts.js`, `file routes`, `repo routes`, and others
4. Use the existing `server/db/mysql.js` connection pool for queries
5. Add an `async` wrapper module at `server/db/database.js` that exports both sync (SQLite) and async (MySQL) methods

**Estimated effort**: 3-5 days. Start with the `tasks.js` and `accounts.js` modules which have the fewest DB calls.

## Session Secret Rotation

Session cookies are managed by `cookie-session` middleware. To support secret rotation without invalidating all sessions:

1. Update the middleware to pass an array of keys: `keys: [currentSecret, oldSecret]`
2. When rotating secrets, keep the old secret in the array for the cookie's TTL (7 days)
3. After 7 days, remove the old secret from the array
4. New cookies are signed with `keys[0]`; old cookies are accepted if they match `keys[1]`

```js
// server/index.js
const secrets = [process.env.SESSION_SECRET];
const oldSecret = process.env.SESSION_SECRET_OLD;
if (oldSecret) secrets.push(oldSecret);
app.use(cookieSession({ keys: secrets, ... }));
```
