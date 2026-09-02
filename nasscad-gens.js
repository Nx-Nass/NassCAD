// ══════════════════════════════════════════════════════════════════════════
// nasscad-gens.js — TOUS les modules *-gen.js de NASSCAD regroupés en un seul
// fichier (Nass, 30/08 : « les .gen, tout en un »). Ce fichier remplace les
// 11 fichiers d'origine :
//   cubechanfrein-gen.js · arcsphere-gen.js · screw-gen.js · nut-gen.js
//   revsolid-gen.js · cylind-gen.js · tore-gen.js · pipe-gen.js · gear-gen.js
//   circulartext-gen.js · sketch-gen.js
// Regroupement MÉCANIQUE : concaténation seule, aucune ligne de logique
// modifiée. Chaque section garde son nom de fichier d'origine et son banner
// de contrat de dépendances (traçabilité).
//
// Vérifié avant fusion : ZÉRO collision de nom entre les 11 modules (contrôle
// automatisé sur les déclarations top-level). Sketch.Gen est de toute façon
// enfermé dans une IIFE et n'expose que window.openSketcher, window.closeSketcher
// et window.SK — ses ~120 identifiants internes ne peuvent rien écraser.
//
// ORDRE DE CONCATÉNATION = ordre <script src> d'origine dans le htm, préservé
// à l'identique. Trois raisons, toutes vérifiées et non devinées :
//   · cylind-gen.js utilise _slerp3, déclarée dans cubechanfrein-gen.js
//     → CubeChanfrein doit précéder Cylind.
//   · nut-gen.js utilise _SCREW_DB, déclarée dans screw-gen.js
//     → Screw doit précéder Nut.
//   · CircularText.Gen était chargé AVANT les 9 générateurs → il reste en tête.
//
// ⚠ POSITION DE LA BALISE <script src> DANS LE HTM — NE PAS LA REMONTER.
// Sketch.Gen touche le DOM dès son chargement (hors de toute fonction) :
//   const _skRoot = document.getElementById('sk-overlay');
//   const canvas  = document.getElementById('sk-sketch-canvas');
//   const ctx     = canvas.getContext('2d');            // ← null.getContext() si trop tôt
//   ro.observe(wrap);  +  _skRoot.querySelectorAll('.tool-btn[data-tool]')
// Ce fichier doit donc être chargé APRÈS le markup <div id="sk-overlay">, en
// fin de <body> — exactement là où se trouvait sketch-gen.js. Le remonter à
// l'ancienne place de nasscad-gens.js casserait le sketcher au chargement.
// Les 9 générateurs et CircularText.Gen, eux, n'ont aucun accès DOM top-level
// (vérifié) : les déplacer plus bas est sans effet.
//
// _finalizeGenToScene (helper partagé, vit dans le htm) reste le point de
// sortie commun aux générateurs — inchangé par ce regroupement.
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// circulartext-gen.js — module CircularText.Gen extrait du host NASSCAD
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, selObjs, objCnt, COL, PS, isHoleMode          — scene state
//   THREE                                                       — Three.js global
//   undoPush, updProps, updOList, updStats, nasLog, _nasAlert   — app-wide helpers
//   _findFreePos, _csgLog                                       — placement/log helpers
//   _FONTS_DEF, _fontCaches, _initFontSelect                    — font loading (shared w/ other text-capable gens)
//   _genEditBegin, _genEditApply, _genEditCancel, _genEditObj,
//   _genDialogMode, _genLiveUpdate, _previewDispose              — generic "Gen Edit Mode" infra
//                                                                   (lives elsewhere in the host file,
//                                                                   shared by every primitive dialog)
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════ CircularText.Gen — texte 3D courbe (arche/sourire) ══════════════════
// Principe conservé du prototype fourni : slider de courbure, preview live, sens +/- = arche/sourire.
// "Courbure ++" : paramétrage par ANGLE D'ARC (0→340°) au lieu du sagitta à corde fixe du proto
// d'origine (limité géométriquement à un demi-cercle, R min = w/2) — permet d'aller bien plus loin,
// jusqu'à un texte qui s'enroule presque en cercle complet.
//
// Preview : ghost 3D live dans le viewport (_previewShow/_genLiveUpdate), même mécanisme que
// Cubic.Gen/ArcSphere.Gen — plus de preview SVG séparée, ce qu'on voit dans le modal EST ce qui
// sera créé, sous n'importe quel angle de caméra.
//
// Modèle géométrique : arc VERTICAL vu de face, pas un médaillon vu du dessus. Chaque lettre subit
// une simple rotation 2D dans le plan (X,Y) du texte ; l'axe Z (épaisseur d'extrusion) n'est JAMAIS
// transformé → aucune réflexion possible, aucun risque de mirroir (garanti par construction : la
// base [right,up] est toujours une rotation propre, déterminant +1, vérifié par harnais de test).

const _CT_MAXSPAN_DEG = 340; // laisse un petit espace pour ne pas refermer le texte sur lui-même

function _ctCurveParams(val, L){
  const amt = Math.abs(val)/100;
  const spanDeg = amt*_CT_MAXSPAN_DEG;
  const spanRad = spanDeg*Math.PI/180;
  const R = spanRad>1e-6 ? L/spanRad : Infinity;
  const sign = val>=0 ? 1 : -1; // +1 = arche ∩ (texte au sommet, tourné vers l'extérieur)
                                 // -1 = sourire ∪ (texte en creux, tourné vers l'intérieur)
  return {R, spanRad, spanDeg, sign};
}

// Base 2D [right,up] pour un caractère à l'angle theta — rotation propre garantie (det=+1)
// flatX : position X en mode plat (R infini)
function _ctCharBasis(theta, R, sign, flatX){
  if(!isFinite(R)) return {pos:[flatX||0,0], right:[1,0], up:[0,1]}; // plat (courbure ≈ 0)
  if(sign>=0){ // arche ∩ — centre du cercle en dessous, theta=0 = sommet
    return {
      pos:   [R*Math.sin(theta), R*(Math.cos(theta)-1)],
      right: [Math.cos(theta), -Math.sin(theta)],
      up:    [Math.sin(theta),  Math.cos(theta)]
    };
  }
  // sourire ∪ — centre du cercle au dessus, theta=0 = creux du bas
  return {
    pos:   [R*Math.sin(theta), R*(1-Math.cos(theta))],
    right: [Math.cos(theta), Math.sin(theta)],
    up:    [-Math.sin(theta), Math.cos(theta)]
  };
}

function _ctAdvance(font, ch, size){
  const scale = size/font.data.resolution;
  const g = font.data.glyphs[ch] || font.data.glyphs[' '] || font.data.glyphs['?'];
  const ha = g ? g.ha : font.data.resolution*0.5;
  return ha*scale;
}

// Layout complet : position angulaire (ou X si plat) de chaque caractère
function _ctLayout(font, text, size, curveVal){
  const chars = [...text];
  const advances = chars.map(ch=>_ctAdvance(font, ch, size));
  const L = advances.reduce((a,b)=>a+b, 0) || size;
  const {R, spanRad, spanDeg, sign} = _ctCurveParams(curveVal, L);
  const items = [];
  if(!isFinite(R)){
    let running = -L/2;
    chars.forEach((ch,i)=>{
      const adv=advances[i];
      items.push({ch, adv, theta:0, flatX:running+adv/2});
      running += adv;
    });
  } else {
    const angPerMM = spanRad/L;
    let runningTheta = -spanRad/2;
    chars.forEach((ch,i)=>{
      const adv=advances[i];
      const angW = adv*angPerMM;
      items.push({ch, adv, theta:runningTheta+angW/2, flatX:0});
      runningTheta += angW;
    });
  }
  return {items, L, R, spanRad, spanDeg, sign};
}

// Construit la géométrie fusionnée à plat {vPos, tris} — réutilisé par le ghost preview live
// ET par la création finale (source unique de vérité, jamais de désync preview/résultat).
function _ctBuildGeo(font, text, size, depth, curveVal){
  const {items, R, spanDeg, L} = _ctLayout(font, text, size, curveVal);
  const sign = curveVal>=0 ? 1 : -1;
  const pieces = [];
  items.forEach(it=>{
    const shapes = font.generateShapes(it.ch, size);
    if(!shapes || !shapes.length) return; // espace / glyphe vide → avance seulement, pas de géo
    const g = new THREE.ExtrudeGeometry(shapes, {depth:depth, bevelEnabled:false, curveSegments:6});
    g.translate(-it.adv/2, 0, 0); // centre le glyphe sur son propre axe avant placement
    const {pos, right, up} = _ctCharBasis(it.theta, R, sign, it.flatX);
    const m4 = new THREE.Matrix4();
    m4.makeBasis(
      new THREE.Vector3(right[0], right[1], 0),
      new THREE.Vector3(up[0],    up[1],    0),
      new THREE.Vector3(0, 0, 1) // profondeur = toujours l'axe Z local pur → jamais de mirroir
    );
    m4.setPosition(pos[0], pos[1], 0);
    g.applyMatrix4(m4);
    pieces.push(g);
  });
  if(!pieces.length) return {vPos:new Float32Array(0), tris:new Uint32Array(0), R, spanDeg, L};

  let totalV=0, totalI=0;
  pieces.forEach(g=>{
    totalV += g.attributes.position.count;
    totalI += g.index ? g.index.count : g.attributes.position.count;
  });
  const vPos = new Float32Array(totalV*3);
  const tris = new Uint32Array(totalI);
  let vBase=0, iOff=0;
  pieces.forEach(g=>{
    vPos.set(g.attributes.position.array, vBase*3);
    const gi = g.index ? g.index.array : null;
    if(gi){
      for(let k=0;k<gi.length;k++) tris[iOff+k]=gi[k]+vBase;
      iOff += gi.length;
    } else {
      const cnt=g.attributes.position.count;
      for(let k=0;k<cnt;k++) tris[iOff+k]=vBase+k;
      iOff += cnt;
    }
    vBase += g.attributes.position.count;
  });

  // Centrage bbox (X,Y,Z) — cohérent avec create3DText
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for(let i=0;i<vPos.length;i+=3){
    const x=vPos[i],y=vPos[i+1],z=vPos[i+2];
    if(x<minX)minX=x; if(x>maxX)maxX=x;
    if(y<minY)minY=y; if(y>maxY)maxY=y;
    if(z<minZ)minZ=z; if(z>maxZ)maxZ=z;
  }
  const cx=(maxX+minX)/2, cy=(maxY+minY)/2, cz=(maxZ+minZ)/2;
  for(let i=0;i<vPos.length;i+=3){ vPos[i]-=cx; vPos[i+1]-=cy; vPos[i+2]-=cz; }

  return {vPos, tris, R, spanDeg, L};
}

function _ctEnsureFont(fontKey, cb){
  if(_fontCaches[fontKey]){ cb(_fontCaches[fontKey]); return; }
  const fontDef=_FONTS_DEF.find(f=>f.key===fontKey)||_FONTS_DEF[0];
  const _fontData=window[fontDef.data];
  if(!_fontData){
    nasLog('ERROR','Font "'+fontDef.label+'" unavailable — missing file '+fontKey+'.js');
    document.getElementById('ct-stats').textContent = 'font unavailable';
    return;
  }
  const _loader=new THREE.FontLoader();
  _fontCaches[fontKey]=_loader.parse(_fontData);
  nasLog('OK','Font '+fontDef.label+' loaded');
  cb(_fontCaches[fontKey]);
}

function _ctFontChange(){
  const fontKey=document.getElementById('ct-font').value;
  _ctEnsureFont(fontKey, ()=>_ctRebuild());
}

// ── Rebuild live — appelé à chaque frappe/slider, alimente le ghost preview ────────────────
function _ctRebuild(){
  const text = document.getElementById('ct-text').value || 'TEXT';
  const curveVal = +document.getElementById('ct-curve').value;
  document.getElementById('ct-vcurve').value = curveVal;
  const size  = +document.getElementById('ct-size').value;
  const depth = +document.getElementById('ct-depth').value;
  const fontKey = document.getElementById('ct-font').value;
  const font = _fontCaches[fontKey];
  if(!font){ document.getElementById('ct-stats').textContent = 'chargement police…'; return; }

  const {vPos, tris, R, spanDeg, L} = _ctBuildGeo(font, text, size, depth, curveVal);
  if(!vPos.length){
    document.getElementById('ct-stats').textContent = 'empty text';
    _previewDispose();
    return;
  }
  document.getElementById('ct-stats').textContent = isFinite(R)
    ? `L≈${L.toFixed(1)}mm · R≈${R.toFixed(1)}mm · arc ${spanDeg.toFixed(0)}°`
    : `L≈${L.toFixed(1)}mm · flat`;
  // _previewShow/_genLiveUpdate font geo.setIndex(tris) — THREE ne le wrap en BufferAttribute
  // que si Array.isArray(tris)===true ; un Uint32Array (typed array) échoue ce test et produit
  // une géométrie invalide/invisible → conversion explicite en Array ici.
  _genLiveUpdate({vPos, tris:Array.from(tris)});
}

function showCircularTextDialog(obj){
  const editMode = !!obj;
  if(editMode) _genEditBegin(obj);
  else _genEditObj = null;

  const p = editMode && obj.genParams ? obj.genParams
    : {text:'NASSLAB', fontKey:'helvetiker_bold', size:20, depth:4, curve:45};

  document.getElementById('ct-text').value = p.text;
  document.getElementById('ct-curve').value = p.curve;
  document.getElementById('ct-vcurve').value = p.curve;
  document.getElementById('ct-size').value = p.size;
  document.getElementById('ct-vsize').value = p.size;
  document.getElementById('ct-depth').value = p.depth;
  document.getElementById('ct-vdepth').value = p.depth;

  _initFontSelect('ct-font');
  const fontSel=document.getElementById('ct-font');
  if(fontSel && p.fontKey && [...fontSel.options].some(o=>o.value===p.fontKey)) fontSel.value=p.fontKey;

  _genDialogMode('ctext-modal', editMode, '◠ CircularText.Gen — Curved 3D Text', 'ctext-apply-btn');
  _ctEnsureFont(fontSel.value, ()=>_ctRebuild());

  const _el = document.getElementById('ctext-modal');
  _el.style.left = Math.max(196, innerWidth  - 355 - 332) + 'px';
  _el.style.top  = Math.max(34,  innerHeight - 480 - 32)  + 'px';
  _el.classList.add('open');
  document.getElementById('ct-text').focus();
  document.getElementById('ct-text').select();
}

function hideCircularTextDialog(cancel){
  _previewDispose();
  if(cancel) _genEditCancel(); else _genEditApply();
  document.getElementById('ctext-modal').classList.remove('open');
}

function _ctToScene(){
  const text  = (document.getElementById('ct-text').value||'TEXT').substring(0,48);
  const curveVal = +document.getElementById('ct-curve').value;
  const size  = Math.max(1, +document.getElementById('ct-size').value||20);
  const depth = Math.max(0.1, +document.getElementById('ct-depth').value||4);
  const fontKey = document.getElementById('ct-font').value;

  // ── MODE ÉDITION : géo déjà live-updatée sur l'objet réel par _genLiveUpdate → finaliser ──
  if(_genEditObj){
    _genEditObj.genParams = {text, fontKey, size, depth, curve:curveVal};
    nasLog('OK','CircularText.Gen edited: '+_genEditObj.name);
    _csgLog && _csgLog('✏ CircularText.Gen edited → '+_genEditObj.name);
    hideCircularTextDialog(false);
    return;
  }

  // ── MODE CRÉATION ──
  const font = _fontCaches[fontKey];
  if(!font){ nasLog('ERROR','CircularText.Gen : font not loaded'); return; }
  try {
    const {vPos, tris} = _ctBuildGeo(font, text, size, depth, curveVal);
    if(!vPos.length){ nasLog('ERROR','CircularText.Gen : empty text'); return; }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vPos,3));
    geo.setIndex(new THREE.BufferAttribute(tris,1));
    geo.computeVertexNormals();
    geo.computeBoundingBox();

    undoPush('CircularText.Gen');
    objCnt++;
    const isHole = isHoleMode;
    const col = isHole ? '#ff3333' : COL[objCnt%COL.length];
    const colNum = isHole ? 0xff3333 : parseInt(col.replace('#',''),16);
    const mat = new THREE.MeshPhongMaterial({color:colNum, shininess:8, specular:0x1a1a1a, side:THREE.DoubleSide, transparent:isHole, opacity:isHole?0.45:1});
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow=true; mesh.receiveShadow=false;
    scene.add(mesh);
    mesh.updateMatrixWorld(true);

    const freePos = _findFreePos(mesh, PS+2);
    const _bb = new THREE.Box3().setFromObject(mesh);
    mesh.position.set(freePos.x, -_bb.min.y, freePos.z);

    const name = `circtext_${text.replace(/[^A-Za-z0-9]/g,'').substring(0,12)||'txt'}_${objCnt}`;
    const obj = {id:objCnt, name, type:'csg', mesh, color:col, isHole,
      genType:'circtext', genParams:{text, fontKey, size, depth, curve:curveVal}};
    objs.push(obj); selObjs=[obj];
    updProps(); updOList(); updStats();
    _csgLog && _csgLog('✓ CircularText.Gen → '+name);
    nasLog('OK','CircularText.Gen added to scene: '+name);
    hideCircularTextDialog(false);
  } catch(err){
    nasLog('ERROR','CircularText.Gen : '+err.message);
    _nasAlert && _nasAlert('⚠ CircularText.Gen : '+err.message);
  }
}
// ══════════════════ /CircularText.Gen ══════════════════

// ══════════════════════════════════════════════════════════════════════════
// cubechanfrein-gen.js — module CubeChanfrein.Gen ("Cubic.Gen") extrait du host NASSCAD
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, selObjs, objCnt, COL, PS, isHoleMode           — scene state
//   THREE                                                        — Three.js global
//   undoPush, updProps, updOList, updStats, nasLog, _nasAlert    — app-wide helpers
//   _findFreePos, _csgLog                                        — placement/log helpers
//   showSpinner, hideSpinner                                     — loading UI
//   _genEditBegin, _genEditApply, _genEditCancel, _genEditObj,
//   _genDialogMode, _genLiveUpdate, _previewDispose                — generic "Gen Edit Mode" infra
//                                                                    (lives elsewhere in the host file,
//                                                                    shared by every primitive dialog)
//
//   ⚠ PARTICULARITÉ : _ccSegs, _ccMode_val (let, déclarées ligne ~15458 du
//     host original, PAS dans ce module) — contrairement aux autres générateurs,
//     l'état propre de Cubic.Gen a été historiquement déclaré en dehors de son
//     propre bloc de code (avant l'adoption de la convention bannière ══).
//     Ce module n'a pas de bannière d'ouverture ══ dans l'original — il
//     commence directement par showCubeChanfreinDialog().
// ══════════════════════════════════════════════════════════════════════════
function showCubeChanfreinDialog(obj){
  const editMode = !!obj;
  if(editMode) _genEditBegin(obj);
  else _genEditObj = null;

  const p = editMode && obj.genParams ? obj.genParams : {W:60,H:60,D:60,c:8,segs:6,mode:'bevel'};
  document.getElementById('cc-sw').value = p.W;
  document.getElementById('cc-sh').value = p.H;
  document.getElementById('cc-sd').value = p.D;
  document.getElementById('cc-sc').value = p.c;
  document.getElementById('cc-vw').value = p.W;
  document.getElementById('cc-vh').value = p.H;
  document.getElementById('cc-vd').value = p.D;
  document.getElementById('cc-vc').value = (+p.c).toFixed(1);
  _ccSegs = p.segs || 6;
  _ccMode_val = p.mode || 'bevel';
  document.getElementById('cc-mbevel').classList.toggle('active', _ccMode_val==='bevel');
  document.getElementById('cc-mround').classList.toggle('active', _ccMode_val==='round');
  document.getElementById('cc-vs').textContent = _ccSegs;
  document.querySelectorAll('#cc-segbtns .vb-btn').forEach(b=>b.classList.toggle('active', +b.textContent===_ccSegs));
  _genDialogMode('cubechan-modal', editMode, '✦ Chamfered / Rounded Cube', 'cubechan-apply-btn');
  _ccRebuild();
  const _cel = document.getElementById('cubechan-modal');
  _cel.style.left = Math.max(196, innerWidth - 335 - 332) + 'px';
  _cel.style.top  = Math.max(34,  innerHeight - 470 - 32) + 'px';
  _cel.classList.add('open');
}

function hideCubeChanfreinDialog(cancel){
  _previewDispose();
  if(cancel) _genEditCancel(); else _genEditApply();
  document.getElementById('cubechan-modal').classList.remove('open');
}

function _ccMode(m){
  _ccMode_val = m;
  document.getElementById('cc-mbevel').classList.toggle('active', m==='bevel');
  document.getElementById('cc-mround').classList.toggle('active', m==='round');
  _ccRebuild();
}

function _ccSeg(v){
  _ccSegs = v;
  document.getElementById('cc-vs').textContent = v;
  document.querySelectorAll('#cc-segbtns .vb-btn').forEach(b=>b.classList.remove('active'));
  [...document.querySelectorAll('#cc-segbtns .vb-btn')].find(b=>+b.textContent===v)?.classList.add('active');
  _ccRebuild();
}

function _ccRebuild(){
  const W=+document.getElementById('cc-sw').value;
  const H=+document.getElementById('cc-sh').value;
  const D=+document.getElementById('cc-sd').value;
  let c=+document.getElementById('cc-sc').value;
  // clamp chanfrein
  const maxC=Math.min(W,H,D)*0.4999;
  if(c>maxC){ c=maxC; document.getElementById('cc-sc').value=c.toFixed(1); document.getElementById('cc-vc').value=c.toFixed(1); }
  const mesh=_ccBuildBox(W,H,D,c,_ccSegs,_ccMode_val);
  const triCount=mesh.tris.length/3;
  const vtxCount=mesh.vPos.length/3;
  const vol=(W*H*D/1000).toFixed(1);
  document.getElementById('cc-stats').textContent=
    `▲ ${triCount.toLocaleString('fr-FR')} triangles · ◎ ${vtxCount.toLocaleString('fr-FR')} sommets · Vol ≈ ${vol} cm³`;
  _genLiveUpdate(mesh);
}

function _cubeChanfreinToScene(){
  const W=+document.getElementById('cc-sw').value;
  const H=+document.getElementById('cc-sh').value;
  const D=+document.getElementById('cc-sd').value;
  let c=+document.getElementById('cc-sc').value;
  const maxC=Math.min(W,H,D)*0.4999;
  if(c>maxC) c=maxC;

  if(!_numsOK(W,H,D,c) || W<=0 || H<=0 || D<=0){
    nasLog('ERROR','Cubic.Gen : valeurs invalides (W='+W+', H='+H+', D='+D+')');
    _nasAlert('⚠ Cubic.Gen : vérifie les champs numériques (valeur vide, non numérique ou hors plage).');
    return;
  }

  // ── MODE ÉDITION : géo déjà live-updatée par _genLiveUpdate → finaliser seulement ──
  if(_genEditObj){
    _genEditObj.genParams = {W,H,D,c,segs:_ccSegs,mode:_ccMode_val};
    nasLog('OK','Cubic.Gen edited: '+_genEditObj.name);
    _csgLog && _csgLog('✏ Cubic.Gen edited → '+_genEditObj.name);
    hideCubeChanfreinDialog(false);
    return;
  }

  // ── MODE CRÉATION ──
  showSpinner('Cubic.Gen', `${W}×${H}×${D} c=${c.toFixed(1)}`);
  try {
    const {vPos, tris} = _ccBuildBox(W, H, D, c, _ccSegs, _ccMode_val);

    // Géométrie INDEXÉE — préserve le partage exact des sommets → watertight manifold
    // _ccBuildBox retourne vPos dédupliqué + tris indexé (même garantie que Cubic.Gen)
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(vPos), 3));
    geo.setIndex(tris);
    geo.computeVertexNormals();
    geo.computeBoundingBox();

    // [REFACTOR V4.7.1] cf. tore-gen.js — bloc mutualisé dans _finalizeGenToScene (htm).
    const modeName = _ccMode_val==='bevel' ? 'bvl' : 'rnd';
    _finalizeGenToScene({
      label: 'Cubic.Gen', geo,
      name: (n) => `cubechan_${modeName}_${W}x${H}x${D}_c${c.toFixed(0)}_${n}`,
      genType: 'cubic', genParams: {W,H,D,c,segs:_ccSegs,mode:_ccMode_val},
      hideDialogFn: () => hideCubeChanfreinDialog(false)
    });
  } catch(err) {
    hideSpinner();
    nasLog('ERROR', 'Cubic.Gen : ' + err.message);
    _nasAlert('⚠ Cubic.Gen : ' + err.message);
  }
}

// [FIX B6] _slerp3 — interpolation sphérique sur vecteur 3D unitaire, factorisé
// depuis les implémentations locales de _ccBuildBox et _ccBuildFrustum (anciennement dupliqué)
function _slerp3(a, b, t){
  if(t<=0)return[a[0],a[1],a[2]];if(t>=1)return[b[0],b[1],b[2]];
  let d=a[0]*b[0]+a[1]*b[1]+a[2]*b[2];d=Math.max(-1,Math.min(1,d));
  const om=Math.acos(d);if(om<1e-9)return[a[0],a[1],a[2]];
  const s=1/Math.sin(om);const f0=Math.sin((1-t)*om)*s,f1=Math.sin(t*om)*s;
  return[f0*a[0]+f1*b[0],f0*a[1]+f1*b[1],f0*a[2]+f1*b[2]];
}

// ── Algorithme buildBox (Cubic.Gen) — verified-manifold ──────────────────
function _ccBuildBox(W, H, D, chamfer, segments, mode) {
  const hw=W/2, hh=H/2, hd=D/2;
  const maxC=Math.min(hw,hh,hd)*0.9999;
  const c=Math.max(0.0,Math.min(chamfer,maxC));
  const S=Math.max(1,Math.round(segments));

  const PREC=1e5;
  const pool=new Map();
  const vPos=[];

  function V(x,y,z){
    const ix=Math.round(x*PREC),iy=Math.round(y*PREC),iz=Math.round(z*PREC);
    const k=`${ix}|${iy}|${iz}`;
    let i=pool.get(k);
    if(i===undefined){i=vPos.length/3;vPos.push(ix/PREC,iy/PREC,iz/PREC);pool.set(k,i);}
    return i;
  }
  const tris=[];
  function emitQ(a,b,c2,d){tris.push(a,b,c2,a,c2,d);}
  function emitT(a,b,c2){tris.push(a,b,c2);}

  function sphericalTriPt(nA,nB,nC,u,v){
    const uv=u+v;if(uv<1e-9)return[nA[0],nA[1],nA[2]];
    const pBC=_slerp3(nB,nC,v/uv);return _slerp3(nA,pBC,uv);
  }
  function cross(a,b){return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
  function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}

  const h=[hw,hh,hd];
  const cyclicPairs=[[1,2],[2,0],[0,1]];

  // 6 faces plates
  for(const ax of[0,1,2]){
    const[a1,a2]=cyclicPairs[ax];const h1=h[a1]-c,h2=h[a2]-c;
    for(const sg of[+1,-1]){
      const p=(s1,s2)=>{const v=[0,0,0];v[ax]=sg*h[ax];
        if(sg>0){v[a1]=s1*h1;v[a2]=s2*h2;}
        else    {v[a1]=s2*h1;v[a2]=s1*h2;}
        return V(v[0],v[1],v[2]);};
      emitQ(p(-1,-1),p(+1,-1),p(+1,+1),p(-1,+1));
    }
  }
  if(c<1e-9)return{vPos:new Float32Array(vPos),tris};

  function edgePt(fA,sA,fB,sB,eAx,t,eVal){
    const nA=[0,0,0];nA[fA]=sA;const nB=[0,0,0];nB[fB]=sB;
    const n=(mode==='round')?_slerp3(nA,nB,t):(t<0.5?nA:nB);
    const pt=[0,0,0];pt[fA]=sA*(h[fA]-c);pt[fB]=sB*(h[fB]-c);pt[eAx]=eVal;
    return[pt[0]+c*n[0],pt[1]+c*n[1],pt[2]+c*n[2]];
  }
  function buildEdge(fA,sA,fB,sB){
    const eAx=[0,1,2].find(a=>a!==fA&&a!==fB);const eH=h[eAx]-c;
    const steps=(mode==='round')?S:1;
    const nA=[0,0,0];nA[fA]=sA;const nB=[0,0,0];nB[fB]=sB;
    const dU=[nB[0]-nA[0],nB[1]-nA[1],nB[2]-nA[2]];
    const dV=[0,0,0];dV[eAx]=1;
    const sign=dot(cross(dU,dV),[nA[0]+nB[0],nA[1]+nB[1],nA[2]+nB[2]]);
    for(let i=0;i<steps;i++){
      const t0=i/steps,t1=(i+1)/steps;
      const A0=V(...edgePt(fA,sA,fB,sB,eAx,t0,-eH));
      const A1=V(...edgePt(fA,sA,fB,sB,eAx,t0,+eH));
      const B0=V(...edgePt(fA,sA,fB,sB,eAx,t1,-eH));
      const B1=V(...edgePt(fA,sA,fB,sB,eAx,t1,+eH));
      if(sign>=0)emitQ(A0,B0,B1,A1);else emitQ(A0,A1,B1,B0);
    }
  }
  for(const sA of[-1,+1])for(const sB of[-1,+1]){buildEdge(0,sA,1,sB);buildEdge(0,sA,2,sB);buildEdge(1,sA,2,sB);}

  function buildCorner(sx,sy,sz){
    const Seff=(mode==='bevel')?1:S;
    const base=[sx*(hw-c),sy*(hh-c),sz*(hd-c)];
    const nX=[sx,0,0],nY=[0,sy,0],nZ=[0,0,sz];
    const grid=[];
    for(let i=0;i<=Seff;i++){grid[i]=[];for(let j=0;j<=Seff-i;j++){
      const n=(mode==='round')?sphericalTriPt(nZ,nX,nY,i/Seff,j/Seff):(i===Seff?nX:(j===Seff?nY:nZ));
      grid[i][j]=V(base[0]+c*n[0],base[1]+c*n[1],base[2]+c*n[2]);
    }}
    const parity=sx*sy*sz;
    for(let i=0;i<Seff;i++)for(let j=0;j<Seff-i;j++){
      const A=grid[i][j],B=grid[i+1][j],C=grid[i][j+1];
      if(parity>0)emitT(A,B,C);else emitT(A,C,B);
      if(i+j<Seff-1){const Bp=grid[i+1][j+1];if(parity>0)emitT(B,Bp,C);else emitT(B,C,Bp);}
    }
  }
  for(const sx of[-1,+1])for(const sy of[-1,+1])for(const sz of[-1,+1])buildCorner(sx,sy,sz);
  return{vPos:new Float32Array(vPos),tris};
}

// (backdrop-click supprimé — dialog devient fenêtre flottante draggable)

// ══════════════════════════════════════════════════════════════════════════
// arcsphere-gen.js — module ArcSphere.Gen extrait du host NASSCAD
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, selObjs, objCnt, COL, PS, isHoleMode           — scene state
//   THREE                                                        — Three.js global
//   undoPush, updProps, updOList, updStats, nasLog, _nasAlert    — app-wide helpers
//   _findFreePos, _csgLog                                        — placement/log helpers
//   showSpinner, hideSpinner                                     — loading UI
//   _genEditBegin, _genEditApply, _genEditCancel, _genEditObj,
//   _genDialogMode, _genLiveUpdateNorm, _previewDispose            — generic "Gen Edit Mode" infra
//                                                                    (lives elsewhere in the host file,
//                                                                    shared by every primitive dialog)
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// ◑ ArcSphere.Gen — Secteur sphérique watertight
// Arc longitudinal (phi) configurable 1–360°
// Bouchons demi-disques depuis le centre — manifold garanti
// Normales vérifiées algébriquement (convention Three.js SphereGeometry)
// ══════════════════════════════════════════════════════════════════

// BUG-C FIX V4.2.5 : sentinelle pour exclure c2 du mergeVertices positionnel
// (c1 et c2 sont à (0,0,0) mais ont des normales différentes — voir commentaire inline)
let _arcSphNoMerge = -1;

