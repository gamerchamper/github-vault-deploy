// @ts-nocheck
// GitHub Vault Sync — 1:1 File Browser
// vaultSync is exposed by preload via contextBridge
var $=function(id){return document.getElementById(id)};
var esc=function(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};
var F=function(n){if(!n||n===0)return'0 B';var u=['B','KB','MB','GB','TB'],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return n.toFixed(i>0?1:0)+' '+u[i]};

var FILE_ICONS={folder:'📁',pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',ppt:'📊',pptx:'📊',
  jpg:'🖼️',jpeg:'🖼️',png:'🖼️',gif:'🖼️',webp:'🖼️',svg:'🖼️',bmp:'🖼️',ico:'🖼️',heic:'🖼️',
  mp4:'🎬',mkv:'🎬',webm:'🎬',avi:'🎬',mov:'🎬',m4v:'🎬',ts:'🎬',
  mp3:'🎵',flac:'🎵',wav:'🎵',ogg:'🎵',m4a:'🎵',aac:'🎵',opus:'🎵',wma:'🎵',
  zip:'📦',rar:'📦','7z':'📦',tar:'📦',gz:'📦',bz2:'📦',xz:'📦',
  js:'📜',ts:'📘',jsx:'📘',tsx:'📘',py:'🐍',html:'🌐',htm:'🌐',css:'🎨',scss:'🎨',less:'🎨',
  json:'📋',xml:'📋',csv:'📊',txt:'📝',md:'📝',log:'📝',yml:'📋',yaml:'📋',
  exe:'⚙️',msi:'⚙️',dll:'⚙️',bat:'⚙️',cmd:'⚙️',sh:'⚙️',ps1:'⚙️',
  iso:'💿',img:'💿',dmg:'💿',torrent:'🔗'};

function fileIcon(name,isFolder){if(isFolder)return FILE_ICONS.folder;var ext=(name||'').split('.').pop().toLowerCase();return FILE_ICONS[ext]||'📄'}
function previewType(name){var ext=(name||'').split('.').pop().toLowerCase();var imgs=['jpg','jpeg','png','gif','webp','svg','bmp','ico'];var vids=['mp4','mkv','webm','avi','mov','m4v','ts'];var auds=['mp3','flac','wav','ogg','m4a','aac','opus'];if(imgs.includes(ext))return'image';if(vids.includes(ext))return'video';if(auds.includes(ext))return'audio';if(ext==='pdf')return'pdf';if(['txt','md','log','csv','json','xml','yml','yaml','html','htm','css','js','ts','py','sh','bat','ps1'].includes(ext))return'text';return'other'}
function mimeForType(name){var t=previewType(name);if(t==='image')return'image/jpeg';if(t==='video')return'video/mp4';if(t==='audio')return'audio/mpeg';return'application/octet-stream'}
function statusBadge(s){var cls=s==='synced'?'synced':s==='remote_only'?'remote':['downloading','uploading','hashing'].includes(s)?'syncing':['error','conflict'].includes(s)?'error':'local';return'<span class="status-badge '+cls+'">'+s.replace(/_/g,' ')+'</span>'}

// State
var currentPath='/';
var currentView='files';
var allFiles=[];
var selectedFiles=new Set();
var viewMode='grid';
var currentFilter='all';
var syncing=false;
var previewIndex=-1;

function calcFolderSize(folderRelPath){
  var prefix=folderRelPath.replace(/\\/g,'/');
  if(!prefix.endsWith('/'))prefix+='/';
  var total=0;
  for(var i=0;i<allFiles.length;i++){
    var f=allFiles[i];
    if(!f.isFolder){
      var fp=f.localRelPath.replace(/\\/g,'/');
      if(fp.startsWith(prefix)){total+=f.size||0}
    }
  }
  return total;
}

// -- Login --
async function doLogin(){
  var u=($('loginUrl')||{}).value||'',k=($('loginKey')||{}).value||'';
  u=u.trim();k=k.trim();
  if(!u||!k){$('loginErr').textContent='Enter both fields';return}
  $('loginErr').textContent='Connecting...';
  await window.vaultSync.updateSettings({serverUrl:u,apiKey:k});
  var r=await window.vaultSync.testConnection(u,k);
  if(r.ok){
    $('login-screen').classList.add('hidden');
    $('app').style.display='flex';
    initApp();
  }else{
    $('loginErr').textContent=r.error||'Connection failed';
  }
}

