// ══════════════════════════════════════════════════════════════════════════
// nasscad-io.js — module I/O maillage unifié (3MF, GLB, OBJ, PLY, STL —
// export + import pour chacun) — regroupement demandé par Nass (29/08) des
// 10 fichiers io-*.js précédemment séparés :
//   io-3mf-export.js · io-3mf-import.js · io-glb-export.js · io-glb-import.js
//   io-obj-export.js · io-obj-import.js · io-ply-export.js · io-ply-import.js
//   io-stl-export.js · io-stl-import.js
// Regroupement MÉCANIQUE — aucune ligne de logique modifiée, uniquement la
// concaténation. Chaque section ci-dessous garde son ancien nom de fichier
// en repère (traçabilité), et son propre commentaire de contrat de
// dépendances (vérifié par ESLint no-undef à l'origine, pas deviné).
// Vérifié avant fusion : aucune collision de nom entre les 10 fichiers —
// tous les helpers top-level (_decodeDracoEncWasmB64/_decodeDracoWasmB64,
// _dracoEncInst/_dracoInst, _getDracoEncoder/_getDraco, etc.) sont déjà
// distincts Encoder/Decoder ; tous les autres helpers internes (_crc32,
// _zipEntry, cv, faceNormal, _tags, _tag…) sont déclarés À L'INTÉRIEUR de
// leur fonction (exp3MF/import3MF/expSTL/…), donc scope-local, zéro risque
// de shadowing global inter-module.
//
// Contrat de dépendances externes — UNION des 10 modules d'origine :
//   scene, objs, selObjs, objCnt, COL, PS                     — scene state
//   THREE                                                      — Three.js global
//   nasLog, showSpinner, hideSpinner, _nasAlert                — app-wide helpers
//   undoPush, updProps, updOList, updStats                     — app-wide helpers
//   makeGeoHD                                                  — géométrie HD (export)
//   NASSCAD_VERSION                                            — texte des exports
//   _nasDownload                                               — téléchargement partagé
//   _nasSaveWithHandle                                         — [NEW V4.7.2] écriture directe sur
//                                                                 dossier choisi (showSaveFilePicker),
//                                                                 fallback _nasDownload — cf. htm
//   _findFreePos, _csgLog                                      — placement/UI
//   _weldAndCheckManifold, _capStepGaps                        — [02/09] contrôle et
//                                                                 réparation d'étanchéité
//                                                                 avant export — cf. htm
//   computeCenterOfGravity                                     — géométrie (import 3MF)
//   _breathe                                                   — parsing coopératif (import STL/OBJ/PLY)
//   DracoEncoderModule, DracoDecoderModule                     — companions WASM optionnels (GLB)
//
// [NEW V4.7.2] exp3MF/expGLB/expOBJ/expPLY/expSTL/expSTLascii sont maintenant
// async et ouvrent showSaveFilePicker (Chrome/Edge, hors Electron) EN TOUT
// PREMIER — avant tout traitement — pour choisir le dossier de destination,
// exactement comme step-export.js le fait déjà pour le STEP. Annuler le
// dialogue annule l'export (pas de fallback silencieux). Une erreur du picker
// pour une autre raison, ou son absence (Firefox/Safari), retombe sur
// _nasDownload (Téléchargements en navigateur standard, dialogue natif
// showSaveDialog déjà géré par _nasDownload lui-même en Electron).
// ══════════════════════════════════════════════════════════════════════════

// ── [FIX 05/09 — Nass] Choix de la matrice d'export ─────────────────────────
// Les 6 exports (3MF, GLB, OBJ, PLY, STL bin, STL ascii) testaient
// `so.type !== 'csg'` pour decider d'appliquer rotation+position seules (geo
// reconstruite par makeGeoHD, echelle deja bakee dans W/H/D) ou la matrice
// monde complete (geo brute). Or makeGeoHD ne sait pas reconstruire tous les
// types : un 'hollowbox' recoit desormais sa geo d'affichage BRUTE, qui a
// besoin du scale. La vraie question est « makeGeoHD a-t-il reconstruit ? »,
// et c'est _csgCanRebuild() (defini dans le host) qui y repond.
// Repli defensif : si le host est plus ancien, on retombe sur l'ancien test.
function _ioCanRebuild(o){
  return (typeof _csgCanRebuild === 'function')
    ? _csgCanRebuild(o)
    : (o && o.type !== 'csg');
}

// ═══════════════════════════════ 3MF ════════════════════════════════════
// ── io-3mf-export.js ──────────────────────────────────────────────────────
// ── Export 3MF ──────────────────────────────────────────────────────────────
// ZIP writer minimal (stored, no compression) + 3MF core + material extension
// ══════════════════════════════════════════════════════════════════════════
// _watertightGate — contrôle d'étanchéité avant tout export destiné à
// l'impression (3MF, STL binaire).
//
// POURQUOI ICI. Un maillage non fermé ne fait pas échouer l'export : il fait
// échouer l'IMPRESSION, six heures plus tard, sur la machine. Les slicers le
// réparent — mais silencieusement et avec leurs propres hypothèses. Ce
// garde-fou fait la même chose en le DISANT, et avec le moteur de
// l'application plutôt qu'avec celui du slicer.
//
// OÙ EST LE RISQUE — mesuré, et PAS là où on l'attendrait :
//   · ce qui sort du CSG est fermé PAR CONSTRUCTION : c'est l'invariant de
//     Manifold, et le moteur lit déjà manifold_status ;
//   · ce qui entre par STEP est cousu et vérifié (_weldAndCheckManifold et
//     son échelle de tolérances, cf. importSTEP) ;
//   · les GÉNÉRATEURS aussi sont propres. Vérifié un par un au moment d'écrire
//     ce garde-fou — spur, hélicoïdal, chevrons, avec et sans perçage, en
//     qualité 96 et 256, plus la poulie V : 0 arête à nu, 0 arête surnuméraire,
//     étanches. (Un comptage antérieur sur la soupe de triangles BRUTE, sans
//     soudure ni exclusion des triangles dégénérés, donnait 652 "arêtes
//     non-manifold" sur l'engrenage par défaut : c'était un artefact de mesure.
//     Ces 652 venaient de ~1156 triangles dégénérés — points de contour
//     dupliqués après chaque absarc — pas de trous. Un maillage soudé les
//     absorbe, et _edgeManifoldCheck les écarte explicitement.)
//
// Alors pourquoi ce garde-fou ? Pour les deux cas qui restent, et qui sont
// réels :
//   1. les maillages IMPORTÉS — un STL/OBJ/PLY/3MF venu d'ailleurs entre dans
//      objs sans aucun contrôle et ressort tel quel à l'export. C'est le vrai
//      trou, et c'est celui qu'on ne maîtrise pas ;
//   2. la NON-RÉGRESSION — l'étanchéité des générateurs est un fait d'aujourd'hui,
//      pas une garantie. Le prochain générateur, ou la prochaine retouche de
//      profil, peut la casser en silence. Ici, elle ne le pourra plus.
//
// NE BLOQUE JAMAIS. Il répare ce qu'il peut, dit ce qu'il a fait, et laisse
// passer. Un outil de prototypage ne se met pas en travers de son utilisateur :
// c'est lui qui a demandé l'export, il l'aura, informé.
//
// items : [{geo, name}] — MUTÉ. _manifoldRepair libère la géo d'entrée et en
// rend une nouvelle, donc l'appelant DOIT relire items[i].geo après l'appel.
async function _watertightGate(items, label){
  const t0 = performance.now();
  // Au-delà de ce seuil, la carte d'arêtes coûterait plus cher que l'export
  // lui-même et figerait l'onglet. On saute en le disant, plutôt que geler.
  const MAX_TRI = 2000000;
  const triOf = g => { const ix = g.index;
    return ix ? ix.count/3 : (g.attributes.position ? g.attributes.position.count/3 : 0); };

  const bad = [], skipped = [];
  for(let i = 0; i < items.length; i++){
    const g = items[i].geo;
    const nT = triOf(g);
    if(nT === 0) continue;
    if(nT > MAX_TRI){ skipped.push(items[i].name); continue; }
    let ok = null;
    try { ok = _weldAndCheckManifold(g, 4); } catch(e){ ok = null; }
    if(ok === false) bad.push(i);
  }
  for(const n of skipped)
    nasLog('DBG', `${label} — watertight check skipped on "${n}" (over ${MAX_TRI.toLocaleString('en-US')} triangles)`);

  if(!bad.length){
    nasLog('OK', `${label} — watertight: ${items.length} body(ies) checked, all closed`
                 + ` (${Math.round(performance.now()-t0)}ms)`);
    return {checked: items.length, open: 0, repaired: 0, stillOpen: []};
  }

  // ── Réparation : auto-union Manifold, exactement le chemin déjà emprunté à
  //    l'import STEP. Serveur absent ⇒ _manifoldRepair retombe silencieusement
  //    sur la géo d'origine, et le re-contrôle ci-dessous le constatera.
  let repaired = 0; const stillOpen = [];
  for(let k = 0; k < bad.length; k++){
    const it = items[bad[k]];
    const before = (it.geo._nakedEdges||0) + (it.geo._overEdges||0);
    showSpinner(label, `Sealing ${k+1}/${bad.length} — ${it.name}…`, (k+1)/bad.length);
    // [02/09 — corrigé] C'est _capStepGaps qui répare, PAS _manifoldRepair.
    // Cette dernière passe le corps par une auto-union Manifold — or Manifold
    // EXIGE une entrée déjà manifold : sur un maillage troué son constructeur
    // échoue, la fonction retombe silencieusement sur la géométrie d'origine, et
    // le contrôle qui suit annonçait "NOT sealed" sans que rien n'ait été tenté.
    // Elle n'a jamais été un bouche-trou : sa doc dit qu'elle sert à recalculer
    // normales et winding sur un corps DÉJÀ fermé.
    // _capStepGaps, lui, trace les boucles d'arêtes à nu et les triangule —
    // ear-clipping plan, puis poids minimal en repli sur les boucles non planes.
    // Effet de bord appréciable : le contrôle ne dépend plus du moteur MEDUSA,
    // il répare hors ligne.
    let g2 = it.geo;
    try { _capStepGaps(g2); } catch(e){ /* best-effort, jamais bloquant */ }
    let ok2 = false;
    try { ok2 = _weldAndCheckManifold(g2, 4); } catch(e){ ok2 = false; }
    it.geo = g2;
    if(ok2){
      repaired++;
      nasLog('OK', `  ${it.name}: ${before} open edge(s) -> sealed`);
    } else {
      stillOpen.push(it.name);
      nasLog('WARN', `  ${it.name}: ${before} -> ${(g2._nakedEdges||0)+(g2._overEdges||0)} open edge(s), NOT sealed`);
    }
  }

  const line = `${label} — watertight: ${items.length} checked, ${bad.length} open, ${repaired} sealed`
             + (stillOpen.length ? `, ${stillOpen.length} STILL OPEN` : '')
             + ` (${Math.round(performance.now()-t0)}ms)`;
  nasLog(stillOpen.length ? 'WARN' : 'OK', line);
  if(typeof _csgLog === 'function') _csgLog((stillOpen.length ? '⚠ ' : '✓ ') + line);

  if(stillOpen.length){
    _nasAlert('⚠ ' + stillOpen.length + ' body(ies) could not be sealed and may print badly:\n  '
      + stillOpen.slice(0,6).join('\n  ') + (stillOpen.length > 6 ? '\n  …' : '')
      + '\n\nExported anyway. Most slicers close small gaps per layer, so it may still'
      + '\nprint. If it does not: run a Union on the body, which rebuilds its topology.');
  }
  return {checked: items.length, open: bad.length, repaired, stillOpen};
}

