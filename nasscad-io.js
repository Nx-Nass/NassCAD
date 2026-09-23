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
//   _applyFaceColors                                           — [17/09] step-import.js : couleurs
//                                                                 par face (3MF/PLY/OBJ/STL) ;
//                                                                 absent ⇒ couleur dominante seule
//   NASSCAD_MATERIALS                                          — [17/09] nasscad-materials.js,
//                                                                 optionnel (métal → PBR du GLB)
//
// [AUDIT I/O 17/09] Import/export hors STEP audités et corrigés contre un banc
// reproductible — voir le bloc « Helpers partagés » juste en dessous et le
// commentaire [AUDIT 17/09] en tête de chaque fonction retouchée.
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

// ══════════════════════════════════════════════════════════════════════════
// [AUDIT I/O 17/09] Helpers partagés — audit import/export hors STEP, mené
// contre un corpus réel (191 GLB NASA, 33 STL, l'OBJ Vénus de Milo 131 Mo) et
// un corpus de cas limites fabriqué et vérifié avec lib3mf, trimesh, plyfile,
// le validateur Khronos et les loaders three.js r186. Chaque correctif
// ci-dessous répond à un défaut REPRODUIT sur ce banc, pas à une hypothèse.
// ══════════════════════════════════════════════════════════════════════════

// Géométrie d'export cuite en repère monde (Y-up), selon la règle
// _ioCanRebuild. Remplace les six copies du même bloc dans les exports.
// Ajout : si la matrice est un MIROIR (déterminant < 0), applyMatrix4 déplace
// les sommets mais ne retourne pas les triangles — le solide sortait retourné
// comme un gant (normales vers l'intérieur, volume négatif pour un slicer).
function _ioBakeGeo(so){
  const g = makeGeoHD(so);
  let M = so.mesh.matrixWorld;
  if(_ioCanRebuild(so)){
    const _p=new THREE.Vector3(),_q=new THREE.Quaternion(),_s=new THREE.Vector3();
    so.mesh.matrixWorld.decompose(_p,_q,_s);
    M = new THREE.Matrix4().makeRotationFromQuaternion(_q); M.setPosition(_p);
  }
  g.applyMatrix4(M);
  if(M.determinant() < 0) _ioFlipWinding(g);
  return g;
}

// Retourne l'orientation de chaque triangle (échange des sommets 2 et 3).
function _ioFlipWinding(g){
  if(g.index){
    const a = g.index.array;
    for(let i = 0; i + 2 < a.length; i += 3){ const t = a[i+1]; a[i+1] = a[i+2]; a[i+2] = t; }
    g.index.needsUpdate = true;
    return;
  }
  for(const k in g.attributes){
    const at = g.attributes[k], a = at.array, s = at.itemSize;
    for(let i = 0; i + 3*s <= a.length; i += 3*s)
      for(let j = 0; j < s; j++){ const t = a[i+s+j]; a[i+s+j] = a[i+2*s+j]; a[i+2*s+j] = t; }
    at.needsUpdate = true;
  }
}

// Couleur 'rrggbb' d'un objet. Un corps STEP multi-couleur porte un TABLEAU
// de matériaux : `o.mesh.material.color` y vaut undefined, et l'export 3MF
// plantait sur `.getHexString()` — spinner figé, aucun fichier. Un corps en
// mode trou affiche du rouge d'interface : c'est o.color qui porte sa teinte.
function _ioObjColorHex(o){
  if(o.isHole && typeof o.color === 'string' && /^#?[0-9a-f]{6}/i.test(o.color))
    return o.color.replace('#','').slice(0,6).toLowerCase();
  const m = Array.isArray(o.mesh.material) ? o.mesh.material[0] : o.mesh.material;
  if(m && m.color) return m.color.getHexString();
  if(typeof o.color === 'string' && /^#?[0-9a-f]{6}/i.test(o.color))
    return o.color.replace('#','').slice(0,6).toLowerCase();
  return 'cccccc';
}

// Palette par face d'un corps multi-matériau : ['rrggbb', …] indexée par
// materialIndex, ou null. Mêmes sources que _faceStyle (hôte) : _holePal pour
// un corps en mode trou, sinon la couleur de chaque matériau. Les groupes de
// BoxGeometry & co. ne comptent pas : sans tableau de matériaux, ils ne
// portent aucune couleur.
function _ioFacePalette(o){
  const L = o.mesh.material;
  const g = o.mesh.geometry;
  if(!Array.isArray(L) || L.length < 2 || !g || !g.groups || !g.groups.length) return null;
  if(o._holePal && o._holePal.length === L.length)
    return o._holePal.map(h => (typeof h === 'number' ? h.toString(16).padStart(6,'0') : String(h).replace('#','').slice(0,6)).toLowerCase());
  return L.map(m => (m && m.color) ? m.color.getHexString() : _ioObjColorHex(o));
}

// Matériau par triangle (Int32Array, -1 = aucun groupe) depuis geometry.groups.
// Les plages sont en unités d'index (géo indexée) ou de sommets (soupe) : dans
// les deux cas, triangle = unité / 3.
function _ioTriMaterial(g){
  const n = g.index ? g.index.count/3 : g.attributes.position.count/3;
  const tm = new Int32Array(n).fill(-1);
  for(const gr of (g.groups || [])){
    const a = Math.floor(gr.start/3), b = Math.min(n, Math.floor((gr.start + gr.count)/3));
    for(let t = a; t < b; t++) tm[t] = gr.materialIndex || 0;
  }
  return tm;
}

// Soudure EXACTE (bits identiques) des positions d'une soupe → géométrie
// indexée, sans déplacer aucun sommet. Pour l'OBJ, dont les normales sont
// écrites par face : une soupe STL de 2,2 M de sommets n'en garde que 360 k
// (dragon Stanford), et le fichier maigrit d'autant.
function _ioWeldExact(g){
  if(g.index) return g;
  const P = g.attributes.position.array, n = P.length / 3;
  const bits = new Uint32Array(P.buffer, P.byteOffset, P.length);
  let cap = 1; while(cap < n*2) cap <<= 1;
  const mask = cap - 1, table = new Int32Array(cap).fill(-1);
  const remap = new Uint32Array(n), rep = [];
  for(let i = 0; i < n; i++){
    const x = bits[3*i], y = bits[3*i+1], z = bits[3*i+2];
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
    for(;;){
      const s = table[h];
      if(s < 0){ table[h] = i; remap[i] = rep.length; rep.push(i); break; }
      if(bits[3*s] === x && bits[3*s+1] === y && bits[3*s+2] === z){ remap[i] = remap[s]; break; }
      h = (h + 1) & mask;
    }
  }
  const out = new THREE.BufferGeometry();
  const np = new Float32Array(rep.length*3);
  for(let k = 0; k < rep.length; k++){ np[3*k] = P[3*rep[k]]; np[3*k+1] = P[3*rep[k]+1]; np[3*k+2] = P[3*rep[k]+2]; }
  out.setAttribute('position', new THREE.BufferAttribute(np, 3));
  out.setIndex(new THREE.BufferAttribute(remap, 1));
  for(const gr of g.groups) out.addGroup(gr.start, gr.count, gr.materialIndex);
  g.dispose();
  return out;
}

// Extrait les triangles [start, start+count) d'une géométrie (soupe ou
// indexée) dans une géométrie autonome non indexée — découpe des parties OBJ
// (o/g) et STL (plusieurs « solid ») en objets distincts (importMesh).
function _ioSliceTris(g, start, count){
  const out = new THREE.BufferGeometry();
  const ix = g.index ? g.index.array : null;
  for(const k in g.attributes){
    const at = g.attributes[k], s = at.itemSize, src = at.array;
    let dst;
    if(ix){
      dst = new (src.constructor)(count*3*s);
      for(let t = 0; t < count; t++) for(let c = 0; c < 3; c++){
        const v = ix[3*(start + t) + c];
        for(let j = 0; j < s; j++) dst[(3*t + c)*s + j] = src[v*s + j];
      }
    } else {
      dst = src.slice(3*start*s, 3*(start + count)*s);
    }
    out.setAttribute(k, new THREE.BufferAttribute(dst, s, at.normalized));
  }
  return out;
}

// sRGB ↔ linéaire (glTF stocke baseColorFactor en LINÉAIRE ; three r128 et
// l'interface NASSCAD manipulent des hex sRGB).
function _ioSrgb2Lin(c){ return c <= 0.04045 ? c/12.92 : Math.pow((c + 0.055)/1.055, 2.4); }
function _ioLin2Srgb(c){
  if(!(c > 0)) return 0; if(c >= 1) return 1;
  return c <= 0.0031308 ? 12.92*c : 1.055*Math.pow(c, 1/2.4) - 0.055;
}

// Échappement XML (noms d'objets écrits dans le 3MF). Un « & » ou un « < »
// dans un nom — fréquent dans les noms de produits STEP — rendait tout le
// 3MF illisible : lib3mf, PrusaSlicer et Bambu Studio refusent le fichier.
function _ioXml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]))
                  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// Couleurs par triangle issues d'un fichier (PLY, OBJ, STL, 3MF) → groupes +