// -- Init --
async function initApp(){
  var s=await window.vaultSync.getSettings();
  if(s.syncRootPath)await window.vaultSync.updateSettings({syncRootPath:s.syncRootPath});
  loadFiles();renderBreadcrumb();
  window.vaultSync.onSyncState(function(st){updateStatusUI(st)});
  window.vaultSync.onUploadProgress(function(p){if($('qPbar'))$('qPbar').style.width=p.percent+'%';if($('qText'))$('qText').textContent=p.status+': '+p.localRelPath});
  window.vaultSync.onLog(function(l){/* quiet */});
}

// -- File loading --
async function loadFiles(){
  showLoading(true);
  try{
    var files=await window.vaultSync.getFileTree();
    allFiles=files||[];
  }catch(e){console.error(e)}
  renderFiles();
  renderFolders();
  updateSidebar();
  showLoading(false);
}

function showLoading(v){
  var s=$('loadingSpinner');
  var g=$('fileGrid');
  var e=$('emptyState');
  if(s) s.classList.toggle('hidden',!v);
  if(v){
    if(g) g.innerHTML='';
    if(e) e.classList.add('hidden');
  }
}

// -- Render files --
function renderFiles(){
  var grid=$('fileGrid'),empty=$('emptyState'),load=$('loadingSpinner');
  if(load) load.classList.add('hidden');
  var files=filterFiles(allFiles);
  if(!files.length){
    grid.innerHTML='';
    if(empty) empty.classList.remove('hidden');
    $('barInfo').textContent='0 items';
  }else{
    if(empty) empty.classList.add('hidden');
    grid.className='file-grid'+(viewMode==='list'?' list':'');
    grid.innerHTML='';
    files.forEach(function(f){grid.appendChild(createFileEl(f))});
    $('barInfo').textContent=files.length+' item'+(files.length!==1?'s':'');
  }
}

function filterFiles(files){
  return files.filter(function(f){
    var fp=f.localRelPath.replace(/\\/g,'/');
    var normPath=currentPath.replace(/\\/g,'/');
    if(normPath.charAt(0)==='/')normPath=normPath.slice(1);
    if(normPath===''){
      if(fp.indexOf('/')>=0)return false;
    }else{
      if(fp===normPath)return false;
      if(fp.indexOf(normPath)!==0)return false;
      var remainder=fp.slice(normPath.length);
      if(remainder.charAt(0)!=='/')return false;
      if(remainder.slice(1).indexOf('/')>=0)return false;
    }
    if(currentFilter==='all')return true;
    if(currentFilter==='synced')return f.syncStatus==='synced';
    if(currentFilter==='remote')return f.syncStatus==='remote_only';
    var t=previewType(f.name||f.localRelPath);
    if(currentFilter==='folder')return f.isFolder;
    return t===currentFilter;
  });
}

