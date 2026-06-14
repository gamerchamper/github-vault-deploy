const http = require('http');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { VaultApi } = require('./api');
const { UploadEngine, DEFAULT_CONCURRENCY } = require('./upload-engine');
const { SeamlessUploadEngine } = require('./seamless-upload');
const { SessionStore } = require('./session-store');
const configStore = require('./config');
const pkg = require('../package.json');

const UI_BUILD = 'seamless-panel-1';

const jobs = new Map();

const API_CACHE = 'private, no-cache, must-revalidate';
const HTML_CACHE = 'no-cache, must-revalidate';

function responseHeaders(extra = {}) {
  const { cacheControl, ...rest } = extra;
  return {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': cacheControl || API_CACHE,
    ...rest,
  };
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, responseHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  }));
  res.end(data);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function safeConfig(config, includeSecret = false) {
  const activeId = configStore.activeServerId(config);
  const safe = {
    serverUrl: config.serverUrl || '',
    hasCookie: !!config.cookie,
    hasApiKey: !!config.apiKey,
    cookiePreview: config.cookie ? `${config.cookie.slice(0, 18)}...` : '',
    apiKeyPreview: config.apiKey ? `${config.apiKey.slice(0, 12)}...` : '',
    activeServerId: activeId,
    serverHistory: configStore.safeServerHistory(config, includeSecret),
  };
  if (includeSecret) {
    safe.cookie = config.cookie || '';
    safe.apiKey = config.apiKey || '';
  }
  return safe;
}

function applyConfigBody(config, body) {
  if (body.serverUrl !== undefined) {
    config.serverUrl = configStore.normalizeServerUrl(body.serverUrl);
  }
  if (body.apiKey !== undefined) config.apiKey = String(body.apiKey || '').trim();
  if (body.cookie !== undefined) config.cookie = String(body.cookie || '').trim();
  if (config.apiKey && config.cookie) config.cookie = '';
}

async function saveAndCheckConfig(config) {
  if (config.serverUrl && (config.apiKey || config.cookie)) {
    config.serverHistory = configStore.addToServerHistory(config);
  }
  configStore.save(config);
  const api = new VaultApi(config.serverUrl, { cookie: config.cookie, apiKey: config.apiKey });
  const ok = await api.checkAuth().catch(() => false);
  let localUpload = null;
  if (ok) {
    try {
      const stats = await api.stats();
      localUpload = stats.localUpload || null;
    } catch {
      // optional
    }
  }
  return { config, authenticated: ok, localUpload };
}

function getApi() {
  const config = configStore.load();
  if (!config.serverUrl) throw new Error('Server URL is not configured');
  if (!config.cookie && !config.apiKey) throw new Error('API key or session cookie is not configured');
  return new VaultApi(config.serverUrl, { cookie: config.cookie, apiKey: config.apiKey });
}

function serializeSession(session) {
  if (!session) return null;
  return {
    taskId: session.taskId,
    fileId: session.fileId,
    fileName: session.fileName,
    filePath: session.filePath,
    fileSize: session.fileSize,
    parentPath: session.parentPath,
    chunkSize: session.chunkSize,
    uploadMode: session.uploadMode,
    convertHls: session.convertHls,
    totalParts: session.totalParts,
    partSize: session.partSize,
    totalChunks: session.totalChunks,
    chunksDone: session.chunksDone,
    status: session.status,
    error: session.error,
    createdAt: session.createdAt,
  };
}

function createJob(taskId, engine, filePath) {
  const job = {
    taskId,
    filePath,
    status: 'starting',
    logs: [],
    progress: { chunksDone: 0, totalChunks: 0, percent: 0, bytesUploaded: 0, speed: 0, eta: 0 },
    result: null,
    error: null,
    startedAt: Date.now(),
  };
  jobs.set(taskId, job);
  engine.onProgress = (progress) => { job.progress = progress; };
  engine.onLog = (message) => {
    job.logs.push({ at: Date.now(), message });
    if (job.logs.length > 200) job.logs.shift();
  };
  return job;
}

