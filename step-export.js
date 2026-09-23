// ══════════════════════════════════════════════════════════════════════════
// step-export.js — module Export STEP (B-Rep analytique, multi-protocole)
//   AP203 CC · AP214 IS · AP242 Ed.1 — ISO 10303-21
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
//   _ioBakeGeo, _ioObjColorHex, _ioFacePalette, _ioTriMaterial  — nasscad-io.js
//     (repli local si le module n'est pas chargé : cf. _stepBake / _stepHexOf)
//
//   Indépendant de step-import.js — aucun couplage détecté (scan confirmé,
//   pas supposé). L'export et l'import STEP ne partagent aucun état.
// ══════════════════════════════════════════════════════════════════════════
// ── Export STEP — B-Rep analytique — ISO 10303-21 / AP203 · AP214 · AP242
// Merge coplanaire : triangles coplanaires connexes → MANIFOLD_SOLID_BREP (ADVANCED_FACE/PLANE,
// EDGE_CURVE/LINE, VERTEX_POINT partagés). Fallback FACETED_BREP si mesh non-planaire (organique).
// Three.js Y-up → STEP Z-up : cv(x,y,z)=[x,-z,y]. Validé : Autodesk Viewer, FreeCAD.
//
// [AUDIT STEP 18/09] Structure et couleurs refaites d'après la référence
// OCCT 8.0 (STEPCAFControl_Writer + XCAFDoc_ColorTool), relue entité par entité :
//   • assemblage — 1 PRODUCT par corps + NEXT_ASSEMBLY_USAGE_OCCURRENCE, au lieu
//     d'un produit unique avalant tous les solides (les noms de corps étaient perdus) ;
//   • couleurs PAR FACE — OVER_RIDING_STYLED_ITEM sur l'ADVANCED_FACE, comme OCCT ;
//   • transparence — SURFACE_STYLE_RENDERING_WITH_PROPERTIES + SURFACE_STYLE_TRANSPARENT ;
//   • AP203 — appareil de configuration control (CC_DESIGN_*) et couleurs via
//     le schéma SHAPE_APPEARANCE_LAYER_MIM : AP203 n'est plus le protocole sans couleur ;
//   • ISO 10303-21 — chaînes échappées (\X2\ et antislash), lignes repliées à 72
//     caractères (la norme en interdit plus de 256), plus aucune liste vide à virgule.
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
// AP203 — CONFIG_CONTROL_DESIGN :
//   Compatibilité maximale (SolidWorks, CATIA, AutoCAD, tous lecteurs STEP).
//   [18/09] Le schéma déclaré était la MIM longue de l'édition 2 alors que le
//   fichier ne portait ni l'appareil de configuration control ni les sous-types
//   MECHANICAL_CONTEXT/DESIGN_CONTEXT : il n'était conforme à aucune des deux
//   éditions. On écrit désormais l'édition 1 complète — c'est elle que tous les
//   lecteurs attendent, et c'est ce qu'écrit OCCT pour 'AP203'.
//   Les couleurs passent par le second schéma SHAPE_APPEARANCE_LAYER_MIM.
// AP214 — 10303-214 IS :
//   Standard automobile/mécanique le plus répandu en industrie.
//   COLOUR_RGB + STYLED_ITEM + MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION.
// AP242 Ed.1 — 10303-442 MIM LF :
//   Standard actuel (2014), superset AP203+AP214 + MBD/PMI.
//   Même chaîne couleur que AP214, capacités MBD supplémentaires.
const STEPApVersions = {
  AP203: {
    name:       'AP203',
    label:      'Config Controlled Design',
    schema:     'CONFIG_CONTROL_DESIGN',
    schemaStyle:'SHAPE_APPEARANCE_LAYER_MIM',  // 2e schéma déclaré si le modèle a des couleurs
    appCtxText: 'configuration controlled 3D designs of mechanical parts and assemblies',
    apdStd:     'international standard',
    apdName:    'config_control_design',
    apdYear:    1994,
    ctxProduct: 'MECHANICAL_CONTEXT',
    ctxDefApi:  'DESIGN_CONTEXT',
    ctxDefName: '',
    srcSpec:    true,   // PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE
    ccDesign:   true,   // appareil CC_DESIGN_* (approbation, classement, personne)
    hasColors:  true
  },
  AP214: {
    name:       'AP214',
    label:      'Automotive Design',
    schema:     'AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }',
    schemaStyle:null,
    appCtxText: 'core data for automotive mechanical design processes',
    apdStd:     'international standard',
    apdName:    'automotive_design',
    apdYear:    2000,
    ctxProduct: 'PRODUCT_CONTEXT',
    ctxDefApi:  'PRODUCT_DEFINITION_CONTEXT',
    ctxDefName: 'part definition',
    srcSpec:    false,
    ccDesign:   false,
    hasColors:  true
  },
  AP242: {
    name:       'AP242',
    label:      'Managed Model 3D Eng.',
    schema:     'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }',
    schemaStyle:null,
    appCtxText: 'Managed model based 3d engineering',
    apdStd:     'international standard',
    apdName:    'ap242_managed_model_based_3d_engineering',
    apdYear:    2013,
    ctxProduct: 'PRODUCT_CONTEXT',
    ctxDefApi:  'PRODUCT_DEFINITION_CONTEXT',
    ctxDefName: 'part definition',
    srcSpec:    false,
    ccDesign:   false,
    hasColors:  true
  }
};
// Au-delà de cette limite, les couleurs par face d'un corps sont abandonnées au
// profit de la seule couleur de corps : un OVER_RIDING_STYLED_ITEM pèse 8 entités
// et un maillage organique multicolore en produirait des centaines de milliers.
const _STEP_MAX_FACE_STYLES = 20000;

