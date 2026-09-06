/**
 * A UTF-16 indexed piece treap. Internal nodes carry character and newline
 * measures, making edits and line/offset lookup logarithmic in piece count.
 * Original and inserted buffers are immutable; no full-document copying on edit.
 */
const size = n => n?.length ?? 0;
const lines = n => n?.newlines ?? 0;
const lowerBound = (a, x) => {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
};
let randomState = 0x7a419e13;
function priority() {
  randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
  return randomState >>> 0;
}
function update(n) {
  if (n) { n.length = size(n.left) + n.count + size(n.right); n.newlines = lines(n.left) + n.breaks + lines(n.right); }
  return n;
}
function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.priority < b.priority) { a.right = merge(a.right, b); return update(a); }
  b.left = merge(a, b.left); return update(b);
}

export class PieceTable {
  constructor(text = '') {
    this.buffers = [];
    this.version = 0;
    this.root = text.length ? this.node(this.addBuffer(text), 0, text.length) : null;
  }
  addBuffer(text) {
    const breaks = [];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) breaks.push(i);
    this.buffers.push({ text, breaks });
    return this.buffers.length - 1;
  }
  node(buffer, start, count) {
    const b = this.buffers[buffer].breaks;
    const firstBreak = lowerBound(b, start);
    return { buffer, start, count, firstBreak,
      breaks: lowerBound(b, start + count) - firstBreak,
      priority: priority(), left: null, right: null,
      length: count, newlines: lowerBound(b, start + count) - firstBreak };
  }
  split(n, offset) {
    if (!n) return [null, null];
    const leftSize = size(n.left);
    if (offset < leftSize) {
      const [a, b] = this.split(n.left, offset); n.left = b; return [a, update(n)];
    }
    if (offset > leftSize + n.count) {
      const [a, b] = this.split(n.right, offset - leftSize - n.count); n.right = a; return [update(n), b];
    }
    if (offset === leftSize) { const a = n.left; n.left = null; return [a, update(n)]; }
    if (offset === leftSize + n.count) { const b = n.right; n.right = null; return [update(n), b]; }
    const at = offset - leftSize;
    const a = this.node(n.buffer, n.start, at), b = this.node(n.buffer, n.start + at, n.count - at);
    a.priority = b.priority = n.priority;
    return [merge(n.left, a), merge(b, n.right)];
  }
  get length() { return size(this.root); }
  get lineCount() { return lines(this.root) + 1; }
  replace(start, end, text) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > this.length)
      throw new RangeError(`Invalid edit [${start}, ${end}) / ${this.length}`);
    if (typeof text !== 'string') throw new TypeError('Replacement must be text');
    const [a, rest] = this.split(this.root, start);
    const [, b] = this.split(rest, end - start);
    const inserted = text.length ? this.node(this.addBuffer(text), 0, text.length) : null;
    this.root = merge(merge(a, inserted), b); this.version++;
  }
  slice(start = 0, end = this.length) {
    start = Math.max(0, start); end = Math.min(this.length, end);
    if (end <= start) return '';
    const out = [];
    const visit = (n, base) => {
      if (!n || base >= end || base + n.length <= start) return;
      const p = base + size(n.left);
      visit(n.left, base);
      const a = Math.max(start - p, 0), b = Math.min(end - p, n.count);
      if (b > a) out.push(this.buffers[n.buffer].text.slice(n.start + a, n.start + b));
      visit(n.right, p + n.count);
    };
    visit(this.root, 0); return out.join('');
  }
  /** Absolute offset of the zero-indexed nth newline, or document length. */
  newlineAt(index) {
    if (index < 0) return -1;
    let n = this.root, offset = 0;
    while (n) {
      const l = lines(n.left);
      if (index < l) { n = n.left; continue; }
      offset += size(n.left); index -= l;
      if (index < n.breaks) return offset + this.buffers[n.buffer].breaks[n.firstBreak + index] - n.start;
      index -= n.breaks; offset += n.count; n = n.right;
    }
    return this.length;
  }
  getLine(line) {
    if (line < 0 || line >= this.lineCount) return '';
    return this.slice(this.newlineAt(line - 1) + 1, this.newlineAt(line));
  }
  lineStart(line) { return this.newlineAt(Math.max(0, Math.min(line, this.lineCount - 1)) - 1) + 1; }
  offsetAt(line, column = 0) {
    line = Math.max(0, Math.min(line, this.lineCount - 1));
    const a = this.lineStart(line), b = this.newlineAt(line);
    return a + Math.max(0, Math.min(column, b - a));
  }
  positionAt(offset) {
    offset = Math.max(0, Math.min(offset, this.length));
    const absolute = offset;
    let n = this.root, line = 0;
    while (n) {
      const left = size(n.left);
      if (offset < left) { n = n.left; continue; }
      line += lines(n.left); offset -= left;
      if (offset <= n.count) {
        line += lowerBound(this.buffers[n.buffer].breaks, n.start + offset) - n.firstBreak;
        break;
      }
      line += n.breaks; offset -= n.count; n = n.right;
    }
    return { line, column: absolute - (this.newlineAt(line - 1) + 1) };
  }
  toString() { return this.slice(); }
  /** Reclaim unreachable insertion buffers after an explicit history reset. */
  compact() {
    const text = this.toString(); this.buffers = [];
    this.root = text ? this.node(this.addBuffer(text), 0, text.length) : null;
  }
}