function createFileEl(f){
  var el=document.createElement('div');el.className='file-item';el.setAttribute('data-path',f.localRelPath);el.setAttribute('data-id',f.fileId||'');
  if(f.isFolder){
    el.setAttribute('data-folder','1');
    el.addEventListener('dblclick',function(e){e.stopPropagation();navTo(f.localRelPath.replace(/\\/g,'/'))});
  }else{
    el.addEventListener('dblclick',function(e){e.stopPropagation();openPreview(f)});
  }
  el.addEventListener('click',function(e){if(e.ctrlKey||e.metaKey){e.stopPropagation();toggleSelect(f,el)}else if(!f.isFolder){selectSingle(f,el)}});
  el.addEventListener('contextmenu',function(e){e.preventDefault();e.stopPropagation();showCtxMenu(e,f)});
  el.draggable=true;el.addEventListener('dragstart',function(e){e.dataTransfer.setData('text/plain',f.localRelPath)});

  var iconWrap=document.createElement('div');iconWrap.className='file-icon-wrap';
  var iconEl=document.createElement('div');iconEl.className='file-icon';iconEl.textContent=fileIcon(f.name||f.localRelPath,f.isFolder);
  iconWrap.appendChild(iconEl);el.appendChild(iconWrap);

  var nameEl=document.createElement('div');nameEl.className='file-name';nameEl.textContent=f.name||f.localRelPath.split(/[\\/]/).pop();el.appendChild(nameEl);

  var meta=document.createElement('div');meta.className='file-meta';
  var displaySize=f.isFolder?calcFolderSize(f.localRelPath):f.size;
  var sizeEl=document.createElement('span');sizeEl.className='file-size';sizeEl.textContent=F(displaySize);meta.appendChild(sizeEl);
  if(f.syncStatus!=='synced'){meta.innerHTML+=statusBadge(f.syncStatus)}
  if(f.syncStatus==='remote_only'&&!f.isFolder&&f.fileId){var btn=document.createElement('button');btn.className='btn-secondary';btn.style.cssText='font-size:10px;padding:2px 6px;margin-top:2px';btn.textContent='⬇ Download';btn.onclick=function(e){e.stopPropagation();downloadFile(f)};meta.appendChild(btn)}
  el.appendChild(meta);
  return el
}

function toggleSelect(f,el){if(selectedFiles.has(f.localRelPath)){selectedFiles.delete(f.localRelPath);el.classList.remove('selected')}else{selectedFiles.add(f.localRelPath);el.classList.add('selected')};updateSelInfo()}
function selectSingle(f,el){deselectAll();selectedFiles.add(f.localRelPath);el.classList.add('selected');updateSelInfo()}
function deselectAll(){document.querySelectorAll('.file-item.selected').forEach(function(e){e.classList.remove('selected')});selectedFiles.clear();updateSelInfo()}
function updateSelInfo(){var c=selectedFiles.size;var si=$('selInfo');if(si){si.textContent=c>0?c+' selected':'';si.classList.toggle('visible',c>0)}}

