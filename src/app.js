import { Workspace, normalizePath, MAX_FILE_SIZE, MAX_PROJECT_SIZE } from './core/workspace.js';
import { CodeEditor } from './editor/editor.js';
import { AnalysisService } from './core/analysis.js';
import { Runtime, instrumentTrace } from './core/runtime.js';
import { findMatches, lineDiff } from './core/search.js';
import { download, createZip } from './core/zip.js';
import { LANGUAGE_LABEL } from './core/languages.js';
import { demoWorkspace, newWorkspace } from './demo.js';
import { icon, fileIcon } from './icons.js';

const $=selector=>document.querySelector(selector);
const $$=selector=>[...document.querySelectorAll(selector)];
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function hydrate(root=document){root.querySelectorAll('[data-icon]:not([data-hydrated])').forEach(el=>{el.insertAdjacentHTML('afterbegin',icon(el.dataset.icon));el.dataset.hydrated='true';});}
hydrate();
let settings={theme:'dark',fontSize:14,tabSize:4,minimap:true,accessible:false,liveReload:false};
try{const stored=JSON.parse(localStorage.getItem('forge-settings')||'{}');settings={...settings,...stored};}catch{}
settings.theme=['dark','light'].includes(settings.theme)?settings.theme:'dark';settings.fontSize=Math.min(24,Math.max(10,Number(settings.fontSize)||14));settings.tabSize=[2,4,8].includes(settings.tabSize)?settings.tabSize:4;
document.documentElement.dataset.theme=settings.theme;
const workspace=new Workspace(),editor=new CodeEditor($('#editor'),{...settings,forceCanvas:new URLSearchParams(location.search).has('canvas')});
const runtime=new Runtime();let analysis;
try{analysis=new AnalysisService();}catch(e){toast('Language worker could not start: '+e.message,'error');}
let loading=true,activePanel='output',sidebarMode='explorer',previewVisible=false,previewRunning=false,traceSession=null;
let closedFolders=new Set(),solutionCollapsed=false,paletteMode='commands',paletteItems=[],paletteIndex=0;
let output=[],testResults=[],lastPersisted=null,searchTimer=null,liveTimer=null,modalCloseCallback=null;
const commandMap=new Map(),terminalHistory=[];let historyIndex=0;

