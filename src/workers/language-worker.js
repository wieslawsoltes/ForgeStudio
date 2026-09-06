import { parse } from '../../vendor/acorn.mjs';
import { basicSymbols } from '../core/languages.js';
function visit(node,callback) {
  if(!node||typeof node!=='object')return;
  if(node.type)callback(node);
  for(const key of Object.keys(node)){
    if(key==='loc')continue;
    const v=node[key];if(Array.isArray(v))for(const child of v)visit(child,callback);else if(v&&typeof v==='object')visit(v,callback);
  }
}
self.onmessage=({data})=>{
  const {id,path,text,language,version}=data;
  const diagnostics=[],symbols=[];
  try{
    if(language==='javascript'){
      const ast=parse(text,{ecmaVersion:'latest',sourceType:'module',locations:true,allowHashBang:true});
      visit(ast,node=>{
        if(['FunctionDeclaration','ClassDeclaration'].includes(node.type)&&node.id)symbols.push({name:node.id.name,kind:node.type==='ClassDeclaration'?'class':'function',line:node.loc.start.line-1,column:node.loc.start.column});
        else if(node.type==='VariableDeclarator'&&node.id.type==='Identifier')symbols.push({name:node.id.name,kind:'variable',line:node.loc.start.line-1,column:node.loc.start.column});
        else if(node.type==='MethodDefinition')symbols.push({name:node.key.name||node.key.value,kind:'method',line:node.loc.start.line-1,column:node.loc.start.column});
      });
    }else if(language==='json')JSON.parse(text);
    else symbols.push(...basicSymbols(text,language));
  }catch(error){
    let line=Math.max(0,(error.loc?.line||1)-1),column=error.loc?.column||0;
    if(language==='json'){
      const position=/position (\d+)/.exec(error.message);
      if(position){const before=text.slice(0,+position[1]).split('\n');line=before.length-1;column=before.at(-1).length;}
    }
    diagnostics.push({severity:'error',source:language==='json'?'JSON':'JavaScript',message:error.message.replace(/\s*\(\d+:\d+\)$/,''),line,column});
  }
  self.postMessage({id,path,version,diagnostics,symbols:symbols.slice(0,500)});
};
