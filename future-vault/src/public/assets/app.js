let apiKey = localStorage.getItem('fv_api_key') || '';
let configFormDirty = false;

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && !options._retried) {
    const entered = prompt('Future Vault API key (shown in terminal on first start):');
    if (entered) {
      apiKey = entered.trim();
      localStorage.setItem('fv_api_key', apiKey);
      return api(path, { ...options, _retried: true });
    }
  }
  return res;
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function setRing(id, state) {
  const el = document.getElementById(id);
  if (el) el.dataset.state = state;
}

function renderStatus(data) {
  document.getElementById('agent-url').textContent = data.agent_url || '—';
  document.getElementById('api-key-display').textContent = data.api_key || '—';
  if (data.api_key && !apiKey) {
    apiKey = data.api_key;
    localStorage.setItem('fv_api_key', apiKey);
  }

  const playback = data.playback || {};
  const ready = playback.ready || 0;
  const total = playback.total_strm || 0;
  const needsRepair = playback.needs_repair || 0;

  document.getElementById('metric-strm').textContent = total ? `${ready}/${total}` : '—';
  document.getElementById('metric-playback-hint').textContent = needsRepair
    ? `${needsRepair} need repair`
    : 'All items playback-ready';

  document.getElementById('metric-sync').textContent = fmtTime(data.last_sync_at);
  document.getElementById('metric-sync-source').textContent = data.last_sync_source
    ? `Source: ${data.last_sync_source}${data.last_sync_error ? ' (cache)' : ''}`
    : (data.last_sync_error || 'Not synced yet');

  document.getElementById('metric-repair').textContent = fmtTime(data.last_repair_at);
  document.getElementById('metric-repair-hint').textContent = data.last_repair_ready != null
    ? `${data.last_repair_ready} ready in DB`
    : '—';

  document.getElementById('metric-interval').textContent = data.auto_sync
    ? `${data.sync_interval_minutes || 15} min`
    : 'Off';

  setRing('ring-vault', !data.vault_configured ? 'warn' : data.vault_online ? 'ok' : 'bad');
  setRing('ring-plex', data.plex_running === true ? 'ok' : data.plex_running === false ? 'bad' : 'warn');
  setRing('ring-playback', needsRepair === 0 && total > 0 ? 'ok' : needsRepair > 0 ? 'bad' : 'warn');

  if (needsRepair === 0 && total > 0) {
    document.getElementById('hero-title').textContent = 'Systems nominal';
    document.getElementById('hero-sub').textContent = 'Plex library DB is patched for remote streaming. Cached catalog available offline.';
  } else if (needsRepair > 0) {
    document.getElementById('hero-title').textContent = 'Repair recommended';
    document.getElementById('hero-sub').textContent = `${needsRepair} items still point at local .strm files — playback will fail until repaired.`;
  } else {
    document.getElementById('hero-title').textContent = 'Agent online';
    document.getElementById('hero-sub').textContent = 'Configure GitHub Vault URL to enable sync and offline cache.';
  }

  const form = document.getElementById('config-form');
  if (!configFormDirty) {
    if (form.vault_url) form.vault_url.value = data.vault_url || '';
    if (form.vault_api_key) form.vault_api_key.value = data.vault_api_key || '';
    if (form.plex_library_path) form.plex_library_path.value = data.plex_library_path || '';
    if (form.plex_server_url) form.plex_server_url.value = data.plex_server_url || '';
    if (form.plex_token) form.plex_token.value = data.plex_token || '';
    if (form.plex_section_key) form.plex_section_key.value = data.plex_section_key || '';
    if (form.sync_interval_minutes) form.sync_interval_minutes.value = data.sync_interval_minutes || 15;
    if (form.auto_sync) form.auto_sync.checked = data.auto_sync !== false;
    if (form.auto_repair) form.auto_repair.checked = data.auto_repair !== false;
    if (form.auto_plugin) form.auto_plugin.checked = data.auto_plugin !== false;
  }

  const feed = document.getElementById('event-feed');
  feed.innerHTML = '';
  for (const ev of (data.events || [])) {
    const li = document.createElement('li');
    li.innerHTML = `<time>${fmtTime(ev.at)}</time><span class="level-${ev.level}">${ev.message}</span>`;
    feed.appendChild(li);
  }
  if (!feed.children.length) {
    feed.innerHTML = '<li><span class="level-info">No events yet</span></li>';
  }
}

async function refresh() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    renderStatus(data);
  } catch (err) {
    document.getElementById('hero-title').textContent = 'Connection lost';
    document.getElementById('hero-sub').textContent = err.message;
  }
}

document.getElementById('btn-sync').addEventListener('click', async () => {
  const btn = document.getElementById('btn-sync');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    await api('/api/sync', { method: 'POST' });
    await refresh();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync now';
  }
});

document.getElementById('btn-repair').addEventListener('click', async () => {
  await api('/api/repair', { method: 'POST' });
  await refresh();
});

document.getElementById('btn-plugins').addEventListener('click', async () => {
  await api('/api/plugins', { method: 'POST' });
  await refresh();
});

document.getElementById('btn-copy-key').addEventListener('click', () => {
  const key = document.getElementById('api-key-display').textContent;
  navigator.clipboard.writeText(key).catch(() => {});
});

document.getElementById('config-form').addEventListener('input', () => {
  configFormDirty = true;
});

document.getElementById('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    vault_url: fd.get('vault_url'),
    vault_api_key: fd.get('vault_api_key'),
    plex_library_path: fd.get('plex_library_path'),
    plex_server_url: fd.get('plex_server_url'),
    plex_token: fd.get('plex_token'),
    plex_section_key: fd.get('plex_section_key'),
    sync_interval_minutes: Number(fd.get('sync_interval_minutes')) || 15,
    auto_sync: fd.get('auto_sync') === 'on',
    auto_repair: fd.get('auto_repair') === 'on',
    auto_plugin: fd.get('auto_plugin') === 'on',
  };

  const saveBtn = e.target.querySelector('button[type="submit"]');
  const prevLabel = saveBtn.textContent;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Save failed (${res.status})`);
    configFormDirty = false;
    saveBtn.textContent = 'Saved';
    await refresh();
  } catch (err) {
    saveBtn.textContent = 'Save failed';
    document.getElementById('hero-sub').textContent = err.message;
  } finally {
    setTimeout(() => {
      saveBtn.disabled = false;
      saveBtn.textContent = prevLabel;
    }, 1200);
  }
});

refresh();
let refreshTimer = null;

function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(refresh, 15000);
}

function stopRefreshTimer() {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopRefreshTimer();
  else {
    refresh();
    startRefreshTimer();
  }
});

startRefreshTimer();

window.__fvPauseDashboard = stopRefreshTimer;
window.__fvResumeDashboard = () => {
  refresh();
  startRefreshTimer();
};