async function exp3MF(){
  // [NEW V4.7.2] Choix du dossier — showSaveFilePicker DOIT être appelé ICI,
  // avant tout traitement, pour rester dans la fenêtre de user-gesture
  // (même contrainte que step-export.js/doStepExport). Cancel → pas d'export.
  // API absente (Firefox/Safari) ou autre échec → fallback _nasDownload.
  let _fh=null;
  if(typeof showSaveFilePicker==='function' && !(window.electronAPI&&window.electronAPI.isElectron)){
    try{
      _fh=await showSaveFilePicker({suggestedName:'model.3mf',types:[{description:'3MF File',accept:{'model/3mf':['.3mf']}}]});
    }catch(e){
      if(e.name==='AbortError') return;
      nasLog('WARN','showSaveFilePicker: '+e.message+' — fallback navigateur');
    }
  }
  showSpinner('Export 3MF','Preparing…');
  // [02/09] Le rAF passe de callback à await : le contrôle d'étanchéité qui
  // suit est asynchrone (il peut router vers /repair). Le corps est inchangé
  // par ailleurs — seule l'imbrication disparaît.
  await new Promise(_r => requestAnimationFrame(_r));
  // ── CRC32 ──
  const _crcTable=(()=>{const t=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?(0xEDB88320^(c>>>1)):(c>>>1);t[i]=c;}return t;})();
  function _crc32(buf){let c=0xFFFFFFFF;for(let i=0;i<buf.length;i++)c=_crcTable[(c^buf[i])&0xFF]^(c>>>8);return(c^0xFFFFFFFF)>>>0;}

  // ── ZIP entry builder (stored) ──
  function _enc(s){return new TextEncoder().encode(s);}
  function _u16(v){return[v&0xFF,(v>>8)&0xFF];}
  function _u32(v){return[v&0xFF,(v>>8)&0xFF,(v>>16)&0xFF,(v>>24)&0xFF];}

  function _zipEntry(name,data){
    const nb=_enc(name), db=data instanceof Uint8Array?data:_enc(data);
    const crc=_crc32(db), sz=db.length;
    const local=[0x50,0x4B,0x03,0x04, // sig
      20,0, 0,0, 0,0, // ver,flags,method(stored)
      0,0,0,0, // mod time/date
      ..._u32(crc),..._u32(sz),..._u32(sz),
      ..._u16(nb.length),0,0]; // name len, extra len
    return {name:nb,data:db,crc,sz,local:new Uint8Array(local),offset:0};
  }

  function _zipFinalize(entries){
    // Calculer offsets
    let off=0;
    entries.forEach(e=>{e.offset=off;off+=e.local.length+e.name.length+e.data.length;});
    const cdOff=off;
    // Central directory
    const cdParts=[];
    entries.forEach(e=>{
      const cd=[0x50,0x4B,0x01,0x02,
        20,0,20,0, 0,0, 0,0,
        0,0,0,0,
        ..._u32(e.crc),..._u32(e.sz),..._u32(e.sz),
        ..._u16(e.name.length),0,0,0,0,0,0,0,0,0,0,0,0,
        ..._u32(e.offset)];
      cdParts.push(new Uint8Array(cd),e.name);
    });
    const cdSize=cdParts.reduce((s,p)=>s+p.length,0);
    const eocd=[0x50,0x4B,0x05,0x06,
      0,0,0,0,
      ..._u16(entries.length),..._u16(entries.length),
      ..._u32(cdSize),..._u32(cdOff),
      0,0];
    // Assembler
    const total=off+cdSize+eocd.length;
    const buf=new Uint8Array(total); let pos=0;
    const wr=(a)=>{buf.set(a,pos);pos+=a.length;};
    entries.forEach(e=>{wr(e.local);wr(e.name);wr(e.data);});
    cdParts.forEach(wr);
    wr(new Uint8Array(eocd));
    return buf;
  }

  // ── Construire le 3MF ──
  const cv=(x,y,z)=>({x:x,y:-z,z:y}); // Three Y-up → Z-up
  scene.updateMatrixWorld(true);

  // ── Pass 1: collect HD geometries + global bbox ───────
  const geoList=[];
  let bxMin=Infinity,byMin=Infinity,bzMin=Infinity;
  let bxMax=-Infinity,byMax=-Infinity,bzMax=-Infinity;
  objs.forEach(so=>{
    const gHD=makeGeoHD(so);
    if(_ioCanRebuild(so)){
      const _p=new THREE.Vector3(),_q=new THREE.Quaternion(),_s=new THREE.Vector3();
      so.mesh.matrixWorld.decompose(_p,_q,_s);
      const mPR=new THREE.Matrix4().makeRotationFromQuaternion(_q);mPR.setPosition(_p);
      gHD.applyMatrix4(mPR);
    } else { gHD.applyMatrix4(so.mesh.matrixWorld); }
    const p=gHD.attributes.position;
    for(let i=0;i<p.count;i++){const v=cv(p.getX(i),p.getY(i),p.getZ(i));
      if(v.x<bxMin)bxMin=v.x;if(v.x>bxMax)bxMax=v.x;
      if(v.y<byMin)byMin=v.y;if(v.y>byMax)byMax=v.y;
      if(v.z<bzMin)bzMin=v.z;if(v.z>bzMax)bzMax=v.z;}
    geoList.push({so,gHD});
  });

  // [02/09] Étanchéité — cf. _watertightGate. Le 3MF est le format d'impression
  // par excellence : c'est ici que le contrôle a le plus de valeur.
  {
    const _wt = geoList.map((e,i) => ({geo: e.gHD, name: (e.so && e.so.name) || ('body '+(i+1))}));
    await _watertightGate(_wt, 'Export 3MF');
    for(let i=0;i<geoList.length;i++) geoList[i].gHD = _wt[i].geo;  // la réparation rend une NOUVELLE géo
    showSpinner('Export 3MF','Writing…');
  }
  // Offset: Z minimum = 0 only (part resting on build plate)
  // XY unchanged — slicer handles placement on build plate
  const oxShift=0;
  const oyShift=0;
  const ozShift=-bzMin;

  // Collect unique colors → materials
  const colorMap=new Map(); let matIdx=0;
  objs.forEach(o=>{const c='#'+o.mesh.material.color.getHexString();if(!colorMap.has(c))colorMap.set(c,matIdx++);});

  // Materials XML
  let matXml='';
  colorMap.forEach((idx,hex)=>{
    matXml+=`<m:color id="${idx+1}" color="#${hex.slice(1).toUpperCase()}FF"/>\n`;
  });

  // ── Pass 2: XML objects with offset ──
  let objsXml=''; let buildXml='';
  let oid=2+colorMap.size;

  geoList.forEach(({so,gHD})=>{
    const p=gHD.attributes.position, ix=gHD.index;
    const c='#'+so.mesh.material.color.getHexString();
    const pid=colorMap.get(c)+1;

    // Recentered vertices
    let vx='';
    for(let i=0;i<p.count;i++){
      const v=cv(p.getX(i),p.getY(i),p.getZ(i));
      vx+=`<vertex x="${(v.x+oxShift).toFixed(4)}" y="${(v.y+oyShift).toFixed(4)}" z="${(v.z+ozShift).toFixed(4)}"/>`;
    }
    // Triangles
    let tx='';
    if(ix){for(let i=0;i<ix.count;i+=3)tx+=`<triangle v1="${ix.getX(i)}" v2="${ix.getX(i+1)}" v3="${ix.getX(i+2)}"/>`;}
    else{for(let i=0;i<p.count;i+=3)tx+=`<triangle v1="${i}" v2="${i+1}" v3="${i+2}"/>`;}

    objsXml+=`<object id="${oid}" name="${so.name}" type="model" pid="${pid}" pindex="0"><mesh><vertices>${vx}</vertices><triangles>${tx}</triangles></mesh></object>\n`;
    buildXml+=`<item objectid="${oid}"/>\n`;
    oid++; gHD.dispose();
  });

  const model=`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
<resources>
<m:colorgroup id="1">
${matXml}</m:colorgroup>
${objsXml}</resources>
<build>${buildXml}</build>
</model>`;

  const ct=`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

  const rels=`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  const entries=[
    _zipEntry('[Content_Types].xml', ct),
    _zipEntry('_rels/.rels', rels),
    _zipEntry('3D/3dmodel.model', model),
  ];
  const zip=_zipFinalize(entries);
  const a=document.createElement('a');
  _nasSaveWithHandle('model.3mf', new Blob([zip],{type:'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'}), 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml', _fh);
  nasLog('OK',`Export 3MF — ${objs.length} object(s) — ${(zip.length/1024).toFixed(1)} KB`);
  hideSpinner();
}