function toast(message,type='info'){
  const element=document.createElement('div');element.className='toast '+type;element.innerHTML=icon(type==='error'?'error':'info')+`<span>${escape(message)}</span>`;
  $('#toasts').append(element);while($('#toasts').children.length>4)$('#toasts').firstChild.remove();setTimeout(()=>element.remove(),6500);
}
function log(message,level='info',channel='system'){
  output.push({time:new Date().toLocaleTimeString('en-GB'),message:String(message),level,channel});if(output.length>800)output.shift();renderOutput();
}
function renderOutput(){
  const filter=$('#output-filter').value,rows=output.filter(r=>filter==='all'||r.channel===filter).slice(-250),element=$('#output-lines');
  const atEnd=element.scrollHeight-element.scrollTop-element.clientHeight<50;
  element.innerHTML=rows.map(r=>`<div class="log-line ${escape(r.level)}"><span class="log-time">${r.time}</span><span class="log-icon">${icon(({success:'check',error:'error',warn:'warning',result:'chevron'})[r.level]||'chevron')}</span><span class="log-message">${escape(r.message)}</span></div>`).join('');
  if(atEnd)element.scrollTop=element.scrollHeight;
}
function status(message='Ready',busy=false){$('#status-message').textContent=message;$('.statusbar').classList.toggle('busy',busy);}
function panel(name){
  activePanel=name;$('#main-workspace').classList.remove('panel-hidden');
  $$('.panel-tab').forEach(el=>el.classList.toggle('active',el.dataset.panel===name));
  $$('.panel-content').forEach(el=>el.classList.toggle('hidden',el.id!==name+'-panel'));
  if(name==='changes')renderChanges();if(name==='problems')renderProblems();if(name==='terminal')$('#terminal-input').focus();
}
function selectActivity(command){$$('.activity').forEach(el=>el.classList.toggle('active',el.dataset.command===command));}
function editorActive(){
  editor.setDocument(workspace.active);renderTabs();renderTree();renderProperties();updateSelection();renderSupport();renderChanges();
  $('#title-project').textContent=workspace.name;document.title=`${workspace.active?.path.split('/').pop()||workspace.name} — Forge Studio`;
  $('#startup-project').textContent=previewEntry()?.split('/')[0]?.replace('index.html',workspace.name)||workspace.name;
  if(workspace.active){analysis?.schedule(workspace.active);editor.focus();}
  $('#find-bar').classList.add('hidden');editor.findMatches=[];
}
function renderTabs(){
  const tabs=$('#document-tabs');tabs.replaceChildren();
  for(const path of workspace.tabs){const doc=workspace.files.get(path);if(!doc)continue;
    const el=document.createElement('div');el.className='document-tab'+(path===workspace.activePath?' active':'')+(doc.dirty?' dirty':'');el.role='tab';el.tabIndex=path===workspace.activePath?0:-1;el.setAttribute('aria-selected',path===workspace.activePath);el.title=path;el.draggable=true;
    el.innerHTML=fileIcon(path)+`<span>${escape(path.split('/').pop())}</span>${doc.dirty?'<span class="dirty-dot"></span>':''}<button class="tab-close" title="Close file" aria-label="Close ${escape(path.split('/').pop())}">${icon('close')}</button>`;
    el.addEventListener('click',e=>{if(!e.target.closest('.tab-close'))workspace.open(path);});
    el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();workspace.open(path);}});
    el.querySelector('.tab-close').addEventListener('click',e=>{e.stopPropagation();workspace.close(path);});
    el.addEventListener('auxclick',e=>{if(e.button===1){e.preventDefault();workspace.close(path);}});
    el.addEventListener('dragstart',e=>e.dataTransfer.setData('application/forge-tab',path));el.addEventListener('dragover',e=>e.preventDefault());
    el.addEventListener('drop',e=>{e.preventDefault();const from=e.dataTransfer.getData('application/forge-tab');if(!workspace.tabs.includes(from))return;workspace.tabs=workspace.tabs.filter(p=>p!==from);workspace.tabs.splice(workspace.tabs.indexOf(path),0,from);renderTabs();workspace.scheduleSave();});
    tabs.append(el);
  }
  const tools=document.createElement('div');tools.className='tabs-end';tools.innerHTML=`<button class="icon-button" data-command="quickOpen" title="Open a file (Ctrl+P)">${icon('down')}</button>`;tabs.append(tools);
  const segments=(workspace.activePath||'Workspace').split('/');
  $('#breadcrumbs').innerHTML=segments.map((s,i)=>(i?icon('chevron'):'')+`<span class="${i===segments.length-1?'crumb-current':''}">${escape(s)}</span>`).join('');
}
function renderTree(){
  if(sidebarMode==='search')return;
  const tree=$('#file-tree');tree.replaceChildren();
  if(sidebarMode==='outline'){
    const symbols=workspace.active?.symbols||[];
    for(const symbol of symbols){const row=document.createElement('button');row.className='outline-row';row.innerHTML=icon(symbol.kind==='class'?'class':'code')+`<span>${escape(symbol.name)}</span><small>${symbol.line+1}</small>`;row.onclick=()=>editor.goto(symbol.line,symbol.column);tree.append(row);}
    if(!symbols.length)tree.innerHTML='<div class="panel-empty">No symbols found in this file.</div>';return;
  }
  const query=$('#tree-search').value.trim().toLowerCase(),root={children:new Map()},paths=[...workspace.files.keys()].filter(p=>p.toLowerCase().includes(query));
  for(const path of paths){let node=root;const parts=path.split('/');parts.forEach((part,i)=>{if(!node.children.has(part))node.children.set(part,{name:part,path:parts.slice(0,i+1).join('/'),children:new Map(),file:i===parts.length-1});node=node.children.get(part);});}
  const solution=document.createElement('div');solution.className='tree-row solution';solution.role='treeitem';solution.setAttribute('aria-expanded',!solutionCollapsed);solution.style.paddingLeft='8px';solution.tabIndex=0;
  solution.innerHTML=`<span class="tree-arrow">${icon(solutionCollapsed?'chevron':'down')}</span><span class="tree-folder-icon">${icon('layout')}</span><span class="tree-label">Solution '${escape(workspace.name)}'</span>`;
  solution.onclick=()=>{solutionCollapsed=!solutionCollapsed;renderTree();};solution.onkeydown=e=>{if(e.key==='Enter')solution.click();};tree.append(solution);
  if(!solutionCollapsed||query){
    const append=(node,depth)=>{
      const children=[...node.children.values()].sort((a,b)=>Number(a.file)-Number(b.file)||a.name.localeCompare(b.name));
      for(const child of children){
        const row=document.createElement('div'),isProject=!child.file&&depth===0,expanded=!closedFolders.has(child.path)||!!query;
        row.className='tree-row'+(child.file?'':' folder')+(isProject?' project':'')+(child.path===workspace.activePath?' active':'');row.role='treeitem';row.tabIndex=0;row.title=child.path;row.dataset.path=child.path;row.style.paddingLeft=`${15+depth*15}px`;
        if(!child.file)row.setAttribute('aria-expanded',expanded);
        row.innerHTML=`<span class="tree-arrow">${child.file?'':icon(expanded?'down':'chevron')}</span>${child.file?fileIcon(child.path):`<span class="tree-folder-icon">${icon(isProject?'cube':'folder')}</span>`}<span class="tree-label">${escape(child.name)}</span>${workspace.files.get(child.path)?.dirty?'<span class="tree-dirty">●</span>':''}`;
        row.onclick=()=>{if(child.file)workspace.open(child.path);else{expanded?closedFolders.add(child.path):closedFolders.delete(child.path);renderTree();}};
        row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();row.click();}else if(e.key==='ArrowDown'){e.preventDefault();row.nextElementSibling?.focus();}else if(e.key==='ArrowUp'){e.preventDefault();row.previousElementSibling?.focus();}};
        row.oncontextmenu=e=>{e.preventDefault();if(child.file)workspace.open(child.path);showMenu(child.file?['newFile','rename','deleteFile','-','exportFile','revealActive']:['newFile','openFolder','collapseTree'],e.clientX,e.clientY);};
        tree.append(row);if(!child.file&&expanded)append(child,depth+1);
      }
    };append(root,0);
  }
  $('#file-count').textContent=`${workspace.files.size} files`;
}
function renderProperties(){
  const doc=workspace.active;if(!doc){$('#properties-file').textContent='No file selected';$('#file-properties').replaceChildren();return;}
  $('#properties-file').innerHTML=fileIcon(doc.path)+`<span>${escape(doc.path.split('/').pop())}</span>`;
  const pairs=[['Build action',doc.language==='csharp'?'Source · edit only':doc.language==='javascript'?'JavaScript module':'Content'],['Language',LANGUAGE_LABEL[doc.language]],['Characters',doc.buffer.length.toLocaleString()],['Lines',doc.buffer.lineCount.toLocaleString()],['Encoding','UTF-8'],['Location',workspace.handles.has(doc.path)?'Local file + browser':'Browser workspace']];
  $('#file-properties').innerHTML=pairs.map(([key,value])=>`<dt>${escape(key)}</dt><dd title="${escape(value)}">${escape(value)}</dd>`).join('');
}
function updateSelection(){
  const doc=workspace.active;if(!doc)return;const pos=doc.buffer.positionAt(doc.selection.head),selection=Math.abs(doc.selection.head-doc.selection.anchor);
  $('#cursor-status').textContent=`Ln ${pos.line+1}, Col ${pos.column+1}${selection?' ('+selection+' selected)':''}`;
  $('#language-status').textContent=LANGUAGE_LABEL[doc.language];$('#eol-status').textContent=doc.eol==='\r\n'?'CRLF':'LF';
  const symbol=doc.symbols.filter(s=>s.line<=pos.line).at(-1);$('#current-symbol').textContent=symbol?.name||doc.path.split('/').pop();
}
function renderSupport(){
  const doc=workspace.active;if(!doc)return;
  const support=doc.language==='javascript'?'JavaScript · parser diagnostics':doc.language==='json'?'JSON · parser diagnostics':`${LANGUAGE_LABEL[doc.language]} · syntax editing`;
  $('#document-support').textContent=support;
  $('#file-health').textContent=doc.diagnostics.length?`${doc.diagnostics.length} syntax error${doc.diagnostics.length===1?'':'s'}`:['javascript','json'].includes(doc.language)?'No syntax errors':'Syntax highlighting';
  $('#file-health').previousElementSibling.style.background=doc.diagnostics.length?'var(--red)':'var(--green)';
}
function renderProblems(){
  const diagnostics=[...workspace.files.values()].flatMap(d=>d.diagnostics.map(e=>({...e,path:d.path})));
  $('#problem-count').textContent=diagnostics.length;$('#status-errors').textContent=diagnostics.length;
  $('#problems-summary').textContent=`${diagnostics.length} error${diagnostics.length===1?'':'s'} · JavaScript and JSON syntax analysis. Other languages are not compiled.`;
  const target=$('#problems-list');target.replaceChildren();
  for(const d of diagnostics){const row=document.createElement('button');row.className='problem-row';row.innerHTML=icon('error')+`<span>${escape(d.message)}</span><span>${escape(d.path.split('/').pop())}</span><span>Ln ${d.line+1}</span>`;row.onclick=()=>{workspace.open(d.path);editor.goto(d.line,d.column);};target.append(row);}
  if(!diagnostics.length)target.innerHTML='<div class="panel-empty">No JavaScript or JSON syntax errors in analyzed files.</div>';
  renderSupport();editor.invalidate();
}
function renderChanges(){
  const changes=workspace.changes();$('#change-count').textContent=changes.length;$('#changes-badge').textContent=changes.length;$('#changes-badge').classList.toggle('hidden',!changes.length);
  if(activePanel!=='changes')return;
  const target=$('#changes-list');target.replaceChildren();
  for(const change of changes){const row=document.createElement('div');row.className='change-row';row.innerHTML=`<button>${fileIcon(change.path)}<span>${escape(change.path)}</span><span>${escape(change.kind.toUpperCase())}</span></button><button class="icon-button" title="Revert local change">${icon('undo')}</button>`;row.children[0].onclick=()=>showDiff(change);row.children[1].onclick=()=>confirmDialog('Revert local change?',`This restores <strong>${escape(change.path)}</strong> to the local baseline. No disk files are changed until you explicitly save.`,'Revert',()=>revertChange(change));target.append(row);}
  if(!changes.length)target.innerHTML='<div class="panel-empty">Your workspace matches the local baseline. Start editing to see a diff here.</div>';
}
function revertChange(change){
  if(change.kind==='added')workspace.delete(change.path);
  else if(change.kind==='deleted'){workspace.add(change.path,change.before);workspace.open(change.path);workspace.scheduleSave();}
  else{const doc=workspace.files.get(change.path);doc.edit(0,doc.buffer.length,change.before);}
  renderChanges();renderTree();renderTabs();
}
function showDiff(change){const rows=lineDiff(change.before,change.after);showDialog('Changes · '+change.path.split('/').pop(),`<p>Local baseline → current document. ${rows.filter(x=>x.kind==='added').length} added lines, ${rows.filter(x=>x.kind==='removed').length} removed lines.</p><div class="diff-view">${rows.slice(0,4000).map(row=>`<div class="diff-row ${row.kind}"><span class="diff-number">${row.oldLine||''}</span><span class="diff-number">${row.newLine||''}</span><span>${row.kind==='added'?'+':row.kind==='removed'?'−':' '}</span><span>${escape(row.text)||' '}</span></div>`).join('')}</div>${rows.length>4000?'<p>Display limited to 4,000 diff rows. Export the project for the full file.</p>':''}`,[{label:'Close',run:closeModal}]);}
function showSidebar(mode='explorer'){
  sidebarMode=mode;$('#right-sidebar').classList.add('mobile-visible');$('#right-sidebar').style.display='';
  if(innerWidth>790){$('#workbench').style.gridTemplateColumns='';$('#explorer-resizer').style.display='';}
  $('#sidebar-title').textContent=mode==='search'?'Find in Files':mode==='outline'?'Document Outline':'Solution Explorer';
  $('#workspace-search').classList.toggle('hidden',mode!=='search');$('#file-tree').classList.toggle('hidden',mode==='search');$('.explorer-search').classList.toggle('hidden',mode==='search');
  $$('.explorer-bottom button').forEach(el=>el.classList.toggle('active',el.dataset.command===(mode==='outline'?'outline':'explorer')));
  selectActivity(mode==='search'?'searchWorkspace':'explorer');renderTree();if(mode==='search')$('#workspace-query').focus();
}
function searchWorkspace(){
  const query=$('#workspace-query').value,target=$('#workspace-results');target.replaceChildren();if(!query){$('#workspace-search-meta').textContent='Search your entire workspace.';return;}
  let count=0,files=0;
  for(const [path,doc]of workspace.files){const matches=findMatches(doc.text,query,{limit:300});if(matches.length)files++;
    for(const match of matches){if(count++>=300)break;const pos=doc.buffer.positionAt(match.start),row=document.createElement('button');row.className='search-result';row.innerHTML=`<strong>${fileIcon(path)}${escape(path.split('/').pop())}<small>:${pos.line+1}</small></strong><code>${escape(doc.buffer.getLine(pos.line).trim().slice(0,150))}</code>`;row.onclick=()=>{workspace.open(path);doc.setSelection(match.start,match.end);editor.ensureVisible();editor.focus();};target.append(row);}if(count>=300)break;
  }$('#workspace-search-meta').textContent=`${Math.min(300,count)}${count>=300?'+':''} results in ${files} files`;
}

