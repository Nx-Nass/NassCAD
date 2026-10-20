const { spawn } = require('node:child_process');
const fs=require('node:fs');
const { StringDecoder } = require('node:string_decoder');
class MedusaPipe {
  constructor(executable, supervisorPath, enginePath, cwd) {
    this.queue = []; this.pending = new Map(); this.lines = []; this.partial = ''; this.carriage = false; this.decoder = new StringDecoder('utf8'); this.error = ''; this.pid = null;
    this.launchArgs={executable,supervisorPath,enginePath,cwd}; this.start();
  }
  start() {
    const {executable,supervisorPath,enginePath,cwd}=this.launchArgs;this.error='';this.current=null;this.pid=null;
    const owned = this.child = spawn(executable, [supervisorPath, enginePath, cwd], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe','pipe','pipe']
    });
    let lines = '';
    this.child.stderr.on('data', chunk => {
      lines += chunk.toString(); let index;
      while ((index = lines.indexOf('\n')) >= 0) {
        const line = lines.slice(0,index); lines = lines.slice(index+1);
        try { const state = JSON.parse(line);
          if(this.child!==owned)return;
          if (state.pid) this.pid = state.pid;
          if (state.log) this.appendLog(this.decoder.write(Buffer.from(state.log,'base64')));
          if (state.error) this.fail(new Error(state.error));
        } catch {}
      }
    });
    owned.on('error', error => {if(this.child===owned)this.fail(error)});
    owned.on('exit', code => { if(this.child===owned)this.fail(new Error('Medusa stopped (code '+code+').')); });
    this.readFrames(owned).catch(error => {if(this.child===owned)this.fail(error)});
  }
  get log() { return this.lines.join('\n') + (this.partial ? '\n' + this.partial : ''); }
  appendLog(text) {
    for(const c of text.replace(/\x1b\[[0-9;]*([A-Za-z])/g,(sequence,command)=>command==='m'?sequence:'')) {
      if(c==='\r') {this.carriage=true;continue;}
      if(c==='\n') {this.lines.push(this.partial.trimEnd());if(this.lines.length>2500)this.lines.shift();this.partial='';this.carriage=false;continue;}
      if(this.carriage) {this.partial='';this.carriage=false;}
      if(c==='\b')this.partial=this.partial.slice(0,-1);else this.partial+=c;
    }
  }
  async refreshLog() {
    // Native requests are serial. Do not enqueue a console refresh behind a long import.
    if(this.current || this.error) return this.log;
    return new Promise((resolve,reject)=> {
      const chunks=[];
      this.request('GET','/log?n=2500&ansi=1',null,{onData:bytes=>chunks.push(Buffer.from(bytes)),onEnd:()=>resolve(Buffer.concat(chunks).toString('utf8').replace(/\x1b\[[0-9;]*([A-Za-z])/g,(sequence,command)=>command==='m'?sequence:'')),onError:reject}).catch(reject);
    });
  }
  fail(error) {
    this.error ||= error.message;
    for (const job of this.pending.values()) { job.reject(error); job.onError?.(error.message); job.resume?.(); }
    this.pending.clear(); this.queue.length = 0;this.current=null;
  }
  cancel(id) {
    const job=Array.from(this.pending.values()).find(j=>j.id===id);if(!job)return;
    if(job!==this.current){this.queue=this.queue.filter(j=>j!==job);this.pending.delete(job);job.reject(new Error('Request canceled.'));job.onError?.('Request canceled.');return;}
    // OCCT readers cannot be interrupted safely mid-parse. Restart the owned engine;
    // exact STEP sources are reloaded through the existing /stepheld + /stepload cache.
    const old=this.child;this.restartPromise=new Promise(resolve=>{this.restartResolve=resolve});this.fail(new Error('Medusa operation canceled; engine restarting.'));
    this.child=null;
    old.once('exit',()=>{if(this.child===null && !this.stopping)this.start();this.restartResolve?.();this.restartPromise=null;});old.stdin.end();
  }
  request(method, route, body, hooks = {}) {
    if(this.restartPromise)return this.restartPromise.then(()=>this.request(method,route,body,hooks));
    if (this.error) return Promise.reject(new Error(this.error));
    return new Promise((resolve,reject) => {
      const job = {method,route,body:body?.filePath?body:Buffer.from(body || []),resolve,reject,...hooks};
      this.pending.set(job,job); this.queue.push(job); if (!this.current) this.next();
    });
  }
  next() {
    this.current = this.queue.shift(); if (!this.current) return;
    const job = this.current, method = Buffer.from(job.method), route = Buffer.from(job.route);
    const head = Buffer.alloc(16); head.writeUInt32LE(method.length,0); head.writeUInt32LE(route.length,4); head.writeBigUInt64LE(BigInt(job.body.filePath?job.body.size:job.body.length),8);
    const owned=this.child;owned.stdin.write(head);owned.stdin.write(method);owned.stdin.write(route);
    if(job.body.filePath){
      const source=job.body;job.body=null;
      (async()=>{const stream=fs.createReadStream(source.filePath,{highWaterMark:1048576});try{for await(const chunk of stream){if(this.current!==job || this.child!==owned)break;if(!owned.stdin.write(chunk))await new Promise((resolve,reject)=>{const clear=()=>{owned.stdin.off('drain',done);owned.stdin.off('error',failed);owned.stdin.off('close',closed)};const done=()=>{clear();resolve()};const failed=error=>{clear();reject(error)};const closed=()=>failed(new Error('Engine pipe closed while reading source file.'));owned.stdin.once('drain',done);owned.stdin.once('error',failed);owned.stdin.once('close',closed);});}}finally{stream.destroy();}})().catch(error=>{if(this.child===owned){job.onError?.(error.message);this.cancel(job.id);}});
    }else{owned.stdin.write(job.body);job.body=null;}
  }
  async readFrames(owned) {
    let buffer = Buffer.alloc(0);
    for await (const part of owned.stdout) {
      if(this.child!==owned)return;
      buffer = buffer.length ? Buffer.concat([buffer,part]) : part;
      while (buffer.length >= 8) {
        if(this.child!==owned)return;
        const type=buffer.readUInt32LE(0), len=buffer.readUInt32LE(4);
        if (len>1048576 || type<1 || type>4) throw new Error('Invalid Medusa pipe frame.');
        if (buffer.length < 8+len) break;
        const bytes=buffer.subarray(8,8+len); buffer=buffer.subarray(8+len);
        const job=this.current; if (!job) throw new Error('Unexpected Medusa response.');
        if (type===1) { job.meta=JSON.parse(bytes.toString()); job.resolve(job.meta); }
        else if (type===2) { if(!job.failed) await job.onData?.(bytes); }
        else if (type===4) { job.failed=true; const error=new Error(bytes.toString());job.reject(error);job.onError?.(error.message); }
        else { job.onEnd?.(); this.pending.delete(job); this.current=null; this.next(); }
      }
    }
    if (this.child===owned && !this.error) this.fail(new Error('Medusa pipe closed.'));
  }
}
module.exports = { MedusaPipe };