// ── io-3mf-import.js ──────────────────────────────────────────────────────
// ── Import 3MF ─────────────────────────────────────────────────────────────
async function import3MF(file){
  showSpinner('Import 3MF', file.name);
  try{
    const buf = await file.arrayBuffer();
    const u8  = new Uint8Array(buf);

    // ── Extraction ZIP via EOCD → Central Directory (robuste) ──
    async function _zipExtract(name){
      const dv=new DataView(buf);
      // 1. Trouver EOCD (End of Central Directory) depuis la fin
      let eocdOff=-1;
      for(let i=u8.length-22;i>=Math.max(0,u8.length-65557);i--){
        if(dv.getUint32(i,true)===0x06054B50){eocdOff=i;break;}
      }
      if(eocdOff<0) throw new Error('EOCD not found — invalid ZIP');
      const cdOff =dv.getUint32(eocdOff+16,true);
      const cdCnt =dv.getUint16(eocdOff+10,true);
      // 2. Parcourir la Central Directory
      let cdPos=cdOff;
      for(let e=0;e<cdCnt;e++){
        if(dv.getUint32(cdPos,true)!==0x02014B50) break; // sig CD
        const meth  =dv.getUint16(cdPos+10,true);
        const csz   =dv.getUint32(cdPos+20,true);
        const fnl   =dv.getUint16(cdPos+28,true);
        const exl   =dv.getUint16(cdPos+30,true);
        const coml  =dv.getUint16(cdPos+32,true);
        const lhOff =dv.getUint32(cdPos+42,true);
        const fn    =new TextDecoder().decode(u8.slice(cdPos+46,cdPos+46+fnl));
        cdPos+=46+fnl+exl+coml;
        // Match: exact name, path end or case-insensitive
        if(fn===name||fn.endsWith('/'+name)||fn.toLowerCase().endsWith('/'+name.toLowerCase())||fn.toLowerCase()===name.toLowerCase()){
          // 3. Read Local File Header to get actual data offset
          const lhExl=dv.getUint16(lhOff+28,true);
          const lhFnl=dv.getUint16(lhOff+26,true);
          const dataOff=lhOff+30+lhFnl+lhExl;
          const cdata=u8.slice(dataOff,dataOff+csz);
          if(meth===0) return cdata; // stored
          if(meth===8){ // deflate
            const ds=new DecompressionStream('deflate-raw');
            const w=ds.writable.getWriter(); w.write(cdata); w.close();
            const chunks=[]; const r=ds.readable.getReader();
            while(true){const {done,value}=await r.read();if(done)break;chunks.push(value);}
            const total=chunks.reduce((s,c)=>s+c.length,0);
            const out=new Uint8Array(total); let p=0;
            chunks.forEach(c=>{out.set(c,p);p+=c.length;}); return out;
          }
          throw new Error('Unsupported ZIP compression (method='+meth+')');
        }
      }
      return null;
    }

    const modelBytes = await _zipExtract('3dmodel.model');
    if(!modelBytes) throw new Error('3dmodel.model not found in ZIP');
    const xml = new TextDecoder().decode(modelBytes);
    const doc = new DOMParser().parseFromString(xml,'text/xml');

    // ── Helper namespace-agnostic ──
    const _tags=(parent,tag)=>[...parent.getElementsByTagName(tag)];
    const _tag =(parent,tag)=>parent.getElementsByTagName(tag)[0]||null;

    // ── Couleurs ──
    const colorMap3mf={};
    _tags(doc,'colorgroup').forEach(cg=>{
      const cgid=cg.getAttribute('id');
      const cols=[];
      [...cg.children].forEach(c=>{const col=c.getAttribute('color');if(col)cols.push(col.slice(0,7));});
      if(cgid) colorMap3mf[cgid]=cols;
    });

    // ── Map id → element (ressources du fichier racine) ──
    const resMap={};
    _tags(doc,'object').forEach(o=>resMap[o.getAttribute('id')]=o);

    // ── Build items ──
    const buildItems=_tags(doc,'item');
    const targets = buildItems.length
      ? buildItems.map(it=>({oid:it.getAttribute('objectid'),transform:it.getAttribute('transform')}))
      : Object.keys(resMap).map(id=>({oid:id,transform:null}));

    // ── BUG-6 FIX: cache des .model externes référencés via <component p:path="..."/>
    //    (Production extension — 3MF multi-fichiers Bambu Studio / OrcaSlicer /
    //    Creality Print / PrusaSlicer "project". L'objet racine ne contient que
    //    <components>, le mesh réel est dans /3D/Objects/object_N.model) ──
    const PROD_NS='http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
    const _extCache=new Map();
    async function _loadExternalModel(path){
      const clean=path.replace(/^\/+/,'');
      if(_extCache.has(clean)) return _extCache.get(clean);
      const bytes=await _zipExtract(clean);
      if(!bytes){ _extCache.set(clean,null); return null; }
      const xdoc=new DOMParser().parseFromString(new TextDecoder().decode(bytes),'text/xml');
      const xResMap={};
      _tags(xdoc,'object').forEach(o=>xResMap[o.getAttribute('id')]=o);
      const entry={doc:xdoc,resMap:xResMap};
      _extCache.set(clean,entry);
      return entry;
    }

    // ── Applique un transform 3MF (12 nombres, repère natif Z-up 3MF) ──
    function _applyTf(posArr,transformStr){
      if(!transformStr) return posArr;
      const m=transformStr.trim().split(/\s+/).map(Number);
      if(m.length!==12||m.some(v=>!isFinite(v))) return posArr;
      const [m0,m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11]=m;
      if(m0===1&&m1===0&&m2===0&&m3===0&&m4===1&&m5===0&&m6===0&&m7===0&&m8===1&&m9===0&&m10===0&&m11===0) return posArr;
      for(let i=0;i<posArr.length;i+=3){
        const x=posArr[i],y=posArr[i+1],z=posArr[i+2];
        posArr[i]  =m0*x+m3*y+m6*z+m9;
        posArr[i+1]=m1*x+m4*y+m7*z+m10;
        posArr[i+2]=m2*x+m5*y+m8*z+m11;
      }
      return posArr;
    }

    // ── Recursive: résout un <object> — mesh direct, ou <components> (internes
    //    via resMapCtx, ou externes via p:path → _loadExternalModel). Retourne
    //    les positions en repère NATIF 3MF (Z-up) ; le swap Y-up se fait une
    //    seule fois, en sortie de boucle principale, après transform build-item. ──
    async function _resolveGeo(objEl,resMapCtx){
      const meshEl=_tag(objEl,'mesh');
      if(meshEl){
        const vertsEl=_tags(meshEl,'vertex');
        const trisEl =_tags(meshEl,'triangle');
        if(!vertsEl.length||!trisEl.length) return null;
        const posArr=new Float32Array(trisEl.length*9); let vi=0;
        trisEl.forEach(t=>{
          ['v1','v2','v3'].forEach(attr=>{
            const v=vertsEl[+t.getAttribute(attr)];
            posArr[vi++]=+v.getAttribute('x');posArr[vi++]=+v.getAttribute('y');posArr[vi++]=+v.getAttribute('z');
          });
        });
        return posArr;
      }
      // Components — internes (resMapCtx) ou externes (p:path → autre fichier .model)
      const comps=_tags(objEl,'component');
      if(!comps.length) return null;
      const all=[];
      for(const c of comps){
        const path=c.getAttributeNS(PROD_NS,'path')||c.getAttribute('p:path')||c.getAttribute('path');
        let refEl,refMap;
        if(path){
          const ext=await _loadExternalModel(path);
          if(!ext) continue;
          refMap=ext.resMap; refEl=refMap[c.getAttribute('objectid')];
        } else {
          refMap=resMapCtx; refEl=refMap[c.getAttribute('objectid')];
        }
        if(!refEl) continue;
        let p=await _resolveGeo(refEl,refMap);
        if(!p) continue;
        p=_applyTf(p,c.getAttribute('transform'));
        all.push(p);
      }
      if(!all.length) return null;
      const total=all.reduce((s,a)=>s+a.length,0);
      const merged=new Float32Array(total); let off=0;
      all.forEach(a=>{merged.set(a,off);off+=a.length;});
      return merged;
    }

    let imported=0;
    undoPush('import');

    for(const {oid,transform:itemTf} of targets){
      const objEl=resMap[oid]; if(!objEl) continue;
      const t=objEl.getAttribute('type')||'model';
      if(t==='support'||t==='solidsupport') continue; // ignorer supports slicer

      let posArr=await _resolveGeo(objEl,resMap);
      if(!posArr||posArr.length<9) continue;
      posArr=_applyTf(posArr,itemTf); // transform du <item> (repère natif 3MF)
      for(let i=0;i<posArr.length;i+=3){ // Z-up (3MF) → Y-up (Three.js), passe finale unique
        const x=posArr[i],y=posArr[i+1],z=posArr[i+2];
        posArr[i]=x;posArr[i+1]=z;posArr[i+2]=-y;
      }

      const geo=new THREE.BufferGeometry();
      geo.setAttribute('position',new THREE.Float32BufferAttribute(posArr,3));
      geo.computeVertexNormals();
      geo.computeBoundingBox();
      const bb=geo.boundingBox;
      geo.translate(-(bb.min.x+bb.max.x)/2,-bb.min.y,-(bb.min.z+bb.max.z)/2);
      // Recenter on real center of gravity
      const _3mfCG=computeCenterOfGravity(geo);
      geo.translate(-_3mfCG.x,-_3mfCG.y,-_3mfCG.z);

      // Color
      let hexCol=COL[objCnt%COL.length];
      const pid=objEl.getAttribute('pid'), pi=+(objEl.getAttribute('pindex')||0);
      if(pid&&colorMap3mf[pid]&&colorMap3mf[pid][pi]) hexCol=colorMap3mf[pid][pi];

      objCnt++;
      const mat=new THREE.MeshPhongMaterial({color:hexCol,shininess: 8, specular: 0x1a1a1a,side:THREE.DoubleSide});
      const meshObj=new THREE.Mesh(geo,mat);meshObj.castShadow=true;meshObj.receiveShadow=false;scene.add(meshObj);
      meshObj.updateMatrixWorld(true);
      const _3mf_pos=_findFreePos(meshObj, PS+2);
      meshObj.position.set(_3mfCG.x+_3mf_pos.x, _3mfCG.y, _3mfCG.z+_3mf_pos.z);
      const name=(objEl.getAttribute('name')||file.name.replace(/\.[^.]+$/,''))+'_'+objCnt;
      const o={id:objCnt,name,type:'csg',mesh:meshObj,color:hexCol,isHole:false};
      objs.push(o); selObjs=[o];
      imported++;
    }

    updProps();updOList();updStats();
    hideSpinner();
    nasLog('OK',`Import 3MF — ${imported} object(s) from ${file.name}`);
    _csgLog(`✓ 3MF imported: ${imported} object(s)`);
  }catch(err){
    hideSpinner();
    nasLog('ERROR','Import 3MF: '+err.message);
    _nasAlert('⚠ Import 3MF: '+err.message);
  }
}

