const fs = require('fs');
const path = require('path');
const plexPatches = require('./plex-patches');
const plexStreamTest = require('./plex-stream-test');
const db = require('../db/database');

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function checkPlugins(paths) {
  const bundledVaultHook = path.join(
    paths.bundledPluginsDir || '',
    'LocalMedia.bundle',
    'Contents',
    'Code',
    'vault_hook.py',
  );
  const userAgent = path.join(paths.pluginsDir, 'GitHubVaultAgent.bundle');
  const userVaultHook = path.join(userAgent, 'Contents', 'Code', 'vault_hook.py');
  const localMediaInit = path.join(
    paths.bundledPluginsDir || '',
    'LocalMedia.bundle',
    'Contents',
    'Code',
    '__init__.py',
  );

  let localMediaHookInjected = false;
  if (fileExists(localMediaInit)) {
    try {
      const content = fs.readFileSync(localMediaInit, 'utf8');
      localMediaHookInjected = content.includes('[GitHub Vault hook]');
    } catch {
      localMediaHookInjected = false;
    }
  }

  return {
    github_vault_agent_installed: fileExists(userAgent),
    github_vault_hook_present: fileExists(userVaultHook),
    bundled_vault_hook_present: fileExists(bundledVaultHook),
    localmedia_hook_injected: localMediaHookInjected,
    bundled_plugins_dir: paths.bundledPluginsDir,
    plugins_dir: paths.pluginsDir,
  };
}

function checkLibrarySidecars(libraryPath) {
  if (!libraryPath || !fileExists(libraryPath)) {
    return { library_exists: false, strm_count: 0, sidecar_count: 0, sample: null };
  }

  let strmCount = 0;
  let sidecarCount = 0;
  let sample = null;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.strm')) {
        strmCount += 1;
        if (!sample) {
          const sidecarPath = full.replace(/\.strm$/i, '.vault-item.json');
          let sidecar = null;
          if (fileExists(sidecarPath)) {
            sidecarCount += 1;
            try {
              sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
            } catch {
              sidecar = { parse_error: true };
            }
          }
          sample = {
            strm: full,
            sidecar_path: sidecarPath,
            sidecar_exists: fileExists(sidecarPath),
            sidecar,
          };
        }
      } else if (entry.name.endsWith('.vault-item.json')) {
        sidecarCount += 1;
      }
    }
  };

  for (const sub of ['Playlists', 'Collections', 'Continue Watching']) {
    const subPath = path.join(libraryPath, sub);
    if (fileExists(subPath)) walk(subPath);
  }

  return {
    library_exists: true,
    library_path: libraryPath,
    strm_count: strmCount,
    sidecar_count: sidecarCount,
    sample,
  };
}

async function verifyIntegration(userId, req, { fileId = null, libraryPath = null } = {}) {
  const paths = plexPatches.resolvePaths();
  const plugins = checkPlugins(paths);
  const library = checkLibrarySidecars(libraryPath || paths.libraryPath);

  const issues = [];
  if (!plugins.github_vault_agent_installed) {
    issues.push('GitHubVaultAgent.bundle is not installed in Plex Plug-ins — run Integrate or copy from integrate/plex/patches');
  }
  if (!plugins.localmedia_hook_injected) {
    issues.push('LocalMedia hook not injected — re-run Integrate with patch_bundled enabled, then restart Plex');
  }
  if (library.library_exists && library.strm_count > 0 && library.sidecar_count < library.strm_count) {
    issues.push('Some STRM files are missing .vault-item.json sidecars — re-sync from GitHub Vault');
  }
  if (library.sample?.sidecar_exists && !library.sample.sidecar?.container) {
    issues.push('Sidecar missing container field — refresh manifest and re-write STRM files');
  }

  let streamTest = null;
  const testFileId = fileId || library.sample?.sidecar?.file_id;
  if (testFileId) {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(testFileId, userId);
    if (file && !file.is_folder) {
      streamTest = await plexStreamTest.testStreamForPlex(userId, file, req);
      if (!streamTest.plex_ready) {
        issues.push(`Stream not Plex-ready: ${streamTest.issues.join('; ')}`);
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    plugins,
    library,
    stream_test: streamTest,
    next_steps: [
      'Confirm plugin log shows "[GitHub Vault] metadata agent loaded" (not the main Plex Media Server.log)',
      'Settings → Manage → Plugins — GitHub Vault should be listed',
      'Library → ⋯ → Manage Library → Edit → Advanced → Agent → choose "GitHub Vault" (legacy UI, not cloud providers)',
      'Or run: PLEX_TOKEN=... npm run plex:install-agent — or npm run plex:test-agent -- --apply',
      'Re-sync STRM files — sync writes sidecars, injects stream metadata into Plex DB, and applies episode thumbnails via Plex API',
      'Restart Plex Media Server after sync, then retry playback',
    ],
  };
}

module.exports = {
  verifyIntegration,
  checkPlugins,
  checkLibrarySidecars,
};
