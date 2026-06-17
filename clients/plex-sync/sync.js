#!/usr/bin/env node
/**
 * Sync GitHub Vault playlists/collections to a Plex-scannable STRM library folder.
 *
 * Usage:
 *   node clients/plex-sync/sync.js --url https://vault.example.com --key gv_xxx --out "D:/Plex/Vault"
 *   node clients/plex-sync/sync.js --config clients/plex-sync/config.json
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_OUT = path.join(process.cwd(), 'plex-vault-library');

function parseArgs(argv) {
  const opts = { prune: true };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config' && argv[i + 1]) {
      Object.assign(opts, JSON.parse(fs.readFileSync(argv[++i], 'utf8')));
    } else if (arg === '--url' && argv[i + 1]) {
      opts.url = argv[++i];
    } else if (arg === '--key' && argv[i + 1]) {
      opts.apiKey = argv[++i];
    } else if ((arg === '--out' || arg === '--output') && argv[i + 1]) {
      opts.output = argv[++i];
    } else if (arg === '--agent-url' && argv[i + 1]) {
      opts.agentUrl = argv[++i];
    } else if (arg === '--no-prune') {
      opts.prune = false;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`GitHub Vault → Plex STRM sync

Creates .strm pointer files Plex can scan as an "Other Videos" library.

Options:
  --url URL          Vault base URL (https://vault.example.com)
  --key gv_…         Vault API key
  --out PATH         Output folder (default: ./plex-vault-library)
  --config FILE      JSON config with url, apiKey, output, prune
  --agent-url URL    Future Vault agent URL for local routing (http://127.0.0.1:7420)
  --no-prune         Do not delete removed STRM files
  --help             Show this help

Example:
  node clients/plex-sync/sync.js --url https://vault.arktic.top --key gv_xxx --out "D:/Plex/Vault" --agent-url http://127.0.0.1:7420

With --agent-url, STRM files point to the local agent instead of the vault server directly.
The agent serves HLS playlists from GitHub raw (free) and proxies MP4 streams to vault.
`);

function safeName(name, max = 140) {
  return String(name || 'Untitled')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || 'Untitled';
}

async function vaultFetch(baseUrl, apiKey, apiPath) {
  const url = `${baseUrl.replace(/\/+$/, '')}${apiPath}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const body = await res.text();
  let data;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${body.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} for ${url}`);
  }
  return data;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeStrm(filePath, streamUrl) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${streamUrl}\n`, 'utf8');
}

function isVaultServerUrl(url) {
  return /\/api\/files\/(stream|hls)\//.test(url);
}

function rewriteToAgent(vaultUrl, agentUrl) {
  const fileMatch = String(vaultUrl).match(/\/api\/files\/(stream|hls)\/([^/?]+)/);
  if (!fileMatch) return vaultUrl;
  const fileId = fileMatch[2];

  if (vaultUrl.includes('/hls/')) {
    return `${agentUrl}/api/m3u8/${fileId}`;
  }

  const nameMatch = String(vaultUrl).match(/\/api\/files\/stream\/[^/]+\/([^?]+)/);
  const fileName = nameMatch ? decodeURIComponent(nameMatch[1]) : 'stream';
  return `${agentUrl}/api/stream/${fileId}/${encodeURIComponent(fileName)}`;
}

function resolveStreamUrl(item, agentUrl) {
  const raw = item.strm_url || item.hls_url || item.stream_url;
  if (agentUrl && isVaultServerUrl(raw)) {
    return rewriteToAgent(raw, agentUrl);
  }
  return raw;
}

function padIndex(n) {
  return String(n).padStart(2, '0');
}

async function syncPlaylist(baseUrl, apiKey, playlistId, outDir, manifest, stats, agentUrl) {
  const playlist = await vaultFetch(baseUrl, apiKey, `/api/plex/playlists/${encodeURIComponent(playlistId)}`);
  ensureDir(outDir);

  const items = playlist.items || [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const title = safeName(item.title || item.id);
    const fileName = `${padIndex(i + 1)} - ${title}.strm`;
    const filePath = path.join(outDir, fileName);
    writeStrm(filePath, resolveStreamUrl(item, agentUrl));
    manifest.files.push(path.relative(manifest.root, filePath));
    stats.files += 1;
  }
  stats.playlists += 1;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }

  const baseUrl = opts.url || opts.vaultUrl;
  const apiKey = opts.apiKey || opts.key;
  const output = path.resolve(opts.output || opts.out || DEFAULT_OUT);
  const agentUrl = opts.agentUrl || null;

  if (!baseUrl || !apiKey) {
    printHelp();
    process.exit(1);
  }

  if (agentUrl) {
    console.log(`Agent URL: ${agentUrl} (STRM files will route through local agent)`);
  }

  ensureDir(output);
  const manifest = {
    root: output,
    vault_url: baseUrl.replace(/\/+$/, ''),
    synced_at: new Date().toISOString(),
    files: [],
  };
  const stats = { playlists: 0, collections: 0, files: 0 };

  console.log(`Syncing from ${baseUrl} → ${output}`);

  const hub = await vaultFetch(baseUrl, apiKey, '/api/plex/hub');

  const playlistsDir = path.join(output, 'Playlists');
  for (const playlist of hub.playlists || []) {
    const dir = path.join(playlistsDir, safeName(playlist.title));
    await syncPlaylist(baseUrl, apiKey, playlist.id, dir, manifest, stats, agentUrl);
    console.log(`  Playlist: ${playlist.title} (${playlist.item_count || '?'} items)`);
  }

  const collectionsDir = path.join(output, 'Collections');
  for (const collection of hub.collections || []) {
    const col = await vaultFetch(baseUrl, apiKey, `/api/plex/collections/${encodeURIComponent(collection.id)}`);
    const colDir = path.join(collectionsDir, safeName(col.title));
    for (const playlist of col.playlists || []) {
      const dir = path.join(colDir, safeName(playlist.title));
      await syncPlaylist(baseUrl, apiKey, playlist.id, dir, manifest, stats, agentUrl);
      console.log(`  Collection: ${col.title} / ${playlist.title}`);
    }
    stats.collections += 1;
  }

  const continueDir = path.join(output, 'Continue Watching');
  const continueItems = await vaultFetch(baseUrl, apiKey, '/api/plex/continue');
  if (continueItems.items?.length) {
    ensureDir(continueDir);
    for (let i = 0; i < continueItems.items.length; i += 1) {
      const item = continueItems.items[i];
      const label = item.playlist_title
        ? `${item.playlist_title} - ${item.title}`
        : item.title;
      const fileName = `${padIndex(i + 1)} - ${safeName(label)}.strm`;
      const filePath = path.join(continueDir, fileName);
      writeStrm(filePath, resolveStreamUrl(item, agentUrl));
      manifest.files.push(path.relative(manifest.root, filePath));
      stats.files += 1;
    }
    console.log(`  Continue watching: ${continueItems.items.length} items`);
  }

  fs.writeFileSync(
    path.join(output, '.vault-plex-sync.json'),
    `${JSON.stringify({ ...manifest, stats }, null, 2)}\n`,
    'utf8',
  );

  fs.writeFileSync(
    path.join(output, 'README.txt'),
    `GitHub Vault Plex library (STRM files)\n\n`
    + `Do not delete this folder manually while Plex is scanning.\n`
    + `Re-run sync to refresh after vault playlist changes:\n\n`
    + `  npm run plex:sync -- --url ${baseUrl} --key YOUR_KEY --out "${output}"\n\n`
    + `Last sync: ${manifest.synced_at}\n`,
    'utf8',
  );

  if (opts.prune !== false) {
    const keep = new Set(manifest.files.map((f) => path.normalize(f)));
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.strm')) {
          const rel = path.normalize(path.relative(output, full));
          if (!keep.has(rel)) {
            fs.unlinkSync(full);
            console.log(`  Pruned: ${rel}`);
          }
        }
      }
    };
    for (const sub of ['Playlists', 'Collections', 'Continue Watching']) {
      const subPath = path.join(output, sub);
      if (fs.existsSync(subPath)) walk(subPath);
    }
  }

  console.log(`Done — ${stats.files} STRM files, ${stats.playlists} playlists, ${stats.collections} collections`);
  console.log(`Add "${output}" as an Other Videos library in Plex, then scan.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