// ── Constructeur géométrie ─────────────────────────────────────
// R      : rayon (mm)
// Wphi   : segments en longitude (phi)
// Htheta : segments en latitude  (theta)
// arcDeg : angle d'arc 1–360° en longitude
// Centre sphère à Y=0 → translater +R pour poser sur grille
function _makeArcSphereGeo(R, Wphi, Htheta, arcDeg) {
  // ── Générateur watertight manifold ──
  // Coque : SphereGeometry (rapide) + bouchons par push
  // mergeVertices intégré : fusionne les doublons coque/bouchons/pôles → manifold garanti
  const arcDegC = Math.min(360, Math.max(1, arcDeg));
  const full    = arcDegC >= 359.99;
  const arcRad  = arcDegC * Math.PI / 180;

  // A. Coque sphérique — extraction des arrays natifs
  const sGeo    = new THREE.SphereGeometry(R, Wphi, Htheta, 0, arcRad);
  const vPos    = Array.from(sGeo.attributes.position.array);
  const normals = Array.from(sGeo.attributes.normal.array);
  const tris    = Array.from(sGeo.index.array);
  sGeo.dispose();

  if (!full) {
    // B. Bouchon début (phi = 0) — normale analytique (0, 0, −1)
    const c1 = vPos.length / 3;
    vPos.push(0, 0, 0);  normals.push(0, 0, -1);
    const e1 = vPos.length / 3;
    for (let i = 0; i <= Htheta; i++) {
      const t = (i / Htheta) * Math.PI;
      vPos.push(-R * Math.sin(t),  R * Math.cos(t), 0);
      normals.push(0, 0, -1);
    }
    for (let i = 0; i < Htheta; i++) {
      tris.push(c1, e1 + i + 1, e1 + i);
    }

    // C. Bouchon fin (phi = arcRad) — normale analytique (sin(arc), 0, cos(arc))
    const c2 = vPos.length / 3;
    vPos.push(0, 0, 0);
    const nx = Math.sin(arcRad), nz = Math.cos(arcRad);
    normals.push(nx, 0, nz);
    const e2 = vPos.length / 3;
    for (let i = 0; i <= Htheta; i++) {
      const t = (i / Htheta) * Math.PI;
      const sinT = Math.sin(t);
      vPos.push(
        -R * Math.cos(arcRad) * sinT,
         R * Math.cos(t),
         R * Math.sin(arcRad) * sinT
      );
      normals.push(nx, 0, nz);
    }
    for (let i = 0; i < Htheta; i++) {
      tris.push(c2, e2 + i, e2 + i + 1);
    }

    // BUG-C FIX V4.2.5 : c1 et c2 sont tous deux à (0,0,0) mais avec des normales
    // différentes. Sans protection, mergeVertices (positional-only) les fusionne et
    // c2 hérite de la normale de c1 → artefact de shading au centre du bouchon fin.
    // Solution : exclure c2 du merge (force un slot propre quel que soit le vmap).
    _arcSphNoMerge = c2;
  }

  // ── mergeVertices intégré ────────────────────────────────────────
  // Fusion des doublons positionnels : pôles SphereGeometry (UV-split)
  // + jonctions coque/bouchons → arêtes partagées → manifold ✓
  // Tolérance 0.001 mm (largement > floating-point noise pour R ≥ 2 mm)
  // _arcSphNoMerge : index de c2 à exclure du merge (BUG-C FIX — normale différente)
  // try/finally : garantit le reset même si une exception est levée dans le merge
  const PREC   = 1000;
  const vmap   = new Map();
  const mPos   = [], mNorm = [];
  const remap  = new Int32Array(vPos.length / 3);

  try {
    for (let i = 0; i < vPos.length / 3; i++) {
      const key = Math.round(vPos[i*3]   * PREC) + ',' +
                  Math.round(vPos[i*3+1] * PREC) + ',' +
                  Math.round(vPos[i*3+2] * PREC);
      // c2 (centre bouchon fin) : même position que c1 mais normale différente
      // → forcer un slot distinct en rendant la clé unique pour cet index
      const lookupKey = (i === _arcSphNoMerge) ? key + '_c2' : key;
      if (vmap.has(lookupKey)) {
        remap[i] = vmap.get(lookupKey);
      } else {
        const idx = mPos.length / 3;
        mPos.push( vPos[i*3],     vPos[i*3+1],     vPos[i*3+2]   );
        mNorm.push(normals[i*3], normals[i*3+1], normals[i*3+2]);
        vmap.set(lookupKey, idx);
        remap[i] = idx;
      }
    }
  } finally {
    _arcSphNoMerge = -1; // reset garanti (BUG-C fix — even on exception)
  }

  // Remap indices + éliminer triangles dégénérés (issus des pôles dupliqués)
  const mTris = [];
  for (let i = 0; i < tris.length; i += 3) {
    const a = remap[tris[i]], b = remap[tris[i+1]], c = remap[tris[i+2]];
    if (a !== b && b !== c && a !== c) mTris.push(a, b, c);
  }

  return { vPos: mPos, normals: mNorm, tris: mTris };
}

// ── Live rebuild (utilise les normales analytiques) ───────────────
function _arcSphRebuild() {
  const R      = +document.getElementById('as-sr').value;
  const arc    = +document.getElementById('as-sarc').value;
  const Wphi   = +document.getElementById('as-swphi').value;
  const Htheta = +document.getElementById('as-shtheta').value;
  const geo    = _makeArcSphereGeo(R, Wphi, Htheta, arc);
  const triCount = geo.tris.length / 3;
  const vtxCount = geo.vPos.length / 3;
  const vol = (4/3 * Math.PI * R * R * R * arc / 360) / 1000;
  document.getElementById('as-stats').textContent =
    `▲ ${triCount.toLocaleString('fr-FR')} triangles · ◎ ${vtxCount.toLocaleString('fr-FR')} sommets · Vol ≈ ${vol.toFixed(1)} cm³`;
  // Décalage Y pour poser sur grille (preview)
  const n = geo.vPos.length;
  const vS = new Float32Array(n), nS = new Float32Array(geo.normals.length);
  for (let i = 0; i < n; i++) vS[i] = (i % 3 === 1) ? geo.vPos[i] + R : geo.vPos[i];
  for (let i = 0; i < geo.normals.length; i++) nS[i] = geo.normals[i];
  _genLiveUpdateNorm({ vPos: vS, normals: nS, tris: geo.tris });
}

// ── Preset arc ───────────────────────────────────────────────────
function _arcSphArcPreset(v) {
  const sl  = document.getElementById('as-sarc');
  const lbl = document.getElementById('as-varc');
  if (sl)  sl.value = v;
  if (lbl) lbl.textContent = v + '°';
  _arcSphRebuild();
}

// ── Ouverture / fermeture dialog ─────────────────────────────────
function showArcSphereDialog(obj) {
  const editMode = !!obj;
  if (editMode) _genEditBegin(obj);
  else _genEditObj = null;

  const p = editMode && obj.genParams ? obj.genParams
    : { R: 20, Wphi: 64, Htheta: 32, arc: 270 };

  document.getElementById('as-sr').value      = p.R;
  document.getElementById('as-vr').value = p.R;
  document.getElementById('as-sarc').value    = p.arc;
  document.getElementById('as-varc').value = p.arc;
  document.getElementById('as-swphi').value   = p.Wphi;
  document.getElementById('as-vwphi').value = p.Wphi;
  document.getElementById('as-shtheta').value = p.Htheta;
  document.getElementById('as-vhtheta').value = p.Htheta;

  _genDialogMode('arcsphere-modal', editMode, '◑ Arc-Sphere · Spherical Sector', 'arcsphere-apply-btn');
  _arcSphRebuild();

  const _el = document.getElementById('arcsphere-modal');
  _el.style.left = Math.max(196, innerWidth  - 345 - 332) + 'px';
  _el.style.top  = Math.max(34,  innerHeight - 440 - 32)  + 'px';
  _el.classList.add('open');
}

function hideArcSphereDialog(cancel) {
  _previewDispose();
  if (cancel) _genEditCancel(); else _genEditApply();
  document.getElementById('arcsphere-modal').classList.remove('open');
}

// ── Validation et ajout en scène ─────────────────────────────────
function _arcSphereToScene() {
  const R      = +document.getElementById('as-sr').value;
  const arc    = +document.getElementById('as-sarc').value;
  const Wphi   = +document.getElementById('as-swphi').value;
  const Htheta = +document.getElementById('as-shtheta').value;

  if(!_numsOK(R,arc,Wphi,Htheta) || R<=0){
    nasLog('ERROR','ArcSphere.Gen : valeurs invalides (R='+R+', arc='+arc+')');
    _nasAlert('⚠ ArcSphere.Gen : vérifie les champs numériques (valeur vide, non numérique ou hors plage).');
    return;
  }

  // MODE ÉDITION
  if (_genEditObj) {
    _genEditObj.genParams = { R, Wphi, Htheta, arc };
    nasLog('OK', 'ArcSphere.Gen edited: ' + _genEditObj.name);
    _csgLog && _csgLog('✏ ArcSphere.Gen edited → ' + _genEditObj.name);
    hideArcSphereDialog(false);
    return;
  }

  // MODE CRÉATION
  showSpinner('ArcSphere.Gen', `R${R}·arc${arc}°·${Wphi}×${Htheta}`);
  try {
    const _asgr = _makeArcSphereGeo(R, Wphi, Htheta, arc);

    // Translater pour poser la base sur Y=0 (centre → +R)
    const _asn  = _asgr.vPos.length;
    const _asVS = new Float32Array(_asn);
    for (let _i = 0; _i < _asn; _i++)
      _asVS[_i] = (_i % 3 === 1) ? _asgr.vPos[_i] + R : _asgr.vPos[_i];

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(_asVS, 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(new Float32Array(_asgr.normals), 3));
    geo.setIndex(_asgr.tris);
    // Normales analytiques déjà présentes — pas de computeVertexNormals()
    geo.computeBoundingBox();

    // [REFACTOR V4.7.1] cf. tore-gen.js — bloc mutualisé dans _finalizeGenToScene (htm).
    _finalizeGenToScene({
      label: 'ArcSphere.Gen', geo,
      name: (n) => `arcsph_R${R}_arc${arc}_${n}`,
      genType: 'arcsphere', genParams: { R, Wphi, Htheta, arc },
      hideDialogFn: () => hideArcSphereDialog(false)
    });
  } catch (err) {
    hideSpinner();
    nasLog('ERROR', 'ArcSphere.Gen : ' + err.message);
    _nasAlert('⚠ ArcSphere.Gen : ' + err.message);
  }
}
// ══ Fin ArcSphere.Gen ══════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// screw-gen.js — module Screw.Gen extrait du host NASSCAD
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, selObjs, objCnt, COL, PS, isHoleMode           — scene state
//   THREE                                                        — Three.js global
//   undoPush, updProps, updOList, updStats, nasLog, _nasAlert    — app-wide helpers
//   _findFreePos, _csgLog                                        — placement/log helpers
//   showSpinner, hideSpinner                                     — loading UI
//   _genEditBegin, _genEditApply, _genEditCancel, _genEditObj,
//   _genDialogMode, _genLiveUpdate, _previewDispose                — generic "Gen Edit Mode" infra
//                                                                    (lives elsewhere in the host file,
//                                                                    shared by every primitive dialog)
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// 🔩 Screw.Gen — Parametric fastener ISO 68-1 / ASME B1.1/B1.2
// Profil V ISO 60° · Tête hex / CHC / aucune · Hélicoïde réel
// Lead-in / lead-out · Watertight manifold
// ══════════════════════════════════════════════════════════════════

const _SCREW_DB = {
  metric: [
    { name:'M2',   dia: 2.0,  coarse:0.40, fine:0.25 },
    { name:'M2.5', dia: 2.5,  coarse:0.45, fine:0.35 },
    { name:'M3',   dia: 3.0,  coarse:0.50, fine:0.35 },
    { name:'M4',   dia: 4.0,  coarse:0.70, fine:0.50 },
    { name:'M5',   dia: 5.0,  coarse:0.80, fine:0.50 },
    { name:'M6',   dia: 6.0,  coarse:1.00, fine:0.75 },
    { name:'M8',   dia: 8.0,  coarse:1.25, fine:1.00 },
    { name:'M10',  dia:10.0,  coarse:1.50, fine:1.25 },
    { name:'M12',  dia:12.0,  coarse:1.75, fine:1.50 },
    { name:'M14',  dia:14.0,  coarse:2.00, fine:1.50 },
    { name:'M16',  dia:16.0,  coarse:2.00, fine:1.50 },
    { name:'M20',  dia:20.0,  coarse:2.50, fine:1.50 },
    { name:'M24',  dia:24.0,  coarse:3.00, fine:2.00 },
  ],
  imperial: [
    { name:'#4  — 0.112"',  dia: 2.845, coarse:40,  fine:48  },
    { name:'#6  — 0.138"',  dia: 3.505, coarse:32,  fine:40  },
    { name:'#8  — 0.164"',  dia: 4.166, coarse:32,  fine:36  },
    { name:'#10 — 0.190"',  dia: 4.826, coarse:24,  fine:32  },
    { name:'1/4"',          dia: 6.350, coarse:20,  fine:28  },
    { name:'5/16"',         dia: 7.938, coarse:18,  fine:24  },
    { name:'3/8"',          dia: 9.525, coarse:16,  fine:24  },
    { name:'7/16"',         dia:11.113, coarse:14,  fine:20  },
    { name:'1/2"',          dia:12.700, coarse:13,  fine:20  },
    { name:'5/8"',          dia:15.875, coarse:11,  fine:18  },
    { name:'3/4"',          dia:19.050, coarse:10,  fine:16  },
    { name:'7/8"',          dia:22.225, coarse: 9,  fine:14  },
    { name:'1"',            dia:25.400, coarse: 8,  fine:12  },
  ],
};

// ── Constructeur géométrie pure (sans Three.js) ────────────────────
// params: { system, specIdx, thread, pitchCustom, length, head, nRad }
// Retourne { vPos: Float32Array, tris: Uint32Array }
// Géométrie posée sur Y=0 (base vis). Tête vers Y = length + headH.
function _makeScrew(params) {
  const sys      = params.system   || 'metric';
  const spIdx    = params.specIdx  !== undefined ? params.specIdx : 5; // M6 défaut
  const db       = _SCREW_DB[sys]  || _SCREW_DB.metric;
  const spec     = db[Math.min(Math.max(0, spIdx), db.length - 1)];
  const D        = spec.dia;
  const rCrest   = D / 2;
  const thread   = params.thread   || 'coarse';
  const length   = Math.max(1, params.length || 20);
  const headType = params.head     || 'hex';
  const N_RAD    = params.nRad     || 48;

  // ── Pas du filet ────────────────────────────────────────────────
  let pitch = 0, rRoot = rCrest;
  if (thread !== 'none') {
    if      (thread === 'custom') pitch = Math.max(0.05, params.pitchCustom || 1.0);
    else if (thread === 'fine')   pitch = sys === 'metric' ? spec.fine   : 25.4 / spec.fine;
    else                          pitch = sys === 'metric' ? spec.coarse : 25.4 / spec.coarse;
    const Hv = (Math.sqrt(3) / 2) * pitch;
    rRoot    = rCrest - (5 / 8) * Hv;   // rayon mineur externe ISO 60°
  }

  // ── Profil V ISO 60° ────────────────────────────────────────────
  // φ ∈ [0,1/16[ ∪ [15/16,1[ → crête (rCrest)
  // φ ∈ [1/16,  6/16[         → flanc descendant
  // φ ∈ [6/16, 10/16]         → gorge (rRoot)
  // φ ∈ ]10/16,15/16[         → flanc remontant
  function profileR(phi) {
    const p  = ((phi % 1) + 1) % 1;
    const HR = rCrest - rRoot;
    if (p < 1/16 || p >= 15/16) return rCrest;
    if (p < 6/16)   return rCrest - HR * (p - 1/16)  / (5/16);
    if (p <= 10/16) return rRoot;
    return rRoot + HR * (p - 10/16) / (5/16);
  }

  // ── Résolution axiale ───────────────────────────────────────────
  const N_PER_TURN = 32;      // anneaux par tour de filet
  const N_AX_MAX   = 3200;    // cap perf
  const nTurns     = pitch > 0 ? length / pitch : 1;
  const N_AX       = pitch > 0
    ? Math.max(N_PER_TURN, Math.min(N_AX_MAX, Math.ceil(nTurns * N_PER_TURN)))
    : 48;

  // ── Tête : géométrie ISO ─────────────────────────────────────────
  // Largeur sur plats ≈ 1.70·D (DIN 931/933) ; inradius = flat/2
  const headH   = D * 0.64;
  const headInr = D * 1.70 / 2;

  function headR(theta) {
    if (headType === 'hex') {
      const localA = theta % (Math.PI / 3) - Math.PI / 6;
      return headInr / Math.cos(localA);
    }
    return headInr; // chc = cylindre
  }

  const verts = [];
  const idxs  = [];
  const Y0    = 0;      // base sur la grille NASSCAD
  const Y1    = length;

  // ══ 1. TIGE ══════════════════════════════════════════════════════
  // Lead-in/lead-out : fade linéaire sur 1 pas → anneaux lisses aux extrémités
  // (INCHANGé, s'applique toujours aux deux bouts, chanfrein ou pas).
  // [FIX V4.5.3] Chanfrein d'about ISO 4753 (Y0, pointe libre) : s'applique
  // EN PLUS du fade (pas à sa place) — fade normal d'abord, clip conique
  // par-dessus ensuite. Ma 1re version (V4.5.2) remplaçait le fade par un
  // cône calé sur le 45° strict (Lcham=rCrest-rRoot, <1 pas) : trop court
  // face à la période hélicoïdale du filet, ça tronquait à mi-cycle et donnait
  // un effet de disques empilés au lieu d'un cône lisse. Longueur recalibrée
  // à 1,5×pas (~20° réel, toujours < 2P donc conforme à la norme) : assez
  // long pour lisser sur plusieurs tours, validé visuellement.
  const fadeDist     = pitch > 0 ? pitch : 1;
  const chamferAbout = !!params.chamferAbout;
  const chamferLen   = chamferAbout
    ? (pitch > 0 ? pitch * 1.5 : (rCrest - rRoot > 0 ? rCrest - rRoot : rCrest * 0.4))
    : 0;
  // [NEW V4.5.4] Sans tête (goujon fileté des deux bouts), Y1 est AUSSI une
  // extrémité libre d'entrée de filet (tige qui se visse aux deux bouts) —
  // même chanfrein que Y0, symétrique. Avec une tête, Y1 = base de tête,
  // jamais insérée nulle part : pas de chanfrein là. Automatique, pas une
  // case en plus — découle directement du choix HEAD déjà fait.
  const chamferBothEnds = chamferAbout && headType === 'none';
  for (let i = 0; i <= N_AX; i++) {
    const y = Y0 + (i / N_AX) * length;
    for (let j = 0; j < N_RAD; j++) {
      const theta = (j / N_RAD) * Math.PI * 2;
      let r;
      if (pitch <= 0) {
        r = rCrest;
      } else {
        const phi  = y / pitch - theta / (Math.PI * 2); // hélice droite
        const rFull = profileR(phi);
        let fade    = 1.0;
        if (y - Y0 < fadeDist) fade = Math.min(fade, (y - Y0) / fadeDist);
        if (Y1 - y < fadeDist) fade = Math.min(fade, (Y1 - y) / fadeDist);
        r = rCrest - (rCrest - rFull) * fade;
        if (chamferLen > 0 && (y - Y0) < chamferLen) {
          const rEnv = rRoot + (rCrest - rRoot) * ((y - Y0) / chamferLen);
          r = Math.min(r, rEnv);
        }
        if (chamferBothEnds && (Y1 - y) < chamferLen) {
          const rEnvTop = rRoot + (rCrest - rRoot) * ((Y1 - y) / chamferLen);
          r = Math.min(r, rEnvTop);
        }
      }
      verts.push(Math.cos(theta) * r, y, Math.sin(theta) * r);
    }
  }

  // ══ 2. TÊTE ══════════════════════════════════════════════════════
  const headBaseOfs = (N_AX + 1) * N_RAD;
  const headTopOfs  = headBaseOfs + N_RAD;
  if (headType !== 'none') {
    for (let j = 0; j < N_RAD; j++) {
      const theta = (j / N_RAD) * Math.PI * 2;
      const r = headR(theta);
      verts.push(Math.cos(theta) * r, Y1, Math.sin(theta) * r);           // base tête
    }
    for (let j = 0; j < N_RAD; j++) {
      const theta = (j / N_RAD) * Math.PI * 2;
      const r = headR(theta);
      verts.push(Math.cos(theta) * r, Y1 + headH, Math.sin(theta) * r);   // sommet tête
    }
  }

  // ══ Centres de bouchons ═══════════════════════════════════════════
  const botCtrIdx = verts.length / 3;
  verts.push(0, Y0, 0);
  const topCtrIdx = verts.length / 3;
  const capTopY   = (headType !== 'none') ? Y1 + headH : Y1;
  verts.push(0, capTopY, 0);

  // ══ 3. TRIANGULATION ═════════════════════════════════════════════

  // 3a. Latérale tige hélicoïdale
  for (let i = 0; i < N_AX; i++) {
    for (let j = 0; j < N_RAD; j++) {
      const j1 = (j + 1) % N_RAD;
      const a = i * N_RAD + j,       b = (i + 1) * N_RAD + j;
      const c = (i + 1) * N_RAD + j1, d = i * N_RAD + j1;
      idxs.push(a, b, c,  a, c, d);
    }
  }

  // 3b. Cap bas − normale −Y
  for (let j = 0; j < N_RAD; j++) {
    idxs.push(botCtrIdx, j, (j + 1) % N_RAD);
  }

  if (headType !== 'none') {
    // 3c. Washer (face d'appui) − anneau sommet-tige → base-tête
    const shaftLastRing = N_AX * N_RAD;
    for (let j = 0; j < N_RAD; j++) {
      const j1   = (j + 1) % N_RAD;
      const inJ  = shaftLastRing + j,  inJ1 = shaftLastRing + j1;
      const outJ = headBaseOfs + j,   outJ1 = headBaseOfs + j1;
      idxs.push(inJ, outJ, outJ1,  inJ, outJ1, inJ1);
    }
    // 3d. Latérale tête
    for (let j = 0; j < N_RAD; j++) {
      const j1 = (j + 1) % N_RAD;
      const a = headBaseOfs + j,   b = headTopOfs + j;
      const c = headTopOfs + j1,   d = headBaseOfs + j1;
      idxs.push(a, b, c,  a, c, d);
    }
    // 3e. Cap haut tête − normale +Y
    for (let j = 0; j < N_RAD; j++) {
      idxs.push(topCtrIdx, headTopOfs + (j + 1) % N_RAD, headTopOfs + j);
    }
  } else {
    // 3c'. Cap haut tige − normale +Y
    const shaftTopOfs = N_AX * N_RAD;
    for (let j = 0; j < N_RAD; j++) {
      idxs.push(topCtrIdx, shaftTopOfs + (j + 1) % N_RAD, shaftTopOfs + j);
    }
  }

  return { vPos: new Float32Array(verts), tris: idxs };
}

// ── État dialog ───────────────────────────────────────────────────
let _screwSys    = 'metric';
let _screwThread = 'coarse';
let _screwHead   = 'hex';
let _screwNRad   = 48;

// ── Populate le select taille selon le système ─────────────────────
function _screwPopulateSpec(targetIdx) {
  const sel = document.getElementById('sc-spec');
  if (!sel) return;
  const db = _SCREW_DB[_screwSys] || _SCREW_DB.metric;
  sel.innerHTML = '';
  db.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = s.name;
    sel.appendChild(opt);
  });
  // Par défaut : M6 métrique (idx 5), 1/4" impérial (idx 4)
  sel.selectedIndex = targetIdx !== undefined ? targetIdx
    : (_screwSys === 'metric' ? 5 : 4);
}

// ── Setters ────────────────────────────────────────────────────────
function _screwSetSys(v) {
  _screwSys = v;
  document.getElementById('sc-sys-metric').classList.toggle('active',   v === 'metric');
  document.getElementById('sc-sys-imperial').classList.toggle('active', v === 'imperial');
  _screwPopulateSpec();
  _screwRebuild();
}

function _screwSetThread(v) {
  _screwThread = v;
  ['coarse','fine','custom','none'].forEach(t =>
    document.getElementById('sc-th-'+t).classList.toggle('active', t === v));
  document.getElementById('sc-pitch-row').style.display = (v === 'custom') ? 'grid' : 'none';
  _screwRebuild();
}

function _screwSetHead(v) {
  _screwHead = v;
  ['none','hex','chc'].forEach(h =>
    document.getElementById('sc-hd-'+h).classList.toggle('active', h === v));
  _screwRebuild();
}

function _screwSetNRad(v) {
  _screwNRad = v;
  document.getElementById('sc-vnrad').textContent = v;
  [32,48,64,96].forEach(n => {
    const b = document.getElementById('sc-nrad-'+n);
    if (b) b.classList.toggle('active', n === v);
  });
  _screwRebuild();
}

function _screwLenPreset(v) {
  const sl = document.getElementById('sc-slen');
  const lb = document.getElementById('sc-vlen');
  if (sl) sl.value = v;
  if (lb) lb.textContent = v;
  _screwRebuild();
}

// ── Live rebuild ───────────────────────────────────────────────────
function _screwRebuild() {
  const specIdx     = +document.getElementById('sc-spec').value;
  const length      = +document.getElementById('sc-slen').value;
  const pitchCustom = +document.getElementById('sc-spitch').value;
  const chamferAbout = document.getElementById('sc-chamfer-about').checked;
  const geo = _makeScrew({
    system:_screwSys, specIdx, thread:_screwThread,
    pitchCustom, length, head:_screwHead, nRad:_screwNRad, chamferAbout
  });
  const triCnt = geo.tris.length / 3;
  const vtxCnt = geo.vPos.length / 3;
  const db   = _SCREW_DB[_screwSys] || _SCREW_DB.metric;
  const spec = db[Math.min(specIdx, db.length-1)] || {};
  document.getElementById('sc-stats').textContent =
    `${spec.name||'?'} · Ø${spec.dia ? spec.dia.toFixed(1) : '?'} mm · ▲ ${triCnt.toLocaleString('fr-FR')} tri · ◎ ${vtxCnt.toLocaleString('fr-FR')} vtx`;
  _genLiveUpdate({ vPos: geo.vPos, tris: geo.tris });
}

// ── Ouverture / fermeture dialog ───────────────────────────────────
function showScrewDialog(obj) {
  const editMode = !!obj;
  if (editMode) _genEditBegin(obj);
  else _genEditObj = null;

  const p = editMode && obj.genParams ? obj.genParams
    : { system:'metric', specIdx:5, thread:'coarse', pitchCustom:1.0, length:20, head:'hex', nRad:48, chamferAbout:true };

  _screwSys    = p.system || 'metric';
  _screwThread = p.thread || 'coarse';
  _screwHead   = p.head   || 'hex';
  _screwNRad   = p.nRad   || 48;
  // [NEW V4.5.2] Vis anciennes sans ce champ (projets sauvegardés avant cette
  // version) -> false par défaut : zéro changement de géométrie surprise à la
  // ré-édition. Les vis neuves l'ont à true via le littéral ci-dessus.
  document.getElementById('sc-chamfer-about').checked =
    p.chamferAbout !== undefined ? p.chamferAbout : false;

  // Sync boutons système (avant populateSpec pour le bon filtre)
  document.getElementById('sc-sys-metric').classList.toggle('active',   _screwSys === 'metric');
  document.getElementById('sc-sys-imperial').classList.toggle('active', _screwSys === 'imperial');
  _screwPopulateSpec(p.specIdx !== undefined ? p.specIdx : (_screwSys === 'metric' ? 5 : 4));

  _screwSetThread(_screwThread);
  _screwSetHead(_screwHead);
  _screwSetNRad(_screwNRad);

  const slenEl = document.getElementById('sc-slen');
  const vlenEl = document.getElementById('sc-vlen');
  if (slenEl) slenEl.value = p.length || 20;
  if (vlenEl) vlenEl.textContent = p.length || 20;

  const spEl = document.getElementById('sc-spitch');
  const vpEl = document.getElementById('sc-vpitch');
  if (spEl) spEl.value = (p.pitchCustom || 1.0).toFixed(2);
  if (vpEl) vpEl.textContent = (p.pitchCustom || 1.0).toFixed(2);

  _genDialogMode('screw-modal', editMode, '🔩 Screw.Gen — Parametric fastener', 'screw-apply-btn');
  _screwRebuild();

  const el = document.getElementById('screw-modal');
  el.style.left = Math.max(196, innerWidth  - 360 - 332) + 'px';
  el.style.top  = Math.max(34,  innerHeight - 560 - 32)  + 'px';
  el.classList.add('open');
}

function hideScrewDialog(cancel) {
  _previewDispose();
  if (cancel) _genEditCancel(); else _genEditApply();
  document.getElementById('screw-modal').classList.remove('open');
}

// ── Validation et ajout en scène ───────────────────────────────────
function _screwToScene() {
  const specIdx     = +document.getElementById('sc-spec').value;
  const length      = +document.getElementById('sc-slen').value;
  const pitchCustom = +document.getElementById('sc-spitch').value;
  const db   = _SCREW_DB[_screwSys] || _SCREW_DB.metric;
  const spec = db[Math.min(specIdx, db.length-1)] || {};

  if(!_numsOK(specIdx,length) || length<=0){
    nasLog('ERROR','Screw.Gen : valeurs invalides (spec='+specIdx+', longueur='+length+')');
    _nasAlert('⚠ Screw.Gen : vérifie la spécification et la longueur.');
    return;
  }

  // MODE ÉDITION
  const chamferAbout = document.getElementById('sc-chamfer-about').checked;
  if (_genEditObj) {
    _genEditObj.genParams = { system:_screwSys, specIdx, thread:_screwThread,
                               pitchCustom, length, head:_screwHead, nRad:_screwNRad, chamferAbout };
    nasLog('OK','Screw.Gen edited: '+_genEditObj.name);
    _csgLog && _csgLog('✏ Screw.Gen edited → '+_genEditObj.name);
    hideScrewDialog(false);
    return;
  }

  // MODE CRÉATION
  const label = `${spec.name||specIdx}_L${length}`;
  showSpinner('Screw.Gen', label);
  try {
    const sgr = _makeScrew({ system:_screwSys, specIdx, thread:_screwThread,
                              pitchCustom, length, head:_screwHead, nRad:_screwNRad, chamferAbout });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(sgr.vPos, 3));
    geo.setIndex(sgr.tris);
    geo.computeVertexNormals();
    geo.computeBoundingBox();

    // [REFACTOR V4.7.1] cf. tore-gen.js — bloc mutualisé dans _finalizeGenToScene (htm).
    _finalizeGenToScene({
      label: 'Screw.Gen', geo,
      name: (n) => `screw_${spec.name||specIdx}_L${length}_${n}`,
      genType: 'screw',
      genParams: { system:_screwSys, specIdx, thread:_screwThread,
                   pitchCustom, length, head:_screwHead, nRad:_screwNRad, chamferAbout },
      hideDialogFn: () => hideScrewDialog(false)
    });
  } catch(err) {
    hideSpinner();
    nasLog('ERROR','Screw.Gen : '+err.message);
    _nasAlert('⚠ Screw.Gen : '+err.message);
  }
}
// ══ Fin Screw.Gen ══════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// nut-gen.js — module Nut.Gen extrait du host NASSCAD
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, selObjs, objCnt, COL, PS, isHoleMode           — scene state
//   THREE                                                        — Three.js global
//   undoPush, updProps, updOList, updStats, nasLog, _nasAlert    — app-wide helpers
//   _findFreePos, _csgLog                                        — placement/log helpers
//   showSpinner, hideSpinner                                     — loading UI
//   _genEditBegin, _genEditApply, _genEditCancel, _genEditObj,
//   _genDialogMode, _genLiveUpdate, _previewDispose                — generic "Gen Edit Mode" infra
//                                                                    (lives elsewhere in the host file,
//                                                                    shared by every primitive dialog)
//
//   ⚠ COUPLAGE INTER-MODULES : _SCREW_DB (const déclarée dans screw-gen.js)
//     Nut.Gen réutilise la base de filetage ISO/ASME de Screw.Gen.
//     Fonctionne via l'environnement lexical global partagé entre balises
//     <script> classiques du même document — MAIS EXIGE que screw-gen.js
//     soit chargé (balise <script src>) AVANT nut-gen.js dans le HTML.
//     Ne pas réordonner les <script src> sans recontrôler ce point.
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// ⬡ NUT.GEN — Écrou paramétrique ISO 4032/4033 · ASME B18.2.2
// Géométrie watertight : hex ext + bore intérieur fileté ISO 60°
// + chanfrein 30° optionnel sur les faces haut/bas
// ══════════════════════════════════════════════════════════════════

