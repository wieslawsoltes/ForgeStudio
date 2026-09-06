/** Tiny static ES module packer for the project's acyclic, named-export graph.
 * No packages, network or transpilation. Keeps module scopes separate and
 * preserves function source for the isolated worker / preview bootstraps.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../vendor/acorn.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function bundle(entry){
  const ids=new Map(),chunks=[];
  async function visit(path){
    if(ids.has(path))return ids.get(path);
    const id='__module'+ids.size;ids.set(path,id);
    const source=await readFile(path,'utf8'),ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),edits=[],exports=[];
    for(const node of ast.body){
      if(node.type==='ImportDeclaration'){
        const dependency=await visit(resolve(dirname(path),node.source.value));
        const bindings=node.specifiers.map(s=>s.type==='ImportNamespaceSpecifier'?`const ${s.local.name}=${dependency};`:`const ${s.local.name}=${dependency}[${JSON.stringify(s.type==='ImportDefaultSpecifier'?'default':s.imported.name)}];`).join('\n');
        edits.push({start:node.start,end:node.end,text:bindings});
      }else if(node.type==='ExportNamedDeclaration'){
        if(node.source)throw new Error('Re-export declarations are not used by this build.');
        if(node.declaration){
          const d=node.declaration;
          if(d.type==='VariableDeclaration')for(const v of d.declarations){if(v.id.type!=='Identifier')throw new Error('Unsupported export destructuring');exports.push([v.id.name,v.id.name]);}
          else exports.push([d.id.name,d.id.name]);
          edits.push({start:node.start,end:d.start,text:''});
        }else{for(const s of node.specifiers)exports.push([s.exported.name,s.local.name]);edits.push({start:node.start,end:node.end,text:''});}
      }else if(node.type==='ExportDefaultDeclaration')throw new Error('Default exports are not used by this build.');
    }
    let code=source;for(const e of edits.sort((a,b)=>b.start-a.start))code=code.slice(0,e.start)+e.text+code.slice(e.end);
    chunks.push(`// ${relative(root,path)}\nconst ${id}=(()=>{\n${code}\nreturn {${exports.map(([name,local])=>JSON.stringify(name)+':'+local).join(',')}};\n})();`);
    return id;
  }
  await visit(resolve(root,entry));return chunks.join('\n\n');
}
const worker=await bundle('src/workers/language-worker.js'),main=await bundle('src/app.js');
let html=await readFile(resolve(root,'index.html'),'utf8'),css=await readFile(resolve(root,'styles.css'),'utf8');
const inline=`globalThis.FORGE_LANGUAGE_WORKER_URL=URL.createObjectURL(new Blob([${JSON.stringify(worker).replace(/</g,'\\u003c')}],{type:'text/javascript'}));\n${main}`.replace(/<\/script/gi,'<\\/script');
const encoded=Buffer.from(inline+'\n//# sourceURL=ForgeStudio.bundle.js','utf8').toString('base64');
const loader=`const bytes=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0));\nconst source=new TextDecoder().decode(bytes);\nimport(URL.createObjectURL(new Blob([source],{type:'text/javascript'}))).catch(error=>{console.error(error);document.body.insertAdjacentText('beforeend','Forge Studio failed to start: '+error.message);});`;
html=html.replace('<link rel="stylesheet" href="./styles.css">',()=>`<style>\n${css}\n</style>`).replace('<script type="module" src="./src/app.js"></script>',()=>`<script type="module">\n${loader}\n</script>`);
const notices='Forge Studio\n'+await readFile(resolve(root,'LICENSE'),'utf8')+'\nThird-party component: Acorn 8.15.0\n'+await readFile(resolve(root,'vendor/ACORN-LICENSE'),'utf8');
html=html.replace('</head>',()=>`<!--\n${notices.replace(/-->/g,'-- >')}\n-->\n</head>`);
await writeFile(resolve(root,'ForgeStudio.html'),html);
console.log(`Built ForgeStudio.html (${(Buffer.byteLength(html)/1024).toFixed(0)} KiB).`);
