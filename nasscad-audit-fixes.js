// Data integrity and import conventions shared by desktop and browser builds.
function _nasValidateProject(d){
  if(!d || !Array.isArray(d.objects))throw new Error('Invalid project: objects array is required.');
  const ids=new Set();
  for(const o of d.objects){
    if(!o || typeof o.type!=='string')throw new Error('Invalid project object.');
    if(typeof o.name!=='string')throw new Error('Invalid project object name.');
    if(!Number.isSafeInteger(o.id) || o.id<1 || ids.has(o.id))throw new Error('Invalid or duplicate project object ID.');
    ids.add(o.id);
    for(const [key,legacy] of [['p','position'],['r','rotation'],['s','scale']]){
      const a=o[key] || (o[legacy] && ['x','y','z'].map(k=>o[legacy][k]));
      if(!Array.isArray(a) || a.length!==3 || !a.every(Number.isFinite))throw new Error('Invalid '+key+' transform in project.');
      if(key==='s' && a.some(x=>x===0))throw new Error('Project scale cannot be zero.');
    }
    if(o.type==='csg' && !o.geo && !o.geoPos && !o.geometry)throw new Error('Missing mesh geometry in project.');
    if(o.faceCols && !Array.isArray(o.faceCols))throw new Error('Invalid face colour palette.');
    if(o.faceGrp && (!Array.isArray(o.faceGrp) || o.faceGrp.length%3 || !o.faceGrp.every(Number.isFinite)))throw new Error('Invalid face material ranges.');
    if(o.opacity!==undefined && (!Number.isFinite(o.opacity)||o.opacity<0||o.opacity>1))throw new Error('Invalid project opacity.');
  }
  if(d.camera){
    if(!['theta','phi','dist'].every(k=>Number.isFinite(d.camera[k])) || d.camera.dist<=0)throw new Error('Invalid project camera.');
    const t=d.camera.target;if(t){const a=Array.isArray(t)?t:['x','y','z'].map(k=>t[k]);if(a.length!==3||!a.every(Number.isFinite))throw new Error('Invalid camera target.');}
  }
  if(d.csgTree!==undefined && (!Array.isArray(d.csgTree) || !d.csgTree.every(e=>Array.isArray(e)&&e.length===2&&Number.isSafeInteger(e[0])&&e[1]&&typeof e[1]==='object')))throw new Error('Invalid CSG history.');
}
function _nasValidateMeshGeometry(g){
  const p=g.attributes.position;
  if(!p || p.itemSize!==3 || !Number.isInteger(p.count) || p.count<3)throw new Error('Invalid mesh positions.');
  for(const value of p.array)if(!Number.isFinite(value))throw new Error('Mesh coordinates must be finite.');
  const normal=g.attributes.normal;
  if(normal){if(normal.itemSize!==3 || normal.count!==p.count)throw new Error('Mesh normals do not match its vertices.');for(const value of normal.array)if(!Number.isFinite(value))throw new Error('Mesh normals must be finite.');}
  if(g.index){
    if(g.index.count<3 || g.index.count%3)throw new Error('Mesh indices must describe complete triangles.');
    for(const index of g.index.array)if(!Number.isInteger(index)||index<0||index>=p.count)throw new Error('Mesh index is outside its vertex array.');
  }else if(p.count%3)throw new Error('Mesh vertices must describe complete triangles.');
}
function _nasDisposePreparedObjects(objects){
  for(const o of objects){o.mesh.geometry.dispose();_matAll(o.mesh.material).forEach(m=>m.dispose());}
}

