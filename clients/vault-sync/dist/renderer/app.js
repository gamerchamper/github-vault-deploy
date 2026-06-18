// @ts-nocheck
// GitHub Vault Sync — Renderer UI
// vaultSync API is exposed by preload script via contextBridge
// Functions reference window.vaultSync which Electron's contextBridge maps to the global scope

function $(id) { return document.getElementById(id); }

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('nav button').forEach(function(b) {
    if (b.getAttribute('data-tab') === name) b.classList.add('active');
    else b.classList.remove('active');
  });
  var tab = document.getElementById('tab-' + name);
  if (tab) tab.classList.add('active');
  if (name === 'queue') refreshQueue();
}

var logs = [];

function updateStatusBar(state) {
  var dot = $('status-dot');
  var text = $('status-text');
  var last = $('last-sync');
  if (dot) { dot.className = 'status-dot ' + (state.status === 'syncing' ? 'syncing' : state.status === 'error' || state.status === 'offline' ? 'error' : 'synced'); }
  if (text) text.textContent = state.status === 'idle' ? 'Synced' : state.status;
  if (last) last.textContent = state.lastSyncAt ? 'Last sync: ' + new Date(state.lastSyncAt).toLocaleTimeString() : '';
}

function updateStats(state) {
  setText('stat-total', String(state.totalFiles));
  setText('stat-uploading', String(state.pendingUploads));
  setText('stat-conflicts', String(state.conflictCount));
}

function updateSettingsUI(settings) {
  setText('sync-folder-path', settings.syncRootPath || 'Not configured');
  setText('server-url-display', settings.serverUrl || 'Not connected');
  var inputUrl = $('input-server-url');
  var inputKey = $('input-api-key');
  var inputRoot = $('input-sync-root');
  if (inputUrl && !inputUrl.value) inputUrl.value = settings.serverUrl;
  if (inputKey && !inputKey.value) inputKey.value = settings.apiKey;
  if (inputRoot) inputRoot.value = settings.syncRootPath;
}

function setText(id, text) {
  var el = $(id);
  if (el) el.textContent = text;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function refreshUI() {
  try {
    var settings = await window.vaultSync.getSettings();
    var state = await window.vaultSync.getSyncState();
    updateStatusBar(state);
    updateStats(state);
    updateSettingsUI(settings);
  } catch (err) { console.error('refreshUI:', err); }
}

async function saveServerSettings() {
  var url = ($('input-server-url') || {}).value || '';
  var key = ($('input-api-key') || {}).value || '';
  url = (url || '').trim();
  key = (key || '').trim();
  if (!url || !key) { alert('Enter both Server URL and API Key'); return; }
  await window.vaultSync.updateSettings({ serverUrl: url, apiKey: key });
  setText('conn-status', 'Saved. Testing...');
  var result = await window.vaultSync.testConnection(url, key);
  setText('conn-status', result.ok ? '\u2713 Connected' : '\u2717 ' + (result.error || 'Connection failed'));
  await refreshUI();
}

async function testConnection() {
  var url = ($('input-server-url') || {}).value || '';
  var key = ($('input-api-key') || {}).value || '';
  url = (url || '').trim();
  key = (key || '').trim();
  if (!url || !key) { alert('Enter Server URL and API Key first'); return; }
  setText('conn-status', 'Testing...');
  var result = await window.vaultSync.testConnection(url, key);
  setText('conn-status', result.ok ? '\u2713 Connected' : '\u2717 ' + (result.error || 'Connection failed'));
}

async function browseSyncFolder() {
  var folder = await window.vaultSync.pickFolder();
  if (folder) {
    var input = $('input-sync-root');
    if (input) input.value = folder;
    await window.vaultSync.updateSettings({ syncRootPath: folder });
    setText('sync-folder-path', folder);
  }
}

async function openSyncFolder() {
  var settings = await window.vaultSync.getSettings();
  if (settings.syncRootPath) {
    window.vaultSync.openFolder(settings.syncRootPath);
  }
}

async function refreshQueue() {
  var tbody = document.querySelector('#queue-table tbody');
  if (!tbody) return;
  var entries = [];
  try { entries = await window.vaultSync.getQueue(); } catch (err) { entries = []; }
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text2)">No pending uploads</td></tr>';
    return;
  }
  tbody.innerHTML = entries.map(function(e) {
    var badgeClass = e.status === 'done' ? 'badge-synced' : e.status === 'uploading' || e.status === 'hashing' ? 'badge-uploading' : e.status === 'error' ? 'badge-error' : 'badge-pending';
    return '<tr><td>' + escapeHtml(e.localRelPath) + '</td><td><span class="badge ' + badgeClass + '">' + e.status + '</span>' + (e.error ? ' - ' + escapeHtml(e.error) : '') + '</td><td>' + e.percent + '%</td></tr>';
  }).join('');
}

window.vaultSync.onSyncState(function(state) {
  updateStatusBar(state);
  updateStats(state);
});

window.vaultSync.onUploadProgress(function() {
  if ((document.getElementById('tab-queue') || {}).classList && document.getElementById('tab-queue').classList.contains('active')) {
    refreshQueue();
  }
});

window.vaultSync.onLog(function(logEntry) {
  logs.unshift(logEntry);
  if (logs.length > 200) logs.pop();
  var container = $('log-container');
  if (container) {
    container.innerHTML = logs.map(function(entry) {
      return '<div class="log-entry ' + entry.level + '">[' + (entry.time || '').slice(11, 19) + '] ' + entry.category + ': ' + escapeHtml(entry.message) + '</div>';
    }).join('');
  }
});

refreshUI();
setInterval(refreshUI, 5000);