// ── Constructeur géométrie pure ────────────────────────────────────
// params: { system, specIdx, thread, pitchCustom, style, mCustom, chamfer, nRad }
// Retourne { vPos: Float32Array, tris: Uint32Array }
// Géométrie posée sur Y=0 (face bas). Face haut à Y = m.
function _makeNut(params) {
  const sys     = params.system  || 'metric';
  const spIdx   = params.specIdx !== undefined ? params.specIdx : 5; // M6 défaut
  const db      = _SCREW_DB[sys] || _SCREW_DB.metric;
  const spec    = db[Math.min(Math.max(0, spIdx), db.length - 1)];
  const D       = spec.dia;
  const rCrest  = D / 2;
  const thread  = params.thread  || 'coarse';
  const style   = params.style   || 'normal';
  const chamfer = params.chamfer !== false;
  const N_RAD   = params.nRad    || 48;

  // ── Hauteur de l'écrou ────────────────────────────────────────
  let m;
  if      (style === 'custom') m = Math.max(1, params.mCustom || D * 0.8);
  else if (style === 'high')   m = spec.m_high !== undefined ? spec.m_high : (spec.m || D * 0.8) * 1.2;
  else                         m = spec.m      !== undefined ? spec.m      : D * 0.8;
  m = Math.max(1, m);

  // ── Pas du filet (même convention que _makeScrew) ─────────────
  let pitch = 0, rRoot = rCrest;
  if (thread !== 'none') {
    if      (thread === 'custom') pitch = Math.max(0.05, params.pitchCustom || 1.0);
    else if (thread === 'fine')   pitch = sys === 'metric' ? spec.fine   : 25.4 / spec.fine;
    else                          pitch = sys === 'metric' ? spec.coarse : 25.4 / spec.coarse;
    const Hv = (Math.sqrt(3) / 2) * pitch;
    rRoot    = rCrest - (5 / 8) * Hv;
  }

  // ── Hexagone externe ──────────────────────────────────────────
  const hexApothem = spec.s !== undefined ? spec.s / 2 : D * 0.85;
  function hexR(theta) {
    const a = theta % (Math.PI / 3) - Math.PI / 6;
    return hexApothem / Math.cos(a);
  }

  // ── Profil filet ISO 60° — phase +0.5 = filet femelle ─────────
  // Crêtes écrou (vers axe) là où la vis a ses gorges, et vice-versa.
  function profileR(phi) {
    const p  = ((phi % 1) + 1) % 1;
    const HR = rCrest - rRoot;
    if (p < 1/16 || p >= 15/16) return rCrest;
    if (p < 6/16)   return rCrest - HR * (p - 1/16)  / (5/16);
    if (p <= 10/16) return rRoot;
    return rRoot + HR * (p - 10/16) / (5/16);
  }

  // ── Résolution axiale bore ────────────────────────────────────
  const N_PER_TURN = 32, N_AX_MAX = 3200;
  const N_AX = pitch > 0
    ? Math.max(N_PER_TURN, Math.min(N_AX_MAX, Math.ceil((m / pitch) * N_PER_TURN)))
    : 48;

  // ── Chanfrein 30° (face haut/bas) — ISO 4032 ─────────────────
  // ch_h = hauteur axiale du chanfrein
  // r_cham(θ) = rayon à la face plate (Y=0 ou Y=m) = hexR(θ) − ch_h · √3
  const SQRT3 = Math.sqrt(3);
  const ch_h  = chamfer ? Math.min(m * 0.22, (hexApothem - rCrest) * 0.90 / SQRT3) : 0;
  function rCham(theta) { return Math.max(rCrest + 0.01, hexR(theta) - ch_h * SQRT3); }

  const verts = [], idxs = [];

  // ════════════════ ANNEAUX DE SOMMETS ════════════════════════════

  // Parois hex bas / haut (décalées de ch_h si chanfrein)
  const yBot = chamfer ? ch_h : 0;
  const yTop = chamfer ? m - ch_h : m;

  const HEX_BOT = 0;
  for (let j = 0; j < N_RAD; j++) {
    const t = (j / N_RAD) * Math.PI * 2;
    verts.push(Math.cos(t) * hexR(t), yBot, Math.sin(t) * hexR(t));
  }
  const HEX_TOP = N_RAD;
  for (let j = 0; j < N_RAD; j++) {
    const t = (j / N_RAD) * Math.PI * 2;
    verts.push(Math.cos(t) * hexR(t), yTop, Math.sin(t) * hexR(t));
  }

  // Bore intérieur fileté (N_AX+1 anneaux, Y=0 → Y=m)
  const fadeDist = pitch > 0 ? pitch : 1;
  const BORE = 2 * N_RAD;
  for (let i = 0; i <= N_AX; i++) {
    const y = (i / N_AX) * m;
    for (let j = 0; j < N_RAD; j++) {
      const t = (j / N_RAD) * Math.PI * 2;
      let r;
      if (pitch <= 0) {
        r = rCrest;
      } else {
        const phi   = y / pitch - t / (Math.PI * 2);
        const rFull = profileR(phi + 0.5); // +0.5 → filet femelle
        let fade    = 1.0;
        if (y < fadeDist)     fade = Math.min(fade, y / fadeDist);
        if (m - y < fadeDist) fade = Math.min(fade, (m - y) / fadeDist);
        r = rCrest - (rCrest - rFull) * fade;
      }
      verts.push(Math.cos(t) * r, y, Math.sin(t) * r);
    }
  }

  // Arêtes intérieures de chanfrein (r_cham, Y=0 / Y=m)
  const CH_BOT = chamfer ? verts.length / 3 : -1;
  if (chamfer) {
    for (let j = 0; j < N_RAD; j++) {
      const t = (j / N_RAD) * Math.PI * 2;
      verts.push(Math.cos(t) * rCham(t), 0, Math.sin(t) * rCham(t));
    }
  }
  const CH_TOP = chamfer ? verts.length / 3 : -1;
  if (chamfer) {
    for (let j = 0; j < N_RAD; j++) {
      const t = (j / N_RAD) * Math.PI * 2;
      verts.push(Math.cos(t) * rCham(t), m, Math.sin(t) * rCham(t));
    }
  }

  // ════════════════ TRIANGULATION ═════════════════════════════════

  // 1. Parois hex ext — normales sortantes (convention Screw.Gen : a,c,d,a,d,b)
  for (let j = 0; j < N_RAD; j++) {
    const j1 = (j + 1) % N_RAD;
    const a = HEX_BOT + j, b = HEX_BOT + j1;
    const c = HEX_TOP + j, d = HEX_TOP + j1;
    idxs.push(a, c, d,  a, d, b);
  }

  // 2. Bore fileté — normales vers l'axe (winding inversé : a,c,b,a,d,c)
  for (let i = 0; i < N_AX; i++) {
    for (let j = 0; j < N_RAD; j++) {
      const j1 = (j + 1) % N_RAD;
      const a = BORE + i       * N_RAD + j;
      const b = BORE + (i + 1) * N_RAD + j;
      const c = BORE + (i + 1) * N_RAD + j1;
      const d = BORE + i       * N_RAD + j1;
      idxs.push(a, c, b,  a, d, c);
    }
  }

  // 3. Face annulaire bas — normale -Y
  const BORE_BOT = BORE, BORE_TOP = BORE + N_AX * N_RAD;
  for (let j = 0; j < N_RAD; j++) {
    const j1 = (j + 1) % N_RAD;
    const oj  = chamfer ? CH_BOT + j  : HEX_BOT + j;
    const oj1 = chamfer ? CH_BOT + j1 : HEX_BOT + j1;
    const ij  = BORE_BOT + j, ij1 = BORE_BOT + j1;
    idxs.push(oj, ij1, ij,  oj, oj1, ij1);
  }

  // 4. Face annulaire haut — normale +Y
  for (let j = 0; j < N_RAD; j++) {
    const j1 = (j + 1) % N_RAD;
    const oj  = chamfer ? CH_TOP + j  : HEX_TOP + j;
    const oj1 = chamfer ? CH_TOP + j1 : HEX_TOP + j1;
    const ij  = BORE_TOP + j, ij1 = BORE_TOP + j1;
    idxs.push(oj, ij, ij1,  oj, ij1, oj1);
  }

  // 5. Surfaces de chanfrein (si activé) — normales sortantes-obliques
  if (chamfer) {
    // Chanfrein bas : CH_BOT (r_cham, Y=0) → HEX_BOT (hexR, Y=ch_h)
    for (let j = 0; j < N_RAD; j++) {
      const j1 = (j + 1) % N_RAD;
      const a = CH_BOT + j,  b = CH_BOT + j1;
      const c = HEX_BOT + j, d = HEX_BOT + j1;
      idxs.push(a, c, d,  a, d, b);
    }
    // Chanfrein haut : HEX_TOP (hexR, Y=m-ch_h) → CH_TOP (r_cham, Y=m)
    for (let j = 0; j < N_RAD; j++) {
      const j1 = (j + 1) % N_RAD;
      const a = HEX_TOP + j,  b = HEX_TOP + j1;
      const c = CH_TOP + j,   d = CH_TOP + j1;
      idxs.push(a, c, d,  a, d, b);
    }
  }

  return { vPos: new Float32Array(verts), tris: idxs };
}

// ── État dialog ────────────────────────────────────────────────────
let _nutSys     = 'metric';
let _nutThread  = 'coarse';
let _nutStyle   = 'normal';
let _nutChamfer = true;
let _nutNRad    = 48;

function _nutPopulateSpec(targetIdx) {
  const sel = document.getElementById('nt-spec');
  if (!sel) return;
  const db = _SCREW_DB[_nutSys] || _SCREW_DB.metric;
  sel.innerHTML = '';
  db.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = s.name;
    sel.appendChild(o);
  });
  sel.selectedIndex = targetIdx !== undefined ? targetIdx
    : (_nutSys === 'metric' ? 5 : 4); // défaut M6 / 1/4"
}

function _nutSetSys(v) {
  _nutSys = v;
  document.getElementById('nt-sys-metric').classList.toggle('active',   v === 'metric');
  document.getElementById('nt-sys-imperial').classList.toggle('active', v === 'imperial');
  _nutPopulateSpec();
  _nutRebuild();
}

function _nutSetThread(v) {
  _nutThread = v;
  ['coarse','fine','custom','none'].forEach(t =>
    document.getElementById('nt-th-'+t).classList.toggle('active', t === v));
  document.getElementById('nt-pitch-row').style.display = (v === 'custom') ? 'grid' : 'none';
  _nutRebuild();
}

function _nutSetStyle(v) {
  _nutStyle = v;
  ['normal','high','custom'].forEach(s =>
    document.getElementById('nt-st-'+s).classList.toggle('active', s === v));
  document.getElementById('nt-height-row').style.display = (v === 'custom') ? 'grid' : 'none';
  _nutRebuild();
}

function _nutSetChamfer(v) {
  _nutChamfer = v;
  document.getElementById('nt-ch-on').classList.toggle('active',  v);
  document.getElementById('nt-ch-off').classList.toggle('active', !v);
  _nutRebuild();
}

function _nutSetNRad(v) {
  _nutNRad = v;
  document.getElementById('nt-vnrad').textContent = v;
  [32, 48, 64].forEach(n => {
    const b = document.getElementById('nt-nrad-'+n);
    if (b) b.classList.toggle('active', n === v);
  });
  _nutRebuild();
}

function _nutRebuild() {
  const specIdx     = +document.getElementById('nt-spec').value;
  const pitchCustom = +document.getElementById('nt-spitch').value;
  const mCustom     = +document.getElementById('nt-sheight').value;
  const geo = _makeNut({
    system: _nutSys, specIdx,
    thread: _nutThread, pitchCustom,
    style:  _nutStyle,  mCustom,
    chamfer: _nutChamfer, nRad: _nutNRad
  });
  const db   = _SCREW_DB[_nutSys] || _SCREW_DB.metric;
  const spec = db[Math.min(specIdx, db.length - 1)] || {};
  const mVal = _nutStyle === 'custom' ? mCustom
             : _nutStyle === 'high'   ? (spec.m_high || spec.m || 0)
             : (spec.m || 0);
  document.getElementById('nt-stats').textContent =
    `${spec.name || '?'} · Ø${spec.dia ? spec.dia.toFixed(1) : '?'} mm · h=${mVal.toFixed ? mVal.toFixed(1) : mVal} mm`
    + ` · ▲ ${(geo.tris.length / 3).toLocaleString('fr-FR')} tri · ◎ ${(geo.vPos.length / 3).toLocaleString('fr-FR')} vtx`;
  _genLiveUpdate({ vPos: geo.vPos, tris: geo.tris });
}

function showNutDialog(obj) {
  const editMode = !!obj;
  if (editMode) _genEditBegin(obj); else _genEditObj = null;

  const p = (editMode && obj.genParams) ? obj.genParams
    : { system:'metric', specIdx:5, thread:'coarse', pitchCustom:1.0,
        style:'normal', mCustom:5, chamfer:true, nRad:48 };

  _nutSys     = p.system  || 'metric';
  _nutThread  = p.thread  || 'coarse';
  _nutStyle   = p.style   || 'normal';
  _nutChamfer = p.chamfer !== false;
  _nutNRad    = p.nRad    || 48;

  document.getElementById('nt-sys-metric').classList.toggle('active',   _nutSys === 'metric');
  document.getElementById('nt-sys-imperial').classList.toggle('active', _nutSys === 'imperial');
  _nutPopulateSpec(p.specIdx !== undefined ? p.specIdx : (_nutSys === 'metric' ? 5 : 4));
  _nutSetThread(_nutThread);
  _nutSetStyle(_nutStyle);
  _nutSetChamfer(_nutChamfer);
  _nutSetNRad(_nutNRad);

  const sh = document.getElementById('nt-sheight'); if (sh) sh.value = (p.mCustom || 5);
  const vh = document.getElementById('nt-vheight'); if (vh) vh.value = +(p.mCustom || 5).toFixed(1);
  const sp = document.getElementById('nt-spitch');  if (sp) sp.value = (p.pitchCustom || 1.0).toFixed(2);
  const vp = document.getElementById('nt-vpitch');  if (vp) vp.value = (p.pitchCustom || 1.0).toFixed(2);

  _genDialogMode('nut-modal', editMode, '⬡ Nut.Gen', 'nut-apply-btn');
  _nutRebuild();

  const el = document.getElementById('nut-modal');
  el.style.left = Math.max(196, innerWidth  - 390 - 332) + 'px';
  el.style.top  = Math.max(34,  innerHeight - 660 - 32)  + 'px';
  el.classList.add('open');
}

function hideNutDialog(cancel) {
  _previewDispose();
  if (cancel) _genEditCancel(); else _genEditApply();
  document.getElementById('nut-modal').classList.remove('open');
}

function _nutToScene() {
  const specIdx     = +document.getElementById('nt-spec').value;
  const pitchCustom = +document.getElementById('nt-spitch').value;
  const mCustom     = +document.getElementById('nt-sheight').value;
  const db   = _SCREW_DB[_nutSys] || _SCREW_DB.metric;
  const spec = db[Math.min(specIdx, db.length - 1)] || {};

  if(!_numsOK(specIdx)){
    nasLog('ERROR','Nut.Gen : spécification invalide');
    _nasAlert('⚠ Nut.Gen : vérifie le champ de spécification.');
    return;
  }

  if (_genEditObj) {
    _genEditObj.genParams = { system:_nutSys, specIdx, thread:_nutThread,
                               pitchCustom, style:_nutStyle, mCustom,
                               chamfer:_nutChamfer, nRad:_nutNRad };
    nasLog && nasLog('OK', 'Nut.Gen edited: ' + _genEditObj.name);
    hideNutDialog(false);
    return;
  }

  const label = spec.name || ('spec_' + specIdx);
  showSpinner && showSpinner('Nut.Gen', label);
  try {
    const ngr = _makeNut({ system:_nutSys, specIdx, thread:_nutThread,
                            pitchCustom, style:_nutStyle, mCustom,
                            chamfer:_nutChamfer, nRad:_nutNRad });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(ngr.vPos, 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(ngr.tris), 1));
    geo.computeVertexNormals();
    geo.computeBoundingBox();

    // [REFACTOR V4.7.1] cf. tore-gen.js — bloc mutualisé dans _finalizeGenToScene
    // (htm). Seul fichier des 9 à garder ses gardes défensives (nasLog && …,
    // hideSpinner && …) avant ce refactor — le helper les appelle nu comme les
    // 8 autres générateurs (ce sont des globales toujours définies à ce point
    // du cycle de vie de la page ; aucune régression).
    _finalizeGenToScene({
      label: 'Nut.Gen', geo,
      name: (n) => 'nut_' + label.replace(/[^A-Za-z0-9]/g,'_') + '_' + n,
      genType: 'nut',
      genParams: { system:_nutSys, specIdx, thread:_nutThread,
                  pitchCustom, style:_nutStyle, mCustom,
                  chamfer:_nutChamfer, nRad:_nutNRad },
      hideDialogFn: () => hideNutDialog(false)
    });
  } catch(err) {
    hideSpinner && hideSpinner();
    nasLog && nasLog('ERROR', 'Nut.Gen: ' + err.message);
    _nasAlert && _nasAlert('⚠ Nut.Gen: ' + err.message);
  }
}
// ══ Fin Nut.Gen ═════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// revsolid-gen.js — module RevSolid.Gen extrait du host NASSCAD
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, selObjs, objCnt, COL, PS, isHoleMode           — scene state
//   THREE                                                        — Three.js global
//   undoPush, updProps, updOList, updStats, nasLog, _nasAlert    — app-wide helpers
//   _findFreePos, _csgLog                                        — placement/log helpers
//   showSpinner, hideSpinner                                     — loading UI
//   _genEditBegin, _genEditApply, _genEditCancel, _genEditObj,
//   _genDialogMode, _genLiveUpdateNorm, _previewDispose            — generic "Gen Edit Mode" infra
//                                                                    (lives elsewhere in the host file,
//                                                                    shared by every primitive dialog)
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// ⌀ RevSolid.Gen — Solide de révolution watertight
// Arc configurable 1–360° · Fermeture angulaire manifold garantie
// ══════════════════════════════════════════════════════════════════

let _latheN_val   = 64;    // Nb facettes radiales
let _latheArc_val = 270;   // Angle d'arc (degrés)

// ── Constructeur géométrie ─────────────────────────────────────
// Retourne {vPos, tris} compatible _genLiveUpdate / _cylindToScene
// Profil : disque plein (0 → R) tourné de arcDeg° autour de l'axe Y
// Pool de vertices pour garantir le watertight manifold
function _makeLatheGeo(R, H, N, arcDeg) {
  // ── BUG-01 fix V4.2.5 : normales analytiques ──────────────────────────
  // Vertices NON-mergés aux arêtes vives (paroi↔caps, bouchons arc) :
  // chaque surface a ses propres vertices + normales analytiques correctes.
  // Manifold garanti : positions identiques aux arêtes → topologie fermée.
  // Retourne {vPos, normals, tris} — consommé par _genLiveUpdateNorm.
  const arcDegC = Math.min(360, Math.max(1, arcDeg));
  const full    = arcDegC >= 359.99;
  const arcRad  = arcDegC * Math.PI / 180;
  const halfH   = H / 2;
  const count   = full ? N : N + 1;

  const vPos    = [];
  const normals = [];
  const tris    = [];

  // Pré-calculer cos/sin pour chaque anneau
  const cosT = new Float32Array(count);
  const sinT = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const theta = full ? (i / N) * 2 * Math.PI : (i / N) * arcRad;
    cosT[i] = Math.cos(theta);
    sinT[i] = Math.sin(theta);
  }

  function addV(x, y, z, nx, ny, nz) {
    const idx = vPos.length / 3;
    vPos.push(x, y, z);
    normals.push(nx, ny, nz);
    return idx;
  }
  function addTri(a, b, c) { tris.push(a, b, c); }

  // ── Paroi latérale — normale radiale (cosT, 0, sinT) ────────────────
  const wallBot = new Int32Array(count);
  const wallTop = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const nx = cosT[i], nz = sinT[i];
    wallBot[i] = addV(R * cosT[i], -halfH, R * sinT[i], nx, 0, nz);
    wallTop[i] = addV(R * cosT[i],  halfH, R * sinT[i], nx, 0, nz);
  }
  for (let i = 0; i < N; i++) {
    const i1 = full ? (i + 1) % N : i + 1;
    addTri(wallBot[i], wallTop[i],  wallTop[i1]);
    addTri(wallBot[i], wallTop[i1], wallBot[i1]);
  }

  // ── Cap bas — normale (0, −1, 0) ─────────────────────────────────────
  const cBot = addV(0, -halfH, 0, 0, -1, 0);
  const capBotRing = new Int32Array(count);
  for (let i = 0; i < count; i++)
    capBotRing[i] = addV(R * cosT[i], -halfH, R * sinT[i], 0, -1, 0);
  for (let i = 0; i < N; i++) {
    const i1 = full ? (i + 1) % N : i + 1;
    addTri(cBot, capBotRing[i], capBotRing[i1]);
  }

  // ── Cap haut — normale (0, +1, 0) ────────────────────────────────────
  const cTop = addV(0, halfH, 0, 0, 1, 0);
  const capTopRing = new Int32Array(count);
  for (let i = 0; i < count; i++)
    capTopRing[i] = addV(R * cosT[i], halfH, R * sinT[i], 0, 1, 0);
  for (let i = 0; i < N; i++) {
    const i1 = full ? (i + 1) % N : i + 1;
    addTri(cTop, capTopRing[i1], capTopRing[i]);
  }

  // ── Bouchons angulaires pour arc < 360° ─────────────────────────────
  // Normales analytiques vérifiées algébriquement :
  //   début (theta=0)   : (0,  0, -1)
  //   fin   (theta=arc) : (−sin arc, 0, cos arc)
  if (!full) {
    // Face début (theta = 0) — plan XY, normale vers −Z
    const s0B = addV(0, -halfH, 0,  0, 0, -1);
    const s0T = addV(0,  halfH, 0,  0, 0, -1);
    const s0t = addV(R, -halfH, 0,  0, 0, -1);
    const s0u = addV(R,  halfH, 0,  0, 0, -1);
    addTri(s0B, s0T, s0u);
    addTri(s0B, s0u, s0t);

    // Face fin (theta = arcRad) — normale (−sin arc, 0, cos arc)
    const fnx = -Math.sin(arcRad), fnz = Math.cos(arcRad);
    const s1B = addV(0,           -halfH, 0,             fnx, 0, fnz);
    const s1T = addV(0,            halfH, 0,             fnx, 0, fnz);
    const s1b = addV(R*cosT[N],  -halfH, R*sinT[N],      fnx, 0, fnz);
    const s1t = addV(R*cosT[N],   halfH, R*sinT[N],      fnx, 0, fnz);
    addTri(s1B, s1b, s1T);
    addTri(s1b, s1t, s1T);
  }

  return { vPos, normals, tris };
}

// ── Rebuild live (preview fantôme ou édition directe) ────────────
function _latheRebuild() {
  const R   = +document.getElementById('lt-sr').value;
  const H   = +document.getElementById('lt-sh').value;
  const arc = +document.getElementById('lt-sarc').value;
  const geo = _makeLatheGeo(R, H, _latheN_val, arc);
  const triCount = geo.tris.length / 3;
  const vtxCount = geo.vPos.length / 3;
  const vol = (Math.PI * R * R * H * (arc / 360)) / 1000;
  document.getElementById('lt-stats').textContent =
    `▲ ${triCount.toLocaleString('fr-FR')} triangles · ◎ ${vtxCount.toLocaleString('fr-FR')} sommets · Vol ≈ ${vol.toFixed(1)} cm³`;
  // Recentrage pour preview (base à Y=0) — normales inchangées (directionnelles)
  const vShifted = geo.vPos.map((v, i) => (i % 3 === 1) ? v + H/2 : v);
  _genLiveUpdateNorm({ vPos: vShifted, normals: geo.normals, tris: geo.tris });
}

// ── Preset boutons arc ───────────────────────────────────────────
function _latheArcPreset(v) {
  _latheArc_val = v;
  const sl  = document.getElementById('lt-sarc');
  const lbl = document.getElementById('lt-varc');
  if (sl)  sl.value = v;
  if (lbl) lbl.textContent = v + '°';
  _latheRebuild();
}

// ── Preset boutons N facettes ────────────────────────────────────
function _latheN(v) {
  _latheN_val = v;
  document.getElementById('lt-vn').textContent = v;
  document.querySelectorAll('#lathe-modal .vb-win .vb-btn[onclick^="_latheN"]').forEach(b => {
    b.classList.toggle('active', +b.textContent === v);
  });
  _latheRebuild();
}

// ── Ouverture / fermeture du dialog ─────────────────────────────
function showLatheDialog(obj) {
  const editMode = !!obj;
  if (editMode) _genEditBegin(obj);
  else _genEditObj = null;

  const p = editMode && obj.genParams ? obj.genParams
    : { R: 30, H: 40, N: 64, arc: 270 };

  document.getElementById('lt-sr').value    = p.R;
  document.getElementById('lt-vr').value = p.R;
  document.getElementById('lt-sh').value    = p.H;
  document.getElementById('lt-vh').value = p.H;
  document.getElementById('lt-sarc').value  = p.arc;
  document.getElementById('lt-varc').value = p.arc;

  _latheN_val   = p.N   || 64;
  _latheArc_val = p.arc || 270;

  document.getElementById('lt-vn').textContent = _latheN_val;
  document.querySelectorAll('#lathe-modal .vb-win .vb-btn[onclick^="_latheN"]').forEach(b => {
    b.classList.toggle('active', +b.textContent === _latheN_val);
  });

  _genDialogMode('lathe-modal', editMode, '⌀ Revolved Solid · Arc configurable', 'lathe-apply-btn');
  _latheRebuild();

  const _lel = document.getElementById('lathe-modal');
  _lel.style.left = Math.max(196, innerWidth  - 345 - 332) + 'px';
  _lel.style.top  = Math.max(34,  innerHeight - 440 - 32)  + 'px';
  _lel.classList.add('open');
}

function hideLatheDialog(cancel) {
  _previewDispose();
  if (cancel) _genEditCancel(); else _genEditApply();
  document.getElementById('lathe-modal').classList.remove('open');
}

// ── Validation et ajout en scène ─────────────────────────────────
function _latheToScene() {
  const R   = +document.getElementById('lt-sr').value;
  const H   = +document.getElementById('lt-sh').value;
  const arc = +document.getElementById('lt-sarc').value;

  if(!_numsOK(R,H,arc) || R<=0 || H<=0 || arc<=0){
    nasLog('ERROR','RevSolid.Gen : valeurs invalides (R='+R+', H='+H+', arc='+arc+')');
    _nasAlert('⚠ RevSolid.Gen : vérifie les champs numériques (valeur vide, non numérique ou hors plage).');
    return;
  }

  // MODE ÉDITION — géo déjà live-updatée, on finalise
  if (_genEditObj) {
    _genEditObj.genParams = { R, H, N: _latheN_val, arc };
    nasLog('OK', 'RevSolid.Gen edited: ' + _genEditObj.name);
    _csgLog && _csgLog('✏ RevSolid.Gen edited → ' + _genEditObj.name);
    hideLatheDialog(false);
    return;
  }

  // MODE CRÉATION
  showSpinner('RevSolid.Gen', `R${R}·H${H}·arc${arc}°`);
  try {
    const { vPos, normals, tris } = _makeLatheGeo(R, H, _latheN_val, arc);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(vPos), 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(new Float32Array(normals), 3));
    geo.setIndex(tris);
    // Base à Y=0 (convention NASSCAD) — translate n'affecte pas les normales
    geo.translate(0, H / 2, 0);
    geo.computeBoundingBox();

    // [REFACTOR V4.7.1] cf. tore-gen.js — bloc mutualisé dans _finalizeGenToScene (htm).
    _finalizeGenToScene({
      label: 'RevSolid.Gen', geo,
      name: (n) => `lathe_R${R}_H${H}_arc${arc}_${n}`,
      genType: 'lathe', genParams: { R, H, N: _latheN_val, arc },
      hideDialogFn: () => hideLatheDialog(false)
    });
  } catch (err) {
    hideSpinner();
    nasLog('ERROR', 'RevSolid.Gen : ' + err.message);
    _nasAlert('⚠ RevSolid.Gen : ' + err.message);
  }
}
// ══ Fin RevSolid.Gen ══════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// cylind-gen.js — module Cylind.Gen extrait du host NASSCAD
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, selObjs, objCnt, COL, PS, isHoleMode           — scene state
//   THREE                                                        — Three.js global
//   undoPush, updProps, updOList, updStats, nasLog, _nasAlert    — app-wide helpers
//   _findFreePos, _csgLog                                        — placement/log helpers
//   showSpinner, hideSpinner                                     — loading UI
//   _genEditBegin, _genEditApply, _genEditCancel, _genEditObj,
//   _genDialogMode, _genLiveUpdate, _previewDispose                — generic "Gen Edit Mode" infra
//                                                                    (lives elsewhere in the host file,
//                                                                    shared by every primitive dialog)
//
//   ⚠ PARTICULARITÉ : _cylSegs, _cylMode_val, _cylN_val (let, déclarées
//     ligne ~15859 du host original, PAS dans ce module) — même schéma que
//     CubeChanfrein.Gen : état déclaré en dehors du bloc de code, avant la
//     convention bannière.
//
//   ⚠ COUPLAGE INTER-MODULES : _slerp3 (function déclarée dans
//     cubechanfrein-gen.js) — interpolation sphérique partagée entre
//     _ccBuildBox (CubeChanfrein.Gen) et _ccBuildFrustum (ce module).
//     EXIGE que cubechanfrein-gen.js soit chargé AVANT cylind-gen.js
//     dans le HTML. Ne pas réordonner les <script src> sans recontrôler.
// ══════════════════════════════════════════════════════════════════════════
function showCylindDialog(obj){
  const editMode = !!obj;
  if(editMode) _genEditBegin(obj);
  else _genEditObj = null;

  const p = editMode && obj.genParams ? obj.genParams : {H:60,Rt:25,Rb:40,ct:5,cb:5,segs:6,mode:'bevel',N:32};
  document.getElementById('cy-sh').value  = p.H;   document.getElementById('cy-vh').value  = p.H;
  document.getElementById('cy-srt').value = p.Rt;  document.getElementById('cy-vrt').value = p.Rt;
  document.getElementById('cy-srb').value = p.Rb;  document.getElementById('cy-vrb').value = p.Rb;
  document.getElementById('cy-sct').value = p.ct;  document.getElementById('cy-vct').value = (+p.ct).toFixed(1);
  document.getElementById('cy-scb').value = p.cb;  document.getElementById('cy-vcb').value = (+p.cb).toFixed(1);
  _cylSegs = p.segs || 6; _cylMode_val = p.mode || 'bevel'; _cylN_val = p.N || 32;
  document.getElementById('cy-vs').textContent = _cylSegs;
  document.getElementById('cy-vn').textContent = _cylN_val;
  document.getElementById('cy-mbevel').classList.toggle('active', _cylMode_val==='bevel');
  document.getElementById('cy-mround').classList.toggle('active', _cylMode_val==='round');
  document.querySelectorAll('#cy-segbtns .vb-btn').forEach(b=>b.classList.toggle('active', +b.textContent===_cylSegs));
  document.querySelectorAll('#cylind-modal .vb-win .vb-btn[onclick^="_cylN"]').forEach(b=>{
    b.classList.toggle('active', +b.textContent===_cylN_val);
  });
  _genDialogMode('cylind-modal', editMode, '⌾ Truncated Cylinder · Double Chamfer', 'cylind-apply-btn');
  _cylRebuild();
  const _cel = document.getElementById('cylind-modal');
  _cel.style.left = Math.max(196, innerWidth - 345 - 332) + 'px';
  _cel.style.top  = Math.max(34,  innerHeight - 510 - 32) + 'px';
  _cel.classList.add('open');
}

function hideCylindDialog(cancel){
  _previewDispose();
  if(cancel) _genEditCancel(); else _genEditApply();
  document.getElementById('cylind-modal').classList.remove('open');
}

function _cylMode(m){
  _cylMode_val = m;
  document.getElementById('cy-mbevel').classList.toggle('active', m==='bevel');
  document.getElementById('cy-mround').classList.toggle('active', m==='round');
  _cylRebuild();
}

function _cylSeg(v){
  _cylSegs = v;
  document.getElementById('cy-vs').textContent = v;
  document.querySelectorAll('#cy-segbtns .vb-btn').forEach(b=>b.classList.remove('active'));
  [...document.querySelectorAll('#cy-segbtns .vb-btn')].find(b=>+b.textContent===v)?.classList.add('active');
  _cylRebuild();
}

function _cylN(v){
  _cylN_val = v;
  document.getElementById('cy-vn').textContent = v;
  document.querySelectorAll('#cylind-modal .vb-win .vb-btn[onclick^="_cylN"]').forEach(b=>{
    b.classList.toggle('active', +b.textContent===v);
  });
  _cylRebuild();
}

function _cylClamp(slId, dispId, Rend, halfH){
  const max = Math.min(Rend, halfH) * 0.9999;
  const sl  = document.getElementById(slId);
  if(+sl.max < max || +sl.max > max) sl.max = max.toFixed(1);
  if(+sl.value > max){ sl.value = max.toFixed(1); document.getElementById(dispId).textContent = max.toFixed(1); }
  return +sl.value;
}

function _cylRebuild(){
  const H  = +document.getElementById('cy-sh').value;
  const Rt = +document.getElementById('cy-srt').value;
  const Rb = +document.getElementById('cy-srb').value;
  const ct = _cylClamp('cy-sct','cy-vct', Rt, H/2);
  const cb = _cylClamp('cy-scb','cy-vcb', Rb, H/2);
  const mesh = _ccBuildFrustum(Rt, Rb, H, ct, cb, _cylN_val, _cylSegs, _cylMode_val);
  const triCount = mesh.tris.length/3;
  const vtxCount = mesh.vPos.length/3;
  const vol = (Math.PI/3)*H*(Rt**2+Rt*Rb+Rb**2)/1000;
  document.getElementById('cy-stats').textContent =
    `▲ ${triCount.toLocaleString('fr-FR')} triangles · ◎ ${vtxCount.toLocaleString('fr-FR')} sommets · Vol ≈ ${vol.toFixed(1)} cm³`;
  _genLiveUpdate(mesh);
}

function _cylindToScene(){
  const H  = +document.getElementById('cy-sh').value;
  const Rt = +document.getElementById('cy-srt').value;
  const Rb = +document.getElementById('cy-srb').value;
  const ct = _cylClamp('cy-sct','cy-vct', Rt, H/2);
  const cb = _cylClamp('cy-scb','cy-vcb', Rb, H/2);

  if(!_numsOK(H,Rt,Rb,ct,cb) || H<=0 || (Rt<=0 && Rb<=0)){
    nasLog('ERROR','Cylind.Gen : valeurs invalides (H='+H+', Rt='+Rt+', Rb='+Rb+')');
    _nasAlert('⚠ Cylind.Gen : vérifie les champs numériques (valeur vide, non numérique ou hors plage).');
    return;
  }

  // ── MODE ÉDITION : géo déjà live-updatée par _genLiveUpdate → finaliser seulement ──
  if(_genEditObj){
    _genEditObj.genParams = {H,Rt,Rb,ct,cb,segs:_cylSegs,mode:_cylMode_val,N:_cylN_val};
    nasLog('OK','Cylind.Gen edited: '+_genEditObj.name);
    _csgLog && _csgLog('✏ Cylind.Gen edited → '+_genEditObj.name);
    hideCylindDialog(false);
    return;
  }

  // ── MODE CRÉATION ──
  showSpinner('Cylind.Gen', `Rt${Rt}·Rb${Rb}·H${H}`);
  try {
    const {vPos, tris} = _ccBuildFrustum(Rt, Rb, H, ct, cb, _cylN_val, _cylSegs, _cylMode_val);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(vPos), 3));
    geo.setIndex(tris);
    geo.computeVertexNormals();
    geo.computeBoundingBox();

    // [REFACTOR V4.7.1] cf. tore-gen.js — bloc mutualisé dans _finalizeGenToScene (htm).
    const modeName = _cylMode_val==='bevel' ? 'bvl' : 'rnd';
    _finalizeGenToScene({
      label: 'Cylind.Gen', geo,
      name: (n) => `cylind_${modeName}_Rt${Rt}_Rb${Rb}_H${H}_${n}`,
      genType: 'cylind', genParams: {H,Rt,Rb,ct,cb,segs:_cylSegs,mode:_cylMode_val,N:_cylN_val},
      hideDialogFn: () => hideCylindDialog(false)
    });
  } catch(err) {
    hideSpinner();
    nasLog('ERROR', 'Cylind.Gen : ' + err.message);
    _nasAlert('⚠ Cylind.Gen : ' + err.message);
  }
}