// tableau de matériaux, par _applyFaceColors (step-import.js), exactement le
// modèle des corps STEP multi-couleurs. faceRGB : Int32Array, 0xRRGGBB ou -1.
// Au-delà de maxColors teintes distinctes (32 par défaut : couleurs de
// sommets ou de faces PLY/OBJ/STL), c'est un scan coloré, pas des faces
// peintes : un matériau par teinte n'aurait aucun sens, on rend la teinte
// moyenne. Les appelants dont les teintes viennent d'une TABLE de matériaux
// (glTF, ressources 3MF) passent un plafond plus haut. Retourne {mats|null, hex:'#rrggbb'|null}. Réordonne les
// triangles de geo (par couleur) pour obtenir des plages contiguës.
function _ioApplyFaceRGB(geo, faceRGB, name, maxColors, prefer){
  maxColors = maxColors || 32;
  const n = faceRGB ? faceRGB.length : 0;
  if(!n) return {mats:null, hex:null};
  const count = new Map();
  let sr = 0, sg = 0, sb = 0, ns = 0;
  for(let t = 0; t < n; t++){
    const c = faceRGB[t]; if(c < 0) continue;
    count.set(c, (count.get(c)||0) + 1);
    sr += c >> 16 & 255; sg += c >> 8 & 255; sb += c & 255; ns++;
  }
  if(!ns) return {mats:null, hex:null};
  const hx = v => '#' + v.toString(16).padStart(6,'0');
  let dom = -1, dn = -1;
  // À égalité : la couleur de l'objet si le fichier en donne une (prefer), sinon
  // la plus basse — deux imports du même fichier donnent la même couleur.
  for(const [c, k] of count)
    if(k > dn || (k === dn && dom !== prefer && (c === prefer || c < dom))){ dn = k; dom = c; }
  if(count.size === 1) return {mats:null, hex:hx(dom)};
  if(count.size > maxColors)
    return {mats:null, hex:hx((Math.round(sr/ns) << 16) | (Math.round(sg/ns) << 8) | Math.round(sb/ns))};
  // Tri stable des triangles par couleur (triangles sans couleur → dominante)
  const col = new Int32Array(n);
  for(let t = 0; t < n; t++) col[t] = faceRGB[t] < 0 ? dom : faceRGB[t];
  const order = new Uint32Array(n);
  for(let t = 0; t < n; t++) order[t] = t;
  order.sort((a, b) => (col[a] - col[b]) || (a - b));
  if(geo.index){
    const src = geo.index.array, dst = new (src.constructor)(src.length);
    for(let k = 0; k < n; k++){ const t = order[k]; dst[3*k] = src[3*t]; dst[3*k+1] = src[3*t+1]; dst[3*k+2] = src[3*t+2]; }
    geo.setIndex(new THREE.BufferAttribute(dst, 1));
  } else {
    for(const key in geo.attributes){
      const at = geo.attributes[key], s = at.itemSize, src = at.array, dst = new (src.constructor)(src.length);
      for(let k = 0; k < n; k++){ const t = order[k]; for(let j = 0; j < 3*s; j++) dst[3*k*s + j] = src[3*t*s + j]; }
      geo.setAttribute(key, new THREE.BufferAttribute(dst, s, at.normalized));
    }
  }
  // Table au format _applyFaceColors : [r, g, b, start, count] (plages en index)
  const rows = [];
  let k = 0;
  while(k < n){
    const c = col[order[k]]; let e = k;
    while(e < n && col[order[e]] === c) e++;
    rows.push([(c >> 16 & 255)/255, (c >> 8 & 255)/255, (c & 255)/255, 3*k, 3*(e - k)]);
    k = e;
  }
  const mats = (typeof _applyFaceColors === 'function') ? _applyFaceColors(geo, rows, name) : null;
  return {mats, hex:hx(dom)};
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

// ── ZIP (OPC) — écriture ────────────────────────────────────────────────────
// [AUDIT 17/09] Réécrit à partir du writer "stored" d'origine :
//   · DEFLATE natif (CompressionStream, Chrome 80+/Firefox 113+/Safari 16.4+),
//     repli "stored" si l'API manque. Tous les slicers écrivent leurs 3MF
//     compressés ; le XML d'un maillage se comprime 4 à 6 fois.
//   · date/heure DOS réelles : l'ancien writer écrivait 0/0 — le 1980-00-00
//     qu'affichent les outils ZIP, une date invalide au sens du format.
//   · entrées gardées en morceaux (Uint8Array[]) : un maillage de plusieurs
//     millions de triangles ne passe plus par UNE chaîne JS géante (V8 plafonne
//     vers 512 Mo de caractères).
const _ioCrcTable = (() => { const t = new Uint32Array(256); for(let i = 0; i < 256; i++){ let c = i; for(let j = 0; j < 8; j++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c; } return t; })();
function _ioCrc32(parts){
  let c = 0xFFFFFFFF;
  for(const b of parts) for(let i = 0; i < b.length; i++) c = _ioCrcTable[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
async function _ioDeflateRaw(parts){
  if(typeof CompressionStream !== 'function') return null;
  try{
    const s = new Blob(parts).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }catch(e){ return null; }
}
// entries : [{name, parts: Uint8Array[]}] → Blob du ZIP
async function _ioZipWrite(entries){
  const enc = new TextEncoder();
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const out = [], cd = [];
  let off = 0;
  for(const e of entries){
    const nm = enc.encode(e.name);
    const usize = e.parts.reduce((s, p) => s + p.length, 0);
    const crc = _ioCrc32(e.parts);
    const def = await _ioDeflateRaw(e.parts);
    const method = def && def.length < usize ? 8 : 0;
    const data = method === 8 ? [def] : e.parts;
    const csize = method === 8 ? def.length : usize;
    if(usize > 0xFFFFFFFE || off > 0xFFFFFFFE) throw new Error('3MF part over 4 GB — ZIP64 is not supported');
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034B50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, method, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, csize, true); lh.setUint32(22, usize, true);
    lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014B50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true); ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, csize, true);
    ch.setUint32(24, usize, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
    out.push(new Uint8Array(lh.buffer), nm, ...data);
    cd.push(new Uint8Array(ch.buffer), nm);
    off += 30 + nm.length + csize;
  }
  const cdSize = cd.reduce((s, p) => s + p.length, 0);
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054B50, true); eo.setUint16(8, entries.length, true); eo.setUint16(10, entries.length, true);
  eo.setUint32(12, cdSize, true); eo.setUint32(16, off, true);
  return new Blob([...out, ...cd, new Uint8Array(eo.buffer)], {type: 'model/3mf'});
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
      nasLog('WARN','showSaveFilePicker: '+e.message+' — browser fallback');
    }
  }
  showSpinner('Export 3MF','Preparing…');
  // [02/09] Le rAF passe de callback à await : le contrôle d'étanchéité qui
  // suit est asynchrone.
  await new Promise(_r => requestAnimationFrame(_r));
  // [AUDIT 17/09] try/finally : une exception (corps multi-matériau, avant le
  // correctif) laissait le spinner affiché pour toujours, sans message.
  try{
    const t0 = performance.now();
    scene.updateMatrixWorld(true);

    // ── Passe 1 : géométries HD en repère monde + Z mini (pose sur le plateau)
    const geoList = [];
    let bzMin = Infinity;
    for(const so of objs){
      const gHD = _ioBakeGeo(so);
      const a = gHD.attributes.position.array;
      for(let i = 1; i < a.length; i += 3) if(a[i] < bzMin) bzMin = a[i];   // Y three = Z 3MF
      geoList.push({so, gHD, base: _ioObjColorHex(so), faces: _ioFacePalette(so)});
    }
    if(!isFinite(bzMin)) bzMin = 0;

    // [02/09] Étanchéité — cf. _watertightGate. La soudure conserve l'ordre des
    // triangles : les groupes (couleurs par face) restent valides ; les
    // triangles de bouchage éventuels sont ajoutés en fin, hors groupe.
    {
      const _wt = geoList.map((e,i) => ({geo: e.gHD, name: (e.so && e.so.name) || ('body '+(i+1))}));
      await _watertightGate(_wt, 'Export 3MF');
      for(let i=0;i<geoList.length;i++) geoList[i].gHD = _wt[i].geo;
      showSpinner('Export 3MF','Writing…');
    }
    const ozShift = -bzMin;   // Z mini = 0 : la pièce repose sur le plateau ; XY inchangés

    // ── Couleurs : UNE ressource m:colorgroup (id 1), indices positionnels.
    // [AUDIT 17/09] L'ancien code écrivait <m:color id="n" …> — attribut qui
    // n'existe pas dans l'extension Materials (lib3mf refuse le fichier en mode
    // strict) — et référençait pid="n" pindex="0" : un pid qui ne désignait
    // aucune ressource dès la 2e couleur. Correct : pid="1" pindex=rang.
    const colIdx = new Map(), colList = [];
    const _ci = h => { let i = colIdx.get(h); if(i === undefined){ i = colList.length; colIdx.set(h, i); colList.push(h); } return i; };
    for(const e of geoList){ e.pi = _ci(e.base); if(e.faces) e.fi = e.faces.map(_ci); }

    const enc = new TextEncoder();
    const parts = [];
    const put = s => parts.push(enc.encode(s));
    const f4 = v => String(+v.toFixed(4));   // 4 décimales, zéros inutiles retirés
    const day = new Date().toISOString().slice(0, 10);
    put(`<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">\n`
      + ` <metadata name="Application">NASSCAD V${_ioXml(NASSCAD_VERSION)}</metadata>\n`
      + ` <metadata name="CreationDate">${day}</metadata>\n <resources>\n  <m:colorgroup id="1">`
      + colList.map(h => `<m:color color="#${h.toUpperCase()}FF"/>`).join('') + `</m:colorgroup>\n`);

    // ── Passe 2 : un <object> par corps
    let oid = 2, nObj = 0, nTri = 0, nDegen = 0, nEmpty = 0;
    const items = [];
    for(let k = 0; k < geoList.length; k++){
      const {so, gHD, pi, fi} = geoList[k];
      const pos = gHD.attributes.position.array, ix = gHD.index ? gHD.index.array : null;
      const nV = pos.length / 3, nT = ix ? ix.length / 3 : nV / 3;
      const tm = fi ? _ioTriMaterial(gHD) : null;
      // Triangle dégénéré (deux sommets confondus après soudure) : interdit
      // par la spec (« MUST NOT ») — on l'écarte, il n'a aucune aire.
      const deg = t => { const a = ix ? ix[3*t] : 3*t, b = ix ? ix[3*t+1] : 3*t+1, c = ix ? ix[3*t+2] : 3*t+2; return a === b || b === c || a === c; };
      let kept = 0;
      for(let t = 0; t < nT; t++) if(!deg(t)) kept++;
      nDegen += nT - kept;
      if(!kept){ nEmpty++; gHD.dispose(); continue; }   // un objet sans triangle est invalide
      // Écriture par tranches : jamais une chaîne unique pour tout un corps.
      const L = [];
      const flush = () => { if(L.length){ put(L.join('')); L.length = 0; } };
      L.push(`  <object id="${oid}" name="${_ioXml(so.name)}" type="model" pid="1" pindex="${pi}"><mesh><vertices>`);
      for(let i = 0; i < nV; i++){
        L.push(`<vertex x="${f4(pos[3*i])}" y="${f4(-pos[3*i+2])}" z="${f4(pos[3*i+1] + ozShift)}"/>`);
        if(L.length >= 100000) flush();
      }
      L.push('</vertices><triangles>');
      for(let t = 0; t < nT; t++){
        if(deg(t)) continue;
        const a = ix ? ix[3*t] : 3*t, b = ix ? ix[3*t+1] : 3*t+1, c = ix ? ix[3*t+2] : 3*t+2;
        const m = tm ? tm[t] : -1;
        // pid explicite avec p1 : la spec autorise l'héritage du pid de l'objet,
        // mais lib3mf (référence du consortium) ne lit p1 qu'accompagné de pid.
        const p1 = (m >= 0 && fi[m] !== undefined && fi[m] !== pi) ? ` pid="1" p1="${fi[m]}"` : '';
        L.push(`<triangle v1="${a}" v2="${b}" v3="${c}"${p1}/>`);
        if(L.length >= 100000) flush();
      }
      L.push('</triangles></mesh></object>\n');
      flush();
      gHD.dispose();
      items.push(`  <item objectid="${oid}"/>`);
      oid++; nObj++; nTri += kept;
      if((k & 7) === 7){ showSpinner('Export 3MF', `Writing… ${k+1}/${geoList.length}`, (k+1)/geoList.length); await new Promise(r => setTimeout(r, 0)); }
    }
    put(` </resources>\n <build>\n${items.join('\n')}\n </build>\n</model>\n`);
    if(nDegen) nasLog('DBG', `Export 3MF — ${nDegen} degenerate triangle(s) dropped`);
    if(nEmpty) nasLog('WARN', `Export 3MF — ${nEmpty} object(s) without triangles skipped`);

    const ct = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
    showSpinner('Export 3MF','Compressing…');
    const blob = await _ioZipWrite([
      {name: '[Content_Types].xml', parts: [enc.encode(ct)]},
      {name: '_rels/.rels',         parts: [enc.encode(rels)]},
      {name: '3D/3dmodel.model',    parts},
    ]);
    await _nasSaveWithHandle('model.3mf', blob, 'model/3mf', _fh);
    nasLog('OK',`Export 3MF — ${nObj} object(s), ${nTri.toLocaleString('en-US')} triangles, ${colList.length} colour(s) — ${(blob.size/1024).toFixed(1)} KB — ${Math.round(performance.now()-t0)}ms`);
  }catch(err){
    nasLog('ERROR','Export 3MF: '+err.message);
    _nasAlert('⚠ Export 3MF failed:\n'+err.message);
  }finally{
    hideSpinner();
  }
}

// ── io-3mf-import.js ──────────────────────────────────────────────────────
// ── ZIP (OPC) — lecture ─────────────────────────────────────────────────────
// Index de la Central Directory (EOCD cherché depuis la fin, commentaire ZIP
// toléré). Les noms de parties OPC sont insensibles à la casse : clé en
// minuscules, sans '/' initial. Partagé par import3MF.
function _ioDecURI(s){ try{ return decodeURIComponent(s); }catch(e){ return s; } }
function _ioZipIndex(buf){
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for(let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--)
    if(dv.getUint32(i, true) === 0x06054B50){ eocd = i; break; }
  if(eocd < 0) throw new Error('not a ZIP archive (end of central directory not found)');
  const cdCnt = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  if(cdCnt === 0xFFFF || cdOff === 0xFFFFFFFF) throw new Error('ZIP64 archive (> 4 GB) is not supported');
  const dec = new TextDecoder();
  const map = new Map();
  let p = cdOff;
  for(let e = 0; e < cdCnt && p + 46 <= u8.length; e++){
    if(dv.getUint32(p, true) !== 0x02014B50) break;
    const meth = dv.getUint16(p + 10, true), csz = dv.getUint32(p + 20, true), usz = dv.getUint32(p + 24, true);
    const fnl = dv.getUint16(p + 28, true), exl = dv.getUint16(p + 30, true), cml = dv.getUint16(p + 32, true);
    const lh = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + fnl));
    map.set(name.replace(/^\/+/, '').toLowerCase(), {name, meth, csz, usz, lh});
    p += 46 + fnl + exl + cml;
  }
  const read = async path => {
    const key = _ioDecURI(String(path)).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    const en = map.get(key);
    if(!en) return null;
    if(dv.getUint32(en.lh, true) !== 0x04034B50) throw new Error('corrupt ZIP entry: ' + en.name);
    const off = en.lh + 30 + dv.getUint16(en.lh + 26, true) + dv.getUint16(en.lh + 28, true);
    const data = u8.subarray(off, off + en.csz);
    if(en.meth === 0) return data;
    if(en.meth === 8){
      const s = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(s).arrayBuffer());
    }
    throw new Error(`unsupported ZIP compression method ${en.meth} (${en.name})`);
  };
  return {map, read};
}