async function startUpload(body) {
  const api = getApi();
  const filePath = path.resolve(String(body.filePath || ''));
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const isSeamless = body.mode === 'seamless';
  const taskId = body.resumeTaskId || SessionStore.generateTaskId();

  if (isSeamless) {
    const engine = new SeamlessUploadEngine(api, {
      concurrency: parseInt(body.concurrency, 10) || undefined,
      chunkSize: parseInt(body.chunkSize, 10) || 0,
      convertHls: !!body.convertHls,
    });
    const job = createJob(taskId, engine, filePath);

    Promise.resolve().then(async () => {
      try {
        job.status = 'initializing';
        if (body.resumeTaskId) {
          await engine.resumeSession(body.resumeTaskId);
        } else {
          await engine.initSession(filePath, body.parentPath || '/', taskId);
        }
        job.status = 'uploading';
        job.progress = { ...job.progress, phase: 'receiving' };
        const result = await engine.uploadAll();
        job.result = result;
        job.status = 'done';
      } catch (err) {
        job.status = 'error';
        job.error = err.message;
      }
    });

    return { taskId, job };
  }

  const engine = new UploadEngine(api, {
    concurrency: parseInt(body.concurrency, 10) || DEFAULT_CONCURRENCY,
    chunkSize: parseInt(body.chunkSize, 10) || 0,
    uploadMode: body.mode === 'git' ? 'git' : 'api',
    convertHls: !!body.convertHls,
  });

  const job = createJob(taskId, engine, filePath);

  Promise.resolve().then(async () => {
    try {
      job.status = 'initializing';
      const init = body.resumeTaskId
        ? await engine.resumeSession(body.resumeTaskId)
        : await engine.initSession(filePath, body.parentPath || '/', null, taskId);
      job.status = 'uploading';
      job.progress = {
        ...job.progress,
        chunksDone: init.chunksDone || 0,
        totalChunks: init.totalChunks || 0,
        percent: init.totalChunks ? Math.round(((init.chunksDone || 0) / init.totalChunks) * 100) : 0,
      };
      const result = await engine.uploadAll();
      job.result = result;
      job.status = result ? 'done' : 'paused';
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
    }
  });

  return { taskId, job };
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'">
<title>Vault Upload</title>
<style>
:root{color-scheme:dark;--bg-primary:#0b0d14;--bg-secondary:#11141f;--bg-hover:#1a244533;--border:#1e2440;--text-primary:#e8ecf7;--text-secondary:#9aa4c0;--text-muted:#5e6888;--accent:#5b8cf7;--accent-hover:#7ba5ff;--accent-glow:rgba(91,140,247,.15);--danger:#f85b6f;--success:#42e6a0;--warning:#f7b84f;--glass-bg:rgba(13,15,26,.82);--glass-border:rgba(255,255,255,.06);--radius:10px;--font:'Segoe UI Variable','Segoe UI',system-ui,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font);background:var(--bg-primary);color:var(--text-primary);min-height:100vh;overflow-x:hidden;font-size:12px}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 60% 60% at 20% 10%,rgba(91,140,247,.04) 0%,transparent 70%),radial-gradient(ellipse 50% 50% at 85% 90%,rgba(66,230,160,.03) 0%,transparent 60%);pointer-events:none;z-index:0}
.app{position:relative;z-index:1;min-height:100vh;display:flex;flex-direction:column}
.title-bar{display:flex;align-items:center;justify-content:space-between;height:38px;padding:0 12px;background:var(--glass-bg);border-bottom:1px solid var(--glass-border);backdrop-filter:blur(16px)}
.title-bar-left,.title-bar-right{display:flex;align-items:center;gap:8px}
.title-bar-left{font-weight:600;font-size:12px}
.app-icon{color:var(--accent);flex-shrink:0}
.auth-label{color:var(--text-secondary);font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;background:var(--warning);flex-shrink:0}
.dot.done{background:var(--success)}.dot.error{background:var(--danger)}
.chip{font-size:10px;padding:3px 8px;border-radius:999px;border:1px solid var(--border);color:var(--text-muted);background:var(--bg-secondary)}
.chip.good{color:var(--success);border-color:rgba(66,230,160,.35)}.chip.bad{color:var(--danger);border-color:rgba(248,91,111,.35)}.chip.busy{color:var(--warning);border-color:rgba(247,184,79,.35)}
.ribbon{display:flex;align-items:center;gap:4px;padding:6px 10px;background:var(--glass-bg);border-bottom:1px solid var(--glass-border);flex-wrap:wrap}
.ribbon-btn{display:flex;align-items:center;gap:5px;padding:5px 10px;background:none;border:1px solid transparent;border-radius:var(--radius);cursor:pointer;font-size:11px;color:var(--text-primary);font-family:var(--font)}
.ribbon-btn:hover:not(:disabled){background:var(--bg-hover);border-color:var(--border)}
.ribbon-btn-seamless{color:var(--accent);border-color:rgba(91,140,247,.45);background:rgba(91,140,247,.08)}
.ribbon-btn-seamless:hover:not(:disabled){border-color:rgba(91,140,247,.65);background:rgba(91,140,247,.14)}
.ribbon-btn:disabled{opacity:.45;cursor:not-allowed}
.ribbon-sep{width:1px;height:22px;background:var(--border);margin:0 4px}
.layout{display:grid;grid-template-columns:300px 1fr;gap:10px;padding:10px;flex:1;align-items:start}
.panel{background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--radius);overflow:hidden}
.panel-hd{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--border);background:rgba(0,0,0,.12)}
.panel-hd h2{font-size:12px;font-weight:600}
.panel-bd{padding:10px}
.stack{display:grid;gap:8px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.row-compact{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center}
.label{display:block;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
input,select{width:100%;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);border-radius:6px;padding:6px 8px;font-size:12px;font-family:var(--font);outline:none}
input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-glow)}
input[type=checkbox]{width:auto;margin-right:6px}
.btn-primary,.btn-secondary,.btn-ghost,.btn-danger{padding:6px 10px;border-radius:6px;font-size:11px;font-family:var(--font);cursor:pointer;border:1px solid transparent}
.btn-primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn-primary:hover:not(:disabled){background:var(--accent-hover)}
.btn-secondary{background:var(--bg-secondary);color:var(--text-primary);border-color:var(--border)}
.btn-secondary:hover:not(:disabled){background:var(--bg-hover)}
.btn-ghost{background:none;color:var(--text-muted);border-color:transparent}
.btn-ghost:hover:not(:disabled){color:var(--danger)}
.btn-danger{background:none;color:var(--danger);border-color:rgba(248,91,111,.45)}
.btn-sm{padding:5px 8px;font-size:10px}
button:disabled{opacity:.45;cursor:not-allowed}
.main{display:grid;gap:10px;min-width:0}
.split{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.metric-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.metric{padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-primary)}
.metric .label{margin-bottom:2px}
.metric b{display:block;font-size:14px;font-weight:600}
.bar{height:6px;border-radius:999px;background:var(--bg-primary);border:1px solid var(--border);overflow:hidden;margin-top:8px}
.fill{height:100%;width:0;background:linear-gradient(90deg,var(--accent),#42e6a0);transition:width .25s ease}
.list{display:grid;gap:6px;max-height:220px;overflow:auto}
.item{border:1px solid var(--border);background:var(--bg-primary);border-radius:6px;padding:8px;font-size:11px}
.item strong{display:block;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .actions{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.muted{color:var(--text-muted);font-size:10px;line-height:1.4}
.logs{font-family:ui-monospace,Consolas,monospace;font-size:10px;white-space:pre-wrap;max-height:140px;overflow:auto;color:var(--text-secondary);background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;padding:8px}
.details-block{border:1px solid var(--border);border-radius:6px;background:var(--bg-primary)}
.details-block summary{padding:7px 8px;cursor:pointer;color:var(--text-secondary);font-size:11px;list-style:none}
.details-block summary::-webkit-details-marker{display:none}
.details-block .details-body{padding:0 8px 8px;display:grid;gap:8px}
.feedback-box{border:1px solid var(--border);background:var(--bg-primary);border-radius:6px;padding:8px;color:var(--text-muted);font-size:10px}
.feedback-box strong{color:var(--text-primary);font-size:11px}
.local-upload-badge{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border-radius:999px;font-size:10px;font-weight:600;line-height:1.2}
.local-upload-badge.hidden{display:none}
.local-upload-badge.on{color:#0d7a3f;background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.35)}
.local-upload-badge.suggest{color:var(--text-muted);background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.22);font-weight:500}
.local-upload-badge.suggest a{color:var(--accent);text-decoration:none}
.plan-summary{display:grid;gap:4px;font-size:11px}
.plan-summary div{display:flex;justify-content:space-between;gap:8px}
.file-picker-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}
.desktop-only{display:none}.is-desktop .desktop-only{display:inline-flex}
.hidden{display:none!important}
.seamless-panel{border:1px solid rgba(91,140,247,.4);background:rgba(91,140,247,.1);border-radius:8px;padding:10px;display:grid;gap:6px}
.btn-seamless-wide{width:100%;padding:9px 12px;font-weight:600;background:linear-gradient(90deg,var(--accent),#42e6a0);color:#071018;border:none}
.btn-seamless-wide:hover:not(:disabled){filter:brightness(1.08)}
.upload-split-label{font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;margin-top:2px}
.button-spinner::after{content:'';display:inline-block;width:10px;height:10px;margin-left:6px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .75s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:900px){.layout,.split,.metric-grid,.row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="app">
<header class="title-bar">
<div class="title-bar-left">
<svg class="app-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
<span>Vault Upload</span>
<span class="chip" id="uiVersion" title="Client UI build">${pkg.version} · ${UI_BUILD}</span>
<span class="dot" id="authDot"></span>
<span class="auth-label" id="authText">Checking…</span>
</div>
<div class="title-bar-right">
<span class="chip" id="desktopStatus">Browser</span>
<span class="chip" id="operationState">Ready</span>
</div>
</header>
<nav class="ribbon">
<button class="ribbon-btn" id="uploadBtn" type="button"><span>▶</span><span>API / Git</span></button>
<button class="ribbon-btn ribbon-btn-seamless" id="seamlessBtn" type="button"><span>⚡</span><span>Seamless</span></button>
<button class="ribbon-btn" id="planBtn" type="button"><span>📋</span><span>Plan</span></button>
<button class="ribbon-btn desktop-only" id="browseBtn" type="button"><span>📂</span><span>Browse</span></button>
<span class="ribbon-sep"></span>
<button class="ribbon-btn" id="refreshSessions" type="button"><span>↻</span><span>Sessions</span></button>
<button class="ribbon-btn" id="refreshRemote" type="button"><span>↻</span><span>Remote</span></button>
<button class="ribbon-btn" id="clientHelp" type="button"><span>?</span><span>CLI</span></button>
</nav>
<div class="layout">
<aside class="stack">
<section class="panel">
<div class="panel-hd"><h2>Server</h2></div>
<div class="panel-bd stack">
<label><span class="label">Saved servers</span>
<div class="row-compact">
<select id="serverHistory"><option value="">Saved servers…</option></select>
<button class="btn-secondary btn-sm" id="useServer" type="button">Connect</button>
</div></label>
<button class="btn-ghost btn-sm" id="removeServer" type="button" disabled>Remove from history</button>
<details class="details-block" id="manualConnect">
<summary>Manual connection</summary>
<div class="details-body stack">
<label><span class="label">Server URL</span><input id="serverUrl" placeholder="http://localhost:3000"></label>
<label><span class="label">API Key</span><input id="apiKey" placeholder="gv_…"></label>
<label><span class="label">Session cookie</span><input id="cookie" placeholder="vault.sid=…"></label>
<button class="btn-primary" id="saveConfig" type="button">Save &amp; check</button>
</div>
</details>
</div>
</section>
<section class="panel">
<div class="panel-hd"><h2>Upload</h2></div>
<div class="panel-bd stack">
<div class="local-upload-badge hidden" id="localUploadBadge"></div>
<label><span class="label">Files</span>
<div class="file-picker-row"><input id="filePath" placeholder="C:\\path\\to\\file"><button class="btn-secondary btn-sm desktop-only" id="browseBtnSide" type="button">Browse</button></div>
</label>
<div class="list hidden" id="fileList" style="max-height:100px"></div>
<label><span class="label">Parent folder</span>
<div class="row-compact"><select id="parentPath"><option value="/">/ (root)</option></select><button class="btn-secondary btn-sm" id="refreshFolders" type="button">↻</button></div>
</label>
<div class="seamless-panel">
<button class="btn-primary btn-seamless-wide" id="seamlessPanelBtn" type="button">⚡ Seamless Upload</button>
<p class="muted">Stream to server cache — server handles encrypt, GitHub upload, and HLS. Best for large files.</p>
</div>
<p class="upload-split-label">Standard upload</p>
<div class="row">
<label><span class="label">Mode</span><select id="mode"><option value="api">API (resumable)</option><option value="git">Git push</option></select></label>
<label><span class="label">Concurrency</span><input id="concurrency" type="number" min="1" max="32" value="12"></label>
</div>
<details class="details-block">
<summary>Advanced</summary>
<div class="details-body stack">
<label><span class="label">Chunk size (MB)</span><input id="chunkSize" type="number" min="0" max="95" step="0.1" value="0.9" placeholder="auto"></label>
<label class="muted"><input id="convertHls" type="checkbox"> Convert video to HLS</label>
</div>
</details>
<div class="feedback-box hidden" id="feedbackBox"></div>
<pre class="logs" id="planOut" style="max-height:100px"></pre>
</div>
</section>
</aside>
<main class="main">
<section class="panel">
<div class="panel-hd"><h2>Active job</h2></div>
<div class="panel-bd">
<div class="metric-grid">
<div class="metric"><span class="label">Status</span><b id="activeStatus">Idle</b></div>
<div class="metric"><span class="label">Chunks</span><b id="chunks">0/0</b></div>
<div class="metric"><span class="label">Speed</span><b id="speed">--/s</b></div>
<div class="metric"><span class="label">Progress</span><b id="progressPct">0%</b></div>
</div>
<div class="bar"><div class="fill" id="progressFill"></div></div>
</div>
</section>
<div class="split">
<section class="panel">
<div class="panel-hd"><h2>Local sessions</h2></div>
<div class="panel-bd"><div class="list" id="sessions"></div></div>
</section>
<section class="panel">
<div class="panel-hd"><h2>Remote tasks</h2></div>
<div class="panel-bd"><div class="list" id="remote"></div></div>
</section>
</div>
<section class="panel">
<div class="panel-hd"><h2>Live logs</h2></div>
<div class="panel-bd"><pre class="logs" id="logs">No active upload.</pre></div>
</section>
</main>
</div>
</div>
<script>
const $=id=>document.getElementById(id);let activeTask=null;let pollTimer=null;let selectedFiles=[];let uploadQueue=null;let serverCatalog=[];const MAX_PARALLEL_FILES=2;const state={busy:false,configured:false};
async function runPool(items,limit,fn){const results=new Array(items.length);let idx=0;const workers=Array.from({length:Math.min(limit,items.length)},async()=>{while(true){const i=idx++;if(i>=items.length)break;try{results[i]=await fn(items[i],i)}catch(e){results[i]={status:'error',error:e.message}}}});await Promise.all(workers);return results}
function bytes(n){if(!n)return'0 B';const u=['B','KB','MB','GB','TB'];const i=Math.floor(Math.log(n)/Math.log(1024));return (n/Math.pow(1024,i)).toFixed(i?1:0)+' '+u[i]}
function speed(n){return n?bytes(n)+'/s':'--/s'}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function basename(p){return String(p).replace(/\\\\/g,'/').split('/').pop()}
function getUploadPaths(){if(selectedFiles.length)return selectedFiles.slice();const single=$('filePath').value.trim();return single&&!/\\d+ files selected$/.test(single)?[single]:[]}
function renderSelectedFiles(){const list=$('fileList');const paths=getUploadPaths();if(!paths.length){list.innerHTML='';list.classList.add('hidden');return}list.classList.remove('hidden');list.innerHTML=paths.map(p=>'<div class="item"><strong>'+esc(basename(p))+'</strong><div class="muted">'+esc(p)+'</div></div>').join('');$('filePath').value=paths.length===1?paths[0]:paths.length+' files selected';updateButtons()}
function setState(text,type=''){const el=$('operationState');el.textContent=text;el.className='chip '+type}
function setBusy(btn,busy,text){state.busy=busy;if(btn){btn.disabled=busy;btn.classList.toggle('button-spinner',busy);if(text){if(busy){btn.dataset.label=btn.textContent;btn.textContent=text}else if(btn.dataset.label){btn.textContent=btn.dataset.label;delete btn.dataset.label}}}updateButtons()}
function updateButtons(){const hasFile=getUploadPaths().length>0;const dis=state.busy||!hasFile||!state.configured;$('planBtn').disabled=dis;$('uploadBtn').disabled=dis;if($('seamlessBtn'))$('seamlessBtn').disabled=dis;if($('seamlessPanelBtn'))$('seamlessPanelBtn').disabled=dis;$('saveConfig').disabled=state.busy;$('browseBtn').disabled=state.busy;if($('browseBtnSide'))$('browseBtnSide').disabled=state.busy;$('useServer').disabled=state.busy||!$('serverHistory').value}
function chunkSizeFromMbInput(){const MB=1024*1024;const mb=parseFloat($('chunkSize')?.value);if(!Number.isFinite(mb)||mb<=0)return 0;return Math.round(Math.min(95,Math.max(0.064,mb))*MB)}
function getUploadBody(modeOverride){const mode=modeOverride||$('mode').value;return{parentPath:$('parentPath').value,mode,concurrency:$('concurrency').value,chunkSize:chunkSizeFromMbInput(),convertHls:$('convertHls').checked}}
async function api(path,opts={}){const r=await fetch(path,{headers:{'Content-Type':'application/json'},...opts});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Request failed');return j}
function setAuth(ok,text){state.configured=!!ok;$('authDot').className='dot '+(ok?'done':'error');$('authText').textContent=text;updateButtons()}
function encodeServerId(id){return encodeURIComponent(id)}
function decodeServerId(value){try{return decodeURIComponent(value||'')}catch{return value||''}}
function renderServerHistory(servers,activeId){serverCatalog=servers||[];const sel=$('serverHistory');if(!sel)return;const opts=['<option value="">Saved servers…</option>'].concat(serverCatalog.map(s=>'<option value="'+esc(encodeServerId(s.id))+'"'+(s.id===activeId?' selected':'')+'>'+esc(s.label)+' · '+esc(s.apiKeyPreview||s.cookiePreview||'session')+'</option>'));sel.innerHTML=opts.join('');if(activeId)sel.value=encodeServerId(activeId);$('removeServer').disabled=!sel.value;updateButtons()}
function applyServerPreview(id){const entry=serverCatalog.find(s=>s.id===id);if(!entry)return;$('serverUrl').value=entry.serverUrl||''}
async function loadServerHistory(){try{const [servers,cfg]=await Promise.all([api('/api/servers'),api('/api/config')]);renderServerHistory(servers.servers||[],cfg.activeServerId||'')}catch{}}
async function useSelectedServer(){const id=decodeServerId($('serverHistory').value);if(!id)return;setState('Connecting…','busy');try{const r=await api('/api/servers/select',{method:'POST',body:JSON.stringify({id})});await loadConfig();setState(r.authenticated?'Connected':'Auth failed',r.authenticated?'good':'bad')}catch(e){setState(e.message,'bad')}finally{updateButtons()}}
async function removeSelectedServer(){const id=decodeServerId($('serverHistory').value);if(!id)return;if(!confirm('Remove this server from history?'))return;const data=await api('/api/servers/'+encodeURIComponent(id),{method:'DELETE'});renderServerHistory(data.servers||[],'');await loadConfig()}
function renderFeedback(feedback){const box=$('feedbackBox');const storage=feedback&&feedback.storage;if(!storage){box.classList.add('hidden');return}const warnings=(storage.warnings||[]).map(w=>'<div>⚠ '+esc(w)+'</div>').join('');box.innerHTML='<strong>Storage</strong><div>'+bytes(storage.availableBytes)+' free · '+storage.availableRepoCount+'/'+storage.activeRepoCount+' repos · '+storage.usedPercent+'% used</div>'+warnings;box.classList.remove('hidden')}
function renderLocalUpload(localUpload){const el=$('localUploadBadge');if(!el)return;if(!localUpload){el.className='local-upload-badge hidden';el.textContent='';return}if(localUpload.active){const ip=localUpload.serverIpv4&&localUpload.serverIpv4[0];el.className='local-upload-badge on';el.textContent=ip?'⚡ Local upload: ON ('+ip+')':'⚡ Local upload: ON';el.title='Connected to the server over the local network.';return}if(localUpload.onLan&&localUpload.localUrl){el.className='local-upload-badge suggest';el.innerHTML='⚡ Faster: <a href="'+esc(localUpload.localUrl)+'">'+esc(localUpload.localUrl.replace(/^https?:\\/\\//,''))+'</a>';el.title='Use the local server address for LAN-speed uploads.';return}el.className='local-upload-badge hidden';el.textContent=''}
function renderPlan(plan){renderFeedback(plan.feedback);if(plan.plans&&plan.plans.length>1){$('planOut').innerHTML='<div class="plan-summary"><div><span>Files</span><strong>'+plan.totalFiles+'</strong></div><div><span>Total</span><strong>'+bytes(plan.totalSize)+'</strong></div><div><span>Chunks</span><strong>'+plan.totalChunks+'</strong></div></div>';return}const p=plan.plans?plan.plans[0]:plan;const chunkMb=p.chunkSize?(p.chunkSize/1048576).toFixed(2)+' MB':bytes(p.chunkSize);$('planOut').innerHTML='<div class="plan-summary"><div><span>Chunks</span><strong>'+p.totalChunks+'</strong></div><div><span>Chunk size</span><strong>'+chunkMb+'</strong></div><div><span>ETA</span><strong>'+esc(p.estimatedTime||'--')+'</strong></div></div>'}
async function loadConfig(){const c=await api('/api/config');$('serverUrl').value=c.serverUrl||'';$('apiKey').value=c.apiKey||'';$('cookie').value=c.cookie||'';renderServerHistory(c.serverHistory||[],c.activeServerId||'');renderLocalUpload(c.localUpload||null);const label=c.hasApiKey?c.apiKeyPreview:(c.cookiePreview||'');setAuth((c.hasApiKey||c.hasCookie)&&c.serverUrl,'Connected · '+label);updateButtons();if(state.configured)loadFolders()}
async function loadFolders(){try{const f=await api('/api/folders');const sel=$('parentPath');if(!sel||!f.folders)return;const cur=sel.value;sel.innerHTML=f.folders.map(p=>'<option value="'+esc(p)+'"'+(p===cur?' selected':'')+'>'+esc(p||'/')+'</option>').join('');if(!sel.value)sel.value=cur||'/'}catch{}}
async function refreshSessions(){const data=await api('/api/sessions');$('sessions').innerHTML=data.sessions.map(s=>'<div class="item"><strong>'+esc(s.fileName)+'</strong><div class="muted">'+esc(s.uploadMode||'api')+' · '+esc(s.status)+' · '+(s.uploadMode==='seamless'?(s.totalParts?(s.chunksDone||0)+'/'+(s.totalParts||0)+' parts':(s.chunksDone||0)+'/'+(s.totalChunks||0)):(s.chunksDone||0)+'/'+(s.totalChunks||0))+'</div><div class="muted">'+esc(s.taskId)+'</div><div class="actions"><button class="btn-secondary btn-sm" data-resume="'+esc(s.taskId)+'" data-resume-mode="'+esc(s.uploadMode||'api')+'">Resume</button></div></div>').join('')||'<p class="muted">No sessions.</p>';document.querySelectorAll('[data-resume]').forEach(b=>b.onclick=()=>startUpload(b.dataset.resume,b.dataset.resumeMode==='seamless'?'seamless':null));}
async function refreshRemote(){try{const data=await api('/api/remote-tasks');$('remote').innerHTML=(data.tasks||[]).map(t=>'<div class="item"><strong>'+esc((t.title||t.id)||'task')+'</strong><div class="muted">'+esc(t.status||'')+' · '+esc(t.phase||'')+' · '+(t.percent??0)+'%</div><div class="actions"><button class="btn-secondary btn-sm" data-pause="'+esc(t.id)+'">Pause</button><button class="btn-secondary btn-sm" data-resume-task="'+esc(t.id)+'">Resume</button><button class="btn-danger btn-sm" data-cancel="'+esc(t.id)+'">Cancel</button></div></div>').join('')||'<p class="muted">No remote tasks.</p>';document.querySelectorAll('[data-pause]').forEach(b=>b.onclick=()=>taskAction('pause',b.dataset.pause));document.querySelectorAll('[data-resume-task]').forEach(b=>b.onclick=()=>taskAction('resume',b.dataset.resumeTask));document.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>taskAction('cancel',b.dataset.cancel));}catch(e){$('remote').innerHTML='<p class="muted">'+esc(e.message)+'</p>'}}
async function taskAction(action,taskId){setState(action+'…','busy');await api('/api/task/'+action,{method:'POST',body:JSON.stringify({taskId})});setState('Ready','good');refreshRemote()}
function validateUpload(){if(!getUploadPaths().length)throw new Error('Choose a file first');if(!state.configured)throw new Error('Connect to a server first')}
function updateJobUi(j){const queueLabel=uploadQueue&&uploadQueue.total>1?' · '+(uploadQueue.index+1)+'/'+uploadQueue.total:'';const p=j.progress||{};let chunkLabel='0/0';if(p.phase==='receiving'&&p.seamlessPartsTotal)chunkLabel=(p.seamlessPartsDone||0)+'/'+p.seamlessPartsTotal+' parts';else chunkLabel=(p.chunksDone||0)+'/'+(p.totalChunks||0);$('activeStatus').textContent=j.status+(p.phase?(' · '+p.phase):'')+queueLabel;const pct=p.percent||0;$('progressFill').style.width=pct+'%';$('progressPct').textContent=pct+'%';$('chunks').textContent=chunkLabel;$('speed').textContent=speed(p.speed);$('logs').textContent=(j.logs||[]).map(l=>new Date(l.at).toLocaleTimeString()+' '+l.message).join('\\n')||j.error||j.status}
function waitForJob(taskId){return new Promise(resolve=>{const tick=async()=>{try{const j=await api('/api/jobs/'+encodeURIComponent(taskId));updateJobUi(j);if(['done','error','paused'].includes(j.status))resolve(j);else setTimeout(tick,500)}catch(e){setState('Waiting…','busy');setTimeout(tick,1200)}};tick()})}
async function startUpload(resumeTaskId,modeOverride){validateUpload();const seamless=modeOverride==='seamless';const btn=seamless?($('seamlessPanelBtn')||$('seamlessBtn')):$('uploadBtn');const paths=resumeTaskId?[$('filePath').value.trim()]:getUploadPaths();if(!paths.length)throw new Error('Choose a file first');setBusy(btn,true,seamless?'Seamless…':'Starting');uploadQueue=paths.length>1&&!resumeTaskId?{total:paths.length,done:0,index:0}:null;try{const runOne=async(filePath,i)=>{if(uploadQueue)uploadQueue.index=i;{try{const base=getUploadBody(seamless?'seamless':null);const body={...base,filePath};if(paths.length>1)body.concurrency=Math.min(parseInt(base.concurrency,10)||5,3);if(resumeTaskId&&i===0)body.resumeTaskId=resumeTaskId;const r=await api('/api/upload',{method:'POST',body:JSON.stringify(body)});return await waitForJob(r.taskId)}finally{if(uploadQueue)uploadQueue.done++}}};const limit=resumeTaskId?1:Math.min(MAX_PARALLEL_FILES,paths.length);const results=await runPool(paths,limit,runOne);const done=results.filter(j=>j&&j.status==='done').length;const failed=results.filter(j=>j&&j.status==='error');const paused=results.filter(j=>j&&j.status==='paused');if(!done&&!paused.length&&failed.length)throw new Error(failed[0].error||'Upload failed');if(paused.length&&!done){setState('Paused');return}if(failed.length)setState(done+' done, '+failed.length+' failed',done?'good':'bad');else setState(paths.length>1?done+'/'+paths.length+' complete':'Done','good');if(!failed.length&&paths.length>1){selectedFiles=[];renderSelectedFiles()}}catch(e){setState(e.message,'bad');$('logs').textContent=e.stack||e.message}finally{uploadQueue=null;setBusy(btn,false);refreshSessions();refreshRemote()}}
async function chooseFiles(){if(!window.vaultDesktop){setState('Desktop picker only','bad');return}const pick=window.vaultDesktop.selectFiles||window.vaultDesktop.selectFile;const result=await pick();const filePaths=result&&(result.filePaths||[]).length?result.filePaths:(result&&result.filePath?[result.filePath]:[]);if(result&&!result.canceled&&filePaths.length){selectedFiles=filePaths;renderSelectedFiles();setState(filePaths.length+' file(s)','good')}}
async function saveConfig(){const btn=$('saveConfig');setBusy(btn,true,'Checking');setState('Checking…','busy');try{const r=await api('/api/config',{method:'POST',body:JSON.stringify({serverUrl:$('serverUrl').value.trim(),apiKey:$('apiKey').value.trim(),cookie:$('cookie').value.trim()})});renderServerHistory(r.serverHistory||[],r.activeServerId||'');$('serverUrl').value=r.serverUrl||'';$('apiKey').value=r.apiKey||'';$('cookie').value=r.cookie||'';renderLocalUpload(r.localUpload||null);const label=r.hasApiKey?r.apiKeyPreview:(r.cookiePreview||'');setAuth((r.hasApiKey||r.hasCookie)&&r.serverUrl,'Connected · '+label);updateButtons();if(state.configured)loadFolders();const saved=(r.serverHistory||[]).length;const localNote=r.localUpload&&r.localUpload.active?' · Local upload ON':'';setState(r.authenticated?((saved?'Connected · saved to history':'Connected')+localNote):'Saved, but auth failed',r.authenticated?'good':'bad')}catch(e){setState(e.message,'bad')}finally{setBusy(btn,false)}}
async function planUpload(){validateUpload();const btn=$('planBtn');const paths=getUploadPaths();setBusy(btn,true,'Planning');setState('Planning…','busy');try{const body={chunkSize:chunkSizeFromMbInput()};if(paths.length>1)body.filePaths=paths;else body.filePath=paths[0];const r=await api('/api/plan',{method:'POST',body:JSON.stringify(body)});renderPlan(r);setState('Plan ready','good')}catch(e){setState(e.message,'bad');$('planOut').textContent=e.message}finally{setBusy(btn,false)}}
async function tryAutoConnect(){try{const defaults=[window.location.origin,'http://localhost:3000','http://127.0.0.1:3000'];for(const url of defaults){try{const r=await api('/api/probe-server',{method:'POST',body:JSON.stringify({url})});if(r&&r.key){await api('/api/config',{method:'POST',body:JSON.stringify({serverUrl:r.serverUrl||url,apiKey:r.key,cookie:''})});setState('Auto-connected','good');return true}}catch{}}return false}catch{return false}}
async function initDesktopMode(){if(window.vaultDesktop){document.body.classList.add('is-desktop');$('desktopStatus').textContent='Desktop';$('desktopStatus').classList.add('good')}else{$('desktopStatus').textContent='Browser'}}
$('saveConfig').onclick=saveConfig;$('useServer').onclick=useSelectedServer;$('removeServer').onclick=removeSelectedServer;$('serverHistory').onchange=()=>{applyServerPreview(decodeServerId($('serverHistory').value));updateButtons()};$('planBtn').onclick=planUpload;$('uploadBtn').onclick=()=>startUpload();if($('seamlessBtn'))$('seamlessBtn').onclick=()=>startUpload(null,'seamless');if($('seamlessPanelBtn'))$('seamlessPanelBtn').onclick=()=>startUpload(null,'seamless');$('browseBtn').onclick=chooseFiles;if($('browseBtnSide'))$('browseBtnSide').onclick=chooseFiles;$('filePath').addEventListener('input',()=>{if(selectedFiles.length&&!/\\d+ files selected$/.test($('filePath').value.trim())){selectedFiles=[];$('fileList').innerHTML='';$('fileList').classList.add('hidden')}updateButtons()});$('refreshSessions').onclick=refreshSessions;$('refreshRemote').onclick=refreshRemote;$('refreshFolders').onclick=loadFolders;$('clientHelp').onclick=()=>$('planOut').textContent='npm run client -- upload --file <path>\\nnpm run client -- list\\nnpm run client -- status <taskId>';
initDesktopMode();loadConfig().then(()=>{if(!state.configured)tryAutoConnect().then(ok=>{if(ok){loadConfig();refreshSessions();refreshRemote()}})}).catch(()=>tryAutoConnect().then(ok=>{if(ok){loadConfig();refreshSessions();refreshRemote()}}));refreshSessions();refreshRemote();updateButtons();
</script></body></html>`;
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, responseHeaders({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': HTML_CACHE,
        }));
        return res.end(html());
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, safeConfig(configStore.load(), true));
      if (req.method === 'GET' && url.pathname === '/api/version') {
        return json(res, 200, { version: pkg.version, uiBuild: UI_BUILD, features: { seamless: true } });
      }
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await readBody(req);
        const config = configStore.load();
        applyConfigBody(config, body);
        if (!config.serverUrl) return json(res, 400, { error: 'Server URL is required' });
        if (!config.apiKey && !config.cookie) {
          return json(res, 400, { error: 'API key or session cookie is required' });
        }
        const { authenticated, localUpload } = await saveAndCheckConfig(config);
        return json(res, 200, { ...safeConfig(config, true), authenticated, localUpload });
      }
      if (req.method === 'GET' && url.pathname === '/api/servers') {
        const config = configStore.load();
        return json(res, 200, { servers: configStore.safeServerHistory(config) });
      }
      if (req.method === 'POST' && url.pathname === '/api/servers/select') {
        const body = await readBody(req);
        const config = configStore.load();
        const entry = configStore.findServerEntry(config, String(body.id || ''));
        if (!entry) return json(res, 404, { error: 'Saved server not found' });
        config.serverUrl = entry.serverUrl;
        config.apiKey = entry.apiKey || '';
        config.cookie = entry.cookie || '';
        config.serverHistory = configStore.touchServerHistory(config, entry.id);
        configStore.save(config);
        const ok = await new VaultApi(config.serverUrl, { cookie: config.cookie, apiKey: config.apiKey })
          .checkAuth()
          .catch(() => false);
        return json(res, 200, { ...safeConfig(config, true), authenticated: ok });
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/servers/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/servers/'.length));
        const config = configStore.load();
        config.serverHistory = configStore.removeFromServerHistory(config, id);
        const activeId = configStore.activeServerId(config);
        if (activeId === id) {
          config.serverUrl = '';
          config.apiKey = '';
          config.cookie = '';
        }
        configStore.save(config);
        return json(res, 200, { servers: configStore.safeServerHistory(config) });
      }
      if (req.method === 'GET' && url.pathname === '/api/folders') {
        return json(res, 200, await getApi().listFolders());
      }
      if (req.method === 'POST' && url.pathname === '/api/plan') {
        const body = await readBody(req);
        const chunkSize = parseInt(body.chunkSize, 10) || undefined;
        const rawPaths = Array.isArray(body.filePaths) && body.filePaths.length
          ? body.filePaths
          : [body.filePath].filter(Boolean);
        if (!rawPaths.length) return json(res, 400, { error: 'filePath or filePaths required' });
        const api = getApi();
        const plans = [];
        let totalSize = 0;
        let totalChunks = 0;
        for (const raw of rawPaths) {
          const filePath = path.resolve(String(raw));
          if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
          const stat = fs.statSync(filePath);
          const plan = await api.plan(stat.size, chunkSize);
          plans.push({ filePath, fileName: path.basename(filePath), size: stat.size, ...plan });
          totalSize += stat.size;
          totalChunks += plan.totalChunks || 0;
        }
        const single = plans.length === 1 ? plans[0] : null;
        return json(res, 200, {
          plans,
          totalFiles: plans.length,
          totalSize,
          totalChunks,
          chunkSize: single?.chunkSize ?? plans[0]?.chunkSize,
          estimatedTime: single?.estimatedTime,
          repoCount: single?.repoCount ?? plans[0]?.repoCount,
          feedback: single?.feedback ?? plans[0]?.feedback,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        const result = await startUpload(await readBody(req));
        return json(res, 202, { taskId: result.taskId });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
        const taskId = decodeURIComponent(url.pathname.slice('/api/jobs/'.length));
        const job = jobs.get(taskId);
        if (!job) return json(res, 404, { error: 'Job not found' });
        return json(res, 200, job);
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        return json(res, 200, { sessions: SessionStore.listInterrupted().map(serializeSession) });
      }
      if (req.method === 'GET' && url.pathname === '/api/remote-tasks') return json(res, 200, await getApi().listTasks(true, true));
      if (req.method === 'POST' && url.pathname === '/api/probe-server') {
        const body = await readBody(req);
        const serverUrl = String(body.url || '').replace(/\/+$/, '');
        if (!serverUrl) return json(res, 400, { error: 'url required' });
        try {
          const health = await fetch(`${serverUrl}/health`, { timeout: 3000 });
          if (!health.ok) return json(res, 400, { error: 'Server not reachable', url: serverUrl });
          const provision = await fetch(`${serverUrl}/auth/local-provision`, {
            method: 'POST', headers: { 'X-Vault-Local': '1' }, timeout: 4000,
          });
          if (!provision.ok) return json(res, 400, { error: 'Local provision failed', url: serverUrl });
          const data = await provision.json();
          return json(res, 200, { key: data.key, serverUrl: data.serverUrl || serverUrl, username: data.username });
        } catch (err) {
          return json(res, 400, { error: err.message, url: serverUrl });
        }
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/task/')) {
        const action = url.pathname.split('/').pop();
        const { taskId } = await readBody(req);
        const api = getApi();
        if (action === 'pause') return json(res, 200, await api.pauseTask(taskId));
        if (action === 'resume') return json(res, 200, await api.resumeTask(taskId));
        if (action === 'cancel') return json(res, 200, await api.cancelTask(taskId));
      }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  });
}

function listenUiServer(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = opts.port == null ? 4173 : opts.port;
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;
      const url = `http://${host}:${resolvedPort}`;
      resolve({ server, url, host, port: resolvedPort, uiBuild: UI_BUILD });
    });
  });
}

function startUiServer(opts = {}) {
  const pending = listenUiServer(opts);
  pending.then(({ url }) => {
    console.log(`Vault Upload UI running at ${url}`);
  }).catch((err) => {
    console.error(`Failed to start Vault Upload UI: ${err.message}`);
  });
  return pending;
}

module.exports = { createServer, listenUiServer, startUiServer };
