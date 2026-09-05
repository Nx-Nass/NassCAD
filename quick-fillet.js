// ══════════════════════════════════════════════════════════════════════════
// quick-fillet.js — module Quick Fillet (état + UI de scan/highlight d'arêtes)
// + infra de chargement OCCT + _occtFilletAll (calcul du fillet B-Rep) extrait
// du host NASSCAD.
//
// Traité comme UN SEUL module cohérent (comme step-import.js) — état partagé,
// UI interactive et calcul OCCT sont trop imbriqués pour un découpage sûr en
// plusieurs fichiers.
//
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, selObjs, objCnt, cam, ren, ray, mouse            — scene state
//   THREE                                                          — Three.js global
//   undoPush, updProps, updOList, updStats, nasLog                — app-wide helpers
//   showSpinner, hideSpinner, _bboxCache, _camDirty                — UI/état global
//   GeometryPool, updPoolStats, _meshMap, _raycastFiltered,
//   _softenColor, computeCenterOfGravity, makeGeoCSG               — pipeline géométrie/CSG
//
//   ⚠ COUPLAGE INTER-MODULES : _OCCT_LOADER_B64 (déclarée dans occt-loader-b64.js,
//     module séparé juste à côté) — chargée via atob() dans _occtGetFactory().
//     Ordre naturel préservé (occt-loader-b64.js juste après ce module dans le
//     fichier original), mais l'appel n'a lieu qu'au runtime donc l'ordre exact
//     des <script src> n'est pas critique.
//
//   ⚠ COUPLAGE VERS LE HOST : _weldAndCheckManifold, _capStepGaps — restées
//     volontairement dans le host (partagées avec step-import.js, cf. son
//     propre header). Confirmé une seconde fois par ce scan — cohérent avec
//     la découverte initiale.
// ══════════════════════════════════════════════════════════════════════════
// ══ Quick Fillet — état partagé pour le scan/highlight d'arêtes OCCT ═════
// Détecte les chaînes d'arêtes vives de l'objet sélectionné (convexe/
// concave), les affiche en tubes colorés, et sert de base au picking
// sélectif OCCT (drag-paint + présélection Top/Bottom). Le sweep-cutter
// mesh d'origine (v2→v4.3) a été retiré le 21/07 — tout fillet/chamfer
// passe désormais par le kernel B-Rep OCCT (_occtFilletAll).
let _qfActive     = false;
let _qfSrcObj     = null;      // objet source
let _qfChains     = [];        // chaînes courbes {pts,segN1,segN2,convex,closed,len,cum}
let _qfEdgeTubes  = [];        // Groups de tubes colorés permanents (1 Group/chaîne)
let _qfHoverMesh  = null;      // Group hover blanc (chaîne survolée entière)
let _qfHoverEdge  = null;      // chaîne actuellement survolée
let _qfHoverS     = 0;         // abscisse curviligne du point snappé sur _qfHoverEdge
let _qfSegs       = 32;
let _qfMode       = 'round';   // 'round' | 'chamfer'
let _qfOcctPick   = false;     // true : le clic toggle une arête dans la sélection OCCT
let _qfOcctSel    = new Set(); // indices dans _qfChains retenus pour le fillet OCCT sélectif
let _qfOcctSelTubes = new Map(); // idx chain -> Group de tubes doré persistant
let _qfDragSel    = false;     // true : bouton maintenu, on "peint" la sélection en glissant
let _qfDragAdding = true;      // direction figée au premier clic du drag (ajoute ou retire)
let _qfDragLastIdx= -1;        // dernière chaîne traitée pendant CE drag (évite le spam)

function toggleQuickFillet(){
  if(_qfActive){ _qfExit(); return; }
  const src = selObjs.find(o=>!o.isHole);
  if(!src){ nasLog('WARN','QF: select a solid object first'); return; }
  _qfSrcObj = src;
  _qfActive = true;
  const b=document.getElementById('tbx-quickfillet'); if(b) b.classList.add('active');
  ren.domElement.style.cursor='crosshair';
  const m=document.getElementById('qf-modal');
  if(m){ m.classList.add('open');
    m.style.left=Math.max(196,innerWidth-310-20)+'px';
    m.style.top=Math.max(34,innerHeight-300-32)+'px'; }
  _qfScanAndShow();
  nasLog('QF','Quick Fillet v4 — curved chains — ☑full=1 click, partial=A→B');
}

function _qfMakeTube(edge, mat){
  const a=new THREE.Vector3(edge.v0.x,edge.v0.y,edge.v0.z);
  const b=new THREE.Vector3(edge.v1.x,edge.v1.y,edge.v1.z);
  const len=a.distanceTo(b);
  const r=Math.min(Math.max(len*0.010,0.07),0.4);
  const geo=new THREE.CylinderGeometry(r,r,len,6,1);
  const mesh=new THREE.Mesh(geo,mat);
  const dir=b.clone().sub(a).normalize();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),dir);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.raycast=()=>{};
  mesh.renderOrder=999;
  return mesh;
}

// Group de tubes pour une polyline (1 tube/segment + fermeture si boucle)
function _qfMakeChainGroup(pts, closed, mat){
  const grp=new THREE.Group();
  const n=pts.length, nSeg=closed?n:n-1;
  for(let i=0;i<nSeg;i++){
    grp.add(_qfMakeTube({v0:pts[i],v1:pts[(i+1)%n]},mat));
  }
  return grp;
}
function _qfDisposeGroup(g){
  if(!g) return;
  scene.remove(g);
  g.traverse(c=>{if(c.geometry)c.geometry.dispose();});
  if(g.children[0]&&g.children[0].material) g.children[0].material.dispose();
}

function _qfScanAndShow(){
  _qfClearTubes(); _qfChains=[];
  if(!_qfSrcObj) return;
  const bb=_bboxCache.get(_qfSrcObj.mesh)||new THREE.Box3().setFromObject(_qfSrcObj.mesh);
  const diag=bb.getSize(new THREE.Vector3()).length();
  try{
    _qfChains=_qfScanChains(_qfSrcObj).filter(c=>c.len>=Math.max(1.0,diag*0.02));
  }catch(e){ nasLog('WARN','QF scan: '+e.message); }
  let nClosed=0;
  for(const c of _qfChains){
    if(c.closed) nClosed++;
    const col = c.convex ? 0x2288ff : 0xff4444;
    const mat = new THREE.MeshBasicMaterial({color:col,depthTest:false,transparent:true,opacity:0.65});
    const grp = _qfMakeChainGroup(c.pts,c.closed,mat);
    scene.add(grp); _qfEdgeTubes.push(grp);
  }
  _qfSetStatus(`${_qfChains.length} chains (${nClosed} loops) — hover + click`);
  _camDirty=true;
}

function _qfClearTubes(){
  for(const g of _qfEdgeTubes) _qfDisposeGroup(g);
  _qfEdgeTubes=[]; _camDirty=true;
}

function _qfClearHover(){
  _qfDisposeGroup(_qfHoverMesh); _qfHoverMesh=null;
  _qfHoverEdge=null; _camDirty=true;
}