// ═══════════════════════════════ GLB ════════════════════════════════════
// ── io-glb-export.js ──────────────────────────────────────────────────────
// ── Export GLB (Binary GLTF 2.0) ────────────────────────────────────────────
// Spec : https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
// Y-up natif GLTF (pas de conversion axe) — compatible Sketchfab, Blender, Three.js
// ═══════════════════════════════════════════════════════════════════════════
// [NEW V4.6.0] Export GLB compressé Draco — symétrique de l'import (V4.5.9).
// Même moteur (nasscad-draco.js, Apache 2.0), même compagnon optionnel :
// absent = message clair, pas de crash. Mirroring du DRACOExporter officiel
// Three.js — corrigé sur un point vérifié empiriquement : DracoEncoderModule()
// renvoie une VRAIE Promise (comme le décodeur), la référence Three.js NE
// l'attend PAS (bug constaté par test direct) ; ici elle est proprement awaited.
// ═══════════════════════════════════════════════════════════════════════════
function _decodeDracoEncWasmB64(){
  if(typeof window._DRACO_ENC_WASM_B64 !== 'string' || !window._DRACO_ENC_WASM_B64.length) return null;
  const bin = atob(window._DRACO_ENC_WASM_B64);
  const bytes = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function _preloadDracoEncWasm(){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'draco_encoder.wasm', true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      if((xhr.status === 200 || xhr.status === 0) && xhr.response && xhr.response.byteLength)
        resolve(new Uint8Array(xhr.response));
      else reject(new Error(`XHR draco_encoder.wasm: HTTP ${xhr.status} or empty response`));
    };
    xhr.onerror = () => reject(new Error('XHR draco_encoder.wasm failed (network/CORS/file://)'));
    xhr.send();
  });
}
let _dracoEncInst = null;
async function _getDracoEncoder(){
  if(!_dracoEncInst){
    if(typeof DracoEncoderModule==='undefined')
      throw new Error("Companion missing — place nasscad-draco.js next to NASSCAD to export Draco-compressed GLB files.");
    if(!window._DRACO_ENC_WASM){
      const _b64Bytes = _decodeDracoEncWasmB64();
      if(_b64Bytes){
        window._DRACO_ENC_WASM = _b64Bytes;
        nasLog('DBG', `Draco encoder WASM loaded from inline base64 (${(_b64Bytes.length/1024/1024).toFixed(1)} MB)`);
      } else {
        try { window._DRACO_ENC_WASM = await _preloadDracoEncWasm(); }
        catch(e){ nasLog('WARN', `XHR preload draco_encoder.wasm failed (${e.message}) — fallback to internal fetch()`); }
      }
    }
    _dracoEncInst = await DracoEncoderModule(window._DRACO_ENC_WASM ? { wasmBinary: window._DRACO_ENC_WASM } : {});
  }
  return _dracoEncInst;
}

// Encode POSITION(+NORMAL) d'un mesh en un blob Draco compressé, prêt à être
// écrit dans un bufferView GLB. Retourne aussi les unique IDs Draco par
// attribut — glTF exige un mapping EXPLICITE (contrairement à un .drc
// autonome, qui peut se contenter d'un mapping 1:1 par type sémantique).
async function _encodeDracoMesh(pos, nor, vc){
  const dracoEnc = await _getDracoEncoder();
  const builder = new dracoEnc.MeshBuilder();
  const meshObj = new dracoEnc.Mesh();
  try{
    const idPos = builder.AddFloatAttributeToMesh(meshObj, dracoEnc.POSITION, vc, 3, pos);
    let idNor = null;
    if(nor) idNor = builder.AddFloatAttributeToMesh(meshObj, dracoEnc.NORMAL, vc, 3, nor);

    // Pas d'indices partagés dans le pipeline expGLB actuel (toNonIndexed()
    // déjà appliqué en amont) — faces séquentielles, comme le fait la
    // référence Three.js elle-même quand geometry.getIndex() est null.
    const faces = new (vc > 65535 ? Uint32Array : Uint16Array)(vc);
    for(let i=0;i<vc;i++) faces[i] = i;
    builder.AddFacesToMesh(meshObj, vc/3, faces);

    const encoder = new dracoEnc.Encoder();
    encoder.SetSpeedOptions(5, 5); // équilibré, cohérent avec le défaut Three.js
    encoder.SetEncodingMethod(dracoEnc.MESH_EDGEBREAKER_ENCODING);
    encoder.SetAttributeQuantization(dracoEnc.POSITION, 14); // 14 bits ≈ précision sub-µm sur pièce 100mm
    if(nor) encoder.SetAttributeQuantization(dracoEnc.NORMAL, 10);

    const encodedData = new dracoEnc.DracoInt8Array();
    const length = encoder.EncodeMeshToDracoBuffer(meshObj, encodedData);
    if(length === 0) throw new Error('Draco encoding failed (EncodeMeshToDracoBuffer returned 0)');

    const bytes = new Uint8Array(length);
    for(let i=0;i<length;i++) bytes[i] = encodedData.GetValue(i);

    dracoEnc.destroy(encodedData);
    dracoEnc.destroy(encoder);

    const attributes = { POSITION: idPos };
    if(idNor !== null) attributes.NORMAL = idNor;
    return { bytes, attributes };
  } finally {
    dracoEnc.destroy(meshObj);
    dracoEnc.destroy(builder);
  }
}

async function expGLB(useDraco){
  let _fh=null;
  if(typeof showSaveFilePicker==='function' && !(window.electronAPI&&window.electronAPI.isElectron)){
    try{
      _fh=await showSaveFilePicker({suggestedName:'model.glb',types:[{description:'GLB File',accept:{'model/gltf-binary':['.glb']}}]});
    }catch(e){
      if(e.name==='AbortError') return;
      nasLog('WARN','showSaveFilePicker: '+e.message+' — fallback navigateur');
    }
  }
  showSpinner('Export GLB', useDraco ? 'Compressing (Draco)…' : 'Preparing…');
  await new Promise(r => requestAnimationFrame(r));
  try{
  scene.updateMatrixWorld(true);
  const enc = new TextEncoder();

  // ── Collecter géométries HD (inchangé) ───────────────────────────────────
  const geoList = [];
  objs.forEach(so => {
    const _g = makeGeoHD(so);
    if(_ioCanRebuild(so)){
      const _p=new THREE.Vector3(),_q=new THREE.Quaternion(),_s=new THREE.Vector3();
      so.mesh.matrixWorld.decompose(_p,_q,_s);
      const mPR=new THREE.Matrix4().makeRotationFromQuaternion(_q); mPR.setPosition(_p);
      _g.applyMatrix4(mPR);
    } else { _g.applyMatrix4(so.mesh.matrixWorld); }
    const gi = _g.index ? _g.toNonIndexed() : _g;
    if(gi !== _g) _g.dispose();
    if(!gi.attributes.normal) gi.computeVertexNormals();
    const pos = new Float32Array(gi.attributes.position.array);
    const nor = new Float32Array(gi.attributes.normal.array);
    geoList.push({name:so.name, pos, nor, vc:pos.length/3});
    gi.dispose();
  });

  // [NEW V4.6.0] Branche Draco : encode chaque mesh AVANT de construire le
  // buffer binaire final (asynchrone — un seul point d'await, en amont de
  // toute la logique JSON qui reste synchrone et inchangée dans sa forme).
  let dracoResults = null;
  if(useDraco){
    dracoResults = [];
    for(const m of geoList){
      const r = await _encodeDracoMesh(m.pos, m.nor, m.vc);
      dracoResults.push(r);
    }
  }

  // ── Buffer binaire ────────────────────────────────────────────────────────
  // Non-Draco : [pos0][nor0][pos1][nor1]... (inchangé).
  // Draco      : [compressed0][compressed1]... (un seul blob par mesh).
  const offsets = [];
  let binLen = 0;
  if(useDraco){
    geoList.forEach((m,i) => {
      offsets.push({dracoOff:binLen, dracoLen:dracoResults[i].bytes.length});
      binLen += dracoResults[i].bytes.length;
      // Alignement 4 octets entre blobs successifs (bufferViews indépendantes)
      const pad = (4-(binLen%4))%4; binLen += pad;
    });
  } else {
    geoList.forEach(m => {
      offsets.push({posOff:binLen, norOff:binLen + m.pos.byteLength});
      binLen += m.pos.byteLength + m.nor.byteLength;
    });
  }
  const binPad = (4 - (binLen % 4)) % 4;
  const binBuf = new Uint8Array(binLen + binPad);
  if(useDraco){
    let cursor = 0;
    geoList.forEach((m,i) => {
      binBuf.set(dracoResults[i].bytes, cursor);
      cursor += dracoResults[i].bytes.length;
      cursor += (4-(cursor%4))%4;
    });
  } else {
    geoList.forEach((m,i) => {
      binBuf.set(new Uint8Array(m.pos.buffer), offsets[i].posOff);
      binBuf.set(new Uint8Array(m.nor.buffer), offsets[i].norOff);
    });
  }

  // ── JSON GLTF ────────────────────────────────────────────────────────────
  const bufferViews=[], accessors=[], meshes=[], nodes=[];
  let bvIdx=0, accIdx=0;
  geoList.forEach((m,i) => {
    let mnX=Infinity,mnY=Infinity,mnZ=Infinity,mxX=-Infinity,mxY=-Infinity,mxZ=-Infinity;
    for(let j=0;j<m.vc;j++){
      const x=m.pos[j*3],y=m.pos[j*3+1],z=m.pos[j*3+2];
      if(x<mnX)mnX=x; if(y<mnY)mnY=y; if(z<mnZ)mnZ=z;
      if(x>mxX)mxX=x; if(y>mxY)mxY=y; if(z>mxZ)mxZ=z;
    }
    if(useDraco){
      const d = dracoResults[i];
      // [NEW V4.6.0] Accessors SANS bufferView — métadonnées seules (count,
      // min/max pour POSITION), exactement le contrat que notre PROPRE
      // décodeur (V4.5.9) lit déjà correctement sur les vrais fichiers NASA.
      accessors.push({componentType:5126,count:m.vc,type:"VEC3",min:[mnX,mnY,mnZ],max:[mxX,mxY,mxZ]});
      accessors.push({componentType:5126,count:m.vc,type:"VEC3"});
      bufferViews.push({buffer:0,byteOffset:offsets[i].dracoOff,byteLength:offsets[i].dracoLen});
      const primAttrs = {POSITION:accIdx,NORMAL:accIdx+1};
      const dracoAttrs = {POSITION:d.attributes.POSITION};
      if(d.attributes.NORMAL !== undefined) dracoAttrs.NORMAL = d.attributes.NORMAL;
      meshes.push({name:m.name,primitives:[{attributes:primAttrs,mode:4,
        extensions:{KHR_draco_mesh_compression:{bufferView:bvIdx,attributes:dracoAttrs}}}]});
      bvIdx+=1; accIdx+=2;
    } else {
      bufferViews.push({buffer:0,byteOffset:offsets[i].posOff,byteLength:m.pos.byteLength,target:34962});
      bufferViews.push({buffer:0,byteOffset:offsets[i].norOff,byteLength:m.nor.byteLength,target:34962});
      accessors.push({bufferView:bvIdx,  byteOffset:0,componentType:5126,count:m.vc,type:"VEC3",min:[mnX,mnY,mnZ],max:[mxX,mxY,mxZ]});
      accessors.push({bufferView:bvIdx+1,byteOffset:0,componentType:5126,count:m.vc,type:"VEC3"});
      meshes.push({name:m.name,primitives:[{attributes:{POSITION:accIdx,NORMAL:accIdx+1},mode:4}]});
      bvIdx+=2; accIdx+=2;
    }
    nodes.push({mesh:i,name:m.name});
  });
  const gltf={
    asset:{version:"2.0",generator:"NASSCAD V"+NASSCAD_VERSION},
    scene:0,
    scenes:[{name:"Scene",nodes:nodes.map((_,i)=>i)}],
    nodes, meshes, accessors, bufferViews,
    buffers:[{byteLength:binBuf.length}]
  };
  if(useDraco){
    gltf.extensionsUsed = ['KHR_draco_mesh_compression'];
    gltf.extensionsRequired = ['KHR_draco_mesh_compression'];
  }

  // ── Assemblage GLB (inchangé) ────────────────────────────────────────────
  const jsonBytes = enc.encode(JSON.stringify(gltf));
  const jsonPad = (4-(jsonBytes.length%4))%4;
  const jBuf = new Uint8Array(jsonBytes.length+jsonPad);
  jBuf.set(jsonBytes);
  for(let i=jsonBytes.length;i<jBuf.length;i++) jBuf[i]=0x20;

  const totalLen = 12 + 8+jBuf.length + 8+binBuf.length;
  const glb = new Uint8Array(totalLen);
  const dv  = new DataView(glb.buffer);
  let off=0;
  glb.set([0x67,0x6C,0x54,0x46],0); dv.setUint32(4,2,true); dv.setUint32(8,totalLen,true); off=12;
  dv.setUint32(off,jBuf.length,true); off+=4; dv.setUint32(off,0x4E4F534A,true); off+=4;
  glb.set(jBuf,off); off+=jBuf.length;
  dv.setUint32(off,binBuf.length,true); off+=4; dv.setUint32(off,0x004E4942,true); off+=4;
  glb.set(binBuf,off);

  _nasSaveWithHandle('model.glb', new Blob([glb],{type:'model/gltf-binary'}), 'model/gltf-binary', _fh);
  nasLog('OK',`Export GLB${useDraco?' (Draco)':''} — ${objs.length} object(s) — ${(totalLen/1024).toFixed(1)} KB`);
  } finally {
    hideSpinner();
  }
}