(() => {
  const api=window.electronAPI,isDesktop=!!api?.isElectron;
  let dirty=false,revision=0,timer,writing=null,closing=false,restoring=false,confirming=false;
  async function backup(){
    if(!isDesktop || !dirty || restoring)return;
    if(writing)return writing;
    const rev=revision;
    writing=(async()=>{
      try{await api.saveRecovery({savedAt:Date.now(),name:_currentProjectName,data:_journalData()});}
      catch(error){nasLog('ERROR','Automatic recovery backup failed: '+error.message);}
    })();
    try{await writing;}finally{writing=null;if(dirty && rev!==revision)schedule();}
  }
  function schedule(){if(!isDesktop)return;clearTimeout(timer);timer=setTimeout(backup,1500);}
  function markDirty(){if(restoring)return;dirty=true;revision++;schedule();}
  async function markClean(expected){
    if(expected!==undefined && expected!==revision)return false;
    const cleanRevision=revision;
    clearTimeout(timer);
    if(writing)await writing;
    // A change while a save/recovery write is pending must stay protected.
    if(cleanRevision!==revision)return false;
    dirty=false;
    if(isDesktop)await api.clearRecovery();
    return true;
  }
  function browserChoice(){
    return new Promise(resolve=>{
      const active=document.activeElement,dialog=document.createElement('dialog');
      dialog.id='nas-project-confirm';dialog.className='vb-win';
      dialog.setAttribute('aria-labelledby','nas-project-confirm-title');
      dialog.style.cssText='padding:0;width:min(390px,calc(100vw - 24px));max-height:calc(100vh - 24px);color:var(--text);background:var(--panel);font:inherit;border:1px solid var(--lo);';
      dialog.innerHTML='<div class="vb-tbar"><span id="nas-project-confirm-title">Unsaved project</span></div><div style="padding:14px;line-height:1.5">Save your changes before continuing?<div style="margin-top:14px;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap"><button class="vb-btn" id="nas-project-save" data-nas-project-choice="0">Save</button><button class="vb-btn" id="nas-project-discard" data-nas-project-choice="1">Discard</button><button class="vb-btn" id="nas-project-cancel" data-nas-project-choice="2" autofocus>Cancel</button></div></div>';
      function finish(value){window.removeEventListener('keydown',keyboard,true);dialog.close();dialog.remove();if(active?.isConnected)active.focus();resolve(value);}
      function keyboard(event){
        // Application shortcuts must never modify the scene behind this dialog.
        event.stopImmediatePropagation();
        if(event.key==='Escape'){event.preventDefault();finish(2);}
      }
      dialog.addEventListener('cancel',event=>{event.preventDefault();finish(2);});
      dialog.addEventListener('click',event=>{const button=event.target.closest('[data-nas-project-choice]');if(button)finish(Number(button.dataset.nasProjectChoice));});
      document.body.append(dialog);window.addEventListener('keydown',keyboard,true);
      dialog.showModal();dialog.querySelector('#nas-project-cancel').focus();
    });
  }
  async function confirmChange(){
    if(confirming)return false;
    if(!dirty)return true;
    confirming=true;
    try{
      await backup();
      const answer=isDesktop ? await api.confirmUnsaved() : await browserChoice();
      if(answer===2)return false;
      if(answer===0){
        const saved=await saveProjectAs();
        if(saved==='download')_nasAlert('Project download started. Keep this project open until the file is saved. To continue afterwards, choose Discard.');
        return saved===true && !dirty;
      }
      return answer===1;
    }finally{confirming=false;}
  }
  window.NasscadProjectGuard={markDirty,markClean,confirmChange,backup,get dirty(){return dirty},get revision(){return revision}};
  const push=undoPush;undoPush=function(...args){markDirty();return push.apply(this,args)};
  for(const name of ['setTr','setDim','setColor','setOpacity']){
    const fn=window[name];if(typeof fn==='function')window[name]=function(...args){const result=fn.apply(this,args);if(selObjs.length)markDirty();return result};
  }
  const updateList=updOList;updOList=function(...args){const value=updateList.apply(this,args);if(dirty&&!restoring){revision++;schedule();}return value;};
  if(!isDesktop){
    window.addEventListener('beforeunload',event=>{if(!dirty)return;event.preventDefault();event.returnValue='';});
    return;
  }
  api.onCloseRequest(async()=>{
    if(closing)return;closing=true;
    try{if(await confirmChange()){await markClean();api.approveClose();}}finally{closing=false;}
  });
  setTimeout(async()=>{
    try{
      const saved=await api.readRecovery();if(!saved?.data)return;
      if(!confirm('An automatic project backup is available from '+new Date(saved.savedAt).toLocaleString()+'.\nRecover your work?')){await api.clearRecovery();return;}
      restoring=true;_buildSceneFromData(saved.data);_currentProjectName=saved.name||'recovered-project';restoring=false;markDirty();
      nasLog('OK','Project recovered from automatic backup');
    }catch(error){restoring=false;nasLog('ERROR','Project recovery failed: '+error.message);}
  },750);
})();
window.NasscadImportSettings={preserveCoordinates:true,objUp:'y'};
try{Object.assign(NasscadImportSettings,JSON.parse(localStorage.getItem('nasscad.import.settings')||'{}'));}catch{}
(() => {
  const menu=document.getElementById('impdd');if(!menu)return;
  const box=document.createElement('div');box.style.cssText='padding:8px;border-top:1px solid #657085;font-size:12px;display:grid;gap:6px';
  box.innerHTML='<label><input type="checkbox" id="nas-keep-coordinates"> Preserve source coordinates</label><label>OBJ up axis <select id="nas-obj-up"><option value="y">Y-up</option><option value="z">Z-up</option></select></label>';
  box.onclick=event=>event.stopPropagation();menu.append(box);
  const keep=box.querySelector('input'),up=box.querySelector('select');keep.checked=NasscadImportSettings.preserveCoordinates;up.value=NasscadImportSettings.objUp;
  keep.onchange=up.onchange=()=>{NasscadImportSettings.preserveCoordinates=keep.checked;NasscadImportSettings.objUp=up.value;localStorage.setItem('nasscad.import.settings',JSON.stringify(NasscadImportSettings));};
})();
// Remove zero-area faces while retaining face/material ranges and vertex attributes.
function _nasCleanTriangles(geo){
  const p=geo.attributes.position;if(!p)return geo;const src=geo.index?.array,n=src?src.length:p.count;
  let indices=null;const removed=new Uint32Array(geo.groups.length);
  for(let t=0;t+2<n;t+=3){
    const a=src?src[t]:t,b=src?src[t+1]:t+1,c=src?src[t+2]:t+2;
    const ax=p.getX(b)-p.getX(a),ay=p.getY(b)-p.getY(a),az=p.getZ(b)-p.getZ(a);
    const bx=p.getX(c)-p.getX(a),by=p.getY(c)-p.getY(a),bz=p.getZ(c)-p.getZ(a);
    const cx=ay*bz-az*by,cy=az*bx-ax*bz,cz=ax*by-ay*bx;
    if(a===b||b===c||a===c||cx*cx+cy*cy+cz*cz<=1e-24){
      if(!indices){indices=[];for(let i=0;i<t;i++)indices.push(src?src[i]:i);}
      geo.groups.forEach((g,i)=>{if(t>=g.start && t<g.start+g.count)removed[i]+=3});
      continue;
    }
    if(indices)indices.push(a,b,c);
  }
  if(indices){geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices),1));let dropped=0;geo.groups.forEach((g,i)=>{g.start-=dropped;g.count-=removed[i];dropped+=removed[i]});}
  return geo;
}
function _nasNormalizeClosedMesh(geo,closed){
  if(!closed || !geo.index)return geo;
  const p=geo.attributes.position,ix=geo.index.array;let v=0;
  const ox=p.getX(ix[0]),oy=p.getY(ix[0]),oz=p.getZ(ix[0]);
  for(let t=0;t+2<ix.length;t+=3){
    const a=ix[t],b=ix[t+1],c=ix[t+2];
    const ax=p.getX(a)-ox,ay=p.getY(a)-oy,az=p.getZ(a)-oz,bx=p.getX(b)-ox,by=p.getY(b)-oy,bz=p.getZ(b)-oz,cx=p.getX(c)-ox,cy=p.getY(c)-oy,cz=p.getZ(c)-oz;
    v+=ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx);
  }
  if(v<0){for(let t=0;t+2<ix.length;t+=3){const b=ix[t+1];ix[t+1]=ix[t+2];ix[t+2]=b;}geo.index.needsUpdate=true;geo.computeVertexNormals();nasLog('WARN','Reversed closed mesh detected: outward orientation restored.');}
  return geo;
}
