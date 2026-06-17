#!/usr/bin/env node
/**
 * Standalone Plex plugin deploy — copies vault_hook.py bundles into
 * Plex's plugin directories without needing a running vault server.
 *
 * Usage:
 *   npm run plex:integrate
 *   node scripts/plex-integrate.js --no-patch  (skip LocalMedia patches)
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const os = require('os');

function parseArgs(argv) {
  const opts = { patchBundled: true };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-patch') opts.patchBundled = false;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function defaultPlexDataDir() {
  const localAppData = process.env.LOCALAPPDATA
    || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Plex Media Server');
}

function findBundledPluginsDir(plexDataDir) {
  const candidate = path.join(plexDataDir, '..', 'Plex Media Server', 'Resources');
  if (fs.existsSync(candidate)) {
    const entries = fs.readdirSync(candidate)
      .filter((e) => e.startsWith('Plug-ins-'))
      .map((e) => ({ name: e, path: path.join(candidate, e) }))
      .sort((a, b) => b.name.localeCompare(a.name));
    if (entries.length) return entries[0].path;
  }

  const repoBundled = path.join(
    __dirname, '..', 'Plex Media Server', 'Resources',
  );
  if (fs.existsSync(repoBundled)) {
    const entries = fs.readdirSync(repoBundled)
      .filter((e) => e.startsWith('Plug-ins-'))
      .map((e) => path.join(repoBundled, e))
      .sort((a, b) => b.localeCompare(a));
    if (entries.length) return entries[0];
  }

  return null;
}

function resolvePaths() {
  const plexDataDir = defaultPlexDataDir();
  return {
    plexDataDir,
    pluginsDir: path.join(plexDataDir, 'Plug-ins'),
    bundledPluginsDir: findBundledPluginsDir(plexDataDir),
  };
}

function deployUserPlugins(paths) {
  const sourceDir = path.join(
    __dirname, '..', 'integrate', 'plex', 'patches',
  );
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Plugin source not found: ${sourceDir}`);
  }

  fs.mkdirSync(paths.pluginsDir, { recursive: true });
  const deployed = [];

  for (const name of ['GitHubVaultAgent.bundle', 'GitHubVault.bundle']) {
    const src = path.join(sourceDir, name);
    if (!fs.existsSync(src)) {
      console.warn(`  Skip ${name} — not found in patches/`);
      continue;
    }
    const dest = path.join(paths.pluginsDir, name);
    copyDir(src, dest);
    deployed.push(name);
  }

  return deployed;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function patchLocalMediaBundle(bundledPluginsDir) {
  if (!bundledPluginsDir || !fs.existsSync(bundledPluginsDir)) {
    return { ok: false, error: `Bundled plugins dir not found: ${bundledPluginsDir || 'null'}` };
  }

  const localMediaDir = path.join(bundledPluginsDir, 'LocalMedia.bundle');
  if (!fs.existsSync(localMediaDir)) {
    return { ok: false, error: `LocalMedia.bundle not found in ${bundledPluginsDir}` };
  }

  const hooksFile = path.join(
    __dirname, '..', 'integrate', 'plex', 'localmedia-hooks.txt',
  );
  if (!fs.existsSync(hooksFile)) {
    return { ok: false, error: `localmedia-hooks.txt not found` };
  }

  const initFile = path.join(localMediaDir, 'Contents', 'Code', '__init__.py');
  const vaultHookSrc = path.join(
    __dirname, '..', 'integrate', 'plex', 'patches',
    'LocalMedia.bundle', 'Contents', 'Code', 'vault_hook.py',
  );
  const vaultHookDest = path.join(localMediaDir, 'Contents', 'Code', 'vault_hook.py');

  const steps = [];

  if (!fs.existsSync(initFile)) {
    return { ok: false, error: `LocalMedia __init__.py not found: ${initFile}` };
  }

  let init = fs.readFileSync(initFile, 'utf8');

  if (init.includes('import vault_hook')) {
    steps.push('vault_hook already injected in __init__.py');
  } else {
    const hooks = fs.readFileSync(hooksFile, 'utf8');
    const sections = parseHookSections(hooks);
    let patched = false;

    if (sections.PRELOAD) {
      const firstLine = init.split('\n')[0];
      init = init.replace(firstLine, `${firstLine}\n${sections.PRELOAD}`);
      patched = true;
    }

    if (sections.MOVIE_HOOK && sections.MOVIE_ANCHOR) {
      if (init.includes(sections.MOVIE_ANCHOR) && !init.includes('github_vault_hook.enrich_movie')) {
        init = init.replace(
          sections.MOVIE_ANCHOR,
          `${sections.MOVIE_ANCHOR}\n${sections.MOVIE_HOOK}`,
        );
        patched = true;
      }
    }

    if (sections.TV_HOOK && sections.TV_ANCHOR) {
      if (init.includes(sections.TV_ANCHOR) && !init.includes('github_vault_hook.enrich_tv')) {
        init = init.replace(
          sections.TV_ANCHOR,
          `${sections.TV_ANCHOR}\n${sections.TV_HOOK}`,
        );
        patched = true;
      }
    }

    if (patched) {
      fs.writeFileSync(initFile, init, 'utf8');
      steps.push('Injected vault_hook into LocalMedia __init__.py');
    } else {
      steps.push('LocalMedia __init__.py already patched or anchors not found');
    }
  }

  if (fs.existsSync(vaultHookSrc)) {
    const destDir = path.dirname(vaultHookDest);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(vaultHookSrc, vaultHookDest);
    steps.push(`Copied vault_hook.py to ${path.relative(bundledPluginsDir, vaultHookDest)}`);
  } else {
    steps.push(`vault_hook.py source not found: ${vaultHookSrc}`);
  }

  return { ok: true, steps };
}

function parseHookSections(hooksContent) {
  const sections = {};
  let current = null;
  for (const line of hooksContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# PRELOAD')) current = 'PRELOAD';
    else if (trimmed.startsWith('# MOVIE_HOOK')) current = 'MOVIE_HOOK';
    else if (trimmed.startsWith('# TV_HOOK')) current = 'TV_HOOK';
    else if (trimmed.startsWith('# MOVIE_ANCHOR')) {
      current = 'MOVIE_ANCHOR';
      sections.MOVIE_ANCHOR = trimmed.replace('# MOVIE_ANCHOR', '').trim();
    } else if (trimmed.startsWith('# TV_ANCHOR')) {
      current = 'TV_ANCHOR';
      sections.TV_ANCHOR = trimmed.replace('# TV_ANCHOR', '').trim();
    } else if (current && trimmed) {
      sections[current] = (sections[current] || '') + line + '\n';
    }
  }
  return sections;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(`Usage: npm run plex:integrate [--no-patch]\n`);
    console.log('Deploys GitHubVaultAgent and GitHubVault bundles to %LOCALAPPDATA%\\Plex Media Server\\Plug-ins');
    console.log('Optionally patches the LocalMedia.bundle to read .vault-item.json sidecars.');
    console.log('\nNo vault server or user required — this is a file-only deployment.');
    process.exit(0);
  }

  const paths = resolvePaths();

  console.log(`Plex data:    ${paths.plexDataDir}`);
  console.log(`Plugins:      ${paths.pluginsDir}`);
  console.log(`Bundled:      ${paths.bundledPluginsDir || '(not found)'}`);
  console.log('');

  const deployed = deployUserPlugins(paths);
  console.log(`Deployed ${deployed.length} bundle(s): ${deployed.join(', ')}`);

  if (opts.patchBundled && paths.bundledPluginsDir) {
    console.log('\nPatching LocalMedia.bundle...');
    const result = patchLocalMediaBundle(paths.bundledPluginsDir);
    if (result.ok) {
      for (const step of result.steps) {
        console.log(`  ${step}`);
      }
    } else {
      console.warn(`  Patch skipped: ${result.error}`);
    }
  }

  console.log('\nDone. Restart Plex Media Server to load updated plugins.');
  console.log('Then refresh metadata on your GitHub Vault library in Plex.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