// Command registration centralizes menu, palette, toolbar and keyboard behavior.
function register(id,label,run,{shortcut='',icon:iconName='code',group='Workspace'}={}){commandMap.set(id,{id,label,run,shortcut,icon:iconName,group});}
async function execute(id){closeMenu();const command=commandMap.get(id);if(!command)return;try{await command.run();}catch(error){console.error(error);toast(error.message||String(error),'error');log(error.message||String(error),'error');status('Action failed');}}
function showMenu(items,x,y){
  const menu=$('#menu-popup');menu.replaceChildren();
  for(const id of items){if(id==='-'){const separator=document.createElement('div');separator.className='menu-separator';menu.append(separator);continue;}
    const c=commandMap.get(id);if(!c)continue;const row=document.createElement('button');row.className='menu-item';row.role='menuitem';row.dataset.command=id;
    row.innerHTML=icon(c.icon)+`<span>${escape(c.label)}</span>${c.shortcut?`<kbd>${escape(c.shortcut)}</kbd>`:''}`;menu.append(row);
  }
  menu.classList.remove('hidden');menu.style.left=`${Math.min(x,innerWidth-menu.offsetWidth-8)}px`;menu.style.top=`${Math.min(y,innerHeight-menu.offsetHeight-30)}px`;
}
function closeMenu(){$('#menu-popup').classList.add('hidden');$$('.menu-button').forEach(el=>el.classList.remove('open'));}
function openPalette(mode='commands'){
  paletteMode=mode;paletteIndex=0;$('#palette-overlay').classList.remove('hidden');$('#palette-input').value='';
  $('#palette-input').placeholder=mode==='files'?'Go to a file…':mode==='symbols'?'Go to a symbol…':'Search commands…';
  $('#palette-label').textContent=mode==='files'?'WORKSPACE FILES':mode==='symbols'?'DOCUMENT SYMBOLS':'COMMANDS';
  updatePalette();$('#palette-input').focus();
}
function fuzzy(value,query){value=value.toLowerCase();query=query.toLowerCase();if(!query)return 1;if(value.includes(query))return 100-value.indexOf(query);let cursor=0,score=0;for(const c of query){const pos=value.indexOf(c,cursor);if(pos<0)return -1;score+=pos===cursor?4:1;cursor=pos+1;}return score;}
function updatePalette(){
  const query=$('#palette-input').value.trim();
  let items=paletteMode==='files'?[...workspace.files.keys()].map(path=>({label:path.split('/').pop(),detail:path,path,run:()=>workspace.open(path)})):paletteMode==='symbols'?(workspace.active?.symbols||[]).map(s=>({label:s.name,detail:`${s.kind} · line ${s.line+1}`,icon:'class',run:()=>editor.goto(s.line,s.column)})):[...commandMap.values()];
  paletteItems=items.map(item=>({...item,score:fuzzy((item.path||item.label)+' '+(item.group||''),query)})).filter(item=>item.score>=0).sort((a,b)=>b.score-a.score).slice(0,80);
  paletteIndex=Math.max(0,Math.min(paletteIndex,paletteItems.length-1));paintPalette();
}
function paintPalette(){
  const target=$('#palette-results');target.replaceChildren();
  paletteItems.forEach((item,index)=>{const row=document.createElement('button');row.className='palette-item'+(index===paletteIndex?' selected':'');row.role='option';row.setAttribute('aria-selected',index===paletteIndex);
    row.innerHTML=(item.path?fileIcon(item.path):icon(item.icon||'code'))+`<span>${escape(item.label)}${item.detail?`<small>${escape(item.detail)}</small>`:''}</span>${item.shortcut?`<kbd>${escape(item.shortcut)}</kbd>`:''}`;
    row.onclick=()=>choosePalette(index);target.append(row);
  });
  if(!paletteItems.length)target.innerHTML='<div class="panel-empty">No matches. Try a different search.</div>';
  target.children[paletteIndex]?.scrollIntoView({block:'nearest'});
}
function closePalette(){$('#palette-overlay').classList.add('hidden');editor.focus();}
function choosePalette(index=paletteIndex){const item=paletteItems[index];if(!item)return;closePalette();if(item.id)execute(item.id);else item.run();}
function showDialog(title,body,buttons=[],onClose=null){
  modalCloseCallback=onClose;$('#modal-title').textContent=title;$('#modal-body').innerHTML=body;$('#modal-actions').replaceChildren();$('#modal-overlay').classList.remove('hidden');
  for(const [i,button]of buttons.entries()){const el=document.createElement('button');el.className=button.primary?'primary-button':button.danger?'small-button danger-button':'text-button';el.textContent=button.label;el.onclick=async()=>{try{await button.run();}catch(e){toast(e.message,'error');}};$('#modal-actions').append(el);}
  hydrate($('#modal'));requestAnimationFrame(()=>($('#modal-body').querySelector('input,select,button')||$('#modal-close')).focus());
}
function closeModal(){const callback=modalCloseCallback;modalCloseCallback=null;$('#modal-overlay').classList.add('hidden');callback?.();editor.focus();}
function promptDialog(title,label,value,onSubmit,help=''){
  const submit=async()=>{const input=$('#dialog-input').value.trim();await onSubmit(input);closeModal();};
  showDialog(title,`<label for="dialog-input">${escape(label)}</label><input type="text" id="dialog-input" value="${escape(value)}" autocomplete="off" spellcheck="false">${help?`<p class="help-text">${help}</p>`:''}`,[{label:'Cancel',run:closeModal},{label:'Apply',primary:true,run:submit}]);
  $('#dialog-input').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();submit().catch(err=>toast(err.message,'error'));}});requestAnimationFrame(()=>$('#dialog-input').select());
}
function confirmDialog(title,body,label,onConfirm){showDialog(title,`<p>${body}</p>`,[{label:'Cancel',run:closeModal},{label,primary:true,run:async()=>{await onConfirm();closeModal();}}]);}
function confirmAsync(title,body,label='Continue'){return new Promise(resolve=>showDialog(title,`<p>${body}</p>`,[{label:'Cancel',run:()=>{resolve(false);closeModal();}},{label,primary:true,run:()=>{resolve(true);closeModal();}}],()=>resolve(false)));}