// ── ISO 10303-21 clause 7 — écriture des littéraux ────────────────────────
// Chaîne : seul l'ASCII imprimable est autorisé tel quel. L'apostrophe se
// double, l'antislash AUSSI (il ouvre les séquences d'échappement : 'C:\Bac'
// était lu comme un échappement \B invalide et cassait tout le fichier), et
// tout le reste passe en \X2\<UTF-16>\X0\. Les paires de substitution UTF-16
// s'écrivent comme deux unités consécutives dans le même \X2\ — c'est ce que
// lisent OCCT, FreeCAD et les traducteurs commerciaux.
// La chaîne encodée est plafonnée : la norme interdit les lignes de plus de
// 256 caractères et RIEN ne permet de couper une chaîne en deux lignes. Un nom
// de corps de 300 caractères produisait donc une ligne non conforme. 200
// caractères encodés laissent la place au préfixe '#123456 = PRODUCT(' et au
// repli (les deux occurrences du nom sont séparées par une virgule).
// _stepStr.truncated compte les noms rognés, pour le journal d'export.
function _stepStr(s, max){
  max = max || 200;
  s = (s === undefined || s === null) ? '' : String(s);
  let out = '', buf = '', cut = false;
  const flush = () => { if(buf){ out += '\\X2\\' + buf + '\\X0\\'; buf = ''; } };
  for(let i = 0; i < s.length; i++){
    const c = s.charCodeAt(i);
    const ascii = (c >= 32 && c <= 126);
    const len = ascii ? out.length + (buf ? buf.length + 8 : 0) + ((c === 39 || c === 92) ? 2 : 1)
                      : out.length + buf.length + 4 + 8;
    if(len > max){ cut = true; break; }
    if(c === 39){ flush(); out += "''"; }            // ' → ''
    else if(c === 92){ flush(); out += '\\\\'; }      // \ → \\
    else if(ascii){ flush(); out += s[i]; }
    else buf += c.toString(16).toUpperCase().padStart(4, '0');
  }
  // Ne jamais laisser une demi-paire de substitution en fin de chaîne : une
  // coupe pile entre les deux moitiés d'un emoji donnerait un caractère UTF-16
  // invalide au lecteur.
  if(cut && buf.length >= 4){
    const last = parseInt(buf.slice(-4), 16);
    if(last >= 0xD800 && last <= 0xDBFF) buf = buf.slice(0, -4);
  }
  flush();
  if(cut) _stepStr.truncated = (_stepStr.truncated || 0) + 1;
  return out;
}
_stepStr.truncated = 0;
// Réel Part 21 : un point décimal est OBLIGATOIRE. toFixed() suffit pour les
// magnitudes usuelles mais rend '1e+21' au-delà de 1e21 — littéral invalide.
// Les zéros de queue sont retirés : '8.000000' → '8.', ~15 % de fichier en moins.
function _stepReal(v, dec){
  if(!isFinite(v)) v = 0;
  const a = v < 0 ? -v : v;
  if(a !== 0 && (a >= 1e15 || a < 1e-9)){
    const parts = v.toExponential(Math.min(17, (dec || 6) + 3)).split('e');
    let m = parts[0].replace(/(\.\d*?)0+$/, '$1');
    if(m.indexOf('.') < 0) m += '.';
    const e = parts[1];
    return m + 'E' + (e[0] === '-' ? e : '+' + e.replace('+', ''));
  }
  // Coupe des zéros de queue à la main : appelée des millions de fois sur un
  // gros maillage, une expression régulière par coordonnée se paierait cher.
  let s = v.toFixed(dec), e = s.length;
  while(s.charCodeAt(e - 1) === 48) e--;             // 48 = '0'
  if(e < s.length) s = s.slice(0, e);                // le point décimal reste
  return s === '-0.' ? '0.' : s;
}
// Repli de ligne : ISO 10303-21 interdit plus de 256 caractères par ligne, et
// l'usage (OCCT, tous les traducteurs) est de replier autour de 72. Une seule
// CLOSED_SHELL de gros maillage faisait 3000 caractères sur une ligne.
// La coupe ne tombe qu'après une virgule HORS chaîne ('' bascule deux fois,
// l'état reste donc correct).
function _stepFold(s, max){
  max = max || 72;
  if(s.length <= max) return s;
  const out = []; let cur = '', q = false;
  for(let i = 0; i < s.length; i++){
    const c = s[i];
    cur += c;
    if(c === "'") q = !q;
    if(!q && c === ',' && cur.length >= max){ out.push(cur); cur = '  '; }
  }
  if(cur.trim()) out.push(cur);
  return out.join('\n');
}
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
      nasLog('WARN','FileHandle write: '+e.message+' — browser fallback');
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
      nasLog('WARN','showSaveFilePicker: '+e.message+' — browser fallback');
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

