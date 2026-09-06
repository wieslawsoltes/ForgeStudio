import { TextDocument } from './text-buffer.js';
export const MAX_FILE_SIZE = 8 * 1024 * 1024;
export const MAX_PROJECT_SIZE = 40 * 1024 * 1024;
export function normalizePath(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('A file path is required.');
  const result = [];
  for (const part of path.replace(/\\/g,'/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!result.length) throw new Error('Path escapes the workspace.'); result.pop(); }
    else { if (/[\0-\x1f<>:"|?*]/.test(part)) throw new Error('Unsupported character in file path.'); result.push(part); }
  }
  if (!result.length) throw new Error('A file name is required.');
  return result.join('/');
}
export class Workspace extends EventTarget {
  constructor() { super(); this.files = new Map(); this.name = 'Nebula'; this.tabs = []; this.activePath = ''; this.handles = new Map(); this.storage = null; this.baselineFiles = new Map(); this.autosaveTimer = null; }
  async init() {
    try {
      this.storage = await new Promise((resolve,reject) => {
        const request = indexedDB.open('forge-studio',1);
        request.onupgradeneeded = () => request.result.createObjectStore('workspaces');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      return await new Promise((resolve,reject) => {
        const req = this.storage.transaction('workspaces').objectStore('workspaces').get('current');
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
    } catch (e) { this.dispatchEvent(new CustomEvent('storageerror',{ detail:e })); return null; }
  }
  add(path,text = '') {
    path = normalizePath(path);
    if (this.files.has(path)) throw new Error('A file with that name already exists.');
    if (text.length > MAX_FILE_SIZE) throw new Error('File exceeds the 8 MiB text limit.');
    const doc = new TextDocument(path,text);
    this.files.set(path,doc);
    doc.addEventListener('change', e => { this.scheduleSave(); this.dispatchEvent(new CustomEvent('documentchange',{ detail:{ document:doc, ...e.detail } })); });
    this.dispatchEvent(new Event('files')); return doc;
  }
  get active() { return this.files.get(this.activePath); }
  open(path) {
    if (!this.files.has(path)) return;
    if (!this.tabs.includes(path)) this.tabs.push(path);
    this.activePath = path; this.dispatchEvent(new Event('active')); this.scheduleSave();
  }
  close(path) {
    const i = this.tabs.indexOf(path); this.tabs = this.tabs.filter(x => x !== path);
    if (this.activePath === path) this.activePath = this.tabs[Math.min(i,this.tabs.length-1)] || '';
    this.dispatchEvent(new Event('active')); this.scheduleSave();
  }
  rename(from,to) {
    to = normalizePath(to);
    if (this.files.has(to)) throw new Error('The destination already exists.');
    const doc = this.files.get(from); if (!doc) throw new Error('File not found.');
    this.files.delete(from); doc.path = to; this.files.set(to,doc);
    // A renamed browser document is not automatically a renamed disk file.
    this.handles.delete(from);
    this.tabs = this.tabs.map(x => x === from ? to : x);
    if (this.activePath === from) this.activePath = to;
    this.dispatchEvent(new Event('files')); this.dispatchEvent(new Event('active')); this.scheduleSave();
  }
  delete(path) { this.files.delete(path); this.handles.delete(path); this.close(path); this.dispatchEvent(new Event('files')); this.scheduleSave(); }
  serialize() {
    return { format:'forge-workspace',version:1,name:this.name,activePath:this.activePath,tabs:[...this.tabs],
      baseline:Object.fromEntries(this.baselineFiles),
      files:[...this.files.values()].map(d => ({ path:d.path,text:d.text,savedText:d.savedText,baseline:d.baseline,eol:d.eol,selection:d.selection,scrollTop:d.scrollTop,scrollLeft:d.scrollLeft })) };
  }
  load(data) {
    if (data?.format !== 'forge-workspace' || data.version !== 1 || !Array.isArray(data.files) || data.files.length > 2000) throw new Error('Invalid Forge Studio workspace.');
    let total = 0; const seen = new Set();
    for (const f of data.files) {
      const path = normalizePath(f.path);
      if (seen.has(path) || typeof f.text !== 'string' || f.text.length > MAX_FILE_SIZE) throw new Error('Invalid or duplicate workspace file.');
      if (f.baseline !== undefined && (typeof f.baseline !== 'string' || f.baseline.length > MAX_FILE_SIZE)) throw new Error('Invalid baseline.');
      if (f.savedText !== undefined && (typeof f.savedText !== 'string' || f.savedText.length > MAX_FILE_SIZE)) throw new Error('Invalid saved content.');
      total += f.text.length + (f.baseline?.length || 0) + (f.savedText?.length || 0); seen.add(path);
    }
    if (total > MAX_PROJECT_SIZE * 3) throw new Error('Workspace exceeds the import size limit.');
    if (data.baseline !== undefined) {
      if (!data.baseline || typeof data.baseline !== 'object' || Array.isArray(data.baseline) || Object.keys(data.baseline).length > 2000) throw new Error('Invalid baseline map.');
      let baselineSize = 0;
      for (const [path,text] of Object.entries(data.baseline)) { normalizePath(path); if (typeof text !== 'string' || text.length > MAX_FILE_SIZE) throw new Error('Invalid baseline file.'); baselineSize += text.length; }
      if (baselineSize > MAX_PROJECT_SIZE) throw new Error('Baseline exceeds size limit.');
    }
    this.baselineFiles = new Map(data.baseline ? Object.entries(data.baseline) : data.files.map(f => [normalizePath(f.path), f.baseline ?? f.text]));
    clearTimeout(this.autosaveTimer); this.files.clear(); this.handles.clear(); this.tabs = [];
    this.name = String(data.name || 'Workspace').slice(0,100);
    for (const file of data.files) {
      const doc = this.add(file.path,file.text);
      doc.baseline = file.baseline ?? doc.text; doc.savedText = file.savedText ?? doc.text; doc.dirty = doc.savedText !== doc.text; doc.savedRevision = doc.dirty ? -1 : doc.revision;
      doc.eol = file.eol === '\r\n' ? '\r\n' : '\n';
      if (Number.isFinite(file.selection?.head) && Number.isFinite(file.selection?.anchor)) doc.setSelection(file.selection.anchor,file.selection.head);
      doc.scrollTop = Math.max(0,Number(file.scrollTop) || 0); doc.scrollLeft = Math.max(0,Number(file.scrollLeft) || 0);
    }
    this.tabs = [...new Set(Array.isArray(data.tabs) ? data.tabs.filter(p => this.files.has(p)) : [])];
    this.activePath = this.files.has(data.activePath) ? data.activePath : this.tabs[0] || this.files.keys().next().value || '';
    if (this.activePath && !this.tabs.includes(this.activePath)) this.tabs.push(this.activePath);
    this.dispatchEvent(new Event('files')); this.dispatchEvent(new Event('active')); this.scheduleSave();
  }
  scheduleSave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => this.persist(),650);
  }
  async persist() {
    if (!this.storage) return false;
    try {
      const data = this.serialize();
      await new Promise((resolve,reject) => {
        const tx = this.storage.transaction('workspaces','readwrite'); tx.objectStore('workspaces').put(data,'current');
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      this.dispatchEvent(new Event('persisted')); return true;
    } catch (e) { this.dispatchEvent(new CustomEvent('storageerror',{detail:e})); return false; }
  }
  async save(document = this.active, writeDisk = true) {
    if (!document) return;
    const handle = this.handles.get(document.path), text = document.text, revision = document.revision;
    if (handle && writeDisk) {
      const writable = await handle.createWritable();
      try { await writable.write(text.replace(/\n/g,document.eol)); await writable.close(); }
      catch (e) { await writable.abort().catch(() => {}); throw e; }
    }
    const previous = document.savedText, previousRevision = document.savedRevision;
    document.markSaved(text, revision);
    if (!(await this.persist())) { document.savedText = previous; document.savedRevision = previousRevision; document.dirty = document.revision !== previousRevision; throw new Error('Workspace storage is unavailable. Export a backup to keep your changes.'); }
    this.dispatchEvent(new Event('saved'));
  }
  async saveAll() { for (const doc of this.files.values()) if (doc.dirty) await this.save(doc); await this.persist(); }
  changes() {
    const changes = [];
    for (const [path,doc] of this.files) { const before = this.baselineFiles.get(path); const after = doc.text; if (before === undefined || before !== after) changes.push({path,before:before ?? '',after,kind:before === undefined ? 'added' : 'modified'}); }
    for (const [path,before] of this.baselineFiles) if (!this.files.has(path)) changes.push({path,before,after:'',kind:'deleted'});
    return changes;
  }
  setBaseline() { this.baselineFiles = new Map([...this.files].map(([path,d]) => [path,d.text])); for (const d of this.files.values()) d.baseline=d.text; this.scheduleSave(); this.dispatchEvent(new Event('baseline')); }
  snapshot() { return Object.fromEntries([...this.files].map(([path,d]) => [path,d.text])); }
}
