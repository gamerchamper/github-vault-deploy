const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const plexPatches = require('../../server/services/plex-patches');

describe('plex-agent-bundle', () => {
  const patchBundle = path.join(
    plexPatches.PATCHES_ROOT,
    'GitHubVaultAgent.bundle',
  );

  it('patch bundle passes structure and RestrictedPython validation', () => {
    const result = plexPatches.validateAgentBundle(patchBundle);
    assert.strictEqual(result.ok, true, JSON.stringify(result, null, 2));
    assert.strictEqual(result.python.ok, true, result.python.issues.join('; '));
    assert.strictEqual(result.structure.ok, true, result.structure.issues.join('; '));
  });

  it('rejects underscore function names like Plex RestrictedPython', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-agent-'));
    const bundleDir = path.join(tempRoot, 'BadAgent.bundle');
    const codeDir = path.join(bundleDir, 'Contents', 'Code');
    fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, '__init__.py'), 'def _bad():\n  pass\n', 'utf8');
    fs.writeFileSync(path.join(bundleDir, 'Contents', 'Info.plist'), '<plist></plist>', 'utf8');
    fs.writeFileSync(path.join(codeDir, 'vault_hook.py'), '# stub\n', 'utf8');
    fs.writeFileSync(path.join(bundleDir, 'Contents', 'DefaultPrefs.json'), '[]', 'utf8');

    const python = plexPatches.validateAgentPython(bundleDir);
    assert.strictEqual(python.ok, false);
    assert.match(python.issues[0], /def _\*/);
  });

  it('compareAgentBundleStructure requires Agent plugin class', () => {
    const structure = plexPatches.compareAgentBundleStructure(patchBundle);
    assert.strictEqual(structure.ok, true, structure.issues.join('; '));
  });
});
