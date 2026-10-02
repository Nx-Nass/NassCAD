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
//   _genKey                                                        — helper des champs numériques
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
//
//   ⚠ COUPLAGE VERS LE HOST (UI) : le modal #qf-modal du host doit contenir les
//     ids utilisés par _qfSyncUI() (qf-sub-fillet, qf-sub-chamfer, qf-law-*,
//     qf-ct-*, qf-sp2/qf-vp2, qf-swap, qf-cm-*, qf-vc, qf-groups, qf-grp-add).
//     Tous les accès DOM sont gardés (?./if(el)) : un host v4 sans ces ids
//     continue de fonctionner en congé/chanfrein simples.
// ══════════════════════════════════════════════════════════════════════════
// ══ QUICK FILLET v5 (28/09) — types de finition, coins/extrémités, groupes ══
// Référence : planche "FINITIONS D'ARÊTES" de Nass (congé, chanfrein, coins
// arrondis, coins biseautés, double finition, congé variable, chanfrein
// intérieur, multiples congés, chanfrein 5×30°).
//
//  · Congé : R constant, ou VARIABLE R1→R2 (loi linéaire OCCT Add(R1,R2,E) ;
//    R1 du côté où l'on a cliqué l'arête ; boucle fermée → R1→R2→R1 via
//    Add(UandR,E) — une loi linéaire y serait discontinue).
//  · Chanfrein : les 4 méthodes du noyau (API identique d'OCCT 7.4 à 8.0.x) —
//      d×45°  (ChFiDS_Sym)           Add(d,E)
//      d1×d2  (ChFiDS_TwoDist)       Add(d1,d2,E,F)   d1 sur la face de réf. F
//      d×α    (ChFiDS_DistAngle)     AddDA(d,α,E,F)   d sur F, α entre chanfrein et F
//      gorge a (ChFiDS_ConstThroat[WithPenetration]Chamfer, OCCT ≥ 7.4) —
//             hauteur constante de la section, + pénétration p optionnelle.
//    Face de référence F = la face CLIQUÉE au pick ; sinon la plus horizontale
//    (dessus/dessous) ; ⇄ l'inverse. Conventions mesurées sur le noyau :
//    chanfrein 3×30° réf. dessus → 3,000 sur le dessus, 1,732 = 3·tan30° sur le côté.
//  · Coins / extrémités (arêtes verticales) : Idem | Vif | Arrondi Rc | Biseau c×45°.
//    Arrondi/Biseau = passe B-Rep n°1 sur les coins, PUIS la finition des
//    arêtes sur le résultat B-Rep (passe 2) : le chanfrein du dessus contourne
//    alors l'arrondi du coin (propagation tangente OCCT) → "double finition".
//  · Groupes : "＋ Group" fige les arêtes piquées avec la finition courante ;
//    on pique ensuite d'autres arêtes pour une autre finition (multiples congés
//    R4/R6, congé + chanfrein…). Tout part en UN calcul, multi-passes B-Rep,
//    sans retour au maillage entre deux passes (fini le "re-congé sur résultat
//    facetté" pour enchaîner deux finitions).
//  · Garde-fous : recensement B-Rep des arêtes (vives ≥ 20°, convexes/concaves,
//    tangentes G1 écartées), invariant de volume BORNÉ et mesuré sur la
//    TRIANGULATION (BRepGProp se trompe sur les congés qui suivent un contour
//    facetté : faux "volume grew" qui faisait échouer la v4 sur un simple
//    cylindre res 32 ; et le congé concave ajoute de la matière — l'ancien test
//    le rejetait), repli : micro-arêtes/faces lamelles laissées vives
//    (diagnostic OCCT NbFaultyContours), puis réduction uniforme + bissection
//    → la plus grande taille réalisable.
//  · Affichage : normales par face OCCT → un chanfrein se voit plat, un congé
//    lisse (la v4 moyennait les normales à travers les arêtes vives).
//  · Panneau élargi à 380 px (validé par Nass) : pictogrammes des profils,
//    préréglages ①–⑥ de la planche, sections Finish / Corners / Edges.
// ══════════════════════════════════════════════════════════════════════════
// ══ Quick Fillet — état partagé pour le scan/highlight d'arêtes OCCT ═════
// Détecte les chaînes d'arêtes vives de l'objet sélectionné (convexe/
// concave), les affiche en tubes colorés, et sert de base au picking
// sélectif OCCT (drag-paint + présélection Top/Bottom). Le sweep-cutter
// mesh d'origine (v2→v4.3) a été retiré le 21/07 — tout fillet/chamfer
// passe désormais par le kernel B-Rep OCCT (_occtFilletAll).

// ── [FIX 05/09 — Nass] Meme couple (geo, matrice) que dans le host ──────────
// makeGeoCSG ne reconstruit plus les types qu'il ne connait pas (hollowbox et
// tout type futur) : il rend la geo d'affichage BRUTE, qui a besoin de la
// matrice monde COMPLETE, scale inclus. Le test `type==='csg'` d'origine
// aurait donc perdu le scale d'une boite creuse redimensionnee.
function _qfCanRebuild(o){
  return (typeof _csgCanRebuild === 'function')
    ? _csgCanRebuild(o)
    : (o && o.type !== 'csg');
}
let _qfActive     = false;
let _qfSrcObj     = null;      // objet source
let _qfChains     = [];        // chaînes courbes {pts,segN1,segN2,convex,closed,len,cum,vertical}
let _qfEdgeTubes  = [];        // Groups de tubes colorés permanents (1 Group/chaîne)
let _qfHoverMesh  = null;      // Group hover blanc (chaîne survolée entière)
let _qfHoverEdge  = null;      // chaîne actuellement survolée
let _qfHoverS     = 0;         // abscisse curviligne du point snappé sur _qfHoverEdge
let _qfSegs       = 32;
let _qfMode       = 'round';   // 'round' | 'chamfer'  (miroir de _qfFin.kind, gardé pour compat)
let _qfOcctPick   = false;     // true : le clic toggle une arête dans la sélection OCCT
let _qfOcctSel    = new Set(); // indices dans _qfChains retenus pour le fillet OCCT sélectif
let _qfOcctSelTubes = new Map(); // idx chain -> Group de tubes doré persistant
let _qfDragSel    = false;     // true : bouton maintenu, on "peint" la sélection en glissant
let _qfDragAdding = true;      // direction figée au premier clic du drag (ajoute ou retire)
let _qfDragLastIdx= -1;        // dernière chaîne traitée pendant CE drag (évite le spam)
// [v5] Pinceau de finition courant. Une seule structure pour tous les champs :
// changer de type ne perd pas les valeurs des autres (R ≠ d ≠ α…).
let _qfFin = {kind:'fillet', law:'const', R:3, R2:6, type:'sym', d:3, d2:5, ang:30, pen:0, swap:false};
let _qfCorner = {mode:'idem', size:5};   // coins/extrémités : 'idem'|'vif'|'round'|'chamfer'
let _qfGroups = [];                      // groupes figés [{fin, idx:Set, info:Map, tubes:Map}]
let _qfPickInfo = new Map();             // idx chaîne -> {pt, n} point + normale de face cliqués (monde)
let _qfLastHit = null;                   // dernier point survolé sur la pièce {pt, n}
let _qfCornerTubes = [];                 // aperçu violet des coins traités automatiquement
const _QF_COL_PICK=0xffd23f, _QF_COL_GFIL=0xff9f1c, _QF_COL_GCHA=0x3ec9f0, _QF_COL_CORNER=0xc77dff;

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
    _qfSyncUI();
    // [v5] modal plus haut : on se cale sur sa hauteur réelle au lieu de 300 px
    const h=m.offsetHeight||600, w=m.offsetWidth||380;
    m.style.left=Math.max(196,innerWidth-w-20)+'px';
    m.style.top=Math.max(34,innerHeight-h-32)+'px'; }
  _qfScanAndShow();
  nasLog('QF','Quick Fillet v5 — fillet const/variable · chamfer d×45° / d1×d2 / d×α / throat · corners · groups');
}

