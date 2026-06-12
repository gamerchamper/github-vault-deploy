const http = require('http');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { VaultApi } = require('./api');
const { UploadEngine, DEFAULT_CONCURRENCY } = require('./upload-engine');
const { SessionStore } = require('./session-store');
const configStore = require('./config');

const jobs = new Map();

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
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
  const safe = {
    serverUrl: config.serverUrl || '',
    hasCookie: !!config.cookie,
    hasApiKey: !!config.apiKey,
    cookiePreview: config.cookie ? `${config.cookie.slice(0, 18)}...` : '',
    apiKeyPreview: config.apiKey ? `${config.apiKey.slice(0, 12)}...` : '',
  };
  if (includeSecret) {
    safe.cookie = config.cookie || '';
    safe.apiKey = config.apiKey || '';
  }
  return safe;
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

  const engine = new UploadEngine(api, {
    concurrency: parseInt(body.concurrency, 10) || DEFAULT_CONCURRENCY,
    chunkSize: parseInt(body.chunkSize, 10) || 0,
    uploadMode: body.mode === 'git' ? 'git' : 'api',
    convertHls: !!body.convertHls,
  });

  const taskId = body.resumeTaskId || SessionStore.generateTaskId();
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
:root{color-scheme:dark;--bg:#070910;--panel:#101625cc;--panel2:#151e33;--text:#f5f7fb;--muted:#97a3ba;--line:#26324a;--hot:#78ffd6;--violet:#9b8cff;--bad:#ff6b8a;--ok:#78ffd6;--warn:#ffd166}*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Arial,sans-serif;background:radial-gradient(circle at 12% 10%,#19395a 0,transparent 28%),radial-gradient(circle at 85% 15%,#3b246d 0,transparent 26%),linear-gradient(135deg,#070910,#0b1020 58%,#101422);color:var(--text)}.shell{width:min(1180px,calc(100% - 28px));margin:0 auto;padding:28px 0 40px}.hero{display:grid;grid-template-columns:1.25fr .75fr;gap:18px;align-items:stretch}.card{border:1px solid #ffffff14;background:linear-gradient(180deg,#111827d9,#0e1424d9);box-shadow:0 24px 80px #0008, inset 0 1px 0 #ffffff12;backdrop-filter:blur(18px);border-radius:28px;padding:22px}.title{font-size:clamp(32px,5vw,64px);line-height:.95;margin:0;letter-spacing:-.055em}.subtitle{color:var(--muted);font-size:16px;max-width:680px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.stack{display:grid;gap:12px}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em}input,select{width:100%;border:1px solid var(--line);background:#07101f;color:var(--text);border-radius:14px;padding:12px 13px;outline:none}input:focus,select:focus{border-color:var(--hot);box-shadow:0 0 0 3px #78ffd61f}button{border:0;border-radius:15px;padding:12px 14px;color:#07101f;font-weight:800;background:linear-gradient(135deg,var(--hot),#8fb8ff);cursor:pointer;transition:transform .16s ease,filter .16s ease}button:hover{transform:translateY(-1px);filter:saturate(1.15)}button.secondary{color:var(--text);background:#202a40}button.danger{color:white;background:linear-gradient(135deg,#ff6b8a,#ff9f6e)}.metric{padding:16px;border:1px solid var(--line);border-radius:20px;background:#07101f99}.metric b{display:block;font-size:24px}.bar{height:16px;border-radius:999px;background:#07101f;border:1px solid var(--line);overflow:hidden}.fill{height:100%;width:0;background:linear-gradient(90deg,var(--hot),var(--violet));box-shadow:0 0 26px #78ffd677;transition:width .28s ease}.pill{display:inline-flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:999px;padding:7px 10px;color:var(--muted);background:#07101f99}.dot{width:8px;height:8px;border-radius:50%;background:var(--warn);box-shadow:0 0 16px currentColor}.dot.done{background:var(--ok)}.dot.error{background:var(--bad)}.list{display:grid;gap:10px;max-height:360px;overflow:auto}.item{border:1px solid var(--line);background:#07101f99;border-radius:18px;padding:13px}.item strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.muted{color:var(--muted)}.logs{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;white-space:pre-wrap;max-height:220px;overflow:auto;color:#c8d3e8}@media(max-width:850px){.hero,.grid,.row{grid-template-columns:1fr}.shell{width:min(100% - 18px,1180px);padding-top:12px}.card{border-radius:22px;padding:16px}}
button:disabled{opacity:.48;cursor:not-allowed;transform:none!important;filter:none!important}.status-strip{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.status-chip{border:1px solid var(--line);border-radius:999px;padding:8px 11px;background:#07101f99;color:var(--muted);font-size:13px}.status-chip.good{color:var(--ok);border-color:#78ffd655}.status-chip.bad{color:var(--bad);border-color:#ff6b8a55}.status-chip.busy{color:var(--warn);border-color:#ffd16655}.file-picker-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px}.desktop-only{display:none}.is-desktop .desktop-only{display:inline-flex}.action-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.feedback-box{border:1px solid var(--line);background:#07101f99;border-radius:18px;padding:13px;color:var(--muted);font-size:13px}.feedback-box strong{color:var(--text)}.plan-summary{display:grid;gap:8px}.plan-summary div{display:flex;justify-content:space-between;gap:10px}.button-spinner::after{content:'';display:inline-block;width:12px;height:12px;margin-left:8px;border:2px solid #07101f55;border-top-color:#07101f;border-radius:50%;animation:spin .75s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:850px){.file-picker-row,.action-row{grid-template-columns:1fr}}
</style>
</head>
<body><main class="shell">
<section class="hero"><div class="card"><p class="pill"><span class="dot" id="authDot"></span><span id="authText">Checking config</span></p><h1 class="title">Vault Upload</h1><p class="subtitle">A fluid local control surface for resilient large-file uploads. Configure once, plan transfers, launch resumable uploads, and manage active or interrupted sessions.</p><div class="status-strip"><span class="status-chip" id="desktopStatus">Browser mode</span><span class="status-chip" id="operationState">Ready</span></div></div><div class="card stack"><div class="metric"><span class="label">Active job</span><b id="activeStatus">Idle</b></div><div class="bar"><div class="fill" id="progressFill"></div></div><div class="row"><div class="metric"><span class="label">Chunks</span><b id="chunks">0/0</b></div><div class="metric"><span class="label">Speed</span><b id="speed">--/s</b></div></div></div></section>
<section class="grid"><div class="card stack"><h2>Connect</h2><label><span class="label">Server URL</span><input id="serverUrl" placeholder="http://localhost:3000"></label><label><span class="label">API Key</span><input id="apiKey" placeholder="gv_..."></label><label><span class="label">Session Cookie Fallback</span><input id="cookie" placeholder="vault.sid=..."></label><button id="saveConfig">Save and Check</button></div>
<div class="card stack"><h2>Upload</h2><label><span class="label">File Path</span><div class="file-picker-row"><input id="filePath" placeholder="C:\\path\\to\\large-file.zip"><button id="browseBtn" class="secondary desktop-only" type="button">Browse</button></div></label><div class="row"><label><span class="label">Parent Folder</span><select id="parentPath"><option value="/">/ (root)</option></select><button id="refreshFolders" class="secondary" type="button" style="padding:8px 10px;width:auto">↻</button></label><label><span class="label">Mode</span><select id="mode"><option value="api">API</option><option value="git">Git</option></select></label></div><div class="row"><label><span class="label">Concurrency</span><input id="concurrency" type="number" min="1" max="20" value="5"></label><label><span class="label">Chunk Size Bytes</span><input id="chunkSize" type="number" min="0" placeholder="auto"></label></div><label class="muted"><input id="convertHls" type="checkbox" style="width:auto"> Convert video to HLS</label><div class="action-row"><button id="planBtn">Plan</button><button id="uploadBtn">Start Upload</button></div><div class="feedback-box hidden" id="feedbackBox"></div><pre class="logs" id="planOut"></pre></div></section>
<section class="grid"><div class="card stack"><h2>Local Sessions</h2><button class="secondary" id="refreshSessions">Refresh Sessions</button><div class="list" id="sessions"></div></div><div class="card stack"><h2>Remote Tasks</h2><div class="row"><button class="secondary" id="refreshRemote">Refresh Remote</button><button class="secondary" id="clientHelp">CLI Help</button></div><div class="list" id="remote"></div></div></section>
<section class="card stack" style="margin-top:18px"><h2>Live Logs</h2><pre class="logs" id="logs">No active upload.</pre></section>
</main><script>
const $=id=>document.getElementById(id);let activeTask=null;let pollTimer=null;const state={busy:false,configured:false};
function bytes(n){if(!n)return'0 B';const u=['B','KB','MB','GB','TB'];const i=Math.floor(Math.log(n)/Math.log(1024));return (n/Math.pow(1024,i)).toFixed(i?1:0)+' '+u[i]}
function speed(n){return n?bytes(n)+'/s':'--/s'}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function setState(text,type=''){const el=$('operationState');el.textContent=text;el.className='status-chip '+type}
function setBusy(btn,busy,text){state.busy=busy;if(btn){btn.disabled=busy;btn.classList.toggle('button-spinner',busy);if(text){if(busy){btn.dataset.label=btn.textContent;btn.textContent=text}else if(btn.dataset.label){btn.textContent=btn.dataset.label;delete btn.dataset.label}}}updateButtons()}
function updateButtons(){const hasFile=$('filePath').value.trim().length>0;$('planBtn').disabled=state.busy||!hasFile||!state.configured;$('uploadBtn').disabled=state.busy||!hasFile||!state.configured;$('saveConfig').disabled=state.busy;$('browseBtn').disabled=state.busy}
async function api(path,opts={}){const r=await fetch(path,{headers:{'Content-Type':'application/json'},...opts});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Request failed');return j}
function setAuth(ok,text){state.configured=!!ok;$('authDot').className='dot '+(ok?'done':'error');$('authText').textContent=text;updateButtons()}
function renderFeedback(feedback){const box=$('feedbackBox');const storage=feedback&&feedback.storage;if(!storage){box.classList.add('hidden');return}const warnings=(storage.warnings||[]).map(w=>'<div>⚠ '+esc(w)+'</div>').join('');box.innerHTML='<strong>Storage pool</strong><div>'+bytes(storage.availableBytes)+' available · '+storage.availableRepoCount+'/'+storage.activeRepoCount+' repos writable · '+storage.usedPercent+'% used</div>'+warnings;box.classList.remove('hidden')}
function renderPlan(plan){renderFeedback(plan.feedback);$('planOut').innerHTML='<div class="plan-summary"><div><span>Chunks</span><strong>'+plan.totalChunks+'</strong></div><div><span>Chunk size</span><strong>'+bytes(plan.chunkSize)+'</strong></div><div><span>Estimated time</span><strong>'+esc(plan.estimatedTime||'--')+'</strong></div><div><span>Repos</span><strong>'+plan.repoCount+'</strong></div></div>'}
async function loadConfig(){const c=await api('/api/config');$('serverUrl').value=c.serverUrl||'';$('apiKey').value=c.apiKey||'';$('cookie').value=c.cookie||'';const label=c.hasApiKey?c.apiKeyPreview:(c.cookiePreview||'');setAuth((c.hasApiKey||c.hasCookie)&&c.serverUrl,'Configured '+label);updateButtons();if(state.configured)loadFolders()}
async function loadFolders(){try{const f=await api('/api/folders');const sel=$('parentPath');if(!sel||!f.folders)return;const cur=sel.value;sel.innerHTML=f.folders.map(p=>'<option value="'+esc(p)+'"'+(p===cur?' selected':'')+'>'+esc(p||'/')+'</option>').join('');if(!sel.value)sel.value=cur||'/'}catch{}}
async function refreshSessions(){const data=await api('/api/sessions');$('sessions').innerHTML=data.sessions.map(s=>'<div class="item"><strong>'+esc(s.fileName)+'</strong><div class="muted">'+esc(s.status)+' · '+(s.chunksDone||0)+'/'+(s.totalChunks||0)+'</div><div class="muted">'+esc(s.taskId)+'</div><button class="secondary" data-resume="'+esc(s.taskId)+'">Resume</button></div>').join('')||'<p class="muted">No sessions.</p>';document.querySelectorAll('[data-resume]').forEach(b=>b.onclick=()=>startUpload(b.dataset.resume));}
async function refreshRemote(){try{const data=await api('/api/remote-tasks');$('remote').innerHTML=(data.tasks||[]).map(t=>'<div class="item"><strong>'+esc((t.title||t.id)||'task')+'</strong><div class="muted">'+esc(t.status||'')+' · '+esc(t.phase||'')+' · '+(t.percent??0)+'%</div><div class="muted">'+esc(t.id)+'</div><button class="secondary" data-pause="'+esc(t.id)+'">Pause</button> <button class="secondary" data-resume-task="'+esc(t.id)+'">Resume</button> <button class="danger" data-cancel="'+esc(t.id)+'">Cancel</button></div>').join('')||'<p class="muted">No remote tasks.</p>';document.querySelectorAll('[data-pause]').forEach(b=>b.onclick=()=>taskAction('pause',b.dataset.pause));document.querySelectorAll('[data-resume-task]').forEach(b=>b.onclick=()=>taskAction('resume',b.dataset.resumeTask));document.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>taskAction('cancel',b.dataset.cancel));}catch(e){$('remote').innerHTML='<p class="muted">'+esc(e.message)+'</p>'}}
async function taskAction(action,taskId){setState(action+' '+taskId,'busy');await api('/api/task/'+action,{method:'POST',body:JSON.stringify({taskId})});setState('Ready','good');refreshRemote()}
function validateUpload(){if(!$('filePath').value.trim())throw new Error('Choose a file first');if(!state.configured)throw new Error('Configure server credentials first')}
async function startUpload(resumeTaskId){validateUpload();const btn=$('uploadBtn');setBusy(btn,true,'Starting');setState('Starting upload','busy');try{const body={filePath:$('filePath').value,parentPath:$('parentPath').value,mode:$('mode').value,concurrency:$('concurrency').value,chunkSize:$('chunkSize').value,convertHls:$('convertHls').checked,resumeTaskId};const r=await api('/api/upload',{method:'POST',body:JSON.stringify(body)});activeTask=r.taskId;setState('Uploading','busy');pollJob();refreshSessions()}catch(e){setState(e.message,'bad');$('logs').textContent=e.stack||e.message}finally{setBusy(btn,false)}}
async function pollJob(){if(!activeTask)return;clearTimeout(pollTimer);try{const j=await api('/api/jobs/'+encodeURIComponent(activeTask));$('activeStatus').textContent=j.status;$('progressFill').style.width=((j.progress&&j.progress.percent)||0)+'%';$('chunks').textContent=((j.progress&&j.progress.chunksDone)||0)+'/'+((j.progress&&j.progress.totalChunks)||0);$('speed').textContent=speed(j.progress&&j.progress.speed);$('logs').textContent=(j.logs||[]).map(l=>new Date(l.at).toLocaleTimeString()+' '+l.message).join('\\n') || j.error || j.status;if(['done','error','paused'].includes(j.status)){setState(j.status,j.status==='done'?'good':j.status==='error'?'bad':'');refreshSessions();refreshRemote()}else pollTimer=setTimeout(pollJob,500)}catch(e){setState('Waiting for local job status','busy');pollTimer=setTimeout(pollJob,1200)}}
async function chooseFile(){if(!window.vaultDesktop){setState('Native file picker is available in desktop mode only','bad');return}const result=await window.vaultDesktop.selectFile();if(result&&!result.canceled&&result.filePath){$('filePath').value=result.filePath;setState('File selected','good');updateButtons()}}
async function saveConfig(){const btn=$('saveConfig');setBusy(btn,true,'Checking');setState('Checking credentials','busy');try{const r=await api('/api/config',{method:'POST',body:JSON.stringify({serverUrl:$('serverUrl').value,apiKey:$('apiKey').value,cookie:$('cookie').value})});await loadConfig();setState(r.authenticated?'Connected':'Saved, auth failed',r.authenticated?'good':'bad')}catch(e){setAuth(false,e.message);setState(e.message,'bad')}finally{setBusy(btn,false)}}
async function planUpload(){validateUpload();const btn=$('planBtn');setBusy(btn,true,'Planning');setState('Planning upload','busy');try{const r=await api('/api/plan',{method:'POST',body:JSON.stringify({filePath:$('filePath').value,chunkSize:$('chunkSize').value})});renderPlan(r);setState('Plan ready','good')}catch(e){setState(e.message,'bad');$('planOut').textContent=e.message}finally{setBusy(btn,false)}}
async function tryAutoConnect(){try{const defaults=[window.location.origin,'http://localhost:3000','http://127.0.0.1:3000'];for(const url of defaults){try{const r=await api('/api/probe-server',{method:'POST',body:JSON.stringify({url})});if(r&&r.key){await api('/api/config',{method:'POST',body:JSON.stringify({serverUrl:r.serverUrl||url,apiKey:r.key})});setState('Auto-connected','good');return true}}catch{}}return false}catch{return false}}
async function initDesktopMode(){if(window.vaultDesktop){document.body.classList.add('is-desktop');$('desktopStatus').textContent='Desktop mode · '+window.vaultDesktop.platform;$('desktopStatus').classList.add('good')}else{$('desktopStatus').textContent='Browser mode';}}
$('saveConfig').onclick=saveConfig;$('planBtn').onclick=planUpload;$('uploadBtn').onclick=()=>startUpload();$('browseBtn').onclick=chooseFile;$('filePath').addEventListener('input',updateButtons);$('refreshSessions').onclick=refreshSessions;$('refreshRemote').onclick=refreshRemote;$('refreshFolders').onclick=loadFolders;$('clientHelp').onclick=()=>$('planOut').textContent='npm run client -- upload --file <path>\\nnpm run client -- list\\nnpm run client -- status <taskId>';
initDesktopMode();loadConfig().then(c=>{if(!state.configured)tryAutoConnect().then(ok=>{if(ok){loadConfig();refreshSessions();refreshRemote()}})}).catch(e=>{setAuth(false,e.message);tryAutoConnect().then(ok=>{if(ok){loadConfig();refreshSessions();refreshRemote()}})});refreshSessions();refreshRemote();updateButtons();
</script></body></html>`;
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html());
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, safeConfig(configStore.load(), true));
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await readBody(req);
        const config = configStore.load();
        if (body.serverUrl) config.serverUrl = String(body.serverUrl).replace(/\/+$/, '');
        if (body.cookie) config.cookie = String(body.cookie);
        if (body.apiKey) config.apiKey = String(body.apiKey);
        configStore.save(config);
        const ok = await new VaultApi(config.serverUrl, { cookie: config.cookie, apiKey: config.apiKey }).checkAuth().catch(() => false);
        return json(res, 200, { ...safeConfig(config), authenticated: ok });
      }
      if (req.method === 'GET' && url.pathname === '/api/folders') {
        return json(res, 200, await getApi().listFolders());
      }
      if (req.method === 'POST' && url.pathname === '/api/plan') {
        const body = await readBody(req);
        const filePath = path.resolve(String(body.filePath || ''));
        const stat = fs.statSync(filePath);
        return json(res, 200, await getApi().plan(stat.size, parseInt(body.chunkSize, 10) || undefined));
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
      resolve({ server, url, host, port: resolvedPort });
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