function applySettings(){
  document.documentElement.dataset.theme=settings.theme;editor.setOptions(settings);editor.setAccessible(!!settings.accessible);
  $('#indent-status').textContent=`Spaces: ${settings.tabSize}`;$('#zoom-label').textContent=Math.round(settings.fontSize/14*100)+'%';
  try{localStorage.setItem('forge-settings',JSON.stringify(settings));}catch{toast('Settings could not be persisted.','error');}
}
function showSettings(){
  showDialog('Make yourself at home.',`<p>Fine-tune the editor. Your preferences stay in this browser.</p><div class="settings-section-label">EDITOR & APPEARANCE</div><div class="settings-grid"><div><label for="setting-theme">Color theme</label><select id="setting-theme"><option value="dark">Forge Dark</option><option value="light">Forge Light</option></select></div><div><label for="setting-font">Font size</label><input id="setting-font" type="number" min="10" max="24" value="${settings.fontSize}"></div><div><label for="setting-indent">Indentation</label><select id="setting-indent"><option value="2">2 spaces</option><option value="4">4 spaces</option><option value="8">8 spaces</option></select></div><div><label>Editor font</label><p class="help-text">Cascadia Code → SF Mono → Consolas → system monospace</p></div></div><label class="setting-switch"><input id="setting-minimap" type="checkbox" ${settings.minimap?'checked':''}> Show minimap</label><label class="setting-switch"><input id="setting-accessible" type="checkbox" ${settings.accessible?'checked':''}> Accessible native textarea editor</label><label class="setting-switch"><input id="setting-live" type="checkbox" ${settings.liveReload?'checked':''}> Reload a running preview after edits</label><p class="help-text">Native mode gives assistive technologies access to the complete document. It uses browser text rendering instead of the WebGPU surface.</p>`,[{label:'Cancel',run:closeModal},{label:'Save preferences',primary:true,run:()=>{settings={...settings,theme:$('#setting-theme').value,fontSize:Math.max(10,Math.min(24,Number($('#setting-font').value)||14)),tabSize:Number($('#setting-indent').value),minimap:$('#setting-minimap').checked,accessible:$('#setting-accessible').checked,liveReload:$('#setting-live').checked};applySettings();closeModal();}}]);
  $('#setting-theme').value=settings.theme;$('#setting-indent').value=settings.tabSize;
}
function showNewProject(){
  let kind='web';showDialog('What will you build next?',`<p>Start with a small, runnable project. No dependencies to install.</p><div class="template-grid"><button class="template-card active" data-template="web">${icon('layout')}<strong>Web application</strong><small>HTML, CSS, ES modules.<br>Instant browser preview.</small></button><button class="template-card" data-template="javascript">${icon('terminal')}<strong>JavaScript console</strong><small>Run scripts, inspect output,<br>and trace statements.</small></button><button class="template-card" data-template="dotnet">${icon('cube')}<strong>C# workspace</strong><small>Edit .NET source files.<br>Compile with your local SDK.</small></button></div><label for="project-name">Workspace name</label><input type="text" id="project-name" value="MyProject"><p class="help-text">This replaces the current browser workspace. Export a backup first to keep your current files.</p>`,[{label:'Export current',run:()=>execute('exportWorkspace')},{label:'Cancel',run:closeModal},{label:'Create workspace',primary:true,run:()=>{const name=$('#project-name').value.trim();if(!name)throw new Error('Give your workspace a name.');runtime.stopAll();loading=true;workspace.load(newWorkspace(kind,name));loading=false;closedFolders.clear();editorActive();analysis?.all(workspace).catch(()=>{});output=[];log(`Created ${name}: ${workspace.files.size} files.`,'success');closeModal();}}]);
  $$('.template-card').forEach(el=>el.onclick=()=>{kind=el.dataset.template;$$('.template-card').forEach(b=>b.classList.toggle('active',b===el));});
}
function showShortcuts(){
  const keys=[['Command palette','Ctrl / ⌘ + Shift + P'],['Open file / go to symbol','Ctrl / ⌘ + P / Ctrl + Shift + O'],['Save / save all','Ctrl / ⌘ + S / Shift + S'],['Find / replace / find in files','Ctrl + F / H / Shift + F'],['Go to line','Ctrl / ⌘ + G'],['Run web preview / active JavaScript','F5 / Ctrl + F5'],['Validate JavaScript & JSON','Ctrl + Shift + B'],['Trace / step / continue / stop','F9 / F10 / F8 / Shift + F5'],['Completion suggestions','Ctrl + Space'],['Toggle line comment','Ctrl / ⌘ + /'],['Duplicate line / move lines','Ctrl + D / Alt + ↑ or ↓'],['Indent / outdent','Tab / Shift + Tab'],['Undo / redo','Ctrl + Z / Ctrl + Shift + Z'],['Select / word movement','Shift + arrows / Ctrl + arrows'],['Terminal / close editor tab','Ctrl + ` / Ctrl + W']];
  showDialog('Keyboard shortcuts',`<p>A familiar home for your muscle memory.</p><table class="shortcut-table">${keys.map(([a,b])=>`<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table><p class="help-text">macOS accepts ⌘ for standard editor commands. Function keys may require Fn. In text fields, native clipboard shortcuts are supported.</p>`,[{label:'Got it',primary:true,run:closeModal}]);
}
function showAbout(){showDialog('Forge Studio',`<div class="about-brand">${icon('logo')}<div><h3>Build what comes next.</h3><span>FORGE STUDIO · 1.0.0 · BROWSER EDITION</span></div></div><div class="about-tags"><span>Plain JavaScript</span><span>WebGPU text engine</span><span>Local-first</span></div><p>A working, independent IDE inspired by the Visual Studio workspace. A measured piece-table treap powers editing; one instanced GPU draw renders the visible text, selections, diagnostics and minimap.</p><p><strong>Runtime boundary:</strong> JavaScript and web projects run locally. C#, XAML and TypeScript have syntax editing, not Roslyn, MSBuild, a CLR runtime, or semantic language services. Local Changes is a baseline comparison, not a Git client. The terminal is not an OS shell.</p><p><strong>Keep a backup:</strong> browser data can be cleared. Export your workspace regularly. Only execute code you trust.</p><p class="help-text">Original application code: MIT. JavaScript parser: Acorn 8.15.0 (MIT). Not affiliated with Microsoft or Visual Studio.</p>`,[{label:'Keyboard shortcuts',run:showShortcuts},{label:'Start building',primary:true,run:closeModal}]);}
function renderInfo(){const s=editor.surface,stats=s.stats;showDialog('Inside the rendering engine',`<p>Live measurements from the current editor. Frame preparation time is CPU time, not GPU execution time.</p><div class="render-info-grid"><div><small>Active backend</small><strong>${escape(s.mode)}</strong></div><div><small>Last frame preparation</small><strong>${stats.cpuMs.toFixed(2)} ms</strong></div><div><small>Submitted instances</small><strong>${stats.instances.toLocaleString()}</strong></div><div><small>Draw calls</small><strong>${stats.drawCalls}</strong></div><div><small>Cached grapheme glyphs</small><strong>${s.atlas.map.size}</strong></div><div><small>Document lines</small><strong>${workspace.active?.buffer.lineCount.toLocaleString()||0}</strong></div></div><p class="help-text">${escape(s.reason||s.adapterInfo||'')}<br>Visible-row rendering · dynamically populated glyph atlas · viewport culling · demand-driven frames · device-loss fallback. No animation loop runs while the editor is unfocused and unchanged.</p>`,[{label:'Create 10,000-line test',run:()=>{const path='benchmark-10000.txt';if(!workspace.files.has(path))workspace.add(path,Array.from({length:10000},(_,i)=>`Line ${String(i+1).padStart(5,'0')}    The quick brown fox jumps over the lazy dog.    Δ GPU editor benchmark`).join('\n'));workspace.open(path);closeModal();}},{label:'Close',primary:true,run:closeModal}]);}

// File and workspace I/O. Auto-recovery never writes imported handles to disk.
async function openTextFiles(fileList,folder=false,handles=new Map(),name=''){
  const input=[...fileList];let total=0;const entries=[];
  for(const file of input){
    if(file.size>MAX_FILE_SIZE){toast(`Skipped ${file.name}: larger than 8 MiB.`);continue;}
    const raw=folder?(file.webkitRelativePath||file.name).split('/').slice(1).join('/')||file.name:file.name;
    if(/(^|\/)(node_modules|\.git|bin|obj)\//.test(raw))continue;
    const text=await file.text();if(text.includes('\0'))continue;total+=text.length;
    if(total>MAX_PROJECT_SIZE||entries.length>=2000)throw new Error('Import exceeds the workspace size limit.');entries.push({path:normalizePath(raw),text});
  }
  if(!entries.length)throw new Error('No text files were found.');
  if(folder){if(!await confirmAsync('Open folder as workspace?',`Open <strong>${entries.length} text files</strong>. This replaces the current browser workspace; export it first to retain a backup.`,'Open folder'))return;
    loading=true;workspace.load({format:'forge-workspace',version:1,name:name||input[0].webkitRelativePath?.split('/')[0]||'Workspace',files:entries,tabs:[entries[0].path],activePath:entries[0].path});loading=false;workspace.handles=handles;runtime.stopAll();editorActive();
  }else{
    for(const file of entries){const doc=workspace.files.get(file.path);if(doc){if(!await confirmAsync('Replace open file?',`Replace <strong>${escape(file.path)}</strong> with the selected file? This can be undone in the editor.`,'Replace'))continue;doc.edit(0,doc.buffer.length,file.text);}else workspace.add(file.path,file.text);workspace.open(file.path);}
  }
  workspace.scheduleSave();renderTree();analysis?.all(workspace).catch(e=>log(e.message,'error'));log(`Imported ${entries.length} text files.`,'success');
}
async function openFolder(){
  if(!window.showDirectoryPicker){$('#folder-picker').click();return;}
  let root;try{root=await showDirectoryPicker({mode:'readwrite'});}catch(e){if(e.name==='AbortError')return;if(e.name==='SecurityError'||e.name==='NotAllowedError'){toast('Directory handles are unavailable here. Use the folder import picker.');$('#folder-picker').click();return;}throw e;}
  const entries=[],handles=new Map();let total=0;
  async function read(dir,prefix=''){
    for await(const [name,handle]of dir.entries()){
      if(['.git','node_modules','bin','obj'].includes(name))continue;
      const path=prefix+name;
      if(handle.kind==='directory')await read(handle,path+'/');
      else{const file=await handle.getFile();if(file.size>MAX_FILE_SIZE)continue;const text=await file.text();if(text.includes('\0'))continue;total+=text.length;if(total>MAX_PROJECT_SIZE||entries.length>=2000)throw new Error('Folder exceeds the 40 MiB / 2,000 text-file import limit.');entries.push({path,text});handles.set(path,handle);}
    }
  }
  await read(root);if(!entries.length)throw new Error('The folder has no readable text files.');
  if(!await confirmAsync('Open '+root.name+'?',`Load <strong>${entries.length} files</strong> into a new workspace. Ctrl+S will write modified files back to this folder. Auto-recovery only writes browser storage.`,'Open folder'))return;
  runtime.stopAll();loading=true;workspace.load({format:'forge-workspace',version:1,name:root.name,files:entries,tabs:[entries[0].path],activePath:entries[0].path});loading=false;workspace.handles=handles;closedFolders.clear();editorActive();await analysis?.all(workspace);log(`Opened local folder ${root.name}. Explicit Save writes imported file handles.`,'success');
}
async function importWorkspace(file){
  if(!file)return;if(file.size>MAX_PROJECT_SIZE*4)throw new Error('Workspace backup is too large.');const data=JSON.parse(await file.text());
  if(!await confirmAsync('Open workspace backup?',`Replace this browser workspace with <strong>${escape(data.name||file.name)}</strong>? Export the current workspace first to keep a copy.`,'Open workspace'))return;
  runtime.stopAll();loading=true;try{workspace.load(data);}finally{loading=false;}closedFolders.clear();editorActive();await analysis?.all(workspace);log('Workspace backup imported.','success');
}
function previewEntry(){const files=[...workspace.files.keys()];return files.find(p=>p==='Nebula.Web/index.html')||files.find(p=>/(^|\/)index\.html?$/.test(p))||files.find(p=>/\.html?$/.test(p));}
function showPreview(show=true){previewVisible=show;$('#preview-panel').classList.toggle('hidden',!show);if(!show){$('#editor-layout').classList.remove('preview-max');runtime.stopMode('preview');previewRunning=false;$('#preview-empty').classList.remove('hidden');updateRunState();}editor.invalidate();}
async function runPreview(){
  const entry=previewEntry();if(!entry)throw new Error('This workspace has no HTML entry point. Create an index.html file or run a JavaScript script.');
  showPreview(true);$('#preview-address').textContent='workspace / '+entry;
  runtime.preview($('#preview-frame'),workspace.snapshot(),entry);previewRunning=true;$('#preview-empty').classList.add('hidden');updateRunState();
  log(`Starting ${entry} in an opaque-origin browser sandbox…`,'info','console');status('Running');
}
async function validate(){
  if(!analysis)throw new Error('Language analysis is unavailable.');status('Validating',true);panel('output');const start=performance.now();
  try{await analysis.all(workspace);const docs=[...workspace.files.values()],errors=docs.reduce((sum,d)=>sum+d.diagnostics.length,0),supported=docs.filter(d=>['javascript','json'].includes(d.language)).length;
    log(`Validated ${supported} JavaScript / JSON files in ${(performance.now()-start).toFixed(0)} ms. ${errors} syntax errors.`,errors?'error':'success','build');
    if(docs.some(d=>d.language==='csharp'))log('C# source was not compiled. Build Nebula.Core with a local .NET SDK.','info','build');
    renderProblems();status(errors?'Syntax errors':'Validation passed');if(errors)panel('problems');return errors===0;
  }catch(e){status('Validation failed');throw e;}
}
function runFile(){const doc=workspace.active;if(doc?.language!=='javascript')throw new Error('Run Current File supports JavaScript. C# / XAML / TypeScript require their own toolchains.');panel('output');runtime.execute(workspace.snapshot(),{entries:[doc.path],mode:'run',path:doc.path});log(`Running ${doc.path} in an isolated worker.`,'info','console');updateRunState();}
function trace(){
  const doc=workspace.active;if(doc?.language!=='javascript')throw new Error('Open scripts/diagnostics.js, then start Trace. C# and other language runtimes are not attached.');
  const transformed=instrumentTrace(doc.text);panel('debug');const session=runtime.execute({}, {mode:'trace',code:transformed.code,breakpoints:[...doc.breakpoints],path:doc.path});traceSession=session.token;updateRunState();status('Tracing');
}
function updateRunState(){const active=[...runtime.sessions.values()].some(s=>!s.finished);$('.stop-button').disabled=!active;$('#trace-tools').classList.toggle('hidden',!traceSession);$('.statusbar').classList.toggle('debugging',!!traceSession);}
function runTests(){
  const entries=[...workspace.files.keys()].filter(path=>/\.(test|spec)\.m?js$/.test(path));if(!entries.length)throw new Error('No *.test.js or *.spec.js files were found. Use the test(name, fn) and assert APIs.');
  testResults=[];renderTests();panel('tests');$('#test-summary').textContent=`Running ${entries.length} test module${entries.length===1?'':'s'}…`;
  runtime.execute(workspace.snapshot(),{entries,mode:'test'});status('Running tests',true);updateRunState();
}
function renderTests(){
  $('#test-results').innerHTML=testResults.map(r=>`<div class="test-result ${r.passed?'':'failed'}">${icon(r.passed?'check':'error')}<span>${escape(r.name)}${r.message?' — '+escape(r.message):''}</span><small>${r.duration.toFixed(2)} ms</small></div>`).join('');
  if(!testResults.length)$('#test-results').innerHTML='<div class="panel-empty">Tests run in an isolated JavaScript worker. No test results are simulated.</div>';
}

// Find and replace operates on the real text buffer; replacement is one undo unit.
let currentFindIndex=-1;
function openFind(){if(!workspace.active)return;$('#find-bar').classList.remove('hidden');const d=workspace.active,a=Math.min(d.selection.head,d.selection.anchor),z=Math.max(d.selection.head,d.selection.anchor);if(a!==z&&z-a<200)$('#find-input').value=d.buffer.slice(a,z);updateFind();$('#find-input').focus();$('#find-input').select();}
function updateFind(){
  const doc=workspace.active;if(!doc)return;editor.findMatches=findMatches(doc.text,$('#find-input').value,{caseSensitive:$('#find-case').classList.contains('active'),wholeWord:$('#find-word').classList.contains('active')});
  $('#find-count').textContent=`${editor.findMatches.length} results`;currentFindIndex=-1;editor.invalidate();
}
function nextFind(direction=1){const matches=editor.findMatches;if(!matches.length)return;if(currentFindIndex<0){const head=workspace.active.selection.head;currentFindIndex=matches.findIndex(m=>m.start>=head);if(currentFindIndex<0)currentFindIndex=0;if(direction<0)currentFindIndex=(currentFindIndex+matches.length-1)%matches.length;}else currentFindIndex=(currentFindIndex+direction+matches.length)%matches.length;
  const match=matches[currentFindIndex];workspace.active.setSelection(match.start,match.end);editor.ensureVisible();$('#find-count').textContent=`${currentFindIndex+1} of ${matches.length}`;
}
function replaceOne(){const d=workspace.active;if(!d||!editor.findMatches.length)return;if(currentFindIndex<0)nextFind(1);const m=editor.findMatches[currentFindIndex];d.edit(m.start,m.end,$('#replace-input').value);updateFind();nextFind(1);}
function replaceAll(){const d=workspace.active;if(!d||!editor.findMatches.length)return;let text=d.text;const count=editor.findMatches.length;for(const m of [...editor.findMatches].reverse())text=text.slice(0,m.start)+$('#replace-input').value+text.slice(m.end);d.edit(0,d.buffer.length,text,{selection:{anchor:0,head:0}});updateFind();toast(`Replaced ${count} matches. Ctrl+Z undoes the operation.`);}

// Virtual terminal intentionally does not impersonate a system shell.
function terminalWrite(text,kind=''){const row=document.createElement('div');row.className=kind;row.textContent=text;$('#terminal-lines').append(row);while($('#terminal-lines').children.length>500)$('#terminal-lines').firstChild.remove();$('#terminal-panel').scrollTop=$('#terminal-panel').scrollHeight;}
async function terminalCommand(source){
  terminalWrite('forge ~/workspace ❯ '+source,'input-line');const trimmed=source.trim(),[command,...args]=trimmed.split(/\s+/),value=args.join(' ');
  if(!command)return;
  switch(command){
    case 'help':terminalWrite('Workspace commands:\n  ls [path]      List workspace files\n  cat <path>     Read a file\n  open <path>    Open a file in the editor\n  new <path>     Create an empty file\n  grep <text>    Search all files\n  build         Validate JavaScript / JSON syntax\n  run [path]    Run a JavaScript module, or the web preview\n  test          Execute all *.test.js modules\n  js <code>     Evaluate JavaScript in an isolated worker\n  clear         Clear this terminal\n  export        Download a project ZIP\n  pwd           Show virtual workspace location\n\nThis is a browser workspace terminal, not bash, PowerShell, dotnet, npm, or Git.');break;
    case 'pwd':terminalWrite('/workspace/'+workspace.name);break;
    case 'ls':terminalWrite([...workspace.files.keys()].filter(p=>!value||p.startsWith(value)).join('\n')||'(no matching files)');break;
    case 'cat':{const d=workspace.files.get(value);if(!d)throw new Error('File not found: '+value);terminalWrite(d.text.length>30000?d.text.slice(0,30000)+'\n… display truncated':d.text);break;}
    case 'open':if(!workspace.files.has(value))throw new Error('File not found: '+value);workspace.open(value);break;
    case 'new':workspace.add(value,'');workspace.open(value);workspace.scheduleSave();break;
    case 'grep':{let count=0;for(const [path,doc]of workspace.files){for(const m of findMatches(doc.text,value,{limit:20})){const pos=doc.buffer.positionAt(m.start);terminalWrite(`${path}:${pos.line+1}: ${doc.buffer.getLine(pos.line).trim()}`);if(++count>=100)break;}if(count>=100)break;}if(!count)terminalWrite('No matches.');break;}
    case 'build':await validate();panel('terminal');break;
    case 'run':if(value){workspace.open(value);runFile();}else await runPreview();break;
    case 'test':runTests();break;
    case 'js':runtime.execute({}, {mode:'eval',code:trimmed.slice(3)});break;
    case 'clear':$('#terminal-lines').replaceChildren();break;
    case 'export':await execute('exportZip');break;
    default:terminalWrite(`Unknown command: ${command}. Type help. Native OS / SDK commands require a local toolchain.`,'error');
  }
}

register('newProject','New workspace…',showNewProject,{icon:'cube',group:'File'});
register('newFile','New file…',()=>promptDialog('Add a new file','Path relative to the workspace',workspace.activePath.includes('/')?workspace.activePath.split('/').slice(0,-1).join('/')+'/Untitled.js':'Untitled.js',path=>{workspace.add(path,'');workspace.open(path);workspace.scheduleSave();}),{shortcut:'Ctrl N',icon:'plus',group:'File'});
register('openFiles','Open files…',()=>$('#file-picker').click(),{shortcut:'Ctrl O',icon:'folderOpen',group:'File'});
register('openFolder','Open local folder…',openFolder,{icon:'folderOpen',group:'File'});
register('importWorkspace','Open workspace backup…',()=>$('#workspace-picker').click(),{icon:'folder',group:'File'});
register('save','Save',async()=>{const d=workspace.active;if(!d)return;await workspace.save(d);renderTabs();renderTree();status('Saved');log(`Saved ${d.path}${workspace.handles.has(d.path)?' to disk and browser storage.':' to browser storage.'}`,'success');},{shortcut:'Ctrl S',icon:'save',group:'File'});
register('saveAll','Save all',async()=>{await workspace.saveAll();renderTabs();renderTree();status('All saved');log('All documents saved.','success');},{shortcut:'Ctrl Shift S',icon:'saveAll',group:'File'});
register('rename','Rename file…',()=>{if(!workspace.active)return;const from=workspace.activePath;promptDialog('Rename file','New workspace path',from,to=>{workspace.rename(from,to);analysis?.schedule(workspace.active);toast('Renamed in the workspace. Existing disk files are not renamed.');});},{icon:'file',group:'File'});
register('deleteFile','Delete file…',()=>{const path=workspace.activePath;if(!path)return;confirmDialog('Delete from workspace?',`Remove <strong>${escape(path)}</strong>? This only removes the browser workspace document, not the original disk file.`,'Delete',()=>workspace.delete(path));},{icon:'trash',group:'File'});
register('exportFile','Download current file',()=>{const d=workspace.active;if(!d)return;download(d.path.split('/').pop(),d.text.replace(/\n/g,d.eol),'text/plain');},{icon:'download',group:'File'});
register('exportWorkspace','Export workspace backup',()=>download(workspace.name.replace(/[^\w.-]/g,'_')+'.forge.json',JSON.stringify(workspace.serialize(),null,2),'application/json'),{icon:'saveAll',group:'File'});
register('exportZip','Export project ZIP',()=>{const files=Object.fromEntries([...workspace.files].map(([path,d])=>[path,d.text.replace(/\n/g,d.eol)]));download(workspace.name.replace(/[^\w.-]/g,'_')+'.zip',createZip(files));},{icon:'download',group:'File'});
register('undo','Undo',()=>{workspace.active?.undo();editor.ensureVisible();editor.focus();},{shortcut:'Ctrl Z',icon:'undo',group:'Edit'});
register('redo','Redo',()=>{workspace.active?.redo();editor.ensureVisible();editor.focus();},{shortcut:'Ctrl Shift Z',icon:'redo',group:'Edit'});
register('copy','Copy',async()=>{const d=workspace.active;if(!d)return;await navigator.clipboard.writeText(d.buffer.slice(Math.min(d.selection.head,d.selection.anchor),Math.max(d.selection.head,d.selection.anchor)));editor.focus();},{shortcut:'Ctrl C',icon:'files',group:'Edit'});
register('cut','Cut',async()=>{const d=workspace.active;if(!d)return;const a=Math.min(d.selection.head,d.selection.anchor),z=Math.max(d.selection.head,d.selection.anchor);await navigator.clipboard.writeText(d.buffer.slice(a,z));d.edit(a,z,'');editor.focus();},{shortcut:'Ctrl X',icon:'file',group:'Edit'});
register('paste','Paste',async()=>{editor.insert(await navigator.clipboard.readText(),'paste');editor.focus();},{shortcut:'Ctrl V',icon:'files',group:'Edit'});
register('selectAll','Select all',()=>{workspace.active?.setSelection(0,workspace.active.buffer.length);editor.focus();},{shortcut:'Ctrl A',icon:'file',group:'Edit'});
register('find','Find / replace in file',openFind,{shortcut:'Ctrl F',icon:'search',group:'Edit'});
register('findNext','Next match',()=>nextFind(1),{shortcut:'F3',icon:'arrowRight',group:'Edit'});
register('findPrevious','Previous match',()=>nextFind(-1),{shortcut:'Shift F3',icon:'arrowLeft',group:'Edit'});
register('closeFind','Close find',()=>{$('#find-bar').classList.add('hidden');editor.findMatches=[];editor.invalidate();editor.focus();},{icon:'close',group:'Edit'});
register('replace','Replace match',replaceOne,{icon:'code',group:'Edit'});
register('replaceAll','Replace all matches',replaceAll,{icon:'code',group:'Edit'});
register('toggleComment','Toggle comment',()=>{editor.toggleComment();editor.focus();},{shortcut:'Ctrl /',icon:'code',group:'Edit'});
register('duplicateLine','Duplicate line',()=>{editor.duplicateLine();editor.focus();},{shortcut:'Ctrl D',icon:'files',group:'Edit'});
register('formatJSON','Format JSON document',()=>{const d=workspace.active;if(d?.language!=='json')throw new Error('JSON formatting is available for .json documents. Other languages preserve your source formatting.');const text=JSON.stringify(JSON.parse(d.text),null,settings.tabSize)+'\n';d.edit(0,d.buffer.length,text);editor.focus();},{icon:'code',group:'Edit'});
register('gotoLine','Go to line…',()=>promptDialog('Go to line','Line number (optionally line:column)','',value=>{const m=/^(\d+)(?::(\d+))?$/.exec(value);if(!m)throw new Error('Enter a line number, such as 42 or 42:8.');editor.goto(Number(m[1])-1,Number(m[2]||1)-1);}),{shortcut:'Ctrl G',icon:'arrowRight',group:'Navigate'});
register('definition','Go to definition (lexical)',()=>{const d=workspace.active;if(!d)return;const pos=d.buffer.positionAt(d.selection.head),line=d.buffer.getLine(pos.line),left=line.slice(0,pos.column).match(/[\w$]*$/)?.[0]||'',right=line.slice(pos.column).match(/^[\w$]*/)?.[0]||'',word=left+right;for(const doc of [d,...[...workspace.files.values()].filter(x=>x!==d)]){const symbol=doc.symbols.find(s=>s.name===word);if(symbol){workspace.open(doc.path);editor.goto(symbol.line,symbol.column);return;}}toast('No lexical definition was found. Semantic language services are not attached.');},{shortcut:'F12',icon:'class',group:'Navigate'});
register('palette','Command palette',()=>openPalette('commands'),{shortcut:'Ctrl Shift P',icon:'search',group:'Navigate'});
register('quickOpen','Go to file',()=>openPalette('files'),{shortcut:'Ctrl P',icon:'files',group:'Navigate'});
register('symbols','Go to symbol',()=>openPalette('symbols'),{shortcut:'Ctrl Shift O',icon:'class',group:'Navigate'});
register('explorer','Solution Explorer',()=>showSidebar('explorer'),{icon:'files',group:'View'});
register('outline','Document outline',()=>showSidebar('outline'),{icon:'outline',group:'View'});
register('searchWorkspace','Find in Files',()=>showSidebar('search'),{shortcut:'Ctrl Shift F',icon:'search',group:'View'});
register('problems','Error List',()=>panel('problems'),{icon:'error',group:'View'});
register('output','Output',()=>panel('output'),{icon:'output',group:'View'});
register('terminal','Workspace terminal',()=>panel('terminal'),{shortcut:'Ctrl `',icon:'terminal',group:'View'});
register('changes','Local changes (not Git)',()=>{panel('changes');selectActivity('changes');},{icon:'branch',group:'View'});
register('togglePanel','Toggle tool panel',()=>$('#main-workspace').classList.toggle('panel-hidden'),{shortcut:'Ctrl J',icon:'layout',group:'View'});
register('toggleExplorer','Toggle Solution Explorer',()=>{if(innerWidth<=790){$('#right-sidebar').classList.toggle('mobile-visible');return;}const hidden=$('#right-sidebar').style.display==='none';$('#right-sidebar').style.display=hidden?'':'none';$('#explorer-resizer').style.display=hidden?'':'none';$('#workbench').style.gridTemplateColumns=hidden?'':'44px minmax(0,1fr) 0 0';},{icon:'layout',group:'View'});
register('togglePreview','Toggle live preview',()=>showPreview(!previewVisible),{icon:'split',group:'View'});
register('toggleMinimap','Toggle minimap',()=>{settings.minimap=!settings.minimap;applySettings();},{icon:'layout',group:'View'});
register('toggleTheme','Toggle light / dark theme',()=>{settings.theme=settings.theme==='dark'?'light':'dark';applySettings();},{icon:'sun',group:'View'});
register('accessible','Toggle accessible editor',()=>{settings.accessible=!settings.accessible;applySettings();},{icon:'keyboard',group:'View'});
register('fontSize','Editor font size…',()=>promptDialog('Editor font size','Size in pixels (10–24)',String(settings.fontSize),value=>{const n=Number(value);if(!Number.isFinite(n)||n<10||n>24)throw new Error('Choose a size between 10 and 24.');settings.fontSize=n;applySettings();}),{icon:'code',group:'View'});
register('zoomIn','Increase editor font size',()=>{settings.fontSize=Math.min(24,settings.fontSize+1);applySettings();},{icon:'plus',group:'View'});
register('zoomOut','Decrease editor font size',()=>{settings.fontSize=Math.max(10,settings.fontSize-1);applySettings();},{icon:'minus',group:'View'});
register('toggleEol','Toggle LF / CRLF on export',()=>{const d=workspace.active;if(!d)return;d.eol=d.eol==='\n'?'\r\n':'\n';d.dirty=true;workspace.scheduleSave();updateSelection();renderTabs();},{icon:'code',group:'Edit'});
register('build','Validate web sources',validate,{shortcut:'Ctrl Shift B',icon:'check',group:'Build'});
register('buildDotnet','About C# build support',()=>showDialog('C# build toolchain',`<p>Forge Studio edits C# and XAML source, but does not include Roslyn, MSBuild, NuGet, or a .NET runtime. No C# compilation is simulated.</p><p>Export your source tree, then use a local SDK:</p><pre>dotnet run --project Nebula.Core/Nebula.Core.csproj</pre><p class="help-text">The included C# project targets .NET 8. The browser startup target is the separate Nebula.Web project.</p>`,[{label:'Export ZIP',primary:true,run:()=>execute('exportZip')},{label:'Close',run:closeModal}]),{icon:'cube',group:'Build'});
register('start','Start selected target',()=>{const mode=$('#run-mode').value;return mode==='web'?runPreview():mode==='trace'?trace():runFile();},{shortcut:'F5',icon:'play',group:'Run'});
register('runPreview','Start web preview',runPreview,{icon:'play',group:'Run'});
register('runFile','Run current JavaScript',runFile,{shortcut:'Ctrl F5',icon:'terminal',group:'Run'});
register('trace','Trace current JavaScript',trace,{shortcut:'F9',icon:'debug',group:'Run'});
register('continue','Continue trace',()=>{if(!traceSession)throw new Error('No trace session is active.');runtime.command(traceSession,'continue');editor.executionLine=undefined;editor.invalidate();$('#trace-state').textContent='Running';},{shortcut:'F8',icon:'play',group:'Run'});
register('step','Step statement',()=>{if(!traceSession)throw new Error('No trace session is active.');runtime.command(traceSession,'step');editor.executionLine=undefined;editor.invalidate();},{shortcut:'F10',icon:'step',group:'Run'});
register('stop','Stop all execution',()=>{runtime.stopAll();traceSession=null;previewRunning=false;editor.executionLine=undefined;editor.invalidate();$('#preview-empty').classList.remove('hidden');updateRunState();status('Stopped');log('All execution sessions stopped.','info','console');},{shortcut:'Shift F5',icon:'stop',group:'Run'});
register('refreshPreview','Reload web preview',()=>runPreview(),{icon:'refresh',group:'Run'});
register('maximizePreview','Expand / restore preview',()=>$('#editor-layout').classList.toggle('preview-max'),{icon:'expand',group:'View'});
register('tests','Test Explorer',()=>{panel('tests');selectActivity('tests');},{icon:'beaker',group:'Test'});
register('runTests','Run all tests',runTests,{icon:'play',group:'Test'});
register('settings','Preferences',showSettings,{shortcut:'Ctrl ,',icon:'settings',group:'Tools'});
register('renderInfo','Rendering diagnostics',renderInfo,{icon:'chip',group:'Tools'});
register('snapshot','Set local baseline',()=>confirmDialog('Set a new local baseline?',`Use the current workspace as the comparison baseline. Previous local diffs will be cleared. This does not create a Git commit or write to disk.`,'Set baseline',()=>{workspace.setBaseline();renderChanges();toast('Local baseline updated.');}),{icon:'branch',group:'Tools'});
register('clearOutput','Clear active tool window',()=>{if(activePanel==='terminal')$('#terminal-lines').replaceChildren();else if(activePanel==='output'){output=[];renderOutput();}else if(activePanel==='tests'){testResults=[];renderTests();$('#test-summary').textContent='Test results cleared';}else toast('This panel reflects workspace state and cannot be cleared independently.');},{icon:'trash',group:'View'});
register('previousFile','Previous document',()=>{const i=workspace.tabs.indexOf(workspace.activePath);if(workspace.tabs.length)workspace.open(workspace.tabs[(i-1+workspace.tabs.length)%workspace.tabs.length]);},{icon:'arrowLeft',group:'Window'});
register('nextFile','Next document',()=>{const i=workspace.tabs.indexOf(workspace.activePath);if(workspace.tabs.length)workspace.open(workspace.tabs[(i+1)%workspace.tabs.length]);},{icon:'arrowRight',group:'Window'});
register('closeFile','Close document',()=>workspace.close(workspace.activePath),{shortcut:'Ctrl W',icon:'close',group:'Window'});
register('closeOthers','Close other documents',()=>{workspace.tabs=workspace.activePath?[workspace.activePath]:[];renderTabs();workspace.scheduleSave();},{icon:'files',group:'Window'});
register('collapseTree','Collapse / expand folders',()=>{if(closedFolders.size)closedFolders.clear();else for(const path of workspace.files.keys()){const parts=path.split('/');for(let i=1;i<parts.length;i++)closedFolders.add(parts.slice(0,i).join('/'));}renderTree();},{icon:'collapse',group:'View'});
register('refreshTree','Refresh Solution Explorer',()=>{renderTree();toast('Workspace tree refreshed. Disk files are re-imported using Open Folder.');},{icon:'refresh',group:'View'});
register('revealActive','Reveal active file',()=>{showSidebar('explorer');solutionCollapsed=false;$('#tree-search').value='';const parts=workspace.activePath.split('/');for(let i=1;i<parts.length;i++)closedFolders.delete(parts.slice(0,i).join('/'));renderTree();$('#file-tree .active')?.scrollIntoView({block:'nearest'});},{icon:'files',group:'View'});
register('resetLayout','Reset window layout',()=>{document.documentElement.style.removeProperty('--sidebar-width');document.documentElement.style.removeProperty('--panel-height');$('#main-workspace').classList.remove('panel-hidden');showSidebar('explorer');showPreview(false);},{icon:'layout',group:'Window'});
register('shortcuts','Keyboard shortcuts',showShortcuts,{shortcut:'F1',icon:'keyboard',group:'Help'});
register('about','About Forge Studio',showAbout,{icon:'logo',group:'Help'});
register('notifications','Workspace recovery status',()=>toast(workspace.storage?`Auto-recovery is enabled. ${lastPersisted?'Last written at '+lastPersisted.toLocaleTimeString()+'.':'Waiting for first write.'} Export backups to keep your work outside this browser.`:'Browser storage is unavailable. Download a workspace backup now.'),{icon:'info',group:'Help'});
register('resetDemo','Restore Nebula sample…',()=>confirmDialog('Restore the sample workspace?',`This replaces your current files with the original Nebula sample. Export your current workspace before continuing.`,'Restore sample',()=>{runtime.stopAll();loading=true;workspace.load(structuredClone(demoWorkspace));loading=false;closedFolders.clear();editorActive();analysis?.all(workspace).catch(()=>{});}),{icon:'refresh',group:'Help'});

const menuDefinitions={
  File:['newProject','newFile','-','openFiles','openFolder','importWorkspace','-','save','saveAll','-','exportFile','exportWorkspace','exportZip'],
  Edit:['undo','redo','-','cut','copy','paste','selectAll','-','find','searchWorkspace','-','toggleComment','duplicateLine','formatJSON'],
  View:['explorer','outline','output','problems','terminal','changes','tests','-','togglePanel','togglePreview','toggleMinimap','-','toggleTheme','accessible'],
  Git:['changes','snapshot','-','exportZip'],
  Project:['newFile','rename','deleteFile','-','newProject','openFolder'],
  Build:['build','-','buildDotnet'],
  Run:['start','runPreview','runFile','trace','-','continue','step','stop'],
  Test:['runTests','tests'],
  Tools:['palette','settings','renderInfo','-','formatJSON','fontSize'],
  Window:['previousFile','nextFile','closeFile','closeOthers','-','toggleExplorer','resetLayout'],
  Help:['shortcuts','about','renderInfo','notifications','-','resetDemo']
};
for(const [name,items]of Object.entries(menuDefinitions)){const button=document.createElement('button');button.className='menu-button';button.textContent=name;button.setAttribute('aria-haspopup','menu');button.onclick=e=>{e.stopPropagation();const wasOpen=button.classList.contains('open');closeMenu();if(!wasOpen){button.classList.add('open');const r=button.getBoundingClientRect();showMenu(items,r.left,r.bottom+2);}};$('#menubar').append(button);}

// Event wiring and lifetime management.
document.addEventListener('click',e=>{const command=e.target.closest('[data-command]');if(command){e.preventDefault();execute(command.dataset.command);}else if(!e.target.closest('#menu-popup,.menu-button'))closeMenu();});
$('#bottom-tabs').addEventListener('click',e=>{const el=e.target.closest('[data-panel]');if(el)panel(el.dataset.panel);});
$('#tree-search').addEventListener('input',()=>{solutionCollapsed=false;renderTree();});
$('#workspace-query').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(searchWorkspace,180);});
$('#output-filter').addEventListener('change',renderOutput);
$('#palette-input').addEventListener('input',()=>{paletteIndex=0;updatePalette();});
$('#palette-input').addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();paletteIndex=(paletteIndex+(e.key==='ArrowDown'?1:-1)+paletteItems.length)%Math.max(1,paletteItems.length);paintPalette();}
  if(e.key==='Enter'){e.preventDefault();choosePalette();}if(e.key==='Escape'){e.preventDefault();closePalette();}
});
$('#palette-overlay').addEventListener('pointerdown',e=>{if(e.target===$('#palette-overlay'))closePalette();});
$('#modal-close').onclick=closeModal;$('#modal-overlay').addEventListener('pointerdown',e=>{if(e.target===$('#modal-overlay'))closeModal();});
$('#find-input').addEventListener('input',updateFind);
$('#find-input').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();nextFind(e.shiftKey?-1:1);}if(e.key==='Escape')execute('closeFind');});
$('#replace-input').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();replaceOne();}});
for(const id of ['#find-case','#find-word'])$(id).onclick=()=>{$(id).classList.toggle('active');updateFind();};
$('#terminal-form').addEventListener('submit',e=>{e.preventDefault();const source=$('#terminal-input').value;$('#terminal-input').value='';if(source.trim()){terminalHistory.push(source);historyIndex=terminalHistory.length;terminalCommand(source).catch(err=>terminalWrite(err.message,'error'));}});
$('#terminal-input').addEventListener('keydown',e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();historyIndex=Math.max(0,Math.min(terminalHistory.length,historyIndex+(e.key==='ArrowUp'?-1:1)));e.target.value=terminalHistory[historyIndex]||'';}if(e.key==='l'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('#terminal-lines').replaceChildren();}});
$('#file-picker').onchange=async e=>{try{await openTextFiles(e.target.files);}catch(err){toast(err.message,'error');}e.target.value='';};
$('#folder-picker').onchange=async e=>{try{await openTextFiles(e.target.files,true);}catch(err){toast(err.message,'error');}e.target.value='';};
$('#workspace-picker').onchange=async e=>{try{await importWorkspace(e.target.files[0]);}catch(err){toast(err.message,'error');}e.target.value='';};
document.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});
document.addEventListener('drop',e=>{if(e.dataTransfer.files.length){e.preventDefault();openTextFiles(e.dataTransfer.files).catch(err=>toast(err.message,'error'));}});
function trapFocus(e,root){if(e.key!=='Tab')return;const nodes=[...root.querySelectorAll('button,input,select,textarea,[tabindex="0"]')].filter(el=>!el.disabled&&el.offsetParent!==null);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
document.addEventListener('keydown',e=>{
  if(!$('#modal-overlay').classList.contains('hidden')){if(e.key==='Escape'){e.preventDefault();closeModal();}trapFocus(e,$('#modal'));return;}
  if(!$('#palette-overlay').classList.contains('hidden')){trapFocus(e,$('.command-palette'));return;}
  if(!$('#menu-popup').classList.contains('hidden')){
    if(e.key==='Escape'){e.preventDefault();closeMenu();editor.focus();return;}
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const buttons=[...$('#menu-popup').querySelectorAll('button')],i=buttons.indexOf(document.activeElement);buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();return;}
  }
  const mod=e.ctrlKey||e.metaKey,key=e.key.toLowerCase();let id;
  if(mod&&e.shiftKey&&key==='p')id='palette';else if(mod&&key==='q')id='palette';else if(mod&&key==='p')id='quickOpen';
  else if(mod&&e.shiftKey&&key==='s')id='saveAll';else if(mod&&key==='s')id='save';
  else if(mod&&key==='n')id='newFile';else if(mod&&e.shiftKey&&key==='o')id='symbols';else if(mod&&key==='o')id='openFiles';
  else if(mod&&e.shiftKey&&key==='f')id='searchWorkspace';else if(mod&&(key==='f'||key==='h'))id='find';
  else if(mod&&key==='g')id='gotoLine';else if(mod&&key===',')id='settings';else if(mod&&key===';'){e.preventDefault();showSidebar('explorer');$('#tree-search').focus();return;}
  else if(mod&&key==='`')id='terminal';else if(mod&&key==='j')id='togglePanel';else if(mod&&key==='w')id='closeFile';
  else if(mod&&e.shiftKey&&key==='b')id='build';else if(mod&&key==='=')id='zoomIn';else if(mod&&key==='-')id='zoomOut';
  else if(e.key==='F1')id='shortcuts';else if(e.key==='F3')id=e.shiftKey?'findPrevious':'findNext';
  else if(e.key==='F5')id=e.shiftKey?'stop':mod?'runFile':'start';else if(e.key==='F6')id='build';else if(e.key==='F8')id='continue';else if(e.key==='F9')id='trace';else if(e.key==='F10')id='step';else if(e.key==='F12')id='definition';
  if(id){e.preventDefault();execute(id);}
});
function resizeHandle(handle,axis,variable,min,max,reverse=false){
  handle.addEventListener('pointerdown',e=>{e.preventDefault();const start=axis==='x'?e.clientX:e.clientY,current=axis==='x'?$('#right-sidebar').clientWidth:$('#bottom-panel').clientHeight;handle.setPointerCapture(e.pointerId);document.body.classList.add('resizing');
    const move=event=>{const value=current+((axis==='x'?event.clientX:event.clientY)-start)*(reverse?-1:1);document.documentElement.style.setProperty(variable,Math.max(min,Math.min(max(),value))+'px');};
    const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);document.body.classList.remove('resizing');};
    handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
  });
  handle.addEventListener('keydown',e=>{const delta=['ArrowUp','ArrowLeft'].includes(e.key)?-20:['ArrowDown','ArrowRight'].includes(e.key)?20:0;if(!delta)return;e.preventDefault();const current=axis==='x'?$('#right-sidebar').clientWidth:$('#bottom-panel').clientHeight;document.documentElement.style.setProperty(variable,Math.max(min,Math.min(max(),current+delta*(reverse?-1:1)))+'px');});
}
resizeHandle($('#explorer-resizer'),'x','--sidebar-width',200,()=>Math.min(500,innerWidth*.45),true);
resizeHandle($('#panel-resizer'),'y','--panel-height',100,()=>Math.max(110,innerHeight*.6),true);