// ── io-glb-import.js ──────────────────────────────────────────────────────
// ── Import GLB (Binary GLTF 2.0) ─────────────────────────────────────────────
// Y-up natif GLTF — pas de conversion d'axe (contrairement à STL/OBJ Z-up)
// ═══════════════════════════════════════════════════════════════════════════
// [NEW V4.5.9] Support KHR_draco_mesh_compression — décodeur officiel Google
// (nasscad-draco.js, Apache 2.0), même famille de moteur WASM que
// occt-import-js/Manifold déjà embarqués. Companion OPT-IN comme les autres :
// absent = message clair, pas de crash ; présent = décodage réel.
// Séquence d'appels calquée sur THREE.DRACOLoader officiel (r128, celui déjà
// utilisé par NASSCAD) — Init(buffer) → DecodeBufferToMesh → GetAttributeByUniqueId
// (glTF fournit toujours des unique IDs, jamais un mapping 1:1 par nom) →
// GetAttributeDataArrayForAllPoints / GetTrianglesUInt32Array.
// ═══════════════════════════════════════════════════════════════════════════
function _decodeDracoWasmB64(){
  if(typeof window._DRACO_WASM_B64 !== 'string' || !window._DRACO_WASM_B64.length) return null;
  const bin = atob(window._DRACO_WASM_B64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for(let i=0;i<len;i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function _preloadDracoWasm(){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'draco_decoder_gltf.wasm', true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      if((xhr.status === 200 || xhr.status === 0) && xhr.response && xhr.response.byteLength)
        resolve(new Uint8Array(xhr.response));
      else
        reject(new Error(`XHR draco_decoder_gltf.wasm: HTTP ${xhr.status} or empty response`));
    };
    xhr.onerror = () => reject(new Error('XHR draco_decoder_gltf.wasm failed (network/CORS/file://)'));
    xhr.send();
  });
}
let _dracoInst = null;
async function _getDraco(){
  if(!_dracoInst){
    if(typeof DracoDecoderModule==='undefined')
      throw new Error("Companion missing — place nasscad-draco.js next to NASSCAD to read Draco-compressed GLB files (KHR_draco_mesh_compression).");
    if(!window._DRACO_WASM){
      const _b64Bytes = _decodeDracoWasmB64();
      if(_b64Bytes){
        window._DRACO_WASM = _b64Bytes;
        nasLog('DBG', `Draco WASM loaded from inline base64 (${(_b64Bytes.length/1024/1024).toFixed(1)} MB)`);
      } else {
        try { window._DRACO_WASM = await _preloadDracoWasm(); }
        catch(e){
          nasLog('WARN', `XHR preload draco_decoder_gltf.wasm failed (${e.message}) — fallback to internal fetch()`);
        }
      }
    }
    _dracoInst = await DracoDecoderModule(window._DRACO_WASM ? { wasmBinary: window._DRACO_WASM } : {});
  }
  return _dracoInst;
}

// Parse UNE primitive GLTF standard (non-Draco) → THREE.BufferGeometry.
// Gère toutes les combinaisons de componentType (FLOAT, UNSIGNED_SHORT,
// UNSIGNED_INT…), byteStride (interleaved buffers), et accessors épars.
// Même contrat de sortie que _decodeDracoPrimitive.
function _parseGLTFPrimitive(gltf, prim, binBuf){
  if(!binBuf) return null;
  // composantes par type glTF
  const _nc = {SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};
  // taille en bytes par componentType
  const _cs = {5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};

  // Lit un accessor, retourne toujours Float32Array (norme interne THREE)
  function readFloat(accIdx){
    const acc = gltf.accessors[accIdx];
    const bv  = gltf.bufferViews[acc.bufferView];
    const nc  = _nc[acc.type] || 1;
    const csz = _cs[acc.componentType] || 4;
    const cnt = acc.count;
    const base = (bv.byteOffset||0) + (acc.byteOffset||0);
    const stride = bv.byteStride || nc*csz;
    const dv = new DataView(binBuf);
    const out = new Float32Array(cnt*nc);
    const rd = {
      5120:o=>dv.getInt8(o),    5121:o=>dv.getUint8(o),
      5122:o=>dv.getInt16(o,true), 5123:o=>dv.getUint16(o,true),
      5125:o=>dv.getUint32(o,true), 5126:o=>dv.getFloat32(o,true)
    }[acc.componentType] || (o=>dv.getFloat32(o,true));
    for(let i=0;i<cnt;i++) for(let c=0;c<nc;c++) out[i*nc+c]=rd(base+i*stride+c*csz);
    return {arr:out, nc};
  }

  // Lit un accessor d'indices → Uint32Array
  function readIndex(accIdx){
    const acc = gltf.accessors[accIdx];
    const bv  = gltf.bufferViews[acc.bufferView];
    const cnt = acc.count;
    const csz = _cs[acc.componentType] || 4;
    const base = (bv.byteOffset||0) + (acc.byteOffset||0);
    const stride = bv.byteStride || csz;
    const dv = new DataView(binBuf);
    const out = new Uint32Array(cnt);
    const rd = {
      5121:o=>dv.getUint8(o), 5123:o=>dv.getUint16(o,true), 5125:o=>dv.getUint32(o,true)
    }[acc.componentType] || (o=>dv.getUint32(o,true));
    for(let i=0;i<cnt;i++) out[i]=rd(base+i*stride);
    return out;
  }

  if(prim.attributes.POSITION===undefined) return null;
  const geo = new THREE.BufferGeometry();

  const pos = readFloat(prim.attributes.POSITION);
  geo.setAttribute('position', new THREE.BufferAttribute(pos.arr, pos.nc));

  if(prim.attributes.NORMAL!==undefined){
    const nor = readFloat(prim.attributes.NORMAL);
    geo.setAttribute('normal', new THREE.BufferAttribute(nor.arr, nor.nc));
  }
  if(prim.attributes.TEXCOORD_0!==undefined){
    const uv = readFloat(prim.attributes.TEXCOORD_0);
    geo.setAttribute('uv', new THREE.BufferAttribute(uv.arr, uv.nc));
  }
  if(prim.indices!==undefined){
    geo.setIndex(new THREE.BufferAttribute(readIndex(prim.indices), 1));
  }
  return geo;
}

// Décode UNE primitive Draco-compressée → THREE.BufferGeometry — MÊME contrat
// de sortie que _parseGLTFPrimitive : le reste d'importGLB (transforms de
// hiérarchie, recentrage 2-passes, pivot de groupe) ne change pas d'une ligne,
// peu importe lequel des deux décodeurs a produit la géométrie.
async function _decodeDracoPrimitive(gltf, prim, binBuf){
  const draco = await _getDraco();
  const ext = prim.extensions.KHR_draco_mesh_compression;
  const bv = gltf.bufferViews[ext.bufferView];
  const off = bv.byteOffset || 0;
  const compressedBytes = new Int8Array(binBuf, off, bv.byteLength);

  const decoder = new draco.Decoder();
  const decoderBuffer = new draco.DecoderBuffer();
  decoderBuffer.Init(compressedBytes, compressedBytes.length);

  try{
    const geometryType = decoder.GetEncodedGeometryType(decoderBuffer);
    if(geometryType !== draco.TRIANGULAR_MESH)
      throw new Error('Draco: geometrie non-triangulaire non supportee (point cloud ?)');
    const dracoGeom = new draco.Mesh();
    const status = decoder.DecodeBufferToMesh(decoderBuffer, dracoGeom);
    if(!status.ok() || dracoGeom.ptr === 0)
      throw new Error('Draco decode failed: ' + status.error_msg());

    const geo = new THREE.BufferGeometry();
    const attrMap = { POSITION:['position',3], NORMAL:['normal',3] };
    for(const gltfName in ext.attributes){
      const map = attrMap[gltfName]; if(!map) continue;
      const [threeName, numComp] = map;
      const uniqueId = ext.attributes[gltfName];
      const attribute = decoder.GetAttributeByUniqueId(dracoGeom, uniqueId);
      const numPoints = dracoGeom.num_points();
      const numValues = numPoints * numComp;
      const byteLength = numValues * 4; // Float32
      const ptr = draco._malloc(byteLength);
      try{
        decoder.GetAttributeDataArrayForAllPoints(dracoGeom, attribute, draco.DT_FLOAT32, byteLength, ptr);
        const arr = new Float32Array(draco.HEAPF32.buffer, ptr, numValues).slice();
        geo.setAttribute(threeName, new THREE.BufferAttribute(arr, numComp));
      } finally { draco._free(ptr); }
    }
    const numFaces = dracoGeom.num_faces();
    const numIndices = numFaces * 3;
    const idxByteLength = numIndices * 4;
    const idxPtr = draco._malloc(idxByteLength);
    try{
      decoder.GetTrianglesUInt32Array(dracoGeom, idxByteLength, idxPtr);
      const idx = new Uint32Array(draco.HEAPF32.buffer, idxPtr, numIndices).slice();
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
    } finally { draco._free(idxPtr); }

    draco.destroy(dracoGeom);
    return geo;
  } finally {
    draco.destroy(decoderBuffer);
    draco.destroy(decoder);
  }
}

