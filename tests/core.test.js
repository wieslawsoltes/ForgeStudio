import test from 'node:test';
import assert from 'node:assert/strict';
import { PieceTable, TextDocument } from '../src/core/text-buffer.js';
import { normalizePath, Workspace } from '../src/core/workspace.js';
import { tokenizeLine, TOKEN, TokenCache } from '../src/core/languages.js';
import { findMatches, lineDiff } from '../src/core/search.js';
import { crc32, createZip } from '../src/core/zip.js';
import { planModule, modulePlans, rewritePlan, instrumentTrace, resolveImport } from '../src/core/runtime.js';
import { demoWorkspace, newWorkspace } from '../src/demo.js';

function checkTree(table) {
  function visit(node){
    if(!node)return {length:0,newlines:0};
    const a=visit(node.left),b=visit(node.right);
    const text=table.buffers[node.buffer].text.slice(node.start,node.start+node.count);
    assert.equal(node.length,a.length+text.length+b.length);
    assert.equal(node.newlines,a.newlines+(text.match(/\n/g)||[]).length+b.newlines);
    if(node.left)assert.ok(node.priority<=node.left.priority);
    if(node.right)assert.ok(node.priority<=node.right.priority);
    return {length:node.length,newlines:node.newlines};
  }visit(table.root);
}
test('piece treap supports empty, insert, replace, delete and compact',()=>{
  const b=new PieceTable();assert.equal(b.length,0);assert.equal(b.lineCount,1);assert.deepEqual(b.positionAt(0),{line:0,column:0});
  b.replace(0,0,'hello\nworld');assert.equal(b.getLine(1),'world');assert.equal(b.offsetAt(1,2),8);
  b.replace(3,8,'x\ny');assert.equal(b.toString(),'helx\nyrld');b.replace(0,b.length,'');assert.equal(b.toString(),'');assert.equal(b.lineCount,1);
  b.replace(0,0,'a\nb\n');b.compact();assert.equal(b.getLine(2),'');checkTree(b);
});
test('piece treap matches a reference string across 4,000 randomized UTF-16 edits',()=>{
  let state=73452;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const b=new PieceTable('initial\ntext\n');let reference=b.toString();
  const inserted=['','x','abc','\n','αβ\n','😀','a\nb\nc','👩‍💻',' \t'];
  for(let i=0;i<4000;i++){
    const a=Math.floor(random()*(reference.length+1)),z=a+Math.floor(random()*(reference.length-a+1)),text=inserted[Math.floor(random()*inserted.length)];
    b.replace(a,z,text);reference=reference.slice(0,a)+text+reference.slice(z);
    assert.equal(b.toString(),reference);assert.equal(b.length,reference.length);assert.equal(b.lineCount,reference.split('\n').length);
    for(let j=0;j<3;j++){const offset=Math.floor(random()*(reference.length+1)),prefix=reference.slice(0,offset).split('\n');assert.deepEqual(b.positionAt(offset),{line:prefix.length-1,column:prefix.at(-1).length});}
    reference.split('\n').forEach((line,index)=>{assert.equal(b.getLine(index),line);assert.equal(b.offsetAt(index,0),reference.split('\n').slice(0,index).reduce((n,l)=>n+l.length+1,0));});
    if(i%100===0)checkTree(b);
  }checkTree(b);
});
test('large document line lookup remains exact after insertion',()=>{
  const text=Array.from({length:100000},(_,i)=>'line '+i).join('\n'),b=new PieceTable(text);
  assert.equal(b.getLine(99999),'line 99999');const at=b.offsetAt(54321,4);b.replace(at,at,'\ninserted\n');assert.equal(b.lineCount,100002);assert.equal(b.getLine(54322),'inserted');checkTree(b);
});
test('history coalesces typing and supports undo, redo, divergent edits',()=>{
  const d=new TextDocument('a.js','start\r\n');assert.equal(d.eol,'\r\n');assert.equal(d.text,'start\n');
  d.setSelection(d.buffer.length);d.edit(6,6,'a',{kind:'typing'});d.edit(7,7,'b',{kind:'typing'});assert.equal(d.undoStack.length,1);
  d.undo();assert.equal(d.text,'start\n');assert.deepEqual(d.selection,{anchor:6,head:6});d.redo();assert.equal(d.text,'start\nab');
  d.undo();d.edit(0,0,'x');assert.equal(d.redo(),false);assert.equal(d.dirty,true);d.markSaved();assert.equal(d.dirty,false);
});
test('buffer rejects invalid ranges',()=>{const b=new PieceTable('abc');assert.throws(()=>b.replace(-1,0,''),RangeError);assert.throws(()=>b.replace(2,1,''),RangeError);assert.throws(()=>b.replace(0,8,''),RangeError);});
test('lexer maintains multiline state and resets after comments',()=>{
  const a=tokenizeLine('/* comment','javascript');assert.equal(a.state,'comment');assert.equal(a.tokens[0].kind,TOKEN.comment);
  const b=tokenizeLine('end */ const x = 42;','javascript',a.state);assert.equal(b.state,'');assert.ok(b.tokens.some(t=>t.kind===TOKEN.keyword));assert.ok(b.tokens.some(t=>t.kind===TOKEN.number));
  const c=tokenizeLine('const text = `hello','javascript');assert.equal(c.state,'`');assert.equal(tokenizeLine('world`;','javascript',c.state).state,'');
});
test('token cache invalidates state from the edited line',()=>{
  const d=new TextDocument('a.js','/* open\nhello\nend */\nconst a = 1;'),c=new TokenCache(d);assert.equal(c.line(1)[0].kind,TOKEN.comment);
  d.edit(0,7,'// open');c.invalidate(0);assert.notEqual(c.line(1)[0].kind,TOKEN.comment);
});
test('literal search escapes regex operators, honors case and whole word',()=>{
  assert.equal(findMatches('x.a X.A x-a','x.a').length,2);assert.equal(findMatches('cat scatter Cat','cat',{wholeWord:true}).length,2);assert.equal(findMatches('cat Cat','cat',{caseSensitive:true}).length,1);assert.equal(findMatches('hello','').length,0);
});
test('line diff produces a reversible edit stream',()=>{
  const before='a\nb\nc',after='a\nx\nc\nd',diff=lineDiff(before,after);
  assert.equal(diff.filter(x=>x.kind!=='added').map(x=>x.text).join('\n'),before);
  assert.equal(diff.filter(x=>x.kind!=='removed').map(x=>x.text).join('\n'),after);
});
test('safe virtual paths normalize and reject workspace escape',()=>{
  assert.equal(normalizePath('a\\b/../c.js'),'a/c.js');assert.equal(normalizePath('./src/main.js'),'src/main.js');assert.throws(()=>normalizePath('../a'));assert.throws(()=>normalizePath('a\0b'));assert.throws(()=>normalizePath('https://x.com'));
});
test('workspace preserves modifications, additions, deletions and rename in local diffs',()=>{
  const w=new Workspace();w.load(newWorkspace('javascript','Test'));assert.equal(w.changes().length,0);
  w.add('new.txt','hello');assert.equal(w.changes()[0].kind,'added');w.rename('main.js','renamed.js');assert.ok(w.changes().some(c=>c.path==='main.js'&&c.kind==='deleted'));
  const serialized=w.serialize();const restored=new Workspace();restored.load(serialized);assert.deepEqual(restored.changes(),w.changes());
  w.setBaseline();assert.equal(w.changes().length,0);w.delete('new.txt');assert.equal(w.changes()[0].kind,'deleted');clearTimeout(w.autosaveTimer);clearTimeout(restored.autosaveTimer);
});
test('workspace import rejects duplicates and malformed backups before replacing files',()=>{
  const w=new Workspace();w.load(newWorkspace('javascript','Test'));const original=w.activePath;
  assert.throws(()=>w.load({format:'forge-workspace',version:1,files:[{path:'a.js',text:''},{path:'a.js',text:''}]}));assert.equal(w.activePath,original);
  assert.throws(()=>w.load({format:'forge-workspace',version:1,files:[{path:'a',text:44}]}));clearTimeout(w.autosaveTimer);
});
test('module resolver rewrites AST import sites but leaves ordinary strings intact',()=>{
  const files={'src/a.js':`import {x} from './b.js';\nconst fake = "./b.js";\nexport {x};\nimport('./b.js');`,'src/b.js':'export const x=42;'};
  const plan=planModule(files['src/a.js'],'src/a.js',files);assert.equal(plan.imports.length,2);
  const rewritten=rewritePlan(plan,p=>'forge:/'+p);assert.ok(rewritten.includes('from "forge:/src/b.js"'));assert.ok(rewritten.includes('const fake = "./b.js"'));
  assert.throws(()=>resolveImport('src/a.js','react',files));assert.throws(()=>planModule('import(name)','src/a.js',files));
});
test('all included JavaScript modules and test dependencies parse and resolve',()=>{
  const files=Object.fromEntries(demoWorkspace.files.map(f=>[f.path,f.text]));const plans=modulePlans(files);assert.ok(Object.keys(plans).length>=5);
  assert.equal(plans['Nebula.Web/src/app.js'].imports.length,2);
});
test('trace instrumentation snapshots only initialized top-level bindings',async()=>{
  const source='const x=2;\nconst y=x+3;\nglobalThis.__traceTest=y;',result=instrumentTrace(source);assert.deepEqual(result.lines,[0,1,2]);
  const snapshots=[],AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction('__checkpoint',result.code)(async(line,get)=>snapshots.push({line,values:get()}));
  assert.deepEqual(snapshots.map(s=>s.values),[{}, {x:2}, {x:2,y:5}]);assert.equal(globalThis.__traceTest,5);delete globalThis.__traceTest;
  assert.throws(()=>instrumentTrace('import x from "./x.js";'));
});
test('ZIP writer produces valid headers and canonical CRC32',async()=>{
  assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
  const bytes=new Uint8Array(await createZip({'hello.txt':'Hello','src/α.js':'const x=1;'}).arrayBuffer()),v=new DataView(bytes.buffer);
  assert.equal(v.getUint32(0,true),0x04034b50);assert.equal(v.getUint32(bytes.length-22,true),0x06054b50);assert.equal(v.getUint16(bytes.length-14,true),2);
});
test('undo returns to the saved revision without flattening the document',()=>{
  const d=new TextDocument('a.js','a');d.edit(1,1,'b',{kind:'typing'});d.markSaved();
  d.edit(2,2,'c',{kind:'typing'});assert.equal(d.undoStack.length,2);assert.equal(d.dirty,true);
  d.undo();assert.equal(d.text,'ab');assert.equal(d.dirty,false);d.redo();assert.equal(d.dirty,true);
  d.undo();d.undo();assert.equal(d.text,'a');assert.equal(d.dirty,true);
});
test('invalid document edits leave history and source unchanged',()=>{
  const d=new TextDocument('a.js','a');assert.throws(()=>d.edit(10,10,'x'),RangeError);assert.equal(d.text,'a');assert.equal(d.undoStack.length,0);
});
test('saving an earlier in-flight snapshot does not mark later edits saved',()=>{
  const d=new TextDocument('a.js','a');d.edit(1,1,'b');const text=d.text,revision=d.revision;d.edit(2,2,'c');d.markSaved(text,revision);
  assert.equal(d.savedText,'ab');assert.equal(d.dirty,true);d.undo();assert.equal(d.text,'ab');assert.equal(d.dirty,false);
});