function _qfOcctPickToggle(){
  _qfOcctPick=!_qfOcctPick;
  document.getElementById('qf-occtpick')?.classList.toggle('active',_qfOcctPick);
  _qfSetStatus(_qfOcctPick?'🖱 Click the edges to fillet (click again to remove)':'Select an object then ⌐R');
}
// Version directionnelle (add=true/false) — nécessaire pour le drag-paint :
// un toggle pur ferait clignoter la sélection si le curseur repasse deux
// fois sur la même arête pendant un même geste de glisser.
function _qfOcctSetSel(idx, add){
  if(idx<0||idx>=_qfChains.length) return;
  const already=_qfOcctSel.has(idx);
  if(add===already) return; // déjà dans l'état voulu, rien à faire
  if(!add){
    _qfOcctSel.delete(idx);
    const g=_qfOcctSelTubes.get(idx);
    if(g){_qfDisposeGroup(g);_qfOcctSelTubes.delete(idx);}
  }else{
    _qfOcctSel.add(idx);
    const c=_qfChains[idx];
    const mat=new THREE.MeshBasicMaterial({color:0xffd23f,depthTest:false,transparent:true,opacity:0.9});
    const g=_qfMakeChainGroup(c.pts,c.closed,mat);
    scene.add(g); _qfOcctSelTubes.set(idx,g);
  }
  const n=_qfOcctSel.size;
  const btn=document.getElementById('qf-occt-sel');
  if(btn){btn.textContent=`⬡ Selected (${n})`;btn.disabled=(n===0);}
  _qfSetStatus(`${n} chain(s) selected for OCCT — click again to remove`);
  _camDirty=true;
}
// Présélection par zone — "Top"/"Bottom" ajoutent toutes les chaînes dont
// TOUS les points sont proches du Y max/min de la bbox monde de l'objet
// (donc le contour d'une face plate, pas une arête verticale qui relie
// les deux et dont les points s'étalent sur toute la hauteur). Idée Nass
// 21/07. Tolérance relative à la diagonale, cohérente avec le reste du code.
function _qfPresetZone(zone){
  if(!_qfChains.length||!_qfSrcObj) return;
  const bb=_bboxCache.get(_qfSrcObj.mesh)||new THREE.Box3().setFromObject(_qfSrcObj.mesh);
  const diag=bb.getSize(new THREE.Vector3()).length();
  const tol=Math.max(0.05,diag*0.01);
  const targetY=(zone==='top')?bb.max.y:bb.min.y;
  let n=0;
  _qfChains.forEach((c,idx)=>{
    const allNear=c.pts.every(p=>Math.abs(p.y-targetY)<tol);
    if(allNear&&!_qfOcctSel.has(idx)){ _qfOcctSetSel(idx,true); n++; }
  });
  _qfSetStatus(n?`${n} chain(s) added from ${zone}`:`⚠ No ${zone} edge found`,n?'var(--success)':'var(--warn)');
}
function _qfOcctClearSel(){
  for(const g of _qfOcctSelTubes.values()) _qfDisposeGroup(g);
  _qfOcctSelTubes.clear(); _qfOcctSel.clear();
  _qfDragSel=false; _qfDragLastIdx=-1;
  const btn=document.getElementById('qf-occt-sel');
  if(btn){btn.textContent='⬡ Selected (0)';btn.disabled=true;}
  _qfOcctPick=false;
  document.getElementById('qf-occtpick')?.classList.remove('active');
}

function _qfExit(){
  _qfActive=false; _qfSrcObj=null; _qfChains=[];
  _qfClearTubes(); _qfClearHover(); _qfOcctClearSel();
  const b=document.getElementById('tbx-quickfillet'); if(b) b.classList.remove('active');
  ren.domElement.style.cursor='';
  const m=document.getElementById('qf-modal'); if(m) m.classList.remove('open');
}

function _qfSeg(v){
  _qfSegs=v;
  document.getElementById('qf-vs').textContent=v;
  document.querySelectorAll('#qf-segbtns .vb-btn').forEach(b=>b.classList.remove('active'));
  [...document.querySelectorAll('#qf-segbtns .vb-btn')].find(b=>+b.textContent===v)?.classList.add('active');
}

function _qfModeSet(m){
  _qfMode=m;
  document.getElementById('qf-mround').classList.toggle('active',m==='round');
  document.getElementById('qf-mchamfer').classList.toggle('active',m==='chamfer');
  const lbl=document.getElementById('qf-plabel');
  if(lbl) lbl.textContent=m==='chamfer'?'Distance C':'Radius R (mm)';
}

function _qfSetStatus(msg,col){
  const el=document.getElementById('qf-status');
  if(el){el.textContent=msg;el.style.color=col||'var(--accent)';}
}

function _qfChainDistParam(chain,p){
  const pts=chain.pts, n=pts.length, nSeg=chain.closed?n:n-1;
  let bd=Infinity, bs=0;
  for(let i=0;i<nSeg;i++){
    const A=pts[i], B=pts[(i+1)%n];
    const dx=B.x-A.x, dy=B.y-A.y, dz=B.z-A.z;
    const l2=dx*dx+dy*dy+dz*dz;
    let t=l2>1e-12?((p.x-A.x)*dx+(p.y-A.y)*dy+(p.z-A.z)*dz)/l2:0;
    t=Math.max(0,Math.min(1,t));
    const qx=A.x+dx*t, qy=A.y+dy*t, qz=A.z+dz*t;
    const d=Math.hypot(p.x-qx,p.y-qy,p.z-qz);
    if(d<bd){bd=d;bs=chain.cum[i]+Math.sqrt(l2)*t;}
  }
  return {d:bd, s:bs};
}
// Point 3D à l'abscisse curviligne s (clampé sur [0, cum_last])
function _qfNearestChain(hitPt, candidates){
  const bb=_bboxCache.get(_qfSrcObj.mesh)||new THREE.Box3().setFromObject(_qfSrcObj.mesh);
  const diag=bb.getSize(new THREE.Vector3()).length();
  const thresh=Math.min(Math.max(diag*0.07,0.5),10);
  let best=null, bd=thresh, bs=0;
  for(const c of candidates){
    const r=_qfChainDistParam(c,hitPt);
    if(r.d<bd){bd=r.d;best=c;bs=r.s;}
  }
  return best?{chain:best,s:bs}:null;
}

// Hover : chaîne survolée en surbrillance blanche + preview sous-chaîne
// ambre A→hover si un point de départ est figé (verrouillé sur sa chaîne).
function _qfOnHover(){
  if(!_qfActive||!_qfSrcObj) return;
  ray.setFromCamera(mouse,cam);
  const hits=_raycastFiltered();
  let hitPt=null;
  for(const h of hits){
    const c=_meshMap.get(h.object);
    if(c&&c.id===_qfSrcObj.id){hitPt=h.point;break;}
  }
  if(!hitPt){_qfClearHover();return;}

  const hitRes=_qfNearestChain(hitPt,_qfChains);

  if(!hitRes){
    _qfClearHover();
    return;
  }
  const best=hitRes.chain;
  _qfHoverS=hitRes.s;

  if(best!==_qfHoverEdge){
    _qfClearHover();
    _qfHoverEdge=best;
    const mat=new THREE.MeshBasicMaterial({color:0xffffff,depthTest:false,transparent:true,opacity:0.98});
    _qfHoverMesh=_qfMakeChainGroup(best.pts,best.closed,mat);
    scene.add(_qfHoverMesh);
  }

  const tag=best.convex?'▲ convex':'▼ concave';
  const loop=best.closed?' ⟳boucle':'';
  _qfSetStatus(`${tag}${loop} len=${best.len.toFixed(1)}mm`);
  _camDirty=true;
}

// Click : bascule une chaîne dans/hors la sélection OCCT (mode pick actif)
function _qfOnClick(){
  ray.setFromCamera(mouse,cam);
  const hits=_raycastFiltered();
  let hitPt=null;
  for(const h of hits){
    const c=_meshMap.get(h.object);
    if(c&&c.id===_qfSrcObj.id){hitPt=h.point;break;}
  }
  if(!hitPt){_qfSetStatus('Click on the part','var(--warn)');return true;}

  if(_qfOcctPick){
    const hr=_qfNearestChain(hitPt,_qfChains);
    if(!hr){_qfSetStatus('⚠ No edge here','var(--warn)');return true;}
    const idx=_qfChains.indexOf(hr.chain);
    _qfDragAdding=!_qfOcctSel.has(idx); // direction figée pour tout le glisser à suivre
    _qfOcctSetSel(idx,_qfDragAdding);
    _qfDragSel=true; _qfDragLastIdx=idx;
    return true;
  }

  _qfSetStatus('🖱 Click "Pick edges" first to select edges for OCCT','var(--warn)');
  return true;
}