async function importGLB(file){
  showSpinner('Import GLB',file.name);
  try{
    const buf=await file.arrayBuffer(); const dv=new DataView(buf);
    if(dv.getUint32(0,true)!==0x46546C67) throw new Error('Not a valid GLB (wrong magic)');
    const jsonLen=dv.getUint32(12,true);
    if(dv.getUint32(16,true)!==0x4E4F534A) throw new Error('Expected JSON chunk');
    const gltf=JSON.parse(new TextDecoder().decode(new Uint8Array(buf,20,jsonLen)));
    let binBuf=null;
    const binOff=20+jsonLen;
    if(binOff+8<=buf.byteLength&&dv.getUint32(binOff+4,true)===0x004E4942)
      binBuf=buf.slice(binOff+8, binOff+8+dv.getUint32(binOff,true));

    // Composition de la hiérarchie de nœuds glTF (V4.5.6) — inchangé.
    const worldMatrices = new Map();
    function localMatrixOf(node){
      const m = new THREE.Matrix4();
      if(node.matrix){ m.fromArray(node.matrix); return m; }
      const t = node.translation ? new THREE.Vector3(node.translation[0],node.translation[1],node.translation[2]) : new THREE.Vector3(0,0,0);
      const r = node.rotation    ? new THREE.Quaternion(node.rotation[0],node.rotation[1],node.rotation[2],node.rotation[3]) : new THREE.Quaternion(0,0,0,1);
      const s = node.scale       ? new THREE.Vector3(node.scale[0],node.scale[1],node.scale[2]) : new THREE.Vector3(1,1,1);
      return m.compose(t, r, s);
    }
    function walkNode(nodeIdx, parentWorld){
      const node = gltf.nodes[nodeIdx];
      const world = parentWorld.clone().multiply(localMatrixOf(node));
      worldMatrices.set(nodeIdx, world);
      (node.children||[]).forEach(c => walkNode(c, world));
    }
    const sceneIdx = gltf.scene || 0;
    const roots = (gltf.scenes && gltf.scenes[sceneIdx] && gltf.scenes[sceneIdx].nodes) || [];
    roots.forEach(r => walkNode(r, new THREE.Matrix4()));

    // [NEW V4.5.9] Dispatch PAR PRIMITIVE : Draco (KHR_draco_mesh_compression)
    // si présent sur cette primitive précise, sinon le parseur direct existant.
    // Un même fichier peut mélanger les deux (rare mais légal) — décidé au cas
    // par cas, jamais au niveau du fichier entier.
    const geos=[];
    for(let ni=0; ni<gltf.nodes.length; ni++){
      const node = gltf.nodes[ni];
      if(node.mesh === undefined || node.mesh === null) continue;
      const mesh = gltf.meshes[node.mesh];
      const world = worldMatrices.get(ni) || new THREE.Matrix4();
      for(const prim of (mesh.primitives||[])){
        const isDraco = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
        let geo;
        if(isDraco){
          geo = await _decodeDracoPrimitive(gltf, prim, binBuf);
        } else {
          geo = _parseGLTFPrimitive(gltf, prim, binBuf);
        }
        if(geo){
          geo.applyMatrix4(world);
          geos.push({geo, name: node.name||mesh.name||('mesh_'+node.mesh)});
        }
      }
    }
    if(!geos.length) throw new Error('No geometry found');

    // Recentrage 2-passes (V4.5.6/7) — inchangé.
    undoPush('import GLB');
    let gMinX=Infinity,gMinY=Infinity,gMinZ=Infinity,gMaxX=-Infinity,gMaxY=-Infinity,gMaxZ=-Infinity;
    geos.forEach(({geo})=>{
      if(!geo.attributes.normal) geo.computeVertexNormals();
      geo.computeBoundingBox();
      const bb=geo.boundingBox;
      gMinX=Math.min(gMinX,bb.min.x); gMinY=Math.min(gMinY,bb.min.y); gMinZ=Math.min(gMinZ,bb.min.z);
      gMaxX=Math.max(gMaxX,bb.max.x); gMaxY=Math.max(gMaxY,bb.max.y); gMaxZ=Math.max(gMaxZ,bb.max.z);
    });
    const ox=-(gMinX+gMaxX)/2, oy=-gMinY, oz=-(gMinZ+gMaxZ)/2;
    const groupObjs = [];
    geos.forEach(({geo,name})=>{
      geo.translate(ox,oy,oz);
      objCnt++;
      const col=COL[objCnt%COL.length];
      const mat=new THREE.MeshPhongMaterial({color:col,shininess:8,specular:0x1a1a1a,side:THREE.DoubleSide});
      const mesh=new THREE.Mesh(geo,mat); mesh.castShadow=true; scene.add(mesh);
      mesh.updateMatrixWorld(true);
      const oname=name.replace(/[^a-zA-Z0-9_]/g,'_')+'_'+objCnt;
      const obj={id:objCnt,name:oname,type:'csg',mesh,color:col,isHole:false};
      objs.push(obj); groupObjs.push(obj);
    });
    if(groupObjs.length){
      const totalW=gMaxX-gMinX, totalD=gMaxZ-gMinZ;
      const fp=_findFreePos(groupObjs[0].mesh, Math.max(totalW,totalD)+2);
      groupObjs.forEach(o => o.mesh.position.set(o.mesh.position.x+fp.x, 0, o.mesh.position.z+fp.z));
    }
    selObjs=groupObjs.slice(-1);
    nasLog('OK','Import GLB: '+groupObjs.length+' part(s), assembly preserved ('+file.name+')');
    updProps();updOList();updStats();hideSpinner();
  }catch(err){
    hideSpinner();
    nasLog('ERROR','Import GLB: '+err.message);
    _nasAlert('⚠ Import GLB failed:\n'+err.message);
  }
}

// ═══════════════════════════════ OBJ ════════════════════════════════════
// ── io-obj-export.js ──────────────────────────────────────────────────────
// ⚠ PARTICULARITÉ (héritée) : expOBJ() n'avait PAS de bannière ══ dans
// l'original — il suivait directement expSTLascii() sans séparation
// visuelle. Frontière conservée par fidélité, plus significative ici
// puisque tout est déjà regroupé dans ce même fichier.
async function expOBJ(){
  let _fh=null;
  if(typeof showSaveFilePicker==='function' && !(window.electronAPI&&window.electronAPI.isElectron)){
    try{
      _fh=await showSaveFilePicker({suggestedName:'model.obj',types:[{description:'OBJ File',accept:{'model/obj':['.obj']}}]});
    }catch(e){
      if(e.name==='AbortError') return;
      nasLog('WARN','showSaveFilePicker: '+e.message+' — fallback navigateur');
    }
  }
  showSpinner('Export OBJ','Preparing…');
  requestAnimationFrame(()=>{
  // Same axis conversion as STL: Three.js Y-up → Z-up (Blender/Cura)
  const cv=(x,y,z)=>({x:x,y:-z,z:y});
  const faceNormal=(pa,pb,pc)=>{
    const ax=pb.x-pa.x,ay=pb.y-pa.y,az=pb.z-pa.z;
    const bx=pc.x-pa.x,by=pc.y-pa.y,bz=pc.z-pa.z;
    const nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx;
    const l=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
    return {x:nx/l,y:ny/l,z:nz/l};
  };
  // [PERF V4.7.1] vLines/vnLines/fLines were built via += string concatenation across
  // the ENTIRE scene in one synchronous pass — on a large assembly this reallocates
  // and copies an ever-growing string on every single line, which can visibly freeze
  // the tab for seconds. Arrays + join('') at the end is the same output, O(n) instead
  // of O(n²). (io-stl-export.js's binary path already avoided this; this brings OBJ
  // export in line with it.)
  const vLines=[],vnLines=[],fLines=[]; let vo=0,no=0; // vo=vertex offset, no=normal offset
  scene.updateMatrixWorld(true);
  objs.forEach(so=>{
    const _gHD = makeGeoHD(so);
    if(_ioCanRebuild(so)){
      const _p=new THREE.Vector3(),_q=new THREE.Quaternion(),_s=new THREE.Vector3();
      so.mesh.matrixWorld.decompose(_p,_q,_s);
      const mPR=new THREE.Matrix4().makeRotationFromQuaternion(_q);mPR.setPosition(_p);
      _gHD.applyMatrix4(mPR);
    } else { _gHD.applyMatrix4(so.mesh.matrixWorld); }
    const g=_gHD;
    const p=g.attributes.position,ix=g.index;
    fLines.push('\no '+so.name+'\n');
    // Vertices convertis
    for(let i=0;i<p.count;i++){
      const v=cv(p.getX(i),p.getY(i),p.getZ(i));
      vLines.push('v '+v.x.toFixed(6)+' '+v.y.toFixed(6)+' '+v.z.toFixed(6)+'\n');
    }
    // Faces + normals computed per triangle (1 normal per face)
    const triCount=ix ? ix.count/3 : p.count/3;
    for(let i=0;i<triCount;i++){
      const ai=ix?ix.getX(i*3):i*3, bi=ix?ix.getX(i*3+1):i*3+1, ci=ix?ix.getX(i*3+2):i*3+2;
      const pa=cv(p.getX(ai),p.getY(ai),p.getZ(ai));
      const pb=cv(p.getX(bi),p.getY(bi),p.getZ(bi));
      const pc=cv(p.getX(ci),p.getY(ci),p.getZ(ci));
      const n=faceNormal(pa,pb,pc);
      const ni=no+i+1; // FIX: base on normal counter, not vertex counter
      vnLines.push('vn '+n.x.toFixed(6)+' '+n.y.toFixed(6)+' '+n.z.toFixed(6)+'\n');
      const a=ai+1+vo,b=bi+1+vo,c=ci+1+vo;
      fLines.push('f '+a+'//'+ni+' '+b+'//'+ni+' '+c+'//'+ni+'\n');
    }
    vo+=p.count;
    no+=triCount; // FIX: advance normal offset by triangle count
    g.dispose();
  });
  const o='# NASSCAD V'+NASSCAD_VERSION+'\n# Axis: Z-up (compatible Cura/Blender/FreeCAD)\n'+vLines.join('')+vnLines.join('')+fLines.join('');
  _nasSaveWithHandle('model.obj', new Blob([o],{type:'model/obj'}), 'model/obj', _fh);
  hideSpinner();
  }); // end rAF
}

