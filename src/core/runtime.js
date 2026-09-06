import { parse } from '../../vendor/acorn.mjs';
import { normalizePath } from './workspace.js';
function walk(node,fn){if(!node||typeof node!=='object')return;if(node.type)fn(node);for(const [k,v] of Object.entries(node)){if(k==='loc')continue;if(Array.isArray(v))v.forEach(n=>walk(n,fn));else if(v&&typeof v==='object')walk(v,fn);}}
export function resolveImport(owner,specifier,files){
  if(!specifier.startsWith('.')&&!specifier.startsWith('/'))throw new Error(`External package "${specifier}" is not available. Import a local module instead.`);
  const path=normalizePath(specifier.startsWith('/')?specifier.slice(1):owner.split('/').slice(0,-1).join('/')+'/'+specifier);
  const found=[path,path+'.js',path+'.mjs',path+'/index.js'].find(p=>Object.hasOwn(files,p));
  if(!found)throw new Error(`Cannot resolve "${specifier}" from ${owner}.`);
  if(!/\.(m?js|json)$/.test(found))throw new Error(`Module imports support .js, .mjs, and .json files, not ${found}.`);
  return found;
}
export function planModule(code,path,files){
  const ast=parse(code,{ecmaVersion:'latest',sourceType:'module',locations:true}),imports=[];
  walk(ast,node=>{
    if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source){imports.push({start:node.source.start,end:node.source.end,path:resolveImport(path,node.source.value,files)});}
    if(node.type==='ImportExpression'){
      if(node.source.type!=='Literal'||typeof node.source.value!=='string')throw new Error(`${path}: computed dynamic imports are not supported by the virtual module loader.`);
      imports.push({start:node.source.start,end:node.source.end,path:resolveImport(path,node.source.value,files)});
    }
  });return {code,imports:imports.sort((a,b)=>b.start-a.start)};
}
export function modulePlans(files){
  const plans={};for(const [path,text] of Object.entries(files)){
    if(/\.m?js$/.test(path))plans[path]=planModule(text,path,files);
    else if(path.endsWith('.json'))plans[path]={code:'export default '+JSON.stringify(JSON.parse(text))+';',imports:[]};
  }return plans;
}
export function rewritePlan(plan,mapper){let code=plan.code;for(const item of plan.imports)code=code.slice(0,item.start)+JSON.stringify(mapper(item.path))+code.slice(item.end);return code;}
function safeJSON(value){return JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');}
const CSP="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; worker-src blob:; frame-src 'none'; form-action 'none'; base-uri 'none'";
function previewBootstrap(payload){
  const send=(type,data)=>parent.postMessage({forge:payload.token,type,...data},'*');let count=0;
  const format=v=>{try{if(typeof v==='string')return v;if(v instanceof Error)return v.stack||v.message;return JSON.stringify(v,(_,x)=>typeof x==='bigint'?x+'n':x,2)??String(v);}catch{return String(v);}};
  for(const level of ['log','info','warn','error','debug','table']){const original=console[level];console[level]=(...args)=>{original.apply(console,args);if(count++<500)send('console',{level,text:args.map(format).join(' ').slice(0,8000)});};}
  addEventListener('error',e=>send('error',{message:e.message}));addEventListener('unhandledrejection',e=>send('error',{message:format(e.reason)}));
  const imports={};for(const [path,code]of Object.entries(payload.modules))imports['forge:/'+path]=URL.createObjectURL(new Blob([code+'\n//# sourceURL=forge:/'+path],{type:'text/javascript'}));
  const map=document.createElement('script');map.type='importmap';map.textContent=JSON.stringify({imports});document.head.append(map);
  addEventListener('DOMContentLoaded',()=>send('ready',{entry:payload.entry}));
}
export function buildPreview(files,entry,token){
  if(!Object.hasOwn(files,entry))throw new Error('The preview entry point does not exist.');
  const plans=modulePlans(files),modules=Object.fromEntries(Object.entries(plans).map(([path,p])=>[path,rewritePlan(p,x=>'forge:/'+x)]));
  const html=new DOMParser().parseFromString(files[entry],'text/html');
  for(const base of html.querySelectorAll('base'))base.remove();
  for(const element of html.querySelectorAll('link[rel="stylesheet"]')){
    const href=element.getAttribute('href');if(!href||/^[\w]+:|^\/\//.test(href))throw new Error('Preview stylesheets must be local workspace files.');
    const path=normalizePath(entry.split('/').slice(0,-1).join('/')+'/'+href);
    if(!Object.hasOwn(files,path))throw new Error('Missing stylesheet: '+path);
    const style=html.createElement('style');style.textContent=files[path];element.replaceWith(style);
  }
  for(const script of html.querySelectorAll('script')){
    const src=script.getAttribute('src');
    if(src){
      const path=resolveImport(entry,src.startsWith('.')||src.startsWith('/')?src:'./'+src,files);
      script.removeAttribute('src');script.removeAttribute('integrity');
      if(script.type==='module')script.textContent='import '+JSON.stringify('forge:/'+path)+';';
      else script.textContent=files[path];
    }else if(script.type==='module')script.textContent=rewritePlan(planModule(script.textContent,entry,files),x=>'forge:/'+x);
  }
  const meta=html.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.content=CSP;
  const boot=html.createElement('script');boot.textContent=`(${previewBootstrap.toString()})(${safeJSON({token,modules,entry})});`;
  html.head.prepend(meta,boot);
  return '<!doctype html>\n'+html.documentElement.outerHTML;
}

export function instrumentTrace(code){
  const ast=parse(code,{ecmaVersion:'latest',sourceType:'module',locations:true});
  if(ast.body.some(n=>n.type.startsWith('Import')||n.type.startsWith('Export')))throw new Error('Trace mode supports standalone JavaScript without imports or exports. Open scripts/diagnostics.js for a runnable example.');
  const edits=[],names=new Set(),lines=[];
  const addNames=n=>{if(!n)return;if(n.type==='Identifier')names.add(n.name);else if(n.type==='ObjectPattern')n.properties.forEach(p=>addNames(p.value||p.argument));else if(n.type==='ArrayPattern')n.elements.forEach(addNames);else if(n.type==='AssignmentPattern')addNames(n.left);else if(n.type==='RestElement')addNames(n.argument);};
  for(const node of ast.body){
    if(node.type==='EmptyStatement'||node.directive)continue;
    const line=node.loc.start.line-1;lines.push(line);
    edits.push({position:node.start,text:`await __checkpoint(${line}, () => ({${[...names].map(n=>JSON.stringify(n)+':'+n).join(',')}}));\n`});
    if(node.type==='VariableDeclaration')node.declarations.forEach(n=>addNames(n.id));
    if(['FunctionDeclaration','ClassDeclaration'].includes(node.type)&&node.id)names.add(node.id.name);
  }
  for(const edit of edits.reverse())code=code.slice(0,edit.position)+edit.text+code.slice(edit.position);
  return {code,lines};
}

// This function becomes an isolated, terminable Worker in an opaque-origin frame.
// It deliberately exposes no bridge to the parent filesystem or workspace state.
function executionWorker(){
  let resolvePause=null,stepping=false,breakpoints=new Set(),outputCount=0;
  const send=(type,data={})=>postMessage({type,...data});
  const format=value=>{
    try{if(typeof value==='function')return '[Function '+(value.name||'anonymous')+']';if(typeof value==='string')return value;if(value instanceof Error)return value.stack||value.message;return JSON.stringify(value,(_,v)=>typeof v==='bigint'?v+'n':v,2)??String(value);}catch{return '[Unserializable value]';}
  };
  const inspect=values=>Object.fromEntries(Object.entries(values).slice(0,80).map(([k,v])=>[k,format(v).slice(0,2000)]));
  for(const level of ['log','info','warn','error','debug','table'])console[level]=(...args)=>{if(outputCount++<500)send('console',{level,text:args.map(format).join(' ').slice(0,8000)});};
  const tests=[];
  globalThis.test=(name,run)=>tests.push({name,run});
  globalThis.assert=Object.assign((condition,message='Assertion failed')=>{if(!condition)throw new Error(message);},{
    equal:(actual,expected,message)=>{if(!Object.is(actual,expected))throw new Error(message||`Expected ${format(expected)}, got ${format(actual)}`);},
    deepEqual:(actual,expected)=>{if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`Expected ${format(expected)}, got ${format(actual)}`);},
    throws:fn=>{let didThrow=false;try{fn();}catch{didThrow=true;}if(!didThrow)throw new Error('Expected the function to throw');}
  });
  const checkpoint=async(line,getLocals)=>{
    if(stepping||breakpoints.has(line)){
      let locals={};try{locals=inspect(getLocals());}catch(e){locals={'<snapshot>':e.message};}
      send('paused',{line,locals});await new Promise(resolve=>{resolvePause=resolve;});
    }
  };
  self.onmessage=async({data})=>{
    if(data.command==='step'||data.command==='continue'){stepping=data.command==='step';resolvePause?.();resolvePause=null;return;}
    if(data.command==='breakpoints'){breakpoints=new Set(data.lines);return;}
    if(data.command!=='start')return;
    try{
      if(data.mode==='trace'){
        stepping=true;breakpoints=new Set(data.breakpoints||[]);
        const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
        await new AsyncFunction('__checkpoint',data.code)(checkpoint);
      }else if(data.mode==='eval'){
        const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;let fn;
        try{fn=new AsyncFunction('return ('+data.code+'\n)');}catch{fn=new AsyncFunction(data.code);}
        const result=await fn();send('console',{level:'result',text:format(result)});
      }else{
        for(const entry of data.entries)await import(entry);
        if(data.mode==='test'){
          let passed=0,failed=0;
          for(const {name,run}of tests){const start=performance.now();try{await run();passed++;send('test',{name,passed:true,duration:performance.now()-start});}catch(e){failed++;send('test',{name,passed:false,message:e.message,duration:performance.now()-start});}}
          send('test-summary',{passed,failed,total:tests.length});
        }
      }
      send('complete');
    }catch(e){send('error',{message:e.stack||e.message||String(e)});send('complete',{failed:true});}
  };
}
function sandboxBootstrap(payload){
  const send=(type,data={})=>parent.postMessage({forge:payload.token,type,...data},'*');
  const urls={},visiting=new Set();
  const materialize=path=>{
    if(urls[path])return urls[path];
    if(visiting.has(path))throw new Error('Worker execution cannot resolve cyclic imports; the browser preview supports them.');
    const plan=payload.plans[path];if(!plan)throw new Error('Module not found: '+path);
    visiting.add(path);let code=plan.code;
    for(const item of plan.imports){const target=materialize(item.path);code=code.slice(0,item.start)+JSON.stringify(target)+code.slice(item.end);}
    visiting.delete(path);return urls[path]=URL.createObjectURL(new Blob([code+'\n//# sourceURL=forge:/'+path],{type:'text/javascript'}));
  };
  try{
    const entries=(payload.entries||[]).map(materialize);
    const worker=new Worker(URL.createObjectURL(new Blob(['('+payload.worker+')()'],{type:'text/javascript'})),{type:'classic'});
    worker.onmessage=({data})=>send(data.type,data);
    worker.onerror=e=>{send('error',{message:e.message});send('complete',{failed:true});};
    addEventListener('message',e=>{if(e.source!==parent||e.data?.forge!==payload.token)return;if(e.data.command==='stop')worker.terminate();else worker.postMessage(e.data);});
    worker.postMessage({...payload,entries,command:'start'});
  }catch(e){send('error',{message:e.message});send('complete',{failed:true});}
}
function sessionToken(){return [...crypto.getRandomValues(new Uint8Array(24))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export class Runtime extends EventTarget {
  constructor(){super();this.sessions=new Map();window.addEventListener('message',e=>this.receive(e));}
  receive(e){
    const session=this.sessions.get(e.data?.forge);
    if(!session||e.source!==session.frame.contentWindow)return;
    const data=e.data;if(data.type==='paused'){clearTimeout(session.timeout);session.paused=true;}
    if(data.type==='complete'){clearTimeout(session.timeout);session.finished=true;session.resolve?.(data);}
    this.dispatchEvent(new CustomEvent(data.type,{detail:{...data,session:session.token,mode:session.mode,path:session.path}}));
  }
  preview(frame,files,entry){
    this.stopMode('preview');const token=sessionToken();
    const html=buildPreview(files,entry,token);
    this.sessions.set(token,{token,frame,mode:'preview',path:entry});frame.setAttribute('sandbox','allow-scripts');frame.srcdoc=html;return token;
  }
  execute(files,{entries=[],mode='run',code='',breakpoints=[],path=''}={}){
    this.stopMode('run');this.stopMode('trace');this.stopMode('test');this.stopMode('eval');
    const token=sessionToken(),frame=document.createElement('iframe');frame.hidden=true;frame.setAttribute('sandbox','allow-scripts');frame.title='Isolated execution worker';
    const plans=['run','test'].includes(mode)?modulePlans(files):{};
    const payload={token,mode,plans,entries,code,breakpoints,worker:executionWorker.toString()};
    const session={token,frame,mode,path,paused:false};
    session.finishedPromise=new Promise(resolve=>session.resolve=resolve);
    this.sessions.set(token,session);document.body.append(frame);
    frame.srcdoc=`<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><script>(${sandboxBootstrap.toString()})(${safeJSON(payload)})<\/script>`;
    this.watchdog(session);return session;
  }
  watchdog(session){clearTimeout(session.timeout);session.timeout=setTimeout(()=>{this.dispatchEvent(new CustomEvent('error',{detail:{message:'Execution exceeded the 10-second limit and was terminated.',session:session.token,mode:session.mode}}));this.stop(session.token);},10000);}
  command(token,command,extra={}){const s=this.sessions.get(token);if(!s||s.finished)return;s.frame.contentWindow.postMessage({forge:token,command,...extra},'*');if(['step','continue'].includes(command)){s.paused=false;this.watchdog(s);}}
  stop(token){
    const s=this.sessions.get(token);if(!s)return;clearTimeout(s.timeout);
    if(s.mode==='preview')s.frame.srcdoc='';else {s.frame.contentWindow?.postMessage({forge:token,command:'stop'},'*');s.frame.remove();}
    s.resolve?.({stopped:true});this.sessions.delete(token);this.dispatchEvent(new CustomEvent('stopped',{detail:{session:token,mode:s.mode}}));
  }
  stopMode(mode){for(const s of this.sessions.values())if(s.mode===mode)this.stop(s.token);}
  stopAll(){for(const token of [...this.sessions.keys()])this.stop(token);}
}