function _qfScanChains(targetObj){
  targetObj.mesh.updateMatrixWorld(true);
  const geoSrc=(targetObj.type==='csg')?targetObj.mesh.geometry.clone():makeGeoCSG(targetObj);
  {
    const _pos=new THREE.Vector3(),_q=new THREE.Quaternion(),_sc=new THREE.Vector3();
    targetObj.mesh.matrixWorld.decompose(_pos,_q,_sc);
    const _m=(targetObj.type==='csg')
      ? new THREE.Matrix4().compose(_pos,_q,_sc)
      : (()=>{const m=new THREE.Matrix4().makeRotationFromQuaternion(_q);m.setPosition(_pos);return m;})();
    geoSrc.applyMatrix4(_m);
  }
  const srcNI=geoSrc.index?geoSrc.toNonIndexed():geoSrc;
  const pos=srcNI.attributes.position;
  const triCount=pos.count/3|0;
  const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
  const add2=(a,b)=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
  const cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
  const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
  const norm=a=>{const l=Math.sqrt(dot(a,a));return l>1e-9?{x:a.x/l,y:a.y/l,z:a.z/l}:null;};
  // Weld positionnel → indices uniques (quantum 0.1µm)
  const vmap=new Map(), uniq=[];
  function uidx(p){
    const k=Math.round(p.x*1e4)+'_'+Math.round(p.y*1e4)+'_'+Math.round(p.z*1e4);
    let i=vmap.get(k);
    if(i===undefined){i=uniq.length;uniq.push(p);vmap.set(k,i);}
    return i;
  }
  const triV=new Array(triCount), triN=new Array(triCount);
  for(let t=0;t<triCount;t++){
    const a={x:pos.getX(t*3),y:pos.getY(t*3),z:pos.getZ(t*3)};
    const b={x:pos.getX(t*3+1),y:pos.getY(t*3+1),z:pos.getZ(t*3+1)};
    const c={x:pos.getX(t*3+2),y:pos.getY(t*3+2),z:pos.getZ(t*3+2)};
    triV[t]=[uidx(a),uidx(b),uidx(c)];
    triN[t]=norm(cross(sub(b,a),sub(c,a)))||{x:0,y:1,z:0};
  }
  if(srcNI!==geoSrc) srcNI.dispose();
  geoSrc.dispose();
  // Adjacence arête → triangles (+ sommet opposé pour test convexité)
  const edgeMap=new Map();
  for(let t=0;t<triCount;t++){
    const [ia,ib,ic]=triV[t];
    for(const [x,y,op] of [[ia,ib,ic],[ib,ic,ia],[ic,ia,ib]]){
      const key=x<y?x+'_'+y:y+'_'+x;
      let arr=edgeMap.get(key);
      if(!arr){arr=[];edgeMap.set(key,arr);}
      arr.push({t,op});
    }
  }
  // Arêtes vives (dièdre ≥ 20°), convexes ET concaves
  const segsArr=[];
  for(const [key,adj] of edgeMap){
    if(adj.length!==2) continue;
    const idx=key.indexOf('_');
    const a=+key.slice(0,idx), b=+key.slice(idx+1);
    const n1=triN[adj[0].t], n2=triN[adj[1].t];
    const ang=Math.acos(Math.max(-1,Math.min(1,dot(n1,n2))))*180/Math.PI;
    if(ang<20) continue;
    const p2=uniq[adj[1].op];
    const convex=dot(sub(p2,uniq[a]),n1)<-1e-6;
    segsArr.push({a,b,n1,n2,convex});
  }
  // Chaînage courbe
  const adjMap=new Map();
  for(const s of segsArr){
    if(!adjMap.has(s.a)) adjMap.set(s.a,[]);
    if(!adjMap.has(s.b)) adjMap.set(s.b,[]);
    adjMap.get(s.a).push(s); adjMap.get(s.b).push(s);
  }
  const BEND_MAX=Math.cos(42*Math.PI/180);
  const sKey=s=>s.a<s.b?s.a+'_'+s.b:s.b+'_'+s.a;
  const visited=new Set();
  const chains=[];
  for(const seed of segsArr){
    if(visited.has(sKey(seed))) continue;
    visited.add(sKey(seed));
    let idxPts=[seed.a,seed.b];
    let segList=[{n1:seed.n1,n2:seed.n2}];
    // 2 passes queue-only avec inversion entre les deux (fermeture toujours
    // par la queue → mapping seg[j]=pts[j]→pts[j+1] garanti)
    for(let pass=0;pass<2;pass++){
      let go=true;
      while(go){
        go=false;
        const last=idxPts[idxPts.length-1];
        if(idxPts.length>2 && last===idxPts[0]) break; // bouclé
        const prev=idxPts[idxPts.length-2];
        const dirPrev=norm(sub(uniq[last],uniq[prev]));
        if(!dirPrev) break;
        const refSeg=segList[segList.length-1];
        let best=null,bestDot=-2;
        for(const cand of (adjMap.get(last)||[])){
          const ck=sKey(cand);
          if(visited.has(ck)) continue;
          if(cand.convex!==seed.convex) continue;
          const other=cand.a===last?cand.b:cand.a;
          const dirNew=norm(sub(uniq[other],uniq[last]));
          if(!dirNew) continue;
          const c=dot(dirNew,dirPrev);
          if(c<BEND_MAX) continue;                     // virage trop sec
          const m11=dot(cand.n1,refSeg.n1)+dot(cand.n2,refSeg.n2);
          const m12=dot(cand.n1,refSeg.n2)+dot(cand.n2,refSeg.n1);
          if(Math.max(m11,m12)<1.0) continue;          // faces sans continuité
          if(c>bestDot){bestDot=c;best={cand,other,swap:m12>m11};}
        }
        if(best){
          visited.add(sKey(best.cand));
          idxPts.push(best.other);
          segList.push({n1:best.swap?best.cand.n2:best.cand.n1,
                        n2:best.swap?best.cand.n1:best.cand.n2});
          go=true;
        }
      }
      if(idxPts.length>2 && idxPts[0]===idxPts[idxPts.length-1]) break;
      idxPts.reverse(); segList.reverse();             // étendre l'autre bout
    }
    let closed=false;
    if(idxPts.length>3 && idxPts[0]===idxPts[idxPts.length-1]){
      closed=true; idxPts.pop();                        // dernier == premier
    }
    const pts=idxPts.map(i=>uniq[i]);
    const cum=[0];
    for(let i=1;i<pts.length;i++){
      const d=sub(pts[i],pts[i-1]);
      cum.push(cum[i-1]+Math.sqrt(dot(d,d)));
    }
    let len=cum[cum.length-1];
    if(closed){
      const d=sub(pts[0],pts[pts.length-1]);
      len+=Math.sqrt(dot(d,d));
    }
    chains.push({pts,segN1:segList.map(s=>s.n1),segN2:segList.map(s=>s.n2),
                 convex:seed.convex,closed,len,cum});
  }
  return chains;
}

// ══ Fin Quick Congé v4 ═══════════════════════════════════════════════════

// ══ OCCT All-Edges Fillet — BRepFilletAPI_MakeFillet (opencascade.js) ═════
// Real B-Rep kernel pipeline: mesh → per-triangle faces → Sewing (welds
// shared borders) → Solid → ShapeUpgrade_UnifySameDomain (merges coplanar
// facets into true planar faces: a 24-facet box becomes 6 faces / 12
// edges) → BRepFilletAPI_MakeFillet or MakeChamfer on EVERY edge — with
// automatic spherical vertex blends where 3 fillets meet at a corner —
// → BRepMesh_IncrementalMesh → triangles back to NASSCAD.
// Two selection modes: "All edges" fillets the whole object at once
// (original mode). "Selected edges" lets Nass pick specific edges first
// (🖱 Pick edges button, reusing the same colored convex/blue-concave/red
// edge scan as classic Quick Congé — click toggles a chain in/out of a
// persistent gold highlight); only OCCT edges geometrically matching a
// picked chain segment get Add()ed, the rest of the object stays sharp.
// Matching is geometric (collinearity + endpoint proximity), not index-
// based, so it survives UnifySameDomain merging several mesh sub-segments
// into one longer topological edge.
// Kernel = opencascade.js v1.1.1 (OCCT 7.4). The 331 KB JS loader is
// INLINED below in base64 (same treatment as Manifold) — zero import(),
// zero CORS. The 65.8 MB WASM binary is acquired at FIRST use through a
// fallback chain: (1) fetch from nasscad.com/occt/ when reachable,
// (2) local file picker (File API works in file:// and offline — the
// user points to a downloaded opencascade.wasm.wasm once per session).
// jsDelivr is NOT usable: it caps files at 50 MB.
// validated end-to-end in Node before integration (cube 12 tris → 26
// faces = 6 planar + 12 cylindrical + 8 spherical corners, vol 7798.5).
// Known limit: tessellated cylinders stay faceted (UnifySameDomain merges
// planar facets only — analytic surface recovery is Gorgone V5 territory).
// Embind instances are not .delete()d (few MB per run in WASM heap, 2 GB
// cap — acceptable for interactive one-shot use).
// Kernel hosting: jsDelivr caps files at 50 MB → the 65.8 MB wasm is
// self-hosted on nasscad.com/occt/ (loader + wasm, same directory).
const _OCCT_CDN='https://nasscad.com/occt/';
const _OCCT_MAX_TRIS=50000;
let _occt=null,_occtLoading=null,_occtNeedLocal=false;
let _occtWasmCache=null;   // binaire wasm gardé en RAM → un reset kernel est gratuit