// ── io-obj-import.js ──────────────────────────────────────────────────────
// Parser bas niveau (parseOBJ) — ne fait QUE parser (texte → THREE.BufferGeometry).
// L'insertion en scène est gérée par le dispatcher importMesh() resté dans le host.
async function parseOBJ(txt, opts){
  const onP = (opts && opts.onProgress) || null;
  let _lastY = performance.now();
  const verts=[],faces=[];
  const lines=txt.split('\n');
  // Pondération progression : ~70% du temps dans le scan des lignes, ~30% dans le dépliage
  for(let li=0;li<lines.length;li++){
    const p=lines[li].trim().split(/\s+/);
    if(p[0]==='v'){verts.push(+p[1],+p[2],+p[3]);}
    else if(p[0]==='f'){const idx=p.slice(1).map(s=>parseInt(s.split('/')[0])-1);for(let i=1;i<idx.length-1;i++)faces.push(idx[0],idx[i],idx[i+1]);}
    if((li & 0x3FFF)===0 && performance.now()-_lastY>40){ _lastY=performance.now(); if(onP)onP(0.7*li/lines.length); await _breathe(); }
  }
  const pos=new Float32Array(faces.length*3);
  for(let i=0;i<faces.length;i++){
    pos[i*3]=verts[faces[i]*3];pos[i*3+1]=verts[faces[i]*3+1];pos[i*3+2]=verts[faces[i]*3+2];
    if((i & 0xFFFF)===0 && performance.now()-_lastY>40){ _lastY=performance.now(); if(onP)onP(0.7+0.3*i/faces.length); await _breathe(); }
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  if(!(opts && opts.skipNormals)) geo.computeVertexNormals();
  return geo;
}

// ═══════════════════════════════ PLY ════════════════════════════════════
// ── io-ply-export.js ──────────────────────────────────────────────────────
// ── Export PLY ASCII (Stanford Polygon File Format) ─────────────────────────
// Supporte vertex normals — compatible MeshLab, CloudCompare, Blender
// Axe Z-up (cohérent avec STL/OBJ)
async function expPLY(){
  let _fh=null;
  if(typeof showSaveFilePicker==='function' && !(window.electronAPI&&window.electronAPI.isElectron)){
    try{
      _fh=await showSaveFilePicker({suggestedName:'model.ply',types:[{description:'PLY File',accept:{'application/octet-stream':['.ply']}}]});
    }catch(e){
      if(e.name==='AbortError') return;
      nasLog('WARN','showSaveFilePicker: '+e.message+' — fallback navigateur');
    }
  }
  showSpinner('Export PLY','Preparing…');
  requestAnimationFrame(()=>{
  const cv=(x,y,z)=>({x,y:-z,z:y}); // Three Y-up → Z-up
  scene.updateMatrixWorld(true);

  let totalVerts=0, totalFaces=0;
  const vParts=[], fParts=[];

  objs.forEach(so => {
    const _g = makeGeoHD(so);
    if(_ioCanRebuild(so)){
      const _p=new THREE.Vector3(),_q=new THREE.Quaternion(),_s=new THREE.Vector3();
      so.mesh.matrixWorld.decompose(_p,_q,_s);
      const mPR=new THREE.Matrix4().makeRotationFromQuaternion(_q); mPR.setPosition(_p);
      _g.applyMatrix4(mPR);
    } else { _g.applyMatrix4(so.mesh.matrixWorld); }
    const gi = _g.index ? _g.toNonIndexed() : _g;
    if(gi !== _g) _g.dispose();
    if(!gi.attributes.normal) gi.computeVertexNormals();
    const p=gi.attributes.position, n=gi.attributes.normal;
    const vc=p.count, fc=vc/3;
    // [PERF V4.7.1] Même remède qu'io-obj-export.js : += en boucle sur vStr/fStr
    // réalloue et recopie une chaîne grandissante à CHAQUE ligne. Ici la boucle
    // est déjà bornée par objet (pas par scène entière comme OBJ l'était), donc
    // sévérité moindre sur une scène de petits objets — mais un seul GROS objet
    // (STEP dense, résultat Hydra fusionné) retombe dans le même O(n²). Tableau +
    // join('') : même sortie, O(n).
    const vLines=[], fLines=[];
    for(let i=0;i<vc;i++){
      const v=cv(p.getX(i),p.getY(i),p.getZ(i));
      const nv=cv(n.getX(i),n.getY(i),n.getZ(i));
      vLines.push(v.x.toFixed(6)+' '+v.y.toFixed(6)+' '+v.z.toFixed(6)+' '+
            nv.x.toFixed(6)+' '+nv.y.toFixed(6)+' '+nv.z.toFixed(6)+'\n');
    }
    for(let i=0;i<fc;i++){
      const b=totalVerts+i*3;
      fLines.push('3 '+b+' '+(b+1)+' '+(b+2)+'\n');
    }
    vParts.push(vLines.join('')); fParts.push(fLines.join(''));
    totalVerts+=vc; totalFaces+=fc;
    gi.dispose();
  });

  const hdr=`ply\nformat ascii 1.0\ncomment Generated by NASSCAD V${NASSCAD_VERSION}\nelement vertex ${totalVerts}\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\nelement face ${totalFaces}\nproperty list uchar int vertex_indices\nend_header\n`;
  _nasSaveWithHandle('model.ply', new Blob([hdr+vParts.join('')+fParts.join('')],{type:'application/octet-stream'}), 'application/octet-stream', _fh);
  nasLog('OK',`Export PLY — ${objs.length} object(s) — ${totalVerts} vertices`);
  hideSpinner();
  }); // end rAF
}

// ── io-ply-import.js ──────────────────────────────────────────────────────
// ── Import PLY (Stanford Polygon File Format) ────────────────────────────────
// Supporte : ASCII · binary_little_endian · binary_big_endian
// Retourne une BufferGeometry Z-up (même convention que STL/OBJ — conversion appliquée par importMesh)
// [NEW V4.4.0] async coopératif — cf. commentaire au-dessus de parseSTL. Progression
// pondérée : vertices 0→0.6, faces 0.6→1.0 (approximatif mais honnête, deux phases).
async function parsePLY(buf, opts){
  const onP = (opts && opts.onProgress) || null;
  let _lastY = performance.now();
  const bytes=new Uint8Array(buf), dec=new TextDecoder('utf-8');
  // Trouver end_header
  const EH='end_header'; let hdrEnd=-1;
  for(let i=0;i<Math.min(bytes.length-EH.length-2,8192);i++){
    if(bytes[i]===0x65){
      let ok=true;
      for(let j=0;j<EH.length;j++) if(bytes[i+j]!==EH.charCodeAt(j)){ok=false;break;}
      if(ok){hdrEnd=i+EH.length;while(hdrEnd<bytes.length&&(bytes[hdrEnd]===13||bytes[hdrEnd]===10))hdrEnd++;break;}
    }
  }
  if(hdrEnd<0) throw new Error('Invalid PLY: no end_header');
  const lines=dec.decode(bytes.slice(0,hdrEnd)).split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  // Parser header
  let fmt='ascii'; let nV=0, nF=0; const vP=[]; let cur=null;
  const _SZ={char:1,uchar:1,short:2,ushort:2,int:4,uint:4,float:4,double:8};
  for(const line of lines){
    const t=line.split(/\s+/);
    if(t[0]==='format') fmt=t[1];
    else if(t[0]==='element'){cur=t[1];if(cur==='vertex')nV=+t[2];else if(cur==='face')nF=+t[2];}
    else if(t[0]==='property'&&cur==='vertex'&&t[1]!=='list') vP.push({type:t[1],name:t[2],sz:_SZ[t[1]]||4,off:0});
  }
  let stride=0; vP.forEach(p=>{p.off=stride;stride+=p.sz;});
  const xi=vP.findIndex(p=>p.name==='x'),yi=vP.findIndex(p=>p.name==='y'),zi=vP.findIndex(p=>p.name==='z');
  const nxi=vP.findIndex(p=>p.name==='nx'),nyi=vP.findIndex(p=>p.name==='ny'),nzi=vP.findIndex(p=>p.name==='nz');
  if(xi<0||yi<0||zi<0) throw new Error('PLY: missing x/y/z');
  const pos=[],nor=nxi>=0?[]:null,idx=[]; const dv=new DataView(buf); const le=fmt!=='binary_big_endian';
  const _rf=(off,p)=>{
    if(p.type==='float') return dv.getFloat32(off,le);
    if(p.type==='double') return dv.getFloat64(off,le);
    if(p.type==='int'||p.type==='uint') return dv.getInt32(off,le);
    if(p.type==='short'||p.type==='ushort') return dv.getInt16(off,le);
    return dv.getUint8(off);
  };
  if(fmt==='ascii'){
    const dl=dec.decode(bytes.slice(hdrEnd)).split(/\r?\n/); let li=0;
    for(let i=0;i<nV;i++){const v=dl[li++].trim().split(/\s+/).map(Number);pos.push(v[xi],v[yi],v[zi]);if(nor)nor.push(v[nxi]||0,v[nyi]||0,v[nzi]||0);
      if((i & 0x3FFF)===0 && performance.now()-_lastY>40){ _lastY=performance.now(); if(onP)onP(0.6*i/nV); await _breathe(); }}
    for(let i=0;i<nF;i++){const v=dl[li++].trim().split(/\s+/).map(Number);for(let t=1;t<v[0]-1;t++)idx.push(v[1],v[t+1],v[t+2]);
      if((i & 0x3FFF)===0 && performance.now()-_lastY>40){ _lastY=performance.now(); if(onP)onP(0.6+0.4*i/nF); await _breathe(); }}
  } else {
    let off=hdrEnd;
    for(let i=0;i<nV;i++){pos.push(_rf(off+vP[xi].off,vP[xi]),_rf(off+vP[yi].off,vP[yi]),_rf(off+vP[zi].off,vP[zi]));if(nor)nor.push(_rf(off+vP[nxi].off,vP[nxi]),_rf(off+vP[nyi].off,vP[nyi]),_rf(off+vP[nzi].off,vP[nzi]));off+=stride;
      if((i & 0x3FFF)===0 && performance.now()-_lastY>40){ _lastY=performance.now(); if(onP)onP(0.6*i/nV); await _breathe(); }}
    for(let i=0;i<nF;i++){const n=dv.getUint8(off);off++;const fc=[];for(let j=0;j<n;j++){fc.push(dv.getInt32(off,le));off+=4;}for(let t=1;t<n-1;t++)idx.push(fc[0],fc[t],fc[t+1]);
      if((i & 0x3FFF)===0 && performance.now()-_lastY>40){ _lastY=performance.now(); if(onP)onP(0.6+0.4*i/nF); await _breathe(); }}
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  if(nor) geo.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
  if(idx.length) geo.setIndex(idx);
  return geo;
}

// ═══════════════════════════════ STL ════════════════════════════════════
// ── io-stl-export.js ──────────────────────────────────────────────────────
// ── Export STL binaire — 4-5× plus compact que l'ASCII, natif pour les slicers
// Structure : 80B header · 4B uint32 triCount · N×50B (12B normal + 3×12B verts + 2B attr)
async function expSTL(){
  const t0=performance.now();
  let _fh=null;
  if(typeof showSaveFilePicker==='function' && !(window.electronAPI&&window.electronAPI.isElectron)){
    try{
      _fh=await showSaveFilePicker({suggestedName:'model.stl',types:[{description:'STL File (Binary)',accept:{'model/stl':['.stl']}}]});
    }catch(e){
      if(e.name==='AbortError') return;
      nasLog('WARN','showSaveFilePicker: '+e.message+' — fallback navigateur');
    }
  }
  showSpinner('Export STL','Preparing…');
  // [02/09] rAF en await — voir exp3MF, même raison.
  await new Promise(_r => requestAnimationFrame(_r));
  const cv=(x,y,z)=>({x,y:-z,z:y}); // Three Y-up → Z-up
  scene.updateMatrixWorld(true);
  // Passe 1 : construire + transformer toutes les géos HD
  const geos=[];
  objs.forEach(so=>{
    const gHD=makeGeoHD(so);
    if(_ioCanRebuild(so)){
      const _p=new THREE.Vector3(),_q=new THREE.Quaternion(),_s=new THREE.Vector3();
      so.mesh.matrixWorld.decompose(_p,_q,_s);
      const mPR=new THREE.Matrix4().makeRotationFromQuaternion(_q);mPR.setPosition(_p);
      gHD.applyMatrix4(mPR);
    } else { gHD.applyMatrix4(so.mesh.matrixWorld); }
    geos.push(gHD);
  });

  // [02/09] Étanchéité — cf. _watertightGate.
  {
    const _wt = geos.map((g,i) => ({geo: g, name: (objs[i] && objs[i].name) || ('body '+(i+1))}));
    await _watertightGate(_wt, 'Export STL');
    for(let i=0;i<geos.length;i++) geos[i] = _wt[i].geo;   // la réparation rend une NOUVELLE géo
    showSpinner('Export STL','Writing…');
  }

  // triCount compté APRÈS la passe : souder et réparer change le maillage, et
  // un buffer STL dimensionné sur l'ancien compte serait tronqué ou trop grand.
  let triCount=0;
  for(const g of geos){ const ix=g.index; triCount += ix ? ix.count/3 : g.attributes.position.count/3; }

  // Allocation du buffer binaire
  const buf=new ArrayBuffer(80+4+triCount*50);
  const dv=new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode('NASSCAD V'+NASSCAD_VERSION+' Binary STL'),0);
  dv.setUint32(80,triCount,true);
  let off=84;
  const wf=v=>{dv.setFloat32(off,v,true);off+=4;};
  const wv=v=>{wf(v.x);wf(v.y);wf(v.z);};
  // Passe 2 : écrire les triangles
  geos.forEach(g=>{
    const pos=g.attributes.position,ix=g.index;
    const nTri=ix?ix.count/3:pos.count/3;
    for(let i=0;i<nTri;i++){
      const ai=ix?ix.getX(i*3):i*3, bi=ix?ix.getX(i*3+1):i*3+1, ci=ix?ix.getX(i*3+2):i*3+2;
      const va=cv(pos.getX(ai),pos.getY(ai),pos.getZ(ai));
      const vb=cv(pos.getX(bi),pos.getY(bi),pos.getZ(bi));
      const vc=cv(pos.getX(ci),pos.getY(ci),pos.getZ(ci));
      const ex=vb.x-va.x,ey=vb.y-va.y,ez=vb.z-va.z;
      const fx=vc.x-va.x,fy=vc.y-va.y,fz=vc.z-va.z;
      const nx=ey*fz-ez*fy,ny=ez*fx-ex*fz,nz=ex*fy-ey*fx;
      const nl=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
      wf(nx/nl);wf(ny/nl);wf(nz/nl); // normale
      wv(va);wv(vb);wv(vc);           // 3 sommets
      dv.setUint16(off,0,true);off+=2; // attr
    }
    g.dispose();
  });
  nasLog('OK',`Export STL binaire — ${triCount} triangles — ${(buf.byteLength/1024).toFixed(0)} KB — ${Math.round(performance.now()-t0)}ms`);
  _nasSaveWithHandle('model.stl',new Blob([buf],{type:'model/stl'}),'model/stl', _fh);
  hideSpinner();
}

// ── Export STL ASCII — format texte, compatible outils legacy
async function expSTLascii(){
  let _fh=null;
  if(typeof showSaveFilePicker==='function' && !(window.electronAPI&&window.electronAPI.isElectron)){
    try{
      _fh=await showSaveFilePicker({suggestedName:'model-ascii.stl',types:[{description:'STL File (ASCII)',accept:{'model/stl':['.stl']}}]});
    }catch(e){
      if(e.name==='AbortError') return;
      nasLog('WARN','showSaveFilePicker: '+e.message+' — fallback navigateur');
    }
  }
  showSpinner('Export STL (ASCII)','Preparing…');
  requestAnimationFrame(()=>{
  const cv=(x,y,z)=>({x:x,y:-z,z:y});
  const faceNormal=(pa,pb,pc)=>{const ax=pb.x-pa.x,ay=pb.y-pa.y,az=pb.z-pa.z,bx=pc.x-pa.x,by=pc.y-pa.y,bz=pc.z-pa.z;const nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx;const l=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;return nx/l+' '+ny/l+' '+nz/l;};
  let s='solid m\n';
  scene.updateMatrixWorld(true);
  objs.forEach(so=>{
    const _gHD=makeGeoHD(so);
    if(_ioCanRebuild(so)){
      const _p=new THREE.Vector3(),_q=new THREE.Quaternion(),_s=new THREE.Vector3();
      so.mesh.matrixWorld.decompose(_p,_q,_s);
      const mPR=new THREE.Matrix4().makeRotationFromQuaternion(_q);mPR.setPosition(_p);
      _gHD.applyMatrix4(mPR);
    } else { _gHD.applyMatrix4(so.mesh.matrixWorld); }
    const g=_gHD;
    const p=g.attributes.position,ix=g.index;
    const vt=i=>{const v=cv(p.getX(i),p.getY(i),p.getZ(i));return'  vertex '+v.x.toFixed(6)+' '+v.y.toFixed(6)+' '+v.z.toFixed(6)+'\n';};
    if(ix){for(let i=0;i<ix.count;i+=3){const a=ix.getX(i),b=ix.getX(i+1),c=ix.getX(i+2);const pa=cv(p.getX(a),p.getY(a),p.getZ(a)),pb=cv(p.getX(b),p.getY(b),p.getZ(b)),pc=cv(p.getX(c),p.getY(c),p.getZ(c));s+='facet normal '+faceNormal(pa,pb,pc)+'\n outer loop\n'+vt(a)+vt(b)+vt(c)+' endloop\nendfacet\n';}}
    else{for(let i=0;i<p.count;i+=3){const pa=cv(p.getX(i),p.getY(i),p.getZ(i)),pb=cv(p.getX(i+1),p.getY(i+1),p.getZ(i+1)),pc=cv(p.getX(i+2),p.getY(i+2),p.getZ(i+2));s+='facet normal '+faceNormal(pa,pb,pc)+'\n outer loop\n'+vt(i)+vt(i+1)+vt(i+2)+' endloop\nendfacet\n';}}
    g.dispose();
  });
  s+='endsolid m\n';_nasSaveWithHandle('model-ascii.stl',new Blob([s],{type:'model/stl'}),'model/stl', _fh);
  hideSpinner();
  }); // end rAF
}

// ── io-stl-import.js ──────────────────────────────────────────────────────
// Parser bas niveau (parseSTL) — binaire OU ASCII, auto-détecté.
// [NEW V4.4.0] Parsers coopératifs — parseSTL/parseOBJ/parsePLY sont async et
// rendent la main au navigateur (~toutes les 40ms de travail) au lieu de dérouler des
// millions d'itérations d'un seul tenant sur le main thread. Cause racine du symptôme
// constaté sur le David de Michel-Ange : spinner peint mais figé à 00:00 + bannière
// Firefox "cette page ralentit" — le setInterval du chrono, les events, tout était
// affamé pendant le parsing. Le masque binaire (i & 0x3FFF) évite d'appeler
// performance.now() à chaque itération (l'appel lui-même coûterait cher ×2M).
// opts.onProgress(0..1) : branché par importMesh sur la barre RÉELLE du spinner
// (triCount connu d'avance en STL binaire → vrai %, pas un scanner indéterminé).
// opts.skipNormals : importMesh applique une conversion d'axes juste après le parsing,
// qui invalide les normales — les calculer ici PUIS les recalculer après conversion
// était un double O(n) pur gâchis.
// NB NassScript : ces trois fonctions retournent désormais une Promise (await requis).
async function parseSTL(buf, opts){
  const onP = (opts && opts.onProgress) || null;
  let _lastY = performance.now();
  const geo=new THREE.BufferGeometry();
  const dv=new DataView(buf);
  const triCount=dv.getUint32(80,true);
  if(84+triCount*50===buf.byteLength){
    const verts=new Float32Array(triCount*9);let vi=0;
    for(let i=0;i<triCount;i++){
      const base=84+i*50+12;
      for(let v=0;v<3;v++){verts[vi++]=dv.getFloat32(base+v*12,true);verts[vi++]=dv.getFloat32(base+v*12+4,true);verts[vi++]=dv.getFloat32(base+v*12+8,true);}
      if((i & 0x3FFF)===0 && performance.now()-_lastY>40){ _lastY=performance.now(); if(onP)onP(i/triCount); await _breathe(); }
    }
    geo.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));
  } else {
    const txt=new TextDecoder().decode(buf);const verts=[];
    const re=/vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)/g;let m;let n=0;
    while((m=re.exec(txt))!==null){
      verts.push(+m[1],+m[2],+m[3]);
      // Progression ASCII : position du curseur regex dans le texte (lastIndex/length)
      if(((++n) & 0xFFF)===0 && performance.now()-_lastY>40){ _lastY=performance.now(); if(onP)onP(re.lastIndex/txt.length); await _breathe(); }
    }
    geo.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));
  }
  if(!(opts && opts.skipNormals)) geo.computeVertexNormals();
  return geo;
}