// ── Algorithme buildFrustum (Cylind.Gen) — watertight manifold ───────────
function _ccBuildFrustum(Rt, Rb, H, ct, cb, N, S, mode) {
  const hh = H / 2;
  const arcSteps = (mode === 'round') ? Math.max(1, Math.round(S)) : 1;

  const PREC = 1e5;
  const pool = new Map();
  const vPos = [];

  function V(x,y,z){
    const ix=Math.round(x*PREC),iy=Math.round(y*PREC),iz=Math.round(z*PREC);
    const k=`${ix}|${iy}|${iz}`;
    let i=pool.get(k);
    if(i===undefined){i=vPos.length/3;vPos.push(ix/PREC,iy/PREC,iz/PREC);pool.set(k,i);}
    return i;
  }
  const tris=[];
  function emitQ(a,b,c,d){tris.push(a,b,c,a,c,d);}
  function emitT(a,b,c){tris.push(a,b,c);}

  function chamferPt(theta,t,sy,R,c){
    const nA=[Math.cos(theta),0,Math.sin(theta)];
    const nB=[0,sy,0];
    const n=(mode==='round')?_slerp3(nA,nB,t):(t<0.5?nA:nB);
    return[(R-c)*Math.cos(theta)+c*n[0], sy*(hh-c)+c*n[1], (R-c)*Math.sin(theta)+c*n[2]];
  }

  const yTop= hh-ct;
  const yBot=-hh+cb;

  // 1. Lateral frustum
  for(let i=0;i<N;i++){
    const th0=(i/N)*2*Math.PI, th1=((i+1)/N)*2*Math.PI;
    const P00=V(Rb*Math.cos(th0),yBot,Rb*Math.sin(th0));
    const P01=V(Rt*Math.cos(th0),yTop,Rt*Math.sin(th0));
    const P11=V(Rt*Math.cos(th1),yTop,Rt*Math.sin(th1));
    const P10=V(Rb*Math.cos(th1),yBot,Rb*Math.sin(th1));
    emitQ(P00,P01,P11,P10);
  }

  // Top
  if(ct<1e-9){
    const ctr=V(0,hh,0);
    for(let i=0;i<N;i++){
      const th0=(i/N)*2*Math.PI,th1=((i+1)/N)*2*Math.PI;
      emitT(ctr,V(Rt*Math.cos(th1),hh,Rt*Math.sin(th1)),V(Rt*Math.cos(th0),hh,Rt*Math.sin(th0)));
    }
  } else {
    for(let i=0;i<N;i++){
      const th0=(i/N)*2*Math.PI,th1=((i+1)/N)*2*Math.PI;
      for(let j=0;j<arcSteps;j++){
        const t0=j/arcSteps,t1=(j+1)/arcSteps;
        const P00=V(...chamferPt(th0,t0,+1,Rt,ct));
        const P01=V(...chamferPt(th0,t1,+1,Rt,ct));
        const P10=V(...chamferPt(th1,t0,+1,Rt,ct));
        const P11=V(...chamferPt(th1,t1,+1,Rt,ct));
        emitQ(P00,P01,P11,P10);
      }
    }
    const ctr=V(0,hh,0);
    for(let i=0;i<N;i++){
      const th0=(i/N)*2*Math.PI,th1=((i+1)/N)*2*Math.PI;
      emitT(ctr,V((Rt-ct)*Math.cos(th1),hh,(Rt-ct)*Math.sin(th1)),
                V((Rt-ct)*Math.cos(th0),hh,(Rt-ct)*Math.sin(th0)));
    }
  }

  // Bottom
  if(cb<1e-9){
    const ctr=V(0,-hh,0);
    for(let i=0;i<N;i++){
      const th0=(i/N)*2*Math.PI,th1=((i+1)/N)*2*Math.PI;
      emitT(ctr,V(Rb*Math.cos(th0),-hh,Rb*Math.sin(th0)),V(Rb*Math.cos(th1),-hh,Rb*Math.sin(th1)));
    }
  } else {
    for(let i=0;i<N;i++){
      const th0=(i/N)*2*Math.PI,th1=((i+1)/N)*2*Math.PI;
      for(let j=0;j<arcSteps;j++){
        const t0=j/arcSteps,t1=(j+1)/arcSteps;
        const P00=V(...chamferPt(th0,t0,-1,Rb,cb));
        const P01=V(...chamferPt(th0,t1,-1,Rb,cb));
        const P10=V(...chamferPt(th1,t0,-1,Rb,cb));
        const P11=V(...chamferPt(th1,t1,-1,Rb,cb));
        emitQ(P00,P10,P11,P01); // reversed winding
      }
    }
    const ctr=V(0,-hh,0);
    for(let i=0;i<N;i++){
      const th0=(i/N)*2*Math.PI,th1=((i+1)/N)*2*Math.PI;
      emitT(ctr,V((Rb-cb)*Math.cos(th0),-hh,(Rb-cb)*Math.sin(th0)),
                V((Rb-cb)*Math.cos(th1),-hh,(Rb-cb)*Math.sin(th1)));
    }
  }

  return {vPos:new Float32Array(vPos), tris};
}

// (backdrop-click supprimé — dialog devient fenêtre flottante draggable)

// ══════════════════════════════════════════════════════════════════════════
// tore-gen.js — module Tore.Gen extrait du host NASSCAD
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, selObjs, objCnt, COL, PS, isHoleMode           — scene state
//   THREE                                                        — Three.js global
//   undoPush, updProps, updOList, updStats, nasLog, _nasAlert    — app-wide helpers
//   _findFreePos, _csgLog                                        — placement/log helpers
//   showSpinner, hideSpinner                                     — loading UI
//   _genEditBegin, _genEditApply, _genEditCancel, _genEditObj,
//   _genDialogMode, _genLiveUpdate, _previewDispose                — generic "Gen Edit Mode" infra
//                                                                    (lives elsewhere in the host file,
//                                                                    shared by every primitive dialog)
// ══════════════════════════════════════════════════════════════════════════
// ── TORE.GEN — Tore Ultra-HD intégré ─────────────────────────────────────
// Algorithme watertight manifold — NassLab 2026 (CC BY-NC 4.0)
// Topologie torique périodique : pas de couture, maillage fermé garanti.
// ─────────────────────────────────────────────────────────────────────────

function showToreDialog(obj){
  const editMode = !!obj;
  if(editMode) _genEditBegin(obj);
  else _genEditObj = null;

  const p = editMode && obj.genParams ? obj.genParams : {R:34,r:5.3,N:64,M:32};
  document.getElementById('tore-sr').value = p.R;
  document.getElementById('tore-st').value = p.r;
  document.getElementById('tore-sn').value = p.N;
  document.getElementById('tore-sm').value = p.M;
  document.getElementById('tore-vr').value = (+p.R).toFixed(1);
  document.getElementById('tore-vt').value = (+p.r).toFixed(1);
  document.getElementById('tore-vn').value = p.N;
  document.getElementById('tore-vm').value = p.M;
  _genDialogMode('tore-modal', editMode, '◎ Torus Ultra-HD', 'tore-apply-btn');
  _toreRebuild();
  const _tel = document.getElementById('tore-modal');
  _tel.style.left = Math.max(196, innerWidth - 355 - 332) + 'px';
  _tel.style.top  = Math.max(34,  innerHeight - 310 - 32) + 'px';
  _tel.classList.add('open');
}

function hideToreDialog(cancel){
  _previewDispose();
  if(cancel) _genEditCancel(); else _genEditApply();
  document.getElementById('tore-modal').classList.remove('open');
}

function _toreRebuild(){
  const R = +document.getElementById('tore-sr').value;
  let   r = +document.getElementById('tore-st').value;
  const N = +document.getElementById('tore-sn').value;
  const M = +document.getElementById('tore-sm').value;
  if(r >= R){
    const rClamped = (R * 0.9999).toFixed(1);
    document.getElementById('tore-st').value = rClamped;
    document.getElementById('tore-vt').value = rClamped;
    r = +rClamped;
  }
  const triCount = N * M * 2;
  const vtxCount = N * M;
  const vol = (2 * Math.PI * Math.PI * R * r * r / 1000).toFixed(1);
  document.getElementById('tore-stats').textContent =
    '\u25b2 ' + triCount.toLocaleString('fr-FR') + ' triangles \u00b7 \u25ce ' + vtxCount.toLocaleString('fr-FR') + ' sommets \u00b7 Vol \u2248 ' + vol + ' cm\u00b3';
  _genLiveUpdate(_toreBuild(R, r, N, M));
}

function _toreToScene(){
  const R = +document.getElementById('tore-sr').value;
  let   r = +document.getElementById('tore-st').value;
  const N = +document.getElementById('tore-sn').value;
  const M = +document.getElementById('tore-sm').value;
  if(r >= R) r = R * 0.9999;

  if(!_numsOK(R,r,N,M) || R<=0 || r<=0 || N<3 || M<3){
    nasLog('ERROR','Tore.Gen : valeurs invalides (R='+R+', r='+r+', N='+N+', M='+M+')');
    _nasAlert('⚠ Tore.Gen : vérifie les champs numériques (valeur vide, non numérique ou hors plage).');
    return;
  }

  // ── MODE ÉDITION : géo déjà live-updatée par _genLiveUpdate → finaliser seulement ──
  if(_genEditObj){
    _genEditObj.genParams = {R,r,N,M};
    nasLog('OK','Tore.Gen edited: '+_genEditObj.name);
    _csgLog && _csgLog('✏ Tore.Gen edited → '+_genEditObj.name);
    hideToreDialog(false);
    return;
  }

  // ── MODE CRÉATION ──
  showSpinner('Tore.Gen', 'R'+R+'.r'+r.toFixed(1)+'.N'+N+'.M'+M);
  try {
    const {vPos, tris} = _toreBuild(R, r, N, M);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(vPos), 3));
    geo.setIndex(tris);
    geo.computeVertexNormals();
    geo.computeBoundingBox();

    // [REFACTOR V4.7.1] Bloc undoPush\u2192placement\u2192objs.push\u2192logs\u2192hideDialog
    // mutualis\u00e9 dans _finalizeGenToScene (htm, cf. commentaire l\u00e0-bas) \u2014 9
    // g\u00e9n\u00e9rateurs copiaient ce m\u00eame bloc quasi \u00e0 l'identique.
    _finalizeGenToScene({
      label: 'Tore.Gen', geo,
      name: (n) => 'tore_R'+R+'_r'+r.toFixed(1)+'_N'+N+'_M'+M+'_'+n,
      genType: 'tore', genParams: {R,r,N,M},
      hideDialogFn: () => hideToreDialog(false)
    });
  } catch(err) {
    hideSpinner();
    nasLog('ERROR', 'Tore.Gen : ' + err.message);
    _nasAlert('⚠ Tore.Gen : ' + err.message);
  }
}

// ── _toreBuild — watertight manifold ─────────────────────────────────────
// Topologie périodique i∈[0,N), j∈[0,M) — tous les quads partagent leurs arêtes
// → surface fermée, 0 bord, Euler = 0 → Manifold OK pour Manifold WASM
// Axe Y haut : tore couché dans le plan XZ
function _toreBuild(R, r, N, M){
  const TWO_PI = 2 * Math.PI;
  const PREC   = 1e5;
  const pool   = new Map();
  const vPos   = [];

  function V(x, y, z){
    const ix = Math.round(x * PREC);
    const iy = Math.round(y * PREC);
    const iz = Math.round(z * PREC);
    const k  = ix + '|' + iy + '|' + iz;
    let   vi = pool.get(k);
    if(vi === undefined){
      vi = vPos.length / 3;
      vPos.push(ix / PREC, iy / PREC, iz / PREC);
      pool.set(k, vi);
    }
    return vi;
  }

  // Précalcul angles
  const cosT = new Float64Array(N);
  const sinT = new Float64Array(N);
  const cosP = new Float64Array(M);
  const sinP = new Float64Array(M);
  for(let i = 0; i < N; i++){ const a=(TWO_PI*i)/N; cosT[i]=Math.cos(a); sinT[i]=Math.sin(a); }
  for(let j = 0; j < M; j++){ const a=(TWO_PI*j)/M; cosP[j]=Math.cos(a); sinP[j]=Math.sin(a); }

  // Grille d'indices
  const gi = new Int32Array(N * M);
  for(let i = 0; i < N; i++){
    for(let j = 0; j < M; j++){
      const rho = R + r * cosP[j];
      gi[i * M + j] = V(rho * cosT[i], r * sinP[j], rho * sinT[i]);
    }
  }

  // Triangulation quads → triangles (CCW extérieur)
  const tris = [];
  for(let i = 0; i < N; i++){
    const i1 = (i + 1) % N;
    for(let j = 0; j < M; j++){
      const j1 = (j + 1) % M;
      const a  = gi[ i * M + j ];
      const b  = gi[i1 * M + j ];
      const c  = gi[i1 * M + j1];
      const d  = gi[ i * M + j1];
      // FIX winding : (a,b,c) donne normales entrantes car (b-a)×(c-a) pointe vers l'intérieur
      // du tore. Inversion → (a,c,b) + (a,d,c) = normales sortantes CCW pour Manifold WASM
      tris.push(a, c, b,  a, d, c);
    }
  }
  return { vPos, tris };
}
// ── Fin Tore.Gen ──────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════
// pipe-gen.js — module Pipe.Gen extrait du host NASSCAD
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, selObjs, objCnt, COL, PS, isHoleMode           — scene state
//   THREE                                                        — Three.js global
//   undoPush, updProps, updOList, updStats, nasLog, _nasAlert    — app-wide helpers
//   _findFreePos, _csgLog                                        — placement/log helpers
//   showSpinner, hideSpinner                                     — loading UI
//   _genEditBegin, _genEditApply, _genEditCancel, _genEditObj,
//   _genDialogMode, _genLiveUpdate, _previewDispose                — generic "Gen Edit Mode" infra
//                                                                    (lives elsewhere in the host file,
//                                                                    shared by every primitive dialog)
// ══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// PIPE.GEN — Tuyau creux CatmullRom watertight — NassLab 2026 (CC BY-NC 4.0)
// Algo Pipe_Gen préservé intégralement : Shape+hole extrudée sur CatmullRomCurve3
// toNonIndexed() appliqué avant insertion → Manifold WASM compatible
// ═══════════════════════════════════════════════════════════════════════════

function showPipeDialog(obj){
  const editMode = !!obj;
  if(editMode) _genEditBegin(obj);
  else _genEditObj = null;

  const defs = editMode && obj.genParams ? {
    're':obj.genParams.re,'ep':obj.genParams.ep,'rb':obj.genParams.rb,
    'sc':obj.genParams.sc,'sr':obj.genParams.sr,
    'l1':obj.genParams.l1,'v1y':obj.genParams.v1y,'v1z':obj.genParams.v1z,
    'l2':obj.genParams.l2,'v2y':obj.genParams.v2y,'v2z':obj.genParams.v2z,
    'l3':obj.genParams.l3
  } : {'re':5,'ep':1.2,'rb':12,'sc':40,'sr':16,'l1':30,'v1y':90,'v1z':0,'l2':20,'v2y':0,'v2z':45,'l3':30};

  for(const [k,v] of Object.entries(defs)){
    const el = document.getElementById('pipe-'+k);
    if(el) el.value = v;
  }
  document.getElementById('pipe-vre').value  = (+defs.re).toFixed(1);
  document.getElementById('pipe-vep').value  = (+defs.ep).toFixed(1);
  document.getElementById('pipe-vrb').value  = (+defs.rb).toFixed(1);
  document.getElementById('pipe-vsc').value  = defs.sc;
  document.getElementById('pipe-vsr').value  = defs.sr;
  document.getElementById('pipe-vl1').value  = defs.l1;
  document.getElementById('pipe-vv1y').value = defs.v1y;
  document.getElementById('pipe-vv1z').value = defs.v1z;
  document.getElementById('pipe-vl2').value  = defs.l2;
  document.getElementById('pipe-vv2y').value = defs.v2y;
  document.getElementById('pipe-vv2z').value = defs.v2z;
  document.getElementById('pipe-vl3').value  = defs.l3;
  _genDialogMode('pipe-modal', editMode, '⌁ Pipe.Gen', 'pipe-apply-btn');
  _pipeRebuild();
  const el = document.getElementById('pipe-modal');
  el.style.left = Math.max(196, innerWidth - 365 - 332) + 'px';
  el.style.top  = Math.max(34,  innerHeight - 490 - 32) + 'px';
  el.classList.add('open');
}

function hidePipeDialog(cancel){
  _previewDispose();
  if(cancel) _genEditCancel(); else _genEditApply();
  document.getElementById('pipe-modal').classList.remove('open');
}

function _getPipeParams(){
  return {
    rayonExterieur:   +document.getElementById('pipe-re').value,
    epaisseurMur:     +document.getElementById('pipe-ep').value,
    rayonCintrage:    +document.getElementById('pipe-rb').value,
    resolutionCurve:  +document.getElementById('pipe-sc').value,
    resolutionRadial: +document.getElementById('pipe-sr').value,
    longueur1:        +document.getElementById('pipe-l1').value,
    angleVirage1Y:    +document.getElementById('pipe-v1y').value,
    angleVirage1Z:    +document.getElementById('pipe-v1z').value,
    longueur2:        +document.getElementById('pipe-l2').value,
    angleVirage2Y:    +document.getElementById('pipe-v2y').value,
    angleVirage2Z:    +document.getElementById('pipe-v2z').value,
    longueur3:        +document.getElementById('pipe-l3').value
  };
}

// ── _pipeBuild — Bishop frame + arcs circulaires tangents — Gemini/NassLab 2026
// Segments droits + arcs circulaires de rayon R_bend aux coudes (cintreuse réelle).
// Repère de Bishop (parallel transport) : zéro vrillage de la section le long du chemin.
// Caps bouchés aux deux extrémités → watertight manifold.
// Retourne {vPos, tris} — même contrat que _toreBuild.
function _pipeBuild(p){
  const R_ext  = p.rayonExterieur;
  const t_wall = Math.min(p.epaisseurMur, R_ext - 0.1);
  const R_int  = R_ext - t_wall;
  const R_bend = Math.max(R_ext + 0.1, p.rayonCintrage);
  const resA   = Math.max(4,  Math.floor(p.resolutionCurve));
  const nR     = Math.max(6,  Math.floor(p.resolutionRadial));

  // ── 1. Chemin : segments droits + arcs circulaires tangents ──────────────
  const pts = [new THREE.Vector3(0,0,0)];
  let curPos = new THREE.Vector3(0,0,0);
  let curDir = new THREE.Vector3(1,0,0);

  const addSegmentAndBend = (L, ay, az) => {
    const end = curPos.clone().add(curDir.clone().multiplyScalar(L));
    pts.push(end.clone());
    curPos.copy(end);
    const m = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(0, THREE.MathUtils.degToRad(ay), THREE.MathUtils.degToRad(az), 'YXZ')
    );
    const nextDir = curDir.clone().applyMatrix4(m).normalize();
    const axis = new THREE.Vector3().crossVectors(curDir, nextDir);
    if(axis.length() > 0.001){
      axis.normalize();
      const angle = Math.acos(Math.min(1, Math.max(-1, curDir.dot(nextDir))));
      for(let i = 1; i <= resA; i++){
        const ratio = i / resA;
        const stepDir = curDir.clone().applyAxisAngle(axis, ratio * angle);
        curPos.add(stepDir.clone().multiplyScalar((angle * R_bend) / resA));
        pts.push(curPos.clone());
      }
      curDir.copy(nextDir);
    }
  };

  addSegmentAndBend(p.longueur1, p.angleVirage1Y, p.angleVirage1Z);
  addSegmentAndBend(p.longueur2, p.angleVirage2Y, p.angleVirage2Z);
  pts.push(curPos.clone().add(curDir.clone().multiplyScalar(p.longueur3)));

  // ── 2. Repères de Bishop (parallel transport) — zéro vrillage ────────────
  const frames = [];
  let T = new THREE.Vector3().subVectors(pts[1], pts[0]).normalize();
  const initVec = Math.abs(T.y) < 0.9 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0);
  let N = new THREE.Vector3().crossVectors(T, initVec).normalize();
  let B = new THREE.Vector3().crossVectors(T, N).normalize();
  frames.push({t:T.clone(), n:N.clone(), b:B.clone()});

  for(let i = 1; i < pts.length; i++){
    const T0 = frames[i-1].t;
    const T1 = (i < pts.length-1)
      ? new THREE.Vector3().subVectors(pts[i+1], pts[i]).normalize()
      : T0.clone();
    const ax2 = new THREE.Vector3().crossVectors(T0, T1);
    if(ax2.length() > 0.0001){
      ax2.normalize();
      N.applyAxisAngle(ax2, Math.acos(Math.min(1, Math.max(-1, T0.dot(T1)))));
    }
    B.crossVectors(T1, N).normalize();
    frames.push({t:T1.clone(), n:N.clone(), b:B.clone()});
  }

  // ── 3. Sommets — paroi ext + paroi int ────────────────────────────────────
  const vertices = [];
  const indices  = [];

  pts.forEach((pt, i) => {
    const f = frames[i];
    for(let j = 0; j < nR; j++){
      const a = (j/nR)*Math.PI*2, c = Math.cos(a), s = Math.sin(a);
      vertices.push(
        pt.x + f.n.x*c*R_ext + f.b.x*s*R_ext,
        pt.y + f.n.y*c*R_ext + f.b.y*s*R_ext,
        pt.z + f.n.z*c*R_ext + f.b.z*s*R_ext
      );
    }
    for(let j = 0; j < nR; j++){
      const a = (j/nR)*Math.PI*2, c = Math.cos(a), s = Math.sin(a);
      vertices.push(
        pt.x + f.n.x*c*R_int + f.b.x*s*R_int,
        pt.y + f.n.y*c*R_int + f.b.y*s*R_int,
        pt.z + f.n.z*c*R_int + f.b.z*s*R_int
      );
    }
  });

  // ── 4. Quads parois + caps ────────────────────────────────────────────────
  const stride = nR * 2;
  for(let i = 0; i < pts.length-1; i++){
    const curr = i*stride, next = (i+1)*stride;
    for(let j = 0; j < nR; j++){
      const nj = (j+1)%nR;
      indices.push(curr+j, next+j, next+nj,   curr+j, next+nj, curr+nj);       // ext CCW
      indices.push(curr+nR+j, next+nR+nj, next+nR+j,  curr+nR+j, curr+nR+nj, next+nR+nj); // int
    }
  }
  const buildCap = (ptIdx, isStart) => {
    const off = ptIdx * stride;
    for(let j = 0; j < nR; j++){
      const nj = (j+1)%nR;
      if(isStart) indices.push(off+j, off+nR+nj, off+nR+j,   off+j, off+nj, off+nR+nj);
      else        indices.push(off+j, off+nR+j,  off+nR+nj,  off+j, off+nR+nj, off+nj);
    }
  };
  buildCap(0, true);
  buildCap(pts.length-1, false);

  return { vPos: Array.from(vertices), tris: Array.from(indices) };
}

function _pipeRebuild(){
  const p = _getPipeParams();
  try{
    const {vPos, tris} = _pipeBuild(p);
    const triCount = tris.length / 3;
    const vtxCount = vPos.length / 3;
    document.getElementById('pipe-stats').textContent =
      '\u25b2 '+triCount.toLocaleString('fr-FR')+' tri \u00b7 \u25ce '+vtxCount.toLocaleString('fr-FR')+' vtx \u00b7 \u00d8ext '+(p.rayonExterieur*2)+' mm';
    _genLiveUpdate({vPos, tris});
  } catch(err){
    document.getElementById('pipe-stats').textContent = '\u26a0 '+err.message;
  }
}

function _pipeToScene(){
  const p = _getPipeParams();
  const tag = 'pipe_Re'+p.rayonExterieur+'_e'+p.epaisseurMur+'_L'+p.longueur1+'+'+p.longueur2+'+'+p.longueur3;

  if(!_numsOK(...Object.values(p)) || p.rayonExterieur<=0 || p.epaisseurMur<=0){
    nasLog('ERROR','Pipe.Gen : valeurs invalides');
    _nasAlert('⚠ Pipe.Gen : vérifie les champs numériques (valeur vide, non numérique ou hors plage).');
    return;
  }

  // ── MODE ÉDITION : géo déjà live-updatée par _genLiveUpdate → finaliser seulement ──
  if(_genEditObj){
    _genEditObj.genParams = {re:p.rayonExterieur,ep:p.epaisseurMur,rb:p.rayonCintrage,
      sc:p.resolutionCurve,sr:p.resolutionRadial,
      l1:p.longueur1,v1y:p.angleVirage1Y,v1z:p.angleVirage1Z,
      l2:p.longueur2,v2y:p.angleVirage2Y,v2z:p.angleVirage2Z,l3:p.longueur3};
    nasLog('OK','Pipe.Gen edited: '+_genEditObj.name);
    _csgLog && _csgLog('✏ Pipe.Gen edited → '+_genEditObj.name);
    hidePipeDialog(false);
    return;
  }

  // ── MODE CRÉATION ──
  showSpinner('Pipe.Gen', tag);
  try{
    const {vPos, tris} = _pipeBuild(p);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(vPos), 3));
    geo.setIndex(tris);
    geo.computeVertexNormals();
    geo.computeBoundingBox();

    // [REFACTOR V4.7.1] cf. tore-gen.js \u2014 bloc mutualis\u00e9 dans _finalizeGenToScene (htm).
    const _pp = _getPipeParams();
    _finalizeGenToScene({
      label: 'Pipe.Gen', geo,
      name: (n) => tag+'_'+n,
      genType: 'pipe', genParams: {re:_pp.rayonExterieur,ep:_pp.epaisseurMur,rb:_pp.rayonCintrage,
        sc:_pp.resolutionCurve,sr:_pp.resolutionRadial,
        l1:_pp.longueur1,v1y:_pp.angleVirage1Y,v1z:_pp.angleVirage1Z,
        l2:_pp.longueur2,v2y:_pp.angleVirage2Y,v2z:_pp.angleVirage2Z,l3:_pp.longueur3},
      hideDialogFn: () => hidePipeDialog(false)
    });
  } catch(err){
    hideSpinner();
    nasLog('ERROR','Pipe.Gen : '+err.message);
    _nasAlert('\u26a0 Pipe.Gen : '+err.message);
  }
}
// ── Fin Pipe.Gen ──────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════
// gear-gen.js — module Gear.Gen extrait du host NASSCAD
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
//   [01/09] +3 pour le mode Pair : _numsOK, _invalidateBbox, _finalizeGenToScene
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, selObjs, objCnt, COL, PS, isHoleMode           — scene state
//   THREE                                                        — Three.js global
//   undoPush, updProps, updOList, updStats, nasLog, _nasAlert    — app-wide helpers
//   _findFreePos, _csgLog                                        — placement/log helpers
//   showSpinner, hideSpinner                                     — loading UI
//   _genEditBegin, _genEditApply, _genEditCancel, _genEditObj,
//   _genDialogMode, _genLiveUpdate, _previewDispose                — generic "Gen Edit Mode" infra
//                                                                    (lives elsewhere in the host file,
//                                                                    shared by every primitive dialog)
// ══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// GEAR.GEN — Engrenages involute ISO + Poulies watertight — NassLab 2026
// Engrenage : développante de cercle (ISO 53, α=20°), module standard
//   ra=rp+m, rf=rp-1.25m, rb=rp·cos(α) — droit/hélicoïdal/chevrons
// Poulie V   : lathe manuel + caps annulaires → watertight garanti
// Poulie T   : ExtrudeGeometry crantée → toNonIndexed
// Brique Gemini corrigée (profil triangulaire → involute, LatheGeo → caps)
// ═══════════════════════════════════════════════════════════════════════════

let _gearMode   = 'gear';
let _gearModVal = 2; // module courant (mm)
const _GEAR_MODS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
// [01/09] Rapports rapides du mode Pair. Ce ne sont que des raccourcis de
// saisie : le parametre reel reste z2 (entier), le rapport en est deduit.
const _GEAR_RATIOS = [1, 1.5, 2, 2.5, 3, 4, 5];

function showGearDialog(obj){
  const editMode = !!obj;
  if(editMode) _genEditBegin(obj);
  else _genEditObj = null;

  // Créer les boutons de module si pas encore fait
  const row = document.getElementById('gear-modbtn-row');
  if(!row.children.length){
    _GEAR_MODS.forEach(m => {
      const b = document.createElement('button');
      b.className = 'vb-btn';
      b.textContent = m;
      b.style.cssText = 'font-size:11px;padding:2px 6px;min-width:32px;';
      b.onclick = () => { _gearModVal = m; _gearModBtnActive(); _gearRebuild(); };
      row.appendChild(b);
    });
  }
  _gearRatioBtns();
  const p = editMode && obj.genParams ? obj.genParams : null;
  if(p){
    _gearModVal = p.gearModule || 2;
    _gearModeSwitch(p.gearMode || 'gear');
    document.getElementById('gear-gtype').value = p.gearType || 'spur';
    document.getElementById('gear-teeth').value = p.gearTeeth || 24;
    document.getElementById('gear-vteeth').value = p.gearTeeth || 24;
    document.getElementById('gear-h').value = p.gearHeight || 20;
    document.getElementById('gear-vh').value = p.gearHeight || 20;
    document.getElementById('gear-hr').value = p.gearHoleR || 6;
    document.getElementById('gear-vhr').value = (+( p.gearHoleR||6)).toFixed(1);
    document.getElementById('gear-tw').value = p.gearTwist || 20;
    document.getElementById('gear-vtw').value = p.gearTwist || 20;
    document.getElementById('gear-res').value = p.gearRes || 96;
    document.getElementById('gear-vres').value = p.gearRes || 96;
    document.getElementById('gear-bl').value  = p.gearBacklash || 0;
    document.getElementById('gear-vbl').value = (+(p.gearBacklash || 0)).toFixed(2);
    // Le mode Pair fabrique DEUX objets : il n'a pas de sens en edition, ou
    // l'on ne modifie que l'objet deja selectionne. Toujours decoche ici.
    document.getElementById('gear-pair').checked = false;
    document.getElementById('gear-z2').value  = p.gearTeeth2 || (p.gearTeeth || 24) * 2;
    document.getElementById('gear-vz2').value = p.gearTeeth2 || (p.gearTeeth || 24) * 2;
    if(p.gearMode==='pulley'){
      document.getElementById('gear-pty').value = p.pulleyType || 'v';
      document.getElementById('gear-pdext').value = (p.pulleyDExtR||40)*2;
      document.getElementById('gear-vpdext').value = (p.pulleyDExtR||40)*2;
      document.getElementById('gear-ph').value = p.pulleyH || 20;
      document.getElementById('gear-vph').value = p.pulleyH || 20;
      document.getElementById('gear-phr').value = p.pulleyHoleR || 8;
      document.getElementById('gear-vphr').value = (+( p.pulleyHoleR||8)).toFixed(1);
      if(p.pulleyType==='v'){
        document.getElementById('gear-gd').value = p.grooveDepth || 8;
        document.getElementById('gear-vgd').value = (+( p.grooveDepth||8)).toFixed(1);
        document.getElementById('gear-gw').value = p.grooveWidth || 12;
        document.getElementById('gear-vgw').value = (+( p.grooveWidth||12)).toFixed(1);
      }
      _gearPulleyRow();
    }
    _gearTwistRow();
  } else {
    _gearModeSwitch('gear');
    document.getElementById('gear-teeth').value = 24;
    document.getElementById('gear-vteeth').value = '24';
    document.getElementById('gear-h').value = 20;
    document.getElementById('gear-vh').value = '20';
    document.getElementById('gear-hr').value = 6;
    document.getElementById('gear-vhr').value = '6.0';
    document.getElementById('gear-tw').value = 20;
    document.getElementById('gear-vtw').value = '20';
    document.getElementById('gear-res').value = 96;
    document.getElementById('gear-vres').value = '96';
    document.getElementById('gear-bl').value = 0;
    document.getElementById('gear-vbl').value = '0.00';
    document.getElementById('gear-pair').checked = false;
    document.getElementById('gear-z2').value = 48;
    document.getElementById('gear-vz2').value = '48';
  }
  _gearPairRow(editMode);
  _gearModBtnActive();
  _genDialogMode('gear-modal', editMode, '⚙ Gear.Gen / Pulley.Gen', 'gear-apply-btn');
  _gearRebuild();
  const el = document.getElementById('gear-modal');
  el.style.left = Math.max(196, innerWidth - 380 - 332) + 'px';
  el.style.top  = Math.max(34,  innerHeight - 580 - 32) + 'px';
  el.classList.add('open');
}

function hideGearDialog(cancel){
  _previewDispose();
  if(cancel) _genEditCancel(); else _genEditApply();
  document.getElementById('gear-modal').classList.remove('open');
}

function _gearModBtnActive(){
  const row = document.getElementById('gear-modbtn-row');
  Array.from(row.children).forEach((b, i) => {
    b.style.color = _GEAR_MODS[i] === _gearModVal ? 'var(--success)' : '';
    b.style.fontWeight = _GEAR_MODS[i] === _gearModVal ? '700' : '';
  });
}

function _gearModeSwitch(mode){
  _gearMode = mode;
  document.getElementById('gear-sec-gear').style.display   = mode === 'gear'   ? '' : 'none';
  document.getElementById('gear-sec-pulley').style.display = mode === 'pulley' ? '' : 'none';
  document.getElementById('gear-btn-gear').style.color   = mode === 'gear'   ? 'var(--success)' : '';
  document.getElementById('gear-btn-gear').style.fontWeight   = mode === 'gear'   ? '700' : '';
  document.getElementById('gear-btn-pulley').style.color = mode === 'pulley' ? 'var(--success)' : '';
  document.getElementById('gear-btn-pulley').style.fontWeight = mode === 'pulley' ? '700' : '';
  _gearRebuild();
}

function _gearTwistRow(){
  const t = document.getElementById('gear-gtype').value;
  const dim = (t === 'spur') ? 'var(--muted)' : 'var(--fg)';
  document.getElementById('gear-tw-lbl').style.color = dim;
}

// ── Mode Pair : boutons de rapport, affichage conditionnel ───────────────
function _gearRatioBtns(){
  const row = document.getElementById('gear-ratiobtn-row');
  if(!row || row.children.length) return;
  _GEAR_RATIOS.forEach(r => {
    const b = document.createElement('button');
    b.className = 'vb-btn';
    b.textContent = (Number.isInteger(r) ? r : r.toFixed(1)) + ':1';
    b.style.cssText = 'font-size:11px;padding:2px 6px;min-width:40px;';
    b.onclick = () => _gearSetRatio(r);
    row.appendChild(b);
  });
}

// Le rapport n'est qu'un raccourci de saisie : il fixe z2 = round(z1*r), et
// c'est z2 qui fait foi. Le rapport REELLEMENT obtenu (z2/z1) est reaffiche
// juste apres, parce que l'arrondi le decale des que z1*r n'est pas entier.
function _gearSetRatio(r){
  const z1 = +document.getElementById('gear-teeth').value;
  const rg = document.getElementById('gear-z2');
  const z2 = Math.min(+rg.max, Math.max(+rg.min, Math.round(z1 * r)));
  rg.value = z2;
  document.getElementById('gear-vz2').value = z2;
  _gearRebuild();
}

function _gearPairRow(editMode){
  const on = document.getElementById('gear-pair').checked;
  document.getElementById('gear-pair-body').style.display = on ? '' : 'none';
  // En edition le mode Pair est indisponible (il creerait un second objet).
  const box = document.getElementById('gear-pair');
  const lock = !!editMode;
  box.disabled = lock;
  document.getElementById('gear-pair-lbl').style.color = lock ? 'var(--muted)' : '';
  document.getElementById('gear-pair-lbl').title = lock
    ? 'Unavailable while editing an existing gear \u2014 a pair creates two objects.'
    : 'Also generate the mating gear, at the exact centre distance and clocking.';
}

function _gearPulleyRow(){
  const t = document.getElementById('gear-pty').value;
  document.getElementById('gear-sec-vgroove').style.display = t === 'v' ? '' : 'none';
  _gearRebuild();
}

