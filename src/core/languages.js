export const TOKEN = Object.freeze({ text: 0, keyword: 1, string: 2, comment: 3, number: 4, type: 5, function: 6, property: 7, punctuation: 8, tag: 9 });
export const LANGUAGE_LABEL = { javascript:'JavaScript', typescript:'TypeScript', csharp:'C#', xml:'XAML / XML', html:'HTML', css:'CSS', json:'JSON', markdown:'Markdown', wgsl:'WGSL', yaml:'YAML', plaintext:'Plain text' };
const keywords = new Set(('abstract as async await base bool break byte case catch char checked class const continue debugger decimal default delegate delete do double dynamic else enum event explicit export extends extern false finally fixed float for foreach from function get global goto if implements implicit import in instanceof int interface internal is let lock long namespace native new null object of operator out override params partial private protected public readonly record ref required return sbyte scoped sealed set short sizeof stackalloc static string struct super switch symbol this throw true try typeof uint ulong unchecked undefined unsafe ushort using var virtual void volatile while with yield fn pub mut impl override enable requires alias diagnostic discard continuing loop ptr vec2 vec3 vec4 mat4x4 f32 i32 u32').split(' '));
const types = new Set(('Array ArrayBuffer BigInt Boolean CanvasRenderingContext2D Date Error Event Float32Array GPUAdapter GPUBuffer GPUCanvasContext GPUDevice GPUTexture HTMLElement Int32Array Map Math Number Object Promise RegExp Set String Symbol Uint8Array Vector2 Vector3 Vector4 Matrix4x4 Task CancellationToken List Dictionary IEnumerable IDisposable Console Guid Random Span ReadOnlySpan').split(' '));

/** Stateful, allocation-bounded line lexer. Semantic analysis is independent. */
export function tokenizeLine(text, language = 'javascript', state = '') {
  const tokens = [];
  let i = 0;
  const emit = (a,b,kind) => { if (b > a) tokens.push({ start:a, end:b, kind }); };
  if (language === 'plaintext') return { tokens: [{ start:0, end:text.length, kind:0 }], state:'' };
  if (language === 'markdown') {
    const kind = /^\s*#/.test(text) ? TOKEN.type : /^\s*(```|>)/.test(text) ? TOKEN.comment : TOKEN.text;
    return { tokens:[{ start:0, end:text.length, kind }], state:'' };
  }
  while (i < text.length) {
    const start = i, ch = text[i], next = text[i + 1];
    if (state === 'comment') {
      const end = text.indexOf('*/', i); i = end < 0 ? text.length : end + 2;
      emit(start,i,TOKEN.comment); if (end >= 0) state = ''; continue;
    }
    if (state === 'xmlcomment') {
      const end = text.indexOf('-->', i); i = end < 0 ? text.length : end + 3;
      emit(start,i,TOKEN.comment); if (end >= 0) state = ''; continue;
    }
    if (state === '`') {
      while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i++] === '`') { state = ''; break; } }
      emit(start,Math.min(i,text.length),TOKEN.string); continue;
    }
    if (/\s/.test(ch)) { while (i < text.length && /\s/.test(text[i])) i++; emit(start,i,0); continue; }
    if (ch === '/' && next === '/' || language === 'yaml' && ch === '#') { emit(i,text.length,TOKEN.comment); break; }
    if (ch === '/' && next === '*') { i += 2; state = 'comment'; const end = text.indexOf('*/', i); i = end < 0 ? text.length : end + 2; emit(start,i,TOKEN.comment); if (end >= 0) state = ''; continue; }
    if (text.startsWith('<!--',i)) { i += 4; state = 'xmlcomment'; const end = text.indexOf('-->',i); i = end < 0 ? text.length : end+3; emit(start,i,TOKEN.comment); if (end >= 0) state=''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch; i++;
      let closed = false;
      while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i++] === quote) { closed = true; break; } }
      if (!closed && quote === '`') state = '`';
      emit(start,Math.min(i,text.length),TOKEN.string); continue;
    }
    if (/\d/.test(ch)) { i++; while (i < text.length && /[\w.x]/.test(text[i])) i++; emit(start,i,TOKEN.number); continue; }
    if (/[\p{L}_$]/u.test(ch)) {
      i++; while (i < text.length && /[\p{L}\p{N}_$-]/u.test(text[i]) && (text[i] !== '-' || ['html','xml','css'].includes(language))) i++;
      const word = text.slice(start,i), rest = text.slice(i);
      let kind = keywords.has(word) ? TOKEN.keyword : types.has(word) || /^[A-Z]/.test(word) ? TOKEN.type : /^\s*\(/.test(rest) ? TOKEN.function : 0;
      if (['html','xml'].includes(language)) kind = /<\/?\s*$/.test(text.slice(0,start)) ? TOKEN.tag : /^\s*=/.test(rest) ? TOKEN.property : kind;
      if (language === 'css') kind = /^\s*:/.test(rest) ? TOKEN.property : kind;
      emit(start,i,kind); continue;
    }
    i++; emit(start,i,TOKEN.punctuation);
  }
  return { tokens, state };
}
export class TokenCache {
  constructor(document) { this.document = document; this.cache = []; }
  invalidate(line = 0) { this.cache.length = Math.min(this.cache.length,line); }
  line(index) {
    for (let i = this.cache.length; i <= index; i++) {
      const previous = this.cache[i-1]?.state || '';
      this.cache.push(tokenizeLine(this.document.buffer.getLine(i),this.document.language,previous));
    }
    return this.cache[index]?.tokens || [];
  }
}
export function completions(document, offset) {
  const before = document.buffer.slice(Math.max(0,offset - 100),offset);
  const prefix = before.match(/[\w$]+$/)?.[0] || '';
  const member = before.match(/([\w$]+)\.([\w$]*)$/);
  const members = {
    console:['log','warn','error','info','table','time','timeEnd','clear'],
    Math:['abs','ceil','cos','floor','max','min','PI','pow','random','round','sin','sqrt'],
    document:['querySelector','querySelectorAll','createElement','getElementById','body','addEventListener'],
    navigator:['gpu','clipboard','hardwareConcurrency'],
    device:['createBuffer','createTexture','createShaderModule','createRenderPipeline','createComputePipeline','createBindGroup','createCommandEncoder','queue','lost'],
    Console:['WriteLine','ReadLine','Write','Clear'],
  };
  const words = member && members[member[1]] ? members[member[1]] : [...keywords,...types,...(document.text.match(/[A-Za-z_$][\w$]{2,}/g) || [])];
  return { prefix, items:[...new Set(words)].filter(w => w.toLowerCase().startsWith(prefix.toLowerCase()) && w !== prefix).slice(0,60) };
}
export function basicSymbols(text, language) {
  const result = [], rows = text.split('\n');
  const re = language === 'csharp' ? /\b(class|struct|interface|enum|record|namespace)\s+(\w+)|\b(?:public|private|protected|internal)\s+(?:static\s+|async\s+|virtual\s+|override\s+)*[\w<>?,\[\]]+\s+(\w+)\s*\(/ : /\b(class|function|const|let|var|interface|type)\s+(\w+)|\b([\w$]+)\s*\([^)]*\)\s*\{/;
  rows.forEach((row,line) => { const m = re.exec(row); if (m) result.push({ name:m[2] || m[3], kind:m[1] || 'method', line, column:m.index }); });
  return result.slice(0,200);
}