// [FIX 04/09 — CAUSE RACINE du plantage récurrent "___cxa_is_pointer_type is
// not defined"] Ce build d'opencascade.js (emscripten 2.0.x) référence deux
// symboles de l'ABI d'exceptions C++ qu'il ne définit NULLE PART :
//   · ___cxa_is_pointer_type — appelé par CatchInfo.get_exception_ptr()
//   · ___cxa_can_catch       — appelé par ___cxa_find_matching_catch_2..5
// Vérifié par scan statique du loader décodé (référencés 1 fois chacun, 0
// déclaration) ET par lecture de la table d'exports du .wasm (26 exports, aucun
// __cxa_*). Conséquence : dès qu'OCCT lève une Standard_Failure — y compris
// quand OCCT la rattrape LUI-MÊME dans son propre try/catch de robustesse —
// le glue JS explose en ReferenceError avant qu'aucun handler C++ ne s'exécute.
// Le kernel ne peut donc jamais faire sa propre récupération d'erreur : ce qui
// devrait être un simple `IsDone()===false` remonte en crash opaque.
// Correctif : injecter les deux symboles manquants dans le code du loader AVANT
// le new Function(). Sémantique choisie, conforme à l'ABI Itanium :
//   · is_pointer_type → 0 : OCCT lève des OBJETS (Standard_Failure), jamais des
//     pointeurs ; 0 est la réponse exacte, pas une approximation.
//   · can_catch → 1 : sans RTTI exporté on ne peut pas tester la parenté de
//     types ; 1 revient au comportement d'un catch(...) — le handler le plus
//     interne attrape, ce qui est précisément la sémantique d'OCCT dont les
//     clauses sont quasi toutes catch(Standard_Failure&) ou catch(...).
// Non-régression mesurée sur 8 cas de référence (slab/plaque/cylindre/marche,
// R de 1 à 15) : volumes identiques au bit près avec et sans stubs. Le seul
// changement observable est que le cas qui crashait rend maintenant IsDone=false.
const _OCCT_ABI_ANCHOR='function ___cxa_free_exception(';
const _OCCT_ABI_STUBS=
  'function ___cxa_is_pointer_type(t){return 0;}\n'+
  'function ___cxa_can_catch(c,t,buf){return 1;}\n';