// -- Navigation --
function navUp(){var p=currentPath.replace(/[\\/]/g,'/').replace(/\/$/,'').split('/');p.pop();currentPath=p.join('/')||'/';loadFiles();renderBreadcrumb()}
function navTo(pth){
  var normalized=pth.replace(/\\/g,'/').replace(/^\//,'');
  currentPath=normalized||'/';
  loadFiles();renderBreadcrumb()
}
function renderBreadcrumb(){
  var bc=$('breadcrumb');if(!bc)return;
  var parts=currentPath.replace(/[\\/]/g,'/').replace(/\/$/,'').split('/').filter(Boolean);
  var html='<span onclick="navTo(\'/\')">📦 Vault</span>';
  var acc='';
  parts.forEach(function(p,i){
    acc+='/'+p;html+='<span class="sep">/</span>';
    if(i===parts.length-1)html+='<span class="current">'+esc(p)+'</span>';
    else html+='<span onclick="navTo(\''+esc(acc)+'\')">'+esc(p)+'</span>';
  });
  bc.innerHTML=html||'<span class="current">📦 Vault</span>'
}

function renderFolders(){
  var tree=$('folderTree');if(!tree)return;
  var folders=allFiles.filter(function(f){return f.isFolder}).map(function(f){return f.localRelPath.replace(/[\\/]/g,'/')});
  folders.sort();
  tree.innerHTML=folders.map(function(f){var name=f.split('/').filter(Boolean).pop()||f;return'<div class="sr" onclick="navTo(\''+esc(f)+'\')"><span>📁 '+esc(name)+'</span></div>'}).join('')||'<div style="font-size:11px;color:var(--text-muted);padding:4px 8px">No folders</div>'
}

// -- Sort --
function sortByName(){allFiles.sort(function(a,b){return(a.name||'').localeCompare(b.name||'')});renderFiles()}
function sortBySize(){allFiles.sort(function(a,b){return b.size-a.size});renderFiles()}

// -- Filters --
function setFilter(f,el){
  currentFilter=f;document.querySelectorAll('.filter-chips .chip').forEach(function(c){c.classList.remove('active')});
  if(el)el.classList.add('active');renderFiles()
}

// -- Search --
var searchTimer;
function doSearch(q){
  clearTimeout(searchTimer);
  searchTimer=setTimeout(function(){
    currentFilter='all';
    if(q&&q.length>0){allFiles=allFiles.filter(function(f){return(f.name||'').toLowerCase().includes(q.toLowerCase())||f.localRelPath.toLowerCase().includes(q.toLowerCase())});renderFiles()}
    else{loadFiles()}
  },300);
}

// -- View mode --
function toggleViewMode(){viewMode=viewMode==='grid'?'list':'grid';$('btnGridList').textContent=viewMode==='grid'?'⊞ Grid':'☰ List';renderFiles()}

// -- Preview --
function openPreview(f){
  if(!f.fileId){return}
  var pt=previewType(f.name||f.localRelPath);
  var panel=$('previewPanel'),body=$('previewBody'),title=$('previewTitle');
  panel.classList.remove('hidden');title.textContent=f.name||'';
  body.innerHTML='';
  previewIndex=allFiles.findIndex(function(x){return x===f});

  var s=null;window.vaultSync.getSettings().then(function(result){s=result});
  var url='';window.vaultSync.getSettings().then(function(st){url=st.serverUrl});

  if(pt==='image'){var img=document.createElement('img');img.src=url.replace(/\/$/,'')+'/api/files/stream/'+f.fileId;img.style.maxHeight='90vh';img.onerror=function(){body.innerHTML='<div class="no-preview"><div class="ico">🖼️</div>Failed to load</div>'};body.appendChild(img)}
  else if(pt==='video'){var v=document.createElement('video');v.src=url.replace(/\/$/,'')+'/api/files/stream/'+f.fileId;v.controls=true;v.autoplay=true;v.style.maxHeight='90vh';body.appendChild(v)}
  else if(pt==='audio'){var a=document.createElement('audio');a.src=url.replace(/\/$/,'')+'/api/files/stream/'+f.fileId;a.controls=true;a.autoplay=true;body.appendChild(a)}
  else if(pt==='pdf'){body.innerHTML='<iframe src="'+url.replace(/\/$/,'')+'/api/files/view/'+f.fileId+'"></iframe>'}
  else{body.innerHTML='<div class="no-preview"><div class="ico">📄</div><p>'+esc(f.name)+'</p><p style="font-size:12px">'+F(f.size)+' — '+f.syncStatus+'</p></div>'}
}
function navPreview(dir){if(previewIndex<0)return;var i=previewIndex+dir;if(i<0||i>=allFiles.length)return;var f=allFiles[i];if(f&&!f.isFolder)openPreview(f)}
function closePreview(){var panel=$('previewPanel');panel.classList.add('hidden');$('previewBody').innerHTML='';previewIndex=-1}
document.addEventListener('keydown',function(e){if(e.key==='Escape'){closePreview();$('settingsModal').classList.add('hidden');deselectAll()}});

// -- Context menu --
function showCtxMenu(e,f){
  var menu=$('ctxMenu');
  var q=esc(f.localRelPath);
  var items=[];
  if(f.isFolder){items.push('<div class="mi" onclick="navTo(\''+esc(f.localRelPath.replace(/\\\\/g,'/'))+'\');hideCtx()">📁 Open</div>')}
  else{
    items.push('<div class="mi" onclick="openPreview(allFiles.find(function(x){return x.localRelPath===\''+q+'\'}));hideCtx()">👁 Preview</div>');
    if(f.syncStatus==='remote_only'&&f.fileId) items.push('<div class="mi" onclick="downloadFile(allFiles.find(function(x){return x.localRelPath===\''+q+'\'}));hideCtx()">⬇ Download</div>');
    if(f.syncStatus==='synced') items.push('<div class="mi" onclick="openPreview(allFiles.find(function(x){return x.localRelPath===\''+q+'\'}));hideCtx()">👁 Open</div>');
  }
  items.push('<div class="sep"></div>');
  var explorerPath=(window.syncRoot||'')+'\\'+f.localRelPath.split('/').join('\\');
  items.push('<div class="mi" onclick="window.vaultSync.openFolder(\''+esc(explorerPath)+'\');hideCtx()">📂 Show in Explorer</div>');
  items.push('<div class="sep"></div>');
  items.push('<div class="mi" onclick="refreshAll();hideCtx()">🔄 Refresh</div>');
  menu.innerHTML=items.join('');
  menu.style.display='block';menu.style.left=e.clientX+'px';menu.style.top=e.clientY+'px';
}
function hideCtx(){$('ctxMenu').style.display='none'}
document.addEventListener('click',function(){hideCtx()});

// -- Download --
async function downloadFile(f){if(!f||!f.fileId)return;$('titleStatus').textContent='Downloading '+f.name+'...';
  var r=await window.vaultSync.downloadFile(f.fileId,f.localRelPath);
  $('titleStatus').textContent=r.ok?'Downloaded '+F(r.size||0):'Download failed';setTimeout(refreshAll,1500)}

// -- Drop --
function onDrop(e){e.preventDefault();var files=e.dataTransfer.files;if(!files.length)return;for(var i=0;i<files.length;i++){var f=files[i];console.log('Drop:',f.name,f.size)}refreshAll()}
var dragCounter=0;var fileView=$('fileView');if(fileView){fileView.addEventListener('dragenter',function(){dragCounter++;$('dropOverlay').classList.add('active')});fileView.addEventListener('dragleave',function(){dragCounter--;if(dragCounter<=0){dragCounter=0;$('dropOverlay').classList.remove('active')}});fileView.addEventListener('drop',function(){dragCounter=0;$('dropOverlay').classList.remove('active')})}

// -- Sync toggle --
async function toggleSync(){syncing=!syncing;var b=$('btnStartSync');b.textContent=syncing?'⏸ Stop':'▶ Start';refreshAll()}

// -- Toolbar --
function handleOpenFolder(){window.vaultSync.getSettings().then(function(s){if(s.syncRootPath)window.vaultSync.openFolder(s.syncRootPath)})}
function handleRefresh(){refreshAll()}

// -- Refresh --
async function refreshAll(){await loadFiles();updateSidebar()}
function updateSidebar(){
  var total=allFiles.length;var synced=allFiles.filter(function(f){return f.syncStatus==='synced'}).length;
  var pending=allFiles.filter(function(f){return f.syncStatus!=='synced'&&!f.isFolder}).length;
  setText('sTotal',String(total));setText('sSynced',String(synced));setText('sPending',String(pending));
}
function updateStatusUI(st){
  setText('titleStatus',st.status==='syncing'?'Syncing...':st.status==='error'?'Offline':'Ready');
  var d=$('connDot');if(d)d.className='dot'+(st.status==='error'?' off':'');
  setText('sStatus',st.status);setText('barLastSync',st.lastSyncAt?'Last sync: '+new Date(st.lastSyncAt).toLocaleTimeString():'');
}
function setText(id,t){var e=$(id);if(e)e.textContent=t}

// -- Settings --
function openSettings(){window.vaultSync.getSettings().then(function(s){$('setUrl').value=s.serverUrl||'';$('setKey').value=s.apiKey||'';$('setFolder').value=s.syncRootPath||'';$('settingsModal').classList.remove('hidden');$('setStatus').textContent=''})}
function closeSettings(){$('settingsModal').classList.add('hidden')}
async function saveSettings(){
  var p={serverUrl:$('setUrl').value.trim(),apiKey:$('setKey').value.trim(),syncRootPath:$('setFolder').value.trim()};
  await window.vaultSync.updateSettings(p);$('settingsModal').classList.add('hidden');
  var r=await window.vaultSync.testConnection(p.serverUrl,p.apiKey);
  $('setStatus').textContent=r.ok?'✓ Connected':'✗ '+r.error;refreshAll()
}
async function browseFolder(){var f=await window.vaultSync.pickFolder();if(f)$('setFolder').value=f}

// -- Boot --
window.vaultSync.getSettings().then(function(s){
  window.syncRoot=s.syncRootPath;
  if(s.serverUrl&&s.apiKey){
    $('login-screen').classList.add('hidden');
    $('app').style.display='flex';
    initApp();
  }
});
// Don't call refreshAll here - initApp handles it above