function _getGearParams(){
  return {
    gearMode:    _gearMode,
    gearType:    document.getElementById('gear-gtype').value,
    gearModule:  _gearModVal,
    gearTeeth:   +document.getElementById('gear-teeth').value,
    gearHeight:  +document.getElementById('gear-h').value,
    gearHoleR:   +document.getElementById('gear-hr').value,
    gearTwist:   +document.getElementById('gear-tw').value,
    gearRes:     +document.getElementById('gear-res').value,
    gearBacklash:+document.getElementById('gear-bl').value,
    // [01/09 - 2e passe] Le SENS d'helice ne peut pas voyager dans gearTwist :
    // le curseur gear-tw est un <input type=range min="5">, il CLAMPE toute
    // valeur negative a 5. Une roue conjuguee stockee a -20 revenait donc a
    // +5 des qu'on la rouvrait en edition — mauvais sens ET mauvais angle, et
    // la paire cessait d'engrener. Verifie en executant le chemin : le curseur
    // relisait bien "5". Le sens vit donc a part, dans gearHand (+1 / -1), et
    // se conserve a travers l'edition puisqu'il est repris de l'objet edite.
    gearHand:    (_genEditObj && _genEditObj.genParams && _genEditObj.genParams.gearHand) || 1,
    gearPair:    document.getElementById('gear-pair').checked,
    gearTeeth2:  +document.getElementById('gear-z2').value,
    pulleyType:  document.getElementById('gear-pty').value,
    pulleyDExtR: +document.getElementById('gear-pdext').value / 2,
    pulleyH:     +document.getElementById('gear-ph').value,
    pulleyHoleR: +document.getElementById('gear-phr').value,
    grooveDepth: +document.getElementById('gear-gd').value,
    grooveWidth: +document.getElementById('gear-gw').value
  };
}

// ── _gearInvoluteShape — développante de cercle ISO α=20° ────────────────
// Formules ISO 53 :
//   rp = m·z/2 (primitif) · ra = rp+m (tête) · rf = rp-1.25m (pied)
//   rb = rp·cos(α) (base) · inv(α) = tan(α)-α
// Profil complet : arc pied → segment radial → développante → arc tête → retour
//
// ═══ [01/09] CORRECTION DU PIED — interférence mesurée, pas supposée ═══
// AVANT : rRoot = max(rf, rb). La développante n'existant pas sous le cercle
// de base, le fond de dent était simplement REMONTÉ à rb dès que rf < rb —
// c'est-à-dire pour TOUT z < 42. Conséquence : la tête de la roue conjuguée
// descend jusqu'à (a - ra2) = rp - m du centre, or rb = rp·cos20° est plus
// GRAND que rp - m tant que z < 2/(1-cos20°) = 33,16. Donc sous 34 dents la
// tête d'en face labourait le fond de dent. Mesuré sur le profil réel :
//     m2 z12 : -1,276 mm · m2 z17 : -0,975 · m2 z24 : -0,553 (défaut !)
//     m2 z30 : -0,191   · m2 z33 : -0,010  · m2 z34 : +0,050 (seuil)
//     m1 z24 : -0,276   · m4 z24 : -1,105
// MAINTENANT : la développante démarre toujours à rb (elle ne peut pas faire
// autrement), mais le flanc REDESCEND radialement jusqu'à rf. Jeu en fond de
// dent rétabli à 0,25·m exactement — la valeur ISO — vérifié de m0,5 à m4 et
// de z12 à z50. Sur z ≥ 42 (rf ≥ rb) rien ne change : le segment n'existe pas.
// Contrôlé inchangés : diamètre de tête (19,000 / 26,000 / 52,000 exacts) et
// épaisseur de dent au primitif (π·m/2 par construction : φ place le flanc à
// pitch/4 du centre de dent, inv(α) s'annulant exactement sur le primitif).
//
// nPts     : points sur la développante. Piloté par le slider Quality — avant
//            c'était une constante 8 que la résolution n'atteignait jamais.
//            96 (défaut) redonne 8 : aucun engrenage existant ne bouge.
// backlash : jeu d'entredent total en mm, mesuré sur le primitif. 0 = denture
//            théorique (deux flancs en contact permanent, convention CAO, même
//            défaut que FreeCAD). Retire backlash/2 d'épaisseur à chaque flanc.
function _gearInvoluteShape(m, z, rHole, nPts, backlash){
  const alpha = Math.PI / 9;  // 20°
  const N  = Math.max(4, (nPts | 0) || 8);
  const bl = Math.max(0, +backlash || 0);
  const rp  = m * z / 2;
  const ra  = rp + m;
  const rb  = rp * Math.cos(alpha);
  const rf  = Math.max(rp - 1.25 * m, 0.1);

  const invAlpha = Math.tan(alpha) - alpha;
  const pitch = 2 * Math.PI / z;

  // Paramètre t de la développante : elle part de max(rf, rb) et monte à ra.
  const t0 = rf > rb ? Math.sqrt((rf/rb)**2 - 1) : 0;
  const ta = Math.sqrt((ra/rb)**2 - 1);

  // Offset angulaire pour centrer la dent : φ = pitch/4 + inv(α) − jeu/2
  const phi = pitch / 4 + invAlpha - (bl / 2) / rp;
  const cp = Math.cos(-phi), sp = Math.sin(-phi);

  // Flanc droit (repère local centré)
  const rF = [];
  // Pied : sous rb la développante n'est pas définie — on descend droit au
  // fond, radialement, depuis son point de départ (rb, 0) déjà tourné de −φ.
  if(rf < rb) rF.push([rf*cp, rf*sp]);
  for(let k = 0; k <= N; k++){
    const t = t0 + (ta - t0) * k / N;
    const x0 = rb*(Math.cos(t)+t*Math.sin(t));
    const y0 = rb*(Math.sin(t)-t*Math.cos(t));
    rF.push([x0*cp - y0*sp, x0*sp + y0*cp]);
  }
  // Flanc gauche = miroir Y, inversé
  const lF = rF.map(([x,y])=>[x,-y]).reverse();
  const M  = rF.length - 1;   // dernier index (sommet de dent) — N+1 si radial

  const rot = (a,[x,y]) => [x*Math.cos(a)-y*Math.sin(a), x*Math.sin(a)+y*Math.cos(a)];
  const ang = ([x,y]) => Math.atan2(y,x);

  // Précalcul des points d'attache inter-dents
  const anchors = Array.from({length:z}, (_,i)=>{
    const a = i*pitch;
    return { a, rs:rot(a,rF[0]), le:rot(a,lF[M]) };
  });

  const sh = new THREE.Shape();
  sh.moveTo(...anchors[0].rs);

  for(let i = 0; i < z; i++){
    const a = anchors[i].a;
    if(i > 0) sh.absarc(0,0,rf, ang(anchors[i-1].le), ang(anchors[i].rs), false);
    rF.forEach(p => sh.lineTo(...rot(a,p)));                             // flanc droit
    const [tx1,ty1]=rot(a,rF[M]), [tx2,ty2]=rot(a,lF[0]);
    sh.absarc(0,0,ra, ang([tx1,ty1]), ang([tx2,ty2]), false);            // arc de tête
    lF.forEach(p => sh.lineTo(...rot(a,p)));                             // flanc gauche
  }
  // Fermeture : arc de pied dernière dent → première dent
  sh.absarc(0,0,rf, ang(anchors[z-1].le), ang(anchors[0].rs), false);
  sh.closePath();

  // Trou axial
  if(rHole > 0.5 && rHole < rf*0.85){
    const hole = new THREE.Path();
    hole.absarc(0,0,rHole, 0, Math.PI*2, true);
    sh.holes.push(hole);
  }
  return sh;
}

// ── Couple d'engrenages — entraxe et calage ──────────────────────────────
// Deux dentures n'engrènent que si TROIS conditions tiennent ensemble :
//   1. même module — garanti ici, la roue conjuguée reprend p.gearModule ;
//   2. entraxe exact  a = m(z1+z2)/2  — ce n'est pas un réglage, c'est un
//      calcul : trop près ça coince, trop loin ça a du jeu et ça tape ;
//   3. calage angulaire : une DENT doit tomber en face d'un CREUX.
//      Dans ce profil la dent 0 est centrée sur +X (vérifié numériquement :
//      0,000° pour z = 17, 20 et 24). La roue 2 est posée sur +X, elle
//      présente donc son angle π à la roue 1. Or π est un centre de dent
//      si et seulement si z2 est PAIR (π = i·2π/z2 ⇔ i = z2/2 entier).
//      D'où la règle : demi-pas de rotation (180/z2) si z2 est pair, rien
//      si z2 est impair.
// Vérifié : 0 collision sur 8 couples (20/80, 17/34, 21/80, 24/24, 20/21,
// 24/36, 4:1 en m4...), contre 44 à 70 avant la correction du pied, et 107
// à 114 si l'on retire volontairement le calage — il ne fait pas rien.
function _gearPairInfo(p){
  const m = p.gearModule, z1 = p.gearTeeth, z2 = p.gearTeeth2;
  const gcd = (x,y) => y ? gcd(y, x % y) : x;
  return {
    m, z1, z2,
    a:     m * (z1 + z2) / 2,
    clock: (z2 % 2 === 0) ? Math.PI / z2 : 0,
    ratio: z2 / z1,
    gcd:   gcd(z1, z2)
  };
}

// Géométrie de la roue conjuguée. Rend le maillage BRUT (pour en faire un
// objet placé par sa matrice) ET le maillage déjà transformé (pour le fantôme
// de prévisualisation, qui n'a qu'un seul buffer de positions).
function _gearMateGeom(p){
  const inf = _gearPairInfo(p);
  const rf2 = inf.m * inf.z2 / 2 - 1.25 * inf.m;
  const q = Object.assign({}, p, {
    gearTeeth: inf.z2,
    // Hélice de sens OPPOSÉ : condition d'engrènement des dentures
    // hélicoïdales et à chevrons. Sans ça les deux hélices se croisent.
    // C'est gearHand qui porte le sens, PAS gearTwist — voir _getGearParams.
    gearHand: ((p.gearHand || 1) < 0 ? 1 : -1),
    // La roue conjuguée est un objet ordinaire une fois posée : elle ne doit
    // pas se rouvrir en réclamant, elle aussi, une conjuguée.
    gearPair: false,
    // Le perçage saisi pour le pignon peut être absurde sur la grande roue
    // (ou l'inverse) : on le borne au pied de CETTE roue-là.
    gearHoleR: Math.min(p.gearHoleR, Math.max(1, rf2 * 0.8))
  });
  const { vPos } = _gearBuildSpur(q);
  const c = Math.cos(inf.clock), s = Math.sin(inf.clock);
  const moved = new Array(vPos.length);
  for(let i = 0; i < vPos.length; i += 3){
    const x = vPos[i], y = vPos[i+1];
    moved[i]   = x*c - y*s + inf.a;
    moved[i+1] = x*s + y*c;
    moved[i+2] = vPos[i+2];
  }
  return { raw: vPos, moved, info: inf, params: q };
}

// ── _gearBuildSpur — extrusion + torsion (droit/hélicoïdal/chevrons) ─────
function _gearBuildSpur(p){
  // [01/09] Le nombre de points de développante suit enfin le slider Quality.
  // 96 (défaut) → 8, soit exactement la constante d'avant : les engrenages
  // déjà en scène sont bit-à-bit identiques tant qu'on ne touche pas au slider.
  const nPts = Math.max(6, Math.round((p.gearRes || 96) / 12));
  // Angle d'helice SIGNE : magnitude au curseur, sens dans gearHand.
  const twist = Math.abs(p.gearTwist) * ((p.gearHand || 1) < 0 ? -1 : 1);
  const sh = _gearInvoluteShape(p.gearModule, p.gearTeeth, p.gearHoleR, nPts, p.gearBacklash);
  const H  = p.gearHeight;
  const steps = Math.max(2, Math.floor(p.gearRes / 16));
  const extGeo = new THREE.ExtrudeGeometry(sh, {
    depth:H, bevelEnabled:false, steps, curveSegments:12
  });

  // Torsion hélicoïdal / chevrons
  // [01/09] Math.abs() : un twist NÉGATIF est légitime — c'est l'hélice de
  // sens opposé, obligatoire sur la roue conjuguée (deux hélices de même sens
  // ne peuvent pas engrener). Avant, `> 0` la désactivait silencieusement et
  // la roue 2 d'une paire hélicoïdale sortait droite.
  if(p.gearType !== 'spur' && Math.abs(twist) > 0){
    const twRad = twist * Math.PI / 180;
    const pos = extGeo.attributes.position;
    for(let i = 0; i < pos.count; i++){
      const zv = pos.getZ(i);
      const zn = zv / H;
      const a = p.gearType === 'helical'
        ? zn * twRad
        : (zn < 0.5 ? zn : 1-zn) * twRad * 2;
      const x=pos.getX(i), y=pos.getY(i);
      pos.setX(i, x*Math.cos(a)-y*Math.sin(a));
      pos.setY(i, x*Math.sin(a)+y*Math.cos(a));
    }
    extGeo.computeVertexNormals();
  }

  const gNI = extGeo.toNonIndexed(); extGeo.dispose();
  const vPos = Array.from(gNI.attributes.position.array);
  gNI.dispose();
  return {vPos, tris:null}; // non-indexé : toNonIndexed() garantit le triangle soup
}

// ── _gearBuildPulleyV — lathe manuel watertight manifold ──────────────────
// Profil 2D [r,z] → révolution nS segments (wrap-around, sans ring dupliqué)
// Le lathe couvre déjà k=0 (cap bas) et k=5 (cap haut) → pas d'addCap
// La paroi intérieure du trou (prof[6]→prof[0]) est fermée explicitement
// Résultat : surface fermée, 0 bord ouvert → Manifold WASM safe
function _gearBuildPulleyV(p){
  const rE  = p.pulleyDExtR;
  const rH  = Math.min(p.pulleyHoleR, rE - 2);
  const H   = p.pulleyH;
  const gd  = Math.min(p.grooveDepth, rE - rH - 1);
  const gw2 = Math.min(p.grooveWidth / 2, H/2 - 1);
  const nS  = Math.max(24, p.gearRes);

  // Profil [r, z] — de bas en haut
  // k=0→1 : cap bas  annulaire (z=-H/2, rH→rE) → normale -z produite par lathe
  // k=1→5 : flanc extérieur + gorge V
  // k=5→6 : cap haut annulaire (z=+H/2, rE→rH) → normale +z produite par lathe
  const prof = [
    [rH,    -H/2],  // 0 — inner bas
    [rE,    -H/2],  // 1 — outer bas
    [rE,    -gw2],  // 2
    [rE-gd,  0  ],  // 3 — fond gorge
    [rE,     gw2],  // 4
    [rE,     H/2],  // 5 — outer haut
    [rH,     H/2],  // 6 — inner haut
  ];
  const nP = prof.length; // 7

  const verts = [];
  const idx   = [];

  // ── Surface de révolution — nS anneaux, wrap-around (seam partagé) ────────
  for(let seg = 0; seg < nS; seg++){
    const a = (seg / nS) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    for(let k = 0; k < nP; k++){
      const [r, z] = prof[k];
      verts.push(r*c, r*s, z);
    }
  }
  // Quads → tris avec wrap-around au seam
  // Inclut automatiquement cap bas (k=0) normale -z et cap haut (k=5) normale +z
  for(let seg = 0; seg < nS; seg++){
    const ns = (seg + 1) % nS;
    for(let k = 0; k < nP - 1; k++){
      const a = seg * nP + k, b = ns * nP + k;
      idx.push(a, b, b+1,  a, b+1, a+1);
    }
  }

  // ── Paroi intérieure du trou — ferme le cylindre entre prof[6] et prof[0] ──
  // Normale vers -r (intérieur du trou)
  for(let seg = 0; seg < nS; seg++){
    const ns = (seg + 1) % nS;
    const b0 = seg * nP + 0;  // inner bas, angle seg
    const b1 = ns  * nP + 0;  // inner bas, angle ns
    const t0 = seg * nP + 6;  // inner haut, angle seg
    const t1 = ns  * nP + 6;  // inner haut, angle ns
    idx.push(b0, t0, t1,  b0, t1, b1);
  }

  return {vPos: verts, tris: idx};
}

// ── _gearBuildPulleyT — poulie timing crantée → ExtrudeGeometry ───────────
function _gearBuildPulleyT(p){
  const rE = p.pulleyDExtR;
  const rH = Math.min(p.pulleyHoleR, rE - 2);
  const H  = p.pulleyH;
  const nT = Math.max(12, Math.floor(p.pulleyDExtR * 2 / 2.5));

  const sh = new THREE.Shape();
  for(let i=0; i<nT*2; i++){
    const a=(i/(nT*2))*Math.PI*2;
    const r = i%2===0 ? rE : rE-2.5;
    if(i===0) sh.moveTo(Math.cos(a)*r, Math.sin(a)*r);
    else sh.lineTo(Math.cos(a)*r, Math.sin(a)*r);
  }
  sh.closePath();
  if(rH > 0.5){ const hole=new THREE.Path(); hole.absarc(0,0,rH,0,Math.PI*2,true); sh.holes.push(hole); }

  const ext = new THREE.ExtrudeGeometry(sh,{depth:H, bevelEnabled:false, steps:1, curveSegments:16});
  const gNI = ext.toNonIndexed(); ext.dispose();
  const vPos = Array.from(gNI.attributes.position.array);
  gNI.dispose();
  return {vPos, tris:null}; // non-indexé
}

// ── Dispatch principal ────────────────────────────────────────────────────
function _gearBuild(p){
  if(p.gearMode === 'pulley')
    return p.pulleyType === 'v' ? _gearBuildPulleyV(p) : _gearBuildPulleyT(p);
  return _gearBuildSpur(p);
}

function _gearRebuild(){
  const p = _getGearParams();
  const pairInfoEl = document.getElementById('gear-pair-info');
  try{
    const {vPos, tris} = _gearBuild(p);
    // Le fantôme montre le COUPLE, en fusionnant les deux soupes de triangles
    // dans un seul buffer de positions — _genLiveUpdate n'en accepte qu'un.
    // Interdit en ÉDITION : là, ce buffer remplace la géométrie de l'objet
    // sélectionné, et on y collerait une seconde roue.
    const pairOn = (p.gearMode === 'gear' && p.gearPair && !_genEditObj);
    let shownPos = vPos;
    if(pairOn) shownPos = vPos.concat(_gearMateGeom(p).moved);

    const triCount = tris ? tris.length/3 : shownPos.length/9;
    const vtxCount = shownPos.length/3;
    let info = '';
    if(p.gearMode === 'gear'){
      const rp = p.gearModule * p.gearTeeth / 2;
      info = `m${p.gearModule} · z${p.gearTeeth} · Ø${(rp*2).toFixed(1)}mm`;
    } else {
      info = `Ø${(p.pulleyDExtR*2).toFixed(0)}mm · H${p.pulleyH}mm`;
    }
    document.getElementById('gear-stats').textContent =
      `▲ ${triCount.toLocaleString('fr-FR')} tri · ◎ ${vtxCount.toLocaleString('fr-FR')} vtx · ${info}`;

    if(pairInfoEl){
      if(p.gearMode === 'gear' && p.gearPair){
        const i = _gearPairInfo(p);
        // gcd > 1 : chaque dent du pignon ne rencontrera jamais que z2/gcd
        // dents de la roue, toujours les mêmes — un défaut d'usinage s'y use
        // en boucle. gcd = 1 (« hunting tooth ») répartit l'usure sur tout.
        const wear = i.gcd > 1
          ? `⚠ gcd ${i.gcd} — each pinion tooth only ever meets ${i.z2/i.gcd} wheel teeth`
          : `✔ hunting tooth (gcd 1) — wear spread over every tooth`;
        pairInfoEl.innerHTML =
          `z${i.z1}/${i.z2} · ratio <b>${i.ratio.toFixed(3)}:1</b> · Ø${(i.m*i.z1).toFixed(1)}/${(i.m*i.z2).toFixed(1)}mm<br>`
        + `centre distance <b>${i.a.toFixed(2)} mm</b> · clocking ${(i.clock*180/Math.PI).toFixed(2)}°<br>`
        + `<span style="opacity:.75">${wear}</span>`;
      } else pairInfoEl.textContent = '—';
    }
    _genLiveUpdate({vPos: shownPos, tris});
  } catch(err){
    document.getElementById('gear-stats').textContent = '⚠ '+err.message;
    if(pairInfoEl) pairInfoEl.textContent = '—';
  }
}

function _gearToScene(){
  const p = _getGearParams();
  const tag = p.gearMode==='gear'
    ? `gear_m${p.gearModule}_z${p.gearTeeth}_${p.gearType}`
    : `pulley_${p.pulleyType}_D${(p.pulleyDExtR*2).toFixed(0)}`;

  const _pNums = Object.values(p).filter(v => typeof v === 'number');
  const _pairOn = (p.gearMode === 'gear' && p.gearPair && !_genEditObj);
  if(!_numsOK(..._pNums) || (p.gearMode==='gear' && p.gearTeeth<3) || (_pairOn && p.gearTeeth2 < 3)){
    nasLog('ERROR','Gear.Gen : valeurs invalides');
    _nasAlert('⚠ Gear.Gen : vérifie les champs numériques (valeur vide, non numérique ou hors plage).');
    return;
  }

  // ── MODE ÉDITION : géo déjà live-updatée par _genLiveUpdate → finaliser seulement ──
  if(_genEditObj){
    _genEditObj.genParams = _getGearParams();
    nasLog('OK','Gear.Gen edited: '+_genEditObj.name);
    _csgLog && _csgLog('✏ Gear.Gen edited → '+_genEditObj.name);
    hideGearDialog(false);
    return;
  }

  // ── MODE CRÉATION ──
  showSpinner('Gear.Gen', tag);
  try{
    const _geoFrom = (vPos, tris) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(vPos),3));
      if(tris) g.setIndex(Array.from({length:tris.length},(_,i)=>tris[i]));
      g.computeVertexNormals();
      g.computeBoundingBox();
      return g;
    };
    const {vPos, tris} = _gearBuild(p);

    // [REFACTOR V4.7.1] cf. tore-gen.js — bloc mutualisé dans _finalizeGenToScene
    // (htm). shininess/specular passés explicitement : Gear.Gen est le SEUL des
    // 9 générateurs à s'écarter des défauts 8/0x1a1a1a (12/0x2a2a2a — rendu
    // dents plus net), variation volontaire préservée, pas effacée.
    const o1 = _finalizeGenToScene({
      label: _pairOn ? 'Gear.Gen pair (pinion)' : 'Gear.Gen',
      geo: _geoFrom(vPos, tris),
      name: (n) => tag+'_'+n,
      genType: 'gear', genParams: _getGearParams(),
      // En mode Pair on garde le dialogue ouvert : c'est la roue conjuguée,
      // créée juste après, qui le fermera.
      hideDialogFn: _pairOn ? (()=>{}) : (() => hideGearDialog(false)),
      shininess: 12, specular: 0x2a2a2a
    });

    if(_pairOn){
      const mate = _gearMateGeom(p);
      const i    = mate.info;
      const tag2 = `gear_m${p.gearModule}_z${i.z2}_${p.gearType}`;
      const o2 = _finalizeGenToScene({
        label: 'Gear.Gen pair (wheel)',
        geo: _geoFrom(mate.raw, null),
        name: (n) => tag2+'_'+n,
        genType: 'gear', genParams: mate.params,
        hideDialogFn: () => hideGearDialog(false),
        shininess: 12, specular: 0x2a2a2a
      });

      // ── Placement MÉCANIQUE, pas esthétique ──
      // Axes parallèles, entraxe exact a, et donc MÊME hauteur de centre pour
      // les deux : c'est la distance entre CENTRES qui vaut a, pas la distance
      // entre deux objets posés chacun sur la grille. On aligne les deux
      // centres sur le rayon de tête le plus grand → la grande roue touche la
      // grille, le pignon flotte. C'est exactement l'allure d'un train réel.
      const ra1 = i.m * (i.z1/2 + 1), ra2 = i.m * (i.z2/2 + 1);
      const yC  = Math.max(ra1, ra2);
      const x1  = o1.mesh.position.x, z1 = o1.mesh.position.z;
      o1.mesh.position.set(x1,       yC, z1);
      o2.mesh.position.set(x1 + i.a, yC, z1);
      o2.mesh.rotation.z = i.clock;   // demi-pas si z2 pair — cf. _gearPairInfo
      o1.mesh.updateMatrixWorld(true);
      o2.mesh.updateMatrixWorld(true);
      if(typeof _invalidateBbox === 'function'){ _invalidateBbox(o1.mesh); _invalidateBbox(o2.mesh); }

      selObjs = [o1, o2];
      updProps(); updOList(); updStats();
      nasLog('OK', `Gear.Gen pair: z${i.z1}/${i.z2} ratio ${i.ratio.toFixed(3)}:1, centre distance ${i.a.toFixed(2)}mm`);
      _csgLog && _csgLog(`⚙ Gear pair z${i.z1}/${i.z2} · i=${i.ratio.toFixed(3)} · a=${i.a.toFixed(2)}mm`);
    }
  } catch(err){
    hideSpinner();
    nasLog('ERROR','Gear.Gen : '+err.message);
    _nasAlert('⚠ Gear.Gen : '+err.message);
  }
}
// ── Fin Gear.Gen ──────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════
// sketch-gen.js — module Sketch.Gen extrait du host NASSCAD
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, selObjs, objCnt, COL, PS, GS, isHoleMode   — scene state
//   THREE                                                    — Three.js global
//   undoPush, updProps, updOList, updStats, nasLog           — app-wide helpers
//   _findFreePos, _invalidateBbox                            — placement/bbox helpers
//   _xrayActive, _applyXRay                                   — X-ray view mode
//
// Public surface exposed to the host: window.openSketcher, window.closeSketcher,
// window.SK (see bottom of file).
// ══════════════════════════════════════════════════════════════════════════
// ════════ NASSCAD Sketch.Gen — 2D Sketcher module (IIFE-isolated) ════════
(function(){
'use strict';
const _skRoot = document.getElementById('sk-overlay');
let   _skOpen = false;
// ────────────────────────────────────────────────────────────
//  CONSTANTS & CONFIG
// ────────────────────────────────────────────────────────────
const GRID_MINOR  = 5;    // minor grid every 5px world
const GRID_MAJOR  = 50;   // major grid every 50px world
const SNAP_THRESH = 10;   // pixels to snap
const CLOSE_THRESH = 14;  // pixels to snap-close a chain back to its start point

// ────────────────────────────────────────────────────────────
//  STATE
// ────────────────────────────────────────────────────────────
let entities  = [];
let selected  = new Set();
let nextId    = 1;

let activeTool = 'select';
let drawState  = null;   // in-progress drawing data
let chain      = null;   // { x, y, links } — tracks the start point of the current multi-segment chain (line/arc/bezier) for auto-closing

let view = { x: 0, y: 0, scale: 1 };  // world-to-screen

let mouse = { wx: 0, wy: 0, sx: 0, sy: 0 };  // world & screen coords
let snapInfo = null;  // { wx, wy, type }

let snaps = { grid: true, endpoint: true, midpoint: true, center: true, intersection: true };

let showGrid = true;
let isPanning = false;
let panStart  = null;
// [V4.7.2] Fillet : première ligne mémorisée entre les deux clics (null = en attente du 1er).
// Déclaré ici, avec le reste de l'état, pour qu'il soit initialisé avant tout appel à setTool().
let _skFilletPick = null;

// [V4.7.3] Historique d'annulation PROPRE AU SKETCHER.
// Avant : un seul undoPush dans tout Sketch.Gen, au moment de l'extrusion — il
// protégeait la scène 3D, pas l'esquisse. Supprimer, déplacer, contraindre, et
// depuis la V4.7.2 trimmer/congé : tout était irréversible, et le ✕ "Clear all"
// vidait l'esquisse sans filet. On empile ici des INSTANTANÉS complets
// {entities, nextId, selected}. Une esquisse fait quelques dizaines d'entités :
// le clone JSON est négligeable devant le confort, et c'est infaillible face aux
// mutations en place — trim et les contraintes réécrivent les coordonnées
// d'entités existantes, un journal de deltas se serait désynchronisé bien plus
// facilement.
let _skUndo = [], _skRedo = [];
let _skUndoLock = false;   // une opération composée (congé = 2 lignes + 1 arc) ne doit empiler qu'UNE entrée
const _SK_UNDO_MAX = 120;

// [V4.7.3] Poignées d'extrémité (grips) + sélection par rectangle élastique
let _skGrip = null;   // { id, key } — point unique en cours de déplacement
let _skBand = null;   // { sx0, sy0, sx1, sy1, add } — rectangle de sélection en cours

// ────────────────────────────────────────────────────────────
//  CANVAS SETUP
// ────────────────────────────────────────────────────────────
const canvas = document.getElementById('sk-sketch-canvas');
const ctx    = canvas.getContext('2d');
const wrap   = document.getElementById('sk-canvas-wrap');

function resize() {
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  // Center origin on first load
  if (view.x === 0 && view.y === 0) {
    view.x = canvas.width  / 2;
    view.y = canvas.height / 2;
  }
  render();
}

const ro = new ResizeObserver(resize);
ro.observe(wrap);

// ────────────────────────────────────────────────────────────
//  COORDINATE TRANSFORMS
// ────────────────────────────────────────────────────────────
function worldToScreen(wx, wy) {
  return { sx: view.x + wx * view.scale, sy: view.y - wy * view.scale };
}
function screenToWorld(sx, sy) {
  return { wx: (sx - view.x) / view.scale, wy: -(sy - view.y) / view.scale };
}
function wdist(d) { return d * view.scale; }

// ────────────────────────────────────────────────────────────
//  SNAP ENGINE
// ────────────────────────────────────────────────────────────
function closeEligible() {
  if (!chain || chain.links < 1) return false;
  if (activeTool === 'line') return !!drawState;
  if (activeTool === 'arc' || activeTool === 'bezier') return !!drawState && drawState.phase === 1;
  return false;
}

function findSnap(sx, sy) {
  // Chain auto-close: highest priority — snap onto the chain's start point
  // so the next click closes the loop instead of starting a new free point.
  if (closeEligible()) {
    const ps = worldToScreen(chain.x, chain.y);
    const d  = Math.hypot(ps.sx - sx, ps.sy - sy);
    if (d < CLOSE_THRESH) return { wx: chain.x, wy: chain.y, type: 'close' };
  }

  const raw = screenToWorld(sx, sy);
  let best = null, bestD = SNAP_THRESH;

  // Endpoint snap
  if (snaps.endpoint) {
    for (const e of entities) {
      const pts = entityPoints(e);
      for (const [wx, wy] of pts) {
        const ps = worldToScreen(wx, wy);
        const d  = Math.hypot(ps.sx - sx, ps.sy - sy);
        if (d < bestD) { best = { wx, wy, type: 'endpoint' }; bestD = d; }
      }
    }
  }

  // Midpoint snap
  if (snaps.midpoint) {
    for (const e of entities) {
      if (e.type === 'line') {
        const mx = (e.x1 + e.x2) / 2, my = (e.y1 + e.y2) / 2;
        const ps = worldToScreen(mx, my);
        const d  = Math.hypot(ps.sx - sx, ps.sy - sy);
        if (d < bestD) { best = { wx: mx, wy: my, type: 'midpoint' }; bestD = d; }
      }
    }
  }

  // Center snap
  if (snaps.center) {
    for (const e of entities) {
      if (e.type === 'circle' || e.type === 'arc') {
        const ps = worldToScreen(e.cx, e.cy);
        const d  = Math.hypot(ps.sx - sx, ps.sy - sy);
        if (d < bestD) { best = { wx: e.cx, wy: e.cy, type: 'center' }; bestD = d; }
      }
    }
  }

  // [V4.7.3] Intersection snap — arrivé en même temps que trim/extend/congé, qui
  // rendent les intersections centrales dans le flux de travail.
  // Coût maîtrisé : on ne croise QUE les entités déjà sous le curseur (hitTest),
  // typiquement 2. Croiser toutes les paires à chaque mousemove serait en O(n²)
  // par image, injouable dès quelques dizaines d'entités.
  if (snaps.intersection) {
    const near = [];
    for (const e of entities) if (hitTest(e, raw.wx, raw.wy)) near.push(e);
    for (let i = 0; i < near.length; i++)
      for (let j = i + 1; j < near.length; j++)
        for (const p of _skXsect(near[i], near[j])) {
          const ps = worldToScreen(p.x, p.y);
          const d  = Math.hypot(ps.sx - sx, ps.sy - sy);
          if (d < bestD) { best = { wx: p.x, wy: p.y, type: 'intersection' }; bestD = d; }
        }
  }

  // Grid snap (lowest priority)
  if (snaps.grid && !best) {
    const gs  = GRID_MINOR;
    const gwx = Math.round(raw.wx / gs) * gs;
    const gwy = Math.round(raw.wy / gs) * gs;
    const ps  = worldToScreen(gwx, gwy);
    const d   = Math.hypot(ps.sx - sx, ps.sy - sy);
    if (d < SNAP_THRESH * 1.5) best = { wx: gwx, wy: gwy, type: 'grid' };
  }

  return best || { wx: raw.wx, wy: raw.wy, type: null };
}

function entityPoints(e) {
  switch (e.type) {
    case 'point':  return [[e.x, e.y]];
    case 'line':   return [[e.x1, e.y1], [e.x2, e.y2]];
    case 'rect':   return [[e.x1, e.y1], [e.x2, e.y1], [e.x2, e.y2], [e.x1, e.y2]];
    case 'circle': return [[e.cx, e.cy]];
    case 'arc': {
      const p1 = arcStartPoint(e), p2 = arcEndPoint(e);
      return [[p1.x, p1.y], [p2.x, p2.y]];
    }
    case 'bezier':
      return [[e.x0, e.y0], [e.x1, e.y1], [e.x2, e.y2], [e.x3, e.y3]];
    default: return [];
  }
}

function arcStartPoint(e) { return { x: e.cx + e.r * Math.cos(e.a1), y: e.cy + e.r * Math.sin(e.a1) }; }
function arcEndPoint(e)   { return { x: e.cx + e.r * Math.cos(e.a2), y: e.cy + e.r * Math.sin(e.a2) }; }

// ────────────────────────────────────────────────────────────
//  TOOL DEFINITIONS
// ────────────────────────────────────────────────────────────
const toolHints = {
  select:  'Click to select. Shift+click multi-select. Middle-drag to pan.',
  point:   'Click to place a point.',
  line:    'Click start point. Click end to finish (chains automatically). Click back near the chain start to close the loop. ESC to cancel.',
  rect:    'Click first corner. Click opposite corner.',
  circle:  'Click center. Click to set radius.',
  arc:     'Click start. Click end. Click apex to bend the arc (chains automatically). Click end near the chain start to close the loop.',
  bezier:  'Click start. Click end. Click 2 control points to bend the curve (chains automatically). Click end near the chain start to close the loop.',
  trim:    'Click the piece to remove. The entity is cut at its intersections with the others. A rectangle is exploded into 4 lines first.',
  extend:  'Click near the end of a line or arc to stretch it up to the next intersection.',
  fillet:  'Pick line 1, then line 2. The corner is replaced by a tangent arc of radius R (set R in the toolbar).',
};

function setTool(name) {
  activeTool = name;
  drawState  = null;
  chain      = null;
  _skFilletPick = null;   // [V4.7.2] abandonne un congé commencé mais non validé
  _skRoot.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === name));
  document.getElementById('sk-sb-tool').textContent = name.toUpperCase();
  document.getElementById('sk-hint-text').textContent = toolHints[name] || '';
  updateCursor();
}