// Loader factory from the inlined base64 (no import(), no CORS, works file://)
function _occtGetFactory(){
  if(window._occtFactory)return window._occtFactory;
  let code=atob(_OCCT_LOADER_B64);
  if(code.indexOf('function ___cxa_is_pointer_type')>=0){
    nasLog('OCCT','Loader already provides the C++ exception ABI — no patch needed');
  }else if(code.indexOf(_OCCT_ABI_ANCHOR)>=0){
    code=code.replace(_OCCT_ABI_ANCHOR,_OCCT_ABI_STUBS+_OCCT_ABI_ANCHOR);
    nasLog('OCCT','C++ exception ABI patched (__cxa_is_pointer_type / __cxa_can_catch were missing from this build)');
  }else{
    nasLog('WARN','OCCT: exception ABI anchor not found in the loader — kernel failures may still surface as an opaque ReferenceError');
  }
  window._occtFactory=new Function(code+'\nreturn opencascade;')();
  return window._occtFactory;
}
// Un abort WASM (heap saturé, unwind impossible) laisse le module inutilisable :
// toute opération suivante échoue jusqu'au rechargement de la page. Comme le
// binaire est gardé en cache, on peut réinstancier un module neuf en ~2 s au
// lieu d'imposer un F5 à l'utilisateur.
function _occtResetKernel(why){
  _occt=null;_occtLoading=null;
  try{window._occtFactory=null;}catch(_){/* environnement sans window en test */}
  nasLog('WARN','OCCT: kernel discarded and will be re-instantiated on next use — '+why);
}
// true si le message d'erreur trahit un module WASM mort (par opposition à un
// simple échec géométrique, dont on se remet sans rien jeter).
function _occtIsFatal(msg){
  return /out of memory|Cannot enlarge memory|memory access out of bounds|unreachable|abort\(|RuntimeError|table index is out of bounds/i.test(String(msg||''));
}
// WASM binary acquisition chain (first success wins):
//  1) fetch from nasscad.com/occt/ (hosted kernel)
//  2) fetch sibling 'opencascade.wasm.wasm' — works when NASSCAD is
//     served over http(s); blocked by Chrome in file://
//  3) sibling 'opencascade.wasm.data.js' loaded via a plain <script src>
//     tag — classic scripts are NOT CORS-blocked in file://, so dropping
//     that companion file next to the HTML gives AUTOMATIC local loading
//  4) manual file picker — last resort (offline + no companion file)
// _occtNeedLocal remembers a network failure so the next attempt skips
// straight to the local paths.
async function _occtWasmBinary(){
  const _sane=b=>(b&&b.byteLength>1e6)?b:null;
  if(_occtWasmCache) return _occtWasmCache;   // reset kernel → zéro re-téléchargement
  if(!_occtNeedLocal){
    try{
      const r=await fetch(_OCCT_CDN+'opencascade.wasm.wasm');
      if(r.ok){const b=_sane(await r.arrayBuffer());if(b)return b;}
    }catch(e){/* CDN unreachable/CORS — expected, next step in the chain picks it up */}
    try{
      const r=await fetch('opencascade.wasm.wasm');
      if(r.ok){const b=_sane(await r.arrayBuffer());if(b){nasLog('OCCT','Kernel from sibling wasm (http)');return b;}}
    }catch(e){/* blocked under file:// — expected, falls through to the local-companion path below */}
    _occtNeedLocal=true;
    nasLog('OCCT','No hosted/sibling wasm over network — trying local companion file');
  }
  try{
    const buf=await new Promise((res,rej)=>{
      const s=document.createElement('script');
      s.src='opencascade.wasm.data.js';
      s.onload=async()=>{
        try{
          const b64=window._OCCT_WASM_B64;window._OCCT_WASM_B64=null;s.remove();
          if(!b64){rej(new Error('companion loaded but empty'));return;}
          let b;
          try{const r=await fetch('data:application/octet-stream;base64,'+b64);b=await r.arrayBuffer();}
          catch(_){const bin=atob(b64);const u=new Uint8Array(bin.length);
            for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);b=u.buffer;}
          res(b);
        }catch(e){rej(e);}
      };
      s.onerror=()=>{s.remove();rej(new Error('no companion file'));};
      document.head.appendChild(s);
    });
    const b=_sane(buf);
    if(b){nasLog('OCCT','Kernel from sibling opencascade.wasm.data.js ✓');return b;}
  }catch(e){nasLog('OCCT','Companion: '+(e&&e.message||e));}
  _qfSetStatus('⬇ Select your local opencascade.wasm.wasm (65 MB)','var(--accent)');
  return new Promise((res,rej)=>{
    const inp=document.createElement('input');
    inp.type='file';inp.accept='.wasm';
    inp.onchange=()=>{
      const f=inp.files&&inp.files[0];
      if(!f){rej(new Error('no file selected'));return;}
      nasLog('OCCT',`Local wasm: ${f.name} (${(f.size/1048576).toFixed(1)} MB)`);
      f.arrayBuffer().then(res,rej);
    };
    inp.oncancel=()=>rej(new Error('file selection cancelled — click the button again'));
    inp.click();
  });
}
function _occtLoad(){
  if(_occt)return Promise.resolve(_occt);
  if(_occtLoading)return _occtLoading;
  _occtLoading=(async()=>{
    _qfSetStatus('⏳ Loading OCCT kernel (65 MB, first time only)…','var(--accent)');
    nasLog('OCCT','Loading kernel…');
    const t0=performance.now();
    try{
      const wasmBinary=await _occtWasmBinary();
      _occtWasmCache=wasmBinary;
      showSpinner('OCCT kernel','Compiling WASM…');
      await new Promise(r=>setTimeout(r,30));
      const oc=await _occtGetFactory()({wasmBinary});
      nasLog('OCCT',`Kernel ready — ${((performance.now()-t0)/1000).toFixed(1)}s`);
      _occt=oc;return oc;
    }finally{_occtLoading=null;hideSpinner();}
  })();
  return _occtLoading;
}
// [NEW 25/07] Pré-check géométrique local, AVANT même de charger le kernel
// OCCT — empêche de lancer un calcul voué à l'échec plutôt que de le laisser
// planter/produire un gap et le détecter après coup. Réutilise les données
// déjà calculées par _qfScanChains (angle dièdre + points de chaque segment) :
// zéro coût de calcul nouveau, zéro appel kernel avant d'avoir vérifié.
// Heuristique CONSERVATRICE, pas une garantie : compare R à la longueur du
// segment lui-même via L=R/tan(angle/2) (formule standard fillet — vérifiée :
// pour un coin à 90°, ça donne L=R, cohérent avec un quart-de-rond), pas à la
// vraie profondeur de la face adjacente perpendiculairement à l'arête (ça
// demanderait de tracer jusqu'à la prochaine feature — nettement plus lourd
// pour un gain marginal, le kernel finit de toute façon par détecter ce cas-
// là). Attrape les cas flagrants (R comparable ou plus grand que l'arête),
// pas les cas subtils où l'arête est longue mais la face est étroite ailleurs.
// [FIX 04/09 — faux positifs] La version du 25/07 mesurait maxR sur CHAQUE
// segment de MAILLAGE. Or une arête franche est presque toujours découpée en
// plusieurs segments par la tessellation ou par les sommets d'intersection d'un
// CSG : sur une union de cubes de 20 mm, un sous-segment de 3 mm donnait
// "R ≤ 1.50 mm" alors que l'arête topologique réelle fait 20 mm. Résultat : le
// garde-fou criait au loup à chaque union, on prenait l'habitude de cliquer
// "Continue anyway", et il ne protégeait plus de rien.
// OCCT ne voit pas les segments de maillage : ShapeUpgrade_UnifySameDomain
// refusionne les sous-segments colinéaires en UNE arête. On mesure donc la même
// chose que lui — des RUNS de segments quasi colinéaires (< 5° de cassure) —
// au lieu du segment isolé. Le reste de l'heuristique est inchangé (conservatrice,
// basée sur la longueur de l'arête et non sur la largeur réelle de la face
// adjacente ; l'échelle de repli du kernel couvre désormais ce qu'elle rate).
const _QF_RUN_COS=Math.cos(5*Math.PI/180);
function _qfCheckRadiusFits(chains, R){
  let worst=null;
  const dirOf=(a,b)=>{const dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z;
    const l=Math.sqrt(dx*dx+dy*dy+dz*dz);
    return l>1e-9?{x:dx/l,y:dy/l,z:dz/l,l}:null;};
  for(const c of chains){
    const n=c.segN1.length, np=c.pts.length;
    let runLen=0, runAngMin=Math.PI, prevDir=null;
    const flush=()=>{
      if(runLen<=0) return;
      const maxR=0.5*runLen*Math.tan(runAngMin/2);
      if(R>maxR*1.05 && (!worst||maxR<worst.maxR)) worst={segLen:runLen,angDeg:runAngMin*180/Math.PI,maxR};
      runLen=0; runAngMin=Math.PI; prevDir=null;
    };
    for(let i=0;i<n;i++){
      const p1=c.pts[i], p2=c.pts[(i+1)%np];
      const dir=dirOf(p1,p2);
      if(!dir){ continue; }
      const d=c.segN1[i].x*c.segN2[i].x+c.segN1[i].y*c.segN2[i].y+c.segN1[i].z*c.segN2[i].z;
      const ang=Math.acos(Math.max(-1,Math.min(1,d)));
      // cassure de direction → l'arête topologique se termine ici
      if(prevDir && (dir.x*prevDir.x+dir.y*prevDir.y+dir.z*prevDir.z)<_QF_RUN_COS) flush();
      runLen+=dir.l;
      if(ang<runAngMin) runAngMin=ang;   // le pire angle du run commande
      prevDir=dir;
    }
    flush();
  }
  return worst; // null si tout est ok, sinon le pire cas trouvé (le plus contraignant)
}

// ══ Garde-fous kernel — helpers ══════════════════════════════════════════
// [NEW 04/09] Les instances embind ne sont plus laissées au ramasse-miettes :
// elles n'en ont pas. Mesuré sur 8 passes d'un maillage de 2 208 triangles —
// heap WASM 64 → 133 Mo sans delete() (et l'accélération est superlinéaire),
// 64 Mo stable avec. À 50 000 triangles le plafond de 2 Go tombait en quelques
// opérations : c'est le "après N fillets, plus rien ne marche jusqu'au F5".
function _occtDrop(...xs){ for(const x of xs){ try{ x&&x.delete&&x.delete(); }catch(_){} } }

