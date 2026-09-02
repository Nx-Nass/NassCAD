// ══════════════════════════════════════════════════════════════════════════
// step-export.js — module Export STEP (B-Rep analytique, multi-protocole)
//   AP203 Ed.2 · AP214 CD3 · AP242 Ed.1 — ISO 10303-21
//
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, PS                                — scene state
//   THREE                                            — Three.js global
//   nasLog, showSpinner, hideSpinner                 — app-wide helpers
//   makeGeoHD                                        — géométrie haute définition pour export
//   NASSCAD_VERSION                                  — utilisée dans le header STEP
//   _nasDownload                                     — helper de téléchargement partagé
//   _csgTree                                          — arbre CSG (pour la détection sphère/plan)
//
//   Indépendant de step-import.js — aucun couplage détecté (scan confirmé,
//   pas supposé). L'export et l'import STEP ne partagent aucun état.
// ══════════════════════════════════════════════════════════════════════════
// ── Export STEP — B-Rep analytique — ISO 10303-21 / AP203 · AP214 · AP242
// Merge coplanaire : triangles coplanaires connexes → MANIFOLD_SOLID_BREP (ADVANCED_FACE/PLANE,
// EDGE_CURVE/LINE, VERTEX_POINT partagés). Fallback FACETED_BREP si mesh non-planaire (organique).
// Three.js Y-up → STEP Z-up : cv(x,y,z)=[x,-z,y]. Validé : Autodesk Viewer, FreeCAD.
// Couleurs : émises en chaîne COLOUR_RGB/STYLED_ITEM pour AP214 et AP242 (pas AP203).
const STEPFusionModes = {
  EXACT:   { name:'Exact',   tolerance:1e-6, decimals:6 },
  ROBUST:  { name:'Robust',  tolerance:1e-5, decimals:5 },
  FACETED: { name:'Faceted', tolerance:null, decimals:null }
};
// ── Descripteurs de protocoles STEP (Application Protocol) ───────────────
// Tout ce qui distingue AP203/AP214/AP242 est centralisé ici.
// Les entités géométriques (MANIFOLD_SOLID_BREP, ADVANCED_FACE, CLOSED_SHELL,
// SPHERICAL_SURFACE, etc.) sont COMMUNES aux trois protocoles — elles viennent
// du noyau géométrique ISO 10303 Part 42/43/44, normalisé séparément des AP.
//
// AP203 Ed.2 — 10303-403 MIM LF :
//   Compatibilité maximale (SolidWorks, AutoCAD, tous lecteurs STEP).
//   Pas d'entités couleur dans le schéma AP de base.
// AP214 CD3  — 10303-214 IS 3e éd. :
//   Standard automobile/mécanique le plus répandu en industrie.
//   COLOUR_RGB + STYLED_ITEM + MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION.
// AP242 Ed.1 — 10303-442 MIM LF :
//   Standard actuel (2014), superset AP203+AP214 + MBD/PMI.
//   Même chaîne couleur que AP214, capacités MBD supplémentaires.
const STEPApVersions = {
  AP203: {
    name:       'AP203',
    label:      'Config Controlled Design',
    schema:     'CONFIGURATION_CONTROLLED_3D_DESIGN_OF_MECHANICAL_PARTS_AND_ASSEMBLIES_MIM_LF { 1 0 10303 403 1 1 4 }',
    appCtxText: 'configuration controlled 3d designs of mechanical parts and assemblies',
    apdStd:     'international standard',
    apdName:    'config_control_design',
    apdYear:    1994,
    hasColors:  false   // AP203 : aucune entité couleur dans le schéma AP
  },
  AP214: {
    name:       'AP214',
    label:      'Automotive Design',
    schema:     'AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 1 }',
    appCtxText: 'automotive_design',
    apdStd:     'draft international standard',
    apdName:    'automotive_design',
    apdYear:    1998,
    hasColors:  true    // COLOUR_RGB + STYLED_ITEM + MECHANICAL_DESIGN_GEOMETRIC_...
  },
  AP242: {
    name:       'AP242',
    label:      'Managed Model 3D Eng.',
    schema:     'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }',
    appCtxText: 'managed model based 3d engineering',
    apdStd:     'international standard',
    apdName:    'managed_model_based_3d_engineering',
    apdYear:    2011,
    hasColors:  true    // idem AP214 + MBD (PMI, annotations 3D…)
  }
};
// ── Sauvegarde STEP avec choix de destination ────────────────────────────
// [FIX] showSaveFilePicker doit être appelé AVANT le calcul B-Rep (dans la
// fenêtre user-gesture ~1s après le clic). Cette fonction se contente d'écrire
// dans un handle déjà obtenu, ou repli _nasDownload si pas de handle.
//
// fileHandle : FileSystemFileHandle obtenu dans doStepExport() pendant le clic.
//   null/undefined → repli download (API absente ou erreur picker).
async function _nasStepSave(suggestedName, blob, fileHandle){
  if(fileHandle){
    try{
      const ws=await fileHandle.createWritable();
      await ws.write(blob);
      await ws.close();
      return; // fichier écrit dans le dossier choisi par l'utilisateur
    }catch(e){
      nasLog('WARN','FileHandle write: '+e.message+' — fallback navigateur');
    }
  }
  // Repli : download navigateur → dossier Téléchargements par défaut
  _nasDownload(suggestedName, blob, 'application/step');
}
// Config globale lue par l'export — modifiable via la modale ou en console.
globalThis._stepExportConfig = globalThis._stepExportConfig || {
  fusionMode:      'ROBUST',  // EXACT | ROBUST | FACETED
  customTolerance: undefined, // override numérique si fourni
  logStats:        true,      // stats d'export en console
  apVersion:       'AP242'    // AP203 | AP214 | AP242
};
// Front-door : expSTEP ouvre la modale d'options ; _expSTEPRun fait l'export.
function openStepExportModal(){
  const m=document.getElementById('step-export-modal');
  if(!m){ _expSTEPRun(); return; } // garde-fou si la modale est absente
  const cfg=globalThis._stepExportConfig||{};
  // Fusion mode
  const r=m.querySelector('input[name="stepFusionMode"][value="'+(cfg.fusionMode||'ROBUST')+'"]');
  if(r) r.checked=true;
  // AP version (nouveau)
  const av=m.querySelector('input[name="stepApVersion"][value="'+(cfg.apVersion||'AP242')+'"]');
  if(av) av.checked=true;
  // Custom tolerance + stats
  const t=document.getElementById('step-custom-tol'); if(t) t.value=(cfg.customTolerance!=null?cfg.customTolerance:'');
  const s=document.getElementById('step-show-stats'); if(s) s.checked=cfg.logStats!==false;
  m.style.display='flex';
}
function closeStepExportModal(){ const m=document.getElementById('step-export-modal'); if(m) m.style.display='none'; }
// [FIX] doStepExport est async : showSaveFilePicker est appelé ICI, immédiatement
// après le clic sur "Exporter" — on est encore dans la fenêtre user-gesture (~1s).
// Le calcul B-Rep dans _expSTEPRun peut durer plusieurs secondes ; si on appelait
// showSaveFilePicker APRÈS le calcul, Chrome lève NotAllowedError et le picker
// n'apparaît jamais. Le handle obtenu est passé à _expSTEPRun via opts.fileHandle.
async function doStepExport(){
  const sel=document.querySelector('input[name="stepFusionMode"]:checked');
  const avSel=document.querySelector('input[name="stepApVersion"]:checked');
  const tEl=document.getElementById('step-custom-tol');
  const tv=(tEl&&tEl.value!=='')?parseFloat(tEl.value):undefined;
  const sEl=document.getElementById('step-show-stats');
  const apVer=avSel?avSel.value:'AP242';
  const _apInfo=STEPApVersions[apVer]||STEPApVersions.AP242;
  // ── Picker pendant le geste ──────────────────────────────────────────────
  let fileHandle=null;
  if(typeof showSaveFilePicker==='function'){
    try{
      fileHandle=await showSaveFilePicker({
        suggestedName:'model_'+_apInfo.name+'.stp',
        types:[{
          description:'STEP File (.stp / .step)',
          accept:{'model/step':['.stp','.step'],'application/step':['.stp','.step']}
        }],
        excludeAcceptAllOption:false
      });
    }catch(e){
      if(e.name==='AbortError') return; // utilisateur a annulé → silencieux
      nasLog('WARN','showSaveFilePicker: '+e.message+' — fallback navigateur');
      // fileHandle reste null → _nasStepSave utilisera _nasDownload
    }
  }
  // ── Config + lancement calcul ────────────────────────────────────────────
  globalThis._stepExportConfig={
    fusionMode:      sel?sel.value:'ROBUST',
    customTolerance: (tv!=null&&isFinite(tv)&&tv>0)?tv:undefined,
    logStats:        sEl?sEl.checked:true,
    apVersion:       apVer
  };
  closeStepExportModal();
  _expSTEPRun(undefined,{fileHandle});
}
function expSTEP(){ openStepExportModal(); }
function _expSTEPRun(objList, opts){
  opts = opts || {};
  const t0=performance.now();
  const _cfg=globalThis._stepExportConfig||{};
  const _mode=_cfg.fusionMode||'ROBUST';
  const _mInfo=STEPFusionModes[_mode]||STEPFusionModes.ROBUST;
  const _apVersion=_cfg.apVersion||'AP242';
  const _apInfo=STEPApVersions[_apVersion]||STEPApVersions.AP242;
  if(!opts.silent) showSpinner('Export STEP '+_apInfo.name,'Mode: '+_mInfo.name+' — B-Rep…');
  // Double rAF : garantit que le spinner est peint avant le traitement synchrone.
  // [FIX 17/07] Retourne désormais une Promise (résolue avec le texte STEP si
  // opts.returnText, sinon undefined) — 100% rétro-compatible : les appels
  // existants ignorent déjà la valeur de retour (fire-and-forget).
  return new Promise((resolve)=>{
  requestAnimationFrame(()=>requestAnimationFrame(async ()=>{
    scene.updateMatrixWorld(true);
    const cv=(x,y,z)=>[x,-z,y]; // Three.js Y-up → STEP Z-up
    const f=v=>v.toFixed(6);
    let id=0; const L=[];
    const E=()=>{ id++; return id; };
    const W=(s)=>{ L.push('#'+id+' = '+s+';'); };

    // ── Boilerplate AP — paramétré par _apInfo ────────────────────────────
    // Émet APPLICATION_CONTEXT, APPLICATION_PROTOCOL_DEFINITION, PRODUCT/
    // DEFINITION chain, Units et Placement origine.
    // APPLICATION_PROTOCOL_DEFINITION n'est pas référencée en aval (métadonnée
    // de conformance — les validateurs STEP l'exigent, les parseurs géo non).
    // Renvoie les trois ids nécessaires au reste de l'export : iPDS, iGC, iAX0.
    const _emitAPBoilerplate=()=>{
      const iAC =E(); W("APPLICATION_CONTEXT('"+_apInfo.appCtxText+"')");
      E();             W("APPLICATION_PROTOCOL_DEFINITION('"+_apInfo.apdStd+"','"+_apInfo.apdName+"',"+_apInfo.apdYear+",#"+iAC+")");
      const iPC =E(); W("PRODUCT_CONTEXT('',#"+iAC+",'mechanical')");
      const iPr =E(); W("PRODUCT('NASSCAD Model','NASSCAD Model','',(#"+iPC+"))");
      const iPDF=E(); W("PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#"+iPr+",.NOT_KNOWN.)");
      const iPDC=E(); W("PRODUCT_DEFINITION_CONTEXT('part definition',#"+iAC+",'design')");
      const iPD =E(); W("PRODUCT_DEFINITION('design','',#"+iPDF+",#"+iPDC+")");
      const iPDS=E(); W("PRODUCT_DEFINITION_SHAPE('','',#"+iPD+")");
      const iUL =E(); W("(NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.0)))");
      const iUA =E(); W("(NAMED_UNIT(*) SI_UNIT($,.RADIAN.) PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(1.)))");
      const iUS =E(); W("(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_MEASURE_WITH_UNIT(SOLID_ANGLE_MEASURE(1.)))");
      const iUM =E(); W("UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.001),#"+iUL+",'distance accuracy value','Max model space distance')");
      const iGC =E(); W("(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#"+iUM+")) GLOBAL_UNIT_ASSIGNED_CONTEXT((#"+iUL+",#"+iUA+",#"+iUS+")) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))");
      const iCP0=E(); W("CARTESIAN_POINT('',(0.,0.,0.))");
      const iDZ0=E(); W("DIRECTION('',(0.,0.,1.))");
      const iDX0=E(); W("DIRECTION('',(1.,0.,0.))");
      const iAX0=E(); W("AXIS2_PLACEMENT_3D('',#"+iCP0+",#"+iDZ0+",#"+iDX0+")");
      return {iPDS,iGC,iAX0};
    };
    const {iPDS,iGC,iAX0}=_emitAPBoilerplate();

    // ── Couleurs (AP214 / AP242) ──────────────────────────────────────────
    // _getObjColor : extrait la THREE.Color du matériau (r,g,b ∈ [0,1]).
    //   Renvoie {r,g,b} ou null si le matériau ne porte pas de couleur unie.
    // _emitColor   : émet la chaîne normative AP214/AP242 :
    //   COLOUR_RGB → FILL_AREA_STYLE_COLOUR → FILL_AREA_STYLE →
    //   SURFACE_STYLE_FILL_AREA → SURFACE_SIDE_STYLE → SURFACE_STYLE_USAGE →
    //   PRESENTATION_STYLE_ASSIGNMENT → STYLED_ITEM
    //   Renvoie l'id du STYLED_ITEM (collecté pour MECHANICAL_DESIGN_GEOMETRIC_
    //   PRESENTATION_REPRESENTATION, conteneur obligatoire AP214).
    // Appelé seulement si _apInfo.hasColors === true.
    const _getObjColor=(so)=>{
      try{
        const c=so.mesh&&so.mesh.material&&so.mesh.material.color;
        if(c&&typeof c.r==='number'&&typeof c.g==='number'&&typeof c.b==='number')
          return{r:Math.max(0,Math.min(1,c.r)),g:Math.max(0,Math.min(1,c.g)),b:Math.max(0,Math.min(1,c.b))};
      }catch(e){/* malformed/missing material on this object — color is optional (AP214 only), just skip it */}
      return null;
    };
    const _emitColor=(iBR,col)=>{
      const iRGB =E(); W("COLOUR_RGB('',"+f(col.r)+","+f(col.g)+","+f(col.b)+")");
      const iFASC=E(); W("FILL_AREA_STYLE_COLOUR('',#"+iRGB+")");
      const iFAS =E(); W("FILL_AREA_STYLE('',(#"+iFASC+"))");
      const iSSFA=E(); W("SURFACE_STYLE_FILL_AREA(#"+iFAS+")");
      const iSSS =E(); W("SURFACE_SIDE_STYLE('',(#"+iSSFA+"))");
      const iSSU =E(); W("SURFACE_STYLE_USAGE(.BOTH.,#"+iSSS+")");
      const iPSA =E(); W("PRESENTATION_STYLE_ASSIGNMENT((#"+iSSU+"))");
      const iSI  =E(); W("STYLED_ITEM('',(#"+iPSA+"),#"+iBR+")");
      return iSI;
    };

    // ── B-Rep par objet : merge coplanaire → MANIFOLD_SOLID_BREP ──────
    // Triangles coplanaires connexes regroupés en faces planes (B-Rep) :
    // ADVANCED_FACE(PLANE) + EDGE_LOOP/ORIENTED_EDGE/EDGE_CURVE(LINE)/
    // VERTEX_POINT, arêtes+sommets dédupliqués (Map) → topologie partagée.
    // [FIX V4.2.7 19/06] Avant : une face avec >1 boucle (trou planaire — perçage qui
    // traverse une face plate, cas fréquent) faisait abandonner TOUT l'objet en
    // FACETED_BREP (1 face/triangle). Cause confirmée par audit du STEP exporté
    // (model.stp : 14562 FACE_SURFACE pour 14622 triangles — fallback déclenché par
    // une seule face à trou parmi des centaines de faces planes par ailleurs fusionnables).
    // Extension : chaque composante connexe trace TOUTES ses boucles de bord (pas juste
    // la première), classées outer/trou par aire 2D projetée (la plus grande en valeur
    // absolue = outer — le trou est mécaniquement plus petit). Le sens de bouclage sort
    // automatiquement correct (outer CCW, trou CW) du chaînage d'arêtes dirigées — propriété
    // topologique du maillage source, aucune logique de flip nécessaire (vérifié : normale
    // résultante pointe vers l'extérieur du solide sur le cas de test boîte+perçage,
    // volume recalculé après réimport OCCT exact à 336mm³ pour 10×10×4 − 4×4×4).
    const _planarMerge=(tris)=>{
      if(!tris.length)return null;
      const vk=p=>f(p[0])+'|'+f(p[1])+'|'+f(p[2]);
      const pk=t=>t.nx.toFixed(6)+','+t.ny.toFixed(6)+','+t.nz.toFixed(6)+','+
        (t.nx*t.A[0]+t.ny*t.A[1]+t.nz*t.A[2]).toFixed(6);
      const groups=new Map();
      tris.forEach((t,i)=>{const k=pk(t);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(i);});
      const faces=[]; let assigned=0;
      for(const idxs of groups.values()){
        const dirSet=new Map();
        idxs.forEach(i=>{const t=tris[i],P=[t.A,t.B,t.C];
          for(let e=0;e<3;e++){const dk=vk(P[e])+'>'+vk(P[(e+1)%3]);
            if(!dirSet.has(dk))dirSet.set(dk,[]);dirSet.get(dk).push(i);}});
        const adj=new Map(); idxs.forEach(i=>adj.set(i,new Set()));
        idxs.forEach(i=>{const t=tris[i],P=[t.A,t.B,t.C];
          for(let e=0;e<3;e++){const rk=vk(P[(e+1)%3])+'>'+vk(P[e]);
            (dirSet.get(rk)||[]).forEach(j=>{if(j!==i){adj.get(i).add(j);adj.get(j).add(i);}});}});
        const seen=new Set();
        for(const start of idxs){
          if(seen.has(start))continue;
          const comp=[],stk=[start]; seen.add(start);
          while(stk.length){const c=stk.pop();comp.push(c);
            for(const nb of adj.get(c))if(!seen.has(nb)){seen.add(nb);stk.push(nb);}}
          const dCount=new Map();
          comp.forEach(i=>{const t=tris[i],P=[t.A,t.B,t.C];
            for(let e=0;e<3;e++){const dk=vk(P[e])+'>'+vk(P[(e+1)%3]);
              dCount.set(dk,(dCount.get(dk)||0)+1);}});
          const bndPairs=[];
          comp.forEach(i=>{const t=tris[i],P=[t.A,t.B,t.C];
            for(let e=0;e<3;e++){const u=P[e],v=P[(e+1)%3];
              if(!dCount.has(vk(v)+'>'+vk(u)))bndPairs.push([u,v]);}});
          if(bndPairs.length===0||bndPairs.length>5000)return null;
          // Trace TOUTES les boucles fermées de la composante (pas juste la première) —
          // même logique de chaînage que _traceNakedLoops (STEP import, cap-fill).
          const nextOf=new Map();
          bndPairs.forEach(([u,v])=>nextOf.set(vk(u),{v,vk:vk(v)}));
          const visited=new Set(), loops=[];
          for(const [startKey] of nextOf){
            if(visited.has(startKey))continue;
            const startPt=bndPairs.find(([u])=>vk(u)===startKey)[0];
            const loop=[startPt]; visited.add(startKey); let curKey=startKey;
            while(true){
              const nxt=nextOf.get(curKey);
              if(!nxt)return null; // chaîne cassée → topologie ambiguë
              if(nxt.vk===startKey){loop.closed=true;break;}
              if(visited.has(nxt.vk))return null; // collision → ambiguë
              loop.push(nxt.v); visited.add(nxt.vk); curKey=nxt.vk;
            }
            loops.push(loop);
          }
          if(loops.some(l=>!l.closed))return null;
          // Classification outer/trou par aire 2D projetée (plan de la composante)
          const nrm=[tris[comp[0]].nx,tris[comp[0]].ny,tris[comp[0]].nz];
          const arb=Math.abs(nrm[0])<0.9?[1,0,0]:[0,1,0];
          const crs=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
          const nrmz=a=>{const l=Math.hypot(...a)||1;return[a[0]/l,a[1]/l,a[2]/l];};
          const uAx=nrmz(crs(arb,nrm)), vAx=nrmz(crs(nrm,uAx));
          const dt=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
          const sgnArea2D=loop=>{const p2=loop.map(p=>[dt(p,uAx),dt(p,vAx)]);
            let a=0; for(let i=0;i<p2.length;i++){const[x1,y1]=p2[i],[x2,y2]=p2[(i+1)%p2.length];a+=x1*y2-x2*y1;}
            return a/2;};
          const withArea=loops.map(l=>({loop:l,area:sgnArea2D(l)}));
          withArea.sort((a,b)=>Math.abs(b.area)-Math.abs(a.area));
          const outer=withArea[0], holes=withArea.slice(1);
          faces.push({outerLoop:outer.loop, holeLoops:holes.map(h=>h.loop), n:nrm});
          assigned+=comp.length;
        }
      }
      if(assigned!==tris.length || faces.length < 4) return null;
      // Validation edge-manifold étendue : compte les arêtes de TOUTES les boucles
      // (outer + trous), pas juste l'outer — garantit un CLOSED_SHELL valide.
      const _ev=new Map();
      faces.forEach(fc=>{
        [fc.outerLoop, ...fc.holeLoops].forEach(L=>{
          for(let i=0;i<L.length;i++){const a=vk(L[i]),b=vk(L[(i+1)%L.length]);
            const ek=a<b?a+'~'+b:b+'~'+a; _ev.set(ek,(_ev.get(ek)||0)+1);}
        });
      });
      if([..._ev.values()].some(v=>v!==2)) return null;
      return faces;
    };
    // Émission MANIFOLD_SOLID_BREP — faces planes + arêtes/sommets partagés
    const _emitManifold=(faces,name)=>{
      const vk=p=>f(p[0])+'|'+f(p[1])+'|'+f(p[2]);
      const vtxMap=new Map();
      const mkVtx=p=>{const k=vk(p);if(vtxMap.has(k))return vtxMap.get(k);
        const cp=E();W("CARTESIAN_POINT('',("+f(p[0])+","+f(p[1])+","+f(p[2])+"))");
        const vp=E();W("VERTEX_POINT('',#"+cp+")");
        const ent={cp,vp,k};vtxMap.set(k,ent);return ent;};
      const edgeMap=new Map();
      const mkEdge=(pA,pB)=>{
        const vA=mkVtx(pA),vB=mkVtx(pB);
        const sk=vA.k<vB.k?vA.k+'/'+vB.k:vB.k+'/'+vA.k;
        if(edgeMap.has(sk)){const ex=edgeMap.get(sk);return{ec:ex.ec,or:(vA.k===ex.v1k)?'.T.':'.F.'};}
        const dx=pB[0]-pA[0],dy=pB[1]-pA[1],dz=pB[2]-pA[2];
        const dl=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;
        const iDD=E();W("DIRECTION('',("+f(dx/dl)+","+f(dy/dl)+","+f(dz/dl)+"))");
        const iVEC=E();W("VECTOR('',#"+iDD+",1.)");
        const iLN=E();W("LINE('',#"+vA.cp+",#"+iVEC+")");
        const iEC=E();W("EDGE_CURVE('',#"+vA.vp+",#"+vB.vp+",#"+iLN+",.T.)");
        edgeMap.set(sk,{ec:iEC,v1k:vA.k});return{ec:iEC,or:'.T.'};
      };
      // EDGE_LOOP depuis une boucle ordonnée — factorisé (outer ET trous l'utilisent).
      // [FIX V4.2.7 19/06] iEL résolu et CAPTURÉ avant tout E() englobant — ne jamais
      // appeler un générateur d'id à l'intérieur de l'argument d'un W() (l'id lu par W()
      // est la variable globale courante : un appel imbriqué la fait avancer entre la
      // réservation et l'écriture → désalignement id réservé / id réellement écrit).
      const mkEdgeLoop=(Lp)=>{
        const n=Lp.length;
        const oeIds=Lp.map((p,i)=>{const{ec,or}=mkEdge(p,Lp[(i+1)%n]);
          const iOE=E();W("ORIENTED_EDGE('',*,*,#"+ec+","+or+")");return iOE;});
        const iEL=E();W("EDGE_LOOP('',("+oeIds.map(i=>'#'+i).join(',')+"))");
        return iEL;
      };
      const faceIds=[];
      faces.forEach(fc=>{
        const [nx,ny,nz]=fc.n;
        // [FIX V4.2.7 19/06] FACE_OUTER_BOUND (1) + FACE_BOUND par trou (0..N) — avant :
        // un seul bound, pas de notion de trou. Le sens de bouclage des trous sort déjà
        // correct (CW vs CCW outer) du chaînage d'arêtes dirigées de _planarMerge —
        // aucune inversion à faire ici, juste émettre FACE_BOUND au lieu de OUTER_BOUND.
        const outerEL=mkEdgeLoop(fc.outerLoop);
        const iFOB=E();W("FACE_OUTER_BOUND('',#"+outerEL+",.T.)");
        const boundIds=[iFOB];
        (fc.holeLoops||[]).forEach(hLoop=>{
          const holeEL=mkEdgeLoop(hLoop);
          const iFB=E();W("FACE_BOUND('',#"+holeEL+",.T.)");
          boundIds.push(iFB);
        });
        const Lp=fc.outerLoop,p0=Lp[0],p1=Lp[1];
        let rx=p1[0]-p0[0],ry=p1[1]-p0[1],rz=p1[2]-p0[2];
        const dot=rx*nx+ry*ny+rz*nz; rx-=dot*nx;ry-=dot*ny;rz-=dot*nz;
        const rl=Math.sqrt(rx*rx+ry*ry+rz*rz)||1; rx/=rl;ry/=rl;rz/=rl;
        const iCP=E();W("CARTESIAN_POINT('',("+f(p0[0])+","+f(p0[1])+","+f(p0[2])+"))");
        const iDN=E();W("DIRECTION('',("+f(nx)+","+f(ny)+","+f(nz)+"))");
        const iDR=E();W("DIRECTION('',("+f(rx)+","+f(ry)+","+f(rz)+"))");
        const iAX=E();W("AXIS2_PLACEMENT_3D('',#"+iCP+",#"+iDN+",#"+iDR+")");
        const iPLn=E();W("PLANE('',#"+iAX+")");
        const iAF=E();W("ADVANCED_FACE('',("+boundIds.map(i=>'#'+i).join(',')+"),#"+iPLn+",.T.)");
        faceIds.push(iAF);
      });
      const iSH=E();W("CLOSED_SHELL('',("+faceIds.map(i=>'#'+i).join(',')+"))");
      const iBR=E();W("MANIFOLD_SOLID_BREP('"+name.replace(/'/g,"''")+"',#"+iSH+")");
      return iBR;
    };
    // Émission FACETED_BREP — fallback (1 FACE_SURFACE/triangle, historique)
    const _emitFaceted=(tris,name)=>{
      const ptMap=new Map();
      const mkPt=(x,y,z)=>{const k=f(x)+'|'+f(y)+'|'+f(z);
        if(ptMap.has(k))return ptMap.get(k);
        const i=E();W("CARTESIAN_POINT('',("+f(x)+","+f(y)+","+f(z)+"))");
        ptMap.set(k,i);return i;};
      const faceIds=[];
      tris.forEach(t=>{
        const[ax,ay,az]=t.A,[bx,by,bz]=t.B,[cx,cy,cz]=t.C,{nx,ny,nz}=t;
        let rx=1,ry=0,rz=0; if(Math.abs(nx)>0.9){rx=0;ry=1;rz=0;}
        const dot=rx*nx+ry*ny+rz*nz; rx-=dot*nx;ry-=dot*ny;rz-=dot*nz;
        const rl=Math.sqrt(rx*rx+ry*ry+rz*rz)||1; rx/=rl;ry/=rl;rz/=rl;
        const kx=(ax+bx+cx)/3,ky=(ay+by+cy)/3,kz=(az+bz+cz)/3;
        const iA=mkPt(ax,ay,az),iB=mkPt(bx,by,bz),iC=mkPt(cx,cy,cz);
        const iPLp=E();W("POLY_LOOP('',(#"+iA+",#"+iB+",#"+iC+"))");
        const iFOB=E();W("FACE_OUTER_BOUND('',#"+iPLp+",.T.)");
        const iDN=E();W("DIRECTION('',("+f(nx)+","+f(ny)+","+f(nz)+"))");
        const iDR=E();W("DIRECTION('',("+f(rx)+","+f(ry)+","+f(rz)+"))");
        const iKP=E();W("CARTESIAN_POINT('',("+f(kx)+","+f(ky)+","+f(kz)+"))");
        const iAXF=E();W("AXIS2_PLACEMENT_3D('',#"+iKP+",#"+iDN+",#"+iDR+")");
        const iSRF=E();W("PLANE('',#"+iAXF+")");
        const iFC=E();W("FACE_SURFACE('',(#"+iFOB+"),#"+iSRF+",.T.)");
        faceIds.push(iFC);
      });
      const iSH=E();W("CLOSED_SHELL('',("+faceIds.map(i=>'#'+i).join(',')+"))");
      const iBR=E();W("FACETED_BREP('"+name.replace(/'/g,"''")+"',#"+iSH+")");
      return iBR;
    };
    // Émission sphère analytique — MANIFOLD_SOLID_BREP à 1 face SPHERICAL_SURFACE.
    // Topologie canonique OCCT : 1 face sphérique bornée par UNE couture méridienne
    // (demi-cercle pôle-sud → pôle-nord, plan X-Z) parcourue 2× (.T. puis .F.).
    // Pôles = sommets dégénérés (singularité v=±π/2 de la paramétrisation sphérique).
    // ~14 entités/sphère au lieu de ~100k (FACETED_BREP à res 128). Importé natif par
    // OCCT/FreeCAD/Fusion/Autodesk Viewer. NB orientation : si normales inversées au
    // réimport, flipper le flag .T. de l'ADVANCED_FACE en .F.
    const _emitSphere=(cx,cy,cz,R,name)=>{
      const iC =E();W("CARTESIAN_POINT('',("+f(cx)+","+f(cy)+","+f(cz)+"))");
      const iDZ=E();W("DIRECTION('',(0.,0.,1.))");
      const iDX=E();W("DIRECTION('',(1.,0.,0.))");
      const iAX=E();W("AXIS2_PLACEMENT_3D('',#"+iC+",#"+iDZ+",#"+iDX+")");
      const iSS=E();W("SPHERICAL_SURFACE('',#"+iAX+","+f(R)+")");
      const iCN=E();W("CARTESIAN_POINT('',("+f(cx)+","+f(cy)+","+f(cz+R)+"))");
      const iVN=E();W("VERTEX_POINT('',#"+iCN+")");
      const iCSp=E();W("CARTESIAN_POINT('',("+f(cx)+","+f(cy)+","+f(cz-R)+"))");
      const iVS=E();W("VERTEX_POINT('',#"+iCSp+")");
      // cercle couture : axe -Y (plan méridien X-Z), ref -Z (θ=0 → pôle sud)
      const iCC =E();W("CARTESIAN_POINT('',("+f(cx)+","+f(cy)+","+f(cz)+"))");
      const iCDz=E();W("DIRECTION('',(0.,-1.,0.))");
      const iCDx=E();W("DIRECTION('',(0.,0.,-1.))");
      const iCAX=E();W("AXIS2_PLACEMENT_3D('',#"+iCC+",#"+iCDz+",#"+iCDx+")");
      const iCIR=E();W("CIRCLE('',#"+iCAX+","+f(R)+")");
      const iEC =E();W("EDGE_CURVE('',#"+iVS+",#"+iVN+",#"+iCIR+",.T.)");
      const iO1 =E();W("ORIENTED_EDGE('',*,*,#"+iEC+",.T.)");
      const iO2 =E();W("ORIENTED_EDGE('',*,*,#"+iEC+",.F.)");
      const iEL =E();W("EDGE_LOOP('',(#"+iO1+",#"+iO2+"))");
      const iFB =E();W("FACE_OUTER_BOUND('',#"+iEL+",.T.)");
      const iAF =E();W("ADVANCED_FACE('',(#"+iFB+"),#"+iSS+",.T.)");
      const iSH =E();W("CLOSED_SHELL('',(#"+iAF+"))");
      const iBR =E();W("MANIFOLD_SOLID_BREP('"+name.replace(/'/g,"''")+"',#"+iSH+")");
      return iBR;
    };

    // ── boucle par objet — choix MANIFOLD_SOLID_BREP / FACETED_BREP ────
    const brepIds=[]; const styledItemIds=[];
    let totalTris=0, nManifold=0, nFaceted=0, nSphere=0;
    (objList||objs).forEach(so=>{
      // ── Sphère à scale uniforme → SPHERICAL_SURFACE analytique ──────────
      // Évite l'explosion FACETED_BREP (res 128 → ~32k triangles/sphère).
      // Scale non-uniforme (ellipsoïde) → on retombe sur la tessellation classique.
      if(so.type==='sphere'){
        const _lg=so.mesh.geometry; _lg.computeBoundingBox(); const _lb=_lg.boundingBox;
        const _sx=Math.abs(so.mesh.scale.x),_sy=Math.abs(so.mesh.scale.y),_sz=Math.abs(so.mesh.scale.z);
        const _W=(_lb.max.x-_lb.min.x)*_sx,_H=(_lb.max.y-_lb.min.y)*_sy,_D=(_lb.max.z-_lb.min.z)*_sz;
        const _mx=Math.max(_W,_H,_D)||1;
        if(Math.abs(_W-_H)/_mx<1e-3 && Math.abs(_H-_D)/_mx<1e-3 && Math.abs(_W-_D)/_mx<1e-3){
          const _wp=new THREE.Vector3(); so.mesh.getWorldPosition(_wp);
          const _C=cv(_wp.x,_wp.y,_wp.z);
          const iBR=_emitSphere(_C[0],_C[1],_C[2],_W/2,so.name);
          brepIds.push(iBR); nSphere++;
          if(_apInfo.hasColors){const col=_getObjColor(so);if(col)styledItemIds.push(_emitColor(iBR,col));}
          return;
        }
      }
      // ── Union triviale de sphères → décomposition analytique multi-corps ──
      // Cas réel : box-select 25 sphères + Union → 1 objet CSG. La branche
      // 'sphere' ci-dessus ne voit plus rien. Ici : si le noeud CSG est une union
      // (op union) de sphères-feuilles DISJOINTES (scale uniforme), émettre chaque
      // sphère en SPHERICAL_SURFACE. Centre = matrixWorld × (p_création − cg).
      // Disjonction re-vérifiée par sphères englobantes : une union OVERLAPPING
      // n'est PAS décomposable en solides séparés → retombe sur la tessellation.
      if(so.type==='csg' && _csgTree.has(so.id)){
        const _nd=_csgTree.get(so.id), _kids=_nd.children||[];
        const _allSph = _nd.op==='union' && _kids.length>0 && _kids.every(c=>
          c.type==='sphere' && !c.isHole && !c._csgTree && c.s &&
          Math.abs(Math.abs(c.s[0])-Math.abs(c.s[1]))<1e-6 &&
          Math.abs(Math.abs(c.s[1])-Math.abs(c.s[2]))<1e-6);
        if(_allSph){
          const _up=new THREE.Vector3(),_uq=new THREE.Quaternion(),_us=new THREE.Vector3();
          so.mesh.matrixWorld.decompose(_up,_uq,_us);
          const _unif = Math.abs(_us.x-_us.y)<1e-6 && Math.abs(_us.y-_us.z)<1e-6;
          const _hasCg = Array.isArray(_nd.cg);
          const _cg = _hasCg ? new THREE.Vector3(_nd.cg[0],_nd.cg[1],_nd.cg[2]) : null;
          if(_unif){
            const _S=_kids.map(c=>{
              const _wc = _hasCg
                ? new THREE.Vector3(c.p[0]-_cg.x,c.p[1]-_cg.y,c.p[2]-_cg.z).applyMatrix4(so.mesh.matrixWorld)
                : new THREE.Vector3(c.p[0],c.p[1],c.p[2]); // legacy (pré-cg) : p déjà en monde
              return {wc:_wc, R:(PS/2)*Math.abs(c.s[0])*(_hasCg?_us.x:1)};
            });
            let _disj=true;
            for(let i=0;i<_S.length&&_disj;i++)for(let j=i+1;j<_S.length;j++){
              if(_S[i].wc.distanceTo(_S[j].wc) < _S[i].R+_S[j].R-1e-4){_disj=false;break;}
            }
            if(_disj){
              const col=_apInfo.hasColors?_getObjColor(so):null;
              _S.forEach((s,k)=>{
                const C=cv(s.wc.x,s.wc.y,s.wc.z);
                const iBR=_emitSphere(C[0],C[1],C[2],s.R,so.name+'_'+(k+1));
                brepIds.push(iBR); nSphere++;
                if(col) styledItemIds.push(_emitColor(iBR,col));
              });
              return;
            }
          }
        }
      }
      const gHD=makeGeoHD(so);
      if(so.type!=='csg'){
        const _p=new THREE.Vector3(),_q=new THREE.Quaternion(),_s=new THREE.Vector3();
        so.mesh.matrixWorld.decompose(_p,_q,_s);
        const mPR=new THREE.Matrix4().makeRotationFromQuaternion(_q);mPR.setPosition(_p);
        gHD.applyMatrix4(mPR);
      } else { gHD.applyMatrix4(so.mesh.matrixWorld); }
      const pos=gHD.attributes.position, ix=gHD.index;
      const nT=ix?ix.count/3:pos.count/3; totalTris+=nT;
      const tris=[];
      for(let i=0;i<nT;i++){
        const ai=ix?ix.getX(i*3):i*3, bi=ix?ix.getX(i*3+1):i*3+1, ci=ix?ix.getX(i*3+2):i*3+2;
        const A=cv(pos.getX(ai),pos.getY(ai),pos.getZ(ai));
        const B=cv(pos.getX(bi),pos.getY(bi),pos.getZ(bi));
        const C=cv(pos.getX(ci),pos.getY(ci),pos.getZ(ci));
        const ex=B[0]-A[0],ey=B[1]-A[1],ez=B[2]-A[2],gx=C[0]-A[0],gy=C[1]-A[1],gz=C[2]-A[2];
        let nx=ey*gz-ez*gy,ny=ez*gx-ex*gz,nz=ex*gy-ey*gx;
        const nl=Math.sqrt(nx*nx+ny*ny+nz*nz);
        if(nl<1e-10)continue; // dégénéré → skip
        nx/=nl;ny/=nl;nz/=nl;
        tris.push({A,B,C,nx,ny,nz});
      }
      if(!tris.length){gHD.dispose();return;}
      const merged=_planarMerge(tris);
      let iBR;
      if(merged){iBR=_emitManifold(merged,so.name);nManifold++;}
      else{iBR=_emitFaceted(tris,so.name);nFaceted++;}
      brepIds.push(iBR);
      if(_apInfo.hasColors){const col=_getObjColor(so);if(col)styledItemIds.push(_emitColor(iBR,col));}
      gHD.dispose();
    });

    // ── Représentation + lien produit ──────────────────────────────────────
    const iSR=E(); W("ADVANCED_BREP_SHAPE_REPRESENTATION('',(#"+iAX0+","+brepIds.map(i=>'#'+i).join(',')+"),#"+iGC+")");
    // ── Conteneur couleurs AP214/AP242 (MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION)
    // Obligatoire pour la conformance AP214 : regroupe tous les STYLED_ITEMs
    // dans une entité de présentation rattachée au contexte géométrique.
    // AP242 : même mécanique, et optionnel en pratique (mais émis pour conformance).
    // AP203 : styledItemIds est toujours vide → ce bloc n'est pas émis.
    if(styledItemIds.length){
      E(); W("MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',("+styledItemIds.map(i=>'#'+i).join(',')+"),#"+iGC+")");
    }
    const iSDR=E(); W("SHAPE_DEFINITION_REPRESENTATION(#"+iPDS+",#"+iSR+")");

    // ── Assemblage fichier ─────────────────────────────────────────────────
    const now=new Date().toISOString().slice(0,19);
    const nObj=(objList||objs).length;
    const step=[
      'ISO-10303-21;',
      'HEADER;',
      "  FILE_DESCRIPTION(('NASSCAD V"+NASSCAD_VERSION+" STEP B-Rep "+_apInfo.name+"'),'2;1');",
      "  FILE_NAME('model.stp','"+now+"',('NassLab'),(''),'','NASSCAD V"+NASSCAD_VERSION+"','');",
      "  FILE_SCHEMA(('"+_apInfo.schema+"'));",
      'ENDSEC;','DATA;',
      '/* NASSCAD V'+NASSCAD_VERSION+' — nasscad.com — '+nObj+' objects — '+totalTris+' triangles — '+
        nManifold+' MANIFOLD_SOLID_BREP / '+nFaceted+' FACETED_BREP / '+nSphere+' SPHERICAL_SURFACE'+
        (styledItemIds.length?' / '+styledItemIds.length+' colored':'')+' — '+_apInfo.name+' */',
      ...L,
      'ENDSEC;','END-ISO-10303-21;',''
    ].join('\n');
    const kb=(step.length/1024).toFixed(1);
    if(opts.returnText){
      // Round-trip interne (repair) : pas de log Export STEP classique, pas de
      // téléchargement — le texte reste en mémoire, remonté par la Promise.
      if(!opts.silent) hideSpinner();
      resolve(step);
      return;
    }
    if(_cfg.logStats!==false)
      nasLog('OK','Export STEP '+_apInfo.name+' B-Rep — '+nObj+' obj — '+totalTris+' tris — '+
        nManifold+' MANIFOLD / '+nFaceted+' FACETED / '+nSphere+' SPHERICAL'+
        (styledItemIds.length?' / '+styledItemIds.length+' colors':'')+
        ' — '+kb+' KB — '+Math.round(performance.now()-t0)+'ms');
    // Nom suggéré : inclut le protocole pour aider l'utilisateur à identifier
    // le fichier dans son dossier (model_AP242.stp, model_AP214.stp…).
    const _suggestedName='model_'+_apInfo.name+'.stp';
    // opts.fileHandle : handle obtenu avant le calcul (dans doStepExport, pendant le clic).
    // null si API absente ou erreur picker → _nasStepSave replie sur _nasDownload.
    await _nasStepSave(_suggestedName, new Blob([step],{type:'application/step'}), opts.fileHandle||null);
    hideSpinner();
    resolve(undefined);
  }));
  });
}