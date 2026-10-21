
const { app, BrowserWindow, ipcMain, dialog, shell, session, protocol, Menu } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const crypto=require('node:crypto');
const selectedStepFiles=new Map();
let closeApproved=false;
const { MedusaPipe } = require('./medusa-pipe.cjs');
protocol.registerSchemesAsPrivileged([{ scheme: 'nasscad', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const root = path.resolve(__dirname, '..');
const assets = app.isPackaged ? path.join(process.resourcesPath, 'nasscad') : path.resolve(root, '..');
const engineDir = app.isPackaged ? path.join(process.resourcesPath, 'medusa') : path.join(root, 'runtime', 'medusa');
let win, supervisor, enginePID, origin, quitting = false, cleaned = false;
let engine, engineInfo;
const activeRequests = new Map();
const allowedWrites = new Set();
const mime = { '.htm': 'text/html; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
async function startMedusa() {
  const enginePath = path.join(engineDir, 'Medusa_Internal.exe');
  if (!fs.existsSync(enginePath)) throw new Error('Medusa engine not found: ' + enginePath);
  engine = new MedusaPipe(process.execPath, path.join(__dirname,'supervisor.cjs'), enginePath, app.getPath('userData'));
  supervisor = engine.child;
  const chunks=[];
  const ready=new Promise((resolve,reject)=> {
    engine.request('GET','/ping',null,{onData:bytes=>chunks.push(Buffer.from(bytes)),onEnd:()=>{
      try { engineInfo=JSON.parse(Buffer.concat(chunks).toString());resolve(); } catch(error) {reject(error);}
    },onError:message=>reject(new Error(String(message)))}).catch(reject);
  });
  await Promise.race([ready, new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('Medusa did not start within 30 seconds.')),30000);ready.finally(()=>clearTimeout(t)).catch(()=>{});})]);
  enginePID = engine.pid;
}
async function serveAssets() {
  origin = 'nasscad://app';
  protocol.handle('nasscad', async request => {
    try {
      const url = new URL(request.url), name = decodeURIComponent(url.pathname).slice(1);
      if(url.host!=='app' || !name || path.basename(name)!==name || !mime[path.extname(name).toLowerCase()]) return new Response(null,{status:404});
      const bytes=await fs.promises.readFile(path.join(assets,name));
      return new Response(request.method==='HEAD'?null:bytes,{headers:{'Content-Type':mime[path.extname(name).toLowerCase()], 'Content-Security-Policy':"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' data: blob: ws://127.0.0.1:*; worker-src 'self' blob: data:; object-src 'none'; base-uri 'self'",'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'credentialless'}});
    } catch { return new Response(null,{status:404}); }
  });
}
function trusted(event) {
  if (!win || event.sender !== win.webContents ||
      !event.senderFrame?.url.startsWith(origin + '/')) throw new Error('IPC source denied');
}
function registerIPC() {
  ipcMain.handle('nasscad:prepare-step-file',async(event,selected,size,modified)=>{
    trusted(event);if(typeof selected!=='string' || !/\.(stp|step|p21)$/i.test(selected))throw new Error('Select a STEP file.');
    const stat=await fs.promises.stat(selected);if(!stat.isFile() || stat.size!==size || Math.abs(stat.mtimeMs-modified)>2)throw new Error('Source file changed. Select it again.');
    const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(selected,{highWaterMark:1048576}))hash.update(chunk);
    const handle=await fs.promises.open(selected,'r'),head=Buffer.alloc(Math.min(4096,stat.size));try{await handle.read(head,0,head.length,0)}finally{await handle.close()}
    const token=crypto.randomUUID();selectedStepFiles.set(token,{path:selected,size:stat.size,mtime:stat.mtimeMs});
    if(selectedStepFiles.size>128)selectedStepFiles.delete(selectedStepFiles.keys().next().value);
    return {nasscadFileToken:token,byteLength:stat.size,hashHex:hash.digest('hex'),head:new Uint8Array(head)};
  });
  const recoveryPath=path.join(app.getPath('userData'),'project-recovery.bin');
  let recoveryWrites=Promise.resolve();
  ipcMain.handle('nasscad:confirm-unsaved', async event => {trusted(event);return (await dialog.showMessageBox(win,{type:'warning',title:'Unsaved changes',message:'Save changes to your project?',detail:'Your current work will be replaced or closed.',buttons:['Save As','Discard','Cancel'],defaultId:0,cancelId:2,noLink:true})).response;});
  ipcMain.handle('nasscad:recovery-save', (event,data) => {trusted(event);recoveryWrites=recoveryWrites.catch(()=>{}).then(async()=>{const tmp=recoveryPath+'.tmp';await fs.promises.writeFile(tmp,v8.serialize(data));await fs.promises.rename(tmp,recoveryPath);});return recoveryWrites.then(()=>true);});
  ipcMain.handle('nasscad:recovery-read', async event => {trusted(event);try{return v8.deserialize(await fs.promises.readFile(recoveryPath))}catch(error){if(error.code==='ENOENT')return null;throw error;}});
  ipcMain.handle('nasscad:recovery-clear', event => {trusted(event);recoveryWrites=recoveryWrites.catch(()=>{}).then(()=>fs.promises.unlink(recoveryPath).catch(error=>{if(error.code!=='ENOENT')throw error}));return recoveryWrites;});
  ipcMain.on('nasscad:close-approved', event=>{trusted(event);closeApproved=true;win.close();});

  ipcMain.handle('nasscad:downloads', event => { trusted(event); return app.getPath('downloads'); });
  ipcMain.handle('nasscad:save-dialog', async (event, options = {}) => {
    trusted(event);
    const suggested = typeof options.defaultPath === 'string' ? options.defaultPath : 'nasscad-project.json';
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.isAbsolute(suggested) ? suggested : path.join(app.getPath('documents'), path.basename(suggested)),
      title: 'Save As', buttonLabel: 'Save', filters: options.filters, properties: ['createDirectory', 'showOverwriteConfirmation']
    });
    if (result.canceled || !result.filePath) return null;
    allowedWrites.add(path.resolve(result.filePath));
    return result.filePath;
  });
  ipcMain.handle('nasscad:write', async (event, filePath, data) => {
    trusted(event);
    try {
      if (typeof filePath !== 'string' || !allowedWrites.has(path.resolve(filePath))) {
        throw new Error('Choose a destination in the Save As dialog.');
      }
      let bytes;
      if (typeof data === 'string') bytes = Buffer.from(data, 'utf8');
      else if (data instanceof ArrayBuffer) bytes = Buffer.from(data);
      else if (ArrayBuffer.isView(data)) bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      else throw new Error('Unsupported data format.');
      const tempPath = filePath + '.nasscad-' + process.pid + '-' + Date.now() + '.tmp';
      try {
        const handle = await fs.promises.open(tempPath, 'wx');
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await fs.promises.rename(tempPath, filePath);
      } finally { await fs.promises.unlink(tempPath).catch(()=>{}); }
      allowedWrites.delete(path.resolve(filePath));
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('nasscad:medusa-status', event => {
    trusted(event); return { running: !engine.error, pid: engine.pid, engine: engineInfo, error: engine.error, transport: 'internal pipe' };
  });
  ipcMain.handle('nasscad:medusa-log', (event,force=false) => { trusted(event); return force ? engine.refreshLog() : engine.log; });
  ipcMain.handle('nasscad:medusa-request', async (event,id,method,route,body) => {
    trusted(event);
    if (!Number.isSafeInteger(id) || activeRequests.has(id) || !['GET','POST','OPTIONS'].includes(method) || !/^\/(ping|log|step|ifc|stepstream|stepexport|stepheld|stepload|csg|csgtree|smooth|repair)(\?|$)/.test(route)) throw new Error('Invalid Medusa request.');
    const job = { canceled: false, id }; activeRequests.set(id,job);
    let payload=body;
    if(body?.nasscadFileToken){
      if(method!=='POST'||!/^\/(step|stepstream|stepload)(\?|$)/.test(route))throw new Error('File transport is restricted to STEP routes.');
      const source=selectedStepFiles.get(body.nasscadFileToken);if(!source)throw new Error('Selected source file has expired.');
      const stat=await fs.promises.stat(source.path);if(stat.size!==source.size || stat.mtimeMs!==source.mtime)throw new Error('Source file changed during import.');
      payload={filePath:source.path,size:source.size};
    }
    return engine.request(method,route,payload,{id,
      onData: bytes => job.canceled ? undefined : new Promise(resolve => {
        job.resume=()=>{clearTimeout(job.ackTimer);resolve()};
        job.ackTimer=setTimeout(()=>{ if(!job.canceled && !event.sender.isDestroyed())event.sender.send('nasscad:medusa-frame',id,{error:'Response was not consumed for 30 seconds.'});job.canceled=true;job.resume?.(); },30000);
        if (event.sender.isDestroyed()) { job.canceled=true;resolve();return; }
        event.sender.send('nasscad:medusa-frame',id,{bytes});
      }),
      onEnd: () => { activeRequests.delete(id); if(!job.canceled && !event.sender.isDestroyed()) event.sender.send('nasscad:medusa-frame',id,{end:true}); },
      onError: error => { const deliver=!job.canceled;job.canceled=true;job.resume?.();activeRequests.delete(id); if(deliver && !event.sender.isDestroyed()) event.sender.send('nasscad:medusa-frame',id,{error:String(error)}); }
    });
  });
  ipcMain.on('nasscad:medusa-ack', (event,id) => { if (!win || event.sender!==win.webContents) return; trusted(event); const job=activeRequests.get(id); const resume=job?.resume; if(job)job.resume=null;resume?.(); });
  ipcMain.on('nasscad:medusa-cancel', (event,id) => { trusted(event); const job=activeRequests.get(id);if(job){job.canceled=true;job.resume?.();activeRequests.delete(id);engine.cancel(id);} });

}
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if(engine)engine.stopping=true;
  for (const job of activeRequests.values()) { job.canceled=true;job.resume?.(); }
  supervisor=engine?.child;enginePID=engine?.pid;
  if (supervisor && supervisor.exitCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        if (enginePID) {
          const killer = spawn('taskkill.exe', ['/PID', String(enginePID), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore' });
          killer.once('exit', resolve); killer.once('error', resolve);
        } else resolve();
      }, 7000);
      supervisor.once('exit', () => { clearTimeout(timer); resolve(); });
      supervisor.stdin.end();
    });
  }
  for (const job of activeRequests.values()) { job.canceled=true;job.resume?.(); }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (cleaned) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    cleanup().finally(() => app.quit());
  });
  app.whenReady().then(async () => {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    await startMedusa();
    await serveAssets();
    registerIPC();
    win = new BrowserWindow({
      width: 1440, height: 950, minWidth: 960, minHeight: 640, show: false,
      title: 'NASSCAD · MEDUSA', icon: path.join(assets, 'Nasscad_V4.ico'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
    });
    win.setMenuBarVisibility(false);
    win.webContents.on('context-menu', (_event, params) => {
      if (!params.isEditable) return;
      const flags=params.editFlags;
      Menu.buildFromTemplate([
        { role: 'undo', enabled: flags.canUndo },
        { role: 'redo', enabled: flags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: flags.canCut },
        { role: 'copy', enabled: flags.canCopy },
        { role: 'paste', enabled: flags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: flags.canSelectAll }
      ]).popup({window:win});
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(origin + '/') && /\.(html?|pdf)(?:[?#]|$)/i.test(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: {
          autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false }
        }};
      }
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== origin + '/NASSCAD_V4_7_0.htm') {
        event.preventDefault();
        if (/^https?:\/\//i.test(url) && !url.startsWith(origin)) shell.openExternal(url);
      }
    });
    win.on('close', event=>{if(!closeApproved && !quitting && !win.webContents.isDestroyed()){event.preventDefault();win.webContents.send('nasscad:close-request');}});
    win.on('closed', () => {
      win = null;
      for (const other of BrowserWindow.getAllWindows()) other.destroy();
      app.quit();
    });
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({
        defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename()))
      });
    });
    win.webContents.on('render-process-gone', (_event,details) => { dialog.showErrorBox('NASSCAD — renderer stopped', 'The 3D view stopped ('+details.reason+'). Restart NASSCAD to recover the latest automatic backup.');app.quit(); });
    await win.loadURL(origin + '/NASSCAD_V4_7_0.htm');
    win.show();
  }).catch(async error => {
    quitting = true;
    await cleanup();
    try { dialog.showErrorBox('NASSCAD — unable to start', error?.message || String(error || 'Unknown startup error')); } finally { app.quit(); }
  });
}