let uiTimer;
workspace.addEventListener('files',()=>{if(!loading){renderTree();renderChanges();}});
workspace.addEventListener('active',()=>{if(!loading)editorActive();});
workspace.addEventListener('documentchange',e=>{
  analysis?.schedule(e.detail.document);clearTimeout(uiTimer);uiTimer=setTimeout(()=>{renderTabs();renderTree();renderProperties();renderChanges();renderSupport();if(!$('#find-bar').classList.contains('hidden'))updateFind();},100);
  if(traceSession)execute('stop');
  if(settings.liveReload&&previewRunning){clearTimeout(liveTimer);liveTimer=setTimeout(()=>runPreview().catch(err=>log('Live reload: '+err.message,'error','console')),700);}
});
workspace.addEventListener('persisted',()=>{lastPersisted=new Date();});
workspace.addEventListener('storageerror',e=>{toast('Auto-recovery failed. Export a workspace backup. '+(e.detail?.message||''),'error');log('Browser storage is unavailable. Export a backup to keep your work.','error');});
workspace.addEventListener('baseline',renderChanges);
analysis?.addEventListener('result',e=>{renderProblems();if(e.detail===workspace.active){updateSelection();if(sidebarMode==='outline')renderTree();}});
analysis?.addEventListener('error',e=>log(e.detail.message,'error','build'));
editor.addEventListener('selection',updateSelection);
editor.addEventListener('renderer',()=>{$('#renderer-name').textContent=editor.surface.mode;});
editor.addEventListener('error',e=>log('Renderer: '+e.detail,'error'));
editor.addEventListener('stats',e=>{$('#render-stats').textContent=`${e.detail.cpuMs.toFixed(1)} ms · ${e.detail.glyphs.toLocaleString()} glyphs`;});
editor.addEventListener('contextmenu',e=>showMenu(['undo','redo','-','cut','copy','paste','selectAll','-','definition','toggleComment','find'],e.detail.x,e.detail.y));
editor.addEventListener('breakpoint',e=>{
  const {document:doc,line}=e.detail;if(doc.language!=='javascript'){toast('Trace breakpoints are available for standalone JavaScript files. Open scripts/diagnostics.js.');return;}
  try{const {lines}=instrumentTrace(doc.text),target=lines.find(n=>n>=line)??lines.at(-1);if(target===undefined)return;doc.breakpoints.has(target)?doc.breakpoints.delete(target):doc.breakpoints.add(target);editor.invalidate();if(traceSession)runtime.command(traceSession,'breakpoints',{lines:[...doc.breakpoints]});toast(`Trace breakpoint ${doc.breakpoints.has(target)?'set':'removed'} at line ${target+1}.`);}catch(err){toast(err.message,'error');}
});
runtime.addEventListener('console',e=>{const d=e.detail;if(d.mode==='eval')terminalWrite(d.text,d.level==='error'?'error':'');else log(d.text,d.level==='error'?'error':d.level==='warn'?'warn':d.level==='result'?'result':'info','console');});
runtime.addEventListener('ready',e=>{if(e.detail.mode==='preview'){log('Browser preview loaded. Console output is connected.','success','console');status('Running');}});
runtime.addEventListener('error',e=>{const d=e.detail;if(d.mode==='eval')terminalWrite(d.message,'error');else{log(d.message,'error','console');panel('output');}status('Runtime error');});
runtime.addEventListener('test',e=>{testResults.push(e.detail);renderTests();});
runtime.addEventListener('test-summary',e=>{const d=e.detail;$('#test-summary').textContent=`${d.passed} passed · ${d.failed} failed · ${d.total} tests`;log(`${d.passed}/${d.total} tests passed${d.failed?`; ${d.failed} failed`:''}.`,d.failed?'error':'success','build');status(d.failed?'Tests failed':'Tests passed');});
runtime.addEventListener('paused',e=>{const d=e.detail;if(workspace.files.has(d.path)&&workspace.activePath!==d.path)workspace.open(d.path);editor.executionLine=d.line;editor.goto(d.line);$('#trace-state').textContent='Paused';status('Paused at line '+(d.line+1));panel('debug');
  $('#locals-list').innerHTML=Object.keys(d.locals).length?Object.entries(d.locals).map(([key,value])=>`<div class="local-row">${icon('cube')}<span>${escape(key)}</span><span>${escape(value)}</span></div>`).join(''):'<div class="panel-empty">No initialized top-level bindings at this statement.</div>';
});
runtime.addEventListener('complete',e=>{const d=e.detail;if(d.mode==='trace'){traceSession=null;editor.executionLine=undefined;editor.invalidate();}if(d.mode==='run'||d.mode==='trace'){log(d.failed?'Execution failed.':'Execution completed.',d.failed?'error':'success','console');status(d.failed?'Execution failed':'Ready');}runtime.stop(d.session);updateRunState();});
runtime.addEventListener('stopped',e=>{if(e.detail.mode==='trace'){traceSession=null;editor.executionLine=undefined;editor.invalidate();}if(e.detail.mode==='preview'){previewRunning=false;$('#preview-empty').classList.remove('hidden');}updateRunState();});
window.addEventListener('beforeunload',e=>{if([...workspace.files.values()].some(d=>d.dirty)&&!lastPersisted){e.preventDefault();e.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)workspace.persist();});