export class TextDocument extends EventTarget {
  constructor(path, text = '') {
    super(); this.path = path;
    this.eol = text.includes('\r\n') ? '\r\n' : '\n';
    this.buffer = new PieceTable(text.replace(/\r\n?/g, '\n'));
    this.savedText = this.buffer.toString();
    this.baseline = this.savedText;
    this.selection = { anchor: 0, head: 0 };
    this.undoStack = []; this.redoStack = [];
    this.scrollTop = 0; this.scrollLeft = 0;
    this.diagnostics = []; this.symbols = []; this.breakpoints = new Set();
    this.dirty = false; this.disposed = false;
    this.revision = 0; this.savedRevision = 0; this.nextRevision = 1;
  }
  get text() { return this.buffer.toString(); }
  get language() {
    return ({ js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
      cs: 'csharp', xaml: 'xml', axaml: 'xml', csproj: 'xml', html: 'html', htm: 'html',
      css: 'css', json: 'json', md: 'markdown', wgsl: 'wgsl', xml: 'xml', yml: 'yaml', yaml: 'yaml' })
      [this.path.split('.').pop().toLowerCase()] || 'plaintext';
  }
  setSelection(anchor, head = anchor) {
    this.selection = { anchor: Math.max(0, Math.min(anchor, this.buffer.length)), head: Math.max(0, Math.min(head, this.buffer.length)) };
    this.dispatchEvent(new Event('selection'));
  }
  edit(start, end, inserted, options = {}) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > this.buffer.length) throw new RangeError('Invalid document edit range.');
    if (typeof inserted !== 'string') throw new TypeError('Replacement must be text.');
    inserted = inserted.replace(/\r\n?/g, '\n');
    const removed = this.buffer.slice(start, end), before = { ...this.selection };
    if (!removed && !inserted) return;
    const after = options.selection || { anchor: start + inserted.length, head: start + inserted.length };
    const time = Date.now();
    const record = { start, removed, inserted, before, after, time, kind: options.kind || '', beforeRevision:this.revision, afterRevision:this.nextRevision++ };
    const last = this.undoStack.at(-1);
    if (options.kind === 'typing' && last?.kind === 'typing' && time - last.time < 800 &&
        last.afterRevision === this.revision && last.afterRevision !== this.savedRevision && !removed && !last.removed && !inserted.includes('\n') && start === last.start + last.inserted.length) {
      last.inserted += inserted; last.after = after; last.time = time; last.afterRevision = record.afterRevision;
    } else { this.undoStack.push(record); if (this.undoStack.length > 2000) this.undoStack.shift(); }
    this.redoStack.length = 0;
    this.apply(start, end, inserted, after, record.afterRevision);
  }
  apply(start, end, inserted, selection, revision = this.nextRevision++) {
    const startLine = this.buffer.positionAt(start).line;
    this.buffer.replace(start, end, inserted);
    this.selection = { ...selection }; this.revision = revision; this.dirty = this.revision !== this.savedRevision;
    // A content change invalidates source-position breakpoints; never silently pause on stale lines.
    this.breakpoints.clear();
    this.dispatchEvent(new CustomEvent('change', { detail: { start, end, inserted, startLine } }));
    this.dispatchEvent(new Event('selection'));
  }
  undo() {
    const r = this.undoStack.pop(); if (!r) return false;
    this.apply(r.start, r.start + r.inserted.length, r.removed, r.before, r.beforeRevision);
    this.redoStack.push(r); return true;
  }
  redo() {
    const r = this.redoStack.pop(); if (!r) return false;
    this.apply(r.start, r.start + r.removed.length, r.inserted, r.after, r.afterRevision);
    this.undoStack.push(r); return true;
  }
  markSaved(text = this.text, revision = this.revision) { this.savedText = text; this.savedRevision = revision; this.dirty = this.revision !== revision; this.dispatchEvent(new Event('saved')); }
  get changeCount() { return this.text === this.baseline ? 0 : 1; }
}