function _qfMakeTube(edge, mat, rMul){
  const a=new THREE.Vector3(edge.v0.x,edge.v0.y,edge.v0.z);
  const b=new THREE.Vector3(edge.v1.x,edge.v1.y,edge.v1.z);
  const len=a.distanceTo(b);
  const r=Math.min(Math.max(len*0.010,0.07),0.4)*(rMul||1);
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
function _qfMakeChainGroup(pts, closed, mat, rMul){
  const grp=new THREE.Group();
  const n=pts.length, nSeg=closed?n:n-1;
  for(let i=0;i<nSeg;i++){
    grp.add(_qfMakeTube({v0:pts[i],v1:pts[(i+1)%n]},mat,rMul));
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
  _qfSetStatus(_qfOcctPick?'🖱 Click the edges to finish (click again to remove) — the face you click is the reference face':'Select an object then ⌐R');
}
// Nombre total d'arêtes à traiter en mode sélection (piquées + groupes figés)
function _qfSelCount(){
  let n=_qfOcctSel.size;
  for(const g of _qfGroups) n+=g.idx.size;
  return n;
}
function _qfUpdSelBtn(){
  const n=_qfSelCount();
  const btn=document.getElementById('qf-occt-sel');
  if(btn){btn.textContent=`⬡ Apply selection (${n})`;btn.disabled=(n===0);}
  const ga=document.getElementById('qf-grp-add');
  if(ga) ga.disabled=(_qfOcctSel.size===0);
}
// Retire une chaîne d'un groupe figé (et son tube coloré)
function _qfGroupDropIdx(g, idx){
  if(!g.idx.has(idx)) return false;
  g.idx.delete(idx); g.info.delete(idx);
  const t=g.tubes.get(idx); if(t){ _qfDisposeGroup(t); g.tubes.delete(idx); }
  return true;
}
// Version directionnelle (add=true/false) — nécessaire pour le drag-paint :
// un toggle pur ferait clignoter la sélection si le curseur repasse deux
// fois sur la même arête pendant un même geste de glisser.
// [v5] À l'ajout on mémorise le point + la normale de la face survolée
// (_qfLastHit) : face de référence des chanfreins asymétriques et extrémité R1
// des congés variables. Piquer une arête d'un groupe figé la "re-tamponne"
// avec la finition courante (elle quitte son groupe).
function _qfOcctSetSel(idx, add){
  if(idx<0||idx>=_qfChains.length) return;
  const already=_qfOcctSel.has(idx);
  if(add===already) return; // déjà dans l'état voulu, rien à faire
  if(!add){
    _qfOcctSel.delete(idx); _qfPickInfo.delete(idx);
    const g=_qfOcctSelTubes.get(idx);
    if(g){_qfDisposeGroup(g);_qfOcctSelTubes.delete(idx);}
  }else{
    let moved=false;
    for(const g of _qfGroups) moved=_qfGroupDropIdx(g,idx)||moved;
    if(moved){ _qfGroups=_qfGroups.filter(g=>g.idx.size); _qfRenderGroups(); }
    _qfOcctSel.add(idx);
    if(_qfLastHit) _qfPickInfo.set(idx,{pt:{x:_qfLastHit.pt.x,y:_qfLastHit.pt.y,z:_qfLastHit.pt.z},
                                        n:_qfLastHit.n?{x:_qfLastHit.n.x,y:_qfLastHit.n.y,z:_qfLastHit.n.z}:null});
    const c=_qfChains[idx];
    const mat=new THREE.MeshBasicMaterial({color:_QF_COL_PICK,depthTest:false,transparent:true,opacity:0.9});
    const g=_qfMakeChainGroup(c.pts,c.closed,mat);
    scene.add(g); _qfOcctSelTubes.set(idx,g);
  }
  _qfUpdSelBtn(); _qfUpdCornerPreview();
  const n=_qfOcctSel.size;
  _qfSetStatus(`${n} edge(s) picked · ${_qfFinLabel(_qfCurFinish())}`
    +(_qfGroups.length?` + ${_qfGroups.length} group(s)`:'')+' — ＋Group to freeze, Apply to run');
  _camDirty=true;
}
// Présélection par zone — "Top"/"Bottom" ajoutent toutes les chaînes dont
// TOUS les points sont proches du Y max/min de la bbox monde de l'objet
// (donc le contour d'une face plate, pas une arête verticale qui relie
// les deux et dont les points s'étalent sur toute la hauteur). Idée Nass
// 21/07. Tolérance relative à la diagonale, cohérente avec le reste du code.
// [v5] + 'corners' (toutes les arêtes verticales : coins extérieurs ET
// intérieurs — planche ③/④) et 'concave' (arêtes rentrantes : fonds de
// poche, marches, coins intérieurs).
function _qfPresetZone(zone){
  if(!_qfChains.length||!_qfSrcObj) return;
  const bb=_bboxCache.get(_qfSrcObj.mesh)||new THREE.Box3().setFromObject(_qfSrcObj.mesh);
  const diag=bb.getSize(new THREE.Vector3()).length();
  const tol=Math.max(0.05,diag*0.01);
  const targetY=(zone==='top')?bb.max.y:bb.min.y;
  const pick=(zone==='corners')?(c=>c.vertical)
            :(zone==='concave')?(c=>!c.convex)
            :(c=>c.pts.every(p=>Math.abs(p.y-targetY)<tol));
  const saveHit=_qfLastHit; _qfLastHit=null;   // pas de face "cliquée" pour une présélection
  let n=0;
  _qfChains.forEach((c,idx)=>{
    if(pick(c)&&!_qfOcctSel.has(idx)){ _qfOcctSetSel(idx,true); n++; }
  });
  _qfLastHit=saveHit;
  const names={top:'top',bottom:'bottom',corners:'corner (vertical)',concave:'concave'};
  _qfSetStatus(n?`${n} ${names[zone]||zone} edge(s) added · ${_qfFinLabel(_qfCurFinish())}`:`⚠ No ${names[zone]||zone} edge found`,n?'var(--success)':'var(--warn)');
}
function _qfOcctClearSel(){
  for(const g of _qfOcctSelTubes.values()) _qfDisposeGroup(g);
  _qfOcctSelTubes.clear(); _qfOcctSel.clear(); _qfPickInfo.clear();
  _qfDragSel=false; _qfDragLastIdx=-1;
  _qfUpdSelBtn();
  _qfOcctPick=false;
  document.getElementById('qf-occtpick')?.classList.remove('active');
}
function _qfGroupsClear(){
  for(const g of _qfGroups) for(const t of g.tubes.values()) _qfDisposeGroup(t);
  _qfGroups=[]; _qfRenderGroups(); _qfUpdSelBtn();
}
// Bouton ⌫ : vide piquées + groupes, SANS quitter le mode pick
function _qfSelClearAll(){
  for(const g of _qfOcctSelTubes.values()) _qfDisposeGroup(g);
  _qfOcctSelTubes.clear(); _qfOcctSel.clear(); _qfPickInfo.clear();
  _qfGroupsClear(); _qfUpdCornerPreview(); _qfUpdSelBtn();
  _qfSetStatus('Selection cleared'); _camDirty=true;
}
// ── Groupes figés : même arêtes → même finition, plusieurs finitions → 1 calcul
function _qfGroupAdd(){
  if(!_qfOcctSel.size){ _qfSetStatus('⚠ Pick edges first, then ＋Group freezes them with the current finish','var(--warn)'); return; }
  const fin=_qfCurFinish();
  const g={fin, idx:new Set(_qfOcctSel), info:new Map(), tubes:new Map()};
  for(const i of g.idx) if(_qfPickInfo.has(i)) g.info.set(i,_qfPickInfo.get(i));
  for(const t of _qfOcctSelTubes.values()) _qfDisposeGroup(t);
  _qfOcctSelTubes.clear(); _qfOcctSel.clear(); _qfPickInfo.clear();
  const col=fin.kind==='fillet'?_QF_COL_GFIL:_QF_COL_GCHA;
  for(const i of g.idx){
    const c=_qfChains[i];
    const mat=new THREE.MeshBasicMaterial({color:col,depthTest:false,transparent:true,opacity:0.85});
    const t=_qfMakeChainGroup(c.pts,c.closed,mat); scene.add(t); g.tubes.set(i,t);
  }
  _qfGroups.push(g);
  _qfRenderGroups(); _qfUpdSelBtn(); _qfUpdCornerPreview();
  _qfSetStatus(`Group ${_qfGroups.length} frozen: ${_qfFinLabel(fin)} ×${g.idx.size} — change the finish and pick other edges`,'var(--success)');
  _camDirty=true;
}
function _qfGroupRemove(k){
  const g=_qfGroups[k]; if(!g) return;
  for(const t of g.tubes.values()) _qfDisposeGroup(t);
  _qfGroups.splice(k,1);
  _qfRenderGroups(); _qfUpdSelBtn(); _qfUpdCornerPreview(); _camDirty=true;
}
function _qfRenderGroups(){
  const el=document.getElementById('qf-groups'); if(!el) return;
  el.innerHTML=''; el.style.display=_qfGroups.length?'flex':'none';
  _qfGroups.forEach((g,k)=>{
    const chip=document.createElement('span');
    chip.className='qf-chip '+g.fin.kind;
    chip.title=(g.fin.kind==='fillet'?'Fillet':'Chamfer')+' group — ✕ to remove';
    chip.textContent=`${k+1}· ${_qfFinLabel(g.fin)} ×${g.idx.size}`;
    const x=document.createElement('button'); x.textContent='✕'; x.onclick=()=>_qfGroupRemove(k);
    chip.appendChild(x); el.appendChild(chip);
  });
}
// ── Coins automatiques (mode sélection, Coins = Arrondi/Biseau) ──────────────
// Arêtes verticales NON piquées qui touchent une arête piquée non verticale :
// ce sont les "extrémités" des arêtes finies. Aperçu violet avant calcul ; le
// noyau refait le même test sur le B-Rep (source de vérité).
function _qfSelEntries(){
  const out=[];
  for(const g of _qfGroups) for(const i of g.idx) out.push(i);
  for(const i of _qfOcctSel) out.push(i);
  return out;
}
function _qfAutoCornerIdx(selIdx){
  if(!_qfSrcObj||!_qfChains.length) return [];
  const set=new Set(selIdx);
  const others=selIdx.map(i=>_qfChains[i]).filter(c=>c&&!c.vertical);
  if(!others.length) return [];
  const bb=_bboxCache.get(_qfSrcObj.mesh)||new THREE.Box3().setFromObject(_qfSrcObj.mesh);
  const tol=Math.max(0.05,bb.getSize(new THREE.Vector3()).length()*0.002);
  const out=[];
  _qfChains.forEach((c,i)=>{
    if(!c.vertical||set.has(i)) return;
    const e0=c.pts[0], e1=c.pts[c.pts.length-1];
    if(others.some(o=>_qfDistPtPoly(e0,o.pts,o.closed)<tol||_qfDistPtPoly(e1,o.pts,o.closed)<tol)) out.push(i);
  });
  return out;
}
function _qfUpdCornerPreview(){
  for(const g of _qfCornerTubes) _qfDisposeGroup(g);
  _qfCornerTubes=[];
  if(!_qfActive||(_qfCorner.mode!=='round'&&_qfCorner.mode!=='chamfer')) { _camDirty=true; return; }
  for(const i of _qfAutoCornerIdx(_qfSelEntries())){
    const c=_qfChains[i];
    const mat=new THREE.MeshBasicMaterial({color:_QF_COL_CORNER,depthTest:false,transparent:true,opacity:0.95});
    const g=_qfMakeChainGroup(c.pts,c.closed,mat,2.5); scene.add(g); _qfCornerTubes.push(g);
  }
  _camDirty=true;
}

function _qfExit(){
  _qfActive=false; _qfSrcObj=null; _qfChains=[];
  _qfClearTubes(); _qfClearHover(); _qfOcctClearSel(); _qfGroupsClear();
  for(const g of _qfCornerTubes) _qfDisposeGroup(g); _qfCornerTubes=[];
  _qfLastHit=null;
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

// ── [v5] Pinceau de finition : état → UI (source de vérité = _qfFin) ─────────
function _qfModeSet(m){
  _qfMode=(m==='chamfer')?'chamfer':'round';
  _qfFin.kind=(_qfMode==='chamfer')?'chamfer':'fillet';
  _qfSyncUI();
}
function _qfLawSet(l){ _qfFin.law=(l==='var')?'var':'const'; _qfSyncUI(); }
function _qfChamfTypeSet(t){ _qfFin.type=['sym','dd','da','throat'].includes(t)?t:'sym'; _qfSyncUI(); }
function _qfSwapToggle(){ _qfFin.swap=!_qfFin.swap; _qfSyncUI(); }
function _qfCornerSet(m){
  _qfCorner.mode=['idem','vif','round','chamfer'].includes(m)?m:'idem';
  _qfSyncUI(); _qfUpdCornerPreview();
}
// Clé d'état portée par le champ p1/p2 selon le type courant
function _qfParamKey(which){
  const f=_qfFin;
  if(which==='p1') return f.kind==='fillet'?'R':'d';
  if(f.kind==='fillet') return f.law==='var'?'R2':null;
  return ({dd:'d2',da:'ang',throat:'pen'})[f.type]||null;
}
const _QF_PARAM_META={
  R:  {min:0.05,max:999,smax:50,step:0.1, lbl:()=>_qfFin.law==='var'?'R1 (mm)':'Radius R (mm)'},
  R2: {min:0.05,max:999,smax:50,step:0.1, lbl:()=>'R2 (mm)'},
  d:  {min:0.05,max:999,smax:50,step:0.1, lbl:()=>({dd:'d1 (mm)',da:'d (mm)',throat:'Throat a (mm)'})[_qfFin.type]||'d (mm)'},
  d2: {min:0.05,max:999,smax:50,step:0.1, lbl:()=>'d2 (mm)'},
  ang:{min:5,   max:80, smax:80,step:0.5, lbl:()=>'Angle α (°)'},
  pen:{min:0,   max:999,smax:20,step:0.1, lbl:()=>'Penetr. p (mm)'}
};
function _qfParam(which, v){
  v=parseFloat(v); if(!isFinite(v)) { _qfSyncUI(); return; }
  if(which==='pc'){ _qfCorner.size=Math.min(999,Math.max(0.05,v)); _qfSyncUI(); return; }
  const key=_qfParamKey(which); if(!key) return;
  const m=_QF_PARAM_META[key];
  _qfFin[key]=Math.min(m.max,Math.max(m.min,v));
  _qfSyncUI();
}
// Snapshot immuable de la finition courante (ce qui part au noyau / dans un groupe)
function _qfCurFinish(){
  const f=_qfFin;
  if(f.kind==='fillet') return {kind:'fillet',law:f.law,R:f.R,R2:f.law==='var'?f.R2:f.R,swap:f.swap};
  return {kind:'chamfer',type:f.type,d:f.d,d2:f.d2,ang:f.ang,pen:(f.type==='throat')?f.pen:0,swap:f.swap};
}
function _qfCornerFinish(){
  const c=_qfCorner;
  if(c.mode==='round')   return {kind:'fillet', law:'const',R:c.size,R2:c.size,swap:false};
  if(c.mode==='chamfer') return {kind:'chamfer',type:'sym',d:c.size,d2:c.size,ang:45,pen:0,swap:false};
  return null;
}
// ── [v5] Préréglages = les cases de la planche "finitions d'arêtes" ─────────
// Un clic règle finition + coins + arêtes (tailles de la planche, à ajuster) ;
// rien n'est calculé tant qu'on n'a pas cliqué Apply / All.
const _QF_RECIPE_HINT={
  fillet:'① Fillet R5 on the top edges + corners — adjust R, then Apply selection',
  chamfer:'② Chamfer 3 × 45° on the top edges — adjust d, then Apply selection',
  rcorners:'③ Rounded corners R10 — adjust R, then Apply selection',
  bcorners:'④ Bevelled corners 8 × 45° — adjust d, then Apply selection',
  double:'⑤ Corners R8 first, then chamfer 2 × 45° around them — Apply selection',
  var:'⑥ Click the edge near the end that gets R1 (R3), the other end gets R2 (R8)',
  inner:'⑥ Click the rim edges of the pocket / hollow (inner chamfer 4 × 45°)',
  multi:'⑥ Pick the R4 edges, ＋ Group, set R6, pick the others, Apply selection',
  da:'⑥ Click the edge ON the face that carries the 5 mm (30° from that face)'
};
function _qfRecipe(v){
  const sel=document.getElementById('qf-recipe'); if(sel) sel.value='';
  if(!v||!_qfActive||!_QF_RECIPE_HINT[v]) return;
  _qfSelClearAll();
  const F=_qfFin;
  const pick=on=>{ if(_qfOcctPick!==on) _qfOcctPickToggle(); };
  const setCorner=(m,sz)=>{ if(sz) _qfCorner.size=sz; _qfCornerSet(m); };
  switch(v){
    case 'fillet':   _qfModeSet('round');   _qfLawSet('const'); F.R=5; setCorner('idem'); _qfPresetZone('top'); _qfPresetZone('corners'); break;
    case 'chamfer':  _qfModeSet('chamfer'); _qfChamfTypeSet('sym'); F.d=3; setCorner('idem'); _qfPresetZone('top'); break;
    case 'rcorners': _qfModeSet('round');   _qfLawSet('const'); F.R=10; setCorner('idem'); _qfPresetZone('corners'); break;
    case 'bcorners': _qfModeSet('chamfer'); _qfChamfTypeSet('sym'); F.d=8; setCorner('idem'); _qfPresetZone('corners'); break;
    case 'double':   _qfModeSet('chamfer'); _qfChamfTypeSet('sym'); F.d=2; setCorner('round',8); _qfPresetZone('top'); break;
    case 'var':      _qfModeSet('round');   _qfLawSet('var'); F.R=3; F.R2=8; F.swap=false; setCorner('idem'); pick(true); break;
    case 'inner':    _qfModeSet('chamfer'); _qfChamfTypeSet('sym'); F.d=4; setCorner('idem'); pick(true); break;
    case 'multi':    _qfModeSet('round');   _qfLawSet('const'); F.R=4; setCorner('idem'); pick(true); break;
    case 'da':       _qfModeSet('chamfer'); _qfChamfTypeSet('da'); F.d=5; F.ang=30; F.swap=false; setCorner('idem'); pick(true); break;
  }
  _qfSyncUI();
  _qfSetStatus(_QF_RECIPE_HINT[v],'var(--success)');
  nasLog('QF','Preset: '+_QF_RECIPE_HINT[v].split(' — ')[0]);
}
function _qfSyncUI(){
  const f=_qfFin, $=id=>document.getElementById(id);
  const act=(id,on)=>{ const e=$(id); if(e) e.classList.toggle('active',!!on); };
  const show=(el,on)=>{ if(el) el.style.display=on?'':'none'; };
  const isF=f.kind==='fillet';
  _qfMode=isF?'round':'chamfer';
  act('qf-mround',isF); act('qf-mchamfer',!isF);
  show($('qf-sub-fillet'),isF); show($('qf-sub-chamfer'),!isF);
  act('qf-law-const',f.law!=='var'); act('qf-law-var',f.law==='var');
  for(const t of ['sym','dd','da','throat']) act('qf-ct-'+t,f.type===t);
  // p1
  const k1=_qfParamKey('p1'), m1=_QF_PARAM_META[k1];
  const lbl=$('qf-plabel'); if(lbl) lbl.textContent=m1.lbl();
  const sp=$('qf-sp'), vp=$('qf-vp');
  if(sp){ sp.min=0.1; sp.max=m1.smax; sp.step=m1.step; sp.value=Math.min(m1.smax,f[k1]); }
  if(vp&&vp!==document.activeElement) vp.value=(+f[k1]).toFixed(k1==='ang'?1:2).replace(/\.?0+$/,'')||'0';
  // p2
  const k2=_qfParamKey('p2');
  document.querySelectorAll('#qf-modal .qf-p2').forEach(e=>show(e,!!k2));
  if(k2){
    const m2=_QF_PARAM_META[k2];
    const l2=$('qf-p2label'); if(l2) l2.textContent=m2.lbl();
    const sp2=$('qf-sp2'), vp2=$('qf-vp2');
    if(sp2){ sp2.min=(k2==='pen')?0:(k2==='ang'?5:0.1); sp2.max=m2.smax; sp2.step=m2.step; sp2.value=Math.min(m2.smax,f[k2]); }
    if(vp2&&vp2!==document.activeElement) vp2.value=(+f[k2]).toFixed(k2==='ang'?1:2).replace(/\.?0+$/,'')||'0';
  }
  // ⇄ : extrémité R1 (congé variable) ou face de référence (chanfreins asymétriques)
  const sw=$('qf-swap');
  const swapUse=isF?(f.law==='var'):(f.type==='dd'||f.type==='da'||(f.type==='throat'&&f.pen>0));
  if(sw){
    show(sw,swapUse); sw.classList.toggle('active',!!f.swap);
    const what=isF?'R1 at':({dd:'d1 on',da:'d on',throat:'p on'})[f.type]||'d on';
    sw.textContent=isF?`⇄ ${what}: ${f.swap?'the far end':'the clicked end'}`
                      :`⇄ ${what}: ${f.swap?'the other face':'clicked / top face'}`;
  }
  // coins / extrémités
  for(const cm of ['idem','vif','round','chamfer']) act('qf-cm-'+cm,_qfCorner.mode===cm);
  const vc=$('qf-vc');
  if(vc){ vc.disabled=!(_qfCorner.mode==='round'||_qfCorner.mode==='chamfer');
          if(vc!==document.activeElement) vc.value=+(+_qfCorner.size).toFixed(2); }
  const occ=$('qf-occt');
  if(occ) occ.textContent=`⬡ All sharp edges · ${_qfFinLabel(_qfCurFinish())}`
    +(_qfCorner.mode==='round'?` + corners R${+_qfCorner.size.toFixed(2)}`:_qfCorner.mode==='chamfer'?` + corners C${+_qfCorner.size.toFixed(2)}`:_qfCorner.mode==='vif'?' · corners sharp':'');
  _qfUpdSelBtn();
  // le modal grandit/rapetisse selon le type : on le garde entièrement visible
  const mod=$('qf-modal');
  if(mod&&mod.classList.contains('open')&&typeof innerHeight==='number'&&mod.getBoundingClientRect){
    const r=mod.getBoundingClientRect();
    if(r.height&&r.bottom>innerHeight-6) mod.style.top=Math.max(34,innerHeight-r.height-6)+'px';
  }
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

// [v5] Point + normale MONDE de la face de la pièce sous le curseur (ou null).
// La normale sert à désigner la face de référence des chanfreins asymétriques.
function _qfHitOnSrc(){
  ray.setFromCamera(mouse,cam);
  const hits=_raycastFiltered();
  for(const h of hits){
    const c=_meshMap.get(h.object);
    if(c&&c.id===_qfSrcObj.id){
      let n=null;
      if(h.face&&h.face.normal){
        const v=h.face.normal.clone().transformDirection(h.object.matrixWorld);
        n={x:v.x,y:v.y,z:v.z};
      }
      return {pt:h.point.clone(),n};
    }
  }
  return null;
}
// Finition portée par une chaîne (groupe figé ou piquée) — pour le survol
function _qfChainFinLabel(idx){
  if(_qfOcctSel.has(idx)) return _qfFinLabel(_qfCurFinish());
  for(const g of _qfGroups) if(g.idx.has(idx)) return _qfFinLabel(g.fin)+' (group)';
  return '';
}

// Hover : chaîne survolée en surbrillance blanche + preview sous-chaîne
// ambre A→hover si un point de départ est figé (verrouillé sur sa chaîne).
function _qfOnHover(){
  if(!_qfActive||!_qfSrcObj) return;
  const hit=_qfHitOnSrc();
  if(!hit){_qfClearHover();return;}
  _qfLastHit=hit;
  const hitPt=hit.pt;

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
  const loop=best.closed?' ⟳loop':'';
  const vert=best.vertical?' ▮corner':'';
  const fl=_qfChainFinLabel(_qfChains.indexOf(best));
  _qfSetStatus(`${tag}${loop}${vert} len=${best.len.toFixed(1)}mm${fl?' · '+fl:''}`);
  _camDirty=true;
}

// Click : bascule une chaîne dans/hors la sélection OCCT (mode pick actif)
function _qfOnClick(){
  const hit=_qfHitOnSrc();
  if(!hit){_qfSetStatus('Click on the part','var(--warn)');return true;}
  _qfLastHit=hit;
  const hitPt=hit.pt;

  if(_qfOcctPick){
    const hr=_qfNearestChain(hitPt,_qfChains);
    if(!hr){_qfSetStatus('⚠ No edge here','var(--warn)');return true;}
    const idx=_qfChains.indexOf(hr.chain);
    _qfDragAdding=!_qfOcctSel.has(idx); // direction figée pour tout le glisser à suivre
    _qfOcctSetSel(idx,_qfDragAdding);
    _qfDragSel=true; _qfDragLastIdx=idx;
    return true;
  }

  _qfSetStatus('🖱 Click "Pick edges" first — or use Top / Bottom / Corners / Concave, or All sharp edges','var(--warn)');
  return true;
}

function _qfScanChains(targetObj){
  targetObj.mesh.updateMatrixWorld(true);
  const _qfRebuilt=_qfCanRebuild(targetObj);
  const geoSrc=_qfRebuilt?makeGeoCSG(targetObj):targetObj.mesh.geometry.clone();
  {
    const _pos=new THREE.Vector3(),_q=new THREE.Quaternion(),_sc=new THREE.Vector3();
    targetObj.mesh.matrixWorld.decompose(_pos,_q,_sc);
    const _m=(!_qfRebuilt)
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
    // [v5] chaîne "verticale" (coin) : tous ses segments à ≤ 10° de l'axe Y
    let vertical=!closed&&pts.length>=2;
    for(let i=0;vertical&&i<pts.length-1;i++){
      const d=sub(pts[i+1],pts[i]), l=Math.sqrt(dot(d,d));
      if(l>1e-9&&Math.abs(d.y)/l<_QF_VERT_COS) vertical=false;
    }
    chains.push({pts,segN1:segList.map(s=>s.n1),segN2:segList.map(s=>s.n2),
                 convex:seed.convex,closed,len,cum,vertical});
  }
  return chains;
}

// ══ Fin Quick Congé v5 (UI) ══════════════════════════════════════════════

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
// [v5 28/09] Devenu INFORMATIF (journal + statut), plus de confirm() bloquant :
//  · faux positif systématique sur le cas phare "coins arrondis" — les arêtes
//    verticales d'une plaque de 10 mm "n'acceptent pas" R10 selon ce test alors
//    que le noyau le fait (planche ③ : R10 sur plaque) ; la longueur d'une arête
//    ne borne pas son rayon, la largeur des faces adjacentes si ;
//  · le noyau v5 ne "plante" plus sur un R trop grand : il cherche lui-même la
//    plus grande taille réalisable (réduction + bissection) et l'annonce.
// Accepte une taille par chaîne : list = [{chain, size}] (ou (chains, R) v4).
const _QF_RUN_COS=Math.cos(5*Math.PI/180);
function _qfCheckRadiusFits(list, R){
  if(R!==undefined) list=list.map(c=>({chain:c,size:R}));
  let worst=null;
  const dirOf=(a,b)=>{const dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z;
    const l=Math.sqrt(dx*dx+dy*dy+dz*dz);
    return l>1e-9?{x:dx/l,y:dy/l,z:dz/l,l}:null;};
  for(const {chain:c,size:Rc} of list){
    if(!c||!(Rc>0)) continue;
    const n=c.segN1.length, np=c.pts.length;
    let runLen=0, runAngMin=Math.PI, prevDir=null;
    const flush=()=>{
      if(runLen<=0) return;
      const maxR=0.5*runLen*Math.tan(runAngMin/2);
      if(Rc>maxR*1.05 && (!worst||maxR/Rc<worst.maxR/worst.R)) worst={segLen:runLen,angDeg:runAngMin*180/Math.PI,maxR,R:Rc};
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
// ══ QF v5 — noyau B-Rep multi-passes (congés / chanfreins OCCT) ═════════════
// Code pur noyau : aucune dépendance DOM/THREE — validé tel quel sous Node avec
// le même opencascade.wasm que NASSCAD (pipeline triangles → sewing → unify
// identique), sur plaque, bloc en L, marche, poche, plaque à coins facettés.
//
// Descripteurs de finition ("pinceau") :
//   congé   {kind:'fillet',  law:'const'|'var', R, R2}
//   chanfrein {kind:'chamfer', type:'sym'|'dd'|'da'|'throat', d, d2, ang, pen, swap}
//     sym    : d × 45°            → Add(d, E)                 (ChFiDS_Sym)
//     dd     : d1 × d2            → Add(d1, d2, E, F)         (ChFiDS_TwoDist, d1 sur F)
//     da     : d × α              → AddDA(d, α, E, F)         (ChFiDS_DistAngle, d sur F)
//     throat : gorge a [+ pén. p] → SetMode(ConstThroat[WithPenetration]) — OCCT ≥ 7.4
// ═════════════════════════════════════════════════════════════════════════════
const _QF_SHARP_DEG = 20;                               // même seuil que le scan maillage
const _QF_VERT_COS  = Math.cos(10*Math.PI/180);         // arête "verticale" (coin) : ≤ 10° de Y

// Taille caractéristique d'une finition (pour filtres/garde-fous/déflexion).
function _qfFinSize(f){
  if(!f) return 0;
  if(f.kind==='fillet') return f.law==='var'?Math.max(f.R,f.R2):f.R;
  switch(f.type){
    case 'dd': return Math.max(f.d,f.d2);
    case 'da': { const a=Math.min(80,Math.max(10,f.ang))*Math.PI/180; return Math.max(f.d, f.d*Math.tan(a)); }
    case 'throat': return f.d*Math.SQRT2+(f.pen||0);
    default: return f.d;
  }
}
function _qfFinLabel(f){
  if(!f) return '—';
  if(f.kind==='fillet') return f.law==='var'?`R${+f.R.toFixed(2)}→R${+f.R2.toFixed(2)}`:`R${+f.R.toFixed(2)}`;
  switch(f.type){
    case 'dd': return `C${+f.d.toFixed(2)}×${+f.d2.toFixed(2)}`;
    case 'da': return `C${+f.d.toFixed(2)}×${+f.ang.toFixed(1)}°`;
    case 'throat': return `a${+f.d.toFixed(2)}`+(f.pen>0?`+p${+f.pen.toFixed(2)}`:'');
    default: return `C${+f.d.toFixed(2)}×45°`;
  }
}
// Finition réellement appliquée après réduction ×s (l'angle d'un d×α ne change pas)
function _qfFinScaled(f, s){
  if(!f||s===1) return f;
  const g=Object.assign({},f);
  for(const k of ['R','R2','d','d2','pen']) if(typeof g[k]==='number') g[k]*=s;
  return g;
}
// Aire max de la section retirée/ajoutée par une finition sur une arête dont les
// normales font un angle θ (rad) — borne l'invariant de volume.
function _qfFinArea(f, s, theta){
  const th=Math.min(Math.max(theta,0.05),170*Math.PI/180);
  if(f.kind==='fillet'){
    const R=(f.law==='var'?Math.max(f.R,f.R2):f.R)*s;
    return R*R*(Math.tan(th/2)-th/2)+1e-9;
  }
  const L=_qfFinSize(f)*s*1.5;                 // jambes majorées
  return 0.5*L*L+1e-9;
}

// ── Recensement topologique d'une forme : 1 fiche par arête unique ──────────
// {edge, fa, fb (faces), oa (orientation de l'arête dans fa), p0, p1, pts[],
//  len, dih (°), convex, vertical, sharp, why}
function _occtCensus(oc, shape){
  const TA=oc.TopAbs_ShapeEnum;
  const faces=[], recs=[], buckets=new Map();
  const fex=new oc.TopExp_Explorer_2(shape,TA.TopAbs_FACE,TA.TopAbs_SHAPE);
  while(fex.More()){
    const f=oc.TopoDS.Face_1(fex.Current());
    const fi=faces.length; faces.push(f);
    const eex=new oc.TopExp_Explorer_2(f,TA.TopAbs_EDGE,TA.TopAbs_SHAPE);
    while(eex.More()){
      const e=oc.TopoDS.Edge_1(eex.Current());
      const h=e.HashCode(0x3fffffff);
      let arr=buckets.get(h); if(!arr){arr=[];buckets.set(h,arr);}
      let r=arr.find(x=>x.edge.IsSame(e));
      if(!r){ r={edge:e,adj:[],extra:[]}; arr.push(r); recs.push(r); }
      else r.extra.push(e);
      r.adj.push({fi,ori:e.Orientation_1()});
      eex.Next();
    }
    _occtDrop(eex);
    fex.Next();
  }
  _occtDrop(fex);
  const REV=oc.TopAbs_Orientation.TopAbs_REVERSED;
  const fverts=[];
  const faceVerts=(fi)=>{
    if(fverts[fi]) return fverts[fi];
    const arr=[]; const vex=new oc.TopExp_Explorer_2(faces[fi],TA.TopAbs_VERTEX,TA.TopAbs_SHAPE);
    while(vex.More()){ const v=oc.TopoDS.Vertex_1(vex.Current()), p=oc.BRep_Tool.Pnt(v);
      arr.push({x:p.X(),y:p.Y(),z:p.Z()}); _occtDrop(p,v); vex.Next(); }
    _occtDrop(vex); return (fverts[fi]=arr);
  };
  const faceWidth=(fi,r)=>{ let w=0; for(const v of faceVerts(fi)){ const d=_qfDistPtPoly(v,r.pts,false); if(d>w) w=d; } return w; };
  const normalAt=(face,edge,t)=>{
    // normale sortante de `face` au point de paramètre relatif t de `edge`
    let c2=null,uv=null,s=null,pr=null;
    try{
      c2=new oc.BRepAdaptor_Curve2d_2(edge,face);
      const a=c2.FirstParameter(),b=c2.LastParameter();
      uv=c2.Value(a+(b-a)*t);
      s=new oc.BRepAdaptor_Surface_2(face,true);
      pr=new oc.BRepLProp_SLProps_1(s,uv.X(),uv.Y(),1,1e-7);
      if(!pr.IsNormalDefined()) return null;
      const n=pr.Normal();
      let v={x:n.X(),y:n.Y(),z:n.Z()};
      _occtDrop(n);
      if(face.Orientation_1()===REV) v={x:-v.x,y:-v.y,z:-v.z};
      return v;
    }catch(_){ return null; }
    finally{ _occtDrop(pr,s,uv,c2); }
  };
  for(const r of recs){
    r.fa=faces[r.adj[0].fi]; r.oa=r.adj[0].ori;
    r.fb=r.adj.length>1?faces[r.adj[1].fi]:null;
    // points échantillonnés (12) + longueur
    let c=null;
    try{
      if(oc.BRep_Tool.Degenerated(r.edge)){ r.why='degenerated'; r.pts=[]; r.len=0; continue; }
      c=new oc.BRepAdaptor_Curve_2(r.edge);
      const u0=c.FirstParameter(),u1=c.LastParameter(),K=12;
      r.pts=[];
      for(let k=0;k<=K;k++){ const p=c.Value(u0+(u1-u0)*k/K); r.pts.push({x:p.X(),y:p.Y(),z:p.Z()}); _occtDrop(p); }
      r.len=0; for(let k=1;k<r.pts.length;k++){ const a=r.pts[k-1],b=r.pts[k]; r.len+=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z); }
      // tangente au milieu (orientée comme l'arête parcourue dans fa)
      const P=new oc.gp_Pnt_1(), V=new oc.gp_Vec_1();
      c.D1(u0+(u1-u0)*0.5,P,V);
      r.tan={x:V.X(),y:V.Y(),z:V.Z()};
      _occtDrop(P,V);
    }catch(e){ r.why='curve: '+(e&&e.message||e); r.pts=r.pts||[]; r.len=r.len||0; }
    finally{ _occtDrop(c); }
    r.p0=r.pts[0]; r.p1=r.pts[r.pts.length-1];
    if(r.adj.length!==2){ r.why=r.why||('non-manifold ('+r.adj.length+' faces)'); continue; }
    if(r.adj[0].fi===r.adj[1].fi){ r.why='seam'; continue; }
    const na=normalAt(r.fa,r.edge,0.5), nb=normalAt(r.fb,r.edge,0.5);
    r.na=na; r.nb=nb;
    if(!na||!nb){ r.why='normals'; continue; }
    const d=Math.max(-1,Math.min(1,na.x*nb.x+na.y*nb.y+na.z*nb.z));
    r.dih=Math.acos(d)*180/Math.PI;
    // convexité : (na × nb)·T > 0 avec T orientée comme l'arête dans fa
    const cx=na.y*nb.z-na.z*nb.y, cy=na.z*nb.x-na.x*nb.z, cz=na.x*nb.y-na.y*nb.x;
    let t=r.tan||{x:0,y:0,z:0}; if(r.oa===REV) t={x:-t.x,y:-t.y,z:-t.z};
    r.convex=(cx*t.x+cy*t.y+cz*t.z)>0;
    // continuité codée par OCCT (arêtes de raccord des congés précédents)
    let g1=false;
    try{ const cont=oc.BRep_Tool.Continuity_1(r.edge,r.fa,r.fb);
         g1=(cont!==oc.GeomAbs_Shape.GeomAbs_C0); }catch(_){}
    r.sharp=!g1 && r.dih>=_QF_SHARP_DEG;
    if(!r.sharp) r.why=g1?'tangent (G1)':('smooth '+r.dih.toFixed(1)+'°');
    // verticalité (coin) : corde ~ Y et arête rectiligne
    const dx=r.p1.x-r.p0.x, dy=r.p1.y-r.p0.y, dz=r.p1.z-r.p0.z, L=Math.hypot(dx,dy,dz);
    let straight=L>1e-9;
    if(straight){ for(const p of r.pts){ const w=((p.x-r.p0.x)*dx+(p.y-r.p0.y)*dy+(p.z-r.p0.z)*dz)/(L*L);
      if(Math.hypot(p.x-(r.p0.x+dx*w),p.y-(r.p0.y+dy*w),p.z-(r.p0.z+dz*w))>Math.max(1e-3,0.02*L)){straight=false;break;} } }
    r.vertical=straight && Math.abs(dy)/L>=_QF_VERT_COS;
    // largeur des faces adjacentes perpendiculairement à l'arête (distance max
    // d'un sommet de la face à l'arête) → détecte les faces "lamelles" d'une
    // couture CSG, qui bornent la taille de finition quelle que soit la longueur.
    if(r.sharp){ r.wmin=Math.min(faceWidth(r.adj[0].fi,r),faceWidth(r.adj[1].fi,r)); }
  }
  return {faces,recs,dispose(){ for(const r of recs){ _occtDrop(r.edge,...r.extra); } _occtDrop(...faces); }};
}

// ── Géométrie polyline ───────────────────────────────────────────────────────
function _qfDistPtSeg(p,a,b){
  const dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z,l2=dx*dx+dy*dy+dz*dz;
  let t=l2>1e-18?((p.x-a.x)*dx+(p.y-a.y)*dy+(p.z-a.z)*dz)/l2:0; t=Math.max(0,Math.min(1,t));
  return Math.hypot(p.x-(a.x+dx*t),p.y-(a.y+dy*t),p.z-(a.z+dz*t));
}
function _qfDistPtPoly(p,pts,closed){
  let d=Infinity; const n=pts.length, m=closed?n:n-1;
  for(let i=0;i<m;i++){ const v=_qfDistPtSeg(p,pts[i],pts[(i+1)%n]); if(v<d)d=v; }
  return d;
}
// Une arête OCCT correspond-elle à une chaîne picked ? Deux sens :
//  A) l'arête est portée par la chaîne (≥ 2/3 des échantillons intérieurs dessus) —
//     couvre les arêtes RACCOURCIES par une passe précédente (coins arrondis) ;
//  B) un segment de la chaîne est porté par l'arête — couvre les arêtes FUSIONNÉES
//     par UnifySameDomain (un segment picked = sous-partie d'une arête longue).
function _qfBBox(pts){
  const a={x:Infinity,y:Infinity,z:Infinity}, b={x:-Infinity,y:-Infinity,z:-Infinity};
  for(const p of pts){ if(p.x<a.x)a.x=p.x; if(p.y<a.y)a.y=p.y; if(p.z<a.z)a.z=p.z;
                       if(p.x>b.x)b.x=p.x; if(p.y>b.y)b.y=p.y; if(p.z>b.z)b.z=p.z; }
  return {a,b};
}
function _qfRecOnChain(r,ch,tol){
  if(!r.pts||r.pts.length<3) return false;
  const P=ch.pts, closed=ch.closed;
  // pré-filtre boîtes englobantes (mises en cache) : O(1) pour les paires éloignées
  const cb=ch._bb||(ch._bb=_qfBBox(P)), rb=r._bb||(r._bb=_qfBBox(r.pts));
  if(rb.a.x>cb.b.x+tol||rb.b.x<cb.a.x-tol||rb.a.y>cb.b.y+tol||rb.b.y<cb.a.y-tol||rb.a.z>cb.b.z+tol||rb.b.z<cb.a.z-tol) return false;
  let inner=0,ok=0;
  for(let k=1;k<r.pts.length-1;k++){ inner++; if(_qfDistPtPoly(r.pts[k],P,closed)<tol) ok++; }
  if(inner && ok>=Math.ceil(inner*2/3)) return true;
  const n=P.length, m=closed?n:n-1;
  for(let i=0;i<m;i++){
    const a=P[i], b=P[(i+1)%n];
    if(_qfDistPtPoly(a,r.pts,false)<tol && _qfDistPtPoly(b,r.pts,false)<tol){
      const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2};
      if(_qfDistPtPoly(mid,r.pts,false)<tol) return true;
    }
  }
  return false;
}

// Face de référence pour les chanfreins asymétriques (d1 / d mesurée dessus) :
//  1) face cliquée (normale mémorisée au pick) ;
//  2) sinon la plus "horizontale" (|n·Y| max) — le dessus/dessous d'une plaque ;
//  3) arête verticale (coin) : la face la plus alignée sur Z (avant/arrière).
// `swap` inverse le choix.
function _qfRefFace(r, refN, swap){
  const na=r.na, nb=r.nb; let useA=true;
  if(na&&nb){
    if(refN){ useA=(na.x*refN.x+na.y*refN.y+na.z*refN.z)>=(nb.x*refN.x+nb.y*refN.y+nb.z*refN.z); }
    else if(Math.abs(Math.abs(na.y)-Math.abs(nb.y))>0.1) useA=Math.abs(na.y)>Math.abs(nb.y);
    else useA=Math.abs(na.z)>=Math.abs(nb.z);
  }
  if(swap) useA=!useA;
  return useA?r.fa:r.fb;
}

// ── Une construction OCCT (un seul MakeFillet OU MakeChamfer) ────────────────
// items : [{rec, fin, scale, drop, r1Pt, refN}] — tous du même `kind`.
function _occtBuildOnce(oc, shape, kind, items, ctx){
  const M=oc.ChFiDS_ChamfMode;
  const mk=(kind==='fillet')
    ? new oc.BRepFilletAPI_MakeFillet(shape,oc.ChFi3d_FilletShape.ChFi3d_Rational)
    : new oc.BRepFilletAPI_MakeChamfer(shape);
  const used=[]; const notes=[];
  for(const it of items){
    if(it.drop) continue;
    const f=it.fin, s=it.scale||1, E=it.rec.edge;
    try{
      if(kind==='fillet'){
        if(f.law==='var' && Math.abs(f.R-f.R2)>1e-9){
          let Ra=f.R*s, Rb=f.R2*s;
          mk.Add_3(Ra,Rb,E);
          const IC=mk.Contour(E);
          if(IC>0){
            if(mk.Closed(IC)){
              // loi linéaire impossible sur un contour fermé (R1≠R2 au même sommet)
              // → loi symétrique R1 → R2 → R1 via Add(UandR)
              mk.Remove(E);
              const arr=new oc.TColgp_Array1OfPnt2d_2(1,3);
              const q1=new oc.gp_Pnt2d_3(0,Ra),q2=new oc.gp_Pnt2d_3(0.5,Rb),q3=new oc.gp_Pnt2d_3(1,Ra);
              arr.SetValue(1,q1);arr.SetValue(2,q2);arr.SetValue(3,q3);
              mk.Add_5(arr,E);
              _occtDrop(q1,q2,q3,arr);
              notes.push('closed contour: R1→R2→R1');
            }else if(it.r1Pt){
              // R1 du côté du clic : si le 1er sommet du contour est plus loin du clic
              // que le dernier, on retire et on ré-ajoute avec R1/R2 inversés
              const vF=mk.FirstVertex(IC), vL=mk.LastVertex(IC);
              const pF=oc.BRep_Tool.Pnt(vF), pL=oc.BRep_Tool.Pnt(vL);
              const dF=Math.hypot(pF.X()-it.r1Pt.x,pF.Y()-it.r1Pt.y,pF.Z()-it.r1Pt.z);
              const dL=Math.hypot(pL.X()-it.r1Pt.x,pL.Y()-it.r1Pt.y,pL.Z()-it.r1Pt.z);
              _occtDrop(pF,pL,vF,vL);
              if(dL<dF){ mk.Remove(E); mk.Add_3(Rb,Ra,E); }
            }
          }
        }else mk.Add_2(f.R*s,E);
      }else{
        const F=(f.type==='dd'||f.type==='da'||(f.type==='throat'&&f.pen>0))?_qfRefFace(it.rec,it.refN,f.swap):null;
        switch(f.type){
          case 'dd':
            mk.SetMode(M.ChFiDS_ClassicChamfer);
            mk.Add_3(f.d*s,f.d2*s,E,F); break;
          case 'da':
            mk.SetMode(M.ChFiDS_ClassicChamfer);
            mk.AddDA(f.d*s,Math.min(80,Math.max(5,f.ang))*Math.PI/180,E,F); break;
          case 'throat':
            if(f.pen>0){ mk.SetMode(M.ChFiDS_ConstThroatWithPenetrationChamfer); mk.Add_3(f.pen*s,f.d*s,E,F); }
            else{ mk.SetMode(M.ChFiDS_ConstThroatChamfer); mk.Add_2(f.d*s,E); }
            break;
          default:
            mk.SetMode(M.ChFiDS_ClassicChamfer);
            mk.Add_2(f.d*s,E);
        }
      }
      used.push(it);
    }catch(e){ notes.push('Add: '+(e&&e.message||e)); }
  }
  if(!used.length){ _occtDrop(mk); return {ok:false,used,why:'no edge to process',notes}; }
  let built=false, why='';
  try{ mk.Build(); built=mk.IsDone(); if(!built) why='kernel Build failed'; }
  catch(err){ why=(err&&err.message)||String(err); }
  // Diagnostics OCCT (MakeFillet uniquement) : quels contours / sommets ont échoué
  const faulty=new Set(); const faultyInfo=[];
  if(!built && kind==='fillet'){
    try{
      const ES=oc.ChFiDS_ErrorStatus;
      const nf=mk.NbFaultyContours();
      for(let i=1;i<=nf;i++){
        const IC=mk.FaultyContour(i);
        let st='?'; try{ const v=mk.StripeStatus(IC); st=Object.keys(ES).find(k=>ES[k]===v)||'?'; }catch(_){}
        faultyInfo.push('C'+IC+':'+st.replace('ChFiDS_',''));
        const ne=mk.NbEdges(IC);
        for(let j=1;j<=ne;j++){
          const E=mk.Edge(IC,j);
          for(const it of used) if(it.rec.edge.IsSame(E)) faulty.add(it);
          _occtDrop(E);
        }
      }
      const nv=mk.NbFaultyVertices();
      for(let i=1;i<=nv;i++){
        const V=mk.FaultyVertex(i), P=oc.BRep_Tool.Pnt(V);
        const q={x:P.X(),y:P.Y(),z:P.Z()}; _occtDrop(P,V);
        faultyInfo.push('V('+q.x.toFixed(1)+','+q.y.toFixed(1)+','+q.z.toFixed(1)+')');
        for(const it of used){ const r=it.rec;
          if(Math.hypot(r.p0.x-q.x,r.p0.y-q.y,r.p0.z-q.z)<ctx.tol*4||Math.hypot(r.p1.x-q.x,r.p1.y-q.y,r.p1.z-q.z)<ctx.tol*4) faulty.add(it); }
      }
    }catch(_){ /* diagnostics indisponibles → échelle globale */ }
    if(faultyInfo.length) why+=' ['+faultyInfo.slice(0,6).join(' ')+(faultyInfo.length>6?' …':'')+']';
  }
  if(!built){ _occtDrop(mk); return {ok:false,used,why,faulty,notes}; }
  const res=mk.Shape();
  return {ok:true,mk,shape:res,used,notes};
}

// Aire MINIMALE réaliste de la section retirée (congé : formule exacte au dièdre,
// rayon mini ; chanfrein symétrique : triangle exact ; autres : pas de borne basse)
function _qfFinAreaLo(f, s, theta){
  const th=Math.min(Math.max(theta,0.05),170*Math.PI/180);
  if(f.kind==='fillet'){ const R=(f.law==='var'?Math.min(f.R,f.R2):f.R)*s; return R*R*(Math.tan(th/2)-th/2); }
  if(f.type==='sym'){ const d=f.d*s; return 0.5*d*d*Math.sin(Math.PI-th); }
  return 0;
}
// Volume du solide mesuré sur SA TRIANGULATION (BRepMesh), + nombre de faces
// impossibles à trianguler. [v5] Mesuré : sur une plaque percée d'un trou à 64
// facettes, BRepGProp donnait ΔV = −23 mm³ après congé R1 de toutes les arêtes,
// la triangulation −117 mm³ (valeur attendue ≈ −116) ; et sur un résultat
// réellement cassé (congés des seuls bords du trou) BRepGProp −279, maillage +120
// — le maillage, lui, voit l'aberration (un congé convexe n'AJOUTE pas de
// matière). C'est aussi exactement ce que NASSCAD affichera et exportera.
function _occtMeshVolume(oc, shape, defl){
  const REV=oc.TopAbs_Orientation.TopAbs_REVERSED;
  let mesher=null, fex=null, v=0, nNull=0, nTri=0;
  try{
    mesher=new oc.BRepMesh_IncrementalMesh_2(shape,defl,false,0.5,false);
    fex=new oc.TopExp_Explorer_2(shape,oc.TopAbs_ShapeEnum.TopAbs_FACE,oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    while(fex.More()){
      const face=oc.TopoDS.Face_1(fex.Current()), loc=new oc.TopLoc_Location_1();
      const triH=oc.BRep_Tool.Triangulation(face,loc);
      if(triH.IsNull()) nNull++;
      else{
        const tri=triH.get(), trsf=loc.Transformation(), rev=face.Orientation_1()===REV;
        const nv=tri.NbNodes(), nt=tri.NbTriangles(), P=new Float64Array(nv*3);
        for(let i=1;i<=nv;i++){ const nd=tri.Node(i), q=nd.Transformed(trsf);
          P[(i-1)*3]=q.X(); P[(i-1)*3+1]=q.Y(); P[(i-1)*3+2]=q.Z(); _occtDrop(q,nd); }
        for(let i=1;i<=nt;i++){
          const t=tri.Triangle(i); let a=t.Value(1)-1,b=t.Value(2)-1,c=t.Value(3)-1; _occtDrop(t);
          if(rev){ const w=b; b=c; c=w; }
          const ax=P[a*3],ay=P[a*3+1],az=P[a*3+2],bx=P[b*3],by=P[b*3+1],bz=P[b*3+2],cx=P[c*3],cy=P[c*3+1],cz=P[c*3+2];
          v+=ax*(by*cz-bz*cy)-ay*(bx*cz-bz*cx)+az*(bx*cy-by*cx); nTri++;
        }
        _occtDrop(trsf,triH);
      }
      _occtDrop(loc,face); fex.Next();
    }
  }catch(_){ return {vol:NaN,nNull,nTri}; }
  finally{ _occtDrop(fex,mesher); }
  return {vol:v/6,nNull,nTri};
}
// Validation indépendante d'un résultat (IsDone()===true ne garantit rien) :
//  · BRepCheck_Analyzer ;
//  · toutes les faces triangulables ;
//  · invariant de volume BORNÉ, mesuré sur la triangulation (cf. ci-dessus) :
//    une arête convexe ne peut qu'enlever de la matière, une concave ne peut
//    qu'en ajouter, jamais plus que la section maximale × longueur (× 3), et —
//    sans arête concave — au moins 30 % de la section minimale réaliste (un
//    contour sauté en silence par le noyau se voit ici).
//    [FIX v5] l'ancien test "le volume ne doit pas croître" rejetait à tort
//    tout congé CONCAVE (qui ajoute de la matière).
function _occtValidate(oc, shape, used, volBeforeAt, defl){
  const valid=_occtIsValid(oc,shape);
  if(valid===false) return {ok:false,vol:NaN,why:'BRepCheck_Analyzer rejected the resulting B-Rep'};
  const mv=_occtMeshVolume(oc,shape,defl);
  if(mv.nNull>0) return {ok:false,vol:NaN,why:`${mv.nNull} face(s) could not be triangulated (degenerate B-Rep)`};
  const vol=mv.vol, volBefore=volBeforeAt(defl);
  if(isFinite(vol)&&isFinite(volBefore)){
    let rem=0, add=0, remLo=0, concave=false;
    for(const it of used){
      const th=(it.rec.dih||90)*Math.PI/180, L=it.rec.len||0, s=it.scale||1;
      const a=L*_qfFinArea(it.fin,s,th);
      if(it.rec.convex===false){ add+=a; concave=true; }
      else { rem+=a; remLo+=L*_qfFinAreaLo(it.fin,s,th); }
    }
    const eps=Math.abs(volBefore)*1e-3, dV=vol-volBefore;
    if(dV>3*add+eps) return {ok:false,vol,why:`result volume grew ${volBefore.toFixed(0)} → ${vol.toFixed(0)} mm³ (self-intersecting solid)`};
    if(dV<-3*rem-eps) return {ok:false,vol,why:`result lost ${(-dV).toFixed(0)} mm³, far beyond the finish section (corrupted solid)`};
    if(!concave && remLo>0 && -dV<0.3*remLo-eps)
      return {ok:false,vol,why:`only ${(-dV).toFixed(1)} mm³ removed for ~${remLo.toFixed(0)} expected (kernel skipped part of the finish)`};
  }
  return {ok:true,vol};
}

// ── Une passe (un kind) avec repli ───────────────────────────────────────────
// 1) tout à la taille demandée ;
// 2) micro-arêtes (plus courtes que 2×taille ET que 15 % de la plus longue arête
//    traitée — typiquement les coutures d'une union CSG) laissées vives, taille
//    pleine ailleurs. Pour les congés, OCCT désigne lui-même les contours fautifs
//    (NbFaultyContours / NbFaultyVertices) : on écarte d'abord SEULEMENT les
//    micro-arêtes fautives, puis toutes ;
// 3) réduction UNIFORME ×0.85 … ×0.15, puis UNE bissection entre le dernier échec
//    et le premier succès → la plus grande taille réalisable, pas la première.
// Choix délibéré : une vraie arête n'est jamais laissée vive ni réduite seule
// (résultat asymétrique surprenant) — seules les micro-arêtes le sont.
// [v5] L'ancienne règle "écarter toute arête < 2R" retirait aussi les arêtes
// verticales d'une plaque de 10 mm dont le congé R25 était faisable jusqu'à
// R≈20 : la longueur d'une arête ne borne pas le rayon, la largeur des faces
// adjacentes si. D'où le critère "micro" relatif.
const _QF_SCALES=[0.85,0.7,0.55,0.4,0.25,0.15];
function _occtRunPass(oc, shape, kind, items, ctx){
  // volume "avant" sur la triangulation, à la même déflexion que le "après"
  // (mis en cache : les faces inchangées gardent la même triangulation)
  const vbCache=new Map();
  const volBeforeAt=defl=>{ if(!vbCache.has(defl)) vbCache.set(defl,_occtMeshVolume(oc,shape,defl).vol); return vbCache.get(defl); };
  // déflexion de contrôle : 5 % de la plus petite taille EN JEU (bornée 0.005–0.1)
  const vDefl=()=>{ let m=Infinity; for(const it of items){ if(it.drop) continue; const f=it.fin;
      const z=(f.kind==='fillet'?(f.law==='var'?Math.min(f.R,f.R2):f.R):f.d)*(it.scale||1); if(z<m) m=z; }
    const d=isFinite(m)?0.05*m:0.1; return Math.min(0.1,Math.max(0.005,+d.toPrecision(2))); };
  const log=[]; const t0=Date.now(); let budget=0;
  const tryOnce=(label)=>{
    const tA=Date.now();
    const b=_occtBuildOnce(oc,shape,kind,items,ctx);
    let ok=b.ok, why=b.why, vol=NaN;
    if(ok){ const v=_occtValidate(oc,b.shape,b.used,volBeforeAt,vDefl()); ok=v.ok; why=v.why; vol=v.vol;
            if(!ok){ _occtDrop(b.shape,b.mk); b.shape=null; b.mk=null; } }
    const dt=Date.now()-tA; if(!budget) budget=Math.max(8000,dt*6);   // même budget que la v4 (6× la 1re tentative)
    log.push(`${label} → ${ok?'valid':why} (${dt}ms)`);
    return Object.assign(b,{ok,why,vol});
  };
  const expired=()=>Date.now()-t0>budget;
  const isFatal=r=>!!(ctx.isFatal&&ctx.isFatal(r.why));
  const done=(r)=>Object.assign(r,{log,volBefore:volBeforeAt(vDefl())});
  const fail=(r,fatal)=>Object.assign(r,{ok:false,log,fatal:!!fatal});
  let lmax=0; for(const it of items) lmax=Math.max(lmax,it.rec.len||0);
  // micro à l'échelle s : arête courte (coutures) OU bordée d'une face lamelle
  const isMicro=(it,s)=>{ const sz=_qfFinSize(it.fin)*s, L=it.rec.len||0;
    return (L<2*sz && L<0.15*lmax) || (isFinite(it.rec.wmin) && it.rec.wmin<0.5*sz); };
  const microAt=s=>{ const m=new Set(items.filter(i=>isMicro(i,s))); return m.size<items.length?m:new Set(); };
  let sMin=Infinity; for(const it of items) sMin=Math.min(sMin,_qfFinSize(it.fin));
  let dropSet=new Set();
  const set=(s)=>{ for(const it of items){ it.scale=s; it.drop=dropSet.has(it); } };
  set(1);
  let r=tryOnce(`${kind} ×${items.length}`);
  if(r.ok) return done(r);
  if(isFatal(r)) return fail(r,true);
  // (2) micro-arêtes vives à taille pleine — d'abord les seules fautives
  //     désignées par OCCT, puis toutes
  const micro1=microAt(1);
  if(micro1.size){
    const faultyMicro=r.faulty?[...r.faulty].filter(i=>micro1.has(i)):[];
    if(faultyMicro.length && faultyMicro.length<micro1.size && !expired()){
      dropSet=new Set(faultyMicro); set(1);
      r=tryOnce(`${faultyMicro.length} faulty micro-edge(s) left sharp`);
      if(r.ok) return done(r);
      if(isFatal(r)) return fail(r,true);
    }
    if(!expired()){
      dropSet=micro1; set(1);
      r=tryOnce(`${micro1.size} micro-edge(s) left sharp`);
      if(r.ok) return done(r);
      if(isFatal(r)) return fail(r,true);
    }
  }
  // (3) réduction uniforme + bissection (les micro-arêtes sont réévaluées à
  //     chaque échelle : plus la taille baisse, moins il y en a)
  let lastFail=1;
  for(const s of _QF_SCALES){
    if(expired()){ log.push('stopped on time budget'); break; }
    if(sMin*s<0.02) break;
    dropSet=microAt(s);
    set(s);
    r=tryOnce(`×${s}`);
    if(r.ok){
      if(!expired() && lastFail-s>0.1){
        const sm=(s+lastFail)/2, keepR=r, keepDrop=dropSet;
        dropSet=microAt(sm); set(sm);
        const r2=tryOnce(`×${sm.toFixed(3)} (refine)`);
        if(r2.ok){ _occtDrop(keepR.shape,keepR.mk); return done(r2); }
        dropSet=keepDrop; set(s);
        return done(keepR);
      }
      return done(r);
    }
    if(isFatal(r)) return fail(r,true);
    lastFail=s;
  }
  return fail(r,false);
}

// ── Plan multi-passes ────────────────────────────────────────────────────────
// passes : [{label, kind, resolve(census) → items}] exécutées dans l'ordre, chacune
// sur le B-Rep produit par la précédente (pas de retour maillage entre passes :
// plus de "re-congé sur résultat facetté").
function _occtRunPlan(oc, shape0, passes, ctx){
  let shape=shape0; const keep=[]; const report=[]; let anyDone=false;
  for(const p of passes){
    const cen=_occtCensus(oc,shape);
    let items=[];
    try{ items=p.resolve(cen)||[]; }catch(e){ cen.dispose(); return {ok:false,why:'resolve '+p.label+': '+(e&&e.message||e),report,keep,shape}; }
    if(!items.length){ report.push({label:p.label,n:0}); cen.dispose(); continue; }
    const r=_occtRunPass(oc,shape,p.kind,items,ctx);
    let minSize=Infinity, minR=Infinity;
    for(const it of items){ if(it.drop) continue; const sc=it.scale||1;
      minSize=Math.min(minSize,_qfFinSize(it.fin)*sc);
      if(it.fin.kind==='fillet') minR=Math.min(minR,(it.fin.law==='var'?Math.min(it.fin.R,it.fin.R2):it.fin.R)*sc); }
    const scales=items.filter(i=>!i.drop).map(i=>i.scale||1);
    const summary={label:p.label,kind:p.kind,n:items.length,log:r.log,ok:r.ok,
      applied:items.filter(i=>!i.drop).length, dropped:items.filter(i=>i.drop).length,
      bridges:items.filter(i=>i.bridge).length,
      scale:scales.length?Math.min(...scales):1, minSize, minR,
      finishes:[...new Set(items.map(i=>_qfFinLabel(i.fin)))],
      appliedLabels:[...new Set(items.filter(i=>!i.drop).map(i=>_qfFinLabel(_qfFinScaled(i.fin,i.scale||1))))],
      notes:r.notes};
    report.push(summary);
    cen.dispose();
    if(!r.ok) return {ok:false,why:`${p.label}: ${r.why}`,fatal:r.fatal,report,keep,shape};
    keep.push(r.mk,r.shape); shape=r.shape; anyDone=true;
  }
  return {ok:anyDone,why:anyDone?'':'nothing matched',report,keep,shape};
}

// ── [v5] Sélection → entrées noyau ──────────────────────────────────────────
// Chaque entrée : {idx, chain, fin, refN, r1Pt}. Les piquées "vivantes" prennent
// la finition courante et priment sur un groupe figé pour la même chaîne.
function _qfR1Point(c, fin, info){
  if(fin.kind!=='fillet'||fin.law!=='var') return null;
  const a=c.pts[0], b=c.pts[c.pts.length-1];
  if(c.closed) return info&&info.pt?info.pt:a;       // boucle : loi R1→R2→R1 depuis le 1er sommet OCCT
  let near=a, far=b;
  if(info&&info.pt){
    const da=Math.hypot(info.pt.x-a.x,info.pt.y-a.y,info.pt.z-a.z);
    const db=Math.hypot(info.pt.x-b.x,info.pt.y-b.y,info.pt.z-b.z);
    if(db<da){ near=b; far=a; }
  }
  return fin.swap?far:near;
}
function _qfCollectSelection(curFin){
  const out=new Map();
  const push=(idx,fin,info)=>{
    const c=_qfChains[idx]; if(!c) return;
    out.set(idx,{idx,chain:c,fin,refN:(info&&info.n)||null,r1Pt:_qfR1Point(c,fin,info)});
  };
  for(const g of _qfGroups) for(const i of g.idx) push(i,g.fin,g.info.get(i));
  for(const i of _qfOcctSel) push(i,curFin,_qfPickInfo.get(i));
  return [...out.values()];
}
// Arêtes OCCT d'une passe ← chaînes piquées (+ "ponts" : arêtes neuves créées
// par une passe de coins biseautés, qui relient deux arêtes retenues — sans eux
// le chanfrein du dessus s'arrêterait net sur chaque biseau de coin).
function _qfResolveSel(cen, list, tol, bridgeMax){
  const items=[]; const matched=new Set();
  for(const r of cen.recs){
    if(!r.sharp) continue;
    for(const s of list){
      if(_qfRecOnChain(r,s.chain,tol)){ items.push({rec:r,fin:s.fin,r1Pt:s.r1Pt,refN:s.refN}); matched.add(r); break; }
    }
  }
  if(bridgeMax>0 && items.length){
    const ends=[]; for(const it of items) ends.push({p:it.rec.p0,it},{p:it.rec.p1,it});
    const near=p=>ends.find(e=>Math.hypot(e.p.x-p.x,e.p.y-p.y,e.p.z-p.z)<tol*2);
    const extra=[];
    for(const r of cen.recs){
      if(!r.sharp||matched.has(r)||r.vertical||!(r.len<=bridgeMax)) continue;
      const a=near(r.p0), b=near(r.p1);
      if(a&&b&&a.it!==b.it) extra.push({rec:r,fin:a.it.fin,refN:a.it.refN,bridge:true});
    }
    items.push(...extra);   // après les arêtes piquées : OCCT les ignore si déjà propagées
  }
  return items;
}
// Plan de passes B-Rep. Ordre : coins (verticales) d'abord, congés avant
// chanfreins — l'ordre standard des modeleurs (le contour du dessus peut alors
// contourner un coin déjà arrondi par propagation tangente).
// Une seule passe quand tout est homogène (même type, pas de coins dédiés) :
// les congés de même rayon s'y raccordent par de vrais congés de sommet.
function _qfBuildPlan(selectedOnly, sel, mainFin, cornerFin, cMode, tol){
  const passes=[];
  const add=(label,kind,resolve)=>passes.push({label,kind,resolve});
  if(!selectedOnly){
    if(cornerFin){
      add('corners',cornerFin.kind,cen=>cen.recs.filter(r=>r.sharp&&r.vertical).map(rec=>({rec,fin:cornerFin})));
      add('edges',mainFin.kind,cen=>cen.recs.filter(r=>r.sharp&&!r.vertical).map(rec=>({rec,fin:mainFin})));
    }else{
      add('edges',mainFin.kind,cen=>cen.recs.filter(r=>r.sharp&&!(cMode==='vif'&&r.vertical)).map(rec=>({rec,fin:mainFin})));
    }
    return passes;
  }
  const cornerSel=cornerFin?_qfAutoCornerIdx(sel.map(s=>s.idx)).map(i=>({idx:i,chain:_qfChains[i],fin:cornerFin,refN:null,r1Pt:null})):[];
  const kinds=new Set(sel.map(s=>s.fin.kind));
  if(!cornerSel.length && kinds.size===1){
    const k=[...kinds][0];
    add('selection',k,cen=>_qfResolveSel(cen,sel,tol,0));
    return passes;
  }
  const A=[...sel.filter(s=>s.chain.vertical),...cornerSel];
  const B=sel.filter(s=>!s.chain.vertical);
  let cornerMax=0; for(const s of A) cornerMax=Math.max(cornerMax,_qfFinSize(s.fin));
  for(const k of ['fillet','chamfer']){
    const a=A.filter(s=>s.fin.kind===k);
    if(a.length) add('corners '+k,k,cen=>_qfResolveSel(cen,a,tol,0));
  }
  for(const k of ['fillet','chamfer']){
    const b=B.filter(s=>s.fin.kind===k);
    if(b.length) add('edges '+k,k,cen=>_qfResolveSel(cen,b,tol,A.length?2.5*cornerMax+tol:0));
  }
  return passes;
}

async function _occtFilletAll(selectedOnly){
  const obj=_qfSrcObj;
  if(!obj){_qfSetStatus('⚠ Select an object first','var(--danger)');return;}
  const mainFin=_qfCurFinish();
  const cMode=_qfCorner.mode;
  const cornerFin=_qfCornerFinish();
  let sel=null;
  if(selectedOnly){
    sel=_qfCollectSelection(mainFin);
    if(!sel.length){
      _qfSetStatus('⚠ Click "🖱 Pick edges" (or Top / Bottom / Corners / Concave) to select at least one edge','var(--danger)');
      return;
    }
  }
  const fins=selectedOnly?[...sel.map(s=>s.fin),...(cornerFin?[cornerFin]:[])]:[mainFin,...(cornerFin?[cornerFin]:[])];
  const kinds=new Set(fins.map(f=>f.kind));
  const opName=kinds.size>1?'finish':(kinds.has('fillet')?'fillet':'chamfer');
  const opLbl=selectedOnly
    ? [...new Set(sel.map(s=>_qfFinLabel(s.fin)))].join(' + ')+(cornerFin?` · corners ${_qfFinLabel(cornerFin)}`:'')
    : _qfFinLabel(mainFin)+(cornerFin?` · corners ${_qfFinLabel(cornerFin)}`:cMode==='vif'?' · corners sharp':'');
  // [v5] Pré-check local : désormais informatif (cf. _qfCheckRadiusFits)
  const _chk=selectedOnly
    ? sel.map(s=>({chain:s.chain,size:_qfFinSize(s.fin)}))
    : _qfChains.map(c=>({chain:c,size:c.vertical?(cornerFin?_qfFinSize(cornerFin):(cMode==='vif'?0:_qfFinSize(mainFin))):_qfFinSize(mainFin)}));
  const _rIssue=_qfCheckRadiusFits(_chk);
  if(_rIssue){
    nasLog('WARN',`OCCT: size ${_rIssue.R}mm beyond the local estimate ${_rIssue.maxR.toFixed(2)}mm `
      +`(edge ${_rIssue.segLen.toFixed(2)}mm, ${_rIssue.angDeg.toFixed(0)}°) — the kernel will apply the largest feasible size if needed`);
  }
  if(obj.isOcctResult){
    const _ok2=confirm(`⚠ This object is already an OCCT fillet/chamfer result.\n\n`
      +`Re-filleting on top of it is a known kernel edge case: it can succeed, `
      +`fail cleanly, or (more insidiously) appear to succeed with an `
      +`invisible gap in the mesh.\n\n`
      +`Better: go back to the original object (before any fillet) and do it in `
      +`ONE pass — Quick Fillet v5 chains several finishes on the B-Rep itself `
      +`(＋ Group for several radii / fillet + chamfer, Corners for rounded or `
      +`bevelled corners).\n\n`
      +`Continue anyway on this already-filleted object?`);
    if(!_ok2){ _qfSetStatus('⚠ Cancelled — go back to the original object to avoid the edge case','var(--warn)'); return; }
    nasLog('OCCT','⚠ Re-filleting an already-curved OCCT result — the rebuilt B-Rep may hit a kernel edge case (see fallback below if it fails)');
  }
  // World-space non-indexed geometry — same transform pattern as _qfScanChains
  obj.mesh.updateMatrixWorld(true);
  const _qfRebuilt2=_qfCanRebuild(obj);
  let geo=_qfRebuilt2?makeGeoCSG(obj):obj.mesh.geometry.clone();
  {
    const _p=new THREE.Vector3(),_q=new THREE.Quaternion(),_s=new THREE.Vector3();
    obj.mesh.matrixWorld.decompose(_p,_q,_s);
    const _m=(!_qfRebuilt2)
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
  undoPush(opName==='chamfer'?'chamfer':'fillet');
  showSpinner('OCCT '+(opName==='fillet'?'Fillet':opName==='chamfer'?'Chamfer':'Finish'),`${nTris} tris → B-Rep — ${selectedOnly?sel.length+' picked edge(s)':'all sharp edges'} · ${opLbl}`);
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
    // 3. [v5] Plan multi-passes sur le B-Rep : recensement des arêtes vives de la
    //    forme COURANTE à chaque passe (convexes/concaves, verticales, tangentes
    //    G1 écartées), appariement géométrique des chaînes piquées (robuste aux
    //    arêtes fusionnées par UnifySameDomain ET raccourcies par une passe
    //    précédente), construction + validation + repli par passe.
    const tol=Math.max(0.02,diag*0.0015);
    const passes=_qfBuildPlan(!!selectedOnly,sel,mainFin,cornerFin,cMode,tol);
    const plan=_occtRunPlan(oc,unified,passes,{tol,isFatal:_occtIsFatal});
    _keep.push(...plan.keep);
    for(const r of plan.report){
      if(!r.n) { nasLog('DBG',`  pass "${r.label}": no matching edge`); continue; }
      nasLog('DBG',`  pass "${r.label}" (${r.kind}, ${r.finishes.join(' + ')}): ${r.applied}/${r.n} edge(s)`
        +(r.bridges?`, ${r.bridges} bridge(s)`:'')+` — ${r.log.join(' | ')}`
        +(r.notes&&r.notes.length?` — ${r.notes.join('; ')}`:''));
    }
    if(!plan.ok){
      if(plan.fatal) throw new Error(plan.why);
      if(selectedOnly&&plan.report.every(r=>!r.n))
        throw new Error('no OCCT edge matched the picked selection — try picking again');
      throw new Error(`kernel could not build a valid ${opName} (${opLbl}) — ${plan.why}`);
    }
    const result=plan.shape;
    const tFillet=performance.now();
    // Réductions/abandons éventuels → message clair (taille réellement appliquée)
    const degraded=plan.report.filter(r=>r.n&&(r.scale<0.999||r.dropped));
    const nEdges=plan.report.reduce((a,r)=>a+(r.applied||0),0);
    if(degraded.length){
      const parts=degraded.map(r=>(r.scale<0.999?`${r.finishes.join('+')} impossible here → applied ${r.appliedLabels.join('+')} (largest feasible)`:`${r.finishes.join('+')}`)
        +(r.dropped?` · ${r.dropped} micro-edge(s) left sharp`:''));
      _qfSetStatus('⚠ '+parts.join(' · '),'var(--warn)');
      nasLog('WARN','OCCT: '+parts.join(' · '));
    }
    const _brepInvalid=false;   // déjà validé passe par passe (B-Rep + volume borné)
    // 4. B-Rep → triangles. Deflection derived from R and the Segments
    // slider — same physical quantity as the mesh sweep path: sagitta of
    // an arc of radius R split into N segments ≈ R·π²/(2N²). This makes
    // "Segments" mean the same thing in both engines (8 = coarse facets,
    // 192 = near-smooth), instead of an object-size heuristic the slider
    // had zero effect on. Clamped to avoid pathological mesh sizes on
    // extreme R/segments combos.
    // [v5] R = plus PETIT rayon réellement appliqué (congés variables/multiples),
    // à défaut la plus petite taille de chanfrein.
    let Rmesh=Infinity;
    for(const r of plan.report){ if(!r.n) continue; Rmesh=Math.min(Rmesh,isFinite(r.minR)?r.minR:r.minSize); }
    if(!isFinite(Rmesh)) Rmesh=_qfFinSize(mainFin);
    const arcSegs=Math.max(3,Math.min(192,Math.round(_qfSegs)));
    const sagitta=Rmesh*Math.PI*Math.PI/(2*arcSegs*arcSegs);
    const defl=Math.min(0.5,Math.max(0.005,sagitta));
    // les triangulations de CONTRÔLE (validation des passes) sont jetées : le
    // maillage final doit suivre la déflexion demandée (curseur Segments)
    try{ oc.BRepTools.Clean(result); }catch(_){}
    const mesher=new oc.BRepMesh_IncrementalMesh_2(result,defl,false,0.5,false);
    const out=[];
    // [v5] Géométrie d'AFFICHAGE : un bloc de sommets par face OCCT (sommets
    // partagés À L'INTÉRIEUR d'une face seulement). computeVertexNormals() lisse
    // donc les congés mais garde nettes les arêtes entre faces — un chanfrein
    // se voit enfin comme un plan, pas comme un arrondi (la v4 soudait tout puis
    // moyennait les normales à travers les arêtes vives). Aux raccords tangents
    // (congé → face plane) les normales coïncident déjà : transition lisse.
    const dPos=[], dIdx=[]; let dOff=0;
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
          dPos.push(pts[(i-1)*3],pts[(i-1)*3+1],pts[(i-1)*3+2]);
          _occtDrop(p,nd);
        }
        for(let i=1;i<=nt;i++){
          const t=tri.Triangle(i);
          let a=t.Value(1),b=t.Value(2),c=t.Value(3);
          if(rev){const w=b;b=c;c=w;}
          out.push(pts[(a-1)*3],pts[(a-1)*3+1],pts[(a-1)*3+2],
                   pts[(b-1)*3],pts[(b-1)*3+1],pts[(b-1)*3+2],
                   pts[(c-1)*3],pts[(c-1)*3+1],pts[(c-1)*3+2]);
          dIdx.push(dOff+a-1,dOff+b-1,dOff+c-1);
          _occtDrop(t);
        }
        dOff+=nv;
        _occtDrop(trsf,triH);
      }
      _occtDrop(loc,face);
      fex.Next();
    }
    _occtDrop(fex,mesher);
    if(!out.length)throw new Error('empty triangulation from kernel');
    const tMesh=performance.now();
    // 5. Result object — doCSG pattern, single source consumed
    //    Contrôle d'étanchéité sur une copie SOUDÉE (soupe) ; l'objet reçoit la
    //    géo d'affichage par faces, sauf si un bouchage de trou a été nécessaire
    //    (on garde alors la géo soudée + bouchons, comportement v4).
    let rGeo=new THREE.BufferGeometry();
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
    let _capped=false;
    if(!isManifold && rGeo._nakedEdgePairs && rGeo._nakedEdgePairs.length && _capStepGaps(rGeo)){
      isManifold=true; _capped=true;
      nasLog('DBG','OCCT gap filled — mesh now watertight');
    }
    if(!_capped && dIdx.length){
      rGeo.dispose();
      rGeo=new THREE.BufferGeometry();
      rGeo.setAttribute('position',new THREE.Float32BufferAttribute(dPos,3));
      rGeo.setIndex(dIdx);
    }
    if(_brepInvalid) isManifold=false; // signal B-Rep pré-triangulation, indépendant du check mesh
    if(!isManifold){
      nasLog('WARN',`OCCT ${opName} result NON-MANIFOLD — ${rGeo._nakedEdges||0} naked edge(s)`
        +(rGeo._overEdges?`, ${rGeo._overEdges} over-valenced`:'')
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
    // Le facteur réellement appliqué apparaît dans le nom quand la taille a dû
    // être réduite — sans ça l'info disparaît avec le panneau QF à la fermeture.
    const sMin=Math.min(1,...plan.report.filter(r=>r.n).map(r=>r.scale));
    let _suffix='';
    if(sMin<0.999){
      const _one=plan.report.filter(r=>r.n);
      const _f=(_one.length===1&&_one[0].finishes.length===1)?(selectedOnly?sel[0].fin:mainFin):null;
      _suffix=(_f&&_f.kind==='fillet'&&_f.law!=='var')?('_R'+(_f.R*sMin).toFixed(2))
             :(_f&&_f.kind==='chamfer'&&_f.type==='sym')?('_C'+(_f.d*sMin).toFixed(2))
             :('_x'+sMin.toFixed(2));
    }
    // nom d'après ce qui a VRAIMENT été construit (une passe de coins vide ne compte pas)
    const _kinds=new Set(plan.report.filter(r=>r.n&&r.applied).map(r=>r.kind));
    const _base=_kinds.size>1?'Finish':_kinds.has('chamfer')?'Chamfer':'Fillet';
    const ro={id:objCnt,name:'OCCT_'+_base+'_'+objCnt+_suffix,type:'csg',mesh:rMesh,isHole:false,color:_col,isOcctResult:true,isManifold,
              occtFinish:{label:opLbl,passes:plan.report.filter(r=>r.n).map(r=>({label:r.label,kind:r.kind,finishes:r.finishes,edges:r.applied,scale:+r.scale.toFixed(3)}))}};
    if(GeometryPool.initialized){ro._poolSlot=GeometryPool.geoStore(rGeo);updPoolStats();}
    scene.remove(obj.mesh);obj.mesh.geometry.dispose();obj.mesh.material.dispose();
    objs=objs.filter(x=>x!==obj);
    objs.push(ro);selObjs=[ro];
    updProps();updOList();updStats();
    const dt=Math.round(performance.now()-t0);
    const _fmtMs=ms=>ms<1000?Math.round(ms)+'ms':(ms/1000).toFixed(1)+'s';
    const _applied=[...new Set(plan.report.filter(r=>r.n).flatMap(r=>r.appliedLabels))].join(' + ');
    nasLog('OCCT',`✓ ${opName} ${opLbl} — ${nEdges} edge(s) in ${plan.report.filter(r=>r.n).length} B-Rep pass(es)`
      +(sMin<0.999?` — applied ${_applied} (×${sMin.toFixed(2)}, largest feasible)`:'')
      +` — ${nTris}→${(out.length/9)|0} tris, defl=${defl.toFixed(3)} — ⏱ ${_fmtMs(dt)}`);
    nasLog('DBG',`  detail: sewing ${_fmtMs(tSew-t0)} · unify ${_fmtMs(tUnify-tSew)} · ${opName} ${_fmtMs(tFillet-tUnify)} · meshing ${_fmtMs(tMesh-tFillet)}`);
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