async function initialize(){
  const saved=await workspace.init();
  try{workspace.load(saved||structuredClone(demoWorkspace));}catch(e){workspace.load(structuredClone(demoWorkspace));toast('Stored workspace was invalid. Loaded the sample instead.','error');}
  loading=false;editorActive();applySettings();renderTests();await editor.ready;$('#renderer-name').textContent=editor.surface.mode;
  log(`${saved?'Restored':'Opened'} solution '${workspace.name}' — ${workspace.files.size} files ready.`,'success');
  log(`${editor.surface.mode} editor initialized. ${editor.surface.mode==='WebGPU'?'Instanced glyph rendering is active.':editor.surface.reason}`,'info');
  log('Web preview: F5   ·   Quick open: Ctrl+P   ·   Commands: Ctrl+Shift+P','info');
  if(workspace.storage)log('Auto-recovery enabled. Export a workspace backup to keep a portable copy.','info');
  try{await analysis?.all(workspace);}catch(e){log(e.message,'error','build');}renderProblems();status('Ready');
  // Explicit public inspection surface for browser automation and integration.
  window.forge={workspace,editor,runtime,analysis,commands:commandMap,execute,settings,version:'1.0.0'};
  document.documentElement.dataset.ready='true';
}
initialize().catch(e=>{console.error(e);toast('Initialization failed: '+e.message,'error');log(e.stack||e.message,'error');});