function updateCursor() {
  if (isPanning) { canvas.className = 'grabbing'; return; }
  canvas.className = activeTool === 'select' ? '' : '';
  canvas.style.cursor = activeTool === 'select' ? 'default' : 'crosshair';
}

// ────────────────────────────────────────────────────────────
//  ENTITY CREATION
// ────────────────────────────────────────────────────────────
function addEntity(e) {
  const _u = _skSnapshot();                 // [V4.7.3] undo
  e.id = nextId++;
  e.constraints = [];
  entities.push(e);
  _skCommit(_u);
  updateEntityList();
  updateStatusCount();
  render();
  return e;
}

function deleteSelected() {
  if (!selected.size) { _skHint('Nothing selected to delete.'); return; }
  const _u = _skSnapshot();                 // [V4.7.3] undo
  const n = selected.size;
  entities = entities.filter(e => !selected.has(e.id));
  selected.clear();
  _skCommit(_u);
  _skHint(`${n} entity(ies) deleted — Ctrl+Z undoes it.`);
  updateEntityList();
  updateProps();
  updateStatusCount();
  render();
}

function clearAll(force) {
  // [V4.7.3] Le ✕ vidait l'esquisse instantanément et sans retour possible.
  // Il est maintenant annulable ET confirmé. force=true pour les appels internes
  // (openSketcher, scripts) qui ne doivent pas ouvrir de boîte de dialogue.
  if (!force && entities.length &&
      !confirm(`Clear all ${entities.length} entities?\n\n(Ctrl+Z undoes it.)`)) return;
  const _u = _skSnapshot();                 // [V4.7.3] undo
  entities = []; selected.clear(); nextId = 1; drawState = null; chain = null;
  _skCommit(_u);
  updateEntityList(); updateProps(); updateStatusCount(); render();
}

// ────────────────────────────────────────────────────────────
//  SELECTION
// ────────────────────────────────────────────────────────────
function hitTest(e, wx, wy) {
  const t = 6 / view.scale;  // world-space tolerance
  switch (e.type) {
    case 'point': return Math.hypot(e.x - wx, e.y - wy) < t * 1.5;
    case 'line': {
      const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
      const len = Math.hypot(dx, dy); if (!len) return false;
      const t2  = ((wx - e.x1) * dx + (wy - e.y1) * dy) / (len * len);
      const tc  = Math.max(0, Math.min(1, t2));
      const px  = e.x1 + tc * dx, py = e.y1 + tc * dy;
      return Math.hypot(wx - px, wy - py) < t;
    }
    case 'rect': {
      const minx = Math.min(e.x1,e.x2), maxx = Math.max(e.x1,e.x2);
      const miny = Math.min(e.y1,e.y2), maxy = Math.max(e.y1,e.y2);
      const onEdge = (wx >= minx - t && wx <= maxx + t && wy >= miny - t && wy <= maxy + t) &&
                     (wx <= minx + t || wx >= maxx - t || wy <= miny + t || wy >= maxy - t);
      return onEdge;
    }
    case 'circle': {
      const d = Math.hypot(wx - e.cx, wy - e.cy);
      return Math.abs(d - e.r) < t;
    }
    case 'arc': {
      const d  = Math.hypot(wx - e.cx, wy - e.cy);
      if (Math.abs(d - e.r) > t) return false;
      const ang = Math.atan2(wy - e.cy, wx - e.cx);
      const total = angNorm(e.ccw ? (e.a2 - e.a1) : (e.a1 - e.a2));
      const toAng = angNorm(e.ccw ? (ang - e.a1) : (e.a1 - ang));
      return toAng <= total + 0.01;
    }
    case 'bezier': {
      let prev = bezierPointAt(e, 0);
      for (let i = 1; i <= 24; i++) {
        const pt = bezierPointAt(e, i / 24);
        if (distToSegment(wx, wy, prev.x, prev.y, pt.x, pt.y) < t) return true;
        prev = pt;
      }
      return false;
    }
    default: return false;
  }
}

// ────────────────────────────────────────────────────────────
//  MOUSE EVENTS
// ────────────────────────────────────────────────────────────
canvas.addEventListener('mousedown', onMouseDown);
canvas.addEventListener('mousemove', onMouseMove);
canvas.addEventListener('mouseup',   onMouseUp);
canvas.addEventListener('wheel',     onWheel, { passive: false });
canvas.addEventListener('contextmenu', e => e.preventDefault());

function getMouseScreen(e) {
  const r = canvas.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
}

function onMouseDown(e) {
  const ms = getMouseScreen(e);
  const snap = findSnap(ms.sx, ms.sy);
  const { wx, wy } = snap;

  // Middle click, right-click, or Alt+drag → pan
  if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
    isPanning = true; panStart = { sx: ms.sx, sy: ms.sy, vx: view.x, vy: view.y };
    updateCursor(); return;
  }
  if (e.button !== 0) return;

  switch (activeTool) {
    case 'select': {
      // [V4.7.3] 1) une poignée d'une entité déjà sélectionnée l'emporte sur tout
      const grip = _skGripAt(ms.sx, ms.sy);
      if (grip) {
        _skGrip = { ...grip, undo: _skSnapshot(), moved: false };
        break;
      }
      let hit = null;
      for (let i = entities.length - 1; i >= 0; i--) {
        if (hitTest(entities[i], wx, wy)) { hit = entities[i]; break; }
      }
      if (hit) {
        if (e.shiftKey) {
          if (selected.has(hit.id)) selected.delete(hit.id);
          else selected.add(hit.id);
        } else {
          if (!selected.has(hit.id)) { selected.clear(); selected.add(hit.id); }
        }
        // start drag: snapshot selected entity positions
        _skDrag = { startWx: wx, startWy: wy, moved: false,
                    undo: _skSnapshot(),
                    snap: [...selected].map(id => _skClone(entities.find(en => en.id === id))).filter(Boolean) };
      } else {
        // [V4.7.3] 2) clic dans le vide → rectangle élastique (Shift = ajout)
        if (!e.shiftKey) selected.clear();
        _skDrag = null;
        _skBand = { sx0: ms.sx, sy0: ms.sy, sx1: ms.sx, sy1: ms.sy, add: e.shiftKey };
      }
      updateProps();
      break;
    }
    case 'point':
      addEntity({ type: 'point', x: wx, y: wy });
      break;
    case 'line':
      if (!drawState) {
        drawState = { phase: 1, x1: wx, y1: wy };
        if (!chain) chain = { x: wx, y: wy, links: 0 };
      } else {
        const closing = snap.type === 'close';
        const ex = closing ? chain.x : wx, ey = closing ? chain.y : wy;
        addEntity({ type: 'line', x1: drawState.x1, y1: drawState.y1, x2: ex, y2: ey });
        chain.links++;
        if (closing) { chain = null; drawState = null; }
        else drawState = { phase: 1, x1: ex, y1: ey };
      }
      break;
    case 'rect':
      if (!drawState) {
        drawState = { phase: 1, x1: wx, y1: wy };
      } else {
        addEntity({ type: 'rect', x1: drawState.x1, y1: drawState.y1, x2: wx, y2: wy });
        drawState = null;
      }
      break;
    case 'circle':
      if (!drawState) {
        drawState = { phase: 1, cx: wx, cy: wy };
      } else {
        const r = Math.hypot(wx - drawState.cx, wy - drawState.cy);
        if (r > 0.1) addEntity({ type: 'circle', cx: drawState.cx, cy: drawState.cy, r });
        drawState = null;
      }
      break;
    case 'arc':
      if (!drawState) {
        drawState = { phase: 1, x1: wx, y1: wy };
        if (!chain) chain = { x: wx, y: wy, links: 0 };
      } else if (drawState.phase === 1) {
        const closing = snap.type === 'close';
        drawState.phase = 2;
        drawState.x2 = closing ? chain.x : wx;
        drawState.y2 = closing ? chain.y : wy;
        drawState.closing = closing;
      } else {
        const arc = arcFrom3Points(drawState.x1, drawState.y1, drawState.x2, drawState.y2, wx, wy);
        if (arc) addEntity({ type: 'arc', ...arc });
        chain.links++;
        if (drawState.closing) { chain = null; drawState = null; }
        else drawState = { phase: 1, x1: drawState.x2, y1: drawState.y2 };
      }
      break;
    case 'bezier':
      if (!drawState) {
        drawState = { phase: 1, x0: wx, y0: wy };
        if (!chain) chain = { x: wx, y: wy, links: 0 };
      } else if (drawState.phase === 1) {
        const closing = snap.type === 'close';
        drawState.phase = 2;
        drawState.x3 = closing ? chain.x : wx;
        drawState.y3 = closing ? chain.y : wy;
        drawState.closing = closing;
      } else if (drawState.phase === 2) {
        drawState.phase = 3;
        drawState.x1 = wx; drawState.y1 = wy;
      } else {
        drawState.x2 = wx; drawState.y2 = wy;
        addEntity({ type: 'bezier',
          x0: drawState.x0, y0: drawState.y0,
          x1: drawState.x1, y1: drawState.y1,
          x2: drawState.x2, y2: drawState.y2,
          x3: drawState.x3, y3: drawState.y3 });
        chain.links++;
        if (drawState.closing) { chain = null; drawState = null; }
        else drawState = { phase: 1, x0: drawState.x3, y0: drawState.y3 };
      }
      break;

    // ── [V4.7.2] MODIFICATION TOOLS ──────────────────────────────────────
    // Ces trois outils désignent une entité EXISTANTE : on veut la position
    // réelle du curseur, pas la position accrochée. findSnap() aurait pu
    // déplacer le point sur la grille ou sur une extrémité voisine et faire
    // rater le picking (ou pire, désigner le mauvais tronçon à couper).
    case 'trim': {
      const rw  = screenToWorld(ms.sx, ms.sy);
      const hit = _skPick(rw.wx, rw.wy);
      if (hit) _skTrimAt(hit, rw.wx, rw.wy);
      else _skHint('Trim: click ON the piece you want to remove.');
      break;
    }
    case 'extend': {
      const rw  = screenToWorld(ms.sx, ms.sy);
      const hit = _skPick(rw.wx, rw.wy);
      if (hit) _skExtendAt(hit, rw.wx, rw.wy);
      else _skHint('Extend: click near the end of a line or arc.');
      break;
    }
    case 'fillet': {
      const rw  = screenToWorld(ms.sx, ms.sy);
      const hit = _skPick(rw.wx, rw.wy);
      if (!hit) { _skHint('Fillet: click on a line.'); break; }
      if (!_skFilletPick) {
        _skFilletPick = hit;
        selected.clear(); selected.add(hit.id);
        _skHint('Fillet: line 1 selected — now pick line 2.');
        updateProps();
      } else if (hit.id === _skFilletPick.id) {
        _skHint('Fillet: pick a DIFFERENT second line.');
      } else {
        const rEl = document.getElementById('sk-fillet-r');
        const R   = Math.abs(parseFloat(rEl && rEl.value)) || 5;
        _skFillet(_skFilletPick, hit, R);
        _skFilletPick = null;
        selected.clear();
        updateProps();
      }
      break;
    }
  }
  render();
}

function onMouseMove(e) {
  const ms  = getMouseScreen(e);
  const snap = findSnap(ms.sx, ms.sy);
  snapInfo = snap;
  mouse.wx = snap.wx; mouse.wy = snap.wy;
  mouse.sx = ms.sx;   mouse.sy = ms.sy;

  document.getElementById('sk-sb-x').textContent    = snap.wx.toFixed(2);
  document.getElementById('sk-sb-y').textContent    = snap.wy.toFixed(2);
  document.getElementById('sk-sb-snap').textContent = snap.type || '—';

  document.getElementById('sk-hint-text').textContent =
    snap.type === 'close' ? '◉ Click to close the loop back to the chain start.' : (toolHints[activeTool] || '');

  if (isPanning && panStart) {
    view.x = panStart.vx + (ms.sx - panStart.sx);
    view.y = panStart.vy + (ms.sy - panStart.sy);
    canvas.style.cursor = 'grabbing';
  } else if (_skGrip) {                      // [V4.7.3] déplacement d'un point unique
    const ent = entities.find(en => en.id === _skGrip.id);
    if (ent) { _skMoveGrip(ent, _skGrip.key, snap.wx, snap.wy); _skGrip.moved = true; }
    canvas.style.cursor = 'grabbing';
  } else if (_skBand) {                      // [V4.7.3] rectangle élastique
    _skBand.sx1 = ms.sx; _skBand.sy1 = ms.sy;
    canvas.style.cursor = 'crosshair';
  } else if (_skDrag && activeTool === 'select') {
    const dx = snap.wx - _skDrag.startWx;
    const dy = snap.wy - _skDrag.startWy;
    if (Math.hypot(dx, dy) > 0.5 / view.scale) {   // threshold: 0.5px
      _skDrag.moved = true;
      _skApplyDrag(dx, dy);
      canvas.style.cursor = 'grabbing';
    }
  } else {
    // hover cursor: show grab when over a selectable entity
    if (activeTool === 'select') {
      let hovered = false;
      for (let i = entities.length - 1; i >= 0; i--) {
        if (hitTest(entities[i], snap.wx, snap.wy)) { hovered = true; break; }
      }
      canvas.style.cursor = hovered ? 'grab' : 'default';
    }
  }

  render();
}

function onMouseUp(e) {
  if (isPanning) { isPanning = false; canvas.style.cursor = 'default'; }

  // [V4.7.3] fin de déplacement d'une poignée
  if (_skGrip) {
    if (_skGrip.moved) { _skCommit(_skGrip.undo); updateProps(); }
    _skGrip = null;
    canvas.style.cursor = activeTool === 'select' ? 'default' : 'crosshair';
    render();
    return;
  }

  // [V4.7.3] fin du rectangle élastique
  if (_skBand) {
    const b = _skBand; _skBand = null;
    const dragged = Math.hypot(b.sx1 - b.sx0, b.sy1 - b.sy0) > 3;   // sinon c'était un simple clic
    if (dragged) {
      const p0 = screenToWorld(b.sx0, b.sy0), p1 = screenToWorld(b.sx1, b.sy1);
      if (!b.add) selected.clear();
      let n = 0;
      for (const en of entities)
        if (_skEntInBand(en, p0.wx, p0.wy, p1.wx, p1.wy)) { selected.add(en.id); n++; }
      _skHint(n ? `${n} entity(ies) selected.` : 'Nothing inside the selection box.');
      updateProps();
    }
    canvas.style.cursor = 'default';
    render();
    return;
  }

  if (_skDrag) {
    if (_skDrag.moved) { _skCommit(_skDrag.undo); updateProps(); }
    _skDrag = null;
    canvas.style.cursor = activeTool === 'select' ? 'default' : 'crosshair';
  }
}

function onWheel(e) {
  e.preventDefault();
  const ms = getMouseScreen(e);
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const wx = (ms.sx - view.x) / view.scale;
  const wy = (ms.sy - view.y) / view.scale;
  view.scale *= factor;
  view.scale  = Math.max(0.05, Math.min(200, view.scale));
  view.x = ms.sx - wx * view.scale;
  view.y = ms.sy - wy * view.scale;
  document.getElementById('sk-sb-zoom').textContent = Math.round(view.scale * 100) + '%';
  render();
}

// ────────────────────────────────────────────────────────────
//  KEYBOARD
// ────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (!_skOpen) return;
  if (e.target.tagName === 'INPUT') return;
  // ── numeric dimension entry when a drawing tool is active ──────────────
  if (drawState && activeTool !== 'select' && activeTool !== 'point') {
    if (/^[0-9\.\-]$/.test(e.key) || (e.key === ',' && !_skNumBuf.includes(','))) {
      _skNumBuf += e.key; _skNumShow(); e.preventDefault(); return;
    }
    if (e.key === 'Backspace' && _skNumBuf) {
      _skNumBuf = _skNumBuf.slice(0, -1); _skNumShow(); e.preventDefault(); return;
    }
    if (e.key === 'Enter' && _skNumBuf) { _skNumCommit(); e.preventDefault(); return; }
    if (e.key === 'Escape') { _skNumBuf = ''; _skNumShow(); drawState = null; chain = null; render(); return; }
  }
  // [V4.7.3] Ctrl/Cmd d'abord — et surtout AVANT le switch des raccourcis à une
  // lettre : sans ce garde, Ctrl+C sélectionnait l'outil Cercle, Ctrl+S l'outil
  // Select, Ctrl+F recadrait… tous les raccourcis système du navigateur
  // déclenchaient un changement d'outil.
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { skUndo(); e.preventDefault(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { skRedo(); e.preventDefault(); }
    return;   // aucun raccourci à une lettre ne doit passer avec un modificateur
  }

  switch (e.key) {
    case 'Escape': _skNumBuf = ''; _skNumShow(); drawState = null; chain = null;
                   _skBand = null; _skGrip = null; _skFilletPick = null; render(); break;
    case 's': case 'S': setTool('select'); break;
    case 'l': case 'L': setTool('line');   break;
    case 'c': case 'C': setTool('circle'); break;
    case 'r': case 'R': setTool('rect');   break;
    case 'a': case 'A': setTool('arc');    break;
    case 'p': case 'P': setTool('point');  break;
    case 'b': case 'B': setTool('bezier'); break;
    case 'x': case 'X': setTool('trim');   break;
    case 'e': case 'E': setTool('extend'); break;
    case 'k': case 'K': setTool('fillet'); break;
    case 'f': case 'F': fitView();         break;
    case 'g': case 'G': toggleGrid();      break;
    case 't': case 'T': toggleTheme();     break;
    case 'Delete': case 'Backspace': deleteSelected(); break;
  }
});

// ────────────────────────────────────────────────────────────
//  ARC FROM 3 POINTS  (start, end, apex/through-point)
//  Fits the circle through all 3 points, then picks whichever of the
//  two possible sweeps (CW / CCW) from start->end actually passes
//  through the apex, so the arc always closes correctly on its own.
// ────────────────────────────────────────────────────────────
function angNorm(a) { let v = a % (Math.PI * 2); if (v < 0) v += Math.PI * 2; return v; }

function arcFrom3Points(x1, y1, x2, y2, x3, y3) {
  // (x1,y1)=start A, (x2,y2)=end B, (x3,y3)=apex/through-point C
  const ax = x1, ay = y1, bx = x2, by = y2, cx = x3, cy = y3;
  const d  = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax*ax + ay*ay)*(by - cy) + (bx*bx + by*by)*(cy - ay) + (cx*cx + cy*cy)*(ay - by)) / d;
  const uy = ((ax*ax + ay*ay)*(cx - bx) + (bx*bx + by*by)*(ax - cx) + (cx*cx + cy*cy)*(bx - ax)) / d;
  const r  = Math.hypot(ax - ux, ay - uy);
  if (!isFinite(r) || r < 1e-9) return null;

  const aA = Math.atan2(ay - uy, ax - ux);
  const aB = Math.atan2(by - uy, bx - ux);
  const aC = Math.atan2(cy - uy, cx - ux);

  const ccwSpanAB = angNorm(aB - aA);   // CCW sweep amount from A to B
  const ccwSpanAC = angNorm(aC - aA);   // CCW sweep amount from A to C
  const ccw = ccwSpanAC <= ccwSpanAB;   // does the apex lie on the CCW(A->B) path?

  return { cx: ux, cy: uy, r, a1: aA, a2: aB, ccw };
}

// ────────────────────────────────────────────────────────────
//  BEZIER HELPERS (cubic: P0 start, P1/P2 controls, P3 end)
// ────────────────────────────────────────────────────────────
function bezierPointAt(e, t) {
  const mt = 1 - t;
  const x = mt*mt*mt*e.x0 + 3*mt*mt*t*e.x1 + 3*mt*t*t*e.x2 + t*t*t*e.x3;
  const y = mt*mt*mt*e.y0 + 3*mt*mt*t*e.y1 + 3*mt*t*t*e.y2 + t*t*t*e.y3;
  return { x, y };
}
function bezierLength(e, N = 24) {
  let len = 0, prev = bezierPointAt(e, 0);
  for (let i = 1; i <= N; i++) { const p = bezierPointAt(e, i / N); len += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
  return len;
}
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx*dx + dy*dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// ────────────────────────────────────────────────────────────
//  RENDER
// ────────────────────────────────────────────────────────────
const THEMES = {
  dark: {
    canvasBg:        '#0b0d13',
    gridMinor:       'rgba(255,255,255,0.035)',
    gridMajor:       'rgba(255,255,255,0.08)',
    axis:            'rgba(255,255,255,0.18)',
    axisText:        'rgba(255,255,255,0.35)',
    entity:          '#4a8fff',
    sel:             '#ff9f43',
    hover:           '#7dd3fc',
    temp:            'rgba(74,143,255,0.55)',
    point:           '#4a8fff',
    dimText:         '#ffc24d',
    dimBg:           'rgba(10,12,18,0.85)',
    snap:            '#2ecc71',
    constr:          '#a78bfa',
    close:           '#ffd23f',
    workspaceBorder: 'rgba(255,180,50,0.30)',
  },
  light: {
    canvasBg:        '#ffffff',
    gridMinor:       'rgba(20,26,40,0.06)',
    gridMajor:       'rgba(20,26,40,0.13)',
    axis:            'rgba(20,26,40,0.32)',
    axisText:        'rgba(20,26,40,0.5)',
    entity:          '#2f6fed',
    sel:             '#c2670a',
    hover:           '#0284c7',
    temp:            'rgba(47,111,237,0.55)',
    point:           '#2f6fed',
    dimText:         '#14181f',
    dimBg:           'rgba(255,255,255,0.92)',
    snap:            '#15803d',
    constr:          '#7c3aed',
    close:           '#b45309',
    workspaceBorder: 'rgba(50,90,180,0.28)',
  },
};
let theme  = 'dark';
let COLORS = THEMES.dark;

function setTheme(name) {
  theme  = (name === 'light') ? 'light' : 'dark';
  COLORS = THEMES[theme];
  _skRoot.setAttribute('data-theme', theme);
  try { localStorage.setItem('nasscad-sketch-theme', theme); } catch (err) { /* storage unavailable */ }
  const btn = document.getElementById('sk-btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
  render();
}
function toggleTheme() { setTheme(theme === 'dark' ? 'light' : 'dark'); }

function render() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = COLORS.canvasBg;
  ctx.fillRect(0, 0, W, H);

  // Grid
  if (showGrid) drawGrid();

  // 3D workspace border (liseré pointillé = empreinte grille 3D GS×GS mm)
  drawWorkspaceBorder();

  // Axes
  drawAxes();

  // Entities
  for (const e of entities) {
    const isSel   = selected.has(e.id);
    const isHover = !isSel && activeTool === 'select' && snapInfo && hitTest(e, snapInfo.wx, snapInfo.wy);
    drawEntity(e, isSel, isHover);
  }

  // In-progress drawing
  drawTemp();

  // [V4.7.3] poignées des entités sélectionnées + rectangle élastique
  drawGrips();
  drawBand();

  // Snap indicator
  if (snapInfo && snapInfo.type) drawSnapIndicator(snapInfo);
}

function drawWorkspaceBorder() {
  const gs   = (typeof GS !== 'undefined' ? GS : 220); // récupère GS du scope global
  const half = gs / 2;
  const tl   = worldToScreen(-half,  half);
  const br   = worldToScreen( half, -half);
  const w    = br.sx - tl.sx;
  const h    = br.sy - tl.sy;
  if (w < 4 || h < 4) return; // trop petit à l'écran, ne pas dessiner
  ctx.save();
  ctx.strokeStyle = COLORS.workspaceBorder;
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([8, 5]);
  ctx.strokeRect(tl.sx, tl.sy, w, h);
  ctx.setLineDash([]);
  ctx.font          = '10px system-ui';
  ctx.fillStyle     = COLORS.workspaceBorder;
  ctx.textAlign     = 'left';
  ctx.textBaseline  = 'bottom';
  ctx.fillText('\u2B21 3D grid ' + gs + '\xD7' + gs + ' mm', tl.sx + 4, tl.sy - 3);
  ctx.restore();
}

function drawGrid() {
  const W = canvas.width, H = canvas.height;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(W, H);

  function drawLines(step, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    const x0 = Math.floor(tl.wx / step) * step;
    const x1 = Math.ceil(br.wx  / step) * step;
    const y0 = Math.floor(br.wy / step) * step;
    const y1 = Math.ceil(tl.wy  / step) * step;
    for (let x = x0; x <= x1; x += step) {
      const s = worldToScreen(x, 0);
      ctx.moveTo(s.sx, 0); ctx.lineTo(s.sx, H);
    }
    for (let y = y0; y <= y1; y += step) {
      const s = worldToScreen(0, y);
      ctx.moveTo(0, s.sy); ctx.lineTo(W, s.sy);
    }
    ctx.stroke();
  }

  if (view.scale > 0.3) drawLines(GRID_MINOR, COLORS.gridMinor);
  drawLines(GRID_MAJOR, COLORS.gridMajor);
}

function drawAxes() {
  const W = canvas.width, H = canvas.height;
  const ox = worldToScreen(0, 0);
  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(0, ox.sy); ctx.lineTo(W, ox.sy);
  ctx.moveTo(ox.sx, 0); ctx.lineTo(ox.sx, H);
  ctx.stroke();

  // Axis labels
  ctx.fillStyle = COLORS.axisText;
  ctx.font = '10px system-ui';
  ctx.fillText('X', W - 14, ox.sy - 5);
  ctx.fillText('Y', ox.sx + 5, 12);
  ctx.fillText('O', ox.sx + 3, ox.sy - 3);
}

function drawEntity(e, isSel, isHover) {
  const color = isSel ? COLORS.sel : (isHover ? COLORS.hover : COLORS.entity);
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.lineWidth   = isSel ? 2 : 1.5;

  switch (e.type) {
    case 'point': {
      const p = worldToScreen(e.x, e.y);
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, isSel ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'line': {
      const p1 = worldToScreen(e.x1, e.y1), p2 = worldToScreen(e.x2, e.y2);
      ctx.beginPath(); ctx.moveTo(p1.sx, p1.sy); ctx.lineTo(p2.sx, p2.sy); ctx.stroke();
      // Endpoint dots
      [p1, p2].forEach(p => {
        ctx.beginPath(); ctx.arc(p.sx, p.sy, 2.5, 0, Math.PI * 2); ctx.fill();
      });
      // Dimension if selected
      if (isSel) {
        const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1).toFixed(2);
        const mx = (p1.sx + p2.sx) / 2, my = (p1.sy + p2.sy) / 2;
        drawDimLabel(mx, my - 10, `${len}`);
      }
      break;
    }
    case 'rect': {
      const p1 = worldToScreen(e.x1, e.y1), p2 = worldToScreen(e.x2, e.y2);
      const rx = Math.min(p1.sx, p2.sx), ry = Math.min(p1.sy, p2.sy);
      const rw = Math.abs(p2.sx - p1.sx), rh = Math.abs(p2.sy - p1.sy);
      ctx.strokeRect(rx, ry, rw, rh);
      const _COT = 18;
      _skDrawCot(rx, ry + rh + _COT, rx + rw, ry + rh + _COT,
                 Math.abs(e.x2-e.x1).toFixed(1), isSel);   // W below
      _skDrawCot(rx + rw + _COT, ry, rx + rw + _COT, ry + rh,
                 Math.abs(e.y2-e.y1).toFixed(1), isSel);   // H right
      break;
    }
    case 'circle': {
      const pc = worldToScreen(e.cx, e.cy), rs = wdist(e.r);
      ctx.beginPath(); ctx.arc(pc.sx, pc.sy, rs, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(pc.sx, pc.sy, 2.5, 0, Math.PI * 2); ctx.fill();
      // Radius cot at 45° (top-right)
      const _C45 = 0.7071;
      _skDrawCot(pc.sx, pc.sy,
                 pc.sx + rs * _C45, pc.sy - rs * _C45,
                 `R ${e.r.toFixed(1)}`, isSel);
      break;
    }
    case 'arc': {
      const pc = worldToScreen(e.cx, e.cy), rs = wdist(e.r);
      ctx.beginPath(); ctx.arc(pc.sx, pc.sy, rs, -e.a1, -e.a2, e.ccw); ctx.stroke();
      const sp = arcStartPoint(e), ep = arcEndPoint(e);
      [sp, ep].forEach(p => {
        const ps = worldToScreen(p.x, p.y);
        ctx.beginPath(); ctx.arc(ps.sx, ps.sy, 2, 0, Math.PI * 2); ctx.fill();
      });
      break;
    }
    case 'bezier': {
      const p0 = worldToScreen(e.x0, e.y0), p1 = worldToScreen(e.x1, e.y1);
      const p2 = worldToScreen(e.x2, e.y2), p3 = worldToScreen(e.x3, e.y3);
      ctx.beginPath();
      ctx.moveTo(p0.sx, p0.sy);
      ctx.bezierCurveTo(p1.sx, p1.sy, p2.sx, p2.sy, p3.sx, p3.sy);
      ctx.stroke();
      [p0, p3].forEach(p => { ctx.beginPath(); ctx.arc(p.sx, p.sy, 2.5, 0, Math.PI * 2); ctx.fill(); });
      if (isSel) {
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = COLORS.constr;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy); ctx.lineTo(p1.sx, p1.sy);
        ctx.moveTo(p3.sx, p3.sy); ctx.lineTo(p2.sx, p2.sy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = COLORS.constr;
        [p1, p2].forEach(p => { ctx.beginPath(); ctx.arc(p.sx, p.sy, 3, 0, Math.PI * 2); ctx.fill(); });
        ctx.restore();
        const len = bezierLength(e).toFixed(2);
        const mid = bezierPointAt(e, 0.5);
        const pm  = worldToScreen(mid.x, mid.y);
        drawDimLabel(pm.sx, pm.sy - 10, `${len}`);
      }
      break;
    }
  }

  // Constraint badges
  if (e.constraints && e.constraints.length) {
    const cp = entityCenterScreen(e);
    ctx.fillStyle = COLORS.constr;
    ctx.font = '8px system-ui';
    ctx.fillText(e.constraints.map(c => c[0].toUpperCase()).join(' '), cp.sx + 6, cp.sy - 4);
  }
}

function entityCenterScreen(e) {
  switch (e.type) {
    case 'point':  return worldToScreen(e.x, e.y);
    case 'line':   return worldToScreen((e.x1+e.x2)/2, (e.y1+e.y2)/2);
    case 'rect':   return worldToScreen((e.x1+e.x2)/2, (e.y1+e.y2)/2);
    case 'circle':
    case 'arc':    return worldToScreen(e.cx, e.cy);
    case 'bezier': { const m = bezierPointAt(e, 0.5); return worldToScreen(m.x, m.y); }
    default:       return { sx: 0, sy: 0 };
  }
}

function drawDimLabel(sx, sy, text) {
  ctx.save();
  ctx.font = 'bold 10px "JetBrains Mono", Consolas, monospace';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = COLORS.dimBg;
  ctx.fillRect(sx - w/2 - 3, sy - 10, w + 6, 13);
  ctx.fillStyle = COLORS.dimText;
  ctx.textAlign = 'center';
  ctx.fillText(text, sx, sy);
  ctx.restore();
}

function drawTemp() {
  if (!drawState) return;
  const { wx: mx, wy: my } = snapInfo || mouse;

  ctx.strokeStyle = COLORS.temp;
  ctx.fillStyle   = COLORS.temp;
  ctx.lineWidth   = 1;
  ctx.setLineDash([5, 4]);

  switch (activeTool) {
    case 'line': {
      const p1 = worldToScreen(drawState.x1, drawState.y1);
      const p2 = worldToScreen(mx, my);
      ctx.beginPath(); ctx.moveTo(p1.sx, p1.sy); ctx.lineTo(p2.sx, p2.sy); ctx.stroke();
      ctx.setLineDash([]);
      // Start point
      ctx.beginPath(); ctx.arc(p1.sx, p1.sy, 3, 0, Math.PI*2); ctx.fill();
      const len = Math.hypot(mx - drawState.x1, my - drawState.y1).toFixed(2);
      const ang = (Math.atan2(my - drawState.y1, mx - drawState.x1) * 180 / Math.PI).toFixed(1);
      drawDimLabel((p1.sx+p2.sx)/2, (p1.sy+p2.sy)/2 - 12, `${len}  ${ang}°`);
      break;
    }
    case 'rect': {
      const p1 = worldToScreen(drawState.x1, drawState.y1);
      const p2 = worldToScreen(mx, my);
      ctx.strokeRect(Math.min(p1.sx,p2.sx), Math.min(p1.sy,p2.sy),
                     Math.abs(p2.sx-p1.sx), Math.abs(p2.sy-p1.sy));
      break;
    }
    case 'circle': {
      const pc = worldToScreen(drawState.cx, drawState.cy);
      const r  = wdist(Math.hypot(mx - drawState.cx, my - drawState.cy));
      ctx.beginPath(); ctx.arc(pc.sx, pc.sy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(pc.sx, pc.sy, 3, 0, Math.PI*2); ctx.fill();
      drawDimLabel(pc.sx, pc.sy - r - 10, `r=${(r/view.scale).toFixed(2)}`);
      break;
    }
    case 'arc': {
      if (drawState.phase === 1) {
        const p1 = worldToScreen(drawState.x1, drawState.y1);
        const p2 = worldToScreen(mx, my);
        ctx.beginPath(); ctx.moveTo(p1.sx, p1.sy); ctx.lineTo(p2.sx, p2.sy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(p1.sx, p1.sy, 3, 0, Math.PI*2); ctx.fill();
      } else if (drawState.phase === 2) {
        ctx.setLineDash([]);
        const arc = arcFrom3Points(drawState.x1, drawState.y1, drawState.x2, drawState.y2, mx, my);
        if (arc) {
          const pc = worldToScreen(arc.cx, arc.cy);
          ctx.strokeStyle = COLORS.temp;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(pc.sx, pc.sy, wdist(arc.r), -arc.a1, -arc.a2, arc.ccw); ctx.stroke();
        }
      }
      break;
    }
    case 'bezier': {
      ctx.setLineDash([]);
      if (drawState.phase === 1) {
        const p0 = worldToScreen(drawState.x0, drawState.y0);
        const p3 = worldToScreen(mx, my);
        ctx.beginPath(); ctx.moveTo(p0.sx, p0.sy); ctx.lineTo(p3.sx, p3.sy); ctx.stroke();
        ctx.beginPath(); ctx.arc(p0.sx, p0.sy, 3, 0, Math.PI*2); ctx.fill();
      } else if (drawState.phase === 2) {
        const p0 = worldToScreen(drawState.x0, drawState.y0);
        const p3 = worldToScreen(drawState.x3, drawState.y3);
        const pm = worldToScreen(mx, my);
        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy);
        ctx.quadraticCurveTo(pm.sx, pm.sy, p3.sx, p3.sy);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(p0.sx, p0.sy, 3, 0, Math.PI*2); ctx.arc(p3.sx, p3.sy, 3, 0, Math.PI*2); ctx.fill();
      } else if (drawState.phase === 3) {
        const p0 = worldToScreen(drawState.x0, drawState.y0);
        const p1 = worldToScreen(drawState.x1, drawState.y1);
        const p3 = worldToScreen(drawState.x3, drawState.y3);
        const p2 = worldToScreen(mx, my);
        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy);
        ctx.bezierCurveTo(p1.sx, p1.sy, p2.sx, p2.sy, p3.sx, p3.sy);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(p0.sx, p0.sy, 3, 0, Math.PI*2); ctx.arc(p3.sx, p3.sy, 3, 0, Math.PI*2); ctx.fill();
      }
      break;
    }
  }
  ctx.setLineDash([]);
}

function drawSnapIndicator(snap) {
  const p = worldToScreen(snap.wx, snap.wy);

  if (snap.type === 'close') {
    ctx.strokeStyle = COLORS.close;
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, 8, 0, Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.arc(p.sx, p.sy, 3, 0, Math.PI*2); ctx.stroke();
    return;
  }

  ctx.strokeStyle = COLORS.snap;
  ctx.lineWidth   = 1;

  switch (snap.type) {
    case 'endpoint':
      ctx.strokeRect(p.sx - 5, p.sy - 5, 10, 10);
      break;
    case 'midpoint':
      ctx.beginPath();
      ctx.moveTo(p.sx - 5, p.sy + 5);
      ctx.lineTo(p.sx, p.sy - 5);
      ctx.lineTo(p.sx + 5, p.sy + 5);
      ctx.closePath(); ctx.stroke();
      break;
    case 'center':
      ctx.beginPath(); ctx.arc(p.sx, p.sy, 5, 0, Math.PI*2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p.sx - 7, p.sy); ctx.lineTo(p.sx + 7, p.sy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p.sx, p.sy - 7); ctx.lineTo(p.sx, p.sy + 7); ctx.stroke();
      break;
    case 'grid':
      ctx.beginPath();
      ctx.moveTo(p.sx - 4, p.sy); ctx.lineTo(p.sx + 4, p.sy);
      ctx.moveTo(p.sx, p.sy - 4); ctx.lineTo(p.sx, p.sy + 4);
      ctx.stroke();
      break;
    case 'intersection':   // [V4.7.3] croix en X, distincte de la croix droite de la grille
      ctx.beginPath();
      ctx.moveTo(p.sx - 6, p.sy - 6); ctx.lineTo(p.sx + 6, p.sy + 6);
      ctx.moveTo(p.sx + 6, p.sy - 6); ctx.lineTo(p.sx - 6, p.sy + 6);
      ctx.stroke();
      break;
  }
}

// ────────────────────────────────────────────────────────────
//  UI UPDATES
// ────────────────────────────────────────────────────────────
function updateEntityList() {
  const list = document.getElementById('sk-entity-list');
  if (!entities.length) { list.innerHTML = '<div class="empty-hint">No entities yet</div>'; return; }
  list.innerHTML = entities.map(e => {
    const dotClass = `dot-${e.type === 'point' ? 'line' : e.type}`;
    const label = entityLabel(e);
    return `<div class="entity-item${selected.has(e.id)?' selected':''}" onclick="selectEntity(${e.id})">
      <div class="entity-dot ${dotClass}"></div>${label}</div>`;
  }).join('');
}

function entityLabel(e) {
  switch (e.type) {
    case 'point':  return `Pt #${e.id}`;
    case 'line':   return `Ln #${e.id}`;
    case 'rect':   return `Rc #${e.id}`;
    case 'circle': return `Ci #${e.id} r=${e.r.toFixed(1)}`;
    case 'arc':    return `Ar #${e.id}`;
    case 'bezier': return `Bz #${e.id}`;
    default: return `#${e.id}`;
  }
}

function selectEntity(id) {
  selected.clear(); selected.add(id);
  updateProps(); updateEntityList(); render();
}

function updateProps() {
  updateEntityList();
  const box = document.getElementById('sk-props-content');
  if (!selected.size) { box.innerHTML = '<div class="empty-hint">Select an entity</div>'; return; }
  const e = entities.find(en => selected.has(en.id));
  if (!e) { box.innerHTML = '<div class="empty-hint">Select an entity</div>'; return; }

  let rows = '';
  const field = (label, key, val) =>
    `<div class="prop-row"><span class="prop-label">${label}</span>
     <input class="prop-val" value="${parseFloat(val).toFixed(3)}"
       onchange="updateProp(${e.id},'${key}',this.value)"></div>`;

  switch (e.type) {
    case 'point':  rows = field('X', 'x', e.x) + field('Y', 'y', e.y); break;
    case 'line':   rows = field('X1','x1',e.x1)+field('Y1','y1',e.y1)+field('X2','x2',e.x2)+field('Y2','y2',e.y2); break;
    case 'rect': { const _rx=Math.min(e.x1,e.x2),_ry=Math.min(e.y1,e.y2); rows=field('X','rx',_rx)+field('Y','ry',_ry)+field('W','rw',Math.abs(e.x2-e.x1))+field('H','rh',Math.abs(e.y2-e.y1)); } break;
    case 'circle': rows = field('CX','cx',e.cx)+field('CY','cy',e.cy)+field('R','r',e.r); break;
    case 'arc':    rows = field('CX','cx',e.cx)+field('CY','cy',e.cy)+field('R','r',e.r); break;
    case 'bezier':
      rows = field('X0','x0',e.x0)+field('Y0','y0',e.y0)+field('X1','x1',e.x1)+field('Y1','y1',e.y1)+
             field('X2','x2',e.x2)+field('Y2','y2',e.y2)+field('X3','x3',e.x3)+field('Y3','y3',e.y3);
      break;
  }
  box.innerHTML = `<div style="color:var(--text-dim);font-size:10px;margin-bottom:4px;font-weight:700;letter-spacing:0.05em">${e.type.toUpperCase()} #${e.id}</div>${rows}`;
}

function updateProp(id, key, val) {
  const e = entities.find(en => en.id === id);
  if (!e) return;
  const _u = _skSnapshot();   // [V4.7.3] undo — éditer une cote au clavier s'annule aussi
  const v = parseFloat(val);
  if (e.type === 'rect' && (key === 'rx' || key === 'ry' || key === 'rw' || key === 'rh')) {
    const x1 = Math.min(e.x1, e.x2), x2 = Math.max(e.x1, e.x2);
    const y1 = Math.min(e.y1, e.y2), y2 = Math.max(e.y1, e.y2);
    if      (key === 'rx') { const d = v - x1; e.x1 += d; e.x2 += d; }
    else if (key === 'ry') { const d = v - y1; e.y1 += d; e.y2 += d; }
    else if (key === 'rw') { e.x1 = x1; e.x2 = x1 + Math.max(0.1, v); }
    else if (key === 'rh') { e.y1 = y1; e.y2 = y1 + Math.max(0.1, v); }
  } else {
    e[key] = v;
  }
  _skCommit(_u);
  updateProps(); render();
}

function updateStatusCount() {
  document.getElementById('sk-sb-count').textContent = entities.length;
}

// ────────────────────────────────────────────────────────────
//  CONSTRAINTS
// ────────────────────────────────────────────────────────────
// [V4.7.2] Avant : seuls 'horizontal' et 'vertical' agissaient réellement ; les 6
// autres boutons se contentaient d'empiler une étiquette dans e.constraints —
// le bouton s'allumait, la géométrie ne bougeait pas. Ils sont maintenant tous
// appliqués immédiatement, dans l'esprit du module : application directe, PAS de
// solveur itératif (pas de résolution simultanée d'un système de contraintes —
// une contrainte s'applique au moment du clic et n'est pas re-maintenue ensuite
// si l'entité est déplacée après coup). C'est volontaire : un vrai solveur est un
// chantier disproportionné ici, et ce comportement-là est déjà celui qu'avaient
// horizontal/vertical depuis le début.
//
// Convention multi-sélection : la PREMIÈRE entité sélectionnée est la RÉFÉRENCE,
// elle ne bouge pas ; les suivantes s'y alignent. Une entité marquée 'fixed'
// n'est jamais déplacée, ni par une contrainte ni par un drag souris.
function _skIsFixed(e) { return !!(e && e.constraints && e.constraints.includes('fixed')); }
function _skHint(msg) {
  const el = document.getElementById('sk-hint-text');
  if (el) el.textContent = msg;
}
// Points d'ancrage significatifs (≠ entityPoints : exclut les poignées de Bézier)
function _skAnchors(e) {
  switch (e.type) {
    case 'point':  return [[e.x, e.y]];
    case 'line':   return [[e.x1, e.y1], [e.x2, e.y2]];
    case 'rect':   return [[e.x1, e.y1], [e.x2, e.y1], [e.x2, e.y2], [e.x1, e.y2]];
    case 'circle': return [[e.cx, e.cy]];
    case 'arc': {
      const p1 = arcStartPoint(e), p2 = arcEndPoint(e);
      return [[p1.x, p1.y], [p2.x, p2.y]];
    }
    case 'bezier': return [[e.x0, e.y0], [e.x3, e.y3]];
    default: return [];
  }
}
// Angle ramené dans ]-π, π] — pour comparer deux directions sans saut de 2π
function _skWrapPi(v) {
  let x = v % (Math.PI * 2);
  if (x >  Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
}
// Fait pivoter une ligne autour de son milieu jusqu'à l'angle voulu, en gardant
// sa longueur ET en choisissant celle des deux orientations (a ou a+π) la plus
// proche de l'actuelle — sinon appliquer "parallèle" retournerait la ligne bout
// pour bout une fois sur deux, ce qui casserait les chaînes déjà tracées.
function _skRotateLineTo(e, ang) {
  const mx = (e.x1 + e.x2) / 2, my = (e.y1 + e.y2) / 2;
  const L   = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  if (L < 1e-9) return;
  const cur = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
  const a   = Math.abs(_skWrapPi(cur - ang)) <= Math.abs(_skWrapPi(cur - ang - Math.PI))
            ? ang : ang + Math.PI;
  e.x1 = mx - L / 2 * Math.cos(a); e.y1 = my - L / 2 * Math.sin(a);
  e.x2 = mx + L / 2 * Math.cos(a); e.y2 = my + L / 2 * Math.sin(a);
}
// Mesure caractéristique : longueur (ligne) ou rayon (cercle/arc)
function _skMeasure(e) {
  if (e.type === 'line')   return { kind: 'len', v: Math.hypot(e.x2 - e.x1, e.y2 - e.y1) };
  if (e.type === 'circle' || e.type === 'arc') return { kind: 'rad', v: e.r };
  return null;
}
function _skSetMeasure(e, m) {
  if (m.kind === 'len' && e.type === 'line') {
    const L = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    if (L < 1e-9) return false;
    e.x2 = e.x1 + (e.x2 - e.x1) / L * m.v;   // garde le point de départ et la direction
    e.y2 = e.y1 + (e.y2 - e.y1) / L * m.v;
    return true;
  }
  if (m.kind === 'rad' && (e.type === 'circle' || e.type === 'arc')) { e.r = m.v; return true; }
  return false;
}
// Déplace l'entité e pour que son ancrage le plus proche vienne sur celui de ref.
// Ligne/Bézier : seule l'extrémité concernée bouge (la poignée Bézier suit, sinon
// la tangente de départ partirait n'importe où). Arc/cercle/rect/point : translation
// complète, car déplacer un seul point déformerait l'entité.
function _skSnapTogether(ref, e) {
  const A = _skAnchors(ref), B = _skAnchors(e);
  if (!A.length || !B.length) return false;
  let best = null;
  for (const a of A) for (const b of B) {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (!best || d < best.d) best = { d, a, b };
  }
  const dx = best.a[0] - best.b[0], dy = best.a[1] - best.b[1];
  const near = (px, py) => Math.hypot(px - best.b[0], py - best.b[1]) < 1e-9;
  switch (e.type) {
    case 'point': e.x += dx; e.y += dy; break;
    case 'line':
      if (near(e.x1, e.y1)) { e.x1 += dx; e.y1 += dy; }
      else                  { e.x2 += dx; e.y2 += dy; }
      break;
    case 'bezier':
      if (near(e.x0, e.y0)) { e.x0 += dx; e.y0 += dy; e.x1 += dx; e.y1 += dy; }
      else                  { e.x3 += dx; e.y3 += dy; e.x2 += dx; e.y2 += dy; }
      break;
    case 'circle': case 'arc': e.cx += dx; e.cy += dy; break;
    case 'rect': e.x1 += dx; e.y1 += dy; e.x2 += dx; e.y2 += dy; break;
    default: return false;
  }
  return true;
}

function applyConstraint(type) {
  const ents = [...selected].map(id => entities.find(en => en.id === id)).filter(Boolean);
  if (!ents.length) { _skHint('Select at least one entity first.'); return; }
  const _u = _skSnapshot();   // [V4.7.3] undo — _skCommit ignore les cas sans effet
  const ref  = ents[0];
  const rest = ents.slice(1);
  const tag  = (e, t) => { if (!e.constraints.includes(t)) e.constraints.push(t); };
  let n = 0;

  switch (type) {
    // 'fixed' est la seule contrainte à 1 entité, et la seule qui bascule
    case 'fixed':
      for (const e of ents) {
        const i = e.constraints.indexOf('fixed');
        if (i >= 0) e.constraints.splice(i, 1); else e.constraints.push('fixed');
      }
      _skHint(`Fixed toggled on ${ents.length} entity(ies) — they no longer move on drag.`);
      break;

    case 'horizontal':
    case 'vertical':
      for (const e of ents) {
        if (e.type !== 'line' || _skIsFixed(e)) continue;
        if (type === 'horizontal') e.y2 = e.y1; else e.x2 = e.x1;
        tag(e, type); n++;
      }
      _skHint(n ? `${type} applied to ${n} line(s).` : `${type}: select at least one non-fixed line.`);
      break;

    case 'equal': {
      if (rest.length < 1) { _skHint('Equal: select 2+ entities — the first one is the reference.'); break; }
      const m = _skMeasure(ref);
      if (!m) { _skHint('Equal: the reference must be a line, a circle or an arc.'); break; }
      for (const e of rest) {
        if (_skIsFixed(e)) continue;
        if (_skSetMeasure(e, m)) { tag(e, 'equal'); n++; }
      }
      if (n) tag(ref, 'equal');
      _skHint(n ? `Equal: ${n} entity(ies) matched to ${m.kind === 'len' ? 'length' : 'radius'} ${m.v.toFixed(2)}.`
                : 'Equal: no compatible entity (line↔line, or circle/arc↔circle/arc).');
      break;
    }

    case 'parallel':
    case 'perp': {
      if (rest.length < 1) { _skHint('Parallel/Perp: select 2+ entities — the first one is the reference.'); break; }
      if (ref.type !== 'line') { _skHint('Parallel/Perp: the reference (first selected) must be a line.'); break; }
      const base = Math.atan2(ref.y2 - ref.y1, ref.x2 - ref.x1)
                 + (type === 'perp' ? Math.PI / 2 : 0);
      for (const e of rest) {
        if (e.type !== 'line' || _skIsFixed(e)) continue;
        _skRotateLineTo(e, base); tag(e, type); n++;
      }
      if (n) tag(ref, type);
      _skHint(n ? `${type === 'perp' ? 'Perpendicular' : 'Parallel'} applied to ${n} line(s).`
                : 'Parallel/Perp: no other non-fixed line selected.');
      break;
    }

    case 'tangent': {
      const line = ents.find(e => e.type === 'line');
      const circ = ents.find(e => e.type === 'circle' || e.type === 'arc');
      if (!line || !circ) { _skHint('Tangent: select one line AND one circle/arc.'); break; }
      if (_skIsFixed(line)) { _skHint('Tangent: that line is fixed — unfix it first.'); break; }
      const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
      const L  = Math.hypot(dx, dy);
      if (L < 1e-9) { _skHint('Tangent: degenerate line.'); break; }
      // Translation de la ligne le long de sa propre normale jusqu'à ce que sa
      // distance au centre vaille exactement r. On garde le côté d'origine
      // (signe de d) pour ne pas faire sauter la ligne de l'autre côté du cercle.
      const nx = -dy / L, ny = dx / L;
      const d  = (circ.cx - line.x1) * nx + (circ.cy - line.y1) * ny;
      const s  = d - (d >= 0 ? 1 : -1) * circ.r;
      line.x1 += nx * s; line.y1 += ny * s;
      line.x2 += nx * s; line.y2 += ny * s;
      tag(line, 'tangent'); tag(circ, 'tangent');
      _skHint(`Tangent: line moved onto the circle (r=${circ.r.toFixed(2)}).`);
      break;
    }

    case 'coincident': {
      if (rest.length < 1) { _skHint('Coincident: select 2+ entities — the first one is the reference.'); break; }
      for (const e of rest) {
        if (_skIsFixed(e)) continue;
        if (_skSnapTogether(ref, e)) { tag(e, 'coincident'); n++; }
      }
      if (n) tag(ref, 'coincident');
      _skHint(n ? `Coincident: ${n} entity(ies) snapped onto the reference.`
                : 'Coincident: no movable entity to snap.');
      break;
    }

    default:
      for (const e of ents) tag(e, type);
      break;
  }
  _skCommit(_u);
  updateProps(); updateEntityList(); render();
}

// ────────────────────────────────────────────────────────────
//  SNAP TOGGLES
// ────────────────────────────────────────────────────────────
function toggleSnap(key, el) {
  snaps[key] = !snaps[key];
  el.classList.toggle('on', snaps[key]);
}

// ────────────────────────────────────────────────────────────
//  VIEW CONTROLS
// ────────────────────────────────────────────────────────────
function fitView() {
  if (!entities.length) { view = { x: canvas.width/2, y: canvas.height/2, scale: 1 }; render(); return; }
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const e of entities) {
    for (const [px, py] of entityPoints(e)) {
      minx = Math.min(minx, px); maxx = Math.max(maxx, px);
      miny = Math.min(miny, py); maxy = Math.max(maxy, py);
    }
    if (e.type === 'circle' || e.type === 'arc') {
      minx = Math.min(minx, e.cx - e.r); maxx = Math.max(maxx, e.cx + e.r);
      miny = Math.min(miny, e.cy - e.r); maxy = Math.max(maxy, e.cy + e.r);
    }
  }
  const W = canvas.width, H = canvas.height;
  const pad = 60;
  const sx = (W - pad*2) / (maxx - minx || 1);
  const sy = (H - pad*2) / (maxy - miny || 1);
  view.scale = Math.min(sx, sy, 50);
  view.x = W/2 - ((minx + maxx) / 2) * view.scale;
  view.y = H/2 + ((miny + maxy) / 2) * view.scale;
  document.getElementById('sk-sb-zoom').textContent = Math.round(view.scale * 100) + '%';
  render();
}

function toggleGrid() {
  showGrid = !showGrid;
  document.getElementById('sk-btn-grid').classList.toggle('active', showGrid);
  render();
}

// ────────────────────────────────────────────────────────────
//  EXPORT NASSSCRIPT
// ────────────────────────────────────────────────────────────
function exportNass() {
  if (!entities.length) { alert('No entities to export.'); return; }
  let lines = ['// NASSCAD 2D Sketch — exported from Sketcher v0.1', ''];
  for (const e of entities) {
    switch (e.type) {
      case 'point':
        lines.push(`Sketch.Point({ x:${e.x.toFixed(3)}, y:${e.y.toFixed(3)} });`); break;
      case 'line':
        lines.push(`Sketch.Line({ x1:${e.x1.toFixed(3)}, y1:${e.y1.toFixed(3)}, x2:${e.x2.toFixed(3)}, y2:${e.y2.toFixed(3)} });`); break;
      case 'rect':
        lines.push(`Sketch.Rect({ x1:${e.x1.toFixed(3)}, y1:${e.y1.toFixed(3)}, x2:${e.x2.toFixed(3)}, y2:${e.y2.toFixed(3)} });`); break;
      case 'circle':
        lines.push(`Sketch.Circle({ cx:${e.cx.toFixed(3)}, cy:${e.cy.toFixed(3)}, r:${e.r.toFixed(3)} });`); break;
      case 'arc':
        lines.push(`Sketch.Arc({ cx:${e.cx.toFixed(3)}, cy:${e.cy.toFixed(3)}, r:${e.r.toFixed(3)}, a1:${e.a1.toFixed(4)}, a2:${e.a2.toFixed(4)}, ccw:${!!e.ccw} });`); break;
      case 'bezier':
        lines.push(`Sketch.Bezier({ x0:${e.x0.toFixed(3)}, y0:${e.y0.toFixed(3)}, x1:${e.x1.toFixed(3)}, y1:${e.y1.toFixed(3)}, x2:${e.x2.toFixed(3)}, y2:${e.y2.toFixed(3)}, x3:${e.x3.toFixed(3)}, y3:${e.y3.toFixed(3)} });`); break;
    }
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sketch.nass';
  a.click();
}

// ────────────────────────────────────────────────────────────
//  TOOLBAR CLICK BINDINGS
// ────────────────────────────────────────────────────────────
_skRoot.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

// ════════════════════════════════════════════════════════════════════════════
//  NASSCAD INTEGRATION LAYER — open/close + edit round-trip + extrusion pipeline
//  (_skRoot / _skOpen are declared at the top of the IIFE)
// ════════════════════════════════════════════════════════════════════════════
let _skEditObj = null;   // object being re-edited (null = create-new)
function _skClone(o){ return JSON.parse(JSON.stringify(o)); }

// ── Entity drag state + apply ─────────────────────────────────────────────
let _skDrag = null;   // { startWx, startWy, moved, snap:[...cloned entities] }
function _skApplyDrag(dx, dy) {
  for (const snap of _skDrag.snap) {
    const e = entities.find(en => en.id === snap.id);
    if (!e) continue;
    if (_skIsFixed(e)) continue;   // [V4.7.2] la contrainte 'fixed' bloque le drag
    switch (e.type) {
      case 'point':
        e.x = snap.x + dx; e.y = snap.y + dy; break;
      case 'line': case 'rect':
        e.x1 = snap.x1+dx; e.y1 = snap.y1+dy;
        e.x2 = snap.x2+dx; e.y2 = snap.y2+dy; break;
      case 'circle': case 'arc':
        e.cx = snap.cx+dx; e.cy = snap.cy+dy; break;
      case 'bezier':
        e.x0=snap.x0+dx; e.y0=snap.y0+dy;
        e.x1=snap.x1+dx; e.y1=snap.y1+dy;
        e.x2=snap.x2+dx; e.y2=snap.y2+dy;
        e.x3=snap.x3+dx; e.y3=snap.y3+dy; break;
    }
  }
}

// ── Numeric dimension input ──────────────────────────────────────────────────
let _skNumBuf = '';
function _skNumShow() {
  const el = document.getElementById('sk-dim-input');
  if (!el) return;
  if (!drawState || !_skNumBuf) {
    el.classList.remove('sk-dim-active'); el.innerHTML = ''; return;
  }
  el.classList.add('sk-dim-active');
  const vals = _skNumBuf.split(',');
  let html = '';
  switch (activeTool) {
    case 'rect':
      html = `W <span class="sk-dim-field">${vals[0]||''}</span>`
           + (vals.length > 1 ? `  H <span class="sk-dim-field">${vals[1]}</span>` : '  ,H')
           + ` <span class="sk-dim-cursor"></span>`
           + `  <span style="opacity:.45;font-size:10px">Enter=commit · Esc=cancel</span>`;
      break;
    case 'circle':
      html = `R <span class="sk-dim-field">${vals[0]||''}</span>`
           + `<span class="sk-dim-cursor"></span>`
           + `  <span style="opacity:.45;font-size:10px">Enter=commit · Esc=cancel</span>`;
      break;
    case 'line':
      html = `L <span class="sk-dim-field">${vals[0]||''}</span>`
           + (vals.length > 1 ? `  A° <span class="sk-dim-field">${vals[1]}</span>` : '  ,A°')
           + `<span class="sk-dim-cursor"></span>`
           + `  <span style="opacity:.45;font-size:10px">Enter=commit · Esc=cancel</span>`;
      break;
    default:
      html = `<span class="sk-dim-field">${_skNumBuf}</span><span class="sk-dim-cursor"></span>`;
  }
  el.innerHTML = html;
}
function _skNumCommit() {
  if (!drawState || !_skNumBuf) return;
  const vals = _skNumBuf.split(',').map(v => parseFloat(v));
  const { wx: mx, wy: my } = snapInfo || mouse;
  switch (activeTool) {
    case 'rect': {
      const W = Math.abs(vals[0] || 0), H = Math.abs(isNaN(vals[1]) ? W : vals[1]);
      if (W < 0.01) break;
      addEntity({ type:'rect', x1:drawState.x1, y1:drawState.y1,
                  x2:drawState.x1 + W, y2:drawState.y1 + H });
      drawState = null; break;
    }
    case 'circle': {
      const R = Math.abs(vals[0] || 0);
      if (R < 0.01) break;
      addEntity({ type:'circle', cx:drawState.cx, cy:drawState.cy, r:R });
      drawState = null; break;
    }
    case 'line': {
      const L = Math.abs(vals[0] || 0);
      if (L < 0.01) break;
      // angle: explicit (deg) or current mouse direction
      const A = (!isNaN(vals[1]))
        ? (vals[1] * Math.PI / 180)
        : Math.atan2(my - drawState.y1, mx - drawState.x1);
      const ex = drawState.x1 + L * Math.cos(A);
      const ey = drawState.y1 + L * Math.sin(A);
      addEntity({ type:'line', x1:drawState.x1, y1:drawState.y1, x2:ex, y2:ey });
      if (chain) chain.links++;
      drawState = { phase:1, x1:ex, y1:ey };  // continue chain from end-point
      break;
    }
  }
  _skNumBuf = ''; _skNumShow(); render();
}

// ── CAO-style dimension line : two screen points + label ─────────────────
function _skDrawCot(x1s, y1s, x2s, y2s, label, isSel) {
  const dxs = x2s - x1s, dys = y2s - y1s;
  const lens = Math.hypot(dxs, dys);
  if (lens < 24) return;          // too small to draw
  const nx = dxs / lens, ny = dys / lens;   // unit along cot
  const ARROW = 6;                // arrowhead size px

  ctx.save();
  // colour + opacity : bright accent when selected, dim ghost otherwise
  const cotCol = isSel ? (COLORS.sel || '#4af') : (COLORS.dimText || '#888');
  ctx.strokeStyle = cotCol; ctx.fillStyle = cotCol;
  ctx.lineWidth   = isSel ? 1.2 : 0.8;
  ctx.globalAlpha = isSel ? 0.92 : 0.35;
  ctx.setLineDash([]);

  // Dimension line
  ctx.beginPath();
  ctx.moveTo(x1s, y1s); ctx.lineTo(x2s, y2s);
  ctx.stroke();

  // Arrowheads (filled triangles, pointing inward)
  const drawArrow = (ax, ay, dx, dy) => {
    const px = -dy, py = dx;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + dx * ARROW + px * ARROW * 0.38, ay + dy * ARROW + py * ARROW * 0.38);
    ctx.lineTo(ax + dx * ARROW - px * ARROW * 0.38, ay + dy * ARROW - py * ARROW * 0.38);
    ctx.closePath(); ctx.fill();
  };
  drawArrow(x1s, y1s,  nx,  ny);   // arrow at start pointing inward →
  drawArrow(x2s, y2s, -nx, -ny);   // arrow at end pointing inward ←

  // Label (reuse existing drawDimLabel, temporarily bump alpha)
  ctx.globalAlpha = isSel ? 1 : 0.55;
  const mx = (x1s + x2s) / 2, my = (y1s + y2s) / 2;
  // offset label perpendicular (away from entity)
  const perpX = -ny * 12, perpY = nx * 12;
  drawDimLabel(mx + perpX, my + perpY, label);

  ctx.globalAlpha = 1;
  ctx.restore();
}

function openSketcher(editObj) {
  // edit round-trip: reload the object's stored 2D sketch into the canvas
  _skEditObj = (editObj && editObj.genType === 'sketch' && editObj.genParams) ? editObj : null;
  if (_skEditObj && Array.isArray(_skEditObj.genParams.entities)) {
    entities = _skClone(_skEditObj.genParams.entities);
    selected.clear();
    nextId = entities.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
    const dEl = document.getElementById('sk-depth');
    if (dEl && _skEditObj.genParams.depth > 0) dEl.value = _skEditObj.genParams.depth;
    updateEntityList(); updateProps(); updateStatusCount();
  }
  _skRoot.style.display = 'flex';
  _skOpen = true;
  resize();
  fitView();
  render();
}
function closeSketcher() {
  _skRoot.style.display = 'none';
  _skOpen = false;
}

// ── contour tracing : entities -> array of closed loops (tessellated 2D points)
const _SK_CIRC_SEG = 64, _SK_ARC_SEG = 48, _SK_BEZ_SEG = 32, _SK_WELD = 1e-3;

function _skTessArc(e) {
  let a1 = e.a1, a2 = e.a2;
  // sweep direction: ccw flag from arcFrom3Points
  if (e.ccw) { if (a2 < a1) a2 += Math.PI * 2; }
  else       { if (a2 > a1) a2 -= Math.PI * 2; }
  const pts = [];
  for (let i = 0; i <= _SK_ARC_SEG; i++) {
    const a = a1 + (a2 - a1) * (i / _SK_ARC_SEG);
    pts.push([e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]);
  }
  return pts;
}
function _skTessBez(e) {
  const pts = [];
  for (let i = 0; i <= _SK_BEZ_SEG; i++) {
    const p = bezierPointAt(e, i / _SK_BEZ_SEG);
    pts.push([p.x, p.y]);
  }
  return pts;
}
// an "edge" = ordered list of points with welded endpoints
function _skEdgePts(e) {
  switch (e.type) {
    case 'line':   return [[e.x1, e.y1], [e.x2, e.y2]];
    case 'arc':    return _skTessArc(e);
    case 'bezier': return _skTessBez(e);
    default: return null;
  }
}
function _skKey(p) {
  return Math.round(p[0] / _SK_WELD) + '|' + Math.round(p[1] / _SK_WELD);
}
// build closed loops from open edges (line/arc/bezier) by endpoint chaining.
// each edge = { pts, ent } ; each loop = { pts:[...], ents:[...] }
function _skTraceLoops(edges) {
  const loops = [];
  const used = new Array(edges.length).fill(false);
  const adj = new Map();
  edges.forEach((edge, ei) => {
    const pts = edge.pts;
    const a = _skKey(pts[0]), b = _skKey(pts[pts.length - 1]);
    (adj.get(a) || adj.set(a, []).get(a)).push({ ei, rev: false });
    (adj.get(b) || adj.set(b, []).get(b)).push({ ei, rev: true });
  });
  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    let loop = [], ents = [];
    let ei = start, rev = false, guard = 0;
    const startKey = _skKey(edges[start].pts[0]);
    while (ei != null && guard++ < edges.length + 2) {
      if (used[ei]) break;
      used[ei] = true;
      let pts = edges[ei].pts;
      if (edges[ei].ent) ents.push(edges[ei].ent);
      if (rev) pts = pts.slice().reverse();
      for (let k = (loop.length ? 1 : 0); k < pts.length; k++) loop.push(pts[k]);
      const tailKey = _skKey(loop[loop.length - 1]);
      if (tailKey === startKey && loop.length > 2) break; // closed
      const cand = (adj.get(tailKey) || []).find(c => !used[c.ei]);
      if (!cand) { ei = null; break; }
      ei = cand.ei; rev = cand.rev;
    }
    if (loop.length > 2 && _skKey(loop[0]) === _skKey(loop[loop.length - 1])) {
      loop.pop();              // drop closing duplicate
      loops.push({ pts: loop, ents });
    }
  }
  return loops;
}
function _skSignedArea(loop) {
  let a = 0;
  for (let i = 0, n = loop.length; i < n; i++) {
    const p = loop[i], q = loop[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
function _skCentroid(loop) {
  let x = 0, y = 0;
  for (const p of loop) { x += p[0]; y += p[1]; }
  return [x / loop.length, y / loop.length];
}
function _skPointInLoop(pt, loop) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const xi = loop[i][0], yi = loop[i][1], xj = loop[j][0], yj = loop[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) &&
        (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// gather every closed loop (circles, rects, traced chains) with its source entities
function _skCollectLoops() {
  const loops = [];
  const openEdges = [];
  for (const e of entities) {
    if (e.type === 'circle') {
      const lp = [];
      for (let i = 0; i < _SK_CIRC_SEG; i++) {
        const a = (i / _SK_CIRC_SEG) * Math.PI * 2;
        lp.push([e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]);
      }
      loops.push({ pts: lp, ents: [e] });
    } else if (e.type === 'rect') {
      loops.push({ pts: [[e.x1, e.y1], [e.x2, e.y1], [e.x2, e.y2], [e.x1, e.y2]], ents: [e] });
    } else if (e.type === 'line' || e.type === 'arc' || e.type === 'bezier') {
      const pts = _skEdgePts(e);
      if (pts) openEdges.push({ pts, ent: e });
    }
  }
  for (const L of _skTraceLoops(openEdges)) loops.push(L);
  return loops;
}

// ── extrude : each disjoint region (outer + its holes) -> its OWN object ──────
function extrudeSketch() {
  const rawLoops = _skCollectLoops();
  if (!rawLoops.length) {
    alert('No closed contour to extrude.\n\nDraw a closed loop (rectangle, circle, or a line/arc/bezier chain snapped back to its start point), then Extrude.');
    return;
  }
  const depthEl = document.getElementById('sk-depth');
  let depth = parseFloat(depthEl && depthEl.value);
  if (!(depth > 0)) depth = 10;

  // sort by |area| descending so outers come before the loops they may contain
  const items = rawLoops.map(L => ({ lp: L.pts, ents: L.ents, area: Math.abs(_skSignedArea(L.pts)) }))
                        .filter(it => it.area > 1e-6)
                        .sort((a, b) => b.area - a.area);
  if (!items.length) { alert('Contour area is degenerate (zero area).'); return; }

  // nesting depth via centroid-in-loop count -> even = solid (outer), odd = hole
  for (const it of items) {
    const c = _skCentroid(it.lp);
    it.depthLevel = 0;
    for (const other of items) {
      if (other === it) continue;
      if (other.area > it.area && _skPointInLoop(c, other.lp)) it.depthLevel++;
    }
  }
  const outers = items.filter(it => it.depthLevel % 2 === 0);
  const holes  = items.filter(it => it.depthLevel % 2 === 1);
  if (!outers.length) { alert('No solid region found in the sketch.'); return; }

  // each outer + the holes it directly contains = one independent region
  const regions = [];
  for (const o of outers) {
    const sh = new THREE.Shape();
    o.lp.forEach((p, i) => i ? sh.lineTo(p[0], p[1]) : sh.moveTo(p[0], p[1]));
    sh.closePath();
    const ents = o.ents.slice();
    for (const h of holes) {
      const c = _skCentroid(h.lp);
      if (h.depthLevel === o.depthLevel + 1 && _skPointInLoop(c, o.lp)) {
        const path = new THREE.Path();
        h.lp.forEach((p, i) => i ? path.lineTo(p[0], p[1]) : path.moveTo(p[0], p[1]));
        path.closePath();
        sh.holes.push(path);
        for (const e of h.ents) ents.push(e);
      }
    }
    regions.push({ shape: sh, ents });
  }

  undoPush(_skEditObj ? 'Sketch.Edit' : 'Sketch.Extrude');

  // shape -> grounded, normal-computed BufferGeometry
  function _skMakeGeo(shape) {
    const ext = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1, curveSegments: 24 });
    ext.rotateX(-Math.PI / 2);            // stand up : sketch plane -> XZ ground, extrude -> +Y
    const gNI = ext.toNonIndexed(); ext.dispose();
    const vPos = gNI.attributes.position.array; gNI.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(vPos), 3));
    geo.computeVertexNormals(); geo.computeBoundingBox();
    return geo;
  }
  const _xr = (typeof _xrayActive !== 'undefined' && _xrayActive && typeof _applyXRay === 'function');

  const created = [];
  regions.forEach((region, idx) => {
    const geo     = _skMakeGeo(region.shape);
    const rParams = { entities: _skClone(region.ents), depth };

    // EDIT MODE : first region swaps the existing object's geometry in place ;
    // any extra regions the user added become brand-new objects.
    if (idx === 0 && _skEditObj && _skEditObj.mesh) {
      const m = _skEditObj.mesh;
      m.geometry.dispose(); m.geometry = geo;
      if (typeof _invalidateBbox === 'function') _invalidateBbox(m);
      m.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(m);
      m.position.y = -bb.min.y;
      _skEditObj.genParams = rParams;
      if (_xr) _applyXRay(_skEditObj);
      created.push(_skEditObj);
      return;
    }

    // CREATE : one independent watertight solid per region (NASSCAD convention)
    objCnt++;
    const isHole = isHoleMode;
    const col    = isHole ? '#ff3333' : COL[objCnt % COL.length];
    const colNum = isHole ? 0xff3333  : parseInt(col.replace('#', ''), 16);
    const mat = new THREE.MeshPhongMaterial({
      color: colNum, shininess: 12, specular: 0x2a2a2a,
      side: THREE.DoubleSide, transparent: isHole, opacity: isHole ? 0.45 : 1
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = false;
    scene.add(mesh); mesh.updateMatrixWorld(true);
    const freePos = _findFreePos(mesh, PS + 2);
    const _bb = new THREE.Box3().setFromObject(mesh);
    mesh.position.set(freePos.x, -_bb.min.y, freePos.z);
    const name = 'Sketch_' + objCnt;
    const obj  = { id: objCnt, name, type: 'csg', mesh, color: col, isHole, genType: 'sketch', genParams: rParams };
    objs.push(obj);
    if (_xr) _applyXRay(obj);
    created.push(obj);
  });

  selObjs = created.slice();
  updProps(); updOList(); updStats();
  nasLog('OK', `Sketch -> ${created.length} object(s) (H=${depth}mm)`);
  closeSketcher();
}

// ══════════════════════════════════════════════════════════════════════════
// [V4.7.2] TRIM · EXTEND · FILLET — outils de modification 2D
//
// Socle commun : un moteur d'intersection ANALYTIQUE (pas d'approximation par
// polylignes pour les cas courants). C'est indispensable ici : les points de
// coupe deviennent des extrémités d'entités, et _skTraceLoops/_skKey soudent
// les chaînes avec une tolérance de 1e-3 (_SK_WELD) au moment de l'extrusion.
// Un point de coupe approché à 1e-2 près ferait silencieusement échouer la
// fermeture du contour — donc "ça a l'air bon à l'écran mais Extrude ne trouve
// rien". Seules les Béziers sont traitées par discrétisation (48 segments),
// faute de solution fermée raisonnable.
// ══════════════════════════════════════════════════════════════════════════

// Un arc contient-il cet angle ? (même convention de balayage que hitTest)
function _skArcHasAngle(e, ang) {
  const total = angNorm(e.ccw ? (e.a2 - e.a1) : (e.a1 - e.a2));
  const to    = angNorm(e.ccw ? (ang  - e.a1) : (e.a1 - ang));
  return to <= total + 1e-9;
}

// Décomposition d'une entité en primitives intersectables
function _skPrims(e) {
  switch (e.type) {
    case 'line': return [{ k:'seg', x1:e.x1, y1:e.y1, x2:e.x2, y2:e.y2 }];
    case 'rect': return [
      { k:'seg', x1:e.x1, y1:e.y1, x2:e.x2, y2:e.y1 },
      { k:'seg', x1:e.x2, y1:e.y1, x2:e.x2, y2:e.y2 },
      { k:'seg', x1:e.x2, y1:e.y2, x2:e.x1, y2:e.y2 },
      { k:'seg', x1:e.x1, y1:e.y2, x2:e.x1, y2:e.y1 }];
    case 'circle': return [{ k:'circ', cx:e.cx, cy:e.cy, r:e.r, arc:null }];
    case 'arc':    return [{ k:'circ', cx:e.cx, cy:e.cy, r:e.r, arc:e }];
    case 'bezier': {
      const out = []; let p = bezierPointAt(e, 0);
      for (let i = 1; i <= 48; i++) {
        const q = bezierPointAt(e, i / 48);
        out.push({ k:'seg', x1:p.x, y1:p.y, x2:q.x, y2:q.y });
        p = q;
      }
      return out;
    }
    default: return [];
  }
}

function _xSegSeg(a, b, out) {
  const r1x = a.x2-a.x1, r1y = a.y2-a.y1, r2x = b.x2-b.x1, r2y = b.y2-b.y1;
  const den = r1x*r2y - r1y*r2x;
  if (Math.abs(den) < 1e-12) return;                  // parallèles / colinéaires
  const t = ((b.x1-a.x1)*r2y - (b.y1-a.y1)*r2x) / den;
  const u = ((b.x1-a.x1)*r1y - (b.y1-a.y1)*r1x) / den;
  if (t < -1e-9 || t > 1+1e-9 || u < -1e-9 || u > 1+1e-9) return;
  out.push({ x: a.x1 + t*r1x, y: a.y1 + t*r1y });
}

function _xSegCirc(s, c, out) {
  const dx = s.x2-s.x1, dy = s.y2-s.y1;
  const fx = s.x1-c.cx, fy = s.y1-c.cy;
  const A = dx*dx + dy*dy;
  if (A < 1e-18) return;
  const B = 2*(fx*dx + fy*dy);
  const C = fx*fx + fy*fy - c.r*c.r;
  let disc = B*B - 4*A*C;
  if (disc < 0) return;
  disc = Math.sqrt(disc);
  for (const t of [(-B - disc)/(2*A), (-B + disc)/(2*A)]) {
    if (t < -1e-9 || t > 1+1e-9) continue;
    const x = s.x1 + t*dx, y = s.y1 + t*dy;
    if (c.arc && !_skArcHasAngle(c.arc, Math.atan2(y - c.cy, x - c.cx))) continue;
    out.push({ x, y });
  }
}

function _xCircCirc(c1, c2, out) {
  const dx = c2.cx-c1.cx, dy = c2.cy-c1.cy;
  const d  = Math.hypot(dx, dy);
  if (d < 1e-9) return;                                       // concentriques
  if (d > c1.r + c2.r + 1e-9) return;                         // disjoints
  if (d < Math.abs(c1.r - c2.r) - 1e-9) return;               // l'un dans l'autre
  const a  = (c1.r*c1.r - c2.r*c2.r + d*d) / (2*d);
  const h  = Math.sqrt(Math.max(0, c1.r*c1.r - a*a));
  const mx = c1.cx + a*dx/d, my = c1.cy + a*dy/d;
  const rx = -dy*h/d,        ry = dx*h/d;
  for (const p of [{ x:mx+rx, y:my+ry }, { x:mx-rx, y:my-ry }]) {
    if (c1.arc && !_skArcHasAngle(c1.arc, Math.atan2(p.y-c1.cy, p.x-c1.cx))) continue;
    if (c2.arc && !_skArcHasAngle(c2.arc, Math.atan2(p.y-c2.cy, p.x-c2.cx))) continue;
    out.push(p);
  }
}

function _skXsect(A, B) {
  const out = [];
  for (const pa of _skPrims(A)) for (const pb of _skPrims(B)) {
    if      (pa.k === 'seg'  && pb.k === 'seg')  _xSegSeg(pa, pb, out);
    else if (pa.k === 'seg'  && pb.k === 'circ') _xSegCirc(pa, pb, out);
    else if (pa.k === 'circ' && pb.k === 'seg')  _xSegCirc(pb, pa, out);
    else                                          _xCircCirc(pa, pb, out);
  }
  const uniq = [];
  for (const p of out) if (!uniq.some(q => Math.hypot(q.x-p.x, q.y-p.y) < 1e-6)) uniq.push(p);
  return uniq;
}

// Paramètre d'un point le long d'une entité :
//   ligne/bézier → t ∈ [0,1] · arc → angle parcouru depuis a1 · cercle → angle absolu
function _skParamAt(e, p) {
  switch (e.type) {
    case 'line': {
      const dx = e.x2-e.x1, dy = e.y2-e.y1, L2 = dx*dx + dy*dy;
      if (L2 < 1e-18) return 0;
      return ((p.x-e.x1)*dx + (p.y-e.y1)*dy) / L2;
    }
    case 'circle': return angNorm(Math.atan2(p.y-e.cy, p.x-e.cx));
    case 'arc': {
      const ang = Math.atan2(p.y-e.cy, p.x-e.cx);
      return angNorm(e.ccw ? (ang - e.a1) : (e.a1 - ang));
    }
    case 'bezier': {
      let bt = 0, bd = Infinity;
      for (let i = 0; i <= 200; i++) {
        const t = i/200, q = bezierPointAt(e, t);
        const d = Math.hypot(q.x-p.x, q.y-p.y);
        if (d < bd) { bd = d; bt = t; }
      }
      return bt;
    }
    default: return 0;
  }
}

function _skPointAtParam(e, t) {
  switch (e.type) {
    case 'line':   return { x: e.x1 + t*(e.x2-e.x1), y: e.y1 + t*(e.y2-e.y1) };
    case 'circle': return { x: e.cx + e.r*Math.cos(t), y: e.cy + e.r*Math.sin(t) };
    case 'arc': {
      const ang = e.a1 + (e.ccw ? t : -t);
      return { x: e.cx + e.r*Math.cos(ang), y: e.cy + e.r*Math.sin(ang) };
    }
    case 'bezier': return bezierPointAt(e, t);
    default: return { x:0, y:0 };
  }
}

// Sous-courbe de Bézier sur [a,b] — De Casteljau, exact (pas de ré-échantillonnage)
function _bezSplit(P, t) {
  const L = (p, q, u) => ({ x: p.x + (q.x-p.x)*u, y: p.y + (q.y-p.y)*u });
  const p01 = L(P[0],P[1],t), p12 = L(P[1],P[2],t), p23 = L(P[2],P[3],t);
  const p012 = L(p01,p12,t),  p123 = L(p12,p23,t);
  const mid  = L(p012,p123,t);
  return { left: [P[0], p01, p012, mid], right: [mid, p123, p23, P[3]] };
}
function _bezSub(e, a, b) {
  let P = [{x:e.x0,y:e.y0},{x:e.x1,y:e.y1},{x:e.x2,y:e.y2},{x:e.x3,y:e.y3}];
  if (a > 1e-9) P = _bezSplit(P, a).right;
  const denom = 1 - a;
  const bb = denom > 1e-9 ? (b - a) / denom : 1;
  if (bb < 1 - 1e-9) P = _bezSplit(P, Math.max(0, Math.min(1, bb))).left;
  return P;
}

// Restreint une entité à sa portion [a,b] (en son propre paramétrage)
function _skSetRange(e, a, b) {
  if (e.type === 'line') {
    const p0 = _skPointAtParam(e, a), p1 = _skPointAtParam(e, b);  // AVANT mutation
    e.x1 = p0.x; e.y1 = p0.y; e.x2 = p1.x; e.y2 = p1.y;
  } else if (e.type === 'arc') {
    const s = e.ccw ? 1 : -1;
    const na1 = e.a1 + s*a, na2 = e.a1 + s*b;
    e.a1 = na1; e.a2 = na2;
  } else if (e.type === 'bezier') {
    const P = _bezSub(e, a, b);
    e.x0=P[0].x; e.y0=P[0].y; e.x1=P[1].x; e.y1=P[1].y;
    e.x2=P[2].x; e.y2=P[2].y; e.x3=P[3].x; e.y3=P[3].y;
  }
}

function _skPick(wx, wy) {
  for (let i = entities.length - 1; i >= 0; i--) if (hitTest(entities[i], wx, wy)) return entities[i];
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// [V4.7.3] UNDO / REDO · POIGNÉES · SÉLECTION RECTANGLE · ACCROCHAGE INTERSECTION
// ══════════════════════════════════════════════════════════════════════════

// ── Undo / Redo ───────────────────────────────────────────────────────────
function _skSnapshot() {
  return { entities: _skClone(entities), nextId, selected: [...selected] };
}
// Ne consigne l'instantané QUE si l'état a réellement changé. Sans ce test, un
// trim sans intersection ou un congé refusé laisserait une entrée fantôme et le
// premier Ctrl+Z semblerait "ne rien faire".
function _skCommit(snap) {
  if (_skUndoLock) return false;
  if (snap.nextId === nextId &&
      JSON.stringify(snap.entities) === JSON.stringify(entities)) return false;
  _skUndo.push(snap);
  if (_skUndo.length > _SK_UNDO_MAX) _skUndo.shift();
  _skRedo.length = 0;
  _skUndoUI();
  return true;
}
function _skRestore(s) {
  entities = _skClone(s.entities);
  nextId   = s.nextId;
  selected = new Set(s.selected.filter(id => entities.some(e => e.id === id)));
  // toute action en cours devient caduque après un saut dans l'historique
  drawState = null; chain = null; _skDrag = null; _skGrip = null;
  _skBand = null; _skFilletPick = null; _skNumBuf = '';
  _skNumShow(); updateEntityList(); updateProps(); updateStatusCount(); render();
  _skUndoUI();
}
function _skUndoUI() {
  const u = document.getElementById('sk-btn-undo'), r = document.getElementById('sk-btn-redo');
  if (u) u.disabled = !_skUndo.length;
  if (r) r.disabled = !_skRedo.length;
}
function skUndo() {
  if (!_skUndo.length) { _skHint('Nothing to undo.'); return; }
  _skRedo.push(_skSnapshot());
  if (_skRedo.length > _SK_UNDO_MAX) _skRedo.shift();
  _skRestore(_skUndo.pop());
  _skHint(`Undo — ${_skUndo.length} step(s) left.`);
}
function skRedo() {
  if (!_skRedo.length) { _skHint('Nothing to redo.'); return; }
  _skUndo.push(_skSnapshot());
  _skRestore(_skRedo.pop());
  _skHint(`Redo — ${_skRedo.length} step(s) left.`);
}

// ── Poignées d'extrémité ──────────────────────────────────────────────────
// Uniquement sur les entités SÉLECTIONNÉES : sinon le canvas se couvrirait de
// carrés et on attraperait un point en croyant déplacer l'entité entière.
function _skGripPts(e) {
  switch (e.type) {
    case 'point':  return [{ k:'p',  x:e.x,  y:e.y  }];
    case 'line':   return [{ k:'p1', x:e.x1, y:e.y1 }, { k:'p2', x:e.x2, y:e.y2 }];
    case 'rect':   return [{ k:'c11', x:e.x1, y:e.y1 }, { k:'c21', x:e.x2, y:e.y1 },
                           { k:'c22', x:e.x2, y:e.y2 }, { k:'c12', x:e.x1, y:e.y2 }];
    case 'circle': return [{ k:'c', x:e.cx, y:e.cy }, { k:'r', x:e.cx + e.r, y:e.cy }];
    case 'arc': {
      const s = arcStartPoint(e), t = arcEndPoint(e);
      return [{ k:'c', x:e.cx, y:e.cy }, { k:'a1', x:s.x, y:s.y }, { k:'a2', x:t.x, y:t.y }];
    }
    case 'bezier': return [{ k:'b0', x:e.x0, y:e.y0 }, { k:'b1', x:e.x1, y:e.y1 },
                           { k:'b2', x:e.x2, y:e.y2 }, { k:'b3', x:e.x3, y:e.y3 }];
    default: return [];
  }
}
function _skGripAt(sx, sy) {
  for (const e of entities) {
    if (!selected.has(e.id) || _skIsFixed(e)) continue;
    for (const g of _skGripPts(e)) {
      const p = worldToScreen(g.x, g.y);
      if (Math.hypot(p.sx - sx, p.sy - sy) < 8) return { id: e.id, key: g.k };
    }
  }
  return null;
}
function _skMoveGrip(e, key, wx, wy) {
  switch (key) {
    case 'p':   e.x  = wx; e.y  = wy; break;
    case 'p1':  e.x1 = wx; e.y1 = wy; break;
    case 'p2':  e.x2 = wx; e.y2 = wy; break;
    case 'c11': e.x1 = wx; e.y1 = wy; break;
    case 'c21': e.x2 = wx; e.y1 = wy; break;
    case 'c22': e.x2 = wx; e.y2 = wy; break;
    case 'c12': e.x1 = wx; e.y2 = wy; break;
    case 'c':   e.cx = wx; e.cy = wy; break;
    case 'r':   e.r  = Math.max(0.01, Math.hypot(wx - e.cx, wy - e.cy)); break;
    // arc : on ne déplace que l'angle, centre et rayon inchangés — tirer une
    // extrémité fait balayer l'arc sur son propre cercle, comportement attendu.
    case 'a1':  e.a1 = Math.atan2(wy - e.cy, wx - e.cx); break;
    case 'a2':  e.a2 = Math.atan2(wy - e.cy, wx - e.cx); break;
    case 'b0':  e.x0 = wx; e.y0 = wy; break;
    case 'b1':  e.x1 = wx; e.y1 = wy; break;
    case 'b2':  e.x2 = wx; e.y2 = wy; break;
    case 'b3':  e.x3 = wx; e.y3 = wy; break;
  }
}
function drawGrips() {
  if (activeTool !== 'select') return;
  ctx.lineWidth = 1.5;
  for (const e of entities) {
    if (!selected.has(e.id)) continue;
    const fixed = _skIsFixed(e);
    for (const g of _skGripPts(e)) {
      const p = worldToScreen(g.x, g.y);
      ctx.fillStyle   = fixed ? COLORS.canvasBg : COLORS.sel;
      ctx.strokeStyle = fixed ? COLORS.axis : COLORS.sel;
      ctx.beginPath();
      ctx.rect(p.sx - 3.5, p.sy - 3.5, 7, 7);
      ctx.fill(); ctx.stroke();
    }
  }
}

// ── Sélection par rectangle élastique ─────────────────────────────────────
// Points échantillonnés le long de l'entité (le cercle est échantillonné sur sa
// circonférence, pas sur son centre : un rectangle posé au milieu d'un grand
// cercle ne doit pas le sélectionner).
function _skSamples(e) {
  const pts = [];
  if (e.type === 'point') return [[e.x, e.y]];
  for (const pr of _skPrims(e)) {
    if (pr.k === 'seg') { pts.push([pr.x1, pr.y1], [pr.x2, pr.y2]); continue; }
    const a  = pr.arc;
    const a1 = a ? a.a1 : 0;
    const tot = a ? angNorm(a.ccw ? (a.a2 - a.a1) : (a.a1 - a.a2)) : Math.PI * 2;
    const sg = (a && !a.ccw) ? -1 : 1;
    for (let i = 0; i <= 32; i++) {
      const ang = a1 + sg * tot * i / 32;
      pts.push([pr.cx + pr.r * Math.cos(ang), pr.cy + pr.r * Math.sin(ang)]);
    }
  }
  return pts;
}
function _skEntInBand(e, x0, y0, x1, y1) {
  const minx = Math.min(x0,x1), maxx = Math.max(x0,x1);
  const miny = Math.min(y0,y1), maxy = Math.max(y0,y1);
  for (const [px, py] of _skSamples(e))
    if (px >= minx && px <= maxx && py >= miny && py <= maxy) return true;
  // sélection "crossing" : une longue ligne qui traverse la fenêtre sans y avoir
  // de point échantillonné doit quand même être prise
  return _skXsect(e, { type:'rect', id:-2, x1:minx, y1:miny, x2:maxx, y2:maxy }).length > 0;
}
function drawBand() {
  if (!_skBand) return;
  const x = Math.min(_skBand.sx0, _skBand.sx1), y = Math.min(_skBand.sy0, _skBand.sy1);
  const w = Math.abs(_skBand.sx1 - _skBand.sx0), h = Math.abs(_skBand.sy1 - _skBand.sy0);
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = COLORS.sel;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.fillStyle = COLORS.temp;
  ctx.globalAlpha = 0.12;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// Un rectangle est une entité unique : on ne peut pas en couper un seul côté.
// On l'éclate donc en 4 lignes (comportement CAO standard) et on renvoie celle
// que l'utilisateur visait.
function _skExplodeRect(e, wx, wy) {
  const idx = entities.findIndex(en => en.id === e.id);
  if (idx < 0) return null;
  const S = [[e.x1,e.y1,e.x2,e.y1],[e.x2,e.y1,e.x2,e.y2],
             [e.x2,e.y2,e.x1,e.y2],[e.x1,e.y2,e.x1,e.y1]];
  const made = S.map(s => ({ type:'line', x1:s[0], y1:s[1], x2:s[2], y2:s[3],
                             id: nextId++, constraints: [] }));
  entities.splice(idx, 1, ...made);
  selected.delete(e.id);
  let best = null;
  for (const m of made) {
    const t = Math.max(0, Math.min(1, _skParamAt(m, { x:wx, y:wy })));
    const p = _skPointAtParam(m, t);
    const d = Math.hypot(p.x-wx, p.y-wy);
    if (!best || d < best.d) best = { d, m };
  }
  _skHint('Rectangle exploded into 4 lines so it could be trimmed.');
  return best ? best.m : null;
}

function _skTrimAt(target, wx, wy) {
  if (target.type === 'point') { _skHint('Trim: nothing to trim on a point.'); return false; }
  if (_skIsFixed(target))      { _skHint('Trim: that entity is fixed — unfix it first.'); return false; }
  // [V4.7.3] undo — instantané pris AVANT l'éclatement éventuel du rectangle, et
  // consigné seulement si quelque chose a bougé (_skCommit compare les états).
  const _u = _skSnapshot();
  const _done = (ok) => { _skCommit(_u); return ok; };
  if (target.type === 'rect') {
    target = _skExplodeRect(target, wx, wy);
    if (!target) return _done(false);
  }

  const cuts = [];
  for (const o of entities) {
    if (o.id === target.id) continue;
    for (const p of _skXsect(target, o)) cuts.push(_skParamAt(target, p));
  }
  const click = _skParamAt(target, { x:wx, y:wy });

  // ── cercle : pas d'extrémités, le paramétrage est cyclique ──
  if (target.type === 'circle') {
    const s = cuts.map(a => angNorm(a)).sort((p, q) => p - q);
    const u = s.filter((a, i) => i === 0 || Math.abs(a - s[i-1]) > 1e-6);
    if (u.length < 2) { _skHint('Trim: a circle needs at least 2 intersections to be cut.'); return _done(false); }
    let lo = null, hi = null;
    for (let i = 0; i < u.length; i++) {
      const a = u[i], b = u[(i+1) % u.length];
      if (angNorm(click - a) <= angNorm(b - a) + 1e-9) { lo = a; hi = b; break; }
    }
    if (lo === null) return _done(false);
    // on retire le secteur [lo,hi] → il reste l'arc complémentaire hi → lo (ccw)
    target.type = 'arc'; target.a1 = hi; target.a2 = lo; target.ccw = true;
    updateEntityList(); updateProps(); updateStatusCount(); render();
    _skHint('Trim: circle cut into an arc.');
    return _done(true);
  }

  const maxP = (target.type === 'arc')
             ? angNorm(target.ccw ? (target.a2-target.a1) : (target.a1-target.a2))
             : 1;
  const ps = cuts.filter(t => t > 1e-6 && t < maxP - 1e-6).sort((a, b) => a - b);
  if (!ps.length) { _skHint('Trim: no intersection on that entity — nothing to cut.'); return _done(false); }

  let lo = 0, hi = maxP;
  for (const t of ps) { if (t <= click && t > lo) lo = t; }
  for (const t of ps) { if (t >= click && t < hi) hi = t; }

  if (lo <= 1e-9 && hi >= maxP - 1e-9) {              // tout le tronçon → suppression
    entities = entities.filter(e => e.id !== target.id);
    selected.delete(target.id);
    _skHint('Trim: entity fully removed.');
  } else if (lo <= 1e-9) {
    _skSetRange(target, hi, maxP);
    _skHint('Trim: head removed.');
  } else if (hi >= maxP - 1e-9) {
    _skSetRange(target, 0, lo);
    _skHint('Trim: tail removed.');
  } else {                                            // trou au milieu → 2 entités
    const tail = _skClone(target); tail.id = nextId++;
    _skSetRange(target, 0, lo);
    _skSetRange(tail, hi, maxP);
    entities.push(tail);
    _skHint('Trim: middle removed — entity split in two.');
  }
  updateEntityList(); updateProps(); updateStatusCount(); render();
  return _done(true);
}

// Intersections de la droite PORTEUSE (prolongée) avec une autre entité
function _skXsectExtended(line, other) {
  const dx = line.x2-line.x1, dy = line.y2-line.y1, L = Math.hypot(dx, dy);
  if (L < 1e-9) return [];
  const K = 1e4 / L;   // ~10 000 unités de part et d'autre : largement assez,
                       // et bien mieux conditionné qu'un 1e6 pour la précision
  const big = { type:'line', id:-1,
                x1: line.x1 - dx*K, y1: line.y1 - dy*K,
                x2: line.x2 + dx*K, y2: line.y2 + dy*K };
  return _skXsect(big, other);
}

function _skExtendAt(target, wx, wy) {
  if (_skIsFixed(target)) { _skHint('Extend: that entity is fixed — unfix it first.'); return false; }
  const _u = _skSnapshot();   // [V4.7.3] undo (consigné seulement si ça bouge)

  if (target.type === 'line') {
    const atStart = _skParamAt(target, { x:wx, y:wy }) < 0.5;
    const cands = [];
    for (const o of entities) {
      if (o.id === target.id) continue;
      for (const p of _skXsectExtended(target, o)) {
        const tp = _skParamAt(target, p);
        if (atStart ? tp < -1e-6 : tp > 1 + 1e-6) cands.push({ d: atStart ? -tp : tp - 1, p });
      }
    }
    if (!cands.length) { _skHint('Extend: nothing to reach on that side.'); return false; }
    cands.sort((a, b) => a.d - b.d);
    const p = cands[0].p;
    if (atStart) { target.x1 = p.x; target.y1 = p.y; }
    else         { target.x2 = p.x; target.y2 = p.y; }
    updateEntityList(); updateProps(); render();
    _skHint('Extend: line stretched to the next intersection.');
    _skCommit(_u);
    return true;
  }

  if (target.type === 'arc') {
    const total = angNorm(target.ccw ? (target.a2-target.a1) : (target.a1-target.a2));
    const atStart = _skParamAt(target, { x:wx, y:wy }) < total / 2;
    const full = { type:'circle', id:-1, cx:target.cx, cy:target.cy, r:target.r };
    const cands = [];
    for (const o of entities) {
      if (o.id === target.id) continue;
      for (const p of _skXsect(full, o)) {
        const ang = Math.atan2(p.y-target.cy, p.x-target.cx);
        const u   = angNorm(target.ccw ? (ang-target.a1) : (target.a1-ang));
        if (u <= total + 1e-6) continue;                  // déjà sur l'arc
        cands.push({ d: atStart ? (2*Math.PI - u) : (u - total), ang });
      }
    }
    if (!cands.length) { _skHint('Extend: nothing to reach on that side.'); return false; }
    cands.sort((a, b) => a.d - b.d);
    if (atStart) target.a1 = cands[0].ang; else target.a2 = cands[0].ang;
    updateEntityList(); updateProps(); render();
    _skHint('Extend: arc stretched to the next intersection.');
    _skCommit(_u);
    return true;
  }

  _skHint('Extend: only lines and arcs can be extended.');
  return false;
}

// Congé entre deux lignes : arc tangent de rayon R, les deux lignes étant
// raccourcies jusqu'à leurs points de tangence. Les lignes n'ont pas besoin de
// se toucher — on travaille sur leurs droites porteuses, comme en CAO.
function _skFillet(A, B, R) {
  if (A.type !== 'line' || B.type !== 'line') { _skHint('Fillet: pick two LINES.'); return false; }
  if (_skIsFixed(A) || _skIsFixed(B))         { _skHint('Fillet: one of the lines is fixed.'); return false; }
  const X = (() => {
    const r1x=A.x2-A.x1, r1y=A.y2-A.y1, r2x=B.x2-B.x1, r2y=B.y2-B.y1;
    const den = r1x*r2y - r1y*r2x;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((B.x1-A.x1)*r2y - (B.y1-A.y1)*r2x) / den;
    return { x: A.x1 + t*r1x, y: A.y1 + t*r1y };
  })();
  if (!X) { _skHint('Fillet: the two lines are parallel — no corner to round.'); return false; }

  // vecteur unitaire partant du coin vers l'extrémité LA PLUS LOIN de chaque ligne
  const arm = (L) => {
    const d1 = Math.hypot(L.x1-X.x, L.y1-X.y), d2 = Math.hypot(L.x2-X.x, L.y2-X.y);
    const farIsP1 = d1 > d2;
    const fx = farIsP1 ? L.x1 : L.x2, fy = farIsP1 ? L.y1 : L.y2;
    const vx = fx-X.x, vy = fy-X.y, n = Math.hypot(vx, vy) || 1;
    return { ux: vx/n, uy: vy/n, farIsP1, len: n };
  };
  const a = arm(A), b = arm(B);
  const theta = Math.acos(Math.max(-1, Math.min(1, a.ux*b.ux + a.uy*b.uy)));
  if (theta < 1e-4 || Math.PI - theta < 1e-4) { _skHint('Fillet: lines are collinear.'); return false; }

  const half = theta / 2;
  const d    = R / Math.tan(half);                 // coin → point de tangence
  if (d > a.len - 1e-9 || d > b.len - 1e-9) {
    _skHint(`Fillet: R=${R} is too large for these lines (max ≈ ${(Math.min(a.len,b.len)*Math.tan(half)).toFixed(2)}).`);
    return false;
  }
  const TA = { x: X.x + a.ux*d, y: X.y + a.uy*d };
  const TB = { x: X.x + b.ux*d, y: X.y + b.uy*d };
  let bx = a.ux + b.ux, by = a.uy + b.uy;
  const bn = Math.hypot(bx, by) || 1; bx /= bn; by /= bn;
  const C  = { x: X.x + bx*(R/Math.sin(half)), y: X.y + by*(R/Math.sin(half)) };

  // [V4.7.3] Toutes les validations sont passées : à partir d'ici on mute.
  // _skUndoLock empêche addEntity() d'empiler une 2e entrée pour l'arc — un congé
  // doit s'annuler d'un seul Ctrl+Z (2 lignes raccourcies + 1 arc = 1 opération).
  const _u = _skSnapshot();
  _skUndoLock = true;
  try {
    // l'extrémité côté coin de chaque ligne devient le point de tangence
    if (a.farIsP1) { A.x2 = TA.x; A.y2 = TA.y; } else { A.x1 = TA.x; A.y1 = TA.y; }
    if (b.farIsP1) { B.x2 = TB.x; B.y2 = TB.y; } else { B.x1 = TB.x; B.y1 = TB.y; }

    const a1 = Math.atan2(TA.y-C.y, TA.x-C.x);
    const a2 = Math.atan2(TB.y-C.y, TB.x-C.x);
    addEntity({ type:'arc', cx:C.x, cy:C.y, r:R, a1, a2,
                ccw: angNorm(a2-a1) <= Math.PI });   // toujours le petit arc
  } finally { _skUndoLock = false; }
  _skCommit(_u);
  updateProps();
  _skHint(`Fillet R${R} applied.`);
  return true;
}

// ── public surface (everything else stays private inside this IIFE) ──────────
window.openSketcher  = openSketcher;
window.closeSketcher = closeSketcher;
window.SK = {
  setTool, applyConstraint, clearAll, deleteSelected, exportNass, fitView,
  selectEntity, toggleGrid, toggleSnap, toggleTheme, updateProp,
  extrude: extrudeSketch, close: closeSketcher,
  // [V4.7.2] lecture seule — pratique en console NassScript, et utilisé par les tests
  getEntities: () => entities.map(_skClone),
  // [V4.7.3] annulation
  undo: skUndo, redo: skRedo,
  canUndo: () => _skUndo.length, canRedo: () => _skRedo.length
};

})();
// ════════ /Sketch.Gen ════════
