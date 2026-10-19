'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
let currentPage = 'overview';
let currentFilePath = '';
let editorPath = '';
let latestLogs = '';
let loadHistory = [];
const pageNames = {overview:'Overview',console:'Console',files:'File manager',backups:'Backups',players:'Players',schedules:'Schedules',metrics:'Metrics',settings:'Settings'};
const iconFor = (name) => ({directory:'▰',file:'▤',other:'◇'}[name] || '▤');

async function api(url, opts = {}) {
  const headers = {...(opts.headers || {})};
  if (!(opts.body instanceof FormData) && opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {...opts, headers, credentials:'same-origin'});
  if (res.status === 401 && !url.startsWith('/api/login')) { showLogin(); throw new Error('Your session expired. Please sign in again.'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(()=>({})) : await res.text();
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
function notice(message, bad = false) {
  const el = $('#globalNotice');
  if (!message) { el.classList.add('hidden'); el.textContent=''; return; }
  el.textContent = message; el.classList.remove('hidden');
  el.style.color = bad ? 'var(--red)' : 'var(--accent)';
  el.style.borderColor = bad ? '#683b49' : '#45643e';
}
function formatBytes(value) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) return '—';
  const n = Number(value); if (n < 1024) return `${n} B`;
  const units=['KB','MB','GB','TB']; let x=n/1024, i=0;
  while (x>=1024 && i<units.length-1) { x/=1024; i++; }
  return `${x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)} ${units[i]}`;
}
function duration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const d=Math.floor(seconds/86400), h=Math.floor(seconds%86400/3600), m=Math.floor(seconds%3600/60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function stamp(value) {
  const date=new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
function relativeStamp(value) {
  const date=new Date(value); if (Number.isNaN(date.getTime())) return '—';
  const secs=Math.max(0,Math.floor((Date.now()-date.getTime())/1000));
  if (secs<60) return 'just now'; if (secs<3600) return `${Math.floor(secs/60)}m ago`;
  if (secs<86400) return `${Math.floor(secs/3600)}h ago`; return `${Math.floor(secs/86400)}d ago`;
}
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
function showApp(username='admin') { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); $('#currentUser').textContent=username; go('overview'); }
function go(page) {
  if (!pageNames[page]) return;
  currentPage=page;
  $$('.page').forEach(p=>p.classList.toggle('active',p.id===`page-${page}`));
  $$('.nav-item[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
  $('#crumbPage').textContent=pageNames[page];
  $('#sidebar').classList.remove('open');
  notice('');
  refreshPage().catch(e=>notice(e.message,true));
}
async function loadStatus() {
  const d=await api('/api/status');
  const active=d.service==='active', missing=d.service==='not-installed';
  $('#sidebarServerPath').textContent=d.minecraftDir || '/opt/minecraft';
  $('#serverDirLine').textContent=`Working directory · ${d.minecraftDir || '/opt/minecraft'}`;
  $('#statusPill').innerHTML=`<i></i> ${active?'ONLINE':missing?'NOT CONFIGURED':String(d.service).toUpperCase()}`;
  $('#statusPill').className='status-pill '+(active?'online':missing?'bad':'');
  $('#statStatus').textContent=active?'Online':missing?'Setup required':'Offline';
  $('#statStatusHint').innerHTML=active?'<span class="tiny-dot"></span> Service running':missing?'<span class="tiny-dot"></span> minecraft.service not found':'<span class="tiny-dot"></span> Service not running';
  $('#serverStateBig').textContent=active?'Online':missing?'Not configured':'Offline';
  $('#serverStateSub').textContent=active?'Service is running':missing?'Create the Minecraft systemd service':'Service not running';
  $('#stateIndicator').classList.toggle('online',active);
  $('#overviewService').textContent=d.serviceName || 'systemd';
  $('#statMemory').textContent=d.memoryBytes ? formatBytes(d.memoryBytes) : '—';
  $('#memoryMeter').style.width=d.memoryBytes?'20%':'0%';
  $('#sidebarServerName').textContent='Minecraft Server';
  $('#consoleRconTag').textContent=d.rconConfigured?'RCON · configured':'RCON · not configured';
  $('#commandState').textContent=d.rconConfigured?'RCON credentials present':'RCON is not configured';
  $('#settingsRconStatus').textContent=d.rconConfigured?'Configured':'Not configured';
  $('#settingsRconStatus').className='status-pill '+(d.rconConfigured?'online':'bad');
  return d;
}
async function loadHost() {
  const d=await api('/api/host');
  const used=d.memory.usedPercent || 0;
  $('#statMemory').textContent=`${used}%`;
  $('#statMemoryHint').textContent=`${formatBytes(d.memory.usedBytes)} of ${formatBytes(d.memory.totalBytes)}`;
  $('#memoryMeter').style.width=`${Math.min(100,used)}%`;
  $('#hostLoad').textContent=(d.load?.[0] ?? 0).toFixed(2);
  $('#hostRam').textContent=`${used}% used`;
  $('#hostRamMeter').style.width=`${Math.min(100,used)}%`;
  $('#hostUptime').textContent=duration(d.uptimeSeconds);
  $('#hostCpuCount').textContent=`${d.cpuCount} CPU cores`;
  $('#hostPlatform').textContent=d.platform;
  $('#lastUpdated').textContent=new Date().toLocaleTimeString();
  $('#metricLoad').textContent=(d.load?.[0] ?? 0).toFixed(2);
  $('#metricCpuHint').textContent=`${d.cpuCount} logical CPU cores · 1 / 5 / 15 min`;
  $('#metricRam').textContent=`${used}%`;
  $('#metricRamHint').textContent=`${formatBytes(d.memory.usedBytes)} used of ${formatBytes(d.memory.totalBytes)}`;
  $('#metricDisk').textContent=d.disk ? `${d.disk.usedPercent}%` : '—';
  $('#metricDiskHint').textContent=d.disk ? `${formatBytes(d.disk.usedBytes)} used / ${formatBytes(d.disk.totalBytes)}` : 'Disk data unavailable';
  $('#statDisk').textContent=d.disk ? `${d.disk.usedPercent}%` : '—';
  $('#statDiskHint').textContent=d.disk ? `${formatBytes(d.disk.freeBytes)} free` : 'Server volume';
  $('#diskMeter').style.width=d.disk?`${Math.min(100,d.disk.usedPercent)}%`:'0%';
  $('#metricUptime').textContent=duration(d.uptimeSeconds);
  $('#memoryRingPct').textContent=`${used}%`;
  $('#memoryRing').style.background=`conic-gradient(var(--accent) ${used*3.6}deg,#253448 ${used*3.6}deg)`;
  $('#memoryUsedLegend').textContent=formatBytes(d.memory.usedBytes);
  $('#memoryFreeLegend').textContent=formatBytes(d.memory.freeBytes);
  $('#memoryTotalLegend').textContent=formatBytes(d.memory.totalBytes);
  loadHistory.push(Math.max(0,Math.min(100,(d.load?.[0] || 0)/Math.max(1,d.cpuCount)*100)));
  if (loadHistory.length>24) loadHistory=loadHistory.slice(-24);
  renderLoadChart();
  const bars=$$('#cpuBars i'); bars.forEach((el,i)=>{ const value=loadHistory[Math.max(0,loadHistory.length-bars.length+i)] ?? 4; el.style.height=`${Math.max(8,Math.min(95,value))}%`; });
  return d;
}
function renderLoadChart() {
  const area=$('#loadChart'); if (!loadHistory.length) return;
  const width=650,height=190, pad=8, max=Math.max(15,...loadHistory);
  const pts=loadHistory.map((v,i)=>`${pad+(i/Math.max(1,loadHistory.length-1))*(width-pad*2)},${height-pad-(v/max)*(height-pad*2)}`);
  const path=pts.join(' '); const areaPath=`${pad},${height-pad} ${path} ${width-pad},${height-pad}`;
  area.innerHTML=`<svg viewBox="0 0 ${width} ${height}" class="chart-svg" role="img" aria-label="Recent normalized CPU load samples"><defs><linearGradient id="loadFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#a7f36b" stop-opacity=".27"/><stop offset="100%" stop-color="#a7f36b" stop-opacity="0"/></linearGradient></defs>${[.25,.5,.75].map(y=>`<line x1="${pad}" y1="${height*y}" x2="${width-pad}" y2="${height*y}" stroke="#29384b" stroke-dasharray="3 5"/>`).join('')}<polygon points="${areaPath}" fill="url(#loadFill)"/><polyline points="${path}" fill="none" stroke="#a7f36b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${pts.length?`<circle cx="${pts[pts.length-1].split(',')[0]}" cy="${pts[pts.length-1].split(',')[1]}" r="4" fill="#a7f36b" stroke="#14202d" stroke-width="2"/>`:''}</svg>`;
}
async function loadLogs(overview=false) {
  const target=overview?'#overviewLogs':'#consoleLogs';
  try { const d=await api('/api/console'); latestLogs=(d.lines||[]).join('\n') || 'No service log entries yet.'; $(target).textContent=latestLogs; if (!overview) $('#terminalSubtitle').textContent=`journalctl · ${d.lines?.length || 0} lines · updated ${new Date().toLocaleTimeString()}`; }
  catch(e) { $(target).textContent=e.message; if (!overview) throw e; }
}
async function loadFiles() {
  const data=await api(`/api/files?path=${encodeURIComponent(currentFilePath)}`);
  $('#fileError').textContent=''; $('#fileCount').textContent=`${data.items.length} items`;
  const crumbs=[{name:'server root',path:''}]; let acc='';
  if (data.path) data.path.split(pathSep()).filter(Boolean).forEach(part=>{acc=acc?`${acc}/${part}`:part;crumbs.push({name:part,path:acc});});
  $('#breadcrumbs').innerHTML=crumbs.map((c,i)=>`${i?'<span>›</span>':''}<button data-path="${escapeAttr(c.path)}">${escapeHtml(c.name)}</button>`).join('');
  $$('#breadcrumbs button').forEach(b=>b.onclick=()=>{currentFilePath=b.dataset.path;loadFiles().catch(showFileError)});
  const rows=$('#fileRows'); rows.innerHTML='';
  if (!data.items.length) {rows.innerHTML='<div class="empty-state">This directory is empty.</div>';return;}
  for (const item of data.items) {
    const rel=currentFilePath?`${currentFilePath}/${item.name}`:item.name;
    const row=document.createElement('div');row.className='file-row';
    const name=document.createElement('button');name.className='file-name '+(item.type==='directory'?'dir':'');name.innerHTML=`<span class="file-glyph">${iconFor(item.type)}</span><span>${escapeHtml(item.name)}</span>`;
    name.onclick=()=>{if(item.type==='directory'){currentFilePath=rel;loadFiles().catch(showFileError);}else openEditor(rel).catch(e=>showFileError(e));};
    const type=document.createElement('span');type.className='file-type';type.textContent=item.type;
    const size=document.createElement('span');size.className='file-size';size.textContent=item.type==='file'?formatBytes(item.size):'—';
    const date=document.createElement('span');date.className='file-date';date.textContent=relativeStamp(item.modifiedAt);date.title=stamp(item.modifiedAt);
    const actions=document.createElement('div');actions.className='file-actions';
    if(item.type==='file') {const download=document.createElement('button');download.className='mini-action';download.textContent='Download';download.onclick=()=>downloadFile(rel);actions.append(download);}
    const del=document.createElement('button');del.className='mini-action';del.textContent='Delete';del.onclick=()=>deleteFile(rel,item.type);actions.append(del);
    row.append(name,type,size,date,actions);rows.append(row);
  }
}
function pathSep(){return '/';}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function escapeAttr(s){return escapeHtml(s).replace(/`/g,'&#96;');}
function showFileError(e){$('#fileError').textContent=e.message||String(e);}
async function openEditor(rel) {
  const d=await api(`/api/file?path=${encodeURIComponent(rel)}`); editorPath=rel;
  $('#editorTitle').textContent=rel;$('#editorContent').value=d.content;$('#editorMeta').textContent=`${formatBytes(d.size)} · 1 MiB text editor limit`;
  $('#editorError').textContent='';$('#editorModal').classList.remove('hidden');
}
async function saveEditor(){
  $('#editorError').textContent='Saving…';
  try {await api('/api/file',{method:'PUT',body:JSON.stringify({path:editorPath,content:$('#editorContent').value})});$('#editorError').textContent='Saved successfully.';setTimeout(()=>$('#editorModal').classList.add('hidden'),500);loadFiles().catch(showFileError);}
  catch(e){$('#editorError').textContent=e.message;}
}
async function downloadFile(rel){
  try {const res=await fetch(`/api/file/download?path=${encodeURIComponent(rel)}`,{credentials:'same-origin'});if(!res.ok)throw new Error((await res.json()).error||'Download failed');const blob=await res.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=rel.split('/').pop();a.click();URL.revokeObjectURL(a.href);}
  catch(e){showFileError(e);}
}
async function deleteFile(rel,type){if(!confirm(`Permanently delete ${type} “${rel}”?`))return;try{await api(`/api/files/item?path=${encodeURIComponent(rel)}`,{method:'DELETE'});notice(`Deleted ${rel}`);await loadFiles();}catch(e){showFileError(e);}}
async function loadBackups(){
  const [d,s]=await Promise.all([api('/api/backups'),api('/api/settings')]); const list=d.backups||[];
  $('#backupCount').textContent=list.length;$('#backupTotal').textContent=formatBytes(list.reduce((sum,x)=>sum+x.sizeBytes,0));$('#backupRemote').textContent=s.rcloneConfigured?'Configured':'Local only';
  const rows=$('#backupRows');rows.innerHTML='';$('#backupError').textContent='';
  if(!list.length){rows.innerHTML='<div class="empty-state">No backups found yet. Create your first snapshot when the Minecraft directory is ready.</div>';return;}
  for(const b of list){const row=document.createElement('div');row.className='backup-row';
    const name=document.createElement('div');name.className='backup-name';name.innerHTML=`<span class="backup-file-icon">◴</span><span><b>${escapeHtml(b.file)}</b><small>Compressed world snapshot</small></span>`;
    const date=document.createElement('span');date.className='backup-date subtle-line';date.textContent=stamp(b.createdAt);
    const size=document.createElement('span');size.className='file-size';size.textContent=formatBytes(b.sizeBytes);
    const actions=document.createElement('div');actions.className='backup-row-actions';const dl=document.createElement('button');dl.className='mini-action';dl.textContent='Download';dl.onclick=()=>downloadBackup(b.file);const del=document.createElement('button');del.className='mini-action';del.textContent='Delete';del.onclick=()=>deleteBackup(b.file);actions.append(dl,del);row.append(name,date,size,actions);rows.append(row);
  }
}
async function downloadBackup(file){try{const r=await fetch(`/api/backup/download?file=${encodeURIComponent(file)}`,{credentials:'same-origin'});if(!r.ok)throw new Error((await r.json()).error||'Download failed');const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=file;a.click();URL.revokeObjectURL(a.href);}catch(e){$('#backupError').textContent=e.message;}}
async function deleteBackup(file){if(!confirm(`Delete backup ${file}? This cannot be undone.`))return;try{await api(`/api/backup?file=${encodeURIComponent(file)}`,{method:'DELETE'});await loadBackups();}catch(e){$('#backupError').textContent=e.message;}}
function openBackupModal(){$('#backupModalError').textContent='';$('#backupModal').classList.remove('hidden');}
async function confirmBackup(){const b=$('#confirmBackup');b.disabled=true;b.textContent='Creating backup…';$('#backupModalError').textContent='';try{const d=await api('/api/backup',{method:'POST',body:JSON.stringify({suspend:true})});$('#backupModalError').textContent=`Created ${d.file} · ${formatBytes(d.sizeBytes)} · remote: ${d.drive}`;await loadBackups();}catch(e){$('#backupModalError').textContent=e.message;}finally{b.disabled=false;b.textContent='Create backup';}}
async function loadPlayers(){
  const d=await api('/api/players');$('#playersOnline').textContent=String(d.online);$('#playersMax').textContent=d.max==null?'—':String(d.max);$('#statPlayers').innerHTML=`${d.online} <small>/ ${d.max==null?'—':d.max}</small>`;$('#statPlayersHint').textContent='Reported through Minecraft RCON';
  const rows=$('#playerRows');rows.innerHTML='';
  if(!d.players.length){rows.innerHTML='<div class="empty-state">No one is online right now.</div>';return;}
  for(const p of d.players){const row=document.createElement('div');row.className='player-entry';row.innerHTML=`<div class="player-head">${escapeHtml(p.charAt(0).toUpperCase())}</div><div><b>${escapeHtml(p)}</b><small>Online now</small></div><button class="mini-action" style="margin-left:auto">Kick</button>`;row.querySelector('button').onclick=async()=>{if(!confirm(`Kick ${p}?`))return;try{const d=await api('/api/players/action',{method:'POST',body:JSON.stringify({action:'kick',player:p,reason:'Removed by server admin'})});$('#playerResult').textContent=d.response||'Kick command sent.';await loadPlayers();}catch(e){$('#playerResult').textContent=e.message;}};rows.append(row);}
}
async function playerAction(e){e.preventDefault();$('#playerResult').textContent='Sending command…';try{const d=await api('/api/players/action',{method:'POST',body:JSON.stringify({player:$('#playerName').value.trim(),action:$('#playerAction').value,reason:$('#playerReason').value.trim()})});$('#playerResult').textContent=d.response||'Action sent.';$('#playerName').value='';await loadPlayers().catch(()=>{});}catch(err){$('#playerResult').textContent=err.message;}}
async function loadTasks(){
  const d=await api('/api/tasks');const rows=$('#taskRows');rows.innerHTML='';
  if(!d.tasks.length){rows.innerHTML='<div class="empty-state">No schedules yet. Add one to automate your routine.</div>';}
  for(const t of d.tasks){const row=document.createElement('div');row.className='task-entry';row.innerHTML=`<div class="task-symbol">${t.action==='backup'?'◴':t.action==='restart'?'↻':t.action==='start'?'▶':'■'}</div><div class="task-body"><b>${escapeHtml(t.name)}</b><small><code>${escapeHtml(t.schedule)}</code> · ${escapeHtml(t.action)} · ${t.enabled?'enabled':'disabled'}</small></div><span class="task-enabled">${t.enabled?'ON':'OFF'}</span><button class="mini-action" data-delete="${escapeAttr(t.id)}">Delete</button>`;row.querySelector('button').onclick=async()=>{if(!confirm(`Delete schedule “${t.name}”?`))return;try{await api(`/api/tasks/${encodeURIComponent(t.id)}`,{method:'DELETE'});await loadTasks();}catch(e){$('#taskResult').textContent=e.message;}};rows.append(row);}
  await loadTaskRuns().catch(()=>{});
}
async function loadTaskRuns(){const d=await api('/api/task-runs');const rows=$('#taskRuns');rows.innerHTML='';if(!d.runs.length){rows.innerHTML='<div class="empty-state">No task executions recorded.</div>';return;}for(const t of d.runs){const row=document.createElement('div');row.className='task-run';row.innerHTML=`<b>${escapeHtml(t.name||t.id)}</b><span>${stamp(t.at)}</span><span>${escapeHtml(t.action)}</span><span class="${t.result==='success'?'success':'failed'}">${escapeHtml(t.result)}${t.error?': '+escapeHtml(t.error):''}</span>`;rows.append(row);}}
async function saveTask(e){e.preventDefault();$('#taskResult').textContent='Saving schedule…';try{await api('/api/tasks',{method:'POST',body:JSON.stringify({name:$('#taskName').value.trim(),action:$('#taskAction').value,schedule:$('#taskCron').value.trim(),enabled:$('#taskEnabled').checked})});$('#taskResult').textContent='Schedule saved.';$('#taskName').value='';await loadTasks();}catch(e){$('#taskResult').textContent=e.message;}}
async function loadSettings(){const d=await api('/api/settings');$('#settingsVersion').textContent=`v${d.version}`;$('#footerVersion').textContent=`v${d.version}`;$('#settingsGrid').innerHTML='';const items=[['Panel version',d.version],['Host name',d.hostname],['Operating system',d.platform],['Node.js',d.node],['Minecraft service',d.serviceName+'.service'],['Minecraft directory',d.minecraftDir],['Backup directory',d.backupDir],['RCON',d.rconConfigured?'Configured':'Not configured'],['RCON endpoint',`${d.rconHost}:${d.rconPort}`],['Remote backups',d.rcloneConfigured?'Configured':'Not configured'],['Timezone',d.timezone]];for(const [label,value] of items){const el=document.createElement('div');el.className='setting-item';el.innerHTML=`<span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b>`;$('#settingsGrid').append(el);}}
async function refreshPage(){
  notice('');
  if(currentPage==='overview') {await Promise.allSettled([loadStatus(),loadHost(),loadLogs(true)]);}
  else if(currentPage==='console'){await Promise.allSettled([loadStatus(),loadLogs(false)]);}
  else if(currentPage==='files'){await loadFiles();}
  else if(currentPage==='backups'){await loadBackups();}
  else if(currentPage==='players'){await loadPlayers();}
  else if(currentPage==='schedules'){await loadTasks();}
  else if(currentPage==='metrics'){await loadHost();}
  else if(currentPage==='settings'){await Promise.all([loadStatus(),loadSettings()]);}
}
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#loginError').textContent='';const data=new FormData(e.target);const button=e.target.querySelector('button');button.disabled=true;button.textContent='Signing in…';try{const d=await api('/api/login',{method:'POST',body:JSON.stringify({username:data.get('username'),password:data.get('password')})});e.target.reset();showApp(d.username||'admin');}catch(err){$('#loginError').textContent=err.message;}finally{button.disabled=false;button.innerHTML='Sign in <span>→</span>';}});
$('#logout').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST',body:'{}'});}catch{}showLogin();});
$$('.nav-item[data-page]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.page)));
$$('[data-goto]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.goto)));
$('#sidebarOpen').onclick=()=>$('#sidebar').classList.add('open');$('#sidebarClose').onclick=()=>$('#sidebar').classList.remove('open');
$('#refreshPage').onclick=()=>refreshPage().catch(e=>notice(e.message,true));$('#overviewRefresh').onclick=()=>refreshPage().catch(e=>notice(e.message,true));
$$('[data-action]').forEach(b=>b.addEventListener('click',async()=>{const action=b.dataset.action;if(action==='stop'&&!confirm('Stop the Minecraft service? Players will be disconnected.'))return;if(action==='restart'&&!confirm('Restart the Minecraft service? Players may be disconnected.'))return;notice(`${action[0].toUpperCase()+action.slice(1)} request in progress…`);$$('[data-action]').forEach(x=>x.disabled=true);try{await api(`/api/server/${action}`,{method:'POST',body:JSON.stringify({})});notice(`Server ${action} request completed.`);await loadStatus();}catch(e){notice(e.message,true);}finally{$$('[data-action]').forEach(x=>x.disabled=false);}}));
$('#consoleRefresh').onclick=()=>loadLogs(false).catch(e=>notice(e.message,true));$('#copyLogs').onclick=async()=>{try{await navigator.clipboard.writeText($('#consoleLogs').textContent);$('#commandState').textContent='Logs copied';}catch{$('#commandState').textContent='Clipboard permission denied';}};$('#clearView').onclick=()=>$('#consoleLogs').textContent='View cleared. Refresh to load service logs again.';
$('#commandForm').addEventListener('submit',async e=>{e.preventDefault();const command=$('#commandInput').value.trim();if(!command)return;$('#commandState').textContent='Sending…';try{const d=await api('/api/console/command',{method:'POST',body:JSON.stringify({command})});$('#consoleLogs').textContent+=`\n> ${command}\n${d.response||'(no response)'}\n`;$('#consoleLogs').scrollTop=$('#consoleLogs').scrollHeight;$('#commandInput').value='';$('#commandState').textContent='Command sent';}catch(err){$('#commandState').textContent=err.message;}});
$('#filesRefresh').onclick=()=>loadFiles().catch(showFileError);
$('#newFolder').onclick=async()=>{const name=prompt('New folder name:');if(!name)return;try{await api('/api/files/mkdir',{method:'POST',body:JSON.stringify({path:currentFilePath,name})});await loadFiles();}catch(e){showFileError(e);}};
$('#uploadInput').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;const form=new FormData();form.append('file',file);form.append('path',currentFilePath);$('#fileError').textContent=`Uploading ${file.name}…`;try{await api('/api/files/upload',{method:'POST',body:form});$('#fileError').textContent='Upload complete.';await loadFiles();}catch(err){showFileError(err);}finally{e.target.value='';}});
$('#saveEditor').onclick=saveEditor;$$('[data-close-modal]').forEach(b=>b.onclick=()=>$('#'+b.dataset.closeModal).classList.add('hidden'));$$('.modal-backdrop').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.add('hidden');}));
$('#createBackup').onclick=openBackupModal;$('#confirmBackup').onclick=confirmBackup;$('#backupsRefresh').onclick=()=>loadBackups().catch(e=>$('#backupError').textContent=e.message);
$('#playersRefresh').onclick=()=>loadPlayers().catch(e=>$('#playerResult').textContent=e.message);$('#playerActionForm').addEventListener('submit',playerAction);
$('#newTaskBtn').onclick=()=>{ $('#taskName').focus(); $('#taskName').scrollIntoView({behavior:'smooth',block:'center'}); };$('#taskForm').addEventListener('submit',saveTask);$('#tasksRefresh').onclick=()=>loadTasks().catch(e=>$('#taskResult').textContent=e.message);$('#runsRefresh').onclick=()=>loadTaskRuns().catch(e=>$('#taskResult').textContent=e.message);$('#metricsRefresh').onclick=()=>loadHost().catch(e=>notice(e.message,true));$('#settingsRefresh').onclick=()=>Promise.all([loadStatus(),loadSettings()]).catch(e=>notice(e.message,true));
api('/api/session').then(d=>showApp(d.username||'admin')).catch(()=>showLogin());
setInterval(()=>{if(!$('#app').classList.contains('hidden')&&currentPage==='overview')Promise.allSettled([loadStatus(),loadHost(),loadLogs(true)]);},10000);
