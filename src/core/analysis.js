export class AnalysisService extends EventTarget {
  constructor(){
    super();this.pending=new Map();this.nextId=1;this.timers=new Map();
    const workerURL=globalThis.FORGE_LANGUAGE_WORKER_URL || new URL('../workers/language-worker.js',import.meta.url);
    this.worker=new Worker(workerURL,{type:globalThis.FORGE_LANGUAGE_WORKER_URL?'classic':'module'});
    this.failure=null;
    this.worker.onmessage=({data})=>{
      const request=this.pending.get(data.id);if(!request)return;this.pending.delete(data.id);clearTimeout(request.timeout);
      const doc=request.document;
      if(doc.buffer.version===data.version){doc.diagnostics=data.diagnostics;doc.symbols=data.symbols;this.dispatchEvent(new CustomEvent('result',{detail:doc}));}
      request.resolve(data);
    };
    this.worker.onerror=e=>{this.failure=new Error(e.message||'The browser could not start the language worker. Editing remains available.');for(const r of this.pending.values()){clearTimeout(r.timeout);r.reject(this.failure);}this.pending.clear();};
  }
  schedule(document){clearTimeout(this.timers.get(document.path));this.timers.set(document.path,setTimeout(()=>{this.analyze(document).catch(e=>this.dispatchEvent(new CustomEvent('error',{detail:e})));},350));}
  analyze(document){
    clearTimeout(this.timers.get(document.path));if(this.failure)return Promise.reject(this.failure);const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{this.pending.delete(id);reject(new Error('Language analysis timed out.'));},10000);
      this.pending.set(id,{document,resolve,reject,timeout});
      this.worker.postMessage({id,path:document.path,text:document.text,language:document.language,version:document.buffer.version});
    });
  }
  async all(workspace){return Promise.all([...workspace.files.values()].map(d=>this.analyze(d)));}
}