// ── Import 3MF ─────────────────────────────────────────────────────────────
// [AUDIT 17/09] Réécrit — défauts reproduits sur le corpus de test :
//   · partie racine trouvée par NOM ('3dmodel.model') : un 3MF valide dont la
//     racine s'appelle autrement (désignée par _rels/.rels, règle OPC) était
//     refusé → lecture de la relation StartPart, le nom en repli ;
//   · attribut `unit` ignoré : un fichier en pouces arrivait 25,4× trop petit,
//     en cm 10× → conversion en mm (micron/mm/cm/inch/foot/meter) ;
//   · couleurs : `getElementsByTagName('colorgroup')` ne voit PAS l'élément
//     préfixé `m:colorgroup` — même nos propres exports perdaient leurs
//     couleurs au retour. Recherche par nom local (NS '*'). basematerials
//     (cœur de la spec) désormais lu ; couleurs par triangle (pid/p1) rendues
//     en faces colorées, comme les corps STEP ;
//   · composants et items MIROIRS (déterminant < 0) : triangles retournés ;
//   · index de sommet hors bornes : TypeError cryptique → triangle écarté et
//     signalé ; objets type="other" jamais construits (règle de la spec) ;
//   · disposition : chaque objet était recentré puis éparpillé en spirale —
//     les positions du plateau (Bambu, Prusa) étaient perdues. L'ensemble est
//     désormais posé comme un assemblage, positions relatives conservées,
//     exactement comme l'import GLB ;
//   · double undoPush quand l'appel vient d'importMesh (qui en fait déjà un) :
//     opts.noUndo.
async function import3MF(file, opts){
  const _noUndo = !!(opts && opts.noUndo);
  showSpinner('Import 3MF', file.name);
  try{
    const buf = await file.arrayBuffer();
    const zip = _ioZipIndex(buf);
    const dec = new TextDecoder();
    const PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
    const $$ = (el, local) => Array.from(el.getElementsByTagNameNS('*', local));
    const $1 = (el, local) => el.getElementsByTagNameNS('*', local)[0] || null;
    const kids = (el, local) => Array.from(el.children).filter(c => c.localName === local);

    // ── Partie racine : relation 3D Model de _rels/.rels (OPC), repli par nom
    let rootPath = null;
    const relBytes = await zip.read('_rels/.rels');
    if(relBytes){
      const rd = new DOMParser().parseFromString(dec.decode(relBytes), 'application/xml');
      for(const r of $$(rd, 'Relationship')){
        if(/\/3dmanufacturing\/2013\/01\/3dmodel$/.test(r.getAttribute('Type') || '')){ rootPath = r.getAttribute('Target'); break; }
      }
    }
    if(!rootPath || !zip.map.has(_ioDecURI(rootPath).replace(/^\/+/, '').toLowerCase())){
      const k = [...zip.map.keys()].find(n => n.endsWith('3dmodel.model')) || [...zip.map.keys()].find(n => n.endsWith('.model'));
      if(!k) throw new Error('no 3D model part in this package (not a 3MF file?)');
      rootPath = k;
    }

    // ── Documents .model (racine + parties externes de l'extension Production)
    const UNIT = {micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000};
    const docs = new Map();
    async function loadDoc(path){
      const key = _ioDecURI(path).replace(/^\/+/, '').toLowerCase();
      if(docs.has(key)) return docs.get(key);
      const bytes = await zip.read(key);
      if(!bytes){ docs.set(key, null); return null; }
      const xd = new DOMParser().parseFromString(dec.decode(bytes), 'application/xml');
      if(xd.getElementsByTagName('parsererror').length)
        throw new Error(`malformed XML in ${path}: ` + xd.getElementsByTagName('parsererror')[0].textContent.slice(0, 120));
      const model = xd.documentElement;
      const unit = model.getAttribute('unit') || 'millimeter';
      if(!(unit in UNIT)) nasLog('WARN', `Import 3MF: unknown unit "${unit}" in ${path} — millimetres assumed`);
      const res = $1(model, 'resources');
      const objects = new Map(), props = new Map();
      if(res){
        for(const o of kids(res, 'object')) objects.set(o.getAttribute('id'), o);
        // Groupes de propriétés porteurs de couleur : id → ['rrggbb'|null, …]
        const hex = s => { const m = /^#?([0-9a-f]{6})/i.exec(s || ''); return m ? m[1].toLowerCase() : null; };
        for(const bm of kids(res, 'basematerials')) props.set(bm.getAttribute('id'), kids(bm, 'base').map(b => hex(b.getAttribute('displaycolor'))));
        for(const cg of kids(res, 'colorgroup'))    props.set(cg.getAttribute('id'), kids(cg, 'color').map(c => hex(c.getAttribute('color'))));
      }
      const d = {key, path, scale: UNIT[unit] || 1, objects, props, model};
      docs.set(key, d);
      return d;
    }
    const root = await loadDoc(rootPath);
    if(!root) throw new Error('3D model part not found: ' + rootPath);

    // ── Transformations 3MF : 12 nombres m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32
    const ID = [1,0,0, 0,1,0, 0,0,1, 0,0,0];
    const parseTf = s => {
      if(!s) return ID;
      const m = s.trim().split(/\s+/).map(Number);
      return (m.length === 12 && m.every(isFinite)) ? m : ID;
    };
    const mulTf = (A, B) => {   // point transformé par A puis par B
      const r = new Array(12);
      for(let i = 0; i < 3; i++){
        for(let j = 0; j < 3; j++) r[3*i+j] = A[3*i]*B[j] + A[3*i+1]*B[3+j] + A[3*i+2]*B[6+j];
      }
      for(let j = 0; j < 3; j++) r[9+j] = A[9]*B[j] + A[10]*B[3+j] + A[11]*B[6+j] + B[9+j];
      return r;
    };
    const detTf = m => m[0]*(m[4]*m[8]-m[5]*m[7]) - m[1]*(m[3]*m[8]-m[5]*m[6]) + m[2]*(m[3]*m[7]-m[4]*m[6]);
    // Les translations d'un document sont dans SES unités : on les ramène en mm
    // une fois pour toutes, et tout `tf` manipulé ci-dessous est en mm.
    const toMM = (m, S) => m.map((v, i) => i >= 9 ? v*S : v);

    // ── Résolution récursive d'un objet → morceaux {pos (mm, Z-up, repère
    //    racine), tri (Uint32 index), rgb (Int32 par triangle ou null)}.
    //    tf : repère de l'objet (en mm) → repère racine (en mm).
    let badIdx = 0;
    const stack = new Set();
    async function resolve(doc, objEl, tf, out){
      const id = doc.key + '#' + objEl.getAttribute('id');
      if(stack.has(id)) throw new Error('circular component reference in 3MF');
      stack.add(id);
      const mesh = kids(objEl, 'mesh')[0];
      if(mesh){
        const vEls = $$(mesh, 'vertex'), tEls = $$(mesh, 'triangle');
        const nV = vEls.length;
        if(nV && tEls.length){
          const S = doc.scale, pos = new Float32Array(nV*3);
          for(let i = 0; i < nV; i++){
            const v = vEls[i];
            const x = +v.getAttribute('x')*S, y = +v.getAttribute('y')*S, z = +v.getAttribute('z')*S;
            pos[3*i]   = tf[0]*x + tf[3]*y + tf[6]*z + tf[9];
            pos[3*i+1] = tf[1]*x + tf[4]*y + tf[7]*z + tf[10];
            pos[3*i+2] = tf[2]*x + tf[5]*y + tf[8]*z + tf[11];
          }
          const flip = detTf(tf) < 0;
          const idx = new Uint32Array(tEls.length*3);
          const opid = objEl.getAttribute('pid'), opi = +(objEl.getAttribute('pindex') || 0);
          const colOf = (pid, pi) => { const g = doc.props.get(pid); return g && g[pi] ? parseInt(g[pi], 16) : -1; };
          const objRGB = opid !== null ? colOf(opid, opi) : -1;
          let rgb = null, n = 0;
          for(const t of tEls){
            const a = +t.getAttribute('v1'), b = +t.getAttribute('v2'), c = +t.getAttribute('v3');
            if(!(a >= 0 && a < nV && b >= 0 && b < nV && c >= 0 && c < nV) || a % 1 || b % 1 || c % 1){ badIdx++; continue; }
            idx[3*n] = a; idx[3*n+1] = flip ? c : b; idx[3*n+2] = flip ? b : c;
            const p1 = t.getAttribute('p1');
            const c1 = p1 !== null ? colOf(t.getAttribute('pid') || opid, +p1) : objRGB;
            if(c1 >= 0){ if(!rgb){ rgb = new Int32Array(tEls.length).fill(-1); } rgb[n] = c1; }
            n++;
          }
          if(n) out.push({pos, tri: idx.subarray(0, 3*n), rgb: rgb ? rgb.subarray(0, n) : null, objRGB});
        }
      }
      const comps = kids(objEl, 'components')[0];
      if(comps){
        for(const c of kids(comps, 'component')){
          const path = c.getAttributeNS(PROD, 'path') || c.getAttribute('p:path');
          const cdoc = path ? await loadDoc(path) : doc;
          if(!cdoc){ nasLog('WARN', `Import 3MF: component part ${path} missing`); continue; }
          const ref = cdoc.objects.get(c.getAttribute('objectid'));
          if(!ref) continue;
          // transformation du composant : exprimée dans les unités du document PARENT
          await resolve(cdoc, ref, mulTf(toMM(parseTf(c.getAttribute('transform')), doc.scale), tf), out);
        }
      }
      stack.delete(id);
    }

    // ── Build : un objet NASSCAD par item (les supports et 'other' écartés)
    const buildEl = $1(root.model, 'build');
    const items = buildEl ? kids(buildEl, 'item') : [];
    const targets = items.length
      ? items.map(it => ({id: it.getAttribute('objectid'), tf: toMM(parseTf(it.getAttribute('transform')), root.scale)}))
      : [...root.objects.keys()].map(id => ({id, tf: ID}));
    const bodies = [];
    let skipped = 0;
    for(const {id, tf} of targets){
      const objEl = root.objects.get(id);
      if(!objEl) continue;
      const type = objEl.getAttribute('type') || 'model';
      if(type === 'support' || type === 'solidsupport' || type === 'other'){ skipped++; continue; }
      const chunks = [];
      await resolve(root, objEl, tf, chunks);
      if(!chunks.length) continue;
      // Fusion des morceaux (composants) en une géométrie indexée
      let nV = 0, nT = 0;
      for(const ch of chunks){ nV += ch.pos.length/3; nT += ch.tri.length/3; }
      const pos = new Float32Array(nV*3), tri = new Uint32Array(nT*3);
      const rgb = chunks.some(ch => ch.rgb) ? new Int32Array(nT).fill(-1) : null;
      let vo = 0, to = 0;
      for(const ch of chunks){
        // Z-up (3MF) → Y-up (three) : (x, y, z) → (x, z, -y)
        for(let i = 0; i < ch.pos.length; i += 3){ pos[3*vo + i] = ch.pos[i]; pos[3*vo + i + 1] = ch.pos[i+2]; pos[3*vo + i + 2] = -ch.pos[i+1]; }
        for(let i = 0; i < ch.tri.length; i++) tri[3*to + i] = ch.tri[i] + vo;
        if(rgb && ch.rgb) rgb.set(ch.rgb, to);
        else if(rgb && ch.objRGB >= 0) rgb.fill(ch.objRGB, to, to + ch.tri.length/3);
        vo += ch.pos.length/3; to += ch.tri.length/3;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setIndex(new THREE.BufferAttribute(tri, 1));
      const nm = objEl.getAttribute('name') || file.name.replace(/\.[^.]+$/, '');
      const pref = chunks.find(ch => ch.objRGB >= 0);
      bodies.push({geo, rgb, name: nm, prefer: pref ? pref.objRGB : undefined});
    }
    if(badIdx) nasLog('WARN', `Import 3MF: ${badIdx} triangle(s) with invalid vertex indices dropped`);
    if(skipped) nasLog('DBG', `Import 3MF: ${skipped} support/other item(s) not imported`);
    if(!bodies.length) throw new Error('no printable object in this 3MF');

    // ── Mise en scène : assemblage, positions relatives conservées
    if(!_noUndo) undoPush('import');
    let gMin = [Infinity, Infinity, Infinity], gMax = [-Infinity, -Infinity, -Infinity];
    for(const b of bodies){
      b.geo.computeBoundingBox();
      const bb = b.geo.boundingBox;
      gMin = [Math.min(gMin[0], bb.min.x), Math.min(gMin[1], bb.min.y), Math.min(gMin[2], bb.min.z)];
      gMax = [Math.max(gMax[0], bb.max.x), Math.max(gMax[1], bb.max.y), Math.max(gMax[2], bb.max.z)];
    }
    const ox = -(gMin[0] + gMax[0])/2, oy = -gMin[1], oz = -(gMin[2] + gMax[2])/2;
    // Place libre calculée AVANT d'ajouter nos objets à objs : _findFreePos
    // n'examine que les positions déjà en scène (et ignore son 1er argument).
    const fp = _findFreePos(null, Math.max(gMax[0] - gMin[0], gMax[2] - gMin[2]) + 2);
    const made = [];
    for(const b of bodies){
      const geo = b.geo;
      geo.translate(ox, oy, oz);
      const cg = computeCenterOfGravity(geo);          // pivot au centre de gravité
      geo.translate(-cg.x, -cg.y, -cg.z);
      objCnt++;
      const fc = _ioApplyFaceRGB(geo, b.rgb, b.name, 256, b.prefer);
      geo.computeVertexNormals();
      const col = fc.hex || COL[objCnt % COL.length];
      const mat = fc.mats || new THREE.MeshPhongMaterial({color: col, shininess: 8, specular: 0x1a1a1a, side: THREE.DoubleSide});
      const mesh = new THREE.Mesh(geo, mat); mesh.castShadow = true; mesh.receiveShadow = false; scene.add(mesh);
      mesh.position.set(cg.x, cg.y, cg.z);
      mesh.updateMatrixWorld(true);
      const o = {id: objCnt, name: b.name + '_' + objCnt, type: 'csg', mesh, color: col, isHole: false};
      objs.push(o); made.push(o);
    }
    made.forEach(o => { o.mesh.position.x += fp.x; o.mesh.position.z += fp.z; o.mesh.updateMatrixWorld(true); });
    selObjs = made.slice();
    updProps(); updOList(); updStats();
    hideSpinner();
    const units = [...docs.values()].filter(Boolean).map(d => d.scale);
    nasLog('OK', `Import 3MF — ${made.length} object(s) from ${file.name}` + (units.some(s => s !== 1) ? ` (units converted to mm ×${units.find(s => s !== 1)})` : ''));
    _csgLog(`✓ 3MF imported: ${made.length} object(s)`);
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

// Encode un maillage INDEXÉ (POSITION + NORMAL) en un blob Draco, prêt à être
// écrit dans un bufferView GLB. Retourne aussi les unique IDs Draco par
// attribut — glTF exige un mapping EXPLICITE — et les comptes RÉELLEMENT
// encodés : l'edgebreaker peut dédoublonner des points, et les accessors du
// glTF doivent annoncer ce que le décodeur rendra (GetNumberOfEncodedPoints/
// Faces, même méthode que gltf-pipeline).
async function _encodeDracoMesh(pos, nor, idx){
  const dracoEnc = await _getDracoEncoder();
  const builder = new dracoEnc.MeshBuilder();
  const meshObj = new dracoEnc.Mesh();
  const vc = pos.length / 3;
  try{
    const idPos = builder.AddFloatAttributeToMesh(meshObj, dracoEnc.POSITION, vc, 3, pos);
    let idNor = null;
    if(nor) idNor = builder.AddFloatAttributeToMesh(meshObj, dracoEnc.NORMAL, vc, 3, nor);
    // [AUDIT 17/09] Les VRAIS indices du maillage (l'ancien code dépliait tout
    // en soupe, 3 sommets par triangle, puis numérotait 0..n-1).
    builder.AddFacesToMesh(meshObj, idx.length / 3, idx);

    const encoder = new dracoEnc.Encoder();
    encoder.SetSpeedOptions(5, 5); // équilibré, cohérent avec le défaut Three.js
    encoder.SetEncodingMethod(dracoEnc.MESH_EDGEBREAKER_ENCODING);
    // 14 bits sur la boîte de CE maillage : pas de 1/16383 de sa plus grande
    // dimension — ≈ 6 µm sur une pièce de 100 mm, 61 µm sur 1 m. (L'ancien
    // commentaire annonçait « sub-µm » : faux d'un facteur 6.)
    encoder.SetAttributeQuantization(dracoEnc.POSITION, 14);
    if(nor) encoder.SetAttributeQuantization(dracoEnc.NORMAL, 10);
    // Sans ce drapeau, GetNumberOfEncodedPoints/Faces rendent 0.
    if(typeof encoder.SetTrackEncodedProperties === 'function') encoder.SetTrackEncodedProperties(true);

    const encodedData = new dracoEnc.DracoInt8Array();
    const length = encoder.EncodeMeshToDracoBuffer(meshObj, encodedData);
    if(length === 0) throw new Error('Draco encoding failed (EncodeMeshToDracoBuffer returned 0)');
    let points = typeof encoder.GetNumberOfEncodedPoints === 'function' ? encoder.GetNumberOfEncodedPoints() : 0;
    let faces  = typeof encoder.GetNumberOfEncodedFaces  === 'function' ? encoder.GetNumberOfEncodedFaces()  : 0;

    const bytes = new Uint8Array(length);
    for(let i=0;i<length;i++) bytes[i] = encodedData.GetValue(i);

    dracoEnc.destroy(encodedData);
    dracoEnc.destroy(encoder);
    // Repli si le suivi n'est pas disponible : on décode le flux avec le
    // décodeur du même compagnon.
    if(!(points > 0 && faces > 0)){
      const dd = await _getDraco();
      const dec = new dd.Decoder(), db = new dd.DecoderBuffer(), dm = new dd.Mesh();
      try{
        db.Init(new Int8Array(bytes.buffer), length);
        const st = dec.DecodeBufferToMesh(db, dm);
        if(!st.ok()) throw new Error('Draco self-check failed: ' + st.error_msg());
        points = dm.num_points(); faces = dm.num_faces();
      } finally { dd.destroy(dm); dd.destroy(db); dd.destroy(dec); }
    }

    const attributes = { POSITION: idPos };
    if(idNor !== null) attributes.NORMAL = idNor;
    return { bytes, attributes, points, faces };
  } finally {
    dracoEnc.destroy(meshObj);
    dracoEnc.destroy(builder);
  }
}

// Sous-maillage compact (sommets réellement utilisés, renumérotés) — une
// primitive Draco par couleur doit être autonome.
function _ioSubMesh(pos, nor, tris){
  const map = new Map(), P = [], N = nor ? [] : null, I = new Uint32Array(tris.length);
  for(let k = 0; k < tris.length; k++){
    const v = tris[k];
    let r = map.get(v);
    if(r === undefined){
      r = map.size; map.set(v, r);
      P.push(pos[3*v], pos[3*v+1], pos[3*v+2]);
      if(N) N.push(nor[3*v], nor[3*v+1], nor[3*v+2]);
    }
    I[k] = r;
  }
  return {pos: new Float32Array(P), nor: N ? new Float32Array(N) : null, idx: I};
}

// Blinn-Phong (NASSCAD, three r128) → métal/rugosité (glTF) : α = √(2/(n+2)),
// roughness = √α. Métal si l'objet porte un matériau de la famille 'metal'
// (nasscad-materials.js) — sinon diélectrique. Sans ces valeurs, glTF prend
// metallicFactor = 1 par défaut : tout sortait en métal sombre dans les
// visionneuses PBR.
function _ioPbrOf(o, hex){
  const m = Array.isArray(o.mesh.material) ? o.mesh.material[0] : o.mesh.material;
  const n = (m && m.shininess > 0) ? m.shininess : 8;
  let metal = 0;
  if(o.matId && typeof NASSCAD_MATERIALS !== 'undefined'){
    const e = NASSCAD_MATERIALS.find(x => x.id === o.matId);
    if(e && e.family === 'metal') metal = 1;
  }
  const opacity = (m && m.transparent && m.opacity < 1 && !o.isHole) ? m.opacity : 1;
  return {hex, metal, rough: +Math.sqrt(Math.sqrt(2/(n + 2))).toFixed(3), opacity: +opacity.toFixed(3)};
}

async function expGLB(useDraco){
  let _fh=null;
  if(typeof showSaveFilePicker==='function' && !(window.electronAPI&&window.electronAPI.isElectron)){
    try{
      _fh=await showSaveFilePicker({suggestedName:'model.glb',types:[{description:'GLB File',accept:{'model/gltf-binary':['.glb']}}]});
    }catch(e){
      if(e.name==='AbortError') return;
      nasLog('WARN','showSaveFilePicker: '+e.message+' — browser fallback');
    }
  }
  showSpinner('Export GLB', useDraco ? 'Compressing (Draco)…' : 'Preparing…');
  await new Promise(r => requestAnimationFrame(r));
  try{
  const t0 = performance.now();
  scene.updateMatrixWorld(true);
  const enc = new TextEncoder();
  // [AUDIT 17/09] UNITÉS. glTF 2.0 est en MÈTRES (spec §3.2) ; NASSCAD
  // écrivait ses millimètres tels quels : une pièce de 20 mm s'ouvrait à 20 m
  // dans Blender, Windows 3D Viewer, Sketchfab, model-viewer. Conversion
  // mm → m ici ; asset.extras.lengthUnit la signale, et l'import s'en sert
  // pour reconnaître les GLB NASSCAD antérieurs (écrits en mm).
  const S = 0.001;

  // ── Collecte : géométrie HD monde, indexée, normales, couleurs ────────────
  // Indexée + normales cohérentes → gardée telle quelle (fichier plus léger,
  // lissage conservé). Sinon → soupe à normales de face (comportement
  // d'origine, le seul correct sans normales fiables).
  const meshesIn = [];
  for(const so of objs){
    let g = _ioBakeGeo(so);
    const P = g.attributes.position;
    if(!P || !P.count){ g.dispose(); continue; }
    const N = g.attributes.normal;
    if(!(g.index && N && N.count === P.count)){
      const gi = g.index ? g.toNonIndexed() : g;
      if(gi !== g) g.dispose();
      gi.computeVertexNormals();
      g = gi;
    }
    const pos = new Float32Array(g.attributes.position.array);
    for(let i = 0; i < pos.length; i++) pos[i] *= S;
    const nor = new Float32Array(g.attributes.normal.array);
    const nV = pos.length / 3;
    const soup = !g.index;
    const idx = g.index ? new Uint32Array(g.index.array) : (() => { const a = new Uint32Array(nV); for(let i = 0; i < nV; i++) a[i] = i; return a; })();
    // NORMAL doit être unitaire (spec §3.7.2.1, contrôlé par le validateur
    // Khronos). Sommets inutilisés ou triangles dégénérés laissent des normales
    // nulles : on les reprend des faces voisines, sinon (0, 0, 1).
    {
      const bad = new Uint8Array(nV); let nb = 0;
      for(let v = 0; v < nV; v++){
        const l = Math.hypot(nor[3*v], nor[3*v+1], nor[3*v+2]);
        if(l > 1e-6 && isFinite(l)){ nor[3*v] /= l; nor[3*v+1] /= l; nor[3*v+2] /= l; }
        else { bad[v] = 1; nb++; nor[3*v] = nor[3*v+1] = nor[3*v+2] = 0; }
      }
      if(nb){
        for(let t = 0; t + 2 < idx.length; t += 3){
          const a = idx[t], b = idx[t+1], c = idx[t+2];
          if(!(bad[a] | bad[b] | bad[c])) continue;
          const ux = pos[3*b]-pos[3*a], uy = pos[3*b+1]-pos[3*a+1], uz = pos[3*b+2]-pos[3*a+2];
          const vx = pos[3*c]-pos[3*a], vy = pos[3*c+1]-pos[3*a+1], vz = pos[3*c+2]-pos[3*a+2];
          const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
          for(const v of [a, b, c]) if(bad[v]){ nor[3*v] += nx; nor[3*v+1] += ny; nor[3*v+2] += nz; }
        }
        for(let v = 0; v < nV; v++) if(bad[v]){
          const l = Math.hypot(nor[3*v], nor[3*v+1], nor[3*v+2]);
          if(l > 1e-12 && isFinite(l)){ nor[3*v] /= l; nor[3*v+1] /= l; nor[3*v+2] /= l; }
          else { nor[3*v] = 0; nor[3*v+1] = 0; nor[3*v+2] = 1; }
        }
      }
    }
    // Primitives : une par couleur de face (corps multi-matériau), sinon une seule
    const base = _ioObjColorHex(so), pal = _ioFacePalette(so);
    const prims = [];
    if(pal){
      const tm = _ioTriMaterial(g);
      const byCol = new Map();
      for(let t = 0; t < tm.length; t++){
        const h = tm[t] >= 0 && pal[tm[t]] ? pal[tm[t]] : base;
        let L = byCol.get(h); if(!L){ L = []; byCol.set(h, L); }
        L.push(idx[3*t], idx[3*t+1], idx[3*t+2]);
      }
      for(const [h, L] of byCol) prims.push({hex: h, idx: new Uint32Array(L)});
    } else {
      prims.push({hex: base, idx});
    }
    g.dispose();
    meshesIn.push({name: so.name, pos, nor, prims, soup, pbr: _ioPbrOf(so, base)});
  }
  if(!meshesIn.length) throw new Error('nothing to export (no triangles)');

  // ── Matériaux (dédoublonnés) ──────────────────────────────────────────────
  const materials = [], matKey = new Map();
  const matOf = (hex, pbr) => {
    const k = hex + '|' + pbr.metal + '|' + pbr.rough + '|' + pbr.opacity;
    let i = matKey.get(k);
    if(i !== undefined) return i;
    const c = [0, 2, 4].map(o => +_ioSrgb2Lin(parseInt(hex.substr(o, 2), 16)/255).toFixed(5));
    const m = {name: '#' + hex, pbrMetallicRoughness: {baseColorFactor: [...c, pbr.opacity], metallicFactor: pbr.metal, roughnessFactor: pbr.rough}, doubleSided: true};
    if(pbr.opacity < 1) m.alphaMode = 'BLEND';
    i = materials.length; materials.push(m); matKey.set(k, i);
    return i;
  };

  // ── Buffer binaire + JSON ─────────────────────────────────────────────────
  const chunks = []; let binLen = 0;
  const pushView = (u8, target) => {
    const pad = (4 - (binLen % 4)) % 4;
    if(pad){ chunks.push(new Uint8Array(pad)); binLen += pad; }
    const bv = {buffer: 0, byteOffset: binLen, byteLength: u8.byteLength};
    if(target) bv.target = target;
    chunks.push(u8); binLen += u8.byteLength;
    bufferViews.push(bv);
    return bufferViews.length - 1;
  };
  const bufferViews = [], accessors = [], meshes = [], nodes = [];
  const u8of = ta => new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength);
  const idxArray = (a, nV) => nV > 65535 ? a : Uint16Array.from(a);
  const bboxOf = pos => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for(let i = 0; i < pos.length; i += 3) for(let k = 0; k < 3; k++){ const v = pos[i+k]; if(v < mn[k]) mn[k] = v; if(v > mx[k]) mx[k] = v; }
    return {min: mn, max: mx};
  };
  let nPrim = 0;
  for(let mi = 0; mi < meshesIn.length; mi++){
    const m = meshesIn[mi];
    const primitives = [];
    if(useDraco){
      for(const pr of m.prims){
        const sub = m.prims.length > 1 ? _ioSubMesh(m.pos, m.nor, pr.idx) : {pos: m.pos, nor: m.nor, idx: pr.idx};
        const d = await _encodeDracoMesh(sub.pos, sub.nor, sub.idx);
        const bb = bboxOf(sub.pos);
        const aPos = accessors.push({componentType: 5126, count: d.points, type: 'VEC3', min: bb.min, max: bb.max}) - 1;
        const aNor = accessors.push({componentType: 5126, count: d.points, type: 'VEC3'}) - 1;
        const aIdx = accessors.push({componentType: d.points > 65535 ? 5125 : 5123, count: d.faces*3, type: 'SCALAR'}) - 1;
        const bv = pushView(d.bytes, 0);
        const dAttr = {POSITION: d.attributes.POSITION};
        if(d.attributes.NORMAL !== undefined) dAttr.NORMAL = d.attributes.NORMAL;
        primitives.push({attributes: {POSITION: aPos, NORMAL: aNor}, indices: aIdx, mode: 4, material: matOf(pr.hex, m.pbr),
          extensions: {KHR_draco_mesh_compression: {bufferView: bv, attributes: dAttr}}});
        nPrim++;
      }
    } else {
      const nV = m.pos.length / 3, bb = bboxOf(m.pos);
      const vPos = pushView(u8of(m.pos), 34962), vNor = pushView(u8of(m.nor), 34962);
      const aPos = accessors.push({bufferView: vPos, componentType: 5126, count: nV, type: 'VEC3', min: bb.min, max: bb.max}) - 1;
      const aNor = accessors.push({bufferView: vNor, componentType: 5126, count: nV, type: 'VEC3'}) - 1;
      if(m.soup && m.prims.length === 1){
        // Soupe à une seule couleur : les indices 0..n-1 n'apportent rien (+12 o
        // par triangle) — primitive non indexée, comme avant.
        primitives.push({attributes: {POSITION: aPos, NORMAL: aNor}, mode: 4, material: matOf(m.prims[0].hex, m.pbr)});
        nPrim++;
      } else for(const pr of m.prims){
        const ia = idxArray(pr.idx, nV);
        const vIdx = pushView(u8of(ia), 34963);
        const aIdx = accessors.push({bufferView: vIdx, componentType: nV > 65535 ? 5125 : 5123, count: ia.length, type: 'SCALAR'}) - 1;
        primitives.push({attributes: {POSITION: aPos, NORMAL: aNor}, indices: aIdx, mode: 4, material: matOf(pr.hex, m.pbr)});
        nPrim++;
      }
    }
    meshes.push({name: m.name, primitives});
    nodes.push({mesh: mi, name: m.name});
    if(useDraco && (mi & 7) === 7){ showSpinner('Export GLB', `Compressing (Draco)… ${mi+1}/${meshesIn.length}`, (mi+1)/meshesIn.length); await new Promise(r => setTimeout(r, 0)); }
  }
  const binPad = (4 - (binLen % 4)) % 4;
  if(binPad){ chunks.push(new Uint8Array(binPad)); binLen += binPad; }
  const gltf = {
    asset: {version: '2.0', generator: 'NASSCAD V' + NASSCAD_VERSION, extras: {lengthUnit: 'meter'}},
    scene: 0,
    scenes: [{name: 'Scene', nodes: nodes.map((_, i) => i)}],
    nodes, meshes, materials, accessors, bufferViews,
    buffers: [{byteLength: binLen}]
  };
  if(useDraco){
    gltf.extensionsUsed = ['KHR_draco_mesh_compression'];
    gltf.extensionsRequired = ['KHR_draco_mesh_compression'];
  }

  // ── Assemblage GLB : en-tête 12 o, chunk JSON (bourré d'espaces), chunk BIN
  const jsonBytes = enc.encode(JSON.stringify(gltf));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jBuf = new Uint8Array(jsonBytes.length + jsonPad);
  jBuf.set(jsonBytes); jBuf.fill(0x20, jsonBytes.length);
  const totalLen = 12 + 8 + jBuf.length + 8 + binLen;
  const head = new DataView(new ArrayBuffer(20));
  head.setUint32(0, 0x46546C67, true); head.setUint32(4, 2, true); head.setUint32(8, totalLen, true);
  head.setUint32(12, jBuf.length, true); head.setUint32(16, 0x4E4F534A, true);
  const binHead = new DataView(new ArrayBuffer(8));
  binHead.setUint32(0, binLen, true); binHead.setUint32(4, 0x004E4942, true);
  const blob = new Blob([head.buffer, jBuf, binHead.buffer, ...chunks], {type: 'model/gltf-binary'});

  await _nasSaveWithHandle('model.glb', blob, 'model/gltf-binary', _fh);
  nasLog('OK',`Export GLB${useDraco?' (Draco)':''} — ${meshesIn.length} object(s), ${nPrim} primitive(s), ${materials.length} material(s), metres — ${(totalLen/1024).toFixed(1)} KB — ${Math.round(performance.now()-t0)}ms`);
  } catch(err){
    nasLog('ERROR','Export GLB: '+err.message);
    _nasAlert('⚠ Export GLB failed:\n'+err.message);
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

// ── Lecture d'un accessor glTF → tableau typé ────────────────────────────────
// [AUDIT 17/09] Réécrit. L'ancien lecteur annonçait les accessors épars sans
// les lire, ignorait `normalized` (KHR_mesh_quantization) et plantait sur un
// accessor sans bufferView. Couvre maintenant la spec 2.0 §3.6 :
//   · bufferView absent → zéros (puis valeurs éparses éventuelles) ;
//   · byteStride (entrelacé), tous les componentType ;
//   · normalized : int8 → max(c/127, −1), uint8 → c/255, int16 → max(c/32767, −1),
//     uint16 → c/65535 ;
//   · sparse : indices + valeurs substitués.
// float=true → Float32Array (attributs) ; false → Uint32Array (indices).
const _GLTF_NC = {SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT2:4, MAT3:9, MAT4:16};
const _GLTF_CS = {5120:1, 5121:1, 5122:2, 5123:2, 5125:4, 5126:4};
function _gltfView(gltf, bufs, bvIdx){
  const bv = gltf.bufferViews && gltf.bufferViews[bvIdx];
  if(!bv) throw new Error(`glTF: bufferView ${bvIdx} missing`);
  if(bv.extensions && bv.extensions.EXT_meshopt_compression){
    const fb = gltf.buffers[bv.buffer];
    if(!bufs[bv.buffer] || (fb && fb.extensions && fb.extensions.EXT_meshopt_compression && fb.extensions.EXT_meshopt_compression.fallback))
      throw new Error('this glTF is compressed with EXT_meshopt_compression, which NASSCAD cannot decode — re-export it without meshopt (e.g. gltfpack without -c, or Blender)');
  }
  const buf = bufs[bv.buffer];
  if(!buf) throw new Error(`glTF: buffer ${bv.buffer} is not available`);
  const off = bv.byteOffset || 0;
  if(off + bv.byteLength > buf.byteLength) throw new Error(`glTF: bufferView ${bvIdx} exceeds its buffer`);
  return {buf, off, len: bv.byteLength, stride: bv.byteStride || 0};
}
function _gltfAccessor(gltf, bufs, accIdx, float){
  const acc = gltf.accessors && gltf.accessors[accIdx];
  if(!acc) throw new Error(`glTF: accessor ${accIdx} missing`);
  const nc = _GLTF_NC[acc.type] || 1, ct = acc.componentType, cs = _GLTF_CS[ct];
  if(!cs) throw new Error(`glTF: unsupported componentType ${ct}`);
  const cnt = acc.count, n = cnt * nc;
  const out = float ? new Float32Array(n) : new Uint32Array(n);
  const norm = float && acc.normalized
    ? ({5120: v => Math.max(v/127, -1), 5121: v => v/255, 5122: v => Math.max(v/32767, -1), 5123: v => v/65535}[ct] || (v => v))
    : null;
  const readInto = (view, base, stride, count, dstIdx) => {
    const dv = new DataView(view.buf);
    const rd = {5120: o => dv.getInt8(o), 5121: o => dv.getUint8(o), 5122: o => dv.getInt16(o, true),
                5123: o => dv.getUint16(o, true), 5125: o => dv.getUint32(o, true), 5126: o => dv.getFloat32(o, true)}[ct];
    for(let i = 0; i < count; i++){
      const d = dstIdx ? dstIdx[i] : i;
      for(let c = 0; c < nc; c++){
        const v = rd(base + i*stride + c*cs);
        out[d*nc + c] = norm ? norm(v) : v;
      }
    }
  };
  if(acc.bufferView !== undefined){
    const view = _gltfView(gltf, bufs, acc.bufferView);
    const base = view.off + (acc.byteOffset || 0);
    const stride = view.stride || nc*cs;
    if(base + (cnt ? (cnt - 1)*stride + nc*cs : 0) > view.off + view.len) throw new Error(`glTF: accessor ${accIdx} exceeds its bufferView`);
    // Chemin rapide : flottants contigus, alignés
    if(ct === 5126 && float && stride === nc*4 && (base & 3) === 0) out.set(new Float32Array(view.buf, base, n));
    else readInto(view, base, stride, cnt, null);
  }
  if(acc.sparse && acc.sparse.count > 0){
    const sp = acc.sparse;
    const iv = _gltfView(gltf, bufs, sp.indices.bufferView);
    const vv = _gltfView(gltf, bufs, sp.values.bufferView);
    const icsz = _GLTF_CS[sp.indices.componentType];
    const idv = new DataView(iv.buf);
    const irdr = {5121: o => idv.getUint8(o), 5123: o => idv.getUint16(o, true), 5125: o => idv.getUint32(o, true)}[sp.indices.componentType];
    if(!irdr) throw new Error('glTF: invalid sparse index type');
    const ids = new Uint32Array(sp.count);
    for(let i = 0; i < sp.count; i++){
      const k = irdr(iv.off + (sp.indices.byteOffset || 0) + i*icsz);
      if(k >= cnt) throw new Error(`glTF: sparse index ${k} out of range in accessor ${accIdx}`);
      ids[i] = k;
    }
    readInto(vv, vv.off + (sp.values.byteOffset || 0), nc*cs, sp.count, ids);
  }
  return {arr: out, nc};
}

// Parse UNE primitive glTF standard (non-Draco) → THREE.BufferGeometry indexée,
// mode ramené à TRIANGLES. Points et lignes (modes 0-3) : null — NASSCAD
// n'importe que des surfaces ; ils étaient jusqu'ici lus comme des triangles
// (triangles fantômes, cf. MeshPrimitiveModes du jeu d'essai Khronos).
function _gltfTriangulate(idx, mode){
  if(mode === 4) return idx;
  const n = idx.length, out = [];
  if(mode === 5){        // TRIANGLE_STRIP : p_i = {v_i, v_{i+1+i%2}, v_{i+2-i%2}}
    for(let i = 0; i + 2 < n; i++){
      const a = idx[i], b = idx[i + 1 + (i & 1)], c = idx[i + 2 - (i & 1)];
      if(a !== b && b !== c && a !== c) out.push(a, b, c);
    }
  } else if(mode === 6){ // TRIANGLE_FAN : p_i = {v_{i+1}, v_{i+2}, v_0}
    for(let i = 0; i + 2 < n; i++) out.push(idx[i+1], idx[i+2], idx[0]);
  }
  return Uint32Array.from(out);
}
function _parseGLTFPrimitive(gltf, prim, bufs){
  if(!bufs) return null;
  const mode = prim.mode === undefined ? 4 : prim.mode;
  if(mode < 4) return null;
  if(!prim.attributes || prim.attributes.POSITION === undefined) return null;
  const geo = new THREE.BufferGeometry();
  const pos = _gltfAccessor(gltf, bufs, prim.attributes.POSITION, true);
  if(pos.nc !== 3) throw new Error('glTF: POSITION must be VEC3');
  geo.setAttribute('position', new THREE.BufferAttribute(pos.arr, 3));
  if(prim.attributes.NORMAL !== undefined){
    const nor = _gltfAccessor(gltf, bufs, prim.attributes.NORMAL, true);
    if(nor.nc === 3 && nor.arr.length === pos.arr.length) geo.setAttribute('normal', new THREE.BufferAttribute(nor.arr, 3));
  }
  if(prim.attributes.COLOR_0 !== undefined){
    const col = _gltfAccessor(gltf, bufs, prim.attributes.COLOR_0, true);
    if(col.arr.length / col.nc === pos.arr.length / 3) geo.userData.gltfColor0 = col;
  }
  const nV = pos.arr.length / 3;
  let idx;
  if(prim.indices !== undefined) idx = _gltfAccessor(gltf, bufs, prim.indices, false).arr;
  else { idx = new Uint32Array(nV); for(let i = 0; i < nV; i++) idx[i] = i; }
  idx = _gltfTriangulate(idx, mode);
  for(let i = 0; i < idx.length; i++) if(idx[i] >= nV) throw new Error('glTF: vertex index out of range');
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

// Décode UNE primitive Draco-compressée → THREE.BufferGeometry — MÊME contrat
// de sortie que _parseGLTFPrimitive : le reste d'importGLB (transforms de
// hiérarchie, recentrage 2-passes, pivot de groupe) ne change pas d'une ligne,
// peu importe lequel des deux décodeurs a produit la géométrie.
async function _decodeDracoPrimitive(gltf, prim, bufs){
  const draco = await _getDraco();
  const ext = prim.extensions.KHR_draco_mesh_compression;
  const view = _gltfView(gltf, bufs, ext.bufferView);
  const compressedBytes = new Int8Array(view.buf, view.off, view.len);

  const decoder = new draco.Decoder();
  const decoderBuffer = new draco.DecoderBuffer();
  decoderBuffer.Init(compressedBytes, compressedBytes.length);

  try{
    const geometryType = decoder.GetEncodedGeometryType(decoderBuffer);
    if(geometryType !== draco.TRIANGULAR_MESH)
      throw new Error('Draco: non-triangular geometry not supported (point cloud?)');
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

// ── Import GLB / glTF 2.0 ───────────────────────────────────────────────────
// [AUDIT 17/09] Corrigé contre le corpus (191 GLB NASA + échantillons Khronos) :
//   · UNITÉS : glTF est en mètres → ×1000 vers les mm de NASSCAD (même règle
//     qu'OCCT/FreeCAD). Exceptions : les GLB écrits par NASSCAD avant ce
//     correctif, en mm (generator « NASSCAD », sans extras.lengthUnit), et
//     les modèles qui dépasseraient 200 m (cf. _GLTF_MAX_MM) ;
//   · COULEURS : baseColorFactor (linéaire → sRGB) repris — 169 des 191 GLB
//     NASA arrivaient en couleurs de palette ; COLOR_0 moyen à défaut ;
//   · un objet par NŒUD (et non plus par primitive), primitives fusionnées en
//     faces colorées ;
//   · nœuds MIROIRS (déterminant < 0, ex. Dawn, Robonaut 2) : triangles
//     retournés, sinon la pièce entrait retournée comme un gant ;
//   · seule la scène active est importée (les nœuds des autres scènes
//     l'étaient aussi, avec une matrice identité) ;
//   · modes de primitive : bandes et éventails triangulés, points et lignes
//     écartés (ils devenaient des triangles fantômes) ;
//   · extensionsRequired vérifié : EXT_meshopt_compression donnait des
//     coordonnées de 5·10³⁸ ou un « Offset is outside the bounds » — message
//     clair désormais. Les extensions de pur rendu (matériaux, textures,
//     lumières) sont ignorées sans risque pour la géométrie ;
//   · sans NORMAL, la spec impose des normales de FACE (lissage auparavant) ;
//   · .gltf JSON accepté (tampons embarqués en data: URI) ;
//   · version GLB contrôlée, chunks parcourus proprement.
const _GLTF_MAX_MM = 200000;   // 200 m : au-delà, la vue ne permet plus de travailler
function _gltfDataUri(uri){
  const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(uri);
  if(!m) return null;
  if(!m[1]) return new TextEncoder().encode(decodeURIComponent(m[2])).buffer;
  const bin = atob(m[2]);
  const u8 = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}
async function importGLB(file, opts){
  const _noUndo = !!(opts && opts.noUndo);
  const _fmt = /\.gltf$/i.test(file.name) ? 'glTF' : 'GLB';
  showSpinner('Import ' + _fmt, file.name);
  try{
    const buf = await file.arrayBuffer();
    const dv = new DataView(buf);
    let gltf, binChunk = null;
    if(buf.byteLength >= 12 && dv.getUint32(0, true) === 0x46546C67){
      const ver = dv.getUint32(4, true);
      if(ver !== 2) throw new Error(`GLB version ${ver} is not supported (glTF 2.0 only)`);
      const total = Math.min(dv.getUint32(8, true), buf.byteLength);
      let p = 12;
      while(p + 8 <= total){
        const len = dv.getUint32(p, true), type = dv.getUint32(p + 4, true);
        if(p + 8 + len > total) throw new Error('truncated GLB chunk');
        if(type === 0x4E4F534A && !gltf) gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, p + 8, len)));
        else if(type === 0x004E4942 && !binChunk) binChunk = buf.slice(p + 8, p + 8 + len);
        p += 8 + len;          // chunkLength inclut déjà le bourrage (spec §4.4.3)
      }
      if(!gltf) throw new Error('GLB without JSON chunk');
    } else {
      const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(64, buf.byteLength))).trimStart();
      if(head[0] !== '{') throw new Error('not a glTF/GLB file (wrong magic)');
      gltf = JSON.parse(new TextDecoder().decode(buf));
    }
    if(!gltf.asset || String(gltf.asset.version || '').split('.')[0] !== '2')
      throw new Error(`glTF version ${gltf.asset && gltf.asset.version} is not supported (2.0 only)`);

    // Extensions exigées : refuser ce qu'on ne sait pas lire, dire lequel
    const SUPPORTED = new Set(['KHR_draco_mesh_compression', 'KHR_mesh_quantization']);
    const cosmetic = e => /^(KHR_materials_|KHR_texture_|EXT_texture_|KHR_lights_|KHR_xmp|EXT_lights_)/.test(e);
    const missing = (gltf.extensionsRequired || []).filter(e => !SUPPORTED.has(e) && !cosmetic(e));
    if(missing.includes('EXT_meshopt_compression'))
      throw new Error('this glTF is compressed with EXT_meshopt_compression, which NASSCAD cannot decode — re-export it without meshopt (e.g. gltfpack without -c, or Blender)');
    if(missing.length) throw new Error('required glTF extension(s) not supported: ' + missing.join(', '));

    // Tampons : BIN du GLB (buffers[0] sans uri), data: URI ; fichiers externes indisponibles
    const bufs = (gltf.buffers || []).map((b, i) => {
      if(b.uri === undefined) return (i === 0) ? binChunk : null;
      const d = _gltfDataUri(b.uri);
      if(!d) throw new Error(`external buffer "${b.uri}" cannot be read from a single file — export as .glb (binary) or embed the buffers`);
      return d;
    });

    // Unités
    const gen = String((gltf.asset && gltf.asset.generator) || '');
    const legacyMM = /^NASSCAD\b/.test(gen) && !(gltf.asset.extras && gltf.asset.extras.lengthUnit);
    const UNIT = legacyMM ? 1 : 1000;

    // Couleurs des matériaux (sRGB 'rrggbb' ou null si texture seule / absente)
    const matHex = (gltf.materials || []).map(m => {
      const pbr = m.pbrMetallicRoughness || {};
      const sg = m.extensions && m.extensions.KHR_materials_pbrSpecularGlossiness;
      let f = pbr.baseColorFactor || (sg && sg.diffuseFactor);
      const tex = pbr.baseColorTexture || (sg && sg.diffuseTexture);
      if(!f && tex) return null;
      if(!f) f = [1, 1, 1, 1];
      return f.slice(0, 3).map(c => Math.round(_ioLin2Srgb(c) * 255).toString(16).padStart(2, '0')).join('');
    });

    // Hiérarchie de la SCÈNE ACTIVE (sans scène : tous les nœuds racines)
    const nodes = gltf.nodes || [];
    let roots;
    if(gltf.scenes && gltf.scenes.length){
      const si = gltf.scene !== undefined ? gltf.scene : 0;
      roots = (gltf.scenes[si] && gltf.scenes[si].nodes) || [];
    } else {
      const child = new Set(); nodes.forEach(n => (n.children || []).forEach(c => child.add(c)));
      roots = nodes.map((_, i) => i).filter(i => !child.has(i));
    }
    const localMatrixOf = node => {
      const m = new THREE.Matrix4();
      if(node.matrix){ m.fromArray(node.matrix); return m; }
      const t = node.translation ? new THREE.Vector3(...node.translation) : new THREE.Vector3();
      const r = node.rotation ? new THREE.Quaternion(...node.rotation) : new THREE.Quaternion();
      const s = node.scale ? new THREE.Vector3(...node.scale) : new THREE.Vector3(1, 1, 1);
      return m.compose(t, r, s);
    };
    const visits = [];            // [nodeIdx, world]
    const seen = new Set();
    const walk = (ni, parent) => {
      if(seen.has(ni) || !nodes[ni]) return;   // la spec interdit les cycles ; on s'en protège
      seen.add(ni);
      const w = parent.clone().multiply(localMatrixOf(nodes[ni]));
      visits.push([ni, w]);
      (nodes[ni].children || []).forEach(c => walk(c, w));
    };
    const top = new THREE.Matrix4().makeScale(UNIT, UNIT, UNIT);
    roots.forEach(r => walk(r, top));

    // Dispatch PAR PRIMITIVE : Draco si présent sur cette primitive, sinon lecteur direct
    const geos = [];
    let skippedPrims = 0, flipped = 0, nPrim = 0;
    for(const [ni, world] of visits){
      const node = nodes[ni];
      if(node.mesh === undefined || node.mesh === null) continue;
      const mesh = gltf.meshes && gltf.meshes[node.mesh];
      if(!mesh) continue;
      const mirror = world.determinant() < 0;
      const prims = [];
      for(const prim of (mesh.primitives || [])){
        nPrim++;
        if(nPrim % 64 === 0){ showSpinner('Import ' + _fmt, `${file.name} — ${nPrim} primitive(s)…`); await new Promise(r => setTimeout(r, 0)); }
        const isDraco = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
        let geo = isDraco ? await _decodeDracoPrimitive(gltf, prim, bufs) : _parseGLTFPrimitive(gltf, prim, bufs);
        if(!geo){ skippedPrims++; continue; }
        const c0 = geo.userData.gltfColor0;      // lu avant toNonIndexed, qui ne copie pas userData
        delete geo.userData.gltfColor0;
        // Normales absentes : normales de FACE (spec §3.7.2.1)
        if(!geo.attributes.normal){
          const gi = geo.toNonIndexed(); geo.dispose(); geo = gi;
          geo.computeVertexNormals();
        }
        geo.applyMatrix4(world);
        if(mirror){ _ioFlipWinding(geo); flipped++; }
        // Couleur : matériau, sinon COLOR_0 moyen, sinon palette
        let hex = prim.material !== undefined ? matHex[prim.material] : null;
        if(c0 && (hex === null || hex === 'ffffff')){
          let r = 0, g = 0, b = 0; const n = c0.arr.length / c0.nc;
          for(let i = 0; i < n; i++){ r += c0.arr[i*c0.nc]; g += c0.arr[i*c0.nc+1]; b += c0.arr[i*c0.nc+2]; }
          if(n) hex = [r, g, b].map(v => Math.round(_ioLin2Srgb(v/n)*255).toString(16).padStart(2, '0')).join('');
        }
        prims.push({geo, hex});
      }
      if(!prims.length) continue;
      // [AUDIT 17/09] Un nœud glTF = UN objet (comme Blender : un objet, un
      // emplacement de matériau par primitive). Ses primitives sont fusionnées
      // et leurs matériaux deviennent des couleurs de faces — le modèle des
      // corps STEP multi-couleurs. Avant : un objet NASSCAD par primitive, et
      // un corps bicolore exporté en GLB revenait coupé en deux.
      const name = node.name || mesh.name || ('mesh_' + node.mesh);
      if(prims.length === 1){ geos.push({geo: prims[0].geo, hex: prims[0].hex, rgb: null, name}); continue; }
      let nv = 0, nt = 0;
      for(const pr of prims){ nv += pr.geo.attributes.position.count; nt += pr.geo.index ? pr.geo.index.count/3 : pr.geo.attributes.position.count/3; }
      const P = new Float32Array(nv*3), N = new Float32Array(nv*3), I = new Uint32Array(nt*3), C = new Int32Array(nt);
      let vo = 0, to = 0;
      for(const pr of prims){
        const g = pr.geo, cnt = g.attributes.position.count;
        P.set(g.attributes.position.array, 3*vo);
        if(g.attributes.normal) N.set(g.attributes.normal.array, 3*vo);
        const ix = g.index ? g.index.array : null, n = ix ? ix.length/3 : cnt/3;
        for(let k = 0; k < 3*n; k++) I[3*to + k] = (ix ? ix[k] : k) + vo;
        C.fill(pr.hex ? parseInt(pr.hex, 16) : -1, to, to + n);
        vo += cnt; to += n;
        g.dispose();
      }
      const mg = new THREE.BufferGeometry();
      mg.setAttribute('position', new THREE.BufferAttribute(P, 3));
      mg.setAttribute('normal', new THREE.BufferAttribute(N, 3));
      mg.setIndex(new THREE.BufferAttribute(I, 1));
      const p0 = prims.find(pr => pr.hex);
      geos.push({geo: mg, hex: null, rgb: C, name, prefer: p0 ? parseInt(p0.hex, 16) : undefined});
    }
    if(!geos.length) throw new Error(skippedPrims ? 'this file only contains points or lines — NASSCAD imports surfaces' : 'No geometry found');
    if(skippedPrims) nasLog('WARN', `Import ${_fmt}: ${skippedPrims} point/line primitive(s) skipped`);
    if(flipped) nasLog('DBG', `Import ${_fmt}: ${flipped} mirrored primitive(s), winding restored`);

    // Recentrage 2-passes (V4.5.6/7) — l'assemblage garde ses positions relatives.
    if(!_noUndo) undoPush('import GLB');
    let gMinX=Infinity,gMinY=Infinity,gMinZ=Infinity,gMaxX=-Infinity,gMaxY=-Infinity,gMaxZ=-Infinity;
    geos.forEach(({geo})=>{
      geo.computeBoundingBox();
      const bb=geo.boundingBox;
      gMinX=Math.min(gMinX,bb.min.x); gMinY=Math.min(gMinY,bb.min.y); gMinZ=Math.min(gMinZ,bb.min.z);
      gMaxX=Math.max(gMaxX,bb.max.x); gMaxY=Math.max(gMaxY,bb.max.y); gMaxZ=Math.max(gMaxZ,bb.max.z);
    });
    // Garde-fou d'échelle. La spec dit mètres, mais nombre d'exporteurs
    // l'ignorent : sur les 191 GLB NASA, 36 dépasseraient 200 m une fois
    // convertis (jusqu'à 11 km), hors de la plage navigable de la vue (dolly
    // 600 m, plan lointain 2 km). Au-delà de _GLTF_MAX_MM, on garde les unités
    // du fichier telles quelles (1 unité = 1 mm, l'ancien comportement), et on
    // le dit.
    let unitNote = UNIT === 1000 ? 'metres → mm' : 'legacy NASSCAD file in mm';
    const extent = Math.max(gMaxX-gMinX, gMaxY-gMinY, gMaxZ-gMinZ);
    if(UNIT === 1000 && extent > _GLTF_MAX_MM){
      const k = 1/UNIT;
      geos.forEach(({geo}) => geo.scale(k, k, k));
      gMinX*=k; gMinY*=k; gMinZ*=k; gMaxX*=k; gMaxY*=k; gMaxZ*=k;
      nasLog('WARN', `Import ${_fmt}: read as metres, this model would be ${Math.round(extent/1000).toLocaleString('en-US')} m wide — beyond the working range, so its units were kept as millimetres (1 unit = 1 mm). Many glTF exporters ignore the metre convention; rescale it if needed.`);
      unitNote = 'units kept as mm (oversized in metres)';
    }
    const ox=-(gMinX+gMaxX)/2, oy=-gMinY, oz=-(gMinZ+gMaxZ)/2;
    // Place libre AVANT d'ajouter nos objets (sinon ils se gênent eux-mêmes)
    const fp=_findFreePos(null, Math.max(gMaxX-gMinX, gMaxZ-gMinZ)+2);
    const groupObjs = [];
    geos.forEach(({geo,name,hex,rgb,prefer})=>{
      geo.translate(ox,oy,oz);
      objCnt++;
      const fc = rgb ? _ioApplyFaceRGB(geo, rgb, name, 256, prefer) : {mats:null, hex:null};
      const col = fc.hex || (hex ? '#' + hex : COL[objCnt%COL.length]);
      const mat=fc.mats || new THREE.MeshPhongMaterial({color:col,shininess:8,specular:0x1a1a1a,side:THREE.DoubleSide});
      const mesh=new THREE.Mesh(geo,mat); mesh.castShadow=true; scene.add(mesh);
      mesh.position.set(fp.x, 0, fp.z);
      mesh.updateMatrixWorld(true);
      const oname=name.replace(/[^a-zA-Z0-9_]/g,'_')+'_'+objCnt;
      const obj={id:objCnt,name:oname,type:'csg',mesh,color:col,isHole:false};
      objs.push(obj); groupObjs.push(obj);
    });
    selObjs=groupObjs.slice(-1);
    nasLog('OK',`Import ${_fmt}: ${groupObjs.length} part(s), assembly preserved, ${unitNote} (${file.name})`);
    updProps();updOList();updStats();hideSpinner();
  }catch(err){
    hideSpinner();
    nasLog('ERROR',`Import ${_fmt}: `+err.message);
    _nasAlert(`⚠ Import ${_fmt} failed:\n`+err.message);
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
      nasLog('WARN','showSaveFilePicker: '+e.message+' — browser fallback');
    }
  }
  showSpinner('Export OBJ','Preparing…');
  // [AUDIT 17/09] Le corps tournait dans un callback rAF non attendu : une
  // exception y restait non rattrapée et le spinner restait affiché.
  await new Promise(r => requestAnimationFrame(r));
  try{
  // Same axis conversion as STL: Three.js Y-up → Z-up (Blender/Cura)
  const cv=(x,y,z)=>({x:x,y:-z,z:y});
  const faceNormal=(pa,pb,pc)=>{
    const ax=pb.x-pa.x,ay=pb.y-pa.y,az=pb.z-pa.z;
    const bx=pc.x-pa.x,by=pc.y-pa.y,bz=pc.z-pa.z;
    const nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx;
    const l=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
    return {x:nx/l,y:ny/l,z:nz/l};
  };
  // [PERF V4.7.1] Arrays + join('') at the end instead of += (O(n) instead of O(n²)).
  const vLines=[],vnLines=[],fLines=[]; let vo=0,no=0; // vo=vertex offset, no=normal offset
  scene.updateMatrixWorld(true);
  for(const so of objs){
    const g=_ioWeldExact(_ioBakeGeo(so));
    const p=g.attributes.position,ix=g.index;
    // [AUDIT 17/09] Couleur de l'objet en couleur de sommet (« v x y z r g b »,
    // extension de fait lue par MeshLab, Blender, PrusaSlicer, three.js,
    // trimesh ; ignorée sans dommage par les autres) — l'OBJ sortait gris.
    const hex=_ioObjColorHex(so);
    const rgb=' '+[0,2,4].map(o=>(parseInt(hex.substr(o,2),16)/255).toFixed(4)).join(' ');
    fLines.push('o '+String(so.name).replace(/[\r\n]+/g,' ')+'\n');
    for(let i=0;i<p.count;i++){
      const v=cv(p.getX(i),p.getY(i),p.getZ(i));
      vLines.push('v '+v.x.toFixed(6)+' '+v.y.toFixed(6)+' '+v.z.toFixed(6)+rgb+'\n');
    }
    // Faces + normals computed per triangle (1 normal per face)
    const triCount=ix ? ix.count/3 : p.count/3;
    for(let i=0;i<triCount;i++){
      const ai=ix?ix.getX(i*3):i*3, bi=ix?ix.getX(i*3+1):i*3+1, ci=ix?ix.getX(i*3+2):i*3+2;
      const pa=cv(p.getX(ai),p.getY(ai),p.getZ(ai));
      const pb=cv(p.getX(bi),p.getY(bi),p.getZ(bi));
      const pc=cv(p.getX(ci),p.getY(ci),p.getZ(ci));
      const n=faceNormal(pa,pb,pc);
      const ni=no+i+1;
      vnLines.push('vn '+n.x.toFixed(6)+' '+n.y.toFixed(6)+' '+n.z.toFixed(6)+'\n');
      const a=ai+1+vo,b=bi+1+vo,c=ci+1+vo;
      fLines.push('f '+a+'//'+ni+' '+b+'//'+ni+' '+c+'//'+ni+'\n');
    }
    vo+=p.count;
    no+=triCount;
    g.dispose();
  }
  const o='# NASSCAD V'+NASSCAD_VERSION+'\n# Units: millimetres. Axis: Z-up (compatible Cura/Blender/FreeCAD)\n# Vertex colours: v x y z r g b\n'
          +vLines.join('')+vnLines.join('')+fLines.join('');
  await _nasSaveWithHandle('model.obj', new Blob([o],{type:'model/obj'}), 'model/obj', _fh);
  nasLog('OK',`Export OBJ — ${objs.length} object(s), ${no.toLocaleString('en-US')} triangles — ${(o.length/1024).toFixed(1)} KB`);
  }catch(err){
    nasLog('ERROR','Export OBJ: '+err.message);
    _nasAlert('⚠ Export OBJ failed:\n'+err.message);
  }finally{
    hideSpinner();
  }
}

// ── io-obj-import.js ──────────────────────────────────────────────────────
// Parser bas niveau (parseOBJ) — ne fait QUE parser (texte → THREE.BufferGeometry).
// L'insertion en scène est gérée par le dispatcher importMesh() resté dans le host.
// [AUDIT 17/09] Réécrit — défauts reproduits :
//   · index NÉGATIFS (relatifs, spec OBJ, fréquents chez les exporteurs en
//     flux) : NaN dans les positions → géométrie invisible ;
//   · continuation « \ » en fin de ligne : NaN ;
//   · index hors bornes : NaN et triangles fantômes → face écartée, signalée ;
//   · o / g : tout fusionnait en un seul corps. Les parties sont rendues dans
//     geo.userData.parts ([{name, start, count}] en triangles) — importMesh
//     en fait des objets distincts, assemblage conservé (comme three.js et
//     Blender) ;
//   · couleurs de sommet « v x y z r g b » : geo.userData.faceRGB ;
//   · fichier sans aucune face (points/lignes) : message explicite.
// Contrat inchangé : Promise<BufferGeometry> non indexée, repère du fichier.
async function parseOBJ(txt, opts){
  const onP = (opts && opts.onProgress) || null;
  let _lastY = performance.now();
  if(txt.indexOf('\\') >= 0) txt = txt.replace(/\\[ \t]*\r?\n/g, ' ');
  const lines = txt.split('\n');
  const V = [];
  let VC = null;                                // couleurs de sommet 0..1, -1 = absente
  let out = new Float32Array(1 << 18), no = 0;  // positions dépliées
  let fc = null;                                // couleur par triangle (0xRRGGBB | -1)
  const parts = [];
  let oName = '', gName = '', partStart = 0, bad = 0;
  const partName = () => oName && gName ? oName + '_' + gName : (oName || gName);
  let curName = '';
  const boundary = () => {
    const tri = no / 9;
    if(tri > partStart){ parts.push({name: curName, start: partStart, count: tri - partStart}); partStart = tri; }
    curName = partName();
  };
  const grow = add => {
    if(no + add <= out.length) return;
    let n = out.length * 2; while(n < no + add) n *= 2;
    const o2 = new Float32Array(n); o2.set(out.subarray(0, no)); out = o2;
    if(fc){ const f2 = new Int32Array(n / 9 | 0).fill(-1); f2.set(fc.subarray(0, Math.min(fc.length, f2.length))); fc = f2; }
  };
  const WS = /\s+/;
  const corner = [];
  for(let li = 0; li < lines.length; li++){
    let s = lines[li];
    let k0 = s.charCodeAt(0);
    if(k0 === 32 || k0 === 9){ s = s.trimStart(); k0 = s.charCodeAt(0); }
    const k1 = s.charCodeAt(1);
    const sep = k1 === 32 || k1 === 9;
    if(k0 === 118 && sep){                                   // v
      const t = s.trim().split(WS);
      V.push(+t[1], +t[2], +t[3]);
      if(t.length >= 7){
        if(!VC){ VC = []; for(let i = 0; i < V.length - 3; i++) VC.push(-1); }
        VC.push(+t[4], +t[5], +t[6]);
      } else if(VC) VC.push(-1, -1, -1);
    } else if(k0 === 102 && sep){                            // f
      const t = s.trim().split(WS);
      const nv = V.length / 3;
      corner.length = 0;
      let ok = true;
      for(let k = 1; k < t.length; k++){
        if(!t[k]) continue;
        let i = parseInt(t[k], 10);                          // "12/5/3" → 12
        i = i > 0 ? i - 1 : (i < 0 ? nv + i : -1);
        if(!(i >= 0 && i < nv) || !isFinite(V[3*i] + V[3*i+1] + V[3*i+2])){ ok = false; break; }
        corner.push(i);
      }
      if(!ok || corner.length < 3){ bad++; continue; }
      const nt = corner.length - 2;
      grow(nt * 9);
      let rgb = -1;
      if(VC){
        const c = corner[0];
        if(VC[3*c] >= 0){
          const u = x => Math.max(0, Math.min(255, Math.round(x * 255)));
          rgb = (u(VC[3*c]) << 16) | (u(VC[3*c+1]) << 8) | u(VC[3*c+2]);
          if(!fc) fc = new Int32Array(out.length / 9 | 0).fill(-1);
        }
      }
      const c0 = corner[0];
      for(let k = 1; k <= nt; k++){                          // éventail (comme three.js, trimesh)
        if(fc) fc[no / 9] = rgb;
        const c1 = corner[k], c2 = corner[k+1];
        out[no++] = V[3*c0]; out[no++] = V[3*c0+1]; out[no++] = V[3*c0+2];
        out[no++] = V[3*c1]; out[no++] = V[3*c1+1]; out[no++] = V[3*c1+2];
        out[no++] = V[3*c2]; out[no++] = V[3*c2+1]; out[no++] = V[3*c2+2];
      }
    } else if(k0 === 111 && (sep || s.length === 1)){        // o
      oName = s.slice(1).trim(); gName = ''; boundary();
    } else if(k0 === 103 && (sep || s.length === 1)){        // g
      gName = s.slice(1).trim(); boundary();
    }
    if((li & 0x3FFF)===0 && performance.now()-_lastY>40){ _lastY=performance.now(); if(onP)onP(0.9*li/lines.length); await _breathe(); }
  }
  const nTri = no / 9;
  if(nTri > partStart) parts.push({name: curName, start: partStart, count: nTri - partStart});
  if(!nTri) throw new Error(bad ? `no valid face in this OBJ (${bad} face(s) with invalid vertex indices)` : 'no faces in this OBJ (points or lines only?)');
  if(bad) nasLog('WARN', `Import OBJ: ${bad} face(s) with invalid vertex indices skipped`);
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(out.slice(0, no),3));
  if(parts.length > 1 && parts.length <= 1000) geo.userData.parts = parts;
  else if(parts.length > 1000) nasLog('WARN', `Import OBJ: ${parts.length} groups — kept as a single object`);
  if(fc) geo.userData.faceRGB = fc.slice(0, nTri);
  if(onP) onP(1);
  if(!(opts && opts.skipNormals)) geo.computeVertexNormals();
  return geo;
}