// Volume signé du solide — NaN si l'API diffère (best-effort, jamais bloquant).
function _occtVolume(oc, shape){
  try{
    const g=new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape,g,false,false,false);
    const m=g.Mass(); _occtDrop(g); return m;
  }catch(_){ return NaN; }
}
// [FIX 04/09] Le check BRepCheck_Analyzer ajouté le 25/07 n'a JAMAIS tourné :
// dans ce binding la méthode s'appelle IsValid_1(shape)/IsValid_2(), pas
// IsValid(). Le try/catch best-effort avalait silencieusement le TypeError, donc
// le garde-fou anti-"trou invisible" était mort depuis le premier jour. Vérifié :
// sur une plaque de 4 mm filetée à R=3, IsValid_2() rend bien false.
function _occtIsValid(oc, shape){
  try{
    const a=new oc.BRepCheck_Analyzer(shape,true);
    const v=(typeof a.IsValid_2==='function')?a.IsValid_2()
           :(typeof a.IsValid==='function')?a.IsValid()
           :(typeof a.IsValid_1==='function')?a.IsValid_1(shape):null;
    _occtDrop(a); return v;
  }catch(_){ return null; }   // API différente → on retombe sur les autres gardes
}
// Longueur d'une arête OCCT (corde sommet→sommet — suffisant pour trier les
// arêtes trop courtes pour accueillir R).
function _occtEdgeLen(oc, edge){
  try{
    const a=oc.BRep_Tool.Pnt(oc.TopExp.FirstVertex(edge,false));
    const b=oc.BRep_Tool.Pnt(oc.TopExp.LastVertex(edge,false));
    const d=Math.hypot(a.X()-b.X(),a.Y()-b.Y(),a.Z()-b.Z());
    _occtDrop(a,b); return d;
  }catch(_){ return Infinity; }  // dans le doute on garde l'arête
}
// Échelle de repli — essayée dans l'ordre jusqu'au premier résultat VALIDE.
// f = facteur sur R demandé ; skip = ignorer les arêtes plus courtes que skip×R
// (celles qui ne peuvent physiquement pas accueillir le congé), 0 = tout garder.
const _OCCT_FALLBACK=[
  {f:1,    skip:0},
  {f:1,    skip:2},
  {f:0.6,  skip:2},
  {f:0.4,  skip:2},
  {f:0.25, skip:2},
  {f:0.15, skip:0}
];
// Une tentative = un MakeFillet/MakeChamfer complet + validation.
// Renvoie {ok, shape, mk, R, nAdded, nSkipped, nEdges, why}.
function _occtAttempt(oc, unified, R, skipK, round, volBefore, keepSegs, segOnEdge){
  const mk=round
    ?new oc.BRepFilletAPI_MakeFillet(unified,oc.ChFi3d_FilletShape.ChFi3d_Rational)
    :new oc.BRepFilletAPI_MakeChamfer(unified);
  const minLen=skipK>0?skipK*R:0;
  let nEdges=0,nAdded=0,nSkipped=0;
  const ex=new oc.TopExp_Explorer_2(unified,oc.TopAbs_ShapeEnum.TopAbs_EDGE,oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while(ex.More()){
    const edge=oc.TopoDS.Edge_1(ex.Current());
    nEdges++;
    let take=true;
    if(keepSegs){
      const vF=oc.TopExp.FirstVertex(edge,false),vL=oc.TopExp.LastVertex(edge,false);
      const pF=oc.BRep_Tool.Pnt(vF),pL=oc.BRep_Tool.Pnt(vL);
      const v1={x:pF.X(),y:pF.Y(),z:pF.Z()},v2={x:pL.X(),y:pL.Y(),z:pL.Z()};
      _occtDrop(pF,pL,vF,vL);
      take=keepSegs.some(s=>segOnEdge(v1,v2,s.p0,s.p1));
    }
    if(take&&minLen>0&&_occtEdgeLen(oc,edge)<minLen){ take=false; nSkipped++; }
    if(take){ mk.Add_2(R,edge); nAdded++; }
    _occtDrop(edge);
    ex.Next();
  }
  _occtDrop(ex);
  if(!nAdded){ _occtDrop(mk); return {ok:false,nEdges,nAdded,nSkipped,why:'no edge left to fillet'}; }
  try{ mk.Build(); }
  catch(err){ const m=(err&&err.message)||String(err); _occtDrop(mk); return {ok:false,nEdges,nAdded,nSkipped,why:m,raw:err}; }
  if(!mk.IsDone()){ _occtDrop(mk); return {ok:false,nEdges,nAdded,nSkipped,why:'kernel Build failed'}; }
  const shape=mk.Shape();
  // Deux vérités indépendantes, parce que IsDone()===true ne garantit rien :
  //  · le B-Rep est-il topologiquement valide (BRepCheck_Analyzer) ;
  //  · un congé/chanfrein ne peut QU'ENLEVER de la matière — un volume qui
  //    augmente est la signature d'un solide auto-intersecté ou retourné.
  //    Mesuré : plaque 60×4×40 (9 600 mm³) filetée R=3 → IsDone=true et
  //    volume 15 328 mm³. Cas que le check mesh-side laissait passer.
  const vol=_occtVolume(oc,shape);
  const valid=_occtIsValid(oc,shape);
  const grew=isFinite(vol)&&isFinite(volBefore)&&vol>volBefore*1.001;
  if(valid===false||grew){
    _occtDrop(shape,mk);
    return {ok:false,nEdges,nAdded,nSkipped,
      why:grew?`result volume grew ${volBefore.toFixed(0)} → ${vol.toFixed(0)} mm³ (self-intersecting solid)`
              :'BRepCheck_Analyzer rejected the resulting B-Rep'};
  }
  return {ok:true,shape,mk,R,nEdges,nAdded,nSkipped,vol};
}

async function _occtFilletAll(selectedOnly){
  const obj=_qfSrcObj;
  if(!obj){_qfSetStatus('⚠ Select an object first','var(--danger)');return;}
  if(selectedOnly&&_qfOcctSel.size===0){
    _qfSetStatus('⚠ Click "🖱 Pick edges" then select at least one edge','var(--danger)');
    return;
  }
  const R=Math.max(0.05,parseFloat(document.getElementById('qf-vp').value)||3);
  const mode=_qfMode;
  // [NEW 25/07] Empêcher le calcul plutôt que le laisser planter — les deux
  // causes identifiées (R trop grand, re-fillet sur courbe) sont maintenant
  // des gates actifs avant le moindre appel kernel, pas des warnings passifs.
  const _chainsToCheck=selectedOnly?[..._qfOcctSel].map(i=>_qfChains[i]).filter(Boolean):_qfChains;
  const _rIssue=_qfCheckRadiusFits(_chainsToCheck,R);
  if(_rIssue){
    const _ok=confirm(`⚠ R=${R}mm seems too large for at least one edge `
      +`(${_rIssue.segLen.toFixed(2)}mm, angle ${_rIssue.angDeg.toFixed(0)}°, `
      +`recommended R ≤ ${_rIssue.maxR.toFixed(2)}mm).\n\n`
      +`The OCCT kernel will likely fail or produce an invalid result.\n\n`
      +`Continue anyway?`);
    if(!_ok){ _qfSetStatus('⚠ Cancelled — R too large for the local geometry','var(--warn)'); return; }
    nasLog('WARN',`OCCT: R=${R}mm beyond the recommended R ${_rIssue.maxR.toFixed(2)}mm — proceeding after confirmation`);
  }
  if(obj.isOcctResult){
    const _ok2=confirm(`⚠ This object is already an OCCT fillet/chamfer result.\n\n`
      +`Re-filleting on top of it is a known kernel edge case: it can succeed, `
      +`fail cleanly, or (more insidiously) appear to succeed with an `
      +`invisible gap in the mesh.\n\n`
      +`Better: go back to the original object (before any fillet) and select `
      +`all the edges you want in a single pass.\n\n`
      +`Continue anyway on this already-filleted object?`);
    if(!_ok2){ _qfSetStatus('⚠ Cancelled — go back to the original object to avoid the edge case','var(--warn)'); return; }
    nasLog('OCCT','⚠ Re-filleting an already-curved OCCT result — the rebuilt B-Rep may hit a kernel edge case (see fallback below if it fails)');
  }
  // World-space non-indexed geometry — same transform pattern as _qfScanChains
  obj.mesh.updateMatrixWorld(true);
  let geo=(obj.type==='csg')?obj.mesh.geometry.clone():makeGeoCSG(obj);
  {
    const _p=new THREE.Vector3(),_q=new THREE.Quaternion(),_s=new THREE.Vector3();
    obj.mesh.matrixWorld.decompose(_p,_q,_s);
    const _m=(obj.type==='csg')
      ?new THREE.Matrix4().compose(_p,_q,_s)
      :(()=>{const m=new THREE.Matrix4().makeRotationFromQuaternion(_q);m.setPosition(_p);return m;})();
    geo.applyMatrix4(_m);
  }
  if(geo.index)geo=geo.toNonIndexed();
  const pos=geo.attributes.position.array,nTris=(pos.length/9)|0;
  const bb=new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(pos,3));
  const diag=bb.getSize(new THREE.Vector3()).length();
  if(nTris>_OCCT_MAX_TRIS){
    _qfSetStatus(`⚠ ${nTris} triangles > ${_OCCT_MAX_TRIS} limit`,'var(--danger)');
    nasLog('WARN',`OCCT: ${nTris} tris exceeds limit ${_OCCT_MAX_TRIS}`);
    geo.dispose();return;
  }
  // Selective mode: flatten the picked chains (world-space, same frame as
  // the mesh) into a segment list [{p0,p1}]. Matching against OCCT edges
  // is geometric (endpoint/collinearity test), not index-based — robust
  // to UnifySameDomain merging several mesh sub-segments into one edge.
  let keepSegs=null;
  if(selectedOnly){
    keepSegs=[];
    for(const idx of _qfOcctSel){
      const c=_qfChains[idx];
      const n=c.pts.length,nSeg=c.closed?n:n-1;
      for(let i=0;i<nSeg;i++)keepSegs.push({p0:c.pts[i],p1:c.pts[(i+1)%n]});
    }
  }
  let oc;
  try{oc=await _occtLoad();}
  catch(e){
    geo.dispose();
    _qfSetStatus('⚠ Kernel unavailable — '+(e&&e.message||e),'var(--danger)');
    nasLog('WARN','OCCT load: '+(e&&e.message||e));return;
  }
  // [FIX 25/07] Guards tous passés (obj/edges/tris/kernel) → même politique que doCSG :
  // push undo une fois qu'on sait qu'on tente réellement l'opération, pas avant (évite un
  // slot vide sur un early-return). Sans ça, _occtFilletAll ne poussait JAMAIS d'undo :
  // Ctrl+Z après un fillet sautait par-dessus et annulait l'opération PRÉCÉDENTE à la place
  // (ex: le CSG Union) — cf. logs 06:31:16 "undo [CSG]" déclenché juste après un fillet.
  undoPush(mode==='round'?'fillet':'chamfer');
  showSpinner('OCCT '+(mode==='round'?'Fillet':'Chamfer'),`${nTris} tris → B-Rep — all edges R=${R}`);
  await new Promise(r=>setTimeout(r,30)); // let the spinner paint (OCCT runs sync on main thread)
  const t0=performance.now();
  const _keep=[];                       // instances embind vivantes jusqu'au finally
  try{
    // 1. triangles → wires → planar faces → sewing (tolerance welds borders)
    //    [FIX 04/09] chaque gp_Pnt / MakePolygon / MakeFace / Face est libéré dès
    //    qu'il est copié dans le sewing — 4 objets embind par triangle, soit
    //    200 000 fuites par passe à la limite de 50 000 triangles.
    const sew=new oc.BRepBuilderAPI_Sewing(1e-4,true,true,true,false);
    _keep.push(sew);
    for(let i=0;i<pos.length;i+=9){
      const q0=new oc.gp_Pnt_3(pos[i],pos[i+1],pos[i+2]);
      const q1=new oc.gp_Pnt_3(pos[i+3],pos[i+4],pos[i+5]);
      const q2=new oc.gp_Pnt_3(pos[i+6],pos[i+7],pos[i+8]);
      const poly=new oc.BRepBuilderAPI_MakePolygon_3(q0,q1,q2,true);
      if(poly.IsDone()){
        const mf=new oc.BRepBuilderAPI_MakeFace_15(poly.Wire(),true);
        const fc=mf.Face();
        sew.Add(fc);                    // le sewing en garde sa propre copie
        _occtDrop(fc,mf);
      }
      _occtDrop(poly,q0,q1,q2);
    }
    const prog=new oc.Handle_Message_ProgressIndicator_1();
    sew.Perform(prog);
    _occtDrop(prog);
    const tSew=performance.now();
    // 2. shell → solid → UnifySameDomain (coplanar facets → real faces)
    const shell=oc.TopoDS.Shell_1(sew.SewedShape());
    const mkSolid=new oc.BRepBuilderAPI_MakeSolid_3(shell);
    const solid=mkSolid.Solid();
    const unify=new oc.ShapeUpgrade_UnifySameDomain_2(solid,true,true,true);
    unify.Build();
    const unified=unify.Shape();
    _keep.push(unify,unified);
    _occtDrop(shell,mkSolid,solid);
    const tUnify=performance.now();
    // Volume de référence : un congé ou un chanfrein ne peut qu'en retirer.
    const volBefore=_occtVolume(oc,unified);
    // 3. Add edges — ALL of them, or only those matching the picked chains
    //    (edges shared by 2 faces are explored twice — OCCT merges
    //    duplicates into one contour, harmless and validated).
    //    Match test: geometric, not index-based (robust to UnifySameDomain
    //    merging several mesh sub-segments into one longer OCCT edge —
    //    a picked segment can be an interior sub-part of a merged edge).
    const segTol=Math.max(0.02,diag*0.0015);
    const segOnEdge=(v1,v2,p0,p1)=>{
      const dx=v2.x-v1.x,dy=v2.y-v1.y,dz=v2.z-v1.z,len2=dx*dx+dy*dy+dz*dz;
      if(len2<1e-9)return false;
      const proj=p=>{
        const t=((p.x-v1.x)*dx+(p.y-v1.y)*dy+(p.z-v1.z)*dz)/len2;
        return {t,d:Math.hypot(p.x-(v1.x+dx*t),p.y-(v1.y+dy*t),p.z-(v1.z+dz*t))};
      };
      const r0=proj(p0),r1=proj(p1);
      return r0.d<segTol&&r1.d<segTol&&r0.t>-0.02&&r0.t<1.02&&r1.t>-0.02&&r1.t<1.02;
    };
    // [NEW 04/09] Échelle de repli au lieu d'un throw sec. Un Build en échec
    // n'est plus une erreur terminale : on retente en écartant les arêtes trop
    // courtes pour accueillir R (typiquement les micro-arêtes de couture d'une
    // union CSG), puis en réduisant R. Chaque tentative est validée par
    // BRepCheck_Analyzer ET par l'invariant de volume avant d'être retenue —
    // un "succès" qui gonfle le volume est rejeté comme un échec.
    // Budget de temps : la ligne de repli s'arrête si le cumul dépasse 6× la
    // première tentative (plancher 8 s), pour ne jamais transformer une pièce
    // lourde en gel d'interface.
    let att=null,attempts=[],tLadder0=performance.now(),budget=0;
    for(let k=0;k<_OCCT_FALLBACK.length;k++){
      const st=_OCCT_FALLBACK[k], Rk=R*st.f;
      if(Rk<0.02) break;
      const tA=performance.now();
      const a=_occtAttempt(oc,unified,Rk,st.skip,mode==='round',volBefore,keepSegs,segOnEdge);
      const dtA=performance.now()-tA;
      if(k===0) budget=Math.max(8000,dtA*6);
      attempts.push(`R=${Rk.toFixed(3)}${st.skip?` skip<${(st.skip*Rk).toFixed(2)}mm`:''} → ${a.ok?'valid':a.why} (${Math.round(dtA)}ms)`);
      if(a.ok){ att=a; break; }
      if(keepSegs&&a.nAdded===0&&!a.nSkipped) break;   // la sélection ne matche aucune arête OCCT
      if(_occtIsFatal(a.why)) throw new Error(a.why);   // module mort → sortie immédiate
      if(performance.now()-tLadder0>budget){
        nasLog('WARN','OCCT: fallback ladder stopped on time budget after '+attempts.length+' attempt(s)');
        break;
      }
    }
    if(!att){
      if(keepSegs&&attempts.length===1&&/no edge left/.test(attempts[0]))
        throw new Error('no OCCT edge matched the picked selection — try picking again');
      throw new Error(`kernel could not build a valid ${mode==='round'?'fillet':'chamfer'} at R=${R} `
        +`nor at any reduced radius — ${attempts.join(' | ')}`);
    }
    const result=att.shape, nEdges=att.nEdges, nKept=att.nAdded, Reff=att.R;
    _keep.push(att.mk,result);
    const tFillet=performance.now();
    if(attempts.length>1){
      const dropped=att.nSkipped?` and left ${att.nSkipped} edge(s) sharp (shorter than ${(2*Reff).toFixed(2)}mm)`:'';
      _qfSetStatus(`⚠ R=${R} impossible here — applied R=${Reff.toFixed(2)}${dropped}`,'var(--warn)');
      nasLog('WARN',`OCCT: R=${R} rejected by the kernel — fell back to R=${Reff.toFixed(3)} on ${nKept}/${nEdges} edges${dropped}`);
      nasLog('DBG','  ladder: '+attempts.join(' | '));
    }
    const _brepInvalid=false;   // déjà validé dans _occtAttempt (B-Rep + volume)
    // 4. B-Rep → triangles. Deflection derived from R and the Segments
    // slider — same physical quantity as the mesh sweep path: sagitta of
    // an arc of radius R split into N segments ≈ R·π²/(2N²). This makes
    // "Segments" mean the same thing in both engines (8 = coarse facets,
    // 192 = near-smooth), instead of an object-size heuristic the slider
    // had zero effect on. Clamped to avoid pathological mesh sizes on
    // extreme R/segments combos.
    const arcSegs=Math.max(3,Math.min(192,Math.round(_qfSegs)));
    const sagitta=Reff*Math.PI*Math.PI/(2*arcSegs*arcSegs);
    const defl=Math.min(0.5,Math.max(0.005,sagitta));
    const mesher=new oc.BRepMesh_IncrementalMesh_2(result,defl,false,0.5,false);
    const out=[];
    const fex=new oc.TopExp_Explorer_2(result,oc.TopAbs_ShapeEnum.TopAbs_FACE,oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    while(fex.More()){
      const face=oc.TopoDS.Face_1(fex.Current());
      const loc=new oc.TopLoc_Location_1();
      const triH=oc.BRep_Tool.Triangulation(face,loc);
      if(!triH.IsNull()){
        const tri=triH.get(),trsf=loc.Transformation();
        const rev=face.Orientation_1()===oc.TopAbs_Orientation.TopAbs_REVERSED;
        const nv=tri.NbNodes(),nt=tri.NbTriangles(),pts=new Float32Array(nv*3);
        for(let i=1;i<=nv;i++){
          const nd=tri.Node(i), p=nd.Transformed(trsf);
          pts[(i-1)*3]=p.X();pts[(i-1)*3+1]=p.Y();pts[(i-1)*3+2]=p.Z();
          _occtDrop(p,nd);
        }
        for(let i=1;i<=nt;i++){
          const t=tri.Triangle(i);
          let a=t.Value(1),b=t.Value(2),c=t.Value(3);
          if(rev){const w=b;b=c;c=w;}
          out.push(pts[(a-1)*3],pts[(a-1)*3+1],pts[(a-1)*3+2],
                   pts[(b-1)*3],pts[(b-1)*3+1],pts[(b-1)*3+2],
                   pts[(c-1)*3],pts[(c-1)*3+1],pts[(c-1)*3+2]);
          _occtDrop(t);
        }
        _occtDrop(trsf,triH);
      }
      _occtDrop(loc,face);
      fex.Next();
    }
    _occtDrop(fex,mesher);
    if(!out.length)throw new Error('empty triangulation from kernel');
    const tMesh=performance.now();
    // 5. Result object — doCSG pattern, single source consumed
    const rGeo=new THREE.BufferGeometry();
    rGeo.setAttribute('position',new THREE.Float32BufferAttribute(out,3));
    // [FIX 25/07 — "trou" silencieux] mk.IsDone()===true ne garantit pas un B-Rep clos.
    // Cas vécu : re-fileter un résultat déjà courbé refacette la surface de congé
    // précédente en micro-faces planes (perte de la surface analytique exacte) ; la
    // résolution de coin sur cette topologie dense peut laisser un gap local SANS
    // qu'aucune exception ne soit levée côté kernel (build "réussit", mesh troué).
    // Même garde-fou que l'import STEP : weld spatial + check d'adjacence d'arêtes
    // (_weldAndCheckManifold, non-bloquant) + même tentative de cap auto best-effort
    // (_capStepGaps, boucles fermées quasi-planes uniquement) avant de conclure à
    // isManifold=false. Bénéfice bonus : rGeo ressort indexée/dédupliquée au lieu du
    // triangle-soup non-indexé actuel.
    let isManifold=_weldAndCheckManifold(rGeo,3);
    if(!isManifold && rGeo._nakedEdgePairs && rGeo._nakedEdgePairs.length && _capStepGaps(rGeo)){
      isManifold=true;
      nasLog('DBG','OCCT gap filled — mesh now watertight');
    }
    if(_brepInvalid) isManifold=false; // signal B-Rep pré-triangulation, indépendant du check mesh
    if(!isManifold){
      nasLog('WARN',`OCCT ${mode==='round'?'fillet':'chamfer'} result NON-MANIFOLD — ${rGeo._nakedEdges||0} naked edge(s)`
        +(rGeo._overEdges?`, ${rGeo._overEdges} over-valenced`:'')
        +(_brepInvalid?' — BRepCheck_Analyzer flagged the B-Rep invalid pre-triangulation':'')
        +(obj.isOcctResult?' — likely the re-fillet-of-curved-result kernel edge case':'')
        +'. CSG disabled on this object.');
    }
    rGeo.computeVertexNormals();
    const cg=computeCenterOfGravity(rGeo);
    rGeo.translate(-cg.x,-cg.y,-cg.z);
    const _col=_softenColor(obj.color||'#6a8a6a');
    const mat=new THREE.MeshPhongMaterial({color:_col,shininess:8,specular:0x1a1a1a,transparent:true,opacity:1,side:THREE.DoubleSide});
    const rMesh=new THREE.Mesh(rGeo,mat);
    rMesh.position.set(cg.x,cg.y,cg.z);rMesh.castShadow=true;
    scene.add(rMesh);
    objCnt++;
    // Le rayon réellement appliqué apparaît dans le nom quand il diffère du rayon
    // demandé — sans ça l'info disparaît avec le panneau QF à la fermeture.
    const _suffix=(Reff!==R)?('_R'+Reff.toFixed(2)):'';
    const ro={id:objCnt,name:'OCCT_'+(mode==='round'?'Fillet':'Chamfer')+'_'+objCnt+_suffix,type:'csg',mesh:rMesh,isHole:false,color:_col,isOcctResult:true,isManifold};
    if(GeometryPool.initialized){ro._poolSlot=GeometryPool.geoStore(rGeo);updPoolStats();}
    scene.remove(obj.mesh);obj.mesh.geometry.dispose();obj.mesh.material.dispose();
    objs=objs.filter(x=>x!==obj);
    objs.push(ro);selObjs=[ro];
    updProps();updOList();updStats();
    const dt=Math.round(performance.now()-t0);
    const _fmtMs=ms=>ms<1000?Math.round(ms)+'ms':(ms/1000).toFixed(1)+'s';
    nasLog('OCCT',`✓ ${mode==='round'?'fillet':'chamfer'} ${keepSegs?nKept+'/'+nEdges+' picked edges':'ALL edges ('+nEdges+' explored)'} R=${Reff}${Reff!==R?` (requested ${R})`:''} — ${nTris}→${(out.length/9)|0} tris, defl=${defl.toFixed(3)} — ⏱ ${_fmtMs(dt)}`);
    nasLog('DBG',`  detail: sewing ${_fmtMs(tSew-t0)} · unify ${_fmtMs(tUnify-tSew)} · ${mode==='round'?'fillet':'chamfer'} ${_fmtMs(tFillet-tUnify)} · meshing ${_fmtMs(tMesh-tFillet)}`);
    _qfExit();
  }catch(e){
    const raw=String(e&&e.message||e);
    // [04/09] Ce build d'opencascade.js ne déclarait pas __cxa_is_pointer_type /
    // __cxa_can_catch : toute exception C++ d'OCCT remontait en ReferenceError
    // opaque. _occtGetFactory() injecte désormais les deux symboles, donc ce
    // message ne devrait plus jamais apparaître — on le garde pour signaler net
    // que le patch n'a pas pris (ancre introuvable, loader régénéré, etc.).
    const isOpaqueRuntime=/^_+cxa_|^___|is not defined$/.test(raw)&&/cxa|dynamic_cast|RTTI/i.test(raw);
    const msg=isOpaqueRuntime
      ?`Kernel exception ABI not patched (${raw}) — the loader signature changed, the fix in _occtGetFactory() needs a new anchor.`
      :raw;
    _qfSetStatus('⚠ '+msg,'var(--danger)');
    nasLog('ERROR','OCCT: '+msg+(isOpaqueRuntime?' [raw: '+raw+']':''));
    // Module WASM mort (heap saturé, abort) → on le jette pour que la prochaine
    // opération reparte sur une instance saine, sans recharger la page ni
    // re-télécharger les 65 Mo (binaire en cache).
    if(_occtIsFatal(raw)||isOpaqueRuntime) _occtResetKernel(raw);
  }finally{
    _occtDrop(..._keep);
    geo.dispose();hideSpinner();
  }
}
// ══ Fin OCCT All-Edges Fillet ═════════════════════════════════════════════
