import { Surface } from '../render/surface.js';
import { TokenCache, completions, tokenizeLine } from '../core/languages.js';
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const pairs={'(':')','[':']','{':'}','"':'"',"'":"'",'`':'`'};

export class CodeEditor extends EventTarget {
  constructor(host,options={}) {
    super();this.host=host;this.options={fontSize:14,theme:'dark',tabSize:4,minimap:true,ligatures:false,...options};
    this.document=null;this.layouts=new Map();this.gutter=70;this.padding=12;this.blink=true;this.focused=false;
    this.canvas=document.createElement('canvas');this.canvas.className='editor-canvas';this.canvas.setAttribute('aria-hidden','true');
    this.scroller=document.createElement('div');this.scroller.className='editor-scroller';
    this.spacer=document.createElement('div');this.spacer.className='editor-spacer';this.scroller.append(this.spacer);
    this.input=document.createElement('textarea');this.input.className='editor-input';this.input.setAttribute('aria-label','Code editor. Press F1 for keyboard shortcuts.');this.input.spellcheck=false;this.input.autocomplete='off';this.input.autocapitalize='off';
    this.accessible=document.createElement('textarea');this.accessible.className='accessible-editor hidden';this.accessible.spellcheck=false;this.accessible.setAttribute('aria-label','Accessible source editor');
    this.suggest=document.createElement('div');this.suggest.className='suggestions hidden';this.suggest.setAttribute('role','listbox');
    host.append(this.canvas,this.scroller,this.input,this.accessible,this.suggest);
    this.surface=new Surface(this.canvas,this.options);this.surface.addEventListener('ready',()=>{this.updateDimensions();this.invalidate();this.dispatchEvent(new Event('renderer'));});
    this.surface.addEventListener('error',e=>this.dispatchEvent(new CustomEvent('error',{detail:e.detail})));
    this.ready=this.surface.init().then(()=>{this.updateDimensions();this.invalidate();});
    this.resizeObserver=new ResizeObserver(()=>{this.updateDimensions();this.invalidate();});this.resizeObserver.observe(host);
    this.scroller.addEventListener('scroll',()=>{if(this.document){this.document.scrollTop=this.scroller.scrollTop;this.document.scrollLeft=this.scroller.scrollLeft;}this.hideSuggestions();this.invalidate();});
    this.scroller.addEventListener('pointerdown',e=>this.pointerDown(e));
    this.scroller.addEventListener('pointermove',e=>this.pointerMove(e));
    this.scroller.addEventListener('pointerup',()=>{this.dragging=false;});
    this.scroller.addEventListener('pointercancel',()=>{this.dragging=false;});
    this.scroller.addEventListener('dblclick',e=>this.selectWord(this.offsetFromPoint(e.clientX,e.clientY)));
    this.scroller.addEventListener('contextmenu',e=>{e.preventDefault();this.dispatchEvent(new CustomEvent('contextmenu',{detail:{x:e.clientX,y:e.clientY}}));});
    this.input.addEventListener('focus',()=>{this.focused=true;this.blink=true;this.invalidate();});
    this.input.addEventListener('blur',()=>{this.focused=false;this.hideSuggestions();this.invalidate();});
    this.input.addEventListener('keydown',e=>this.keyDown(e));
    this.input.addEventListener('beforeinput',e=>this.beforeInput(e));
    this.input.addEventListener('input',()=>{if(!this.composing)this.input.value='';});
    this.input.addEventListener('compositionstart',()=>{this.composing=true;this.input.classList.add('composing');});
    this.input.addEventListener('compositionend',e=>{
      this.composing=false;this.input.classList.remove('composing');if(e.data)this.insert(e.data,'composition');this.input.value='';this.ignoreCompositionInput=true;setTimeout(()=>this.ignoreCompositionInput=false,0);
    });
    for(const type of ['copy','cut','paste'])this.input.addEventListener(type,e=>this.clipboard(e));
    this.accessible.addEventListener('input',()=>{
      if(!this.document)return;
      const old=this.document.text,next=this.accessible.value;let a=0,b=old.length,c=next.length;
      while(a<b&&a<c&&old[a]===next[a])a++;
      while(b>a&&c>a&&old[b-1]===next[c-1]){b--;c--;}
      this.document.edit(a,b,next.slice(a,c),{selection:{anchor:this.accessible.selectionStart,head:this.accessible.selectionEnd}});
    });
    this.accessible.addEventListener('select',()=>{if(this.accessibleMode&&this.document)this.document.setSelection(this.accessible.selectionStart,this.accessible.selectionEnd);});
    this.caretTimer=setInterval(()=>{if(this.focused&&!document.hidden){this.blink=!this.blink;this.invalidate();}},530);
    this.findMatches=[];
  }
  get lineHeight(){return this.surface.atlas.lineHeight;}
  get charWidth(){return this.surface.atlas.charWidth;}
  setDocument(doc) {
    this.docEvents?.abort();this.docEvents=new AbortController();this.document=doc;
    this.layouts.clear();this.minimapData=null;this.maxWidth=400;
    if(doc){
      this.tokens=new TokenCache(doc);
      doc.addEventListener('change',e=>{
        this.tokens.invalidate(e.detail.startLine);this.layouts.clear();this.minimapData=null;
        if(this.accessibleMode&&this.accessible.value!==doc.text)this.accessible.value=doc.text;
        this.updateDimensions();this.ensureVisible();this.blink=true;this.invalidate();
        this.dispatchEvent(new Event('change'));
      },{signal:this.docEvents.signal});
      doc.addEventListener('selection',()=>{this.blink=true;this.invalidate();this.dispatchEvent(new Event('selection'));},{signal:this.docEvents.signal});
      this.input.setAttribute('aria-label',`Code editor: ${doc.path}. Press F1 for keyboard shortcuts.`);
      this.accessible.value=doc.text;
    }
    this.updateDimensions();this.scroller.scrollTop=doc?.scrollTop||0;this.scroller.scrollLeft=doc?.scrollLeft||0;
    this.hideSuggestions();this.findMatches=[];this.invalidate();
  }
  layout(line) {
    if(this.layouts.has(line))return this.layouts.get(line);
    const text=this.document.buffer.getLine(line),items=[];let column=0;
    for(const {segment,index} of segmenter.segment(text)){
      const width=segment==='\t'?this.options.tabSize-column%this.options.tabSize:[...segment].some(c=>c.codePointAt(0)>0x2e80)?2:1;
      items.push({text:segment,start:index,end:index+segment.length,column,width});column+=width;
    }
    const value={text,items,columns:column};this.layouts.set(line,value);
    if(this.layouts.size>700)this.layouts.delete(this.layouts.keys().next().value);
    return value;
  }
  visualColumn(line,column){const l=this.layout(line);const item=l.items.find(x=>x.start>=column);return item?item.column:l.columns;}
  utfColumn(line,column){const l=this.layout(line);const item=l.items.find(x=>x.column+x.width/2>column);return item?item.start:l.text.length;}
  updateDimensions(){
    const w=this.host.clientWidth,h=this.host.clientHeight;this.surface.resize(w,h);
    this.spacer.style.height=`${Math.max(h,(this.document?.buffer.lineCount||1)*this.lineHeight+this.padding*2+h*.3)}px`;
    this.spacer.style.width=`${Math.max(w,this.maxWidth+this.gutter+this.minimapWidth+40)}px`;
  }
  get minimapWidth(){return this.options.minimap&&this.host.clientWidth>520?84:0;}
  invalidate(){if(this.framePending)return;this.framePending=true;requestAnimationFrame(()=>{this.framePending=false;this.render();});}
  render(){
    if(!this.host.clientWidth||!this.host.clientHeight)return;
    const s=this.surface,p=s.palette,w=this.host.clientWidth,h=this.host.clientHeight,doc=this.document;
    s.begin();
    if(!doc){s.text('Open a file to start building.',this.gutter,48,p.muted);s.end();return;}
    const b=doc.buffer,lh=this.lineHeight,cw=this.charWidth,scrollY=this.scroller.scrollTop,scrollX=this.scroller.scrollLeft;
    const first=Math.max(0,Math.floor((scrollY-this.padding)/lh)),last=Math.min(b.lineCount-1,Math.ceil((scrollY+h)/lh));
    const pos=b.positionAt(doc.selection.head),a=Math.min(doc.selection.anchor,doc.selection.head),z=Math.max(doc.selection.anchor,doc.selection.head);
    const start=b.positionAt(a),end=b.positionAt(z),textX=this.gutter-scrollX,right=w-this.minimapWidth-12;
    if(this.executionLine!==undefined)s.rect(this.gutter,this.padding+this.executionLine*lh-scrollY,right-this.gutter,lh,'#a28b372a');
    s.rect(0,this.padding+pos.line*lh-scrollY,right,lh,p.line);
    for(let line=first;line<=last;line++){
      const y=this.padding+line*lh-scrollY,l=this.layout(line),lineStart=b.lineStart(line);
      if(a!==z&&line>=start.line&&line<=end.line){
        const x1=line===start.line?this.visualColumn(line,start.column)*cw:0;
        const x2=line===end.line?this.visualColumn(line,end.column)*cw:(l.columns+1)*cw;
        const x=Math.max(this.gutter,textX+x1),endX=Math.min(right,textX+x2);
        s.rect(x,y,endX-x,lh,p.selection);
      }
      for(const match of this.findMatches){
        if(match.end<lineStart||match.start>lineStart+l.text.length)continue;
        const x1=this.visualColumn(line,Math.max(0,match.start-lineStart))*cw,x2=this.visualColumn(line,Math.min(l.text.length,match.end-lineStart))*cw;
        const x=Math.max(this.gutter,textX+x1);s.rect(x,y,Math.min(right,textX+x2)-x,lh,p.match);
      }
      const indent=l.text.match(/^\s*/)?.[0].length||0;
      for(let col=this.options.tabSize;col<indent;col+=this.options.tabSize){const x=textX+col*cw;if(x>=this.gutter&&x<right)s.rect(x,y,1,lh,p.guide);}
      const tokens=this.tokens.line(line);let t=0;
      for(const item of l.items){
        const x=textX+item.column*cw;if(x<this.gutter-.1||x>right-cw)continue;
        while(t<tokens.length-1&&tokens[t].end<=item.start)t++;
        s.glyph(item.text,x,y,p.tokens[tokens[t]?.kind||0]);
      }
      for(const d of doc.diagnostics.filter(d=>d.line===line)){
        const x=textX+this.visualColumn(line,d.column)*cw;
        for(let i=0;i<Math.min(5,l.text.length-d.column||1)*cw;i+=4)if(x+i>=this.gutter&&x+i<right){s.rect(x+i,y+lh-3,2,1,p.error);s.rect(x+i+2,y+lh-2,2,1,p.error);}
      }
      this.maxWidth=Math.max(this.maxWidth,l.columns*cw);
    }
    s.rect(0,0,this.gutter-9,h,p.gutter);
    for(let line=first;line<=last;line++){
      const y=this.padding+line*lh-scrollY,num=String(line+1);
      s.text(num,this.gutter-23-num.length*cw,y,line===pos.line?p.text:p.muted);
      if(doc.breakpoints.has(line)) {s.rect(9,y+8,9,9,p.breakpoint);s.rect(11,y+6,5,13,p.breakpoint);}
      if(this.executionLine===line)s.text('›',9,y,'#e5ca7d');
    }
    if(this.focused&&this.blink&&a===z&&!this.accessibleMode){
      const x=textX+this.visualColumn(pos.line,pos.column)*cw,y=this.padding+pos.line*lh-scrollY;
      if(x>=this.gutter&&x<right)s.rect(Math.round(x),y+2,1.5,lh-4,p.caret);
    }
    if(this.minimapWidth)this.renderMinimap(w,h,first,last);
    s.end();
    this.spacer.style.width=`${Math.max(w,this.maxWidth+this.gutter+this.minimapWidth+40)}px`;
    const cursorX=clamp(textX+this.visualColumn(pos.line,pos.column)*cw,this.gutter,w-40),cursorY=clamp(this.padding+pos.line*lh-scrollY,0,h-lh);
    this.input.style.left=`${cursorX}px`;this.input.style.top=`${cursorY}px`;this.input.style.fontSize=`${this.options.fontSize}px`;
    if(performance.now()-(this.lastStats||0)>700){this.lastStats=performance.now();this.dispatchEvent(new CustomEvent('stats',{detail:{...s.stats,visibleLines:last-first+1}}));}
  }
  renderMinimap(w,h,first,last){
    const s=this.surface,p=s.palette,width=this.minimapWidth,x=w-width-10,b=this.document.buffer;
    s.rect(x,0,width,h,p.bg);s.rect(x,0,1,h,p.guide);
    const step=Math.max(1,Math.ceil(b.lineCount/180)),rh=Math.min(3,(h-18)/Math.ceil(b.lineCount/step));
    if(!this.minimapData){
      this.minimapData=[];
      for(let line=0;line<b.lineCount;line+=step){const text=b.getLine(line);const tokens=tokenizeLine(text,this.document.language).tokens;this.minimapData.push({line,tokens,text});}
    }
    s.rect(x+1,8+first/step*rh,width-1,Math.max(8,(last-first+1)/step*rh),p.miniview);
    for(const row of this.minimapData){const y=8+row.line/step*rh;for(const token of row.tokens){if(!row.text.slice(token.start,token.end).trim())continue;const a=token.start*.72,v=Math.min((token.end-token.start)*.72,width-a-8);if(v>0)s.rect(x+5+a,y,v,Math.max(.7,rh*.48),p.tokens[token.kind]+'75');}}
  }
  focus(){(this.accessibleMode?this.accessible:this.input).focus({preventScroll:true});}
  offsetFromPoint(clientX,clientY){
    if(!this.document)return 0;const r=this.host.getBoundingClientRect();
    const line=clamp(Math.floor((clientY-r.top+this.scroller.scrollTop-this.padding)/this.lineHeight),0,this.document.buffer.lineCount-1);
    const col=Math.max(0,(clientX-r.left-this.gutter+this.scroller.scrollLeft)/this.charWidth);
    return this.document.buffer.offsetAt(line,this.utfColumn(line,col));
  }
  pointerDown(e){
    if(!this.document||e.button!==0)return;
    const r=this.host.getBoundingClientRect(),x=e.clientX-r.left;
    if(x>this.host.clientWidth-13||e.clientY-r.top>this.host.clientHeight-13)return;
    e.preventDefault();this.focus();this.hideSuggestions();
    if(this.minimapWidth&&x>this.host.clientWidth-this.minimapWidth-10){this.scroller.scrollTop=Math.max(0,(e.clientY-r.top)/this.host.clientHeight*this.document.buffer.lineCount*this.lineHeight-this.host.clientHeight/2);return;}
    const offset=this.offsetFromPoint(e.clientX,e.clientY);
    if(x<22){const line=this.document.buffer.positionAt(offset).line;this.dispatchEvent(new CustomEvent('breakpoint',{detail:{document:this.document,line}}));return;}
    if(e.detail>=3){const line=this.document.buffer.positionAt(offset).line;this.document.setSelection(this.document.buffer.lineStart(line),line+1<this.document.buffer.lineCount?this.document.buffer.lineStart(line+1):this.document.buffer.length);return;}
    const anchor=e.shiftKey?this.document.selection.anchor:offset;
    this.document.setSelection(anchor,offset);this.dragging=true;this.dragAnchor=anchor;
    this.scroller.setPointerCapture(e.pointerId);
  }
  pointerMove(e){
    if(!this.dragging||!this.document)return;
    const r=this.host.getBoundingClientRect();
    if(e.clientY<r.top+15)this.scroller.scrollTop-=this.lineHeight;
    if(e.clientY>r.bottom-15)this.scroller.scrollTop+=this.lineHeight;
    this.document.setSelection(this.dragAnchor,this.offsetFromPoint(e.clientX,e.clientY));
  }
  selectWord(offset=this.document?.selection.head){
    if(!this.document)return;const b=this.document.buffer,p=b.positionAt(offset),line=b.getLine(p.line);let a=p.column,z=p.column;
    while(a>0&&/[\w$]/.test(line[a-1]))a--;while(z<line.length&&/[\w$]/.test(line[z]))z++;
    this.document.setSelection(b.offsetAt(p.line,a),b.offsetAt(p.line,z));
  }
  ensureVisible(){
    if(!this.document)return;const pos=this.document.buffer.positionAt(this.document.selection.head),y=this.padding+pos.line*this.lineHeight,x=this.gutter+this.visualColumn(pos.line,pos.column)*this.charWidth;
    const h=this.host.clientHeight,w=this.host.clientWidth-this.minimapWidth-20;
    if(y<this.scroller.scrollTop+this.padding)this.scroller.scrollTop=Math.max(0,y-this.padding);
    if(y+this.lineHeight>this.scroller.scrollTop+h-20)this.scroller.scrollTop=y+this.lineHeight-h+20;
    if(x<this.scroller.scrollLeft+this.gutter)this.scroller.scrollLeft=Math.max(0,x-this.gutter-20);
    if(x>this.scroller.scrollLeft+w)this.scroller.scrollLeft=x-w+30;
  }
  goto(line,column=0){if(!this.document)return;const offset=this.document.buffer.offsetAt(line,column);this.document.setSelection(offset);this.ensureVisible();this.focus();}
  insert(text,kind='typing'){
    if(!this.document)return;const {anchor,head}=this.document.selection,a=Math.min(anchor,head),b=Math.max(anchor,head);
    this.document.edit(a,b,text,{kind});this.ensureVisible();
  }
  beforeInput(e){
    if(this.composing||e.isComposing)return;
    if(this.ignoreCompositionInput){e.preventDefault();return;}
    if(!this.document)return;
    e.preventDefault();
    if(e.inputType==='insertText'&&e.data){
      const doc=this.document,{anchor,head}=doc.selection,a=Math.min(anchor,head),z=Math.max(anchor,head),next=doc.buffer.slice(z,z+1);
      if(e.data.length===1&&pairs[e.data]&&(!next||/[\s\])};,]/.test(next)||a!==z)){
        const selected=doc.buffer.slice(a,z),text=e.data+selected+pairs[e.data];
        doc.edit(a,z,text,{selection:{anchor:a+1,head:a+1+selected.length}});
      }else if(e.data.length===1&&')]}\'"`'.includes(e.data)&&a===z&&next===e.data)doc.setSelection(head+1);
      else this.insert(e.data);
      if(e.data==='.')this.showSuggestions();else this.hideSuggestions();
    }else if(['insertLineBreak','insertParagraph'].includes(e.inputType))this.newline();
    else if(e.inputType==='deleteContentBackward')this.delete(-1);
    else if(e.inputType==='deleteContentForward')this.delete(1);
    else if(e.inputType==='historyUndo')this.document.undo();
    else if(e.inputType==='historyRedo')this.document.redo();
  }
  adjacent(offset,direction,word=false){
    const b=this.document.buffer,p=b.positionAt(offset),line=this.layout(p.line);
    if(word){const source=direction<0?b.slice(Math.max(0,offset-1000),offset):b.slice(offset,Math.min(b.length,offset+1000));const m=direction<0?source.match(/(?:\s+|[\w$]+|[^\w\s])$/):source.match(/^(?:\s+|[\w$]+|[^\w\s])/);return clamp(offset+direction*(m?.[0].length||1),0,b.length);}
    if(direction<0){if(!p.column)return Math.max(0,offset-1);const prev=line.items.findLast(x=>x.start<p.column);return b.lineStart(p.line)+(prev?.start||0);}
    if(p.column>=line.text.length)return Math.min(b.length,offset+1);
    return b.lineStart(p.line)+(line.items.find(x=>x.end>p.column)?.end??line.text.length);
  }
  delete(direction,word=false){
    const d=this.document;if(!d)return;let a=Math.min(d.selection.anchor,d.selection.head),z=Math.max(d.selection.anchor,d.selection.head);
    if(a===z){
      if(direction<0){const prev=d.buffer.slice(a-1,a),next=d.buffer.slice(a,a+1);if(pairs[prev]===next&&!word){a--;z++;}else a=this.adjacent(a,-1,word);}
      else z=this.adjacent(z,1,word);
    }d.edit(a,z,'');this.hideSuggestions();this.ensureVisible();
  }
  newline(){
    const d=this.document,b=d.buffer,p=b.positionAt(Math.min(d.selection.anchor,d.selection.head)),line=b.getLine(p.line);
    const indent=line.match(/^\s*/)?.[0]||'',before=line.slice(0,p.column),after=line.slice(p.column);
    const extra=/[{[(]\s*$/.test(before)?' '.repeat(this.options.tabSize):'';
    if(extra&&/^\s*[}\])]/.test(after)){
      const a=Math.min(d.selection.anchor,d.selection.head);d.edit(a,Math.max(d.selection.anchor,d.selection.head),'\n'+indent+extra+'\n'+indent,{selection:{anchor:a+1+indent.length+extra.length,head:a+1+indent.length+extra.length}});
    }else this.insert('\n'+indent+extra,'newline');this.hideSuggestions();
  }
  indent(out=false){
    const d=this.document,b=d.buffer,a=Math.min(d.selection.anchor,d.selection.head),z=Math.max(d.selection.anchor,d.selection.head),start=b.positionAt(a),end=b.positionAt(z);
    if(a===z&&!out){const col=this.visualColumn(start.line,start.column);this.insert(' '.repeat(this.options.tabSize-col%this.options.tabSize),'indent');return;}
    const last=end.column===0&&end.line>start.line?end.line-1:end.line,from=b.lineStart(start.line),to=b.newlineAt(last),text=b.slice(from,to),rows=text.split('\n');
    const changed=rows.map(row=>out?row.replace(new RegExp(`^( {1,${this.options.tabSize}}|\\t)`),''):' '.repeat(this.options.tabSize)+row).join('\n');
    d.edit(from,to,changed,{selection:{anchor:from,head:from+changed.length}});
  }
  toggleComment(){
    const d=this.document;if(!d)return;const b=d.buffer,a=b.positionAt(Math.min(d.selection.anchor,d.selection.head)),z=b.positionAt(Math.max(d.selection.anchor,d.selection.head));
    const last=z.column===0&&z.line>a.line?z.line-1:z.line,from=b.lineStart(a.line),to=b.newlineAt(last),rows=b.slice(from,to).split('\n');
    let text;
    if(['html','xml'].includes(d.language)){const source=rows.join('\n');text=source.startsWith('<!-- ')&&source.endsWith(' -->')?source.slice(5,-4):'<!-- '+source+' -->';}
    else if(d.language==='css'){const source=rows.join('\n');text=source.startsWith('/* ')&&source.endsWith(' */')?source.slice(3,-3):'/* '+source+' */';}
    else {const remove=rows.filter(r=>r.trim()).every(r=>/^\s*\/\//.test(r));text=rows.map(row=>remove?row.replace(/^(\s*)\/\/ ?/,'$1'):row.replace(/^(\s*)/,'$1// ')).join('\n');}
    d.edit(from,to,text,{selection:{anchor:from,head:from+text.length}});
  }
  moveLines(direction){
    const d=this.document,b=d.buffer,a=b.positionAt(Math.min(d.selection.anchor,d.selection.head)).line,z=b.positionAt(Math.max(d.selection.anchor,d.selection.head)).line;
    if(direction<0&&a===0||direction>0&&z===b.lineCount-1)return;
    const first=direction<0?a-1:a,last=direction<0?z:z+1,from=b.lineStart(first),to=b.newlineAt(last),rows=b.slice(from,to).split('\n');
    if(direction<0)rows.push(rows.shift());else rows.unshift(rows.pop());
    const block=rows.join('\n'),newStart=direction<0?from:from+rows[0].length+1;
    d.edit(from,to,block,{selection:{anchor:newStart,head:newStart+(direction<0?rows.slice(0,-1):rows.slice(1)).join('\n').length}});
  }
  duplicateLine(){
    const d=this.document,b=d.buffer,p=b.positionAt(d.selection.head),start=b.lineStart(p.line),text=b.getLine(p.line);
    d.edit(start,start,text+'\n',{selection:{anchor:d.selection.head+text.length+1,head:d.selection.head+text.length+1}});
  }
  keyDown(e){
    if(!this.document||this.composing)return;const d=this.document,b=d.buffer,mod=e.ctrlKey||e.metaKey;
    if(!this.suggest.classList.contains('hidden')){
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();this.suggestionIndex=(this.suggestionIndex+(e.key==='ArrowDown'?1:-1)+this.suggestionItems.length)%this.suggestionItems.length;this.paintSuggestions();return;}
      if(e.key==='Tab'||e.key==='Enter'){e.preventDefault();this.acceptSuggestion();return;}
      if(e.key==='Escape'){e.preventDefault();this.hideSuggestions();return;}
    }
    if(mod&&e.key.toLowerCase()==='a'){e.preventDefault();d.setSelection(0,b.length);return;}
    if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?d.redo():d.undo();this.ensureVisible();return;}
    if(mod&&e.key.toLowerCase()==='y'){e.preventDefault();d.redo();this.ensureVisible();return;}
    if(mod&&e.code==='Space'){e.preventDefault();this.showSuggestions();return;}
    if(mod&&e.key==='/'){e.preventDefault();this.toggleComment();return;}
    if(mod&&e.key.toLowerCase()==='d'){e.preventDefault();this.duplicateLine();return;}
    if(e.altKey&&(e.key==='ArrowUp'||e.key==='ArrowDown')){e.preventDefault();this.moveLines(e.key==='ArrowUp'?-1:1);return;}
    if(e.key==='Tab'){e.preventDefault();this.indent(e.shiftKey);return;}
    if(e.key==='Enter'){e.preventDefault();this.newline();return;}
    if(e.key==='Backspace'||e.key==='Delete'){e.preventDefault();this.delete(e.key==='Backspace'?-1:1,mod||e.altKey);return;}
    if(e.key==='Escape'){this.hideSuggestions();return;}
    const p=b.positionAt(d.selection.head);let target;
    switch(e.key){
      case 'ArrowLeft':target=!e.shiftKey&&d.selection.head!==d.selection.anchor?Math.min(d.selection.head,d.selection.anchor):this.adjacent(d.selection.head,-1,mod||e.altKey);break;
      case 'ArrowRight':target=!e.shiftKey&&d.selection.head!==d.selection.anchor?Math.max(d.selection.head,d.selection.anchor):this.adjacent(d.selection.head,1,mod||e.altKey);break;
      case 'ArrowUp':case 'ArrowDown':case 'PageUp':case 'PageDown':{
        this.goalColumn??=this.visualColumn(p.line,p.column);const step=e.key.startsWith('Page')?Math.max(1,Math.floor(this.host.clientHeight/this.lineHeight)-2):1;
        const line=clamp(p.line+(['ArrowUp','PageUp'].includes(e.key)?-step:step),0,b.lineCount-1);target=b.offsetAt(line,this.utfColumn(line,this.goalColumn));break;}
      case 'Home':{const indent=b.getLine(p.line).match(/^\s*/)?.[0].length||0;target=mod?0:b.offsetAt(p.line,p.column===indent?0:indent);break;}
      case 'End':target=mod?b.length:b.newlineAt(p.line);break;
      default:return;
    }
    e.preventDefault();if(!['ArrowUp','ArrowDown','PageUp','PageDown'].includes(e.key))this.goalColumn=undefined;
    d.setSelection(e.shiftKey?d.selection.anchor:target,target);this.ensureVisible();this.hideSuggestions();
  }
  clipboard(e){
    if(!this.document)return;const d=this.document,a=Math.min(d.selection.anchor,d.selection.head),z=Math.max(d.selection.anchor,d.selection.head);
    if(e.type==='paste'){e.preventDefault();this.insert(e.clipboardData.getData('text/plain'),'paste');this.hideSuggestions();return;}
    if(a===z)return;e.preventDefault();e.clipboardData.setData('text/plain',d.buffer.slice(a,z));if(e.type==='cut')d.edit(a,z,'');
  }
  showSuggestions(){
    if(!this.document)return;const result=completions(this.document,this.document.selection.head);
    if(!result.items.length)return;this.suggestionPrefix=result.prefix;this.suggestionItems=result.items;this.suggestionIndex=0;
    const p=this.document.buffer.positionAt(this.document.selection.head),x=this.gutter+this.visualColumn(p.line,p.column)*this.charWidth-this.scroller.scrollLeft,y=this.padding+(p.line+1)*this.lineHeight-this.scroller.scrollTop;
    this.suggest.style.left=`${clamp(x,this.gutter,Math.max(this.gutter,this.host.clientWidth-290))}px`;
    this.suggest.style.top=`${clamp(y,0,Math.max(0,this.host.clientHeight-240))}px`;
    this.suggest.classList.remove('hidden');this.paintSuggestions();
  }
  paintSuggestions(){
    this.suggest.replaceChildren();
    this.suggestionItems.forEach((word,i)=>{const row=document.createElement('button');row.className='suggestion'+(i===this.suggestionIndex?' selected':'');row.setAttribute('role','option');row.setAttribute('aria-selected',i===this.suggestionIndex);const type=document.createElement('span');type.className='symbol-icon';type.textContent='◇';row.append(type,document.createTextNode(word));row.addEventListener('pointerdown',e=>{e.preventDefault();this.suggestionIndex=i;this.acceptSuggestion();});this.suggest.append(row);});
    this.suggest.children[this.suggestionIndex]?.scrollIntoView({block:'nearest'});
  }
  acceptSuggestion(){const d=this.document,head=d.selection.head;d.edit(head-this.suggestionPrefix.length,head,this.suggestionItems[this.suggestionIndex]);this.hideSuggestions();this.focus();}
  hideSuggestions(){this.suggest.classList.add('hidden');}
  setOptions(options){Object.assign(this.options,options);this.layouts.clear();this.minimapData=null;this.surface.setOptions(this.options);this.updateDimensions();this.invalidate();}
  setAccessible(enabled){this.accessibleMode=enabled;this.accessible.classList.toggle('hidden',!enabled);this.scroller.classList.toggle('hidden',enabled);if(enabled&&this.document){this.accessible.value=this.document.text;this.accessible.setSelectionRange(this.document.selection.anchor,this.document.selection.head);}this.focus();}
  dispose(){clearInterval(this.caretTimer);this.resizeObserver.disconnect();this.docEvents?.abort();this.surface.dispose();}
}
