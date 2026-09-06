/**
 * Shared retained-glyph / immediate-quad renderer. The editor submits one
 * interleaved instance stream; text is not painted by an HTML code overlay.
 * Canvas 2D consumes the same draw list when WebGPU cannot initialize.
 */
export const PALETTES = {
  dark: { bg:'#1c1e26', gutter:'#1c1e26', text:'#d5d9e4', muted:'#626879', line:'#242733', selection:'#41426c', guide:'#303442', caret:'#ececfd', match:'#665834', error:'#f17e88', breakpoint:'#ec6c81', miniview:'#a1a9c51a', tokens:['#d5d9e4','#c398f3','#d9b58c','#798796','#b3c992','#68c7cc','#e1d59a','#9dcced','#929bb0','#84b6ed'] },
  light: { bg:'#ffffff', gutter:'#ffffff', text:'#30364b', muted:'#9da3b1', line:'#f5f4fb', selection:'#ddd6f5', guide:'#e7e9ef', caret:'#343248', match:'#fff0b3', error:'#c7374e', breakpoint:'#d64566', miniview:'#55558016', tokens:['#30364b','#7e3fad','#a05437','#76917c','#497b35','#237f88','#835b21','#2056a0','#7c8190','#2370a5'] },
};
const colorCache = new Map();
function rgba(hex) {
  if (colorCache.has(hex)) return colorCache.get(hex);
  const v = hex.replace('#','');
  const c = [parseInt(v.slice(0,2),16)/255,parseInt(v.slice(2,4),16)/255,parseInt(v.slice(4,6),16)/255,v.length===8?parseInt(v.slice(6,8),16)/255:1];
  colorCache.set(hex,c); return c;
}
export class GlyphAtlas {
  constructor(fontSize=14,dpr=1) {
    this.canvas = document.createElement('canvas'); this.canvas.width = this.canvas.height = 2048;
    this.context = this.canvas.getContext('2d',{alpha:true});
    this.fontSize = fontSize; this.dpr=dpr; this.lineHeight=Math.round(fontSize*1.7);
    this.context.font=`${fontSize*dpr}px "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace`;
    this.context.textBaseline='alphabetic'; this.context.fillStyle='#fff';
    this.charWidth = this.context.measureText('M').width/dpr;
    this.map=new Map(); this.x=2; this.y=2; this.rowHeight=Math.ceil(this.lineHeight*dpr)+4;
    this.dirty=false; this.full=false;
    for (let i=32;i<127;i++) this.get(String.fromCharCode(i));
  }
  get(text) {
    if(this.map.has(text)) return this.map.get(text);
    const wide = [...text].some(c => c.codePointAt(0)>0x2e80) ? 2 : 1;
    const width=Math.ceil(this.charWidth*this.dpr*wide)+4, height=this.rowHeight;
    if(this.x+width>2048) {this.x=2;this.y+=height;}
    if(this.y+height>2048) {this.full=true;return this.map.get('?');}
    this.context.fillText(text,this.x+2,this.y+2+(this.lineHeight-this.fontSize)*this.dpr/2+this.fontSize*this.dpr*0.80);
    const glyph={ u:this.x/2048,v:this.y/2048,uw:width/2048,vh:height/2048,width:width/this.dpr,height:height/this.dpr,columns:wide };
    this.map.set(text,glyph);this.x+=width;this.dirty=true;return glyph;
  }
}
const shader = /* wgsl */`
struct View { size: vec2f, _padding: vec2f };
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f };
@vertex fn vertex_main(@builtin(vertex_index) vertex: u32,
  @location(0) rect: vec4f, @location(1) uvRect: vec4f, @location(2) color: vec4f) -> VertexOut {
  let corners = array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  let corner=corners[vertex]; let point=rect.xy+corner*rect.zw;
  var out: VertexOut;
  out.position=vec4f(point/view.size*vec2f(2,-2)+vec2f(-1,1),0,1);
  out.uv=uvRect.xy+corner*uvRect.zw;out.color=color;return out;
}
@fragment fn fragment_main(input: VertexOut) -> @location(0) vec4f {
  if(input.uv.x<0) {return input.color;}
  let coverage=textureSampleLevel(atlas,atlasSampler,input.uv,0).a;
  return vec4f(input.color.rgb,input.color.a*coverage);
}`;
export class Surface extends EventTarget {
  constructor(canvas, {fontSize=14,theme='dark',forceCanvas=false}={}) {
    super(); this.canvas=canvas;this.fontSize=fontSize;this.theme=theme;this.palette=PALETTES[theme];
    this.dpr=Math.min(devicePixelRatio||1,2);this.atlas=new GlyphAtlas(fontSize,this.dpr);
    this.data=new Float32Array(12*8192);this.count=0;this.capacity=0;
    this.mode='Initializing';this.forceCanvas=forceCanvas;this.width=1;this.height=1;
    this.stats={instances:0,glyphs:0,cpuMs:0,drawCalls:0};
  }
  async init() {
    try {
      if(this.forceCanvas || !navigator.gpu) throw new Error(this.forceCanvas?'Canvas mode requested':'WebGPU is unavailable in this browser');
      const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
      if(!adapter) throw new Error('No WebGPU adapter was returned');
      this.device=await adapter.requestDevice();
      this.device.addEventListener('uncapturederror',e=>this.dispatchEvent(new CustomEvent('error',{detail:e.error.message})));
      this.context=this.canvas.getContext('webgpu');
      if(!this.context) throw new Error('Cannot create a WebGPU canvas context');
      this.format=navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({device:this.device,format:this.format,alphaMode:'opaque'});
      const module=this.device.createShaderModule({label:'Forge glyph + primitive shader',code:shader});
      const compilation=await module.getCompilationInfo();
      const errors=compilation.messages.filter(m=>m.type==='error');
      if(errors.length) throw new Error(errors.map(e=>e.message).join('\n'));
      this.pipeline=await this.device.createRenderPipelineAsync({
        label:'Forge instanced text',layout:'auto',
        vertex:{module,entryPoint:'vertex_main',buffers:[{arrayStride:48,stepMode:'instance',attributes:[
          {shaderLocation:0,format:'float32x4',offset:0},{shaderLocation:1,format:'float32x4',offset:16},{shaderLocation:2,format:'float32x4',offset:32}]}]},
        fragment:{module,entryPoint:'fragment_main',targets:[{format:this.format,blend:{
          color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},
        primitive:{topology:'triangle-list'}
      });
      this.uniform=this.device.createBuffer({label:'Viewport',size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      this.texture=this.device.createTexture({label:'Glyph atlas',size:[2048,2048],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
      const sampler=this.device.createSampler({magFilter:'linear',minFilter:'linear'});
      this.bindGroup=this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:this.texture.createView()},{binding:2,resource:sampler}]});
      this.atlas.dirty=true;this.mode='WebGPU';
      this.adapterInfo=adapter.info?.description||adapter.info?.architecture||'GPU adapter';
      this.device.lost.then(info=>{if(!this.disposed)this.fallback(`WebGPU device lost: ${info.message||info.reason}`);});
    } catch(e) {this.fallback(e.message);}
    this.dispatchEvent(new Event('ready'));return this;
  }
  fallback(reason) {
    if(this.mode==='Canvas 2D') return;
    // A canvas cannot switch context types. Replace it rather than asking for 2D
    // on an element which already owns a WebGPU context.
    if(this.context) { const replacement=document.createElement('canvas'); replacement.className=this.canvas.className;this.canvas.replaceWith(replacement);this.canvas=replacement; }
    this.context=null;this.ctx=this.canvas.getContext('2d',{alpha:false});this.mode='Canvas 2D';this.reason=reason;
    this.resize(this.width,this.height);this.dispatchEvent(new Event('ready'));
  }
  resize(width,height) {
    this.width=Math.max(1,width);this.height=Math.max(1,height);
    const dpr=Math.min(devicePixelRatio||1,2);
    if(this.dpr!==dpr) {this.dpr=dpr;this.atlas=new GlyphAtlas(this.fontSize,dpr);}
    const w=Math.max(1,Math.round(width*this.dpr)),h=Math.max(1,Math.round(height*this.dpr));
    if(this.canvas.width!==w)this.canvas.width=w;if(this.canvas.height!==h)this.canvas.height=h;
    this.canvas.style.width=`${width}px`;this.canvas.style.height=`${height}px`;
  }
  setOptions({fontSize=this.fontSize,theme=this.theme}) {
    this.theme=theme;this.palette=PALETTES[theme]||PALETTES.dark;
    if(fontSize!==this.fontSize) {this.fontSize=fontSize;this.atlas=new GlyphAtlas(fontSize,this.dpr);}
  }
  begin() {this.count=0;this.glyphs=0;this.started=performance.now();}
  quad(x,y,w,h,uv,color) {
    if(w<=0||h<=0||x+w<0||y+h<0||x>this.width||y>this.height) return;
    const at=this.count*12;
    if(at+12>this.data.length){const grown=new Float32Array(this.data.length*2);grown.set(this.data);this.data=grown;}
    this.data.set([x,y,w,h,...uv,...rgba(color)],at);this.count++;
  }
  rect(x,y,w,h,color) {this.quad(x,y,w,h,[-1,-1,0,0],color);}
  glyph(text,x,y,color) {
    if(text===' '||text==='\t')return;
    const g=this.atlas.get(text);if(!g)return;
    this.quad(x-2/this.dpr,y-2/this.dpr,g.width,g.height,[g.u,g.v,g.uw,g.vh],color);this.glyphs++;
  }
  text(text,x,y,color) {for(const c of text){this.glyph(c,x,y,color);x+=this.atlas.charWidth*(c.codePointAt(0)>0x2e80?2:1);}}
  end() {
    if(this.mode==='Initializing') return;
    const bg=rgba(this.palette.bg);
    if(this.mode==='WebGPU') {
      try {
        const gpu=this.device;
        if(this.atlas.dirty) {gpu.queue.copyExternalImageToTexture({source:this.atlas.canvas},{texture:this.texture},[2048,2048]);this.atlas.dirty=false;}
        const bytes=this.count*48;
        if(bytes>this.capacity||!this.buffer){this.buffer?.destroy();this.capacity=Math.max(4096,2**Math.ceil(Math.log2(Math.max(bytes,1))));this.buffer=gpu.createBuffer({label:'Editor instances',size:this.capacity,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});}
        gpu.queue.writeBuffer(this.uniform,0,new Float32Array([this.width,this.height,0,0]));
        if(bytes)gpu.queue.writeBuffer(this.buffer,0,this.data.buffer,0,bytes);
        const encoder=gpu.createCommandEncoder({label:'Editor frame'});
        const pass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),clearValue:{r:bg[0],g:bg[1],b:bg[2],a:1},loadOp:'clear',storeOp:'store'}]});
        pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.bindGroup);pass.setVertexBuffer(0,this.buffer);pass.draw(6,this.count);pass.end();
        gpu.queue.submit([encoder.finish()]);
      }catch(e){this.fallback(e.message);return this.end();}
    }else{
      const c=this.ctx;c.setTransform(this.dpr,0,0,this.dpr,0,0);c.fillStyle=this.palette.bg;c.fillRect(0,0,this.width,this.height);
      for(let i=0;i<this.count;i++) {
        const p=i*12,d=this.data,[x,y,w,h]=d.subarray(p,p+4);
        const r=Math.round(d[p+8]*255),g=Math.round(d[p+9]*255),b=Math.round(d[p+10]*255),a=d[p+11];
        if(d[p+4]<0){c.fillStyle=`rgba(${r},${g},${b},${a})`;c.fillRect(x,y,w,h);}
        else {
          // Colorized atlas entries are cached per glyph and token color.
          this.tintCache??=new Map();const key=`${d[p+4]}:${d[p+5]}:${r},${g},${b}:${this.fontSize}:${this.dpr}`;
          let tile=this.tintCache.get(key);
          if(!tile){tile=document.createElement('canvas');tile.width=Math.round(d[p+6]*2048);tile.height=Math.round(d[p+7]*2048);const t=tile.getContext('2d');t.drawImage(this.atlas.canvas,d[p+4]*2048,d[p+5]*2048,tile.width,tile.height,0,0,tile.width,tile.height);t.globalCompositeOperation='source-in';t.fillStyle=`rgb(${r},${g},${b})`;t.fillRect(0,0,tile.width,tile.height);this.tintCache.set(key,tile);if(this.tintCache.size>4096)this.tintCache.clear();}
          c.globalAlpha=a;c.drawImage(tile,x,y,w,h);c.globalAlpha=1;
        }
      }
    }
    this.stats={instances:this.count,glyphs:this.glyphs,cpuMs:performance.now()-this.started,drawCalls:this.mode==='WebGPU'?1:this.count};
  }
  dispose(){this.disposed=true;this.buffer?.destroy();this.texture?.destroy();this.uniform?.destroy();this.device?.destroy();}
}