// ── Géométrie monde d'un corps ────────────────────────────────────────────
// Même cuisson que les exports STL/OBJ/3MF/GLB (nasscad-io.js) : matrice monde,
// et inversion du bouclage quand le déterminant est négatif — un corps mis à
// l'échelle -1 sortait sinon avec ses normales retournées, donc un solide de
// volume négatif pour un lecteur STEP. Repli local si nasscad-io.js est absent.
function _stepBake(so){
  if(typeof _ioBakeGeo === 'function') return _ioBakeGeo(so);
  const g = makeGeoHD(so);
  let M = so.mesh.matrixWorld;
  if(so.type !== 'csg'){
    const _p=new THREE.Vector3(),_q=new THREE.Quaternion(),_s=new THREE.Vector3();
    so.mesh.matrixWorld.decompose(_p,_q,_s);
    M = new THREE.Matrix4().makeRotationFromQuaternion(_q); M.setPosition(_p);
  }
  g.applyMatrix4(M);
  return g;
}
// Couleur de corps 'rrggbb' (sans dièse) — même source que 3MF/GLB/OBJ.
function _stepHexOf(so){
  if(typeof _ioObjColorHex === 'function') return _ioObjColorHex(so);
  const m = Array.isArray(so.mesh.material) ? so.mesh.material[0] : so.mesh.material;
  if(m && m.color) return m.color.getHexString();
  if(typeof so.color === 'string' && /^#?[0-9a-f]{6}/i.test(so.color)) return so.color.replace('#','').slice(0,6).toLowerCase();
  return 'cccccc';
}
// Opacité d'un matériau : 1 si opaque. Un corps en mode trou garde son rouge
// d'interface opaque (sa transparence est un artefact d'affichage).
function _stepAlpha(m, so){
  return (m && m.transparent && typeof m.opacity === 'number' && m.opacity < 1 && !(so && so.isHole))
    ? Math.max(0, Math.min(1, m.opacity)) : 1;
}
// Style par index de matériau : [{hex,a}, …] ou null si le corps est uni.
function _stepFacePalette(so){
  const L = so.mesh && so.mesh.material;
  if(!Array.isArray(L) || L.length < 2) return null;
  const pal = (typeof _ioFacePalette === 'function') ? _ioFacePalette(so) : null;
  if(!pal) return null;
  return pal.map((h, i) => ({hex: String(h).replace('#','').slice(0,6).toLowerCase(), a: _stepAlpha(L[i], so)}));
}

function _expSTEPRun(objList, opts){
  opts = opts || {};
  const t0=performance.now();
  const _cfg=globalThis._stepExportConfig||{};
  const _mode=_cfg.fusionMode||'ROBUST';
  const _mInfo=STEPFusionModes[_mode]||STEPFusionModes.ROBUST;
  const _apVersion=_cfg.apVersion||'AP242';
  const _apInfo=STEPApVersions[_apVersion]||STEPApVersions.AP242;
  // [18/09] Le mode de fusion ne servait qu'à peupler le libellé du spinner :
  // EXACT, ROBUST et FACETED rendaient trois fichiers identiques au octet près,
  // et la tolérance personnalisée de la modale n'était lue par personne.
  //   • decimals → quantification des sommets ET des plans dans le merge
  //     coplanaire : c'est la tolérance de fusion, celle que le mode promet ;
  //   • FACETED  → plus de merge du tout, une face par triangle ;
  //   • tolerance → UNCERTAINTY_MEASURE_WITH_UNIT du contexte géométrique,
  //     au lieu d'un 0.001 mm figé sans rapport avec le calcul.
  // Les coordonnées, elles, restent écrites à 6 décimales quel que soit le mode.
  const _tol = (_cfg.customTolerance!=null && isFinite(_cfg.customTolerance) && _cfg.customTolerance>0)
    ? _cfg.customTolerance : (_mInfo.tolerance!=null ? _mInfo.tolerance : 1e-5);
  const _keyDec = (_cfg.customTolerance!=null && isFinite(_cfg.customTolerance) && _cfg.customTolerance>0)
    ? Math.max(1, Math.min(9, Math.round(-Math.log10(_cfg.customTolerance))))
    : (_mInfo.decimals!=null ? _mInfo.decimals : 6);
  if(!opts.silent) showSpinner('Export STEP '+_apInfo.name,'Mode: '+_mInfo.name+' — B-Rep…');
  // Double rAF : garantit que le spinner est peint avant le traitement synchrone.
  // [FIX 17/07] Retourne désormais une Promise (résolue avec le texte STEP si
  // opts.returnText, sinon undefined) — 100% rétro-compatible : les appels
  // existants ignorent déjà la valeur de retour (fire-and-forget).
  return new Promise((resolve)=>{
  requestAnimationFrame(()=>requestAnimationFrame(async ()=>{
    scene.updateMatrixWorld(true);
    const cv=(x,y,z)=>[x,-z,y]; // Three.js Y-up → STEP Z-up
    const f=v=>_stepReal(v,6);            // coordonnées écrites
    // Clé de fusion (sommets, plans). Le zéro négatif est ramené à '0.…' :
    // sinon deux sommets distants de 2e-9 de part et d'autre de zéro portent
    // des clés différentes et la face refuse de se fermer.
    const q=v=>{const s=(+v).toFixed(_keyDec); return s.charCodeAt(0)===45&&+s===0?s.slice(1):s;};
    _stepStr.truncated=0;
    let id=0; const L=[];
    const E=()=>{ id++; return id; };
    const W=(s)=>{ L.push('#'+id+' = '+s+';'); };
    const R=a=>'('+a.map(i=>'#'+i).join(',')+')';   // liste de références, jamais vide ici

    // ── Boilerplate AP — paramétré par _apInfo ────────────────────────────
    // Émet APPLICATION_CONTEXT, APPLICATION_PROTOCOL_DEFINITION, les unités et
    // le placement origine. Les PRODUCT sont émis plus bas, un par corps.
    // APPLICATION_PROTOCOL_DEFINITION n'est pas référencée en aval (métadonnée
    // de conformance — les validateurs STEP l'exigent, les parseurs géo non).
    const iAC =E(); W("APPLICATION_CONTEXT('"+_stepStr(_apInfo.appCtxText)+"')");
    E();            W("APPLICATION_PROTOCOL_DEFINITION('"+_stepStr(_apInfo.apdStd)+"','"+_stepStr(_apInfo.apdName)+"',"+_apInfo.apdYear+",#"+iAC+")");
    const iUL =E(); W("(NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.)))");
    const iUA =E(); W("(NAMED_UNIT(*) SI_UNIT($,.RADIAN.) PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(1.)))");
    const iUS =E(); W("(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_MEASURE_WITH_UNIT(SOLID_ANGLE_MEASURE(1.)))");
    const iUM =E(); W("UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE("+_stepReal(_tol,12)+"),#"+iUL+",'distance_accuracy_value','confusion accuracy')");
    const iGC =E(); W("(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#"+iUM+")) GLOBAL_UNIT_ASSIGNED_CONTEXT((#"+iUL+",#"+iUA+",#"+iUS+")) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))");
    // Origine partagée : la géométrie est cuite en coordonnées monde, donc chaque
    // composant de l'assemblage porte la transformation identité.
    const iCP0=E(); W("CARTESIAN_POINT('',(0.,0.,0.))");
    const iDZ0=E(); W("DIRECTION('',(0.,0.,1.))");
    const iDX0=E(); W("DIRECTION('',(1.,0.,0.))");
    const iAX0=E(); W("AXIS2_PLACEMENT_3D('',#"+iCP0+",#"+iDZ0+",#"+iDX0+")");
    // Contextes de produit — partagés par tous les produits du fichier.
    const iPC =E(); W(_apInfo.ctxProduct+"('',#"+iAC+",'mechanical')");
    const iPDC=E(); W(_apInfo.ctxDefApi+"('"+_stepStr(_apInfo.ctxDefName)+"',#"+iAC+",'design')");

    // ── Styles (AP203 via SHAPE_APPEARANCE_LAYER_MIM, AP214, AP242) ───────
    // Chaîne normative ISO 10303-46 :
    //   COLOUR_RGB → FILL_AREA_STYLE_COLOUR → FILL_AREA_STYLE →
    //   SURFACE_STYLE_FILL_AREA → SURFACE_SIDE_STYLE → SURFACE_STYLE_USAGE →
    //   PRESENTATION_STYLE_ASSIGNMENT → STYLED_ITEM
    // Transparence : SURFACE_SIDE_STYLE porte en plus un
    //   SURFACE_STYLE_RENDERING_WITH_PROPERTIES(.NORMAL_SHADING.,#colour,(#transp))
    //   avec SURFACE_STYLE_TRANSPARENT(1 − alpha). C'est le couple que lisent
    //   OCCT (XCAFDoc_ColorTool, alpha), FreeCAD et les visionneuses.
    // La chaîne est mise en cache par (teinte, alpha) : un modèle de 500 corps
    // rouges opaques n'émet qu'une seule fois les 7 entités de style.
    const _styleCache=new Map();
    const styledItemIds=[];
    const _style=(hex,a)=>{
      const k=hex+'|'+a.toFixed(3);
      if(_styleCache.has(k)) return _styleCache.get(k);
      const r=parseInt(hex.slice(0,2),16)/255, g=parseInt(hex.slice(2,4),16)/255, b=parseInt(hex.slice(4,6),16)/255;
      const iRGB =E(); W("COLOUR_RGB('',"+f(r)+","+f(g)+","+f(b)+")");
      const iFASC=E(); W("FILL_AREA_STYLE_COLOUR('',#"+iRGB+")");
      const iFAS =E(); W("FILL_AREA_STYLE('',(#"+iFASC+"))");
      const iSSFA=E(); W("SURFACE_STYLE_FILL_AREA(#"+iFAS+")");
      const sides=[iSSFA];
      if(a<1){
        const iTR=E(); W("SURFACE_STYLE_TRANSPARENT("+f(1-a)+")");
        const iRP=E(); W("SURFACE_STYLE_RENDERING_WITH_PROPERTIES(.NORMAL_SHADING.,#"+iRGB+",(#"+iTR+"))");
        sides.push(iRP);
      }
      const iSSS =E(); W("SURFACE_SIDE_STYLE('',"+R(sides)+")");
      const iSSU =E(); W("SURFACE_STYLE_USAGE(.BOTH.,#"+iSSS+")");
      const iPSA =E(); W("PRESENTATION_STYLE_ASSIGNMENT((#"+iSSU+"))");
      _styleCache.set(k,iPSA); return iPSA;
    };
    // STYLED_ITEM de corps, puis OVER_RIDING_STYLED_ITEM pour chaque face qui
    // s'écarte de la teinte du corps — exactement la construction d'OCCT.
    // [FIX V4.2.7 19/06, même piège] _style() émet des entités : son id est
    // résolu AVANT le E() englobant, jamais dans l'argument du W().
    const _styleBody=(iItem,hex,a)=>{
      const iPSA=_style(hex,a);
      const iSI=E(); W("STYLED_ITEM('color',(#"+iPSA+"),#"+iItem+")");
      styledItemIds.push(iSI); return iSI;
    };
    const _styleFace=(iFace,hex,a,iParent)=>{
      const iPSA=_style(hex,a);
      const iSI=E(); W("OVER_RIDING_STYLED_ITEM('overriding color',(#"+iPSA+"),#"+iFace+",#"+iParent+")");
      styledItemIds.push(iSI); return iSI;
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
    // [18/09] La clé de plan inclut l'index de matériau : deux triangles coplanaires
    // de couleurs différentes ne fusionnent plus dans la même face, condition pour
    // que chaque ADVANCED_FACE porte une couleur unique.
    const _planarMerge=(tris)=>{
      if(!tris.length)return null;
      const vk=p=>q(p[0])+'|'+q(p[1])+'|'+q(p[2]);
      const pk=t=>q(t.nx)+','+q(t.ny)+','+q(t.nz)+','+
        q(t.nx*t.A[0]+t.ny*t.A[1]+t.nz*t.A[2])+','+t.m;
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
          faces.push({outerLoop:outer.loop, holeLoops:holes.map(h=>h.loop), n:nrm, m:tris[comp[0]].m});
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
    // Émission MANIFOLD_SOLID_BREP — faces planes + arêtes/sommets partagés.
    // Rend {brep, faces:[{id,m}]} : les ids de face servent aux couleurs par face.
    const _emitManifold=(faces,name)=>{
      const vk=p=>q(p[0])+'|'+q(p[1])+'|'+q(p[2]);
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
        const iEL=E();W("EDGE_LOOP('',"+R(oeIds)+")");
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
        const iAF=E();W("ADVANCED_FACE('',"+R(boundIds)+",#"+iPLn+",.T.)");
        faceIds.push({id:iAF,m:fc.m});
      });
      const iSH=E();W("CLOSED_SHELL('',"+R(faceIds.map(x=>x.id))+")");
      const iBR=E();W("MANIFOLD_SOLID_BREP('"+_stepStr(name)+"',#"+iSH+")");
      return {brep:iBR, faces:faceIds};
    };
    // Émission FACETED_BREP — fallback (1 FACE_SURFACE/triangle, historique)
    // [18/09] Une coque ouverte ne sort plus en CLOSED_SHELL. Un maillage non
    // étanche — la moitié des modèles NASA, tout ce qui est scanné ou décoratif —
    // était déclaré solide fermé : le lecteur y voit un solide invalide et en
    // calcule un volume qui ne veut rien dire. La parité des arêtes tranche, et
    // une coque ouverte part en OPEN_SHELL + SHELL_BASED_SURFACE_MODEL, ce qui
    // est la vérité et ce qu'écrit OCCT dans le même cas.
    const _emitFaceted=(tris,name)=>{
      const ptMap=new Map();
      const mkPt=(x,y,z)=>{const k=q(x)+'|'+q(y)+'|'+q(z);
        if(ptMap.has(k))return ptMap.get(k);
        const i=E();W("CARTESIAN_POINT('',("+f(x)+","+f(y)+","+f(z)+"))");
        ptMap.set(k,i);return i;};
      const par=new Map();
      const bump=(a,b)=>{const k=a<b?a+':'+b:b+':'+a; par.set(k,(par.get(k)||0)+1);};
      const faceIds=[];
      tris.forEach(t=>{
        const[ax,ay,az]=t.A,[bx,by,bz]=t.B,[cx,cy,cz]=t.C,{nx,ny,nz}=t;
        let rx=1,ry=0,rz=0; if(Math.abs(nx)>0.9){rx=0;ry=1;rz=0;}
        const dot=rx*nx+ry*ny+rz*nz; rx-=dot*nx;ry-=dot*ny;rz-=dot*nz;
        const rl=Math.sqrt(rx*rx+ry*ry+rz*rz)||1; rx/=rl;ry/=rl;rz/=rl;
        const kx=(ax+bx+cx)/3,ky=(ay+by+cy)/3,kz=(az+bz+cz)/3;
        const iA=mkPt(ax,ay,az),iB=mkPt(bx,by,bz),iC=mkPt(cx,cy,cz);
        bump(iA,iB); bump(iB,iC); bump(iC,iA);
        const iPLp=E();W("POLY_LOOP('',(#"+iA+",#"+iB+",#"+iC+"))");
        const iFOB=E();W("FACE_OUTER_BOUND('',#"+iPLp+",.T.)");
        const iDN=E();W("DIRECTION('',("+f(nx)+","+f(ny)+","+f(nz)+"))");
        const iDR=E();W("DIRECTION('',("+f(rx)+","+f(ry)+","+f(rz)+"))");
        const iKP=E();W("CARTESIAN_POINT('',("+f(kx)+","+f(ky)+","+f(kz)+"))");
        const iAXF=E();W("AXIS2_PLACEMENT_3D('',#"+iKP+",#"+iDN+",#"+iDR+")");
        const iSRF=E();W("PLANE('',#"+iAXF+")");
        const iFC=E();W("FACE_SURFACE('',(#"+iFOB+"),#"+iSRF+",.T.)");
        faceIds.push({id:iFC,m:t.m});
      });
      let closed=true;
      for(const v of par.values()) if(v!==2){ closed=false; break; }
      if(closed){
        const iSH=E();W("CLOSED_SHELL('',"+R(faceIds.map(x=>x.id))+")");
        const iBR=E();W("FACETED_BREP('"+_stepStr(name)+"',#"+iSH+")");
        return {brep:iBR, faces:faceIds, open:false};
      }
      const iSH=E();W("OPEN_SHELL('',"+R(faceIds.map(x=>x.id))+")");
      const iBR=E();W("SHELL_BASED_SURFACE_MODEL('"+_stepStr(name)+"',(#"+iSH+"))");
      return {brep:iBR, faces:faceIds, open:true};
    };
    // Émission sphère analytique — MANIFOLD_SOLID_BREP à 1 face SPHERICAL_SURFACE.
    // Topologie canonique OCCT : 1 face sphérique bornée par UNE couture méridienne
    // (demi-cercle pôle-sud → pôle-nord, plan X-Z) parcourue 2× (.T. puis .F.).
    // Pôles = sommets dégénérés (singularité v=±π/2 de la paramétrisation sphérique).
    // ~14 entités/sphère au lieu de ~100k (FACETED_BREP à res 128). Importé natif par
    // OCCT/FreeCAD/Fusion/Autodesk Viewer. NB orientation : si normales inversées au
    // réimport, flipper le flag .T. de l'ADVANCED_FACE en .F.
    const _emitSphere=(cx,cy,cz,Rd,name)=>{
      const iC =E();W("CARTESIAN_POINT('',("+f(cx)+","+f(cy)+","+f(cz)+"))");
      const iDZ=E();W("DIRECTION('',(0.,0.,1.))");
      const iDX=E();W("DIRECTION('',(1.,0.,0.))");
      const iAX=E();W("AXIS2_PLACEMENT_3D('',#"+iC+",#"+iDZ+",#"+iDX+")");
      const iSS=E();W("SPHERICAL_SURFACE('',#"+iAX+","+f(Rd)+")");
      const iCN=E();W("CARTESIAN_POINT('',("+f(cx)+","+f(cy)+","+f(cz+Rd)+"))");
      const iVN=E();W("VERTEX_POINT('',#"+iCN+")");
      const iCSp=E();W("CARTESIAN_POINT('',("+f(cx)+","+f(cy)+","+f(cz-Rd)+"))");
      const iVS=E();W("VERTEX_POINT('',#"+iCSp+")");
      // cercle couture : axe -Y (plan méridien X-Z), ref -Z (θ=0 → pôle sud)
      const iCC =E();W("CARTESIAN_POINT('',("+f(cx)+","+f(cy)+","+f(cz)+"))");
      const iCDz=E();W("DIRECTION('',(0.,-1.,0.))");
      const iCDx=E();W("DIRECTION('',(0.,0.,-1.))");
      const iCAX=E();W("AXIS2_PLACEMENT_3D('',#"+iCC+",#"+iCDz+",#"+iCDx+")");
      const iCIR=E();W("CIRCLE('',#"+iCAX+","+f(Rd)+")");
      const iEC =E();W("EDGE_CURVE('',#"+iVS+",#"+iVN+",#"+iCIR+",.T.)");
      const iO1 =E();W("ORIENTED_EDGE('',*,*,#"+iEC+",.T.)");
      const iO2 =E();W("ORIENTED_EDGE('',*,*,#"+iEC+",.F.)");
      const iEL =E();W("EDGE_LOOP('',(#"+iO1+",#"+iO2+"))");
      const iFB =E();W("FACE_OUTER_BOUND('',#"+iEL+",.T.)");
      const iAF =E();W("ADVANCED_FACE('',(#"+iFB+"),#"+iSS+",.T.)");
      const iSH =E();W("CLOSED_SHELL('',(#"+iAF+"))");
      const iBR =E();W("MANIFOLD_SOLID_BREP('"+_stepStr(name)+"',#"+iSH+")");
      return {brep:iBR, faces:[{id:iAF,m:-1}]};
    };

    // ── boucle par objet — choix MANIFOLD_SOLID_BREP / FACETED_BREP ────
    // parts[] : un élément par SOLIDE émis = un PRODUCT dans l'assemblage.
    const parts=[];
    let totalTris=0, nManifold=0, nFaceted=0, nSphere=0, nFaceStyled=0, nStyleDropped=0, nOpen=0;
    const _pushPart=(res,name,base,pal,faceted)=>{
      parts.push({brep:res.brep, faces:res.faces, name:name, base:base, pal:pal,
                  faceted:!!faceted, open:!!res.open});
      if(res.open) nOpen++;
    };
    // ISO 10303-514 : ADVANCED_BREP_SHAPE_REPRESENTATION n'accepte que des faces
    // avancees (ADVANCED_FACE, bords en EDGE_LOOP). Un FACETED_BREP, dont les
    // bords sont des POLY_LOOP, releve de FACETED_BREP_SHAPE_REPRESENTATION —
    // l'ancien export mettait les deux dans la meme entite.
    // Une coque ouverte n'est pas un solide : elle releve de
    // MANIFOLD_SURFACE_SHAPE_REPRESENTATION (SHELL_BASED_SURFACE_MODEL).
    const _repOf=pt=>pt.open?'MANIFOLD_SURFACE_SHAPE_REPRESENTATION'
      :(pt.faceted?'FACETED_BREP_SHAPE_REPRESENTATION':'ADVANCED_BREP_SHAPE_REPRESENTATION');
    (objList||objs).forEach(so=>{
      const base={hex:_stepHexOf(so), a:_stepAlpha(Array.isArray(so.mesh.material)?so.mesh.material[0]:so.mesh.material, so)};
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
          _pushPart(_emitSphere(_C[0],_C[1],_C[2],_W/2,so.name), so.name, base, null);
          nSphere++;
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
              _S.forEach((s,k)=>{
                const C=cv(s.wc.x,s.wc.y,s.wc.z);
                _pushPart(_emitSphere(C[0],C[1],C[2],s.R,so.name+'_'+(k+1)), so.name+'_'+(k+1), base, null);
                nSphere++;
              });
              return;
            }
          }
        }
      }
      const gHD=_stepBake(so);
      const pos=gHD.attributes.position, ix=gHD.index;
      const nT=ix?ix.count/3:pos.count/3; totalTris+=nT;
      // Index de matériau par triangle : c'est lui qui portera la couleur de face.
      const pal=_stepFacePalette(so);
      const triMat=(pal && typeof _ioTriMaterial==='function') ? _ioTriMaterial(gHD) : null;
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
        tris.push({A,B,C,nx,ny,nz,m:triMat?triMat[i]:-1});
      }
      if(!tris.length){gHD.dispose();return;}
      const merged=(_mode==='FACETED')?null:_planarMerge(tris);
      if(merged){_pushPart(_emitManifold(merged,so.name), so.name, base, pal); nManifold++;}
      else{_pushPart(_emitFaceted(tris,so.name), so.name, base, pal, true); nFaceted++;}
      gHD.dispose();
    });

    // ── Produits, assemblage et styles ─────────────────────────────────────
    // Un PRODUCT par corps (choix de l'utilisateur), relié au produit racine par
    // NEXT_ASSEMBLY_USAGE_OCCURRENCE — c'est la structure que lisent XCAF (OCCT),
    // FreeCAD, SolidWorks : sans elle, les corps arrivaient anonymes dans un seul
    // produit fourre-tout et tous les noms de l'arbre NASSCAD étaient perdus.
    // Un seul corps → un seul produit, pas d'assemblage à un composant.
    const _usedIds=new Set();
    const _uniqueId=(n)=>{                      // PRODUCT.id doit rester distinctif
      let base=(n&&String(n).trim())||'Body', k=base, i=2;
      while(_usedIds.has(k)){ k=base+' ('+(i++)+')'; }
      _usedIds.add(k); return k;
    };
    // Squelette produit : PRODUCT → FORMATION → DEFINITION → DEFINITION_SHAPE.
    const _emitProduct=(name)=>{
      const pid=_uniqueId(name);
      const iPr =E(); W("PRODUCT('"+_stepStr(pid)+"','"+_stepStr(name||pid)+"','',(#"+iPC+"))");
      const iPDF=E(); W(_apInfo.srcSpec
        ? "PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#"+iPr+",.NOT_KNOWN.)"
        : "PRODUCT_DEFINITION_FORMATION('','',#"+iPr+")");
      const iPD =E(); W("PRODUCT_DEFINITION('design','',#"+iPDF+",#"+iPDC+")");
      const iPDS=E(); W("PRODUCT_DEFINITION_SHAPE('','',#"+iPD+")");
      return {iPr,iPDF,iPD,iPDS};
    };
    // ── AP203 : appareil de configuration control ─────────────────────────
    // CONFIG_CONTROL_DESIGN impose que chaque version de produit porte son
    // approbation, son classement de sécurité, son créateur et ses dates.
    // Ces entités manquaient : le fichier se disait AP203 sans en respecter le
    // contenu. Personne, organisation, rôles, approbation et date sont partagés ;
    // seul le classement de sécurité est propre à chaque produit (comme OCCT).
    let _cc=null;
    if(_apInfo.ccDesign){
      const d=new Date();
      const iPers=E(); W("PERSON('nasscad','','NASSCAD',$,$,$)");
      const iOrg =E(); W("ORGANIZATION('nasscad','NASSCAD','')");
      const iPO  =E(); W("PERSON_AND_ORGANIZATION(#"+iPers+",#"+iOrg+")");
      const iRCr =E(); W("PERSON_AND_ORGANIZATION_ROLE('creator')");
      const iROw =E(); W("PERSON_AND_ORGANIZATION_ROLE('design_owner')");
      const iRSu =E(); W("PERSON_AND_ORGANIZATION_ROLE('design_supplier')");
      const iRCl =E(); W("PERSON_AND_ORGANIZATION_ROLE('classification_officer')");
      const iLvl =E(); W("SECURITY_CLASSIFICATION_LEVEL('unclassified')");
      const iUTC =E(); W("COORDINATED_UNIVERSAL_TIME_OFFSET(0,$,.EXACT.)");
      const iCal =E(); W("CALENDAR_DATE("+d.getUTCFullYear()+","+d.getUTCDate()+","+(d.getUTCMonth()+1)+")");
      const iTim =E(); W("LOCAL_TIME("+d.getUTCHours()+","+d.getUTCMinutes()+",$,#"+iUTC+")");
      const iDT  =E(); W("DATE_AND_TIME(#"+iCal+",#"+iTim+")");
      const iRCrD=E(); W("DATE_TIME_ROLE('creation_date')");
      const iRClD=E(); W("DATE_TIME_ROLE('classification_date')");
      const iASt =E(); W("APPROVAL_STATUS('not_yet_approved')");
      const iApp =E(); W("APPROVAL(#"+iASt+",'')");
      const iARo =E(); W("APPROVAL_ROLE('approver')");
      E(); W("APPROVAL_PERSON_ORGANIZATION(#"+iPO+",#"+iApp+",#"+iARo+")");
      E(); W("APPROVAL_DATE_TIME(#"+iDT+",#"+iApp+")");
      _cc={iPO,iRCr,iROw,iRSu,iRCl,iLvl,iDT,iRCrD,iRClD,iApp};
    }
    // Catégorie de produit + données CC attachées à un produit donné.
    const _emitProductMeta=(P)=>{
      if(_apInfo.ccDesign){
        const iPRPC=E(); W("PRODUCT_RELATED_PRODUCT_CATEGORY('detail',$,(#"+P.iPr+"))");
        const iCat =E(); W("PRODUCT_CATEGORY('part',$)");
        E(); W("PRODUCT_CATEGORY_RELATIONSHIP('','',#"+iCat+",#"+iPRPC+")");
        const iSec =E(); W("SECURITY_CLASSIFICATION('','',#"+_cc.iLvl+")");
        E(); W("CC_DESIGN_PERSON_AND_ORGANIZATION_ASSIGNMENT(#"+_cc.iPO+",#"+_cc.iRCr+",(#"+P.iPDF+",#"+P.iPD+"))");
        E(); W("CC_DESIGN_PERSON_AND_ORGANIZATION_ASSIGNMENT(#"+_cc.iPO+",#"+_cc.iROw+",(#"+P.iPr+"))");
        E(); W("CC_DESIGN_PERSON_AND_ORGANIZATION_ASSIGNMENT(#"+_cc.iPO+",#"+_cc.iRSu+",(#"+P.iPDF+"))");
        E(); W("CC_DESIGN_PERSON_AND_ORGANIZATION_ASSIGNMENT(#"+_cc.iPO+",#"+_cc.iRCl+",(#"+iSec+"))");
        E(); W("CC_DESIGN_SECURITY_CLASSIFICATION(#"+iSec+",(#"+P.iPDF+"))");
        E(); W("CC_DESIGN_DATE_AND_TIME_ASSIGNMENT(#"+_cc.iDT+",#"+_cc.iRCrD+",(#"+P.iPD+"))");
        E(); W("CC_DESIGN_DATE_AND_TIME_ASSIGNMENT(#"+_cc.iDT+",#"+_cc.iRClD+",(#"+iSec+"))");
        E(); W("CC_DESIGN_APPROVAL(#"+_cc.iApp+",(#"+P.iPDF+",#"+P.iPD+",#"+iSec+"))");
      }else{
        E(); W("PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#"+P.iPr+"))");
      }
    };
    // Styles d'un corps : STYLED_ITEM sur le solide, puis un
    // OVER_RIDING_STYLED_ITEM par face dont la teinte s'écarte du corps.
    const _stylePart=(pt)=>{
      if(!_apInfo.hasColors) return;
      const iSI=_styleBody(pt.brep, pt.base.hex, pt.base.a);
      if(!pt.pal) return;
      const over=pt.faces.filter(fc=>{
        const s=pt.pal[fc.m]; return s && (s.hex!==pt.base.hex || Math.abs(s.a-pt.base.a)>1e-3);
      });
      if(over.length>_STEP_MAX_FACE_STYLES){ nStyleDropped+=over.length; return; }
      over.forEach(fc=>{ const s=pt.pal[fc.m]; _styleFace(fc.id, s.hex, s.a, iSI); nFaceStyled++; });
    };

    const rootName='NASSCAD Model';
    let iRootRep;
    if(parts.length===1){
      // Un seul corps : produit unique, pas de NAUO — un assemblage à un
      // composant n'apporte rien et alourdit l'arbre dans le lecteur.
      const P=_emitProduct(parts[0].name||rootName);
      iRootRep=E(); W(_repOf(parts[0])+"('"+_stepStr(parts[0].name||rootName)+"',(#"+iAX0+",#"+parts[0].brep+"),#"+iGC+")");
      E(); W("SHAPE_DEFINITION_REPRESENTATION(#"+P.iPDS+",#"+iRootRep+")");
      _emitProductMeta(P);
      _stylePart(parts[0]);
    }else{
      const Root=_emitProduct(rootName);
      // Un AXIS2_PLACEMENT_3D par composant : la géométrie étant déjà cuite en
      // coordonnées monde, chaque transformation est l'identité, mais un lecteur
      // qui déplace une pièce a besoin d'un placement qui lui appartient.
      const compAx=parts.map(()=>{ const i=E(); W("AXIS2_PLACEMENT_3D('',#"+iCP0+",#"+iDZ0+",#"+iDX0+")"); return i; });
      iRootRep=E(); W("SHAPE_REPRESENTATION('"+_stepStr(rootName)+"',"+R([iAX0].concat(compAx))+",#"+iGC+")");
      E(); W("SHAPE_DEFINITION_REPRESENTATION(#"+Root.iPDS+",#"+iRootRep+")");
      _emitProductMeta(Root);
      parts.forEach((pt,k)=>{
        const P=_emitProduct(pt.name||('Body '+(k+1)));
        const iRep=E(); W(_repOf(pt)+"('"+_stepStr(pt.name||'')+"',(#"+iAX0+",#"+pt.brep+"),#"+iGC+")");
        E(); W("SHAPE_DEFINITION_REPRESENTATION(#"+P.iPDS+",#"+iRep+")");
        _emitProductMeta(P);
        // Occurrence dans l'assemblage : NAUO + la relation de représentation
        // transformée qui la géométrise (schéma OCCT/XCAF à l'identique).
        const iNAUO=E(); W("NEXT_ASSEMBLY_USAGE_OCCURRENCE('"+(k+1)+"','"+_stepStr(pt.name||'')+"','',#"+Root.iPD+",#"+P.iPD+",$)");
        const iPDSp=E(); W("PRODUCT_DEFINITION_SHAPE('Placement','Placement of an item',#"+iNAUO+")");
        const iIDT =E(); W("ITEM_DEFINED_TRANSFORMATION('','',#"+iAX0+",#"+compAx[k]+")");
        const iRR  =E(); W("(REPRESENTATION_RELATIONSHIP('','',#"+iRep+",#"+iRootRep+") REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#"+iIDT+") SHAPE_REPRESENTATION_RELATIONSHIP())");
        E(); W("CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#"+iRR+",#"+iPDSp+")");
        _stylePart(pt);
      });
    }
    // ── Conteneur de styles (ISO 10303-46) ────────────────────────────────
    // MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION regroupe tous les
    // STYLED_ITEM du modèle et les rattache au contexte géométrique. Toutes les
    // représentations partagent ici le même contexte : un seul conteneur suffit.
    if(styledItemIds.length){
      E(); W("MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',"+R(styledItemIds)+",#"+iGC+")");
    }
    if(nStyleDropped)
      nasLog('WARN','STEP export: '+nStyleDropped+' face colors skipped (over '+_STEP_MAX_FACE_STYLES+' per body) — body color kept');
    if(nOpen)
      nasLog('WARN','STEP export: '+nOpen+' body(ies) are not watertight — written as OPEN_SHELL / SHELL_BASED_SURFACE_MODEL (surface model, not a solid)');
    if(_stepStr.truncated)
      nasLog('WARN','STEP export: '+_stepStr.truncated+' name(s) shortened — ISO 10303-21 forbids lines over 256 characters and a string cannot be split');

    // ── Assemblage fichier ─────────────────────────────────────────────────
    const now=new Date().toISOString().slice(0,19);
    const nObj=(objList||objs).length;
    // FILE_SCHEMA : AP203 déclare en plus SHAPE_APPEARANCE_LAYER_MIM dès qu'il y
    // a des styles — c'est ce second schéma qui autorise la chaîne couleur.
    const schemas=[_apInfo.schema];
    if(_apInfo.schemaStyle && styledItemIds.length) schemas.push(_apInfo.schemaStyle);
    const step=[
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('"+_stepStr('NASSCAD V'+NASSCAD_VERSION+' STEP B-Rep '+_apInfo.name)+"'),'2;1');",
      "FILE_NAME('model.stp','"+now+"',('NassLab'),(''),'NASSCAD V"+NASSCAD_VERSION+"','NASSCAD V"+NASSCAD_VERSION+"','');",
      "FILE_SCHEMA(("+schemas.map(s=>"'"+_stepStr(s)+"'").join(',')+"));",
      'ENDSEC;','DATA;',
      '/* NASSCAD V'+NASSCAD_VERSION+' - nasscad.com - '+nObj+' objects - '+parts.length+' parts - '+totalTris+' triangles - '+
        nManifold+' MANIFOLD_SOLID_BREP / '+nFaceted+' FACETED_BREP / '+nSphere+' SPHERICAL_SURFACE'+
        (nOpen?' / '+nOpen+' OPEN_SHELL':'')+
        (styledItemIds.length?' / '+styledItemIds.length+' styled items':'')+' - '+_apInfo.name+' */',
      ...L.map(s=>_stepFold(s,72)),
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
      nasLog('OK','Export STEP '+_apInfo.name+' B-Rep — '+nObj+' obj — '+parts.length+' parts — '+totalTris+' tris — '+
        nManifold+' MANIFOLD / '+nFaceted+' FACETED / '+nSphere+' SPHERICAL'+(nOpen?' / '+nOpen+' OPEN':'')+
        (styledItemIds.length?' / '+styledItemIds.length+' styles'+(nFaceStyled?' ('+nFaceStyled+' per face)':''):'')+
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