// ═══════════════════════════════ PLY ════════════════════════════════════
// ── io-ply-export.js ──────────────────────────────────────────────────────
// ── Export PLY (Stanford Polygon File Format) ───────────────────────────────
// Compatible MeshLab, CloudCompare, Blender, Open3D. Axe Z-up (cohérent avec
// STL/OBJ).
// [AUDIT 17/09] Binaire little-endian (format par défaut de MeshLab, Open3D,
// CloudCompare et Blender) au lieu de l'ASCII à 6 décimales : ≈ 4× plus
// léger, lu sans perte. Maillage indexé conservé quand il l'est (les sommets
// n'étaient jamais partagés), couleur de l'objet en couleur de sommet, et
// couleur par face (red/green/blue) dès qu'un corps multi-couleur est exporté.
async function expPLY(){
  let _fh=null;
  if(typeof showSaveFilePicker==='function' && !(window.electronAPI&&window.electronAPI.isElectron)){
    try{
      _fh=await showSaveFilePicker({suggestedName:'model.ply',types:[{description:'PLY File',accept:{'application/octet-stream':['.ply']}}]});
    }catch(e){
      if(e.name==='AbortError') return;
      nasLog('WARN','showSaveFilePicker: '+e.message+' — browser fallback');
    }
  }
  showSpinner('Export PLY','Preparing…');
  await new Promise(r => requestAnimationFrame(r));
  try{
    scene.updateMatrixWorld(true);
    const items = [];
    let nV = 0, nF = 0, anyPal = false;
    for(const so of objs){
      let g = _ioBakeGeo(so);
      const P = g.attributes.position, N = g.attributes.normal;
      if(!P || !P.count){ g.dispose(); continue; }
      if(!(g.index && N && N.count === P.count)){
        const gi = g.index ? g.toNonIndexed() : g;
        if(gi !== g) g.dispose();
        gi.computeVertexNormals();
        g = gi;
      }
      const hex = _ioObjColorHex(so), pal = _ioFacePalette(so);
      const vc = g.attributes.position.count, fcnt = g.index ? g.index.count/3 : vc/3;
      items.push({g, rgb: [0, 2, 4].map(o => parseInt(hex.substr(o, 2), 16)), pal, base: nV});
      if(pal) anyPal = true;
      nV += vc; nF += fcnt;
    }
    const hdr = `ply\nformat binary_little_endian 1.0\ncomment Generated by NASSCAD V${NASSCAD_VERSION}\ncomment Units: millimetres, Z-up\n`
      + `element vertex ${nV}\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty float ny\nproperty float nz\n`
      + `property uchar red\nproperty uchar green\nproperty uchar blue\n`
      + `element face ${nF}\nproperty list uchar int vertex_indices\n`
      + (anyPal ? `property uchar red\nproperty uchar green\nproperty uchar blue\n` : '')
      + `end_header\n`;
    const VS = 27, FS = anyPal ? 16 : 13;
    const body = new ArrayBuffer(nV*VS + nF*FS);
    const dv = new DataView(body), u8 = new Uint8Array(body);
    let off = 0;
    for(const it of items){                      // sommets : (x, y, z) three → (x, -z, y)
      const p = it.g.attributes.position.array, n = it.g.attributes.normal.array;
      for(let i = 0; i < p.length; i += 3){
        dv.setFloat32(off, p[i], true); dv.setFloat32(off+4, -p[i+2], true); dv.setFloat32(off+8, p[i+1], true);
        dv.setFloat32(off+12, n[i], true); dv.setFloat32(off+16, -n[i+2], true); dv.setFloat32(off+20, n[i+1], true);
        u8[off+24] = it.rgb[0]; u8[off+25] = it.rgb[1]; u8[off+26] = it.rgb[2];
        off += VS;
      }
    }
    for(const it of items){                      // faces
      const g = it.g, ix = g.index ? g.index.array : null;
      const nt = ix ? ix.length/3 : g.attributes.position.count/3;
      const tm = it.pal ? _ioTriMaterial(g) : null;
      for(let t = 0; t < nt; t++){
        u8[off] = 3;
        dv.setInt32(off+1, it.base + (ix ? ix[3*t] : 3*t), true);
        dv.setInt32(off+5, it.base + (ix ? ix[3*t+1] : 3*t+1), true);
        dv.setInt32(off+9, it.base + (ix ? ix[3*t+2] : 3*t+2), true);
        if(anyPal){
          let c = it.rgb;
          if(tm && tm[t] >= 0 && it.pal[tm[t]]){ const h = it.pal[tm[t]]; c = [parseInt(h.substr(0,2),16), parseInt(h.substr(2,2),16), parseInt(h.substr(4,2),16)]; }
          u8[off+13] = c[0]; u8[off+14] = c[1]; u8[off+15] = c[2];
        }
        off += FS;
      }
      g.dispose();
    }
    const blob = new Blob([hdr, body], {type:'application/octet-stream'});
    await _nasSaveWithHandle('model.ply', blob, 'application/octet-stream', _fh);
    nasLog('OK',`Export PLY — ${items.length} object(s) — ${nV.toLocaleString('en-US')} vertices, ${nF.toLocaleString('en-US')} faces — ${(blob.size/1024).toFixed(1)} KB`);
  }catch(err){
    nasLog('ERROR','Export PLY: '+err.message);
    _nasAlert('⚠ Export PLY failed:\n'+err.message);
  }finally{
    hideSpinner();
  }
}

// ── io-ply-import.js ──────────────────────────────────────────────────────
// ── Import PLY (Stanford Polygon File Format) ────────────────────────────────
// Supporte : ASCII · binary_little_endian · binary_big_endian
// Retourne une BufferGeometry Z-up (même convention que STL/OBJ — conversion appliquée par importMesh)
// [NEW V4.4.0] async coopératif — cf. commentaire au-dessus de parseSTL.
// [AUDIT 17/09] Réécrit sur le modèle générique de la spec (Paul Bourke) —
// tous ces cas donnaient une géométrie fausse SANS message :
//   · types nommés par taille (float32, int32, uint8… — Open3D, VTK, PCL) :
//     taille supposée 4 et lecture en float → tous les sommets à 0 ;
//   · compteur de liste autre que uchar, index autres que int (ushort, uint) ;
//   · propriétés de face après la liste (couleurs), éléments intercalés entre
//     vertex et face, ou placés avant vertex : désynchronisation du binaire ;
//   · en-tête > 8 Ko refusé ; les CR/LF consommés APRÈS end_header mangeaient
//     le premier octet binaire quand il valait 10 ou 13 ;
//   · nuage de points (aucune face) : triangles fantômes → message clair ;
//   · signes : uint lu en int, char en uchar, ushort en short.
// Ajouts : tristrips (-1 = redémarrage), couleurs de sommet ou de face
// (geo.userData.faceRGB). Sortie : géométrie INDEXÉE.
async function parsePLY(buf, opts){
  const onP = (opts && opts.onProgress) || null;
  let _lastY = performance.now();
  const u8 = new Uint8Array(buf);
  // ── En-tête
  const lim = Math.min(u8.length, 16 * 1048576);
  let hdrEnd = -1, head = '';
  for(let sz = 65536; ; sz *= 8){
    head = new TextDecoder('latin1').decode(u8.subarray(0, Math.min(sz, lim)));
    const m = /end_header[ \t]*\r?\n/.exec(head);
    if(m){ hdrEnd = m.index + m[0].length; break; }
    if(sz >= lim) break;
  }
  if(!/^ply[ \t]*\r?\n/.test(head)) throw new Error('not a PLY file (missing "ply" signature)');
  if(hdrEnd < 0) throw new Error('invalid PLY: no end_header');
  const TY = {char:['Int8',1], int8:['Int8',1], uchar:['Uint8',1], uint8:['Uint8',1],
              short:['Int16',2], int16:['Int16',2], ushort:['Uint16',2], uint16:['Uint16',2],
              int:['Int32',4], int32:['Int32',4], uint:['Uint32',4], uint32:['Uint32',4],
              float:['Float32',4], float32:['Float32',4], double:['Float64',8], float64:['Float64',8]};
  let fmt = null; const els = []; let cur = null;
  for(const raw of head.slice(0, hdrEnd).split(/\r?\n/)){
    const t = raw.trim().split(/\s+/);
    if(t[0] === 'format') fmt = t[1];
    else if(t[0] === 'element'){ cur = {name: t[1], count: parseInt(t[2], 10), props: []}; els.push(cur); }
    else if(t[0] === 'property' && cur){
      const p = t[1] === 'list' ? {list: true, ct: t[2], it: t[3], name: t[4]} : {list: false, type: t[1], name: t[2]};
      for(const k of p.list ? [p.ct, p.it] : [p.type]) if(!TY[k]) throw new Error(`PLY: unknown property type "${k}"`);
      cur.props.push(p);
    }
  }
  if(!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(fmt)) throw new Error(`PLY: unsupported format "${fmt}"`);
  for(const e of els) if(!(e.count >= 0)) throw new Error(`PLY: invalid count for element "${e.name}"`);
  const vEl = els.find(e => e.name === 'vertex');
  if(!vEl) throw new Error('PLY without vertex element');
  const nV = vEl.count;
  const pIdx = n => vEl.props.findIndex(p => !p.list && p.name === n);
  const xi = pIdx('x'), yi = pIdx('y'), zi = pIdx('z');
  if(xi < 0 || yi < 0 || zi < 0) throw new Error('PLY: missing x/y/z');
  const colNames = [['red','green','blue'], ['r','g','b'], ['diffuse_red','diffuse_green','diffuse_blue']];
  const colIdx = props => { for(const c of colNames){ const k = c.map(n => props.findIndex(p => !p.list && p.name === n)); if(k.every(i => i >= 0)) return k; } return null; };
  const vci = colIdx(vEl.props);
  const fEl = els.find(e => e.name === 'face'), sEl = els.find(e => e.name === 'tristrips');
  const nF = (fEl ? fEl.count : 0) + (sEl ? sEl.count : 0);
  if(!nF) throw new Error('PLY point cloud (no faces): NASSCAD imports surfaces only — mesh it first (e.g. surface reconstruction in MeshLab or CloudCompare)');

  const pos = new Float32Array(nV * 3);
  const vrgb = vci ? new Int32Array(nV) : null;
  let tri = new Uint32Array(Math.max(16, nF * 3)), nt = 0;
  let frgb = null, badF = 0;
  const pushTri = (a, b, c, col) => {
    if(nt * 3 + 3 > tri.length){ const t2 = new Uint32Array(tri.length * 2); t2.set(tri); tri = t2; if(frgb){ const f2 = new Int32Array(tri.length / 3 | 0).fill(-1); f2.set(frgb); frgb = f2; } }
    if(col >= 0 && !frgb) frgb = new Int32Array(tri.length / 3 | 0).fill(-1);
    if(frgb) frgb[nt] = col;
    tri[3*nt] = a; tri[3*nt+1] = b; tri[3*nt+2] = c; nt++;
  };
  const toByte = (v, type) => /float|double/.test(type) ? Math.max(0, Math.min(255, Math.round(v * 255))) : Math.max(0, Math.min(255, v));
  const listName = e => e.props.findIndex(p => p.list && (p.name === 'vertex_indices' || p.name === 'vertex_index'));
  // Traitement d'un élément lu : vals = valeurs scalaires/listes dans l'ordre des props
  const onFace = (e, vals) => {
    const L = vals[e._li];
    if(!L || (e.name === 'face' && L.length < 3)){ badF++; return; }
    let col = -1;
    if(e._ci) col = (toByte(vals[e._ci[0]], e.props[e._ci[0]].type) << 16) | (toByte(vals[e._ci[1]], e.props[e._ci[1]].type) << 8) | toByte(vals[e._ci[2]], e.props[e._ci[2]].type);
    for(const i of L) if(!(i >= 0 && i < nV) && !(e.name === 'tristrips' && i === -1)){ badF++; return; }
    const cv = i => col >= 0 ? col : (vrgb ? vrgb[i] : -1);
    if(e.name === 'face'){
      for(let k = 1; k + 1 < L.length; k++) pushTri(L[0], L[k], L[k+1], cv(L[0]));
    } else {                                     // tristrips, -1 = redémarrage
      let s = 0;
      for(let k = 0; k <= L.length; k++){
        if(k === L.length || L[k] < 0){
          for(let j = s; j + 2 < k; j++){
            const a = L[j], b = (j - s) & 1 ? L[j+2] : L[j+1], c = (j - s) & 1 ? L[j+1] : L[j+2];
            if(a !== b && b !== c && a !== c) pushTri(a, b, c, cv(a));
          }
          s = k + 1;
        }
      }
    }
  };
  for(const e of [fEl, sEl]) if(e){ e._li = listName(e); if(e._li < 0) throw new Error(`PLY: element "${e.name}" has no vertex_indices list`); e._ci = colIdx(e.props); }

  const tick = async (done, total, base, span) => {
    if(performance.now() - _lastY > 40){ _lastY = performance.now(); if(onP) onP(base + span * done / total); await _breathe(); }
  };
  let elBase = 0;
  const elSpan = e => (e.count || 0) / (els.reduce((s, x) => s + (x.count || 0), 0) || 1);

  if(fmt === 'ascii'){
    const lines = new TextDecoder('latin1').decode(u8.subarray(hdrEnd)).split(/\r?\n/);
    let li = 0;
    const nextTokens = () => {
      while(li < lines.length){ const s = lines[li++].trim(); if(s) return s.split(/\s+/); }
      throw new Error('truncated PLY (ASCII body shorter than announced)');
    };
    for(const e of els){
      const span = elSpan(e);
      for(let i = 0; i < e.count; i++){
        const t = nextTokens();
        if(e === vEl){
          pos[3*i] = +t[xi]; pos[3*i+1] = +t[yi]; pos[3*i+2] = +t[zi];
          if(vrgb) vrgb[i] = (toByte(+t[vci[0]], vEl.props[vci[0]].type) << 16) | (toByte(+t[vci[1]], vEl.props[vci[1]].type) << 8) | toByte(+t[vci[2]], vEl.props[vci[2]].type);
        } else if(e === fEl || e === sEl){
          const vals = []; let k = 0;
          for(const p of e.props){
            if(p.list){ const n = +t[k++]; vals.push(t.slice(k, k + n).map(Number)); k += n; }
            else vals.push(+t[k++]);
          }
          onFace(e, vals);
        }
        if((i & 0x3FFF) === 0) await tick(i, e.count, elBase, span);
      }
      elBase += span;
    }
  } else {
    const le = fmt === 'binary_little_endian';
    const dv = new DataView(buf);
    const rd = t => { const f = 'get' + TY[t][0]; return o => dv[f](o, le); };
    let off = hdrEnd;
    for(const e of els){
      const span = elSpan(e);
      const fixed = e.props.every(p => !p.list);
      if(fixed){
        const offs = []; let stride = 0;
        for(const p of e.props){ offs.push(stride); stride += TY[p.type][1]; }
        if(off + stride * e.count > buf.byteLength) throw new Error(`truncated PLY (element "${e.name}")`);
        if(e === vEl){
          const rx = rd(e.props[xi].type), ry = rd(e.props[yi].type), rz = rd(e.props[zi].type);
          const rc = vci ? vci.map(k => rd(e.props[k].type)) : null;
          for(let i = 0; i < e.count; i++){
            const b = off + i * stride;
            pos[3*i] = rx(b + offs[xi]); pos[3*i+1] = ry(b + offs[yi]); pos[3*i+2] = rz(b + offs[zi]);
            if(rc) vrgb[i] = (toByte(rc[0](b + offs[vci[0]]), e.props[vci[0]].type) << 16) | (toByte(rc[1](b + offs[vci[1]]), e.props[vci[1]].type) << 8) | toByte(rc[2](b + offs[vci[2]]), e.props[vci[2]].type);
            if((i & 0xFFFF) === 0) await tick(i, e.count, elBase, span);
          }
        } else if(e === fEl || e === sEl){
          throw new Error(`PLY: element "${e.name}" has no list property`);
        }
        off += stride * e.count;            // éléments inconnus : sautés en bloc
      } else {
        const R = e.props.map(p => p.list ? {c: rd(p.ct), cs: TY[p.ct][1], v: rd(p.it), vs: TY[p.it][1]} : {v: rd(p.type), vs: TY[p.type][1]});
        const use = e === fEl || e === sEl || e === vEl;
        // Chemin rapide : face = la liste d'abord, puis d'éventuels scalaires de
        // taille fixe (couleurs, attribut « stl » de trimesh…) — 99 % des fichiers.
        if(e === fEl && e._li === 0 && e.props.slice(1).every(p => !p.list)){
          const r = R[0];
          let tail = 0; const toff = [0];
          for(let k = 1; k < R.length; k++){ toff[k] = tail; tail += R[k].vs; }
          const ci = e._ci;
          const L = [];
          for(let i = 0; i < e.count; i++){
            if(off + r.cs > buf.byteLength) throw new Error('truncated PLY (element "face")');
            const n = r.c(off); off += r.cs;
            if(!(n >= 0) || off + n * r.vs + tail > buf.byteLength) throw new Error('corrupt PLY list in element "face"');
            const t0 = off + n * r.vs;
            if(n === 3 && !ci){
              const a = r.v(off), b = r.v(off + r.vs), c = r.v(off + 2*r.vs);
              if(a >= 0 && a < nV && b >= 0 && b < nV && c >= 0 && c < nV) pushTri(a, b, c, vrgb ? vrgb[a] : -1);
              else badF++;
            } else {
              L.length = n;
              for(let j = 0; j < n; j++) L[j] = r.v(off + j * r.vs);
              const vals = [L];
              for(let k = 1; k < R.length; k++) vals.push(ci && ci.includes(k) ? R[k].v(t0 + toff[k]) : 0);
              onFace(e, vals);
            }
            off = t0 + tail;
            if((i & 0x3FFF) === 0) await tick(i, e.count, elBase, span);
          }
          elBase += span;
          continue;
        }
        for(let i = 0; i < e.count; i++){
          const vals = use ? [] : null;
          for(let k = 0; k < R.length; k++){
            const r = R[k];
            if(off >= buf.byteLength) throw new Error(`truncated PLY (element "${e.name}")`);
            if(e.props[k].list){
              const n = r.c(off); off += r.cs;
              if(!(n >= 0) || off + n * r.vs > buf.byteLength) throw new Error(`corrupt PLY list in element "${e.name}"`);
              if(use){ const L = new Array(n); for(let j = 0; j < n; j++) L[j] = r.v(off + j * r.vs); vals.push(L); }
              off += n * r.vs;
            } else {
              if(use) vals.push(r.v(off));
              off += r.vs;
            }
          }
          if(e === vEl){
            pos[3*i] = vals[xi]; pos[3*i+1] = vals[yi]; pos[3*i+2] = vals[zi];
            if(vrgb) vrgb[i] = (toByte(vals[vci[0]], e.props[vci[0]].type) << 16) | (toByte(vals[vci[1]], e.props[vci[1]].type) << 8) | toByte(vals[vci[2]], e.props[vci[2]].type);
          } else if(use) onFace(e, vals);
          if((i & 0x3FFF) === 0) await tick(i, e.count, elBase, span);
        }
      }
      elBase += span;
    }
  }
  if(badF) nasLog('WARN', `Import PLY: ${badF} face(s) with invalid vertex indices skipped`);
  if(!nt) throw new Error('PLY without valid faces');
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(tri.slice(0, 3*nt), 1));
  if(frgb) geo.userData.faceRGB = frgb.slice(0, nt);
  if(onP) onP(1);
  if(!(opts && opts.skipNormals)) geo.computeVertexNormals();
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
      nasLog('WARN','showSaveFilePicker: '+e.message+' — browser fallback');
    }
  }
  showSpinner('Export STL','Preparing…');
  // [02/09] rAF en await — voir exp3MF, même raison.
  await new Promise(_r => requestAnimationFrame(_r));
  try{
  const cv=(x,y,z)=>({x,y:-z,z:y}); // Three Y-up → Z-up
  scene.updateMatrixWorld(true);
  // Passe 1 : construire + transformer toutes les géos HD
  const geos=objs.map(so=>_ioBakeGeo(so));

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
  nasLog('OK',`Binary STL export — ${triCount} triangles — ${(buf.byteLength/1024).toFixed(0)} KB — ${Math.round(performance.now()-t0)}ms`);
  await _nasSaveWithHandle('model.stl',new Blob([buf],{type:'model/stl'}),'model/stl', _fh);
  }catch(err){
    nasLog('ERROR','Export STL: '+err.message);
    _nasAlert('⚠ Export STL failed:\n'+err.message);
  }finally{
    hideSpinner();
  }
}

// ── Export STL ASCII — format texte, compatible outils legacy
// [AUDIT 17/09] Même contrôle d'étanchéité que le binaire (le format ne change
// rien à l'impression), rAF attendu + try/finally, et plus de `s +=` sur une
// chaîne de plusieurs centaines de Mo (O(n²)) : tableau + join.
async function expSTLascii(){
  let _fh=null;
  if(typeof showSaveFilePicker==='function' && !(window.electronAPI&&window.electronAPI.isElectron)){
    try{
      _fh=await showSaveFilePicker({suggestedName:'model-ascii.stl',types:[{description:'STL File (ASCII)',accept:{'model/stl':['.stl']}}]});
    }catch(e){
      if(e.name==='AbortError') return;
      nasLog('WARN','showSaveFilePicker: '+e.message+' — browser fallback');
    }
  }
  showSpinner('Export STL (ASCII)','Preparing…');
  await new Promise(_r => requestAnimationFrame(_r));
  try{
  const cv=(x,y,z)=>({x:x,y:-z,z:y});
  const faceNormal=(pa,pb,pc)=>{const ax=pb.x-pa.x,ay=pb.y-pa.y,az=pb.z-pa.z,bx=pc.x-pa.x,by=pc.y-pa.y,bz=pc.z-pa.z;const nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx;const l=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;return (nx/l).toFixed(6)+' '+(ny/l).toFixed(6)+' '+(nz/l).toFixed(6);};
  scene.updateMatrixWorld(true);
  const geos=objs.map(so=>_ioBakeGeo(so));
  {
    const _wt = geos.map((g,i) => ({geo: g, name: (objs[i] && objs[i].name) || ('body '+(i+1))}));
    await _watertightGate(_wt, 'Export STL (ASCII)');
    for(let i=0;i<geos.length;i++) geos[i] = _wt[i].geo;
    showSpinner('Export STL (ASCII)','Writing…');
  }
  const L=['solid m\n'];
  let nT=0;
  for(const g of geos){
    const p=g.attributes.position,ix=g.index;
    const vt=i=>{const v=cv(p.getX(i),p.getY(i),p.getZ(i));return'  vertex '+v.x.toFixed(6)+' '+v.y.toFixed(6)+' '+v.z.toFixed(6)+'\n';};
    const n=ix?ix.count/3:p.count/3;
    for(let t=0;t<n;t++){
      const a=ix?ix.getX(3*t):3*t, b=ix?ix.getX(3*t+1):3*t+1, c=ix?ix.getX(3*t+2):3*t+2;
      const pa=cv(p.getX(a),p.getY(a),p.getZ(a)),pb=cv(p.getX(b),p.getY(b),p.getZ(b)),pc=cv(p.getX(c),p.getY(c),p.getZ(c));
      L.push('facet normal '+faceNormal(pa,pb,pc)+'\n outer loop\n'+vt(a)+vt(b)+vt(c)+' endloop\nendfacet\n');
    }
    nT+=n;
    g.dispose();
  }
  L.push('endsolid m\n');
  const blob=new Blob(L,{type:'model/stl'});
  await _nasSaveWithHandle('model-ascii.stl',blob,'model/stl', _fh);
  nasLog('OK',`ASCII STL export — ${nT} triangles — ${(blob.size/1024).toFixed(0)} KB`);
  }catch(err){
    nasLog('ERROR','Export STL (ASCII): '+err.message);
    _nasAlert('⚠ Export STL (ASCII) failed:\n'+err.message);
  }finally{
    hideSpinner();
  }
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
// [AUDIT 17/09] Détection et lecture revues :
//   · binaire reconnu seulement à la taille EXACTE : un binaire suivi de
//     quelques octets de bourrage (exporteurs réels) partait en ASCII → « Empty
//     geometry ». Règle de three.js/admesh : taille exacte, OU pas de texte STL
//     après la 1re ligne ; les octets en trop sont tolérés et signalés, un
//     binaire TRONQUÉ est refusé avec un message clair ;
//   · fichier de moins de 84 octets : RangeError « Offset is outside the bounds
//     of the DataView » → message explicite ;
//   · ASCII : mots-clés insensibles à la casse, 'nan'/'inf' écartés par
//     triangle (plus de décalage des triplets), boucles à plus de 3 sommets
//     triangulées en éventail ;
//   · plusieurs « solid » dans un ASCII → geo.userData.parts (un objet par
//     solide, comme les parties OBJ) ;
//   · couleurs VisCAM/SolidView/Materialise : « COLOR=r g b a » dans l'en-tête
//     binaire (couleur de l'objet) et 15 bits par facette (bit 15 à 0 = couleur
//     propre, convention Materialise suivie par three.js) → userData.
function _stlLooksAscii(u8){
  let i = 0;
  while(i < u8.length && i < 256 && (u8[i] === 32 || u8[i] === 9 || u8[i] === 10 || u8[i] === 13)) i++;
  const w = String.fromCharCode(...u8.subarray(i, i + 5)).toLowerCase();
  if(w !== 'solid') return false;
  // Au-delà de la 1re ligne, un ASCII contient « facet » ou « endsolid » ; un
  // binaire dont l'en-tête commence par « solid » n'y a que des flottants.
  let nl = i; const lim = Math.min(u8.length, i + 1024);
  while(nl < lim && u8[nl] !== 10) nl++;
  if(nl >= u8.length) return true;                     // une seule ligne : « solid x » vide
  const rest = new TextDecoder('latin1').decode(u8.subarray(nl + 1, Math.min(u8.length, nl + 1 + 512))).trimStart().toLowerCase();
  return rest.startsWith('facet') || rest.startsWith('endsolid') || rest.length === 0;
}
async function parseSTL(buf, opts){
  const onP = (opts && opts.onProgress) || null;
  let _lastY = performance.now();
  const geo=new THREE.BufferGeometry();
  const u8 = new Uint8Array(buf), n = u8.length;
  const dv=new DataView(buf);
  let binary = false, triCount = 0;
  if(n >= 84){
    triCount = dv.getUint32(80, true);
    const expect = 84 + triCount*50;
    if(expect === n) binary = true;
    else if(!_stlLooksAscii(u8)){
      if(expect > n) throw new Error(`truncated binary STL: header announces ${triCount.toLocaleString('en-US')} triangles (${expect.toLocaleString('en-US')} bytes), file has ${n.toLocaleString('en-US')} bytes`);
      binary = true;
      nasLog('WARN', `STL: ${n - expect} byte(s) after the last triangle — ignored`);
    }
  } else if(!_stlLooksAscii(u8)){
    throw new Error(n ? `not an STL file (${n} bytes, no "solid" header)` : 'empty file (0 bytes)');
  }
  if(binary){
    if(!triCount) throw new Error('binary STL with 0 triangles');
    // Couleur d'objet VisCAM/SolidView : "COLOR=" + R G B A dans l'en-tête
    let hdrRGB = -1;
    for(let i = 0; i + 10 <= 80; i++){
      if(u8[i] === 67 && u8[i+1] === 79 && u8[i+2] === 76 && u8[i+3] === 79 && u8[i+4] === 82 && u8[i+5] === 61){
        hdrRGB = (u8[i+6] << 16) | (u8[i+7] << 8) | u8[i+8]; break;
      }
    }
    const verts=new Float32Array(triCount*9);let vi=0;
    let fc = null;
    for(let i=0;i<triCount;i++){
      const base=84+i*50+12;
      for(let v=0;v<3;v++){verts[vi++]=dv.getFloat32(base+v*12,true);verts[vi++]=dv.getFloat32(base+v*12+4,true);verts[vi++]=dv.getFloat32(base+v*12+8,true);}
      if(hdrRGB >= 0){
        const a = dv.getUint16(base + 36, true);
        if((a & 0x8000) === 0){
          if(!fc) fc = new Int32Array(triCount).fill(-1);
          const k = x => Math.round((x & 31) * 255 / 31);
          fc[i] = (k(a) << 16) | (k(a >> 5) << 8) | k(a >> 10);
        }
      }
      if((i & 0x3FFF)===0 && performance.now()-_lastY>40){ _lastY=performance.now(); if(onP)onP(i/triCount); await _breathe(); }
    }
    geo.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));
    if(hdrRGB >= 0) geo.userData.color = '#' + hdrRGB.toString(16).padStart(6, '0');
    if(fc) geo.userData.faceRGB = fc;
  } else {
    const txt=new TextDecoder().decode(buf);
    const verts=[];
    const parts=[];
    const loop=[]; let bad=0, curName='', partStart=0, nsolid=0;
    const re=/\b(endloop|solid|vertex)\b[ \t]*([^\r\n]*)/gi;
    let m, cnt=0;
    while((m=re.exec(txt))!==null){
      const kw=m[1].toLowerCase();
      if(kw==='vertex'){
        const t=m[2].trim().split(/\s+/);
        loop.push(+t[0], +t[1], +t[2]);
      } else if(kw==='endloop'){
        const k=loop.length/3;
        let ok = k >= 3;
        for(let j=0;j<loop.length && ok;j++) if(!isFinite(loop[j])) ok=false;
        if(ok){
          for(let j=1;j+1<k;j++) verts.push(loop[0],loop[1],loop[2], loop[3*j],loop[3*j+1],loop[3*j+2], loop[3*j+3],loop[3*j+4],loop[3*j+5]);
        } else bad++;
        loop.length=0;
      } else {                                   // solid <nom>
        const tri=verts.length/9;
        if(nsolid++ && tri>partStart){ parts.push({name:curName, start:partStart, count:tri-partStart}); partStart=tri; }
        curName=m[2].trim();
      }
      // Progression ASCII : position du curseur regex dans le texte (lastIndex/length)
      if(((++cnt) & 0xFFF)===0 && performance.now()-_lastY>40){ _lastY=performance.now(); if(onP)onP(re.lastIndex/txt.length); await _breathe(); }
    }
    const nTri=verts.length/9;
    if(nTri>partStart) parts.push({name:curName, start:partStart, count:nTri-partStart});
    if(bad) nasLog('WARN', `STL: ${bad} facet(s) with invalid coordinates skipped`);
    if(!nTri) throw new Error('no triangle in this STL file');
    geo.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));
    if(parts.length > 1 && parts.length <= 1000) geo.userData.parts = parts;
  }
  if(!(opts && opts.skipNormals)) geo.computeVertexNormals();
  return geo;
}
