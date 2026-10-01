// ══════════════════════════════════════════════════════════════════════════
// step-import.js — module STEP import + PMI extrait du host NASSCAD
//
// Contient, dans l'ordre où ils apparaissaient dans l'original (bloc unique,
// volontairement NON fragmenté en plusieurs fichiers — trop d'inter-dépendances
// internes pour un découpage sûr) :
//   - Import STEP via occt-import-js (chargement OCCT WASM)
//   - Cache IndexedDB des résultats STEP parsés (_stepCache*)
//   - OCCT Worker pool dédié (offload du parsing hors thread principal)
//   - STEP Turbo (très gros fichiers sans MEDUSA) : stepSliceAssembly découpe en
//     tranches qui portent chacune toute la structure d'assemblage, _stepTurboRead
//     les lit en parallèle, _importSTEPSingle traite le tout en un seul import
//   - STEP OmniReader (normalisation des conteneurs STEP/ZIP)
//   - NASSCAD PMI — Product Manufacturing Information (AP242/MBD)
//   - importSTEP() + _importSTEPSingle() — les orchestrateurs finaux
//
// Contrat de dépendances externes (vérifié par ESLint no-undef, pas deviné) :
// Ne pas renommer ces identifiants dans le host sans relancer le scan.
//
//   scene, objs, selObjs, objCnt, COL                              — scene state
//   THREE                                                           — Three.js global
//   undoPush, updProps, updOList, updStats, nasLog, _nasAlert       — app-wide helpers
//   showSpinner, hideSpinner, _csgLog, _breathe, render             — UI/render helpers
//   _bboxCache, _camDirty, _csgTree, _fmtDur, _lastImportStats,
//   _stepTurboBatch, _initPPWorker, _ppSlot                         — état applicatif global
//   postProcessCSGGeo                                               — pipeline CSG post-traitement
//   occtimportjs                                                    — companion WASM (occt-import-js.js), externe
//   _POOL_SIZE                                                      — taille Manifold Worker Pool (host) ;
//                                                                      [NEW 11/08] Phase 2a repair concurrent
//
//   ⚠ COUPLAGE INTER-ZONES CRITIQUE : _edgeManifoldCheck, _capStepGaps,
//     _weldAndCheckManifold, _manifoldRepair — ces 4 fonctions sont restées
//     VOLONTAIREMENT dans le host (NON extraites), car directement appelées
//     aussi par la zone Quick Fillet / OCCT All-Edges Fillet (chantier actif,
//     ligne ~6775 de l'original) — extraire ce cluster aurait couplé ce module
//     à un chantier en cours. Ne pas déplacer ces 4 fonctions sans revérifier
//     les DEUX points d'appel (Quick Fillet ET ce module).
// ══════════════════════════════════════════════════════════════════════════
// ── Import STEP via occt-import-js (OCCT WASM companion) ─────────────────
// Companion requis : occt-import-js.js + occt-import-js.wasm (même dossier que NASSCAD)
// ReadStepFile → JSON {meshes[]} → Three.js BufferGeometry → scène NASSCAD
// Remplace parseSTEP JS pur : supporte tout STEP AP203/AP214/AP242, assemblages multi-corps.
// [FIX V4.2.7 19/06] Bug réel trouvé (Nass, machine perso) : "_getOcct" lisait déjà
// window._OCCT_WASM (commentaire "binary inline depuis occt-import-js.js"), mais RIEN ne
// le remplissait jamais dans V4.2.7 — ce préchargeur XHR existait pour V4.3.0 (cf. note de
// session : "WASM loading in a Worker on file:// résolue via XHR preloader... injecting
// window._OCCT_WASM") mais n'avait jamais été porté ici. Avec window._OCCT_WASM=undefined,
// occtimportjs() retombe sur SON fetch() interne par défaut — qui marche par chance sur
// certaines machines/configs Firefox sous file:// et plante sur d'autres avec l'erreur
// Emscripten classique "both async and sync fetching of the wasm failed". XHR est plus
// permissif que fetch() pour lire un fichier sibling sous file:// dans Firefox (différence
// de traitement CORS historique) — d'où le préchargement explicite ci-dessous plutôt que de
// laisser occt-import-js se débrouiller seul.
// [FIX V4.2.7 19/06 bis] Le préchargeur XHR seul ne suffisait pas — chez Nass, même XHR
// échoue sous file:// (politique navigateur plus stricte que prévu, fetch() ET XHR bloqués
// identiquement). Solution définitive : occt-import-js.wasm inliné en base64 directement
// dans le .htm (window._OCCT_WASM_B64, juste après le <script src="occt-import-js.js">)
// — zero file access requis du tout, donc immunisé contre n'importe quelle politique
// CORS/file://. Même pattern que manifold.wasm (déjà base64-inliné en prod). Le base64
// décodé devient la méthode PRIORITAIRE ; XHR ne reste qu'un filet de sécurité pour une
// éventuelle version sans le base64 inline (ex: build allégé).
function _decodeOcctWasmB64(){
  if(typeof window._OCCT_WASM_B64 !== 'string' || !window._OCCT_WASM_B64.length) return null;
  const bin = atob(window._OCCT_WASM_B64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for(let i=0;i<len;i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function _preloadOcctWasm(){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'occt-import-js.wasm', true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      // status 0 = chargement file:// local réussi (pas de code HTTP réel dans ce contexte)
      if((xhr.status === 200 || xhr.status === 0) && xhr.response && xhr.response.byteLength)
        resolve(new Uint8Array(xhr.response));
      else
        reject(new Error(`XHR occt-import-js.wasm: HTTP ${xhr.status} or empty response`));
    };
    xhr.onerror = () => reject(new Error('XHR occt-import-js.wasm failed (network/CORS/file://)'));
    xhr.send();
  });
}
// [PERF V4.7.1] nasscad_occt_wasm.js (~10 Mo, base64 inline du .wasm OCCT) était
// chargé via un <script src> bloquant dans le <head>, à CHAQUE ouverture de la page,
// même quand la session n'importe jamais de STEP et n'utilise jamais le fillet OCCT.
// Chargé maintenant à la demande, au premier besoin réel, avec le même pattern
// d'injection de <script> que le companion opencascade.wasm.data.js de quick-fillet.js.
// Si l'injection échoue/traîne, _getOcct() retombe déjà sur _preloadOcctWasm() (XHR
// direct du .wasm) sans rien casser — le base64 n'est qu'un raccourci, pas une dépendance dure.
let _occtB64Loading = null;
function _ensureOcctB64Companion(){
  if(typeof window._OCCT_WASM_B64 === 'string' && window._OCCT_WASM_B64.length) return Promise.resolve();
  if(_occtB64Loading) return _occtB64Loading;
  _occtB64Loading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'nasscad_occt_wasm.js';
    s.onload = () => resolve();
    s.onerror = () => {
      nasLog('WARN', 'nasscad_occt_wasm.js companion not found — falling back to fetching the .wasm directly');
      resolve();
    };
    document.head.appendChild(s);
  });
  return _occtB64Loading;
}

// Singleton occt : init WASM une seule fois par session, réutilisé aux imports suivants.
let _occtInst = null;
const _getOcct = async () => {
  if(!_occtInst){
    if(typeof occtimportjs==='undefined')
      throw new Error('Companion missing — place occt-import-js.js next to NASSCAD');
    if(!window._OCCT_WASM){
      await _ensureOcctB64Companion();
      const _b64Bytes = _decodeOcctWasmB64();
      if(_b64Bytes){
        window._OCCT_WASM = _b64Bytes;
        nasLog('DBG', `OCCT WASM loaded from inline base64 (${(_b64Bytes.length/1024/1024).toFixed(1)} MB) — zero file access`);
      } else {
        try { window._OCCT_WASM = await _preloadOcctWasm(); }
        catch(e){
          nasLog('WARN', `XHR preload occt-import-js.wasm failed (${e.message}) — fallback to occt-import-js internal fetch()`);
        }
      }
    }
    _occtInst = await occtimportjs(window._OCCT_WASM ? { wasmBinary: window._OCCT_WASM } : undefined);
  }
  return _occtInst;
};

// ── OCCT Worker dédié — offload du parsing STEP hors thread principal ────────
// [NEW V4.2.7p4 20/06] But : gros fichiers multi-corps (type Voron 235MB/1438 produits)
// sans geler l'UI (today: occt.ReadStepFile tourne en synchrone main-thread — le seul
// maillon du pipeline NASSCAD qui n'utilise PAS l'archi Worker déjà en place pour
// CSG/smooth) + isolation crash (un OOM WASM tue le Worker, pas tout l'onglet).
// [REVISED 20/06 bis] Worker inliné via Blob (pattern _MANIFOLD_WORKER_SRC/_PP_WORKER_SRC
// déjà en place), PAS de 3e fichier compagnon — cohérent avec la philosophie monofichier
// (dev multi-fichiers OK, livré = inliné). Le risque "chemin relatif ambigu depuis une
// Blob URL" (leçon payée cher avec MEDUSA/ES Module Worker) est contourné en injectant
// une URL ABSOLUE pour importScripts(occt-import-js.js) — résolue via document.baseURI
// côté thread principal avant création du Worker, donc aucune ambiguïté de résolution
// relative à l'intérieur du Worker, quelle que soit son origine blob:.
// Fallback automatique sur _getOcct() main-thread (chemin existant, inchangé) si le
// Worker ne peut pas être créé/initialisé — zéro régression si ça échoue sous file://
// sur une config donnée, juste pas le bénéfice de l'offload.
// [NEW V4.4.1 07/07] NASSCAD BOOSTER — compagnon natif localhost (OCCT C++).
// Détection au boot (300ms, silencieuse si absent). S'il tourne : parsing STEP
// natif + tessellation PARALLÈLE (IMeshTools InParallel — absente du binding
// WASM) + extraction binaire NSTP (zéro emval, zéro structured clone, zéro
// plafond 4GB). Fallback transparent WASM Worker → main-thread sinon. Le
// monofichier reste 100% autonome : le Booster est un turbo strictement OPT-IN.
// Protocole NSTP v1 : ['NSTP'|u32 ver|u32 jsonLen|u32 binLen][JSON][BIN].
// JSON.meshes[i]={name,color,posOffset,posCount,idxOffset,idxCount} (offsets en
// BYTES depuis le début du chunk BIN, alignés 4). Coordonnées STEP natives
// Z-up en mm — IDENTIQUES à occt-import-js → pipeline aval INCHANGÉ (sewing,
// centrage global, groupes, PMI). Sécurité : bind 127.0.0.1 côté serveur ;
// requête POST sans Content-Type explicite = requête CORS "simple" (pas de
// preflight depuis file:// / Origin null) ; le serveur répond ACAO:* + PNA.
// ═══════════════════════════════════════════════════════════════════════════
// [NEW V4.4.8] BOOSTER INSIDE — cache NSTP navigateur (IndexedDB)
// Le gain n°1 mesuré du compagnon Node (réimports ×200 : Stealthburner 42s→9s
// total, 0.2s côté parsing) venait de son cache disque — et ÇA, contrairement
// au process Node lui-même, EST portable en navigateur pur : IndexedDB. Ce
// module reproduit le même mécanisme (hash du fichier+params → NSTP v1),
// encapsulé dans CE monofichier, fonctionnel pour tout visiteur, zéro install.
// Ordre de résolution d'un import : cache IDB → Booster (si détecté) → WASM
// Worker → main thread. Après tout import réussi (quelle que soit la source),
// le résultat est ré-encodé en NSTP et stocké (fire-and-forget, éviction LRU).
// DB séparée ('nasscad_step_cache') — zéro contact avec l'IDB projet existante.
// ═══════════════════════════════════════════════════════════════════════════
const _STEP_CACHE_DB    = 'nasscad_step_cache';
const _STEP_CACHE_STORE = 'nstp';
const _STEP_CACHE_MAX   = 400 * 1024 * 1024;  // 400 MB total — éviction LRU au-delà
let _stepCacheDbP = null;   // promesse d'ouverture (lazy singleton)
let _stepCacheOff = false;  // [RESTAURÉ 17/09] forcé à true par le test CAP du 16/09
                            // (« À REMETTRE À false »), remis à sa valeur d'origine. Tant
                            // qu'il vaut true, AUCUN réimport ne ressort du cache : chaque
                            // ouverture du même fichier repaie le parsing complet. C'est la
                            // première chose à regarder devant un « import lent ».

// ══════════════════════════════════════════════════════════════════════════
// [PERF 17/09] RÉGLAGES D'IMPORT — rassemblés ici, modifiables à chaud depuis
// la console Script via window.NASSCAD_STEP_TUNING. Chacun est là parce qu'il
// était soit codé en dur, soit absent, et qu'il pèse mesurablement.
// ══════════════════════════════════════════════════════════════════════════

// ── Tessellation du chemin WASM (occt-import-js) ──────────────────────────
// Jusqu'ici RIEN n'était passé hormis linearUnit : le lecteur retombait donc
// sur ses défauts, vérifiés dans SON source (importer.cpp / importer-utils.cpp,
// dépôt kovacsv/occt-import-js) — linearDeflectionType 'bounding_box_ratio',
// linearDeflection 0.001, angularDeflection 0.5 rad.
// Ce 0.001 est un ratio de ((dx+dy+dz)/3) de la bbox de CHAQUE shape libre, et
// le coût de tout l'aval (couture, réparation, lissage, upload GPU) est presque
// linéaire en nombre de triangles : c'est le levier le moins cher du pipeline.
// 0.002 = deux fois moins fin sur les surfaces courbes, invisible à l'œil sur
// une pièce mécanique ; remettre 0.001 rend EXACTEMENT le maillage d'avant.
// Ne concerne QUE le chemin WASM : MEDUSA ignore ces paramètres (il POSTe le
// buffer brut et calcule sa propre déflexion adaptative PAR CORPS, cf.
// adaptiveBodyDeflection côté C++ — ce que le WASM, lui, n'a pas).
// [17/09] Valeur = celle de FreeCAD, littéralement. La propriété Deviation
// d'un Part Feature vaut 0,5 % par défaut et s'applique, dit sa doc, à
// « the dimensions in millimeters of the bounding box of the object », soit
// (w+h+d)/3 × Deviation/100. Or le mode 'bounding_box_ratio' d'occt-import-js
// calcule exactement ((dx+dy+dz)/3) × ratio : mettre 0.005 ici, c'est faire
// tourner le lecteur WASM avec le réglage de FreeCAD, au chiffre près.
// Le défaut d'occt-import-js (0.001) était cinq fois plus fin que FreeCAD, et
// personne ne l'avait jamais comparé à quoi que ce soit.
// Seule différence restante : occt-import-js applique le ratio par SHAPE LIBRE
// (par racine), là où FreeCAD l'applique par objet. MEDUSA, lui, l'applique
// bien par corps (cf. freecadBodyDeflection côté C++).
let _STEP_WASM_DEFLECTION = 0.005;  // = Deviation 0,5 % de FreeCAD
// 28,5° = 0,4974 rad : l'Angular Deflection par défaut de FreeCAD. L'ancien
// 0,5 rad valait 28,65° — le même réglage, écrit par quelqu'un qui ne savait
// pas qu'il recopiait FreeCAD.
let _STEP_WASM_ANGULAR    = 0.497419;

// ── [17/09] IMPORT LÉGER — ne pas post-traiter ce qu'OCCT a déjà fait ─────
// FreeCAD lit le STEP, garde le B-Rep, et maille pour l'affichage. Il ne coud
// pas, ne répare pas, ne relisse pas : les normales viennent de la surface,
// exactes et gratuites, et chaque face porte sa propre triangulation — donc
// une arête vive est vive par construction, sans heuristique d'angle.
//
// NASSCAD faisait l'inverse : il soudait par position (ce qui détruit les
// arêtes vives), jetait les normales d'OCCT, puis les reconstruisait par un
// BFS d'angle de crête, et réparait chaque corps par une auto-union Manifold.
// Mesuré sur Scania-8x4 : réparation 33,8 s, couture plusieurs dizaines de
// secondes sur le thread principal — pour un résultat qu'OCCT donnait déjà.
//
// En mode FreeCAD :
//   - pas de couture ni de bouche-trou à l'import (le buffer d'index reste
//     celui d'OCCT, donc les plages de couleurs par face restent exactes) ;
//   - pas de réparation manifold, jamais — le CSG l'évaluera le jour où il en
//     aura besoin, corps par corps (cf. nasEnsureManifold dans le host) ;
//   - les normales d'OCCT sont ADOPTÉES quand la source les fournit
//     (occt-import-js les renvoie), et le lissage BFS est alors sauté ;
//   - isManifold vaut null = « pas évalué », et non false : un corps sain ne
//     doit pas porter un ⚠ que personne n'a calculé.
// false = pipeline d'avant le 17/09, à l'identique.
let _STEP_LEAN_IMPORT = true;

// ── Réparation manifold à l'import (auto-union Manifold, un corps = une union) ──
// Mesuré (Scania-Engine-V8-XT-Turbo, 1297 corps) : 234,6 s par le pool client,
// contre 17,5 s pour le lissage natif du MÊME lot. Or la réparation ne sert pas
// à AFFICHER : elle sert à rendre un corps utilisable par le CSG. Le pipeline le
// reconnaît déjà pour les corps multicolores, dont la géométrie NON réparée est
// reprise telle quelle en phase 2b, sans aucune régression visuelle.
//   - MEDUSA présent : /repair en un seul batch, quelques secondes → toujours fait.
//   - MEDUSA absent  : le pool client coûte plus cher que tout le reste de
//                      l'import réuni → différé. Les corps restent marqués
//                      non-manifold et _manifoldRepair sera appelé par le CSG
//                      le jour où il en a besoin, exactement comme aujourd'hui
//                      pour les corps multicolores.
// true = comportement d'avant le 17/09 (réparation systématique à l'import).
let _STEP_REPAIR_CLIENT_POOL = false;

// ── Bouche-trou de couture (_capStepGaps) ─────────────────────────────────
// Neutralisé par un `false &&` le 16/09 (« À REMETTRE EN ÉTAT ») pour savoir
// s'il était responsable du soudage des lumières. Rétabli — mais derrière un
// interrupteur nommé : le test se refait en mettant ce drapeau à false, sans
// plus jamais toucher au code.
let _STEP_CAP_GAPS = true;

if(typeof window !== 'undefined'){
  window.NASSCAD_STEP_TUNING = {
    get cacheOff(){ return _stepCacheOff; },                     set cacheOff(v){ _stepCacheOff = !!v; },
    get deflection(){ return _STEP_WASM_DEFLECTION; },           set deflection(v){ _STEP_WASM_DEFLECTION = +v; },
    get angular(){ return _STEP_WASM_ANGULAR; },                 set angular(v){ _STEP_WASM_ANGULAR = +v; },
    get repairClientPool(){ return _STEP_REPAIR_CLIENT_POOL; },  set repairClientPool(v){ _STEP_REPAIR_CLIENT_POOL = !!v; },
    get capGaps(){ return _STEP_CAP_GAPS; },                     set capGaps(v){ _STEP_CAP_GAPS = !!v; },
    get leanImport(){ return _STEP_LEAN_IMPORT; },               set leanImport(v){ _STEP_LEAN_IMPORT = !!v; },
    // Déviation exprimée comme dans FreeCAD : en POURCENTS de la bbox.
    get deviation(){ return _STEP_WASM_DEFLECTION * 100; },      set deviation(v){ _STEP_WASM_DEFLECTION = (+v) / 100; },
    get geoCache(){ return _STEP_GEO_CACHE; },                   set geoCache(v){ _STEP_GEO_CACHE = !!v; }
  };
}

// ══════════════════════════════════════════════════════════════════════════
// [PERF 17/09] CHRONOMÈTRE PAR ÉTAGE — « un import lent sans découpage par
// étage, c'est une opinion ». Les lignes [perf-step] existantes ne couvraient
// que couture et réparation, en DBG (donc filtrées du log visible par défaut),
// et jamais le parsing ni le lissage ni la construction des meshes : impossible
// de dire où passent les minutes. Chaque étage dépose sa marque ici, et une
// seule table est imprimée en fin d'import, en OK (donc lisible sans filtre).
// Le reliquat non mesuré est affiché explicitement plutôt que dilué : c'est lui
// qui désigne le prochain endroit à instrumenter.
// ══════════════════════════════════════════════════════════════════════════
// Le collecteur est un OBJET LOCAL à un import, passé explicitement — pas un
// singleton de module. C'est délibéré : en mode Turbo, plusieurs chunks
// traversent _importSTEPSingle EN CONCURRENCE, et un singleton mélangerait
// leurs mesures en une table qui n'existerait dans aucun import réel.
function _stepPerfNew(label){ return { label, marks: [], t0: performance.now() }; }
function _stepPerfMark(p, name, ms, info){
  if(!p) return;
  p.marks.push({ name, ms: Math.max(0, ms), info: info || '' });
}
function _stepPerfReport(p){
  if(!p || p.done) return;
  p.done = true;
  const total = Math.max(1, performance.now() - p.t0);
  const rows  = p.marks.slice();
  const acc   = rows.reduce((s, m) => s + m.ms, 0);
  rows.push({ name: '(unmeasured remainder)', ms: Math.max(0, total - acc), info: '' });
  const w = rows.reduce((m, r) => Math.max(m, r.name.length), 0);
  const head = `[perf-step] ${p.label} — total ${(total/1000).toFixed(2)} s`;
  nasLog('OK', head);
  try{ if(typeof _csgLog === 'function') _csgLog(head); }catch(e){ /* panneau CSG absent : sans importance */ }
  for(const r of rows){
    if(r.ms < 1 && r.name !== '(unmeasured remainder)') continue; // étage inactif : ne pas polluer
    nasLog('OK', `  ${r.name.padEnd(w)}  ${(r.ms/1000).toFixed(2).padStart(8)} s  `
      + `${String(Math.round(r.ms/total*100)).padStart(3)}%` + (r.info ? '   ' + r.info : ''));
  }
}

function _stepCacheOpen(){
  if(_stepCacheOff) return Promise.resolve(null);
  if(_stepCacheDbP) return _stepCacheDbP;
  _stepCacheDbP = new Promise((resolve) => {
    try{
      const req = indexedDB.open(_STEP_CACHE_DB, 1);
      req.onupgradeneeded = (ev) => {
        const st = ev.target.result.createObjectStore(_STEP_CACHE_STORE, { keyPath: 'hash' });
        st.createIndex('ts', 'ts');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => { _stepCacheOff = true; resolve(null); };
    }catch(e){ _stepCacheOff = true; resolve(null); }
  });
  return _stepCacheDbP;
}

// Hash du buffer → clé (+ salt params en suffixe : zéro copie du gros buffer).
// crypto.subtle si dispo — file:// est un contexte sécurisé, donc présent
// partout en pratique ; fallback double-FNV-1a JS pur sinon (cache local
// non-adversarial : la collision-résistance crypto est inutile ici).
// null = cache désactivé silencieusement, l'import continue normalement.
async function _stepCacheKey(buffer, params, hashHex){
  if(_stepCacheOff) return null;
  // [26/08] NSTP3 → NSTP4 : les entrées mises en cache avant la correction
  // couleur contiennent du linéaire. Bump du salt = invalidation propre, sans
  // purge explicite (l'éviction LRU nettoie les anciennes entrées).
  // [17/09] La déflexion entre dans la clé : elle change le MAILLAGE, donc une
  // entrée calculée à 0.001 n'est pas réutilisable à 0.002. Sans ça, régler
  // _STEP_WASM_DEFLECTION resterait sans effet visible sur tout fichier déjà
  // importé une fois — le pire des cas : un réglage qui a l'air de ne rien faire.
  // Bump NSTP6 → NSTP7 : invalide proprement les entrées d'avant ce changement.
  // [24/09, soir] NSTP7 → NSTP8 : les entrées portent désormais la référence
  // exacte de chaque corps (cf. _stepExactRef) ; une entrée sans elle ferait
  // exporter en maillage un fichier que MEDUSA sait réécrire à l'identique.
  const salt = '|' + ((params && params.linearUnit) || 'mm')
             + '|d' + ((params && params.linearDeflection)  ?? _STEP_WASM_DEFLECTION)
             + '|a' + ((params && params.angularDeflection) ?? _STEP_WASM_ANGULAR)
             + '|NSTP8';
  // [17/09] Le digest lui-même est calculé par _stepDigestHex (plus bas), et
  // l'appelant peut le passer déjà calculé : sur 235 Mo, hacher deux fois le
  // même buffer — une fois pour le cache de parsing, une fois pour le cache de
  // géométrie — coûterait une seconde pleine pour un résultat identique.
  const h = hashHex || await _stepDigestHex(buffer);
  return h ? (h + salt) : null;
}

// Digest du buffer en hexa : SHA-256 si disponible (file:// est un contexte
// sécurisé, donc crypto.subtle y est présent en pratique), sinon double FNV-1a
// en JS pur — le cache est local et non adversarial, la résistance aux
// collisions cryptographique n'y sert à rien, seule l'unicité de fait compte.
async function _stepDigestHex(buffer){
  try{
    if(typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest){
      const h = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,'0')).join('');
    }
  }catch(e){ /* tombe sur FNV ci-dessous */ }
  try{
    const u8 = new Uint8Array(buffer);
    let h1 = 0x811c9dc5 | 0, h2 = 0x811c9dc5 | 0;
    for(let i = 0; i < u8.length; i++){ h1 ^= u8[i]; h1 = Math.imul(h1, 0x01000193); }
    for(let i = u8.length - 1; i >= 0; i--){ h2 ^= u8[i]; h2 = Math.imul(h2, 0x01000193); }
    return 'fnv_' + (h1 >>> 0).toString(16) + '_' + (h2 >>> 0).toString(16) + '_' + u8.length;
  }catch(e){ return null; }
}

function _stepCacheGet(key){
  return _stepCacheOpen().then(db => {
    if(!db) return null;
    return new Promise((resolve) => {
      try{
        const rq = db.transaction(_STEP_CACHE_STORE, 'readonly')
                     .objectStore(_STEP_CACHE_STORE).get(key);
        rq.onsuccess = () => resolve(rq.result ? rq.result.nstp : null);
        rq.onerror   = () => resolve(null);
      }catch(e){ resolve(null); }
    });
  });
}

function _stepCacheDelete(key){
  _stepCacheOpen().then(db => {
    if(!db) return;
    try{
      db.transaction(_STEP_CACHE_STORE, 'readwrite')
        .objectStore(_STEP_CACHE_STORE).delete(key);
    }catch(e){ /* best-effort */ }
  });
}

// Fire-and-forget : encode le résultat (format occt-import-js) en NSTP v1,
// stocke, puis éviction LRU si le total dépasse _STEP_CACHE_MAX. Un échec
// (quota, encode) est silencieux : le cache est un bonus, jamais un blocage.
function _stepCachePut(key, result, label){
  try{
    const nstp = _nstpEncode(result);
    _stepCacheOpen().then(db => {
      if(!db) return;
      try{
        const tx = db.transaction(_STEP_CACHE_STORE, 'readwrite');
        tx.objectStore(_STEP_CACHE_STORE).put({ hash: key, nstp,
          size: nstp.byteLength, ts: Date.now(), name: label || '' });
        tx.oncomplete = () => _stepCacheEvict(db);
      }catch(e){ /* quota/priv — silencieux */ }
    });
  }catch(e){ /* encode raté → pas de cache, import inchangé */ }
}

function _stepCacheEvict(db){
  try{
    const idx = db.transaction(_STEP_CACHE_STORE, 'readonly')
                  .objectStore(_STEP_CACHE_STORE).index('ts');
    const entries = [];
    idx.openCursor().onsuccess = (ev) => {
      const cur = ev.target.result;
      if(cur){ entries.push({ hash: cur.value.hash, size: cur.value.size || 0 }); cur.continue(); }
      else{
        let total = entries.reduce((s, e) => s + e.size, 0);
        if(total <= _STEP_CACHE_MAX) return;
        const del = db.transaction(_STEP_CACHE_STORE, 'readwrite')
                      .objectStore(_STEP_CACHE_STORE);
        for(const e of entries){          // entries trié ts croissant (index) → LRU
          if(total <= _STEP_CACHE_MAX) break;
          del.delete(e.hash); total -= e.size;
        }
      }
    };
  }catch(e){ /* best-effort */ }
}

// Encode un résultat au format occt-import-js ({success, meshes:[...]}) en
// NSTP v1 — miroir exact du writer du compagnon Node, consommé par le
// _nstpDecode déjà présent dans ce fichier. Accepte indifféremment des
// Array JS (sortie WASM emval) ou des TypedArrays (sortie Booster décodée).
function _nstpEncode(result){
  const metas = [], bufs = [];
  let binLen = 0;
  for(const m of result.meshes){
    const posSrc = m.attributes && m.attributes.position && m.attributes.position.array;
    const idxSrc = m.index && m.index.array;
    if(!posSrc || !posSrc.length || !idxSrc || !idxSrc.length) continue;
    const pos = (posSrc instanceof Float32Array) ? posSrc : new Float32Array(posSrc);
    const idx = (idxSrc instanceof Uint32Array)  ? idxSrc : new Uint32Array(idxSrc);
    const posOffset = binLen; binLen += pos.byteLength;
    const idxOffset = binLen; binLen += idx.byteLength;
    metas.push({ name: m.name || 'Body',
      color: (m.color && m.color.r !== undefined) ? { r: m.color.r, g: m.color.g, b: m.color.b } : null,
      // [27/08] Les couleurs par face doivent survivre au cache : sans cette
      // ligne, un second import du même fichier ressortait monochrome.
      faces: (m.faces && m.faces.length) ? m.faces : undefined,
      ref: m.ref || undefined,       // [24/09, soir] cf. _stepExactRef
      posOffset, posCount: pos.length, idxOffset, idxCount: idx.length });
    bufs.push(pos, idx);
  }
  if(!metas.length) throw new Error('NSTP encode: no usable mesh');
  let json = new TextEncoder().encode(JSON.stringify({ success: true,
    source: 'nasscad-inside-cache/1.0', meshCount: metas.length, meshes: metas }));
  const pad = (4 - (json.length % 4)) % 4;
  if(pad){
    const j2 = new Uint8Array(json.length + pad); j2.set(json);
    for(let i = 0; i < pad; i++) j2[json.length + i] = 0x20;
    json = j2;
  }
  const out = new Uint8Array(16 + json.length + binLen);
  const dv = new DataView(out.buffer);
  out[0] = 0x4E; out[1] = 0x53; out[2] = 0x54; out[3] = 0x50;   // 'NSTP'
  dv.setUint32(4, 1, true);
  dv.setUint32(8, json.length, true);
  dv.setUint32(12, binLen, true);
  out.set(json, 16);
  let off = 16 + json.length;
  for(const b of bufs){
    out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), off);
    off += b.byteLength;
  }
  return out.buffer;
}

function _nstpDecode(arrayBuffer, cached){
  const dv = new DataView(arrayBuffer);
  if(arrayBuffer.byteLength < 16 || dv.getUint32(0, false) !== 0x4E535450) // 'NSTP'
    throw new Error('NSTP: invalid magic');
  const ver = dv.getUint32(4, true);
  if(ver !== 1) throw new Error('NSTP: version ' + ver + ' unsupported');
  const jsonLen = dv.getUint32(8, true);
  const binLen  = dv.getUint32(12, true);
  if(16 + jsonLen + binLen > arrayBuffer.byteLength)
    throw new Error('NSTP: truncated stream (' + arrayBuffer.byteLength + ' bytes)');
  const meta = JSON.parse(new TextDecoder('utf-8')
    .decode(new Uint8Array(arrayBuffer, 16, jsonLen)));
  const binBase = 16 + jsonLen;
  // Vues zéro-copie sur le buffer : pas de double coût, le pipeline aval copie
  // déjà lors de la conversion Z-up→Y-up (new Float32Array + Uint32Array).
  const meshes = (meta.meshes || []).map(m => ({
    name:  m.name,
    color: m.color || undefined,
    faces: (m.faces && m.faces.length) ? m.faces : undefined,
    ref:   m.ref || undefined,        // [24/09] cf. _stepExactRef
    attributes: { position: { array:
      new Float32Array(arrayBuffer, binBase + m.posOffset, m.posCount) } },
    index: { array:
      new Uint32Array(arrayBuffer, binBase + m.idxOffset, m.idxCount) }
  }));
  return { success: true, meshes };
}
// ═══════════════════════════════════════════════════════════════════════════
// [PERF 17/09] NSPG v1 — CACHE DE GÉOMÉTRIE FINALE
//
// Le cache NSTP ci-dessus range le résultat du PARSING. C'est l'étage le moins
// cher : mesuré sur Scania-Engine-V8-XT-Turbo (1297 corps), le parsing natif
// coûte 113 s, la réparation 234,6 s et le lissage 17,5 s. Un hit NSTP annonce
// « zéro parsing » — c'est vrai, et c'est précisément le problème : il ne
// rembourse que 113 s sur 365, puis refait couture, réparation et lissage à
// l'identique, à chaque ouverture du même fichier, pour un résultat au bit près
// identique. Un cache qui ne sert que pour le tiers le moins cher n'est pas un
// cache, c'est un acompte.
//
// NSPG range l'AUTRE bout : la géométrie telle qu'elle part à l'écran. Après
// couture, réparation, lissage, bascule Z-up→Y-up et offset global — tout est
// cuit dans les buffers. Restaurer un import revient alors à construire des
// BufferGeometry sur des vues typées et à les accrocher à la scène : plus
// aucun calcul, quelle que soit la taille du fichier.
//
// Format — même esprit que NSTP (binaire, framé, zéro JSON dans le chemin
// chaud) :
//   [u32 'NSPG'][u32 version][u32 jsonLen][JSON utf8][padding 4][BIN]
// Le JSON ne porte que la table des matières (noms, couleurs, drapeaux,
// offsets) ; tout ce qui est volumineux est dans BIN, aligné 4, lu par VUES et
// non par copies — la géométrie restaurée pointe directement dans le tampon du
// cache, il n'existe donc jamais deux exemplaires des sommets en mémoire.
//
// Ce qui entre dans la CLÉ (cf. _geoCacheKey) : tout ce qui change le maillage
// produit — hash du fichier, déflexion, angle, angle de crête du lissage,
// bouche-trou, et le fait qu'une réparation ait été appliquée ou non. Ce
// dernier point est là pour une raison précise : importer sans MEDUSA (corps
// laissés non-manifold), puis lancer MEDUSA et réimporter en attendant des
// corps réparés, ne doit PAS ressortir la version non réparée du cache. Deux
// variantes coexistent donc, jamais plus.
//
// Le cache NSTP est conservé tel quel : il reste le filet quand la clé
// géométrique change (on a touché à un réglage) — le parsing, lui, n'a pas à
// être refait pour autant.
// ═══════════════════════════════════════════════════════════════════════════
let _STEP_GEO_CACHE = true;
const _NSPG_MAGIC = 0x4750534E; // 'NSPG' en little-endian

// Clé du cache géométrique. `repairApplied` doit être connu AVANT l'import —
// c'est le cas : il ne dépend que de la présence de MEDUSA et du drapeau
// _STEP_REPAIR_CLIENT_POOL, tous deux déterminés en amont.
function _geoCacheKey(hashHex, repairApplied){
  if(_stepCacheOff || !_STEP_GEO_CACHE || !hashHex) return null;
  // [17/09] Le mode FreeCAD entre dans la clé. Il change la géométrie produite
  // — pas de couture, normales d'OCCT, pas de lissage — donc une entrée écrite
  // dans un mode n'est pas réutilisable dans l'autre. Sans ce champ, basculer
  // NASSCAD_STEP_TUNING.freecadMode sur un fichier déjà importé n'aurait
  // strictement aucun effet visible, et on chercherait longtemps pourquoi.
  return hashHex
    + '|d' + _STEP_WASM_DEFLECTION
    + '|a' + _STEP_WASM_ANGULAR
    + '|c30'                                  // angle de crête du lissage BFS (cf. _smoothBatch)
    + '|g' + (_STEP_CAP_GAPS ? 1 : 0)
    + '|r' + (repairApplied ? 1 : 0)
    + '|f' + (_STEP_LEAN_IMPORT ? 1 : 0)
    + '|NSPG3';                               // [24/09, soir] 2 : les corps portent leur référence exacte
                                              // [28/09 — audit] 3 : corps tessellés complétés (cf. _stepTessMissing)
}

function _geoCacheGet(key){
  return _stepCacheOpen().then(db => {
    if(!db) return null;
    return new Promise((resolve) => {
      try{
        const rq = db.transaction(_STEP_CACHE_STORE, 'readonly')
                     .objectStore(_STEP_CACHE_STORE).get(key);
        rq.onsuccess = () => resolve(rq.result ? rq.result.nstp : null);
        rq.onerror   = () => resolve(null);
      }catch(e){ resolve(null); }
    });
  });
}

// Même magasin, même éviction LRU, même budget que le cache NSTP : seule la clé
// diffère (suffixe NSPG2). Aucun changement de schéma IndexedDB — donc aucune
// migration à écrire, et une base existante continue de s'ouvrir en version 1.
function _geoCachePut(key, ab, label){
  try{
    _stepCacheOpen().then(db => {
      if(!db) return;
      try{
        const tx = db.transaction(_STEP_CACHE_STORE, 'readwrite');
        tx.objectStore(_STEP_CACHE_STORE).put({ hash: key, nstp: ab,
          size: ab.byteLength, ts: Date.now(), name: label || '' });
        tx.oncomplete = () => _stepCacheEvict(db);
      }catch(e){ /* quota/priv — silencieux, le cache est un bonus */ }
    });
  }catch(e){ /* idem */ }
}

// bodies : [{name, color:'#rrggbb', isManifold, geo, faces}] — `geo` est la
// géométrie FINALE, celle accrochée à la scène ; `faces` la table mFaces
// ([r,g,b,start,count] par face topologique) ou null.
function _nspgEncode(bodies, meta){
  const chunks = [];
  let off = 0;
  // Tous les tableaux stockés sont des f32/u32 : leur byteLength est toujours
  // multiple de 4, l'alignement des vues est donc acquis sans padding interne.
  const put = (ta) => { const o = off; chunks.push(ta); off += ta.byteLength; return o; };
  const jb = [];
  for(const b of bodies){
    const g = b.geo;
    if(!g || !g.attributes || !g.attributes.position) continue;
    const pos = g.attributes.position.array;
    const nrm = g.attributes.normal ? g.attributes.normal.array : null;
    const idx = g.index ? g.index.array : null;
    const e = { n: b.name || '', c: b.color || null, m: !!b.isManifold };
    if(b.ref) e.r = String(b.ref);          // [24/09, soir] cf. _stepExactRef
    e.p = [put(pos instanceof Float32Array ? pos : new Float32Array(pos)), pos.length];
    if(nrm) e.nr = [put(nrm instanceof Float32Array ? nrm : new Float32Array(nrm)), nrm.length];
    if(idx) e.ix = [put(idx instanceof Uint32Array ? idx : new Uint32Array(idx)), idx.length];
    if(b.faces && b.faces.length){
      // Couleur stockée DÉJÀ QUANTIFIÉE en 0xRRGGBB, pas en trois flottants.
      // Les deux seuls consommateurs de cette table (_applyFaceColors et
      // _dominantFaceHex) font exactement Math.round(v*255) : ranger l'octet et
      // le rendre en octet/255 est donc rigoureusement sans perte pour eux,
      // alors qu'un aller-retour par float32 fait dériver 1/3 en 0,33333334 —
      // inoffensif ici, mais c'est le genre d'écart qu'on finit par payer.
      // Bonus : 12 octets par face au lieu de 20, et tout est aligné 4.
      const n = b.faces.length;
      const fa = new Uint32Array(n * 3);
      for(let i = 0; i < n; i++){
        const f = b.faces[i];
        fa[i*3]   = ((Math.round(f[0]*255)<<16)|(Math.round(f[1]*255)<<8)|Math.round(f[2]*255)) >>> 0;
        fa[i*3+1] = f[3];
        fa[i*3+2] = f[4];
      }
      e.fc = [put(fa), n];
    }
    jb.push(e);
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify({ v:1, meta: meta || {}, bodies: jb }));
  const head = 12 + jsonBytes.length;
  const base = head + ((4 - (head % 4)) % 4);
  const out = new ArrayBuffer(base + off);
  const dv = new DataView(out);
  dv.setUint32(0, _NSPG_MAGIC, true);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, jsonBytes.length, true);
  new Uint8Array(out, 12, jsonBytes.length).set(jsonBytes);
  let p = base;
  for(const c of chunks){
    new Uint8Array(out, p, c.byteLength).set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
    p += c.byteLength;
  }
  return out;
}

function _nspgDecode(ab){
  const dv = new DataView(ab);
  if(dv.getUint32(0, true) !== _NSPG_MAGIC) throw new Error('NSPG: invalid signature');
  const ver = dv.getUint32(4, true);
  if(ver !== 1) throw new Error('NSPG: version ' + ver + ' not supported');
  const jsonLen = dv.getUint32(8, true);
  const j = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 12, jsonLen)));
  const head = 12 + jsonLen;
  const base = head + ((4 - (head % 4)) % 4);
  const f32 = (o, l) => new Float32Array(ab, base + o, l);
  const u32 = (o, l) => new Uint32Array(ab, base + o, l);
  const out = [];
  for(const e of j.bodies){
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(f32(e.p[0], e.p[1]), 3));
    if(e.nr) g.setAttribute('normal', new THREE.BufferAttribute(f32(e.nr[0], e.nr[1]), 3));
    if(e.ix) g.setIndex(new THREE.BufferAttribute(u32(e.ix[0], e.ix[1]), 1));
    let faces = null;
    if(e.fc){
      const n = e.fc[1];
      const fa = u32(e.fc[0], n * 3);
      faces = new Array(n);
      for(let i = 0; i < n; i++){
        const h = fa[i*3];
        faces[i] = [((h>>16)&255)/255, ((h>>8)&255)/255, (h&255)/255, fa[i*3+1], fa[i*3+2]];
      }
    }
    out.push({ name: e.n, color: e.c, isManifold: e.m, geo: g, faces, ref: e.r || null });
  }
  return { meta: j.meta || {}, bodies: out };
}

// Reconstruction des objets NASSCAD depuis une entrée NSPG. Volontairement le
// MIROIR EXACT de la phase 2c de _importSTEPSingle : même ordre, mêmes champs,
// même matériau de repli, même convention de nom. Toute divergence entre les
// deux ferait un import « depuis le cache » subtilement différent d'un import
// normal — exactement le genre de bug qu'on ne retrouve jamais.
function _geoCacheRestore(dec, file, groupId, groupLabel){
  const bodies = dec.bodies;
  undoPush('import');
  // [18/09] La table teinte → opacité voyage dans l'entrée de cache : un import
  // « depuis le cache » ne relit pas le texte, et sans elle le même fichier
  // ressortait opaque au second import. Miroir exact, comme le reste ici.
  _stepAlphaTable = (dec.meta && dec.meta.styleAlpha) ? { styleAlpha: dec.meta.styleAlpha } : null;
  const _impObjs = [];
  let meshCount = 0;
  for(const b of bodies){
    objCnt++;
    const _faceMats = _applyFaceColors(b.geo, b.faces, b.name, _stepAlphaOf);
    const col = b.color || COL[objCnt % COL.length];
    const _alpha = _stepAlphaOf(col);
    const mat = _faceMats || new THREE.MeshPhongMaterial({color:col, shininess:8,
      specular:0x1a1a1a, side:THREE.DoubleSide, transparent:_alpha < 1, opacity:_alpha});
    const mesh = new THREE.Mesh(b.geo, mat); mesh.castShadow = true; scene.add(mesh);
    mesh.position.set(0, 0, 0); // positions déjà cuites dans la géo (offset global inclus)
    mesh.updateMatrixWorld(true);
    const name = (b.name || file.name.replace(/\.[^.]+$/,'')) + '_' + objCnt;
    const obj  = {id:objCnt, name, type:'csg', mesh, color:col, isHole:false, isManifold:b.isManifold,
      stepGroupId:groupId, stepGroupLabel:groupLabel};
    // [24/09, soir] Même lien vers le B-Rep exact qu'un import complet : sans
    // lui, un fichier sorti de ce cache s'exporterait en maillage.
    if(b.ref) obj._medusaRef = _stepExactRef(b.ref,
      [(dec.meta && dec.meta.gOx) || 0, (dec.meta && dec.meta.gOy) || 0, (dec.meta && dec.meta.gOz) || 0], b.geo, col, file);
    objs.push(obj); _impObjs.push(obj); meshCount++;
  }
  selObjs = _impObjs;
  return meshCount;
}

// ═══════════════════════════════════════════════════════════════════════════
// [NEW V4.7.1] NASSCAD BOOSTER — pont de communication réel (client HTTP local).
// Complète l'implémentation : le protocole NSTP v1 et le cache IDB existaient
// déjà ci-dessus ("Booster Inside"), mais rien n'appelait encore un vrai
// compagnon natif sur le réseau — ce bloc est ce pont.
// Détection : GET http://127.0.0.1:_BOOSTER_PORT/ping, timeout court (300ms,
// cf. commentaire d'origine ligne ~121), résultat mis en cache pour la session
// (pas de re-détection à chaque import : soit le process tourne, soit non).
// Appel : POST .../step avec le buffer STEP brut en corps, SANS Content-Type
// explicite (requête CORS "simple", cf. note sécurité d'origine) ; la réponse
// est déjà un buffer NSTP v1 — décodée par le _nstpDecode déjà existant.
// Échec à tout moment (process pas lancé, crashé en cours de route, port pris
// par autre chose) → _boosterState repassé à false, fallback silencieux vers
// le chemin WASM Worker/main-thread existant, AUCUNE régression.
// ═══════════════════════════════════════════════════════════════════════════
const _BOOSTER_PORT = 8765;
const _BOOSTER_URL  = `http://127.0.0.1:${_BOOSTER_PORT}`;
let _boosterState = null; // null=pas encore testé, true/false=résultat mis en cache pour la session
// [PERF 17/09] Horodatage de la dernière sonde NÉGATIVE. _repairBatch et
// _smoothBatch remettaient _boosterState à null à CHAQUE appel (« il a pu
// démarrer depuis »), donc re-sondaient le port à chaque lot : sur une session
// sans MEDUSA et un fichier découpé en N chunks, cela fait 2 × N sondes de
// 300 ms de pure latence, payées pour une réponse qu'on connaît déjà. La
// re-sonde garde tout son sens — juste pas plus d'une par minute.
let _boosterProbeTs = 0;
const _BOOSTER_REPROBE_MS = 60000;
function _boosterMaybeReprobe(){
  if(_boosterState === false && (performance.now() - _boosterProbeTs) > _BOOSTER_REPROBE_MS)
    _boosterState = null;
}

async function _detectBooster(timeoutMs = 300){
  // [FIX 28/09 — audit] Un « absent » n'est plus définitif pour toute la session :
  // MEDUSA lancé après l'ouverture de la page, ou trop occupé pour répondre en
  // 300 ms à la première sonde, restait ignoré par les imports STEP jusqu'à F5.
  // Même règle que _repairBatch/_smoothBatch : re-sonde, au plus une par minute.
  _boosterMaybeReprobe();
  if(_boosterState !== null) return _boosterState;
  _boosterProbeTs = performance.now();
  try{
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${_BOOSTER_URL}/ping`, (typeof _nasPingInit === 'function') ? _nasPingInit(ctrl.signal) : { signal: ctrl.signal });
    clearTimeout(timer);
    _boosterState = res.ok;
  }catch(e){ _boosterState = false; }
  if(_boosterState) nasLog('OK', '⚡ NASSCAD Engine detected (native localhost companion) — native tessellation available');
  return _boosterState;
}

// ── Lissage BFS en LOT via MEDUSA natif (POST /smooth, v2.3) ──────────────
// Cible directe du goulot mesure sur import STEP multi-corps (~7 min de
// silence sur 1449 corps) : au lieu de dispatcher CHAQUE corps, l'un après
// l'autre, au seul Worker JS Postprocess (postProcessCSGGeo), on envoie TOUS
// les corps en UNE requete — le serveur les traite en parallele (thread par
// coeur, corps 100% independants). Repli : si MEDUSA absent OU si le batch
// echoue en cours de route, comportement STRICTEMENT identique a avant
// (boucle sequentielle sur postProcessCSGGeo, y compris son court-circuit
// <400 faces) — zero regression fonctionnelle possible, juste plus lent.
//
// [CHOIX DELIBERE] postProcessCSGGeo appelle geo.toNonIndexed() avant de
// deleguer (etale en triangle-soup, perd l'index existant), parce que le
// Worker JS a besoin de re-souder par position de toute facon (_ppMerge).
// Notre algo natif (smoothMeshBFSLocal, MEDUSA) fait CE MEME weld en
// premiere etape, en interne — lui envoyer une geo DEJA indexee (frequent
// en sortie de _manifoldRepair : Manifold WASM produit une geo indexee)
// est donc strictement equivalent en resultat, et evite l'aller-retour
// couteux indexe -> etale -> re-soude. On saute delibrement toNonIndexed()
// ici, uniquement sur le chemin natif.
// [11/08] _repairBatch — mirror exact de _smoothBatch (juste en dessous), meme
// raison d'etre : N corps independants, un thread par coeur cote MEDUSA plutot
// que sequentiel/pool-limite cote client. Mesure Scania-Engine-V8-XT-Turbo
// (1297 corps, meme lot) : repair via pool client (4 workers) = 234.6s vs
// smooth natif = 17.5s pour un probleme de meme forme — 13x, cf. session
// Nass 11/08. Contrat de retour DIFFERENT de _smoothBatch : celle-ci a son
// repli intégré (retourne toujours un tableau valide) ; _repairBatch retourne
// null sur tout echec plutot que de dupliquer le repli — Phase 2a plus bas
// possède déjà un chemin pool-client concurrent complet et testé (session
// précédente), pas de raison de le récrire ici, juste de le sauter quand
// MEDUSA a répondu.
async function _repairBatch(geos){
  if(!geos.length) return [];
  _boosterMaybeReprobe(); // re-sonde : peut avoir demarre depuis — mais throttlee (cf. sa definition)
  if(await _detectBooster()){
    try{
      const _bt0 = performance.now();
      // Triangle soup NON indexe — meme forme que ce qu'envoyait _manifoldRepair
      // par corps. /repair fait lui-meme le weld+union cote serveur (identique
      // a la technique client, cf. commentaire du handler C++).
      // [13/08 FIX] _weldAndCheckManifold (en amont, cf. pipeline STEP) peut
      // laisser geo INDEXEE (ligne "geo.index ? geo.index.count : ..." un peu
      // plus haut dans le pipeline le confirme deja) — position.array donne
      // alors les sommets SOUDES uniques, pas un compte lie au nombre de
      // triangles, d'ou "nVert not a multiple of 3" cote serveur des qu'une
      // geo indexee passait ici tel quelle. _smoothBatch (juste en dessous)
      // gerait deja les deux cas (envoie l'index a part) ; /repair attend du
      // non-indexe pur cote protocole, donc ici la bonne reponse est de
      // convertir AVANT emballage plutot que de changer le protocole serveur.
      const _meshesToSend = geos.map(geo => {
        const _g = geo.index ? geo.toNonIndexed() : geo;
        return { pos: _g.attributes.position.array };
      });

      let _totalBytes = 4; // u32 meshCount
      for(const m of _meshesToSend) _totalBytes += 4 + m.pos.byteLength;
      const _reqBuf = new ArrayBuffer(_totalBytes);
      const _dv = new DataView(_reqBuf);
      let _off = 0;
      _dv.setUint32(_off, _meshesToSend.length, true); _off += 4;
      for(const m of _meshesToSend){
        _dv.setUint32(_off, m.pos.length / 3, true); _off += 4;
        new Uint8Array(_reqBuf, _off, m.pos.byteLength).set(
          new Uint8Array(m.pos.buffer, m.pos.byteOffset, m.pos.byteLength));
        _off += m.pos.byteLength;
      }

      const _res = await fetch(`${_BOOSTER_URL}/repair`, { method: 'POST', body: _reqBuf });
      // [meme classe que /smooth et /csg] une reponse d'erreur est du JSON brut,
      // pas le format binaire frame — verifier AVANT de parser comme tel. Un
      // 404 (vieux MEDUSA sans /repair) tombe aussi ici : pas de content-type
      // binaire attendu -> _res.ok false -> catch -> repli normalement.
      const _ctype = _res.headers.get('content-type') || '';
      if(!_res.ok || _ctype.includes('application/json')){
        let _errMsg = `MEDUSA HTTP ${_res.status}`;
        try{ const _ej = await _res.json(); if(_ej && _ej.error) _errMsg = _ej.error; }catch(e){ /* corps illisible : on garde le statut HTTP */ }
        throw new Error(_errMsg);
      }
      const _respBuf = await _res.arrayBuffer();
      const _rdv = new DataView(_respBuf);
      const _jsonLen = _rdv.getUint32(0, true);
      const _meta = JSON.parse(new TextDecoder().decode(new Uint8Array(_respBuf, 4, _jsonLen)));
      if(!_meta.success) throw new Error(_meta.error || 'native repair failed (unknown reason)');

      let _rOff = 4 + _jsonLen;
      const _outGeos = _meta.counts.map((cnt, _mi) => {
        const vBytes = cnt * 3 * 4;
        const positions = new Float32Array(_respBuf.slice(_rOff, _rOff + vBytes)); _rOff += vBytes;
        const idxCnt = _meta.idxCounts[_mi];
        const idxBytes = idxCnt * 4;
        const indices = new Uint32Array(_respBuf.slice(_rOff, _rOff + idxBytes)); _rOff += idxBytes;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        g.setIndex(new THREE.BufferAttribute(indices, 1));
        return g;
      });
      // Contrat identique a _smoothBatch : les geos d'ENTREE sont consommees/
      // liberees ici, l'appelant ne doit plus y toucher ensuite (succes only).
      geos.forEach(g => g.dispose());
      nasLog('OK', `⚡ MEDUSA: ${geos.length} body(ies) repaired natively in ${((performance.now()-_bt0)/1000).toFixed(2)}s (${_meta.repairedCount}/${geos.length} actually repaired)`);
      return _outGeos;
    }catch(e){
      nasLog('WARN', `MEDUSA repair batch failed (${e.message}) — falling back to client worker pool`);
      // geos intactes (rien disposé avant succès complet) — le repli plus bas
      // (Phase 2a, chemin pool-client) peut les reprendre telles quelles.
    }
  }
  return null; // signale au caller : MEDUSA absent ou en echec, repli necessaire
}

async function _smoothBatch(geos, creaseDeg){
  if(!geos.length) return [];
  _boosterMaybeReprobe(); // re-sonde : peut avoir demarre depuis — mais throttlee (cf. sa definition)
  if(await _detectBooster()){
    try{
      const _bt0 = performance.now();
      const _meshesToSend = geos.map(geo => {
        const posArr = geo.attributes.position.array;
        let idxArr;
        if(geo.index){
          // THREE.js utilise parfois Uint16Array (<65536 vertices) — le
          // protocole /smooth exige u32, upcast si besoin (valeurs preservees).
          idxArr = (geo.index.array instanceof Uint32Array) ? geo.index.array : new Uint32Array(geo.index.array);
        } else {
          const n = posArr.length / 3;
          idxArr = new Uint32Array(n);
          for(let i = 0; i < n; i++) idxArr[i] = i;
        }
        return { pos: posArr, idx: idxArr };
      });

      let _totalBytes = 8; // f32 creaseDeg + u32 meshCount
      for(const m of _meshesToSend) _totalBytes += 8 + m.pos.byteLength + m.idx.byteLength;
      const _reqBuf = new ArrayBuffer(_totalBytes);
      const _dv = new DataView(_reqBuf);
      let _off = 0;
      _dv.setFloat32(_off, creaseDeg, true); _off += 4;
      _dv.setUint32(_off, _meshesToSend.length, true); _off += 4;
      for(const m of _meshesToSend){
        _dv.setUint32(_off, m.pos.length / 3, true); _off += 4;
        _dv.setUint32(_off, m.idx.length / 3, true); _off += 4;
        new Uint8Array(_reqBuf, _off, m.pos.byteLength).set(
          new Uint8Array(m.pos.buffer, m.pos.byteOffset, m.pos.byteLength));
        _off += m.pos.byteLength;
        new Uint8Array(_reqBuf, _off, m.idx.byteLength).set(
          new Uint8Array(m.idx.buffer, m.idx.byteOffset, m.idx.byteLength));
        _off += m.idx.byteLength;
      }

      const _res = await fetch(`${_BOOSTER_URL}/smooth`, { method: 'POST', body: _reqBuf });
      // [FIX meme classe que /csg] une reponse d'erreur est du JSON BRUT, pas
      // le format binaire framé — verifier AVANT de parser comme tel.
      const _ctype = _res.headers.get('content-type') || '';
      if(!_res.ok || _ctype.includes('application/json')){
        let _errMsg = `MEDUSA HTTP ${_res.status}`;
        try{ const _ej = await _res.json(); if(_ej && _ej.error) _errMsg = _ej.error; }catch(e){ /* corps illisible : on garde le statut HTTP */ }
        throw new Error(_errMsg);
      }
      const _respBuf = await _res.arrayBuffer();
      const _rdv = new DataView(_respBuf);
      const _jsonLen = _rdv.getUint32(0, true);
      const _meta = JSON.parse(new TextDecoder().decode(new Uint8Array(_respBuf, 4, _jsonLen)));
      if(!_meta.success) throw new Error(_meta.error || 'native smooth failed (unknown reason)');

      // [v2.4] Reponse desormais INDEXEE (regroupement par vertex soude +
      // ilot, cf. nasscad_booster.cpp) — idxCounts porte le nombre d'indices
      // par mesh, en plus de counts (nombre de vertices de sortie, desormais
      // significativement plus petit que faces*3 sur les pieces majoritairement
      // lisses). Reduit la memoire navigateur ET la bande passante reseau du
      // meme coup, pas seulement la taille de reponse.
      // [COMPAT] Serveur v2.3 encore en place (pas recompile) : pas de champ
      // idxCounts → traiter la reponse comme l'ancien format non-indexe.
      // Sans ce garde, idxCounts[_mi] serait undefined → index VIDE construit
      // silencieusement → corps invisibles sans erreur. Jamais ca.
      const _hasIdx = Array.isArray(_meta.idxCounts);
      if(!_hasIdx) nasLog('WARN', 'MEDUSA server predates v2.4 (no indexed smooth) — using legacy non-indexed format; rebuild the server to get the memory reduction');
      let _rOff = 4 + _jsonLen;
      const _outGeos = _meta.counts.map((cnt, _mi) => {
        const bytes = cnt * 3 * 4;
        const positions = new Float32Array(_respBuf.slice(_rOff, _rOff + bytes)); _rOff += bytes;
        const normals   = new Float32Array(_respBuf.slice(_rOff, _rOff + bytes)); _rOff += bytes;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        g.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3));
        if(_hasIdx){
          const idxCnt = _meta.idxCounts[_mi];
          const idxBytes = idxCnt * 4;
          const indices  = new Uint32Array(_respBuf.slice(_rOff, _rOff + idxBytes)); _rOff += idxBytes;
          g.setIndex(new THREE.BufferAttribute(indices, 1));
        }
        return g;
      });
      // Contrat identique a postProcessCSGGeo : les geos d'ENTREE sont
      // consommees/liberees ici, l'appelant ne doit plus y toucher ensuite.
      geos.forEach(g => g.dispose());
      const _totalOutVerts = _meta.counts.reduce((a,b)=>a+b, 0);
      nasLog('OK', `⚡ MEDUSA: ${geos.length} body(ies) smoothed natively in ${((performance.now()-_bt0)/1000).toFixed(2)}s (indexed: ${_totalOutVerts.toLocaleString('en-US')} verts)`);
      return _outGeos;
    }catch(e){
      nasLog('WARN', `MEDUSA smooth batch failed (${e.message}) — falling back to sequential JS Postprocess Worker`);
      // tombe dans le repli ci-dessous, geos intactes (rien disposé avant succès complet)
    }
  }
  // ── Repli : comportement STRICTEMENT identique a avant cette session
  // (sequentiel, un seul Worker JS Postprocess, court-circuit <400 faces
  // inclus via postProcessCSGGeo inchangee) ──
  const _out = [];
  for(const geo of geos) _out.push(await postProcessCSGGeo(geo, creaseDeg));
  return _out;
}

// [NEW] Streaming NSTS : consomme /stepstream frame par frame — chaque mesh est
// disponible dès SA tessellation terminée côté natif, au lieu d'attendre le bloc
// NSTP complet. Parser incrémental sur ReadableStream : accumule les octets,
// extrait chaque frame [u32 jsonLen][json][pos f32][idx u32] dès qu'elle est
// complète. Frame {"end":true} = fin (ou {"end":true,"error"} = échec côté
// serveur en cours de route → on jette, l'appelant retombe sur /step classique).
// ── [24/09] Référence au B-Rep exact d'un corps importé ─────────────────────
// MEDUSA garde la géométrie exacte de chaque corps qu'il lit et la désigne par
// « ref » (« h<empreinte du fichier>:<rang>:<signature> », cf. ImportEntry dans
// nasscad_medusa.cpp). On mémorise avec elle ce qu'il faut pour la replacer à
// l'export :
//   off  — la translation globale appliquée à l'import (pass 2, centrage) ;
//   col0 — la couleur d'origine (une couleur changée = couleurs de faces
//          d'origine abandonnées, cf. step-export.js) ;
//   fp   — l'empreinte de la géométrie affichée (nombres de sommets et
//          d'indices, hash du contenu). Une géométrie modifiée depuis l'import
//          (booléenne, réparation, transformation « cuite », édition) ne
//          correspond plus : l'export retombe alors sur le maillage, jamais
//          sur l'ancien corps ;
// Le fichier source (File/Blob) est rangé à part, par étiquette, dans
// _stepExactSources : si MEDUSA ne tient plus ce B-Rep au moment de l'export
// (redémarré, ou import sorti du cache du navigateur sans passer par lui),
// step-export.js le lui renvoie (/stepload) — une relecture sans maillage,
// sous la même empreinte. À part, et non dans _medusaRef : le journal
// d'annulation et le fichier projet sérialisent _medusaRef, et un File n'a
// rien à y faire (IndexedDB en recopierait le contenu à chaque action).
//
// Hash du contenu : MurmurHash3 (x86, 32 bits) sur les BITS des positions puis
// sur les indices. Un multiply-xor naïf ne suffirait pas : deux inversions de
// signe s'y annulent, et un miroir « cuit » d'une pièce centrée garde nombre
// de sommets ET boîte englobante — c'est exactement le cas à attraper.
function _stepGeoHash(g){
  const pa = g.attributes.position, ix = g.index;
  let h = 0x9747b28c | 0, len = 0;
  const eat = (w) => {
    let k = Math.imul(w | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    h ^= Math.imul(k, 0x1b873593);
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  };
  const arr = pa.array;
  if(arr instanceof Float32Array && pa.itemSize === 3 && !pa.isInterleavedBufferAttribute){
    const u = new Uint32Array(arr.buffer, arr.byteOffset, pa.count * 3);
    for(let i = 0; i < u.length; i++) eat(u[i]);
    len += u.length;
  }else{
    const f = new Float32Array(3), u = new Uint32Array(f.buffer);
    for(let i = 0; i < pa.count; i++){
      f[0] = pa.getX(i); f[1] = pa.getY(i); f[2] = pa.getZ(i);
      eat(u[0]); eat(u[1]); eat(u[2]);
    }
    len += pa.count * 3;
  }
  if(ix){
    const a = ix.array, n = ix.count;
    for(let i = 0; i < n; i++) eat(a[i]);
    len += n;
  }
  h ^= len;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
function _stepGeoFingerprint(g){
  if(!g || !g.attributes || !g.attributes.position) return null;
  return { n: g.attributes.position.count, i: g.index ? g.index.count : 0, h: _stepGeoHash(g) };
}
const _stepExactSources = new Map();          // étiquette MEDUSA → File/Blob source
function _stepExactRef(ref, off, geo, col, src){
  const r = String(ref), tag = r.split(':')[0];
  if(src && typeof src.slice === 'function' && /^h[0-9a-f]{32}$/.test(tag)) _stepExactSources.set(tag, src);
  return { ref: r, off: off.slice(0, 3), col0: col, fp: _stepGeoFingerprint(geo) };
}
// ?tag= pour MEDUSA : les 32 premiers chiffres hexa du SHA-256 du fichier. Il
// identifie le fichier auprès du moteur d'une session à l'autre ; sans lui
// (digest indisponible), MEDUSA prend une étiquette de session, comme avant.
function _stepTagQuery(hashHex){
  return (typeof hashHex === 'string' && /^[0-9a-f]{32,}$/.test(hashHex)) ? '?tag=' + hashHex.slice(0, 32) : '';
}

async function _readStepFileViaBoosterStream(buffer, params, onMesh, hashHex){
  const res = await fetch(`${_BOOSTER_URL}/stepstream${_stepTagQuery(hashHex)}`, { method: 'POST', body: buffer });
  if(!res.ok || !res.body){
    const err = new Error('stream unavailable (HTTP ' + res.status + ')');
    err.streamUnsupported = true; // vieux serveur sans /stepstream → repli /step
    throw err;
  }
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  const meshes = [];
  let endInfo = null;

  const append = (chunk) => {
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf, 0); merged.set(chunk, buf.length);
    buf = merged;
  };
  const tryParseFrames = () => {
    for(;;){
      if(buf.length < 4) return;
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const jsonLen = dv.getUint32(0, true);
      if(buf.length < 4 + jsonLen) return;
      const meta = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + jsonLen)));
      if(meta.end){
        endInfo = meta;
        buf = buf.subarray(4 + jsonLen);
        return;
      }
      const posBytes = meta.posCount * 4, idxBytes = meta.idxCount * 4;
      const total = 4 + jsonLen + posBytes + idxBytes;
      if(buf.length < total) return; // frame incomplète : attendre la suite
      // Copies (slice) : détachées du gros accumulateur, GC-friendly
      const pos = new Float32Array(buf.slice(4 + jsonLen, 4 + jsonLen + posBytes).buffer);
      const idx = new Uint32Array(buf.slice(4 + jsonLen + posBytes, total).buffer);
      const mesh = { name: meta.name, color: meta.color || undefined,
        faces: (meta.faces && meta.faces.length) ? meta.faces : undefined,
        ref: meta.ref || undefined,   // [24/09] B-Rep exact gardé par MEDUSA (cf. _stepExactRef)
        attributes: { position: { array: pos } }, index: { array: idx } };
      meshes.push(mesh);
      if(onMesh) try{ onMesh(mesh, meshes.length); }catch(e){ /* la progression ne doit jamais casser l'import */ }
      buf = buf.subarray(total);
    }
  };

  for(;;){
    const { done, value } = await reader.read();
    if(value && value.length){ append(value); tryParseFrames(); }
    if(endInfo || done) break;
  }
  if(endInfo && endInfo.error) throw new Error(endInfo.error);
  if(!meshes.length) throw new Error('empty stream');
  return { success: true, meshes };
}

// POST du buffer STEP brut au compagnon natif. Le buffer n'est PAS détaché par
// fetch() (contrairement à un postMessage transferable vers un Worker) — reste
// utilisable ensuite si ce chemin échoue et qu'on retombe sur le Worker WASM.
async function _readStepFileViaBooster(buffer, params, hashHex){
  const ctrl = new AbortController();
  const timeoutMs = Math.max(120000, Math.ceil(buffer.byteLength / (1024*1024)) * 3000); // 3s/Mo, plancher 2min
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try{
    // [19/09] IFC et STEP partagent le conteneur ISO 10303-21 ; seul le schema
    // change. MEDUSA a un point d'entree dedie, et /step sait aussi renifler —
    // on vise quand meme /ifc explicitement, c'est plus clair dans ses logs.
    const _ep = (params && params.ifc) ? '/ifc' : '/step' + _stepTagQuery(hashHex);
    res = await fetch(`${_BOOSTER_URL}${_ep}`, { method: 'POST', body: buffer, signal: ctrl.signal });
  }catch(e){
    if(e.name === 'AbortError'){
      const err = new Error(`timeout after ${(timeoutMs/1000).toFixed(0)}s — server probably stuck on this file`);
      throw err; // PAS de err.boosterAlive : un serveur qui ne répond pas dans ce délai est traité comme mort
    }
    throw e;
  }finally{
    clearTimeout(timer);
  }
  if(!res.ok){
    let msg = 'HTTP ' + res.status;
    try{ const j = await res.json(); if(j && j.error) msg = j.error; }catch(e){ /* corps non-JSON, on garde le code HTTP */ }
    const err = new Error(msg);
    // Le serveur a RÉPONDU (juste avec une erreur) — il est vivant, seul CE fichier
    // a échoué (géométrie exotique, entité non supportée...). Ne pas désactiver le
    // Booster pour le reste de la session sur la base d'un seul fichier capricieux.
    err.boosterAlive = true;
    throw err;
  }
  const ab = await res.arrayBuffer();
  return _nstpDecode(ab, false);
}
// ═══════════════════════════════════════════════════════════════════════════
// [NEW V4.5.0] STEP WORKER POOL — le F4 de l'audit initial, réparé.
// L'ancien _stepSlot SINGLETON sérialisait tous les chunks dans UN seul Worker :
// le "mode PARALLEL" du slicer ne parallélisait en réalité que le pipeline
// main-thread (sewing du chunk N-1 pendant le parsing du chunk N). Désormais :
// un pool de Web Workers, chacun portant SA propre instance occt-import-js
// (WASM mono-thread par instance — mais N instances = N chunks réellement
// simultanés sur N cœurs). C'est le portage navigateur pur du pool
// worker_threads du compagnon Node : même bénéfice, zéro process externe —
// toute la lumière dans un seul récipient.
// Création LAZY : slot 0 seul pour un import simple ; les slots suivants ne
// naissent que si plusieurs chunks arrivent de front (slicing gros fichiers).
// Prudence mémoire : chaque instance WASM porte son heap propre (plusieurs
// centaines de MB possibles sur un chunk de 70MB) et le navigateur ne révèle
// jamais la vraie RAM — plafond dur à 4, et hardwareConcurrency-1 pour
// laisser un cœur au main thread (UI, sewing, Three.js).
let _stepPool = [];            // [{worker, ready, dead, busy, cbs:Map, idx}]
let _stepWorkerFailed = false; // échec GLOBAL (slot 0 KO) → main-thread pour la session
let _stepJobId = 0;
const _STEP_POOL_MAX = Math.max(1, Math.min((navigator.hardwareConcurrency || 2) - 1, 4));

function _occtWorkerSrc(occtJsAbsUrl){
  return [
    `importScripts(${JSON.stringify(occtJsAbsUrl)});`,
    `let _occt = null;`,
    `self.onmessage = async function(ev){`,
    `  const d = ev.data;`,
    `  if(d.type === 'init'){`,
    `    try{`,
    `      var cfg = { locateFile: function(p){ return p; } };`,
    `      if(d.wasmModule){`,
    `        cfg.instantiateWasm = function(imports, receive){`,
    `          WebAssembly.instantiate(d.wasmModule, imports).then(function(inst){ receive(inst, d.wasmModule); })`,
    `            .catch(function(e){ self.postMessage({type:'error', msg:'instantiateWasm: ' + ((e&&e.message)||e)}); });`,
    `          return {};`,
    `        };`,
    `      } else {`,
    `        cfg.wasmBinary = d.wasmBytes;`,
    `      }`,
    `      _occt = await occtimportjs(cfg);`,
    `      self.postMessage({type:'ready'});`,
    `    } catch(err){`,
    `      self.postMessage({type:'error', msg:'OCCT Worker init failed: ' + ((err&&err.message)||err)});`,
    `    }`,
    `    return;`,
    `  }`,
    `  if(d.type === 'read'){`,
    `    const {id, buffer, params} = d;`,
    `    try{`,
    `      if(!_occt) throw new Error('OCCT Worker not initialized');`,
    `      const result = _occt.ReadStepFile(new Uint8Array(buffer), params);`,
    // [PERF 17/09] Sommets et index convertis en tableaux TYPÉS ici, dans le
    // Worker, puis renvoyés en TRANSFERABLES. occt-import-js sort des tableaux
    // JS ordinaires (emval) : sur un corps de 2,7 M triangles, ce sont ~12 M de
    // nombres boxés que le structured clone du postMessage recopie un par un
    // vers le thread principal, avant que la passe 1 ne les recopie encore dans
    // un Float32Array. Converti ici, le passage de frontière devient un simple
    // changement de propriétaire d'ArrayBuffer — coût nul — et la conversion
    // elle-même ne pèse plus sur le thread qui doit rester réactif.
    // En cas de structure inattendue, on renvoie le résultat BRUT : une
    // optimisation ne doit jamais pouvoir casser ce qui marchait.
    `      var _tr = new Set();`,
    `      try{`,
    `        var _ms = (result && result.meshes) || [];`,
    `        for(var _i = 0; _i < _ms.length; _i++){`,
    `          var _m = _ms[_i], _a = _m.attributes;`,
    `          if(_a && _a.position && _a.position.array){`,
    `            var _p = _a.position.array;`,
    `            if(!(_p instanceof Float32Array)) _p = new Float32Array(_p);`,
    `            _a.position.array = _p; _tr.add(_p.buffer);`,
    `          }`,
    `          if(_a && _a.normal && _a.normal.array){`,
    `            var _n = _a.normal.array;`,
    `            if(!(_n instanceof Float32Array)) _n = new Float32Array(_n);`,
    `            _a.normal.array = _n; _tr.add(_n.buffer);`,
    `          }`,
    `          if(_m.index && _m.index.array){`,
    `            var _x = _m.index.array;`,
    `            if(!(_x instanceof Uint32Array)) _x = new Uint32Array(_x);`,
    `            _m.index.array = _x; _tr.add(_x.buffer);`,
    `          }`,
    `        }`,
    `      } catch(convErr){ _tr.clear(); }`,
    `      self.postMessage({type:'result', id, result}, Array.from(_tr));`,
    `    } catch(err){`,
    `      self.postMessage({type:'error', id, msg:(err&&err.message)||String(err)});`,
    `    }`,
    `  }`,
    `};`
  ].join('\n');
}

function _initStepWorkerSlot(idx){
  if(_stepWorkerFailed) return null;
  if(_stepPool[idx]) return _stepPool[idx];
  try{
    const occtJsAbsUrl = new URL('occt-import-js.js', document.baseURI).href;
    const blob = new Blob([_occtWorkerSrc(occtJsAbsUrl)], {type:'application/javascript'});
    const blobUrl = URL.createObjectURL(blob);
    const worker = new Worker(blobUrl);
    const slot = {worker, ready:false, dead:false, busy:false, cbs:new Map(), idx};
    _stepPool[idx] = slot;
    worker.onmessage = function(e){
      const d = e.data;
      if(d.type === 'ready'){
        URL.revokeObjectURL(blobUrl); // différé au 'ready' — safe Electron/WebView2 (cf. _createPoolWorker)
        slot.ready = true;
        nasLog('OK', `OCCT Worker #${idx} (STEP) ready — parsing offloaded from main thread`);
        return;
      }
      if(d.type === 'error' && d.id === undefined){
        // erreur d'INIT (pas liée à un job) — slot 0 KO = bascule globale main-thread
        // (comportement historique) ; slot >0 KO = pool juste réduit, on continue.
        nasLog('WARN', `OCCT Worker #${idx} init failed (${d.msg})` +
          (idx === 0 ? ' — fallback to main-thread' : ' — pool reduced'));
        slot.dead = true;
        if(idx === 0) _stepWorkerFailed = true;
        return;
      }
      if(d.id === undefined) return;
      const cb = slot.cbs.get(d.id);
      if(!cb) return;
      slot.cbs.delete(d.id);
      slot.busy = false;
      if(d.type === 'result') cb.resolve(d.result);
      else cb.reject(new Error(d.msg || 'Unknown OCCT Worker error'));
    };
    worker.onerror = function(e){
      nasLog('WARN', `OCCT Worker #${idx} error (${e.message||e})` +
        (idx === 0 ? ' — falling back to main-thread for the rest of the session'
                   : ' — slot removed from pool'));
      slot.dead = true; slot.ready = false;
      slot.cbs.forEach(cb => cb.reject(new Error('OCCT Worker crashed: ' + (e.message||'unknown'))));
      slot.cbs.clear();
      if(idx === 0) _stepWorkerFailed = true;
    };
    _sendOcctWasmToStepWorker(worker, idx);
    return slot;
  } catch(err){
    nasLog('WARN', `OCCT Worker #${idx} unavailable (${err.message})` +
      (idx === 0 ? ' — fallback to main-thread. If this persists: some browsers restrict ' +
      'Workers under file:// — serve NASSCAD via a small local HTTP server ' +
      '(e.g. python -m http.server) to get around this restriction.' : ''));
    if(idx === 0) _stepWorkerFailed = true;
    _stepPool[idx] = null;
    return null;
  }
}
// Transfert zero-copy du WASM déjà décodé (base64 inline ou XHR fallback, cf. _getOcct)
// vers UN worker du pool — celui-ci ne doit JAMAIS tenter de fetch() le .wasm lui-même
// (c'est exactement ce fetch qui posait problème sous file:// avant l'inlining base64).
// [PERF 17/09] Compilation UNIQUE du binaire OCCT, partagée par le pool.
// Chaque slot recevait jusqu'ici sa propre copie des ~7,25 Mo et appelait
// occtimportjs({wasmBinary}) : autant de compilations WebAssembly complètes que
// de slots, pour un binaire rigoureusement identique. Un WebAssembly.Module est
// structured-cloneable vers un Worker du même agent cluster — on compile donc
// une fois ici, et les slots suivants instancient directement via le hook
// instantiateWasm d'Emscripten. Économie : (N-1) compilations et (N-1) copies
// de 7,25 Mo.
// Le slot 0 garde DÉLIBÉRÉMENT le chemin par octets : sa compilation est de
// toute façon la première (rien à mutualiser), et c'est le seul slot dont
// l'échec bascule toute la session en main-thread — on ne lui fait donc courir
// aucun risque nouveau. Un slot >0 qui échouerait ne fait que réduire le pool,
// cas déjà géré (cf. onmessage/onerror, branche idx !== 0).
let _occtWasmModP = null;
function _occtWasmModule(bytes){
  if(_occtWasmModP) return _occtWasmModP;
  _occtWasmModP = WebAssembly.compile(bytes).catch(e => {
    nasLog('DBG', `OCCT WASM pre-compile unavailable (${e.message}) — pool slots fall back to raw bytes`);
    return null;
  });
  return _occtWasmModP;
}

async function _sendOcctWasmToStepWorker(worker, idx){
  if(!window._OCCT_WASM) await _ensureOcctB64Companion();
  let bytes = window._OCCT_WASM || _decodeOcctWasmB64();
  if(!bytes){
    try{ bytes = await _preloadOcctWasm(); window._OCCT_WASM = bytes; }
    catch(e){
      nasLog('WARN', `OCCT Worker #${idx||0}: WASM not found (${e.message}) — fallback to main-thread`);
      const s = _stepPool[idx||0]; if(s) s.dead = true;
      if(!idx) _stepWorkerFailed = true;
      return;
    }
  }
  // [PERF 17/09] Slots >0 : on envoie le MODULE déjà compilé, pas les octets.
  if(idx > 0){
    const mod = await _occtWasmModule(bytes);
    if(mod){
      worker.postMessage({type:'init', wasmModule: mod});
      nasLog('DBG', `OCCT Worker #${idx} — reusing pre-compiled WASM module (no recompilation)`);
      return;
    }
  }
  // Copie nécessaire : window._OCCT_WASM doit rester utilisable par _getOcct() (fallback
  // main-thread) ET par les autres slots du pool — un transfer neutraliserait l'original.
  const bytesCopy = bytes.slice();
  worker.postMessage({type:'init', wasmBytes: bytesCopy}, [bytesCopy.buffer]);
}

// Acquiert un slot PRÊT et LIBRE : réutilise un slot dispo, sinon en crée un
// (lazy, jusqu'à _STEP_POOL_MAX vivants), sinon ATTEND qu'un se libère.
// Le timeout ne s'applique qu'à la READINESS (init qui foire → main-thread,
// comportement historique) : si au moins un slot a été prêt, on attend sans
// limite une libération — les watchdogs par job protègent déjà des hangs, et
// basculer en main-thread pendant que le pool bosse gèlerait l'UI pour rien.
async function _stepPoolAcquire(timeoutMs=15000){
  if(_stepWorkerFailed) return null;
  _initStepWorkerSlot(0);
  const t0 = performance.now();
  return new Promise(resolve=>{
    const iv = setInterval(()=>{
      if(_stepWorkerFailed){ clearInterval(iv); resolve(null); return; }
      for(const s of _stepPool){
        if(s && !s.dead && s.ready && !s.busy){
          s.busy = true; clearInterval(iv); resolve(s); return;
        }
      }
      const alive = _stepPool.filter(s => s && !s.dead).length;
      if(alive < _STEP_POOL_MAX){
        let idx = 0; while(_stepPool[idx]) idx++;
        _initStepWorkerSlot(idx); // ready async — les ticks suivants le verront
      }
      if(performance.now()-t0 > timeoutMs){
        const anyEverReady = _stepPool.some(s => s && s.ready && !s.dead);
        if(anyEverReady) return; // pool vivant mais saturé → on attend une libération
        clearInterval(iv);
        nasLog('WARN', `OCCT Worker not ready after ${timeoutMs}ms — fallback to main-thread`);
        resolve(null);
      }
    }, 50);
  });
}

// Lecture STEP via un worker du pool si dispo, sinon fallback synchrone main-thread.
// Watchdog généreux (base 25 min, scalé taille) : gros fichiers multi-corps =
// plusieurs minutes légitimes, mais un hang WASM silencieux ne doit pas bloquer.
// ═══════════════════════════════════════════════════════════════════════════
// [26/08] Normalisation couleur des résultats occt-import-js (chemin WASM).
//
// occt-import-js est compilé sur OCCT 7.6 (vérifié dans le binaire :
// "Open CASCADE STEP translator 7.6"). Depuis OCCT 7.5, Quantity_Color stocke
// du RGB LINÉAIRE et le lecteur STEP convertit les COLOUR_RGB du fichier
// (sRGB) vers ce linéaire ; occt-import-js appelle Red()/Green()/Blue() et
// renvoie donc du linéaire.
//
// Vérifié empiriquement en Node sur un STEP écrit par OCCT :
//   fichier  COLOUR_RGB('',1.,0.4,0.)      → #FF6600
//   retour   [1, 0.13286831974983215, 0]   → #FF2200
//
// Deux défauts corrigés ici, au SEUL point de sortie du chemin WASM :
//   1. linéaire → sRGB, pour s'aligner sur MEDUSA (qui convertit désormais
//      côté C++ via occtColorToSRGB) et sur FreeCAD/Fusion ;
//   2. occt-import-js renvoie un TABLEAU [r,g,b], alors que tout le pipeline
//      aval teste `mColor.r !== undefined` — la couleur était donc purement
//      et simplement perdue sur ce chemin, et la palette COL[] prenait le
//      relais sans le dire. Sortie normalisée en objet {r,g,b}.
//
// Ne s'applique JAMAIS aux résultats MEDUSA : ils arrivent déjà en sRGB objet
// par _nstpDecode. Appliquer les deux ferait une double conversion.
// ══════════════════════════════════════════════════════════════════════════
// [27/08] _applyFaceColors — DiffuseColor par face, à la FreeCAD.
//
// UNE seule implémentation, appelée par les deux importeurs (step-import.js et
// step-xcaf.js). C'est délibéré : les deux bugs couleur du 26/08 venaient
// précisément de deux chemins censés être identiques qui avaient divergé
// (_softenColor appliqué d'un côté seulement, {r,g,b} contre [r,g,b]).
//
// mFaces = une entrée [r,g,b,start,count] PAR FACE topologique, dans l'ordre du
// TopExp_Explorer — l'indice dans le tableau est le numéro de face. Ce tableau
// est conservé tel quel dans geo.userData.faceRanges : c'est lui qui rendra la
// sélection et la recoloration d'une face possibles.
//
// Pour le rendu, deux fusions — toutes deux réversibles puisque l'original est
// gardé : un matériau par COULEUR distincte, et les faces CONSÉCUTIVES qui
// partagent ce matériau réunies en une seule plage. Sur une pièce réelle les
// faces de même teinte se suivent presque toujours, donc le nombre d'appels de
// dessin est proche du nombre de couleurs, pas du nombre de faces.
//
// Retourne le tableau de matériaux, ou null si rien d'exploitable — l'appelant
// retombe alors sur son matériau unique, comportement d'avant inchangé.
// [11/09] Diagnostic couleurs par face. Mesuré DANS le fichier Scania :
// 38 635 faces topologiques, 14 906 portent un style propre, et seulement 176
// sont réellement jaunes #dddd0d — sur 2 corps. Les 53 corps dont le SOLIDE est
// jaune ont, pour 50 d'entre eux, 100 % de leurs faces stylées : la règle OCCT
// dit que le jaune y est intégralement écrasé. S'il reste du jaune à l'écran,
// ce n'est donc pas le fichier — c'est que la table de faces n'arrive pas
// jusqu'ici, ou qu'elle n'est plus alignée sur la géométrie. Ces compteurs
// disent lequel des deux, corps par corps. `nasFaceColorReport()` dans la
// console Script imprime le bilan après un import.
// Les lignes sont GARDÉES en mémoire, pas seulement écrites : le niveau DBG est
// filtré du log visible par défaut (cf. le bouton DBG du panneau Logs), donc un
// diagnostic qui n'existe qu'en DBG est un diagnostic que personne ne lit.
// nasFaceColorReport() les réimprime en OK — visibles sans toucher au filtre —
// et le bilan part aussi dans le panneau CSG, à côté du « STEP imported ».
let _facDiagN = 0, _facDiagOk = 0, _facDiagTally = {}, _facDiagLines = [];
function _facDiag(kind, name, info){
  _facDiagTally[kind] = (_facDiagTally[kind] || 0) + 1;
  // Les corps sains sont l'immense majorité et n'apprennent rien : on n'en
  // garde qu'un échantillon. Un plafond commun aux deux remplissait le tampon
  // avec 200 lignes « ok » et jetait précisément les cas qu'on cherche.
  const _ok = (kind === 'ok');
  if(_ok ? (_facDiagOk++ < 10) : (_facDiagN++ < 200)){
    const _l = `[face-color] ${kind} — ${name || '?'}: ${info}`;
    _facDiagLines.push(_l);
    nasLog('DBG', _l);
  }
}
function nasFaceColorReset(){ _facDiagN = 0; _facDiagOk = 0; _facDiagTally = {}; _facDiagLines = []; }
// Bilan lisible sans filtre : une ligne de synthèse + les cas à problème.
// Retourne le texte complet, pour un copier-coller depuis la console Script.
function nasFaceColorReport(n){
  const t = Object.entries(_facDiagTally).sort((a,b)=>b[1]-a[1]);
  if(!t.length){ nasLog('OK','[face-color] no body analysed'); return '[face-color] no body analysed'; }
  const bilan = '[face-color] summary — ' + t.map(([k,v])=>k+':'+v).join('  ');
  nasLog('OK', bilan);
  try{ if(typeof _csgLog === 'function') _csgLog(bilan); }catch(e){}
  // Les lignes « ok » n'apprennent rien : on remonte d'abord les autres.
  const bad = _facDiagLines.filter(l => l.indexOf('[face-color] ok —') !== 0);
  const pick = (bad.length ? bad : _facDiagLines).slice(0, n || 20);
  pick.forEach(l => nasLog('OK', l));
  if(bad.length > pick.length) nasLog('OK', `[face-color] … ${bad.length - pick.length} more line(s) — nasFaceColorReport(200)`);
  return [bilan].concat(_facDiagLines).join('\n');
}
// Export explicite : un Run NassScript s'exécute dans une IIFE isolée, où une
// déclaration de fonction de ce fichier n'est pas forcément visible.
try{ window.nasFaceColorReport = nasFaceColorReport; window.nasFaceColorReset = nasFaceColorReset; }catch(e){}

// [18/09] alphaOf : fonction teinte(0xRRGGBB) → opacité, ou absente. Elle vient
// de la table de styles du fichier (nasStepDeclaredAlpha) et ne touche que les
// teintes que le fichier déclare explicitement transparentes ; sans elle, ou
// pour toute teinte inconnue, le matériau est opaque — comportement d'avant.
function _applyFaceColors(geo, mFaces, _dbgName, alphaOf){
  if(!mFaces || mFaces.length < 2){
    _facDiag('single-colour', _dbgName, `mFaces=${mFaces ? mFaces.length : 'null'}`);
    return null;
  }
  const _idxCount = geo.index ? geo.index.count : geo.attributes.position.count;
  let _drop = 0, _span = 0;
  const _mk = c => {
    const a = alphaOf ? alphaOf(c) : 1;
    return new THREE.MeshPhongMaterial({color:c, shininess:8, specular:0x1a1a1a,
      side:THREE.DoubleSide, transparent:a < 1, opacity:a});
  };
  const _mats = [], _byColor = new Map();
  const _groups = [], _areaOf = [];
  let _covered = 0, _run = null;
  geo.clearGroups();
  for(const f of mFaces){
    const _fs = f[3];
    if(_fs + f[4] > _span) _span = _fs + f[4];
    if(_fs >= _idxCount){ _drop++; continue; }
    const _cnt = Math.min(f[4], _idxCount - _fs);
    if(_cnt <= 0){ _drop++; continue; }
    const _hex = (Math.round(f[0]*255)<<16)|(Math.round(f[1]*255)<<8)|Math.round(f[2]*255);
    let _mi = _byColor.get(_hex);
    if(_mi === undefined){ _mi = _mats.length; _byColor.set(_hex, _mi); _mats.push(_mk(_hex)); }
    if(_run && _run.mi === _mi && _run.start + _run.count === _fs){ _run.count += _cnt; }
    else { if(_run) _groups.push(_run); _run = { start:_fs, count:_cnt, mi:_mi }; }
    _areaOf[_mi] = (_areaOf[_mi] || 0) + _cnt;
    if(_fs + _cnt > _covered) _covered = _fs + _cnt;
  }
  if(_run) _groups.push(_run);
  if(!_mats.length){
    // Toutes les plages hors buffer : la géométrie n'est plus celle sur
    // laquelle la table a été calculée. `span` contre `idx` donne le facteur.
    _facDiag('ranges-off-mesh', _dbgName, `${mFaces.length} face(s), span=${_span}, idx=${_idxCount}, ratio=${(_span/(_idxCount||1)).toFixed(3)}`);
    geo.clearGroups(); return null;
  }
  // ── [11/09] Triangles qu'AUCUNE face ne revendique ───────────────────────
  // Deux origines : le gap-fill (_capStepGaps) qui ajoute en fin de buffer, et
  // les trous INTÉRIEURS — des triangles nés du sewing, entre deux plages de
  // faces, que la table ne couvre pas. Ils étaient traités différemment et tous
  // les deux mal : la queue partait sur le matériau 0, les trous sur AUCUN.
  //
  // Matériau 0, c'est la couleur de la PREMIÈRE face rencontrée — un accident
  // d'ordre de parcours, sans aucun rapport avec l'endroit où sont ces
  // triangles. Sur un corps comme le carter Scania (#2950 : 1 751 faces orange,
  // 7 gris clair, 15 gris foncé) l'orange est premier, donc tout ce qui n'était
  // revendiqué par personne devenait orange. C'est exactement la contamination
  // par proximité de couture : ce n'est pas le fichier qui déborde, c'est nous
  // qui peignons les raccords avec la teinte de la face n° 0.
  //
  // On prend le matériau DOMINANT en surface, pas le premier venu, et on
  // comble aussi les trous intérieurs — sans groupe, three.js ne dessinait
  // simplement pas ces triangles.
  let _dom = 0;
  for(let i = 1; i < _areaOf.length; i++) if((_areaOf[i]||0) > (_areaOf[_dom]||0)) _dom = i;
  _groups.sort((a,b)=>a.start-b.start);
  let _hole = 0, _tail = 0, _cursor = 0;
  for(const g of _groups){
    if(g.start > _cursor){ _hole += g.start - _cursor; geo.addGroup(_cursor, g.start - _cursor, _dom); }
    geo.addGroup(g.start, g.count, g.mi);
    if(g.start + g.count > _cursor) _cursor = g.start + g.count;
  }
  if(_cursor < _idxCount){ _tail = _idxCount - _cursor; geo.addGroup(_cursor, _tail, _dom); }
  const _fill = `holes=${_hole} tail=${_tail} dominant=#${_mats[_dom].color.getHex().toString(16).padStart(6,'0')}`;
  if(_drop) _facDiag('ranges-partial', _dbgName, `${_drop}/${mFaces.length} face(s) outside buffer, span=${_span}, idx=${_idxCount}, ${_fill}`);
  else if(_hole || _tail) _facDiag('gaps-filled', _dbgName, `${mFaces.length} face(s), ${_mats.length} colour(s), ${geo.groups.length} group(s), ${_fill}`);
  else _facDiag('ok', _dbgName, `${mFaces.length} face(s), ${_mats.length} colour(s), ${geo.groups.length} group(s)`);
  geo.userData.faceRanges = mFaces;
  return _mats;
}

// [11/09] _dominantFaceHex — la teinte qui couvre le plus de triangles dans une
// table mFaces. UNE seule implémentation, appelée par les deux importeurs, pour
// la même raison que _applyFaceColors ci-dessus : deux chemins censés donner le
// même résultat finissent toujours par diverger.
//
// Sert à trancher le cas MÉLANGÉ, celui que _adoptBrepFaces et _xcafFaceColors
// laissaient en l'état : les faces sont peintes correctement, mais la couleur
// du CORPS reste celle que le fichier a posée sur le MANIFOLD_SOLID_BREP, et
// elle peut contredire tout ce qui est affiché. Les faces héritées portent déjà
// la couleur du solide dans la table, donc si l'essentiel du corps n'est pas
// stylé c'est elle qui l'emporte d'elle-même et rien ne bouge.
//
// Départage par teinte la plus basse à surface égale : deux imports du même
// fichier doivent donner la même couleur.
function _dominantFaceHex(mFaces){
  if(!mFaces || !mFaces.length) return null;
  const area = new Map();
  for(const f of mFaces){
    if(!f || !(f[4] > 0)) continue;
    const k = (Math.round(f[0]*255)<<16)|(Math.round(f[1]*255)<<8)|Math.round(f[2]*255);
    area.set(k, (area.get(k)||0) + f[4]);
  }
  let bk = null, bv = -1;
  for(const [k,v] of area) if(v > bv || (v === bv && k < bk)){ bv = v; bk = k; }
  return bk;
}

function _lin2srgb(c){
  if(!(c > 0)) return 0;
  if(c > 1) return 1;
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1/2.4) - 0.055;
}
// [31/08] _adoptBrepFaces — les couleurs PAR FACE du chemin WASM, jamais lues
// jusqu'ici.
//
// occt-import-js expose les faces sous le nom `brep_faces`, documenté dans son
// README : [{ first, last, color }] où first/last sont des indices de TRIANGLES
// (bornes incluses) et color vaut null quand la face ne porte pas de style
// propre. Le pipeline NASSCAD, lui, lit `m.faces` — le nom et le format MEDUSA,
// [r,g,b,start,count] en indices de BUFFER. Les deux ne se sont jamais
// rencontrés : `m.faces` valait toujours undefined sur ce chemin, `mFaces`
// aussi (step-import.js ligne ~2844), et la couleur du SOLIDE gouvernait donc
// la totalité du corps.
//
// Mesuré sur Scania-Engine-V8-XT-Turbo.step (Autodesk Inventor 2018 via
// ST-Developer, 374 Mo) : 14 921 des 15 176 STYLED_ITEM du fichier visent un
// ADVANCED_FACE et non un solide. 98 % de l'information couleur du fichier
// partait à la poubelle sur ce chemin.
//
// RÈGLE APPLIQUÉE — celle d'OCCT, pas une convention maison. Dans
// XCAFPrs::CollectStyleSettings, le style d'une sous-forme est écrit dans la
// map des styles et ÉCRASE celui de son parent ; la couleur du solide ne
// s'applique qu'aux faces qui n'ont pas la leur. Deux conséquences ici :
//   - toutes les faces de même couleur  -> cette couleur remplace m.color,
//     et on n'émet aucun tableau (un seul matériau suffit) ;
//   - couleurs mélangées                -> tableau `faces`, les faces sans
//     style propre héritant de la couleur du solide.
// Sans la première règle, les 53 corps du fichier Scania dont le solide est
// jaune #DDDD0D alors qu'AUCUNE de leurs faces ne l'est s'affichaient en jaune
// vif — c'est le symptôme qui a mené à ce correctif.
function _adoptBrepFaces(m){
  const bf = m.brep_faces;
  // `m.faces` déjà présent = chemin MEDUSA ou cache NSTP : conversion déjà faite.
  if(m.faces && m.faces.length) return;
  if(!bf || !bf.length){ _facDiag('brep_faces-absent', m.name, 'occt-import-js returned no face'); return; }
  const body = (m.color && m.color.r !== undefined) ? [m.color.r, m.color.g, m.color.b] : null;
  const out = [];
  let key = null, uniform = true, nStyled = 0;
  for(const f of bf){
    if(!f || f.first === undefined || f.last === undefined) continue;
    const nTri = f.last - f.first + 1;
    if(!(nTri > 0)) continue;
    let rgb;
    if(Array.isArray(f.color) && f.color.length >= 3){
      rgb = [_lin2srgb(f.color[0]), _lin2srgb(f.color[1]), _lin2srgb(f.color[2])];
      nStyled++;
      const k = (Math.round(rgb[0]*255)<<16)|(Math.round(rgb[1]*255)<<8)|Math.round(rgb[2]*255);
      if(key === null) key = k; else if(key !== k) uniform = false;
    } else {
      // Face sans style : elle hérite du solide — même convention que MEDUSA
      // (nasscad_medusa.cpp, extractInto) et que le DiffuseColor de FreeCAD.
      uniform = false;
      rgb = body || [0.54, 0.54, 0.54];
    }
    // brep_faces indexe des TRIANGLES, _applyFaceColors indexe le BUFFER.
    out.push([rgb[0], rgb[1], rgb[2], f.first * 3, nTri * 3]);
  }
  if(!nStyled){                              // aucune couleur de face : le solide gouverne
    _facDiag('no-styled-face', m.name, `${bf.length} face(s) returned, 0 with colour`);
    return;
  }
  if(uniform){
    // Corps uniforme au niveau des faces : la face gagne contre le solide.
    m.color = { r: out[0][0], g: out[0][1], b: out[0][2] };
    return;                                  // un seul matériau, pas de groupes
  }
  if(out.length > 1){
    m.faces = out;
    // [11/09] Corps mélangé : jusqu'ici m.color restait la couleur de niveau
    // SOLIDE. Le rendu, lui, est déjà juste — les plages sont figées dans `out`
    // avant ce point, donc ce qui suit ne change PAS un pixel à l'import. Mais
    // m.color devient o.color, et c'est lui que voient la pastille de l'Object
    // List, _softenColor sur un résultat CSG, l'export STEP et le repli de
    // _buildSceneFromData. Un corps affiché gris acier avec une pastille jaune
    // #DDDD0D, c'est la même contradiction que celle du fichier, recopiée dans
    // l'application au lieu d'être tranchée.
    const dom = _dominantFaceHex(out);
    const cur = body ? ((Math.round(body[0]*255)<<16)|(Math.round(body[1]*255)<<8)|Math.round(body[2]*255)) : null;
    if(dom !== null && dom !== cur)
      m.color = { r:((dom>>16)&255)/255, g:((dom>>8)&255)/255, b:(dom&255)/255 };
  }
}

function _srgbNormalizeMeshColors(result){
  if(!result || !result.meshes) return result;
  for(const m of result.meshes){
    const c = m.color;
    if(c){
      const a = Array.isArray(c) ? c : (c.r !== undefined ? [c.r, c.g, c.b] : null);
      if(!a || a.length < 3) m.color = null;
      else m.color = { r: _lin2srgb(a[0]), g: _lin2srgb(a[1]), b: _lin2srgb(a[2]) };
    }
    // [31/08] Doit venir APRÈS la normalisation de m.color : _adoptBrepFaces
    // s'en sert comme couleur de repli pour les faces sans style, et peut la
    // remplacer quand toutes les faces s'accordent sur une autre couleur.
    try { _adoptBrepFaces(m); }
    catch(e){ nasLog('WARN', `brep_faces ignored on ${m.name||'?'} (${e.message})`); }
  }
  return result;
}

async function _readStepFileOffloaded(buffer, params, _perf, _hashHex){
  // [NEW V4.4.8] Booster Inside — cache navigateur consulté AVANT tout calcul.
  // Hash calculé ICI, en premier : plus bas, le buffer est détaché par le
  // postMessage transferable vers le Worker — il serait illisible après.
  const _tHash0 = performance.now();
  const _ck = await _stepCacheKey(buffer, params, _hashHex);
  _stepPerfMark(_perf, 'parse cache key', performance.now() - _tHash0);
  // [24/09, soir] Empreinte du fichier, remise à MEDUSA (?tag=) : cf. _stepTagQuery.
  const _fileHash = _hashHex || (_ck ? _ck.slice(0, _ck.indexOf('|')) : null);
  if(_ck){
    const _tLook0 = performance.now();
    const _hit = await _stepCacheGet(_ck);
    _stepPerfMark(_perf, 'parse cache lookup', performance.now() - _tLook0, _hit ? 'HIT' : 'miss');
    if(_hit){
      const _t0 = performance.now();
      try{
        const _out = _nstpDecode(_hit, false);
        _stepPerfMark(_perf, 'NSTP decode (cache)', performance.now() - _t0, `${_out.meshes.length} bodies`);
        nasLog('OK', `⚡ Booster Inside: ${_out.meshes.length} bodies in ` +
          `${((performance.now()-_t0)/1000).toFixed(2)}s — browser cache (IndexedDB), zero parsing`);
        return _out;
      }catch(_e){
        nasLog('WARN', 'Corrupted NSTP cache — entry purged: ' + _e.message);
        _stepCacheDelete(_ck);
      }
    }
  }
  // [NEW V4.7.1] Booster natif — tenté AVANT le WASM (Worker ou main-thread).
  // Le buffer reste intact ici (fetch ne le détache pas), donc en cas d'échec
  // on retombe sur _readStepFileUncached sans avoir rien perdu.
  if(await _detectBooster()){
    try{
      const _bt0 = performance.now();
      let _bres;
      // [19/09] /stepstream ne sert que le STEP : un IFC part directement sur
      // /ifc, sans tenter un streaming qui echouerait pour rien.
      if(params && params.ifc){
        _bres = await _readStepFileViaBooster(buffer, params, _fileHash);
      } else
      try{
        _bres = await _readStepFileViaBoosterStream(buffer, params, (mesh, n) => {
          // Progression RÉELLE, corps par corps, pendant que le natif calcule —
          // remplace le spinner "opaque lib" sans pourcentage.
          if(typeof showSpinner === 'function') showSpinner('MEDUSA (streaming)',
            `${n} body(ies) received…`, 'indeterminate');
        }, _fileHash);
      }catch(_se){
        // Vieux serveur (pas de /stepstream), coupure en cours, erreur serveur :
        // le /step classique reste la voie sûre — comportement identique à avant.
        nasLog('DBG', `MEDUSA stream unavailable (${_se.message}) — falling back to classic /step`);
        _bres = await _readStepFileViaBooster(buffer, params, _fileHash);
      }
      nasLog('OK', `⚡ MEDUSA: ${_bres.meshes.length} bodies in ` +
        `${((performance.now()-_bt0)/1000).toFixed(2)}s — native parallel OCCT, no WASM`);
      _stepPerfMark(_perf, 'parsing (MEDUSA native)', performance.now() - _bt0, `${_bres.meshes.length} bodies`);
      if(_ck && _bres && _bres.success && _bres.meshes && _bres.meshes.length){
        _stepCachePut(_ck, _bres);
      }
      return _bres;
    }catch(e){
      if(e.boosterAlive){
        // Serveur vivant, seul ce fichier a échoué (géométrie exotique...) —
        // ne pas pénaliser les imports suivants dans la même session.
        nasLog('WARN', `MEDUSA: failed on this file (${e.message}) — WASM fallback for this import, MEDUSA stays active`);
      } else {
        nasLog('WARN', `MEDUSA became unavailable mid-flight (${e.message}) — WASM fallback`);
        _boosterState = false; // vraie panne (réseau/process mort) — évite de retenter à chaque import
      }
      if(params && params.boosterOnly) throw e; // Turbo bypass : l'appelant repart sur le slicing, PAS sur le WASM entier
    }
  } else if(params && params.boosterOnly){
    throw new Error('MEDUSA not detected (boosterOnly mode)');
  }
  // [26/08] Seul point de sortie du chemin WASM : normalisation couleur AVANT
  // la mise en cache, pour que l'IDB ne stocke jamais de linéaire.
  const _tWasm0 = performance.now();
  const _res = _srgbNormalizeMeshColors(await _readStepFileUncached(buffer, params));
  _stepPerfMark(_perf, 'parsing (OCCT WASM)', performance.now() - _tWasm0,
    `${(_res && _res.meshes ? _res.meshes.length : 0)} bodies` +
    `, deflection ${(params && params.linearDeflection) ?? _STEP_WASM_DEFLECTION}` +
    ` (emval + structured clone included)`);
  if(_ck && _res && _res.success && _res.meshes && _res.meshes.length && !_stepResultUntriangulated(_res)){
    _stepCachePut(_ck, _res); // fire-and-forget : encode NSTP + store + LRU (jamais un résultat sans triangle : il serait resservi tel quel)
  }
  return _res;
}
async function _readStepFileUncached(buffer, params){
  const slot = await _stepPoolAcquire();
  if(!slot){
    nasLog('DBG', 'STEP parsing: main-thread path (Worker unavailable) — UI frozen during parsing');
    const occt = await _getOcct();
    try { return occt.ReadStepFile(new Uint8Array(buffer), params); }
    catch(e){ _occtInst = null; throw e; }   // [29/09] module WASM à court de mémoire : inutilisable, recréé à la prochaine lecture
  }
  nasLog('DBG', `STEP parsing: Worker #${slot.idx} — UI non-blocking (pool ×${_STEP_POOL_MAX})`);
  const id = ++_stepJobId;
  return new Promise((resolve, reject)=>{
    // ══ Watchdog scalable : adapté à la taille du fichier ══
    function _computeWatchdogMs(fileSizeBytes) {
      const base = _STEP_WORKER_WATCHDOG_BASE || (25 * 60 * 1000);
      const bonus = Math.max(0, fileSizeBytes - (50 * 1024 * 1024)) / (50 * 1024 * 1024) * 60000;
      return Math.round(base + bonus);
    }

    const watchdogMs = _computeWatchdogMs(buffer.byteLength);
    const tWdog = setTimeout(()=>{
      slot.cbs.delete(id);
      // [V4.5.0] Un worker qui dépasse son watchdog est présumé foutu : on le TUE
      // (libère sa RAM) et on le retire du pool — acquire en recréera un si besoin.
      // (L'ancien singleton le laissait vivant, bloqué, avec busy orphelin.)
      slot.dead = true;
      try{ slot.worker.terminate(); }catch(e){ /* déjà mort */ }
      reject(new Error(`OCCT Worker: timeout after ${Math.round(watchdogMs / 60000)} min — file probably too large for this WASM build (32-bit, 4GB linear memory cap)`));
    }, watchdogMs);
    slot.cbs.set(id, {
      resolve: (r)=>{ clearTimeout(tWdog); resolve(r); },
      // [29/09] Un worker dont la lecture a échoué est remplacé, pas réutilisé :
      // un module WASM à court de mémoire (abort) reste inutilisable, et la
      // lecture suivante — le Turbo qui prend le relais, par exemple — échouerait
      // à son tour sur lui.
      reject:  (e)=>{ clearTimeout(tWdog); slot.dead = true; slot.ready = false; try{ slot.worker.terminate(); }catch(_e){ /* déjà arrêté */ } reject(e); }
    });
    // buffer transféré en zero-copy — plus besoin après cet appel dans importSTEP()
    slot.worker.postMessage({type:'read', id, buffer, params}, [buffer]);
  });
}
// [NEW V4.2.7 19/06] Arbre Objects par fichier source — groupage par ACTION d'import,
// jamais par nom de fichier seul (convention des ténors de la CAO : SolidWorks
// créent une occurrence distincte par insertion, même fichier réimporté ou pas — la
// traçabilité de l'action prime sur la coïncidence de nom). Si le même nom revient,
// suffixe (2)/(3)/... pour désambiguïser à l'affichage, sans jamais fusionner les groupes.
let _stepGroupSeq = 0;
const _stepFilenameSeen = new Map();
// ── STEP Slicer — découpage en chunks ~30MB pour les très gros assemblages ──
// [NEW V4.2.7p4 21/06] Demande explicite Nass : éviter qu'un fichier STEP géant (type
// Voron 235MB/1438 corps) parte en UN SEUL appel occt.ReadStepFile() — on découpe en
// amont en plusieurs fichiers STEP valides et autonomes, chacun réimporté séparément
// via le pipeline existant (_importSTEPSingle, inchangé). Logique de traversée de graphe
// d'entités Part 21 (#N → #M) — pure texte, zéro dépendance OCCT pour découper, validée
// empiriquement (occt-import-js, hors-ligne) avant intégration ici.
//
// [NEW] Helpers latin1 chunkés — round-trip lossless bytes↔string. ATTENTION :
// TextEncoder encode TOUJOURS en UTF-8 (pas d'option latin1), donc decode(latin1) puis
// re-encode(TextEncoder) corromprait tout octet >127 (accents dans noms de pièces par
// ex). String.fromCharCode/charCodeAt sur des blocs de 64K évite l'explosion de la pile
// (spread operator sur un Uint8Array de 235M éléments planterait) et reste symétrique.
function _bytesToLatin1Str(bytes){
  const CH = 65536;
  let out = '';
  for(let i=0; i<bytes.length; i+=CH)
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i+CH, bytes.length)));
  return out;
}
function _latin1StrToBytes(str){
  const out = new Uint8Array(str.length);
  for(let i=0; i<str.length; i++) out[i] = str.charCodeAt(i) & 0xFF;
  return out;
}

// ── Chargement STEP tamponné sur disque (OPFS) ───────────────────────────────
// [NEW] Remplace l'ancien `await file.arrayBuffer()` + `_bytesToLatin1Str` d'un coup :
// sur un fichier de 235 MB, l'ancien chemin faisait cohabiter en RAM SIMULTANÉMENT
// l'ArrayBuffer brut (235 MB) ET la string latin1 complète (~235 MB) — un pic ~470 MB
// rien que pour ce préalable, AVANT même la Map d'entités du slicer.
// Ici : le fichier est copié une seule fois vers un fichier TAMPON sur l'Origin Private
// File System (sandbox disque par origine, jamais visible de l'utilisateur, purgé en fin
// d'import) via streaming (file.stream() → writable), puis RELU PAR FENÊTRES
// (_STEP_BUF_WINDOW) pour construire la string latin1 par morceaux — un seul Uint8Array
// de fenêtre vit en RAM à la fois, jamais le fichier entier en double. Le résultat final
// reste UNE string (le parseur d'entités du slicer a besoin d'un accès texte complet, les
// références Part21 pouvant pointer en avant ET en arrière) — donc pas de miracle sur la
// taille finale, mais le PIC transitoire pendant le CHARGEMENT passe de ~2× la taille du
// fichier à ~1× + une fenêtre. Fallback intégral (ancien chemin 100% RAM) si OPFS
// indisponible (Safari ancien, contexte non sécurisé, quota dépassé...) — zéro régression.
const _STEP_BUF_WINDOW = 16 * 1024 * 1024; // 16MB — fenêtre de lecture, pas un budget RAM total
let _stepBufSeq = 0;

async function _stepOpfsSupported(){
  try { return !!(navigator.storage && navigator.storage.getDirectory); }
  catch(e){ return false; }
}

// Retourne { text, cleanup() } — cleanup() purge le fichier tampon OPFS (no-op si repli RAM).
async function _stepLoadTextBuffered(file){
  if(!(await _stepOpfsSupported())){
    nasLog('DBG', 'STEP scratch buffer: OPFS unavailable — falling back to 100% RAM (legacy path)');
    const buffer = await file.arrayBuffer();
    return { text: _bytesToLatin1Str(new Uint8Array(buffer)), cleanup: async () => {} };
  }
  let root = null, opfsName = null;
  try {
    root = await navigator.storage.getDirectory();
    opfsName = `_nasscad_step_buf_${Date.now()}_${_stepBufSeq++}.tmp`;
    const fh = await root.getFileHandle(opfsName, { create: true });
    const writable = await fh.createWritable();
    const reader = file.stream().getReader();
    try {
      while(true){
        const { done, value } = await reader.read();
        if(done) break;
        await writable.write(value);
      }
    } finally { await writable.close(); }

    // Relecture par fenêtres → concat latin1 progressif. Blob.slice() est paresseux (ne
    // lit rien tant qu'on n'appelle pas .arrayBuffer() dessus) : chaque itération ne
    // matérialise QUE sa fenêtre, jamais le fichier tampon entier d'un coup.
    const stagedFile = await fh.getFile();
    const total = stagedFile.size;
    const parts = [];
    for(let off = 0; off < total; off += _STEP_BUF_WINDOW){
      const end = Math.min(off + _STEP_BUF_WINDOW, total);
      const winBuf = await stagedFile.slice(off, end).arrayBuffer();
      parts.push(_bytesToLatin1Str(new Uint8Array(winBuf)));
      await _breathe(); // gros fichier = beaucoup de fenêtres, ne pas geler l'UI pendant la relecture
    }
    const text = parts.length === 1 ? parts[0] : parts.join('');
    const cleanup = async () => { try { await root.removeEntry(opfsName); } catch(e){ /* déjà purgé, sans conséquence */ } };
    return { text, cleanup };
  } catch(e){
    nasLog('WARN', `STEP scratch buffer (OPFS) failed (${e.message}) — falling back to 100% RAM`);
    if(root && opfsName){ try { await root.removeEntry(opfsName); } catch(_e){ /* rien à purger */ } }
    const buffer = await file.arrayBuffer();
    return { text: _bytesToLatin1Str(new Uint8Array(buffer)), cleanup: async () => {} };
  }
}

// ═══ STEP Turbo — découpeur EXACT (squelette d'assemblage + géométrie répartie) ═══
// [29/09] Remplace stepSliceBySize pour le Turbo. Principe : CHAQUE tranche est
// un STEP complet qui porte TOUTE la structure du fichier — produits, NAUO,
// placements (CDSR / RRWT / ITEM_DEFINED_TRANSFORMATION), MAPPED_ITEM, unités,
// contextes — mais la géométrie d'une partie seulement des pièces. Dans une
// tranche, une pièce dont la géométrie est ailleurs garde sa représentation
// (tout ce qui la référence reste valide) ; ses items géométriques y sont
// remplacés par les 8 coins de sa boîte englobante (GEOMETRIC_SET de points) :
// OCCT la place comme les autres mais n'en tire aucun maillage. Chaque instance
// de chaque pièce sort donc exactement UNE fois, dans la tranche qui porte sa
// géométrie, placée par OCCT lui-même avec toute la chaîne d'assemblage.
//
// Pourquoi les coins : occt-import-js règle la finesse du maillage sur la boîte
// englobante de chaque racine (0,5 % de sa taille). Une tranche qui ne porterait
// que quelques petites pièces serait maillée jusqu'à 35 fois plus fin qu'un
// import entier (mesuré sur Stealthburner). Avec les coins de toutes les autres
// pièces à leur place, chaque racine garde la taille de tout le modèle : la
// finesse ne dépend plus du découpage. Mesuré le 29/09 : as1-oc-214, as1_pe_203,
// Rocky_House… maillage identique, triangle pour triangle, à l'import entier.
//
// Ce que faisait l'ancien découpeur, mesuré le 29/09 sur Stealthburner_CW2
// (26,7 Mo, 198 corps, lu par le même occt-import-js) avec des tranches de 8 Mo :
// 684 corps au lieu de 198 — des pièces sorties sans leurs liens d'assemblage,
// donc en double à leur position locale, et des tranches qui embarquaient
// presque tout le fichier. La déduplication par boîte englobante ne pouvait
// pas rattraper ça : chaque tranche était en plus recentrée séparément.
//
// Vocabulaire :
//   représentation  = SHAPE_REPRESENTATION et sous-types (ADVANCED_BREP_…,
//                     TESSELLATED_…) ; items = son 2e paramètre ;
//   graine          = item géométrique d'une représentation (solide, coque,
//                     GEOMETRIC_SET, TESSELLATED_SOLID…) — tout sauf placements
//                     (AXIS2_PLACEMENT_*) et MAPPED_ITEM, qui sont de la structure ;
//   unité           = représentations d'une même pièce, lues ensemble : même
//                     produit, SHAPE_REPRESENTATION_RELATIONSHIP simple, graine
//                     ou topologie partagée (faces d'un SHAPE_ASPECT…), MAPPED_ITEM
//                     vers une représentation sans produit ;
//   squelette       = fermeture de la structure (produits, liens, représentations
//                     SANS leurs graines) : présente dans toutes les tranches ;
//   annexes         = le reste (styles, couleurs, calques, PMI, propriétés) :
//                     pris dans une tranche si tout ce qu'ils visent y est, avec
//                     leurs listes filtrées (MDGPR, calques) — sinon laissés.
//
// Les tranches sont produites À LA DEMANDE (emitSeeds) : on ne garde en mémoire
// que celles en cours de lecture, et une tranche que le lecteur WASM n'avale pas
// (mémoire) peut être redécoupée sans rien relire du disque. Le plan (quelle
// graine dans quelle tranche) ne dépend que du fichier.
//
// Retour : { info, plan:[{seeds, units, bytes}…], emitSeeds(graines) → texte STEP,
//            unitLabel(u), unitsOfSeeds(graines), seedUnit(s), unitSplittable(u), release() }
function stepSliceAssembly(text, maxChunkBytes, opts){
  opts = opts || {};
  const N = text.length;
  const isWs = c => c === 32 || c === 10 || c === 13 || c === 9;
  const isKw = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
  const isDigit = c => c >= 48 && c <= 57;
  const skipComment = k => { const e = text.indexOf('*/', k + 2); return e < 0 ? N : e + 2; };   // k sur '/*' → après '*/'

  // ── 1. Section DATA (accepte « DATA; », « DATA(…); », CRLF, commentaires) ──
  function findData(from){
    let i = from, inStr = false;
    while(i < N){
      const c = text.charCodeAt(i);
      if(inStr){ if(c === 39) inStr = false; i++; continue; }
      if(c === 39){ inStr = true; i++; continue; }
      if(c === 47 && text.charCodeAt(i + 1) === 42){ i = skipComment(i); continue; }
      if(c === 68 && text.startsWith('DATA', i) && !(i > 0 && (isKw(text.charCodeAt(i - 1)) || text.charCodeAt(i - 1) === 45))){
        let j = i + 4; while(j < N && isWs(text.charCodeAt(j))) j++;
        const q = text.charCodeAt(j);
        if(q === 59 || q === 40){
          let d = 0, s = false;
          for(; j < N; j++){
            const ch = text.charCodeAt(j);
            if(s){ if(ch === 39) s = false; continue; }
            if(ch === 39){ s = true; continue; }
            if(ch === 40) d++; else if(ch === 41) d--; else if(ch === 59 && d <= 0) break;
          }
          return j + 1;
        }
      }
      i++;
    }
    return -1;
  }
  const data0 = findData(0);
  if(data0 < 0) throw new Error('DATA section not found — invalid STEP file?');
  const headerBlock = text.slice(0, data0);

  // ── 2. Lecture des entités : bornes, type, références ──
  // rList[k] : 0 = référence scalaire ; sinon n° (1..255) de la liste qui la
  // contient — une liste filtrée ne doit jamais se retrouver vide.
  function growI32(a){ const b = new Int32Array(a.length * 2); b.set(a); return b; }
  function growU8(a, len){ const b = new Uint8Array(len); b.set(a); return b; }
  let cap = Math.max(1024, (N / 60) | 0);
  let eId = new Int32Array(cap), eRec = new Int32Array(cap), eEnd = new Int32Array(cap),
      eBody = new Int32Array(cap), eType = new Int32Array(cap), eRef0 = new Int32Array(cap + 1);
  let rId = new Int32Array(cap * 3), rList = new Uint8Array(cap * 3);
  const typeCode = new Map(), typeNames = [];
  const complexParts = [];               // eType = -(k+1) → complexParts[k] = [codes]
  const intern = s => { let c = typeCode.get(s); if(c === undefined){ c = typeNames.length; typeNames.push(s); typeCode.set(s, c); } return c; };
  const listStack = [];
  let n = 0, nr = 0, maxId = 0;
  let i = data0;
  scan:
  while(i < N){
    const c = text.charCodeAt(i);
    if(isWs(c)){ i++; continue; }
    if(c === 47 && text.charCodeAt(i + 1) === 42){ i = skipComment(i); continue; }
    if(c === 69 && text.startsWith('ENDSEC', i)){          // fin de section : une autre section DATA peut suivre (Part 21 éd. 3)
      const nx = findData(i + 6);
      if(nx < 0) break scan;
      i = nx; continue;
    }
    if(c !== 35){ i++; continue; }
    const rec = i;
    let j = i + 1, id = 0;
    while(j < N && isDigit(text.charCodeAt(j))){ id = id * 10 + (text.charCodeAt(j) - 48); j++; }
    if(j === i + 1 || id > 2147483000){ i = j; continue; }
    for(;;){ const q = text.charCodeAt(j); if(isWs(q)){ j++; continue; } if(q === 47 && text.charCodeAt(j + 1) === 42){ j = skipComment(j); continue; } break; }
    if(text.charCodeAt(j) !== 61){ i = j; continue; }
    j++;
    for(;;){ const q = text.charCodeAt(j); if(isWs(q)){ j++; continue; } if(q === 47 && text.charCodeAt(j + 1) === 42){ j = skipComment(j); continue; } break; }
    const body = j;
    const complex = text.charCodeAt(j) === 40;
    const base = complex ? 2 : 1;
    let tcode;
    if(!complex){
      let k = j; while(k < N && isKw(text.charCodeAt(k))) k++;
      tcode = intern(text.slice(j, k).toUpperCase());
    }
    const parts = complex ? [] : null;
    let depth = 0, k = j, listN = 0;
    listStack.length = 0;
    if(n === eId.length){ eId = growI32(eId); eRec = growI32(eRec); eEnd = growI32(eEnd); eBody = growI32(eBody); eType = growI32(eType); eRef0 = growI32(eRef0); }
    eRef0[n] = nr;
    for(; k < N; k++){
      const q = text.charCodeAt(k);
      if(q === 39){ k = text.indexOf("'", k + 1); if(k < 0){ k = N; break; } continue; }    // chaîne ('' = deux chaînes accolées : même résultat)
      if(q === 34){ k = text.indexOf('"', k + 1); if(k < 0){ k = N; break; } continue; }    // binaire "…"
      if(q === 47 && text.charCodeAt(k + 1) === 42){ k = skipComment(k) - 1; continue; }
      if(q === 40){ depth++; if(depth > base){ listN++; listStack.push(listN > 255 ? 255 : listN); } continue; }
      if(q === 41){ if(depth > base) listStack.pop(); depth--; continue; }
      if(q === 59 && depth <= 0) break;
      if(q === 35 && isDigit(text.charCodeAt(k + 1))){
        let v = 0, m = k + 1;
        while(m < N && isDigit(text.charCodeAt(m))){ v = v * 10 + (text.charCodeAt(m) - 48); m++; }
        if(nr === rId.length){ rId = growI32(rId); rList = growU8(rList, rId.length); }
        rId[nr] = v; rList[nr] = depth > base ? listStack[listStack.length - 1] : 0; nr++;
        k = m - 1; continue;
      }
      if(complex && depth === 1 && isKw(q) && !isDigit(q)){
        let m = k; while(m < N && isKw(text.charCodeAt(m))) m++;
        parts.push(intern(text.slice(k, m).toUpperCase()));
        k = m - 1; continue;
      }
    }
    if(k >= N) break;                                       // entité tronquée en fin de fichier : ignorée
    eId[n] = id; eRec[n] = rec; eEnd[n] = k + 1; eBody[n] = body;
    if(complex){ eType[n] = -(complexParts.length + 1); complexParts.push(parts); } else eType[n] = tcode;
    if(id > maxId) maxId = id;
    n++;
    i = k + 1;
  }
  eRef0[n] = nr;
  if(!n) throw new Error('No entity found in DATA section');

  // ── 3. #id → indice ; références résolues (‑1 = référence pendante d'origine) ──
  const dense = maxId <= 8 * n + 1000000;
  const idx = dense ? new Int32Array(maxId + 1).fill(-1) : new Map();
  for(let e = 0; e < n; e++){ if(dense) idx[eId[e]] = e; else idx.set(eId[e], e); }
  const ixOf = v => dense ? (v <= maxId ? idx[v] : -1) : (idx.has(v) ? idx.get(v) : -1);
  const rTo = new Int32Array(nr);
  for(let k = 0; k < nr; k++) rTo[k] = ixOf(rId[k]);
  rId = null;

  // ── 4. Familles de types ──
  const nameOf = e => eType[e] >= 0 ? typeNames[eType[e]] : '(' + complexParts[-eType[e] - 1].map(c => typeNames[c]).join(' ') + ')';
  const hasPart = (e, name) => {
    const t = eType[e];
    if(t >= 0) return typeNames[t] === name;
    const c = typeCode.get(name); return c !== undefined && complexParts[-t - 1].indexOf(c) >= 0;
  };
  const PASSIVE = ['CARTESIAN_POINT', 'DIRECTION', 'VECTOR', 'AXIS1_PLACEMENT', 'AXIS2_PLACEMENT_2D', 'AXIS2_PLACEMENT_3D',
    'CARTESIAN_TRANSFORMATION_OPERATOR', 'CARTESIAN_TRANSFORMATION_OPERATOR_3D'];
  const STRUCT_ITEM = ['AXIS2_PLACEMENT_3D', 'AXIS2_PLACEMENT_2D', 'AXIS1_PLACEMENT', 'MAPPED_ITEM',
    'DESCRIPTIVE_REPRESENTATION_ITEM', 'MEASURE_REPRESENTATION_ITEM', 'VALUE_REPRESENTATION_ITEM'];
  const PD_TYPES = ['PRODUCT_DEFINITION', 'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS'];
  const SK_ROOT = ['PRODUCT', 'PRODUCT_DEFINITION_FORMATION', 'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE',
    'PRODUCT_DEFINITION', 'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS', 'PRODUCT_DEFINITION_SHAPE',
    'SHAPE_DEFINITION_REPRESENTATION', 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION',
    'NEXT_ASSEMBLY_USAGE_OCCURRENCE', 'ASSEMBLY_COMPONENT_USAGE', 'PRODUCT_DEFINITION_USAGE', 'SPECIFIED_HIGHER_USAGE_OCCURRENCE',
    'PROMISSORY_USAGE_OCCURRENCE', 'QUANTIFIED_ASSEMBLY_COMPONENT_USAGE',
    'SHAPE_REPRESENTATION_RELATIONSHIP', 'REPRESENTATION_RELATIONSHIP', 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION',
    'ITEM_DEFINED_TRANSFORMATION', 'MAPPED_ITEM', 'REPRESENTATION_MAP',
    'PRODUCT_RELATED_PRODUCT_CATEGORY', 'PRODUCT_CATEGORY', 'PRODUCT_CATEGORY_RELATIONSHIP',
    'APPLICATION_PROTOCOL_DEFINITION', 'APPLICATION_CONTEXT', 'PRODUCT_CONTEXT', 'PRODUCT_DEFINITION_CONTEXT',
    'MECHANICAL_CONTEXT', 'DESIGN_CONTEXT'];
  // Topologie : partagée entre deux représentations, elle les lie (une face d'un
  // SHAPE_ASPECT est aussi une face du solide ; lues séparément, elle sortirait deux fois).
  const TOPO = ['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'CLOSED_SHELL', 'OPEN_SHELL', 'ORIENTED_CLOSED_SHELL',
    'ORIENTED_OPEN_SHELL', 'ADVANCED_FACE', 'FACE_SURFACE', 'FACE', 'ORIENTED_FACE', 'SUBFACE', 'FACE_BOUND', 'FACE_OUTER_BOUND',
    'EDGE_LOOP', 'POLY_LOOP', 'VERTEX_LOOP', 'ORIENTED_EDGE', 'EDGE_CURVE', 'SUBEDGE', 'VERTEX_POINT', 'CONNECTED_FACE_SET',
    'SHELL_BASED_SURFACE_MODEL', 'FACE_BASED_SURFACE_MODEL'];
  const SOLID_SEED = ['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS'];
  // Boîte d'une pièce = ses SOMMETS (et points de polylignes / polyboucles) :
  // des points qui sont sur la géométrie. Ni pôles de B-spline ni cercles
  // complets : sur Stealthburner, ils donnaient des boîtes de 13 m pour des
  // pièces de 10 cm (arcs de très grand rayon, pôles lointains).
  const BOX_PARENT = ['VERTEX_POINT', 'POLYLINE', 'POLY_LOOP'];
  const codeSet = S => { const a = new Uint8Array(typeNames.length); for(const s of S){ const c = typeCode.get(s); if(c !== undefined) a[c] = 1; } return a; };
  const cPassive = codeSet(PASSIVE), cStruct = codeSet(STRUCT_ITEM), cPD = codeSet(PD_TYPES), cSK = codeSet(SK_ROOT),
        cTopo = codeSet(TOPO), cSolid = codeSet(SOLID_SEED), cBoxP = codeSet(BOX_PARENT);
  const cPoint = typeCode.get('CARTESIAN_POINT');
  const anyPart = (e, cs) => { const t = eType[e]; if(t >= 0) return cs[t] === 1; for(const c of complexParts[-t - 1]) if(cs[c]) return true; return false; };
  const isRepCode = new Uint8Array(typeNames.length);
  for(let c = 0; c < typeNames.length; c++){
    const s = typeNames[c];
    if(s.endsWith('SHAPE_REPRESENTATION') && s !== 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION') isRepCode[c] = 1;
  }
  const cREPRESENTATION = typeCode.get('REPRESENTATION');
  const isRepEntity = e => {
    const t = eType[e];
    if(t >= 0) return isRepCode[t] === 1;
    const ps = complexParts[-t - 1];
    if(cREPRESENTATION === undefined || ps.indexOf(cREPRESENTATION) < 0) return false;
    for(const c of ps) if(isRepCode[c]) return true;
    return false;
  };
  const isStructItem = e => anyPart(e, cStruct);
  const isPassive = e => anyPart(e, cPassive);
  const refs = e => { const a = []; for(let k = eRef0[e]; k < eRef0[e + 1]; k++) a.push(rTo[k]); return a; };

  // Items d'une représentation = références directes du 2e paramètre de
  // REPRESENTATION (simple : TYPE('n',(items),ctx) ; complexe : partiel REPRESENTATION).
  function repItems(e){
    const b = eBody[e], end = eEnd[e] - 1;
    const complex = eType[e] < 0;
    let depth = 0, pIndex = 0, inRepPartial = !complex, listDepth = -1;
    const out = [], partDepth = complex ? 2 : 1;
    for(let k = b; k < end; k++){
      const q = text.charCodeAt(k);
      if(q === 39){ k = text.indexOf("'", k + 1); if(k < 0) break; continue; }
      if(q === 34){ k = text.indexOf('"', k + 1); if(k < 0) break; continue; }
      if(q === 47 && text.charCodeAt(k + 1) === 42){ k = skipComment(k) - 1; continue; }
      if(complex && depth === 1 && isKw(q) && !isDigit(q)){
        let m = k; while(m < end && isKw(text.charCodeAt(m))) m++;
        inRepPartial = text.slice(k, m).toUpperCase() === 'REPRESENTATION'; pIndex = 0;
        k = m - 1; continue;
      }
      if(q === 40){ depth++; if(inRepPartial && depth === partDepth + 1 && pIndex === 1) listDepth = depth; continue; }
      if(q === 41){ if(depth === listDepth) listDepth = -1; depth--; continue; }
      if(q === 44 && inRepPartial && depth === partDepth){ pIndex++; continue; }
      if(q === 35 && listDepth > 0 && depth === listDepth){
        let v = 0, m = k + 1; while(m < end && isDigit(text.charCodeAt(m))){ v = v * 10 + (text.charCodeAt(m) - 48); m++; }
        const t = ixOf(v);
        if(t >= 0) out.push(t);
        k = m - 1;
      }
    }
    return out;
  }
  // Nombres d'une entité (coordonnées d'un point, rayon d'un cercle…) : tous les
  // réels du corps, hors chaînes, dans l'ordre.
  function numbersOf(e){
    const b = eBody[e], end = eEnd[e] - 1, out = [];
    for(let k = b; k < end; k++){
      const q = text.charCodeAt(k);
      if(q === 39){ k = text.indexOf("'", k + 1); if(k < 0) break; continue; }
      if(q === 35){ k++; while(k < end && isDigit(text.charCodeAt(k))) k++; k--; continue; }
      if(isDigit(q) || ((q === 45 || q === 43 || q === 46) && isDigit(text.charCodeAt(k + 1)))){
        let m = k + 1;
        while(m < end){ const x = text.charCodeAt(m); if(isDigit(x) || x === 46 || x === 69 || x === 101 || ((x === 45 || x === 43) && (text.charCodeAt(m - 1) | 32) === 101)) m++; else break; }
        out.push(parseFloat(text.slice(k, m)));
        k = m - 1;
      } else if(isKw(q)){ while(k < end && isKw(text.charCodeAt(k))) k++; k--; }   // mot-clé (évite de lire des chiffres dans un nom de type)
    }
    return out;
  }

  // ── 5. Représentations, graines, unités (union-find) ──
  const repOrd = new Int32Array(n).fill(-1);      // entité → n° de représentation
  const reps = [];
  for(let e = 0; e < n; e++) if(isRepEntity(e)){ repOrd[e] = reps.length; reps.push(e); }
  const R = reps.length;
  const repSeeds = new Array(R), repItemsN = new Int32Array(R);
  const isSeed = new Uint8Array(n);
  for(let r = 0; r < R; r++){
    const items = repItems(reps[r]); const seeds = [];
    for(const it of items) if(!isStructItem(it)){ seeds.push(it); isSeed[it] = 1; }
    repSeeds[r] = seeds; repItemsN[r] = items.length;
  }
  const uf = new Int32Array(R); for(let r = 0; r < R; r++) uf[r] = r;
  const find = r => { while(uf[r] !== r){ uf[r] = uf[uf[r]]; r = uf[r]; } return r; };
  const unite = (a, b) => { a = find(a); b = find(b); if(a !== b) uf[b] = a; };
  const repProduct = new Int32Array(R).fill(-1);
  const pdFirstRep = new Map();
  const cSDR = typeCode.get('SHAPE_DEFINITION_REPRESENTATION'), cPDS = typeCode.get('PRODUCT_DEFINITION_SHAPE');
  const cRR = typeCode.get('REPRESENTATION_RELATIONSHIP'), cSRR = typeCode.get('SHAPE_REPRESENTATION_RELATIONSHIP');
  for(let e = 0; e < n; e++){
    const t = eType[e];
    if(t >= 0 && t === cSDR){                                       // SDR(définition, représentation)
      const [pds, rep] = refs(e);
      if(rep >= 0 && repOrd[rep] >= 0 && pds >= 0 && eType[pds] === cPDS){
        const pd = refs(pds)[0];
        if(pd >= 0 && anyPart(pd, cPD)){
          repProduct[repOrd[rep]] = pd;
          const f = pdFirstRep.get(pd);
          if(f === undefined) pdFirstRep.set(pd, repOrd[rep]); else unite(f, repOrd[rep]);
        }
      }
    } else {
      const plainRR = (t >= 0 && (t === cSRR || t === cRR)) ||
        (t < 0 && (hasPart(e, 'REPRESENTATION_RELATIONSHIP') || hasPart(e, 'SHAPE_REPRESENTATION_RELATIONSHIP')) && !hasPart(e, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION'));
      if(plainRR){                                                  // même pièce, autre représentation
        const [a, b] = refs(e);
        if(a >= 0 && b >= 0 && repOrd[a] >= 0 && repOrd[b] >= 0) unite(repOrd[a], repOrd[b]);
      }
    }
  }
  // Une même graine listée par deux représentations → même unité. Cas réel
  // (Pro/E, as1_pe_203) : le solide est item de l'ADVANCED_BREP_… de la pièce
  // ET d'une SHAPE_REPRESENTATION rattachée à un SHAPE_ASPECT du produit. Dans
  // un import entier, OCCT ne le sort qu'une fois (l'entité est déjà
  // transférée) ; réparties sur deux tranches, les deux représentations le
  // sortaient chacune — un doublon exact, mesuré avant ce garde-fou.
  const seedRep = new Int32Array(n).fill(-1);
  for(let r = 0; r < R; r++) for(const s of repSeeds[r]){ if(seedRep[s] < 0) seedRep[s] = r; else unite(seedRep[s], r); }
  // MAPPED_ITEM vers une représentation SANS produit : elle fait partie de la
  // forme de la pièce hôte (un seul maillage pour OCCT) → même unité.
  const classHasProduct = new Uint8Array(R);
  for(let r = 0; r < R; r++) if(repProduct[r] >= 0) classHasProduct[find(r)] = 1;
  for(let r = 0; r < R; r++){
    for(const it of refs(reps[r])){
      if(it < 0 || !hasPart(it, 'MAPPED_ITEM')) continue;
      const src = refs(it)[0];
      if(src < 0 || !hasPart(src, 'REPRESENTATION_MAP')) continue;
      const mapped = refs(src)[1];
      if(mapped >= 0 && repOrd[mapped] >= 0 && !classHasProduct[find(repOrd[mapped])]) unite(r, repOrd[mapped]);
    }
  }
  // Topologie partagée (faces, arêtes, coques…) entre représentations de
  // classes différentes → même unité. Parcours des fermetures par classe.
  const stack = [];
  {
    const owner = new Int32Array(n).fill(-1), seen = new Int32Array(n);
    let tag = 0;
    const byClass = new Map();
    for(let r = 0; r < R; r++) if(repSeeds[r].length){ const c = find(r); if(!byClass.has(c)) byClass.set(c, []); byClass.get(c).push(r); }
    for(const [c, rs] of byClass){
      tag++;
      for(const r of rs) for(const s of repSeeds[r]) stack.push(s);
      while(stack.length){
        const e = stack.pop();
        if(e < 0 || seen[e] === tag) continue;
        seen[e] = tag;
        if(anyPart(e, cTopo)){
          if(owner[e] < 0) owner[e] = c; else if(find(owner[e]) !== find(c)) unite(owner[e], c);
        }
        for(let k = eRef0[e]; k < eRef0[e + 1]; k++){ const t = rTo[k]; if(t >= 0 && seen[t] !== tag) stack.push(t); }
      }
    }
  }
  const unitOfClass = new Map(), units = [];               // unité = classe portant ≥ 1 graine
  for(let r = 0; r < R; r++){
    if(!repSeeds[r].length) continue;
    const c = find(r);
    let u = unitOfClass.get(c);
    if(u === undefined){ u = units.length; unitOfClass.set(c, u); units.push({ reps: [], seeds: [], bytes: 0, first: reps[r] }); }
    units[u].reps.push(r); for(const s of repSeeds[r]) units[u].seeds.push(s);
  }
  if(!units.length) throw new Error('No SHAPE_REPRESENTATION with geometry found — non-standard file?');
  // Produit de chaque unité : porté par N'IMPORTE quelle représentation de sa
  // classe — souvent la SHAPE_REPRESENTATION sans géométrie, reliée par SRR à
  // l'ADVANCED_BREP_… qui porte les solides (SolidWorks, Inventor, Creo…).
  const classPD = new Int32Array(R).fill(-1);
  for(let r = 0; r < R; r++) if(repProduct[r] >= 0 && classPD[find(r)] < 0) classPD[find(r)] = repProduct[r];
  const seedUnit = new Int32Array(n).fill(-1);
  units.forEach((U, u) => {
    U.pd = classPD[find(U.reps[0])];
    const seen = new Set(), uniq = [];
    for(const s of U.seeds) if(!seen.has(s)){ seen.add(s); uniq.push(s); }
    U.seeds = uniq;
    for(const s of uniq) seedUnit[s] = u;
    // Découpable entre graines : une seule représentation, rien que des solides.
    // Le lecteur sort alors un maillage par solide, qu'ils soient lus ensemble
    // ou non. Des faces, coques ou courbes en items, ou plusieurs représentations
    // (MAPPED_ITEM, SHAPE_ASPECT…), changeraient le résultat si on les séparait.
    U.splittable = U.reps.length === 1 && uniq.length >= 4 && uniq.every(s => anyPart(s, cSolid));
  });
  const repUnit = new Int32Array(R).fill(-1);
  units.forEach((U, ui) => { for(const r of U.reps) repUnit[r] = ui; });

  // ── 6. Fermetures géométriques : taille des unités, propriétaire, boîte de chaque représentation ──
  const gcOwner = new Int32Array(n);              // 0 = hors géométrie, u+1 = une unité, -1 = partagée
  const stampU = new Int32Array(n), stampR = new Int32Array(n);
  const repBox = new Array(R).fill(null);
  const addPt = (bx, x, y, z) => {
    if(!(isFinite(x) && isFinite(y) && isFinite(z))) return;
    if(x < bx[0]) bx[0] = x; if(y < bx[1]) bx[1] = y; if(z < bx[2]) bx[2] = z;
    if(x > bx[3]) bx[3] = x; if(y > bx[4]) bx[4] = y; if(z > bx[5]) bx[5] = z;
  };
  const pointXYZ = e => { if(e < 0 || eType[e] !== cPoint) return null; const v = numbersOf(e); return v.length >= 3 ? v : null; };
  for(let u = 0; u < units.length; u++){
    const U = units[u], tagU = u + 1; let bytes = 0;
    for(const r of U.reps){
      const tagR = r + 1, bx = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for(const s of repSeeds[r]) stack.push(s);
      while(stack.length){
        const e = stack.pop();
        if(e < 0 || stampR[e] === tagR) continue;
        stampR[e] = tagR;
        if(stampU[e] !== tagU){
          stampU[e] = tagU; bytes += eEnd[e] - eRec[e] + 1;
          gcOwner[e] = gcOwner[e] === 0 ? tagU : (gcOwner[e] === tagU ? tagU : -1);
        }
        if(anyPart(e, cBoxP)){
          for(let k = eRef0[e]; k < eRef0[e + 1]; k++){ const p = pointXYZ(rTo[k]); if(p) addPt(bx, p[0], p[1], p[2]); }
        }
        for(let k = eRef0[e]; k < eRef0[e + 1]; k++){ const t = rTo[k]; if(t >= 0 && stampR[t] !== tagR) stack.push(t); }
      }
      if(bx[0] <= bx[3]) repBox[r] = bx;
    }
    U.bytes = bytes;
  }

  // ── 7. Squelette : fermeture de la structure, graines coupées ──
  const inSK = new Uint8Array(n);
  const cutTag = new Int32Array(n);
  for(let e = 0; e < n; e++){
    if(repOrd[e] >= 0 || anyPart(e, cSK)) stack.push(e);
  }
  let skBytes = 0; const skList = [];
  while(stack.length){
    const e = stack.pop();
    if(e < 0 || inSK[e]) continue;
    inSK[e] = 1; skBytes += eEnd[e] - eRec[e] + 1; skList.push(e);
    const r = repOrd[e];
    if(r >= 0) for(const s of repSeeds[r]) cutTag[s] = e + 1;
    for(let k = eRef0[e]; k < eRef0[e + 1]; k++){
      const t = rTo[k];
      if(t < 0 || inSK[t]) continue;
      if(r >= 0 && cutTag[t] === e + 1) continue;             // graine de CETTE représentation : pas dans le squelette
      stack.push(t);
    }
  }
  skList.sort((a, b) => a - b);

  // ── 8. Annexes (ni squelette ni géométrie) : racines = entités jamais référencées ──
  const indeg = new Int32Array(n);
  for(let k = 0; k < nr; k++){ const t = rTo[k]; if(t >= 0) indeg[t]++; }
  const otherTop = [];
  for(let e = 0; e < n; e++) if(!inSK[e] && gcOwner[e] === 0 && indeg[e] === 0) otherTop.push(e);

  // ── 9. Plan : quelles graines dans quelle tranche ──
  // Une unité découpable (cf. plus haut) qui dépasse 1,5 × la taille visée est
  // répartie PAR SOLIDES, au moins deux par morceau : une pièce multi-solide
  // est lue comme un composé (un maillage par solide, sans nom propre) ; un
  // solide SEUL prendrait le nom et la couleur de la pièce — mesuré sur
  // Scania-8x4, d'où cette règle. Répartition LPT : le plus gros morceau
  // d'abord, dans la tranche la moins chargée.
  const total = units.reduce((s, u) => s + u.bytes, 0);
  const capBytes = Math.max(maxChunkBytes - skBytes, maxChunkBytes / 2, opts.floorBytes != null ? opts.floorBytes : 256 * 1024);
  const splitAbove = opts.splitAbove != null ? opts.splitAbove : capBytes * 1.5;
  const items = [];
  let sTag = 0;
  const stampS = new Int32Array(n);
  const seedBytes = s => {                       // fermeture d'une seule graine
    const tag = ++sTag; let b = 0;
    stack.push(s);
    while(stack.length){
      const e = stack.pop();
      if(e < 0 || stampS[e] === tag) continue;
      stampS[e] = tag; b += eEnd[e] - eRec[e] + 1;
      for(let k = eRef0[e]; k < eRef0[e + 1]; k++){ const t = rTo[k]; if(t >= 0 && stampS[t] !== tag) stack.push(t); }
    }
    return b;
  };
  units.forEach(U => {
    if(U.bytes <= splitAbove || !U.splittable || opts.noSeedSplit){ items.push({ seeds: U.seeds, bytes: U.bytes, first: U.first }); return; }
    const groups = [];
    let cur = [], curB = 0;
    for(const s of U.seeds){
      const b = seedBytes(s);
      if(cur.length >= 2 && curB + b > capBytes){ groups.push({ seeds: cur, bytes: curB }); cur = []; curB = 0; }
      cur.push(s); curB += b;
    }
    if(cur.length){
      const g = groups.length ? groups[groups.length - 1] : null;
      if(cur.length < 2 && g && g.seeds.length >= 3){          // un solide du morceau précédent lui tient compagnie
        const s = g.seeds.pop(), b = seedBytes(s); g.bytes -= b; cur.unshift(s); curB += b;
        groups.push({ seeds: cur, bytes: curB });
      } else if(cur.length < 2 && g){ g.seeds.push(...cur); g.bytes += curB; }
      else groups.push({ seeds: cur, bytes: curB });
    }
    for(const g of groups) items.push({ seeds: g.seeds, bytes: g.bytes, first: g.seeds[0] });
  });
  const itemsTotal = items.reduce((s, it) => s + it.bytes, 0);
  let K = Math.max(1, Math.ceil(itemsTotal / capBytes));
  if(opts.maxChunks) K = Math.min(K, opts.maxChunks);
  K = Math.min(K, items.length);
  const bins = Array.from({ length: K }, () => ({ items: [], bytes: 0 }));
  const order = items.map((it, j) => j).sort((a, b) => items[b].bytes - items[a].bytes || items[a].first - items[b].first);
  for(const j of order){
    let best = 0; for(let b = 1; b < K; b++) if(bins[b].bytes < bins[best].bytes) best = b;
    bins[best].items.push(j); bins[best].bytes += items[j].bytes;
  }
  const binsUsed = bins.filter(b => b.items.length);

  // ── 10. Réécriture d'un corps : filtre des références dans les agrégats ──
  // decide(cible, estAgrégat) → null (retirer), true (garder) ou une chaîne (remplacer).
  function rewrite(e, decide){
    const s = text, end = eEnd[e] - 1;
    const complex = eType[e] < 0, base = complex ? 2 : 1;
    let k = eBody[e];
    const skipWs = () => { for(;;){ const q = s.charCodeAt(k); if(isWs(q)){ k++; continue; } if(q === 47 && s.charCodeAt(k + 1) === 42){ k = skipComment(k); continue; } return; } };
    function list(depth){                     // s[k] === '('
      k++; const parts = [];
      for(;;){
        skipWs();
        if(k >= end) break;
        const q = s.charCodeAt(k);
        if(q === 41){ k++; break; }
        if(q === 44){ k++; continue; }
        let el;
        if(q === 40) el = list(depth + 1);
        else if(q === 35){
          let m = k + 1, v = 0; while(m < end && isDigit(s.charCodeAt(m))){ v = v * 10 + (s.charCodeAt(m) - 48); m++; }
          const t = ixOf(v);
          const d = t >= 0 ? decide(t, depth > base) : true;
          el = d === null ? null : (d === true ? s.slice(k, m) : d);
          k = m;
        } else if(q === 39 || q === 34){
          const x = s.indexOf(q === 39 ? "'" : '"', k + 1); const m = x < 0 ? end : x + 1;
          el = s.slice(k, m); k = m;
          while(q === 39 && s.charCodeAt(k) === 39){ const y = s.indexOf("'", k + 1); const m2 = y < 0 ? end : y + 1; el += s.slice(k, m2); k = m2; }
        } else if(isKw(q) && !isDigit(q)){
          let m = k; while(m < end && isKw(s.charCodeAt(m))) m++;
          const kw = s.slice(k, m); k = m; skipWs();
          el = s.charCodeAt(k) === 40 ? kw + list(depth + 1) : kw;
        } else {
          let m = k;
          while(m < end){ const c = s.charCodeAt(m); if(c === 44 || c === 41 || (c === 47 && s.charCodeAt(m + 1) === 42)) break; m++; }
          el = s.slice(k, m).trim(); k = m;
        }
        if(el !== null) parts.push(el);
      }
      // Les partiels d'une entité complexe se suivent SANS virgule : (A(…) B(…))
      return '(' + parts.join(complex && depth === 1 ? ' ' : ',') + ')';
    }
    skipWs();
    let head = '';
    if(!complex){ let m = k; while(m < end && isKw(s.charCodeAt(m))) m++; head = s.slice(k, m); k = m; skipWs(); }
    return '#' + eId[e] + '=' + head + list(1) + ';';
  }

  // ── 11. Émission d'une tranche (à la demande) ──
  const mk = new Int32Array(n);            // mk[e] === stamp ⇔ e dans la tranche
  const seedSel = new Int32Array(n);       // seedSel[s] === stamp ⇔ graine retenue
  const mState = new Int32Array(n), mVal = new Uint8Array(n);   // mémo de disponibilité des annexes
  let stamp = 0;
  const PH_P = maxId + 1, PH_A = maxId + 2;   // placement neutre pour une liste d'items vidée sans boîte connue
  const real = v => { const x = v.toExponential(15).replace('e', 'E'); return x.indexOf('.') < 0 ? x.replace('E', '.E') : x; };
  const markClosure = root => {
    stack.push(root);
    while(stack.length){
      const e = stack.pop();
      if(e < 0 || mk[e] === stamp) continue;
      mk[e] = stamp;
      for(let k = eRef0[e]; k < eRef0[e + 1]; k++){ const t = rTo[k]; if(t >= 0 && mk[t] !== stamp) stack.push(t); }
    }
  };
  // disponibilité d'une cible dans la tranche courante
  function avail(t){
    if(inSK[t]) return true;
    if(gcOwner[t] !== 0) return mk[t] === stamp || isPassive(t);
    return availOther(t);
  }
  const listTot = new Uint16Array(256), listOk = new Uint16Array(256);
  function availOther(root){            // DFS itératif, mémo par tranche ; cycle = disponible
    if(mState[root] === stamp * 2) return mVal[root] === 1;
    const st = [root];
    while(st.length){
      const x = st[st.length - 1];
      if(mState[x] === stamp * 2){ st.pop(); continue; }
      if(mState[x] !== stamp * 2 - 1){                      // première visite : empiler les annexes non évaluées
        mState[x] = stamp * 2 - 1;
        for(let k = eRef0[x]; k < eRef0[x + 1]; k++){
          const t = rTo[k];
          if(t < 0 || inSK[t] || gcOwner[t] !== 0) continue;
          if(mState[t] !== stamp * 2 && mState[t] !== stamp * 2 - 1) st.push(t);
        }
        continue;
      }
      // enfants évalués : scalaires tous disponibles, chaque liste garde au moins un élément
      let ok = true; const touched = [];
      for(let k = eRef0[x]; k < eRef0[x + 1]; k++){
        const t = rTo[k]; if(t < 0) continue;
        const a = inSK[t] ? true : (gcOwner[t] !== 0 ? (mk[t] === stamp || isPassive(t)) : (mState[t] === stamp * 2 ? mVal[t] === 1 : true));
        const L = rList[k];
        if(L){ if(!listTot[L]) touched.push(L); listTot[L]++; if(a) listOk[L]++; }
        else if(!a){ ok = false; break; }
      }
      for(const L of touched){ if(ok && !listOk[L]) ok = false; listTot[L] = 0; listOk[L] = 0; }
      mState[x] = stamp * 2; mVal[x] = ok ? 1 : 0;
      st.pop();
    }
    return mVal[root] === 1;
  }
  const rewritten = new Map();
  function includeOther(root){
    const st = [root];
    while(st.length){
      const x = st.pop();
      if(mk[x] === stamp) continue;
      mk[x] = stamp;
      let drop = false;
      for(let k = eRef0[x]; k < eRef0[x + 1]; k++){
        const t = rTo[k]; if(t < 0) continue;
        if(rList[k] && !avail(t)){ drop = true; continue; }
        if(mk[t] === stamp) continue;
        if(inSK[t]) continue;
        if(gcOwner[t] !== 0) markClosure(t);              // cible passive (placement, point…) : incluse avec sa fermeture
        else st.push(t);
      }
      if(drop) rewritten.set(x, rewrite(x, (t, agg) => (agg && !avail(t)) ? null : true));
    }
  }
  function emitSeeds(seeds){
    stamp++;
    rewritten.clear();
    for(const s of seeds) seedSel[s] = stamp;
    for(const e of skList) mk[e] = stamp;
    for(const s of seeds) markClosure(s);
    const extra = [];
    let nextId = maxId + 3, needPH = false, proxies = 0;
    for(let r = 0; r < R; r++){
      const sd = repSeeds[r];
      if(!sd.length) continue;
      let nSel = 0; for(const s of sd) if(seedSel[s] === stamp) nSel++;
      if(nSel === sd.length) continue;                          // toute la géométrie de cette représentation est ici : intacte
      let first = true, repl = null;
      if(nSel === 0 && repBox[r]){
        // Pièce lue ailleurs : ses 8 coins, pour que la racine garde sa vraie
        // taille (même finesse de maillage que dans un import entier).
        const b = repBox[r], ids = [];
        for(let c = 0; c < 8; c++){
          const id = nextId++;
          extra.push(`#${id}=CARTESIAN_POINT('',(${real(c & 1 ? b[3] : b[0])},${real(c & 2 ? b[4] : b[1])},${real(c & 4 ? b[5] : b[2])}));`);
          ids.push('#' + id);
        }
        const gid = nextId++;
        extra.push(`#${gid}=GEOMETRIC_SET('',(${ids.join(',')}));`);
        repl = '#' + gid; proxies++;
      } else if(nSel === 0 && sd.length >= repItemsN[r]){
        repl = '#' + PH_A; needPH = true;                       // plus aucun item et pas de boîte : un placement neutre
      }
      rewritten.set(reps[r], rewrite(reps[r], t => {
        if(!isSeed[t] || seedSel[t] === stamp) return true;
        if(repl && first){ first = false; return repl; }
        return null;
      }));
    }
    for(const t of otherTop) if(avail(t)) includeOther(t);
    const out = [headerBlock];
    for(let e = 0; e < n; e++){
      if(mk[e] !== stamp) continue;
      const w = rewritten.get(e);
      out.push(w !== undefined ? w : text.slice(eRec[e], eEnd[e]));
    }
    if(needPH) out.push(`#${PH_P}=CARTESIAN_POINT('',(0.,0.,0.));`, `#${PH_A}=AXIS2_PLACEMENT_3D('',#${PH_P},$,$);`);
    for(const x of extra) out.push(x);
    out.push('ENDSEC;', 'END-ISO-10303-21;', '');
    rewritten.clear();
    emitSeeds.lastProxies = proxies;
    return out.join('\n');
  }

  // Nom lisible d'une unité (journal) : PRODUCT.name de sa pièce, sinon le nom de la représentation.
  function strParam(e, want){
    const b = eBody[e], end = eEnd[e] - 1, base = eType[e] < 0 ? 2 : 1;
    let depth = 0, p = 0;
    for(let k = b; k < end; k++){
      const q = text.charCodeAt(k);
      if(q === 39){
        let m = k + 1, s = '';
        for(;;){ const x = text.indexOf("'", m); if(x < 0) return null; s += text.slice(m, x); if(text.charCodeAt(x + 1) === 39){ s += "'"; m = x + 2; continue; } k = x; break; }
        if(depth === base && p === want) return s;
        continue;
      }
      if(q === 40) depth++; else if(q === 41) depth--; else if(q === 44 && depth === base) p++;
    }
    return null;
  }
  function unitLabel(u){
    const U = units[u];
    const pd = U.pd;
    if(pd >= 0){
      const pdf = refs(pd)[0], prod = pdf >= 0 ? refs(pdf)[0] : -1;
      if(prod >= 0){ const s = strParam(prod, 1) || strParam(prod, 0); if(s) return s; }
    }
    return strParam(reps[U.reps[0]], 0) || ('#' + eId[reps[U.reps[0]]]);
  }
  const plan = binsUsed.map(b => {
    const its = b.items.slice().sort((x, y) => items[x].first - items[y].first);
    const seeds = [], us = new Set();
    for(const j of its) for(const s of items[j].seeds){ seeds.push(s); us.add(seedUnit[s]); }
    return { seeds, units: Array.from(us).sort((x, y) => x - y), bytes: b.bytes };
  });
  const unitsOfSeeds = seeds => { const us = new Set(); for(const s of seeds) us.add(seedUnit[s]); return Array.from(us).sort((x, y) => x - y); };
  const info = { entities: n, reps: R, units: units.length, seeds: items.reduce((s, it) => s + it.seeds.length, 0),
    skeletonBytes: skBytes, geometryBytes: total, annexRoots: otherTop.length,
    boxes: repBox.filter(Boolean).length,
    chunks: plan.map(p => ({ units: p.units.length, seeds: p.seeds.length, geoBytes: p.bytes })) };
  if(opts.debug) info.debug = { nameOf, units, reps, repSeeds, repBox, gcOwner, inSK, eId, repProduct, refs, idOf: e => eId[e] };
  return { info, plan, emitSeeds, unitLabel, unitsOfSeeds,
    seedUnit: s => seedUnit[s], unitSplittable: u => !!units[u].splittable, unitSeeds: u => units[u].seeds,
    release(){ text = null; } };
}

// [29/09] Ancien découpeur du Turbo — n'est PLUS appelé par l'import (cf.
// stepSliceAssembly juste au-dessus et _stepTurboImportRead). Gardé pour la
// console ⚡ Script : ses tranches ne portent pas la structure d'assemblage
// (instances doublées ou déplacées), à ne pas réutiliser pour importer.
function stepSliceBySize(text, maxChunkBytes) {
  const dataIdx = text.indexOf('\nDATA;');
  if (dataIdx === -1) throw new Error('DATA section not found — invalid STEP file?');
  const headerBlock = text.slice(0, dataIdx).trimEnd();
  const afterData = text.slice(dataIdx + 1);
  const endIdx = afterData.search(/ENDSEC;\s*END-ISO-10303-21;/);
  const dataBody = endIdx === -1 ? afterData.slice(afterData.indexOf(';') + 1) : afterData.slice(afterData.indexOf(';') + 1, endIdx);

  const entities = new Map();
  {
    let i = 0;
    const n = dataBody.length;
    while (i < n) {
      while (i < n && /\s/.test(dataBody[i])) i++;
      if (i < n && dataBody[i] === '/' && dataBody[i + 1] === '*') {
        const end = dataBody.indexOf('*/', i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }
      if (i >= n) break;
      if (dataBody[i] !== '#') { i++; continue; }
      let j = i + 1;
      while (j < n && dataBody[j] >= '0' && dataBody[j] <= '9') j++;
      const id = parseInt(dataBody.slice(i + 1, j), 10);
      while (j < n && /[\s=]/.test(dataBody[j])) j++;
      let depth = 0, inStr = false, k = j;
      for (; k < n; k++) {
        const c = dataBody[k];
        if (inStr) { if (c === "'") inStr = false; continue; }
        if (c === "'") { inStr = true; continue; }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ';' && depth <= 0) break;
      }
      entities.set(id, dataBody.slice(j, k));
      i = k + 1;
    }
  }

  const refRe = /#(\d+)/g;
  const forward = new Map();
  const reverse = new Map();
  for (const [id, txt] of entities) {
    const refs = new Set();
    let m;
    refRe.lastIndex = 0;
    while ((m = refRe.exec(txt))) {
      const rid = parseInt(m[1], 10);
      if (rid !== id) refs.add(rid);
    }
    forward.set(id, refs);
    for (const rid of refs) {
      if (!reverse.has(rid)) reverse.set(rid, new Set());
      reverse.get(rid).add(id);
    }
  }

  function entityType(id) {
    const txt = entities.get(id);
    if (!txt) return null;
    const m = txt.match(/^([A-Z0-9_]+)\s*\(/);
    return m ? m[1] : null;
  }

  function closure(rootIds) {
    const seen = new Set();
    const stack = Array.isArray(rootIds) ? rootIds.slice() : [rootIds];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || !entities.has(id)) continue;
      seen.add(id);
      for (const rid of forward.get(id) || []) if (!seen.has(rid)) stack.push(rid);
    }
    return seen;
  }

  const GEOM_LEAF_TYPES = new Set([
    'ADVANCED_FACE', 'MANIFOLD_SOLID_BREP', 'FACETED_BREP', 'BREP_WITH_VOIDS',
    'CLOSED_SHELL', 'COMPLEX_TRIANGULATED_FACE', 'TRIANGULATED_FACE', 'OPEN_SHELL'
  ]);
  const shapeRepCandidates = [];
  for (const [id] of entities) {
    const t = entityType(id);
    if (t && (t === 'SHAPE_REPRESENTATION' || t.endsWith('_SHAPE_REPRESENTATION'))) {
      shapeRepCandidates.push(id);
    }
  }
  const leafRoots = [];
  for (const id of shapeRepCandidates) {
    const clos = closure([id]);
    let hasGeom = false;
    for (const cid of clos) { if (GEOM_LEAF_TYPES.has(entityType(cid))) { hasGeom = true; break; } }
    if (hasGeom) leafRoots.push(id);
  }
  if (!leafRoots.length) throw new Error('No SHAPE_REPRESENTATION with geometry found — non-standard file?');
  const leafRootsSet = new Set(leafRoots);

  // [FIX V4.2.7p4 21/06 quater] Réécrit et validé sur un VRAI fichier STEP/AP214
  // (Stealthburner_CW2_Assembly.step, 26.7MB, 88 produits) — les tentatives précédentes
  // n'avaient été validées QUE sur un fichier de test NIST, structure plus simple. Trois
  // bugs réels trouvés et corrigés sur les vraies données :
  //  1. SHAPE_DEFINITION_REPRESENTATION référence sa shape_representation directement —
  //     l'inclure globalement sans la géométrie associée crée des références pendantes.
  //  2. Entités complexes sans type nommé (contextes d'unités, ex: "(GEOMETRIC_
  //     REPRESENTATION_CONTEXT(...)...)") peuvent être des singletons FILE-WIDE (l'unité
  //     "millimètre" était référencée 178 fois) — invisibles à un filtre par nom de type.
  //  3. Les entités STYLE/COULEUR (STYLED_ITEM etc.) référencent la géométrie BRUTE
  //     directement (pas sa shape_representation englobante) — un style partagé entre
  //     plusieurs pièces fait pont direct vers leur géométrie complète.
  // Stratégie retenue : critère de FANOUT (nb de référents, pas le nom du type) pour
  // geler les hubs partagés — mesuré empiriquement : hubs réels fanout 88-178, chaînons
  // privés à une pièce fanout 1-quelques unités. Famille STYLE exclue entièrement (non
  // essentielle à la géométrie, palette de secours COL[] déjà présente dans NASSCAD).
  // Limite connue acceptée : à seuil de chunk agressif, un peu de chevauchement entre
  // chunks reste possible (même pièce comptée dans 2 chunks) — dédupliqué après import
  // par position (cf. _dedupOverlappingObjects, appelé par le dispatcher importSTEP).
  const STYLE_TYPES = new Set([
    'STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM', 'PRESENTATION_STYLE_ASSIGNMENT',
    'PRESENTATION_STYLE_BY_CONTEXT', 'SURFACE_STYLE_USAGE', 'SURFACE_SIDE_STYLE',
    'SURFACE_STYLE_FILL_AREA', 'SURFACE_STYLE_BOUNDARY', 'SURFACE_STYLE_PARAMETER_LINE',
    'FILL_AREA_STYLE', 'FILL_AREA_STYLE_COLOUR', 'COLOUR_RGB', 'COLOUR_SPECIFICATION',
    'CURVE_STYLE', 'CURVE_STYLE_FONT', 'MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION',
    'PRESENTATION_LAYER_ASSIGNMENT', 'DRAUGHTING_PRE_DEFINED_COLOUR'
  ]);
  const ROOT_TYPES = new Set(['PRODUCT_DEFINITION', 'PRODUCT', 'PRODUCT_DEFINITION_FORMATION', 'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE']);
  const FANOUT_FREEZE_THRESHOLD = 80; // validé empiriquement : restaure 198/198 mesh sur le fichier réel (vs hubs à 88-178)
  function isOtherGeomLeaf(id, selfRoot){ return id !== selfRoot && leafRootsSet.has(id); }
  function fanoutOf(id){ return (reverse.get(id)||[]).size + (forward.get(id)||[]).size; }

  function chainFor(rootId) {
    const found = new Set([rootId]);
    let frontier = [rootId];
    const MAX_HOPS = 12;
    for (let hop = 0; hop < MAX_HOPS && frontier.length; hop++) {
      const next = [];
      for (const id of frontier) {
        const t = entityType(id);
        const isRoot = ROOT_TYPES.has(t);
        const isHighFanout = (id !== rootId) && fanoutOf(id) > FANOUT_FREEZE_THRESHOLD;
        const exploreForward = (id === rootId) || !isHighFanout;
        const exploreReverse = (id === rootId) || (!isHighFanout && !isRoot);
        const candidates = [];
        if (exploreForward) for (const rid of forward.get(id) || []) candidates.push(rid);
        if (exploreReverse) for (const rid of reverse.get(id) || []) candidates.push(rid);
        for (const rid of candidates) {
          if (found.has(rid)) continue;
          if (isOtherGeomLeaf(rid, rootId)) continue;
          found.add(rid);
          // [FIX couleur réactivée] Un noeud STYLE (STYLED_ITEM/COLOUR_RGB/...) atteint
          // DIRECTEMENT depuis la géométrie de cette pièce est conservé — sa couleur sera
          // résolue par le closure() forward pur appelé plus bas (qui ramène automatiquement
          // COLOUR_RGB/PRESENTATION_STYLE_* sans jamais remonter vers une autre pièce, car
          // closure() ne suit QUE les refs sortantes). Ce qu'on NE fait PAS : continuer le
          // BFS bidirectionnel depuis ce noeud (pas de push dans `next`) — un contexte de
          // présentation partagé (MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION
          // etc., fanout potentiellement file-wide, même famille que l'unité "millimètre" à
          // 178 réfs) resterait sinon un PONT vers les ADVANCED_FACE d'autres pièces — non
          // filtrées par isOtherGeomLeaf, qui ne connaît que les racines SHAPE_REPRESENTATION,
          // pas les faces individuelles. Gelé comme une feuille : couleur présente, pas de
          // fuite vers le reste du fichier.
          if (STYLE_TYPES.has(entityType(rid))) continue;
          next.push(rid);
        }
      }
      frontier = next;
    }
    return found;
  }

  const pieceClosures = leafRoots.map(rootId => {
    const chainIds = chainFor(rootId);
    return closure([rootId, ...chainIds]);
  });

  const chunks = [];
  let curIds = new Set();
  let curBytes = headerBlock.length + 60;

  function flushChunk() {
    if (curIds.size === 0) return;
    const ids = Array.from(curIds).sort((a, b) => a - b);
    const lines = ids.map(id => `#${id}=${entities.get(id)};`);
    const out = headerBlock + '\nDATA;\n' + lines.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
    chunks.push(out);
    curIds = new Set();
    curBytes = headerBlock.length + 60;
  }

  for (const pieceIds of pieceClosures) {
    let addedBytes = 0;
    for (const id of pieceIds) {
      if (curIds.has(id)) continue;
      addedBytes += entities.get(id).length + 12;
    }
    if (curIds.size > 0 && curBytes + addedBytes > maxChunkBytes) flushChunk();
    for (const id of pieceIds) curIds.add(id);
    curBytes += addedBytes;
  }
  flushChunk();

  return chunks; // array de strings — chacune un STEP complet et valide
}

// [NEW V4.2.7p4 21/06] Dispatcher public — décide slice ou import direct. Remplace
// l'ancien point d'entrée ; _importSTEPSingle (juste en dessous, corps INCHANGÉ) reste
// le chemin réel d'import, appelé une fois par chunk si découpage, une fois sinon.
// ══ ADAPTIVE THRESHOLDS — Détection auto RAM/CPU ══
function _computeAdaptiveSTEPThresholds() {
  const cores = navigator.hardwareConcurrency || 4;
  const deviceMemGB = navigator.deviceMemory || 8;
  
  let heapLimit = 536870912;
  try {
    if (performance.memory?.jsHeapSizeLimit) {
      heapLimit = performance.memory.jsHeapSizeLimit;
    }
  } catch (e) { /* performance.memory inaccessible (Firefox/Safari) → heapLimit reste à 512 MB. NB: deviceBudget (deviceMemory) domine souvent ce min — c'est ici que se règle le budget chunks STEP. */ }
  
  const heapBudget = Math.max(heapLimit * 0.30, 50 * 1024 * 1024);
  const deviceBudget = Math.max(deviceMemGB * 100 * 1024 * 1024 * 0.10, 50 * 1024 * 1024);
  const totalBudget = Math.min(heapBudget, deviceBudget);
  
  const threshold = Math.max(40 * 1024 * 1024, totalBudget * 0.55);
  const chunkSize = Math.max(45 * 1024 * 1024, totalBudget * 0.40);
  const workerPoolSize = (cores >= 8 && deviceMemGB >= 16) ? 2 : 1;
  const watchdogBase = 25 * 60 * 1000;
  
  const result = {
    threshold,
    chunkSize,
    workerPoolSize,
    watchdogBase,
    cores,
    deviceMemGB,
    heapLimitMB: Math.round(heapLimit / 1024 / 1024),
    diagnostics: `CPU ${cores}c, RAM ${deviceMemGB}GB, heap ${Math.round(heapLimit / 1024 / 1024)}MB, ` +
                 `workers ×${workerPoolSize}, threshold ${Math.round(threshold / 1024 / 1024)}MB, ` +
                 `chunks ${Math.round(chunkSize / 1024 / 1024)}MB`
  };
  
  return result;
}

const _STEP_PERF = _computeAdaptiveSTEPThresholds();
const _STEP_SLICE_THRESHOLD = Math.max(80 * 1024 * 1024, _STEP_PERF.threshold);
const _STEP_SLICE_CHUNK = Math.max(70 * 1024 * 1024, _STEP_PERF.chunkSize);
const _STEP_WORKER_POOL_SIZE = _STEP_PERF.workerPoolSize;
const _STEP_WORKER_WATCHDOG_BASE = Math.max(90 * 60 * 1000, _STEP_PERF.watchdogBase);

// Délai le log TURBO après initialisation IDB (TDZ fix)
// Le log se fera dans _initIdb() une fois que _idbReady = true
if (typeof window !== 'undefined') {
  window._STEP_PERF = _STEP_PERF;  // Store for delayed logging
  window._STEP_PERF_READY = true;  // Signal pour initIdb() de loguer
}
// [NEW V4.2.7p4 21/06] Dédoublonnage par position — filet de sécurité pour le slicer
// STEP. Le découpage par graphe d'entités (chainFor, ci-dessus) peut, à seuil de chunk
// agressif, inclure la même pièce dans 2 chunks différents (chevauchement de contexte
// partagé) — accepté comme compromis plutôt que de chasser un seuil "parfait" sans
// garantie théorique sur la sémantique exacte de l'exportateur. Les éventuels doublons
// sont des copies à l'identique (mêmes entités STEP sources) → même bbox/position à la
// tolérance de flottants près. Comparaison géométrique, terrain où on a une vraie prise,
// plutôt que de continuer à deviner la sémantique d'export STEP à l'aveugle.
// [29/09] Plus appelée : le Turbo lit chaque instance une seule fois (cf.
// stepSliceAssembly), il n'y a plus de doublon à deviner — et ce filtre
// retirait aussi deux pièces réellement superposées dans le modèle.
function _dedupOverlappingObjects(newObjs, epsMm = 0.1){
  // [TUNED] 0.1mm validé empiriquement sur données réelles : reproduit EXACTEMENT le
  // même résultat que si on appliquait ce dédup au fichier complet importé en un seul
  // appel (195/198 dans les deux cas — 2 paires de pièces du fichier original sont déjà
  // naturellement à moins de 0.5mm l'une de l'autre, pas un artefact du découpage). Plus
  // serré (0.01mm) sous-dédoublonne : la tessellation OCCT n'est pas bit-exact identique
  // entre deux appels séparés sur des chunks différents (ordre flottant légèrement
  // différent), donc les vrais doublons inter-chunks ne sont pas à 0.0mm près.
  const kept = [];
  let removed = 0;
  for (const o of newObjs){
    o.mesh.geometry.computeBoundingBox();
    const bb = o.mesh.geometry.boundingBox;
    const c = new THREE.Vector3(); bb.getCenter(c); c.add(o.mesh.position);
    const s = new THREE.Vector3(); bb.getSize(s);
    let isDup = false;
    for (const k of kept){
      if (Math.abs(c.x-k.c.x)<epsMm && Math.abs(c.y-k.c.y)<epsMm && Math.abs(c.z-k.c.z)<epsMm &&
          Math.abs(s.x-k.s.x)<epsMm && Math.abs(s.y-k.s.y)<epsMm && Math.abs(s.z-k.s.z)<epsMm){
        isDup = true; break;
      }
    }
    if (isDup){
      scene.remove(o.mesh);
      o.mesh.geometry.dispose();
      o.mesh.material.dispose();
      _csgTree.delete(o.id);
      _bboxCache.delete(o.mesh);
      objs = objs.filter(x=>x!==o);
      removed++;
    } else {
      kept.push({c, s});
    }
  }
  return removed;
}

// ══ SMART HYBRID CHUNKING — Composants + taille équilibrée ══
// [28/09 — audit] Cette fonction était une copie ANCIENNE de stepSliceBySize
// (même algorithme, sans le type racine PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE
// ajouté depuis dans l'original). Elle n'a jamais produit une seule tranche :
// l'identifiant d'entité y était lu avec son '#' (parseInt('#12') = NaN), toutes
// les entités tombaient sous la même clé et elle levait à chaque appel « No
// SHAPE_REPRESENTATION with geometry ». STEP Turbo relisait donc le fichier
// entier DEUX fois (ici pour rien, puis dans stepSliceBySize) et journalisait un
// WARN à chaque gros import. Alias vers la version maintenue, pour ne casser
// aucun appel éventuel depuis la console ⚡ Script.
function stepSliceByComponentsAndSize(text, maxChunkBytes) {
  return stepSliceBySize(text, maxChunkBytes);
}

// ═══ STEP OmniReader — normalisation universelle des conteneurs STEP ════════
// [NEW V4.4.0 03/07] Défi : avaler TOUT ce que l'écosystème STEP produit.
// - .stp/.step/.p21 : Part 21 brut (ISO 10303-21). AP203/AP214/AP242 : même syntaxe
//   Part 21, seul le schéma déclaré dans FILE_SCHEMA change — OCCT lit les trois
//   nativement, aucun travail requis côté géométrie, juste l'identification (badge AP).
// - .stpz : STEP compressé. DEUX conventions coexistent dans la nature : gzip pur
//   (ST-Developer/Express Data Manager) et archive ZIP contenant le .stp (certains PLM).
//   Les deux sont gérées.
// - .stpx/.stpxml : STEP-XML (ISO 10303-28). Cas particulier — voir _stepNormalizeFile.
// Principe cardinal : sniffing par MAGIC BYTES, jamais par extension. Un .stp qui est
// en réalité un gzip renommé passe quand même ; un .stpz qui est du Part 21 nu aussi.
// Zéro dépendance : DecompressionStream natif (déjà exploité par import3MF)
// — philosophie monofichier intacte, rien à embarquer.

// Décompression via DecompressionStream natif — 'gzip' ou 'deflate-raw' (entrée ZIP).
async function _stepInflate(u8, format){
  if(typeof DecompressionStream === 'undefined')
    throw new Error('DecompressionStream unavailable — browser too old to decompress (' + format + ')');
  const ds = new DecompressionStream(format);
  const w = ds.writable.getWriter();
  w.write(u8); w.close();
  const r = ds.readable.getReader();
  const chunks = []; let total = 0;
  while(true){ const {done, value} = await r.read(); if(done) break; chunks.push(value); total += value.length; }
  const out = new Uint8Array(total); let pos = 0;
  for(const c of chunks){ out.set(c, pos); pos += c.length; }
  return out;
}

// Liste les entrées d'un ZIP via EOCD + Central Directory (même approche éprouvée que
// le _zipExtract interne d'import3MF — ici en version "list" car on ne connaît PAS le
// nom de l'entrée à l'avance, on doit choisir la plus plausible). ZIP64 non géré
// (usize=0xFFFFFFFF) : un .stpz > 4 GB n'existe pas dans la vraie vie.
function _stepZipList(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  const _min = Math.max(0, u8.length - 65558); // EOCD = 22 octets + commentaire 64 KB max
  for(let i = u8.length - 22; i >= _min; i--){
    if(dv.getUint32(i, true) === 0x06054B50){ eocd = i; break; }
  }
  if(eocd < 0) throw new Error('EOCD not found — invalid or truncated ZIP');
  const cnt = dv.getUint16(eocd + 10, true);
  let pos = dv.getUint32(eocd + 16, true);
  const entries = [];
  for(let e = 0; e < cnt; e++){
    if(dv.getUint32(pos, true) !== 0x02014B50) break;
    const meth  = dv.getUint16(pos + 10, true);
    const csize = dv.getUint32(pos + 20, true);
    const usize = dv.getUint32(pos + 24, true);
    const fnl   = dv.getUint16(pos + 28, true);
    const exl   = dv.getUint16(pos + 30, true);
    const cml   = dv.getUint16(pos + 32, true);
    const lhOff = dv.getUint32(pos + 42, true);
    const name  = new TextDecoder().decode(u8.subarray(pos + 46, pos + 46 + fnl));
    if(!name.endsWith('/')) entries.push({name, meth, csize, usize, lhOff});
    pos += 46 + fnl + exl + cml;
  }
  return entries;
}

// Extrait une entrée ZIP (stored ou deflate) — offset données réel lu dans le Local
// File Header (les champs fnl/exl du LFH peuvent différer de ceux du Central Directory).
async function _stepZipPull(u8, entry){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if(dv.getUint32(entry.lhOff, true) !== 0x04034B50)
    throw new Error('Invalid ZIP local header (offset ' + entry.lhOff + ')');
  const fnl = dv.getUint16(entry.lhOff + 26, true);
  const exl = dv.getUint16(entry.lhOff + 28, true);
  const start = entry.lhOff + 30 + fnl + exl;
  const cdata = u8.subarray(start, start + entry.csize);
  if(entry.meth === 0) return cdata.slice();                       // stored
  if(entry.meth === 8) return _stepInflate(cdata, 'deflate-raw');  // deflate
  throw new Error('Unsupported ZIP compression method: ' + entry.meth + ' (stored/deflate only)');
}

// Taille lisible pour les logs (Ko sous 1 Mo — une petite pièce de 300 octets ne doit
// pas s'afficher "0.0 MB").
function _stepFmtSize(n){
  return n < 1024*1024 ? (n/1024).toFixed(1) + ' KB' : (n/1024/1024).toFixed(1) + ' MB';
}

// Reconstruit un nom de fichier propre après extraction : priorité au nom de l'entrée
// interne du ZIP, sinon nom d'origine débarrassé de son extension conteneur — le nom
// final doit finir en .stp/.step/.p21 pour que le grouping (_stepGroupLabel) et le
// slicer Turbo (chunkName) restent cohérents en aval.
function _stepRebaseName(orig, innerName){
  let cand = innerName ? (innerName.includes('/') ? innerName.split('/').pop() : innerName) : orig;
  cand = cand.replace(/\.(stpz|gz|zip|stpx|stpxml)$/i, '');
  if(!/\.(stp|step|p21)$/i.test(cand)) cand += '.step';
  return cand;
}

// Point d'entrée : File brut → File Part 21 prêt pour le pipeline OCCT existant.
// Fast path : sniff des 4 premiers Ko SEULEMENT — un .stp nu de 300 MB ne doit PAS
// être lu deux fois (ici + pipeline normal). Si aucun conteneur détecté : retour du
// File d'origine tel quel, zéro copie, chemin historique strictement inchangé.
// [11/08] Détection FILE_SCHEMA — suite à ap210.stp (Nass) : un fichier AP210
// (électronique/packaging) partage des entités B-Rep avec AP203/214/242
// (mécanique), donc OCCT peut échouer proprement ("no shape transferred",
// vu en usage réel) SANS jamais dire pourquoi. Ni blocage dur ni silence :
// un WARN explicite en tête de log, diagnostic immédiat plutôt qu'une erreur
// nue à décortiquer après coup. Whitelist par sous-chaîne (pas égalité
// stricte) pour survivre aux variantes d'édition (ex: suffixes AP242
// _MIM_LF, _ED2…). Aligné sur le commentaire d'en-tête de ce fichier :
// "supporte tout STEP AP203/AP214/AP242".
const _STEP_KNOWN_SCHEMAS = ['CONFIG_CONTROL_DESIGN', 'AUTOMOTIVE_DESIGN', 'AP242'];
function _checkStepSchema(headText, fileName){
  const m = headText.match(/FILE_SCHEMA\s*\(\s*\(([^)]*)\)/i);
  if(!m) return; // header tronqué avant FILE_SCHEMA (rare, >4KB de préambule) — OCCT tranchera
  const schemas = _p21StrAll(m[1]);
  if(!schemas.length) return;
  const unknown = schemas.filter(s => !_STEP_KNOWN_SCHEMAS.some(k => s.toUpperCase().includes(k)));
  if(unknown.length)
    nasLog('WARN', 'STEP schema not mechanical (' + unknown.join(', ') + ') in ' + fileName +
      ' — geometry may be present but product structure likely won\'t resolve as expected. OCCT will try anyway.');
}

async function _stepNormalizeFile(file){
  const _h = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  if(_h.length < 4) throw new Error('Empty or truncated file: ' + file.name);
  const _hTxt = new TextDecoder('utf-8').decode(_h);
  const _sniffGzip = _h[0] === 0x1F && _h[1] === 0x8B;
  const _sniffZip  = _h[0] === 0x50 && _h[1] === 0x4B && _h[2] === 0x03 && _h[3] === 0x04;
  const _sniffXml  = /^\uFEFF?\s*<\?xml/i.test(_hTxt) || /<iso[_-]?10303[_-]?28/i.test(_hTxt);
  if(!_sniffGzip && !_sniffZip && !_sniffXml) { _checkStepSchema(_hTxt, file.name); return file; }

  let u8 = new Uint8Array(await file.arrayBuffer());
  const _origSize = u8.length;
  let container = null, innerName = null;
  // Boucle bornée : conteneurs imbriqués réels (zip d'un .stp.gz, stpz re-gzippé par
  // un proxy de téléchargement…) — 3 sauts max, au-delà c'est un fichier piégé.
  for(let hop = 0; hop < 3; hop++){
    if(u8.length > 2 && u8[0] === 0x1F && u8[1] === 0x8B){
      u8 = await _stepInflate(u8, 'gzip');
      container = container ? container + '+gzip' : 'gzip';
      continue;
    }
    if(u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4B && u8[2] === 0x03 && u8[3] === 0x04){
      const entries = _stepZipList(u8);
      if(!entries.length) throw new Error('Empty ZIP archive: ' + file.name);
      // Choix : entrée Part 21 explicite > XML STEP > plus grosse entrée restante.
      const pick = entries.find(e => /\.(stp|step|p21)$/i.test(e.name))
                || entries.find(e => /\.(stpx|stpxml|xml)$/i.test(e.name))
                || entries.filter(e => e.csize > 0).sort((a, b) => b.csize - a.csize)[0];
      if(!pick) throw new Error('No usable entry in the ZIP: ' + file.name);
      u8 = await _stepZipPull(u8, pick);
      innerName = pick.name;
      container = container ? container + '+zip' : 'zip';
      continue;
    }
    break; // ni gzip ni zip → payload final atteint
  }
  // STEP-XML (ISO 10303-28) — .stpx/.stpxml, ou XML surprise au fond d'un conteneur.
  const _pHead = new TextDecoder('utf-8').decode(u8.subarray(0, Math.min(u8.length, 4096)));
  if(/^\uFEFF?\s*<\?xml/i.test(_pHead) || /<iso[_-]?10303[_-]?28/i.test(_pHead)){
    // La norme prévoit un mécanisme d'inclusion de l'exchange structure Part 21 telle
    // quelle dans le document XML — rarement utilisé, mais quand il l'est, on le prend.
    const _full = new TextDecoder('utf-8').decode(u8);
    const _p21 = _full.match(/ISO-10303-21;[\s\S]*?END-ISO-10303-21;/);
    if(_p21){
      u8 = new TextEncoder().encode(_p21[0]);
      container = container ? container + '+xml' : 'xml(embedded p21)';
    } else {
      // Honnêteté technique : le mapping XML late-binding → Part 21 positionnel exige
      // le schéma EXPRESS complet (AP214/242 = des Mo de définitions) — hors de portée
      // d'un monofichier, et même OCCT desktop (donc FreeCAD, import CATIA standard) ne
      // lit pas le Part 28. Diagnostic précis plutôt qu'un crash OCCT cryptique.
      throw new Error('STEP-XML (ISO 10303-28) detected: ' + file.name +
        ' — no embedded Part 21 payload. The OCCT kernel only reads Part 21: ' +
        're-export as classic .stp/.step (AP242 recommended) from the source software.');
    }
  }
  // Sanity : header ISO-10303-21 attendu en tête. Absent → on laisse quand même OCCT
  // tenter sa chance (préambules exotiques vus dans la nature), mais on prévient.
  // [11/08] Slice élargie 512B→4KB (même lecture réutilisée pour le check FILE_SCHEMA
  // juste après — HEADER STEP tient toujours largement dedans en pratique).
  const _headSlice = new TextDecoder('utf-8').decode(u8.subarray(0, Math.min(u8.length, 4096)));
  if(!/ISO-10303-21/i.test(_headSlice))
    nasLog('WARN', 'ISO-10303-21 header not found in ' + file.name + ' — OCCT will try anyway');
  _checkStepSchema(_headSlice, file.name);
  const _newName = _stepRebaseName(file.name, innerName);
  nasLog('OK', 'STEP OmniReader: ' + file.name + ' [' + container + (innerName ? ' → ' + innerName : '') + '] ' +
    _stepFmtSize(_origSize) + ' → Part 21 ' + _stepFmtSize(u8.length) +
    ' — relayed to pipeline as "' + _newName + '"');
  return new File([u8], _newName, {type: 'text/plain'});
}

// ═══ NASSCAD PMI — Product Manufacturing Information (AP242 / MBD) ══════════
// [NEW V4.4.0 03/07] Défi PMI. Deux mondes dans un fichier AP242 :
//   · PMI GRAPHIQUE (human-readable) : les annotations en tant que courbes 3D —
//     TESSELLATED_ANNOTATION_OCCURRENCE (CATIA/NX moderne) ou ANNOTATION_CURVE_OCCURRENCE
//     + POLYLINE (exportateurs plus anciens). Rendues ici en overlay LineSegments,
//     code-couleur par famille GD&T, toggles individuels.
//   · PMI SÉMANTIQUE (machine-readable) : GEOMETRIC_TOLERANCE, DIMENSIONAL_
//     CHARACTERISTIC_REPRESENTATION, DATUM… extraites et listées dans le panneau.
// BONUS découvert en route : les fichiers NIST "-tg" n'ont AUCUN B-Rep — leur géométrie
// est un TESSELLATED_SOLID (COMPLEX_TRIANGULATED_FACE) qu'occt-import-js IGNORE
// totalement (ReadStepFile → success:true, meshes:0, vérifié en Node sur le fichier
// NIST FTC-08). D'où le lecteur tessellé pur JS ci-dessous : il synthétise des meshes
// au format occt-import-js et TOUT le pipeline aval (sewing, centrage global, smooth
// BFS, groupes) fonctionne sans une ligne de modification.
// Le scan tourne AVANT le transfert du buffer au Worker OCCT (postMessage transfer =
// ArrayBuffer détaché). Part 21 = ASCII → décodage latin1 rapide (_bytesToLatin1Str).

let _pmiPending = null;
let _stepDeclared = null;   // [16/09] relevé de la déclaration du fichier courant   // résultat du scan, consommé en fin d'import
// [18/09] Opacité déclarée par le fichier courant, par teinte. Le porteur est
// séparé de _stepDeclared parce que le chemin « depuis le cache » n'a pas de
// texte à relire : il restitue la table rangée dans l'entrée NSPG.
let _stepAlphaTable = null;
// Accepte '#rrggbb' (matériau unique) ou 0xRRGGBB (table de faces). Rend 1 —
// donc opaque, comportement d'avant — dès que le fichier ne déclare rien.
function _stepAlphaOf(c){
  if(!_stepAlphaTable || typeof nasStepDeclaredAlpha !== 'function') return 1;
  const hex = (typeof c === 'number')
    ? '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0')
    : String(c).toLowerCase();
  try { return nasStepDeclaredAlpha(_stepAlphaTable, hex); } catch(e){ return 1; }
}
let _pmiRoot = null;      // THREE.Group racine des overlays PMI (lazy)
// [NEW V4.4.0 05/07] subs : liens { sub, label, anchor } — chaque sous-groupe PMI suit
// l'objet ancre (1er corps de son import) via _pmiSync() dans anim(). Voir _pmiSync.
const _pmiState = { items: [], sem: [], subs: [] };

// ── Scanner Part 21 ──────────────────────────────────────────────────────────
// Extraction des records "#id=CORPS;" avec découpe quote-aware (échappement '' de la
// norme, pas de backslash). Seuls les types demandés sont conservés → mémoire minimale.
function _p21Records(text, wanted, semTol){
  const R = new Map(); const N = text.length;
  let i = text.indexOf('#');
  while(i !== -1 && i < N){
    let j = i + 1, id = 0, any = false;
    while(j < N){ const c = text.charCodeAt(j); if(c >= 48 && c <= 57){ id = id * 10 + (c - 48); j++; any = true; } else break; }
    // [FIX 28/09 — audit] Part 21 autorise des blancs autour du '=' : NASSCAD
    // (MEDUSA et writer JS) et OCCT écrivent « #12 = TYPE(...) ». Sans ce saut,
    // AUCUN record de ces fichiers n'était retenu : corps tessellés et PMI
    // ignorés en silence (0 corps décodé sur nos propres exports AP242).
    if(any) while(j < N && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r' || text[j] === '\n')) j++;
    if(!any || text[j] !== '='){ i = text.indexOf('#', j); continue; }
    j++;
    while(j < N && (text[j] === ' ' || text[j] === '\n' || text[j] === '\r' || text[j] === '\t')) j++;
    const bodyStart = j; let inq = false;
    while(j < N){
      const ch = text[j];
      if(inq){ if(ch === "'"){ if(text[j+1] === "'") j++; else inq = false; } }
      else if(ch === "'") inq = true;
      else if(ch === ';') break;
      j++;
    }
    const body = text.slice(bodyStart, j);
    let types;
    if(body[0] === '(') types = body.match(/[A-Z_0-9]{3,}(?=\()/g) || [];
    else { const m = body.match(/^[A-Z_0-9]+/); types = m ? [m[0]] : []; }
    let keep = false;
    for(const t of types){ if(wanted.has(t)){ keep = true; break; } }
    if(!keep && semTol){ for(const t of types){ if(t.length > 10 && t.slice(-10) === '_TOLERANCE'){ keep = true; break; } } }
    if(keep) R.set(id, { t: types, s: body });
    i = text.indexOf('#', j);
  }
  return R;
}

// Découpe les arguments top-level d'un record (parenthèses + quotes respectées).
function _p21Split(s){
  const out = []; let depth = 0, inq = false, start = 0;
  for(let i = 0; i < s.length; i++){
    const ch = s[i];
    if(inq){ if(ch === "'"){ if(s[i+1] === "'") i++; else inq = false; } continue; }
    if(ch === "'"){ inq = true; continue; }
    if(ch === '(') depth++;
    else if(ch === ')') depth--;
    else if(ch === ',' && depth === 0){ out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out;
}
function _p21Args(body){ const p = body.indexOf('('); return body.slice(p + 1, body.lastIndexOf(')')); }
function _p21Refs(s){ const m = s.match(/#\d+/g); return m ? m.map(x => parseInt(x.slice(1))) : []; }
function _p21Str(s){ const m = s.match(/'((?:[^']|'')*)'/); return m ? m[1].replace(/''/g, "'") : null; }
function _p21StrAll(s){ const m = s.match(/'((?:[^']|'')*)'/g); return m ? m.map(x => x.slice(1, -1).replace(/''/g, "'")) : []; }
// Nombres HORS chaînes (un nom 'Datum 1' ne doit pas polluer des coordonnées).
function _p21Floats(s){ const m = s.replace(/'(?:[^']|'')*'/g, ' ').match(/-?\d+\.?\d*(?:[Ee][+-]?\d+)?/g); return m ? m.map(Number) : []; }

// ── Unité de longueur du fichier → facteur vers millimètres ─────────────────
// occt-import-js est appelé avec linearUnit:'millimeter' → les meshes sortent en mm.
// L'overlay PMI doit suivre : SI_UNIT (préfixe) ou CONVERSION_BASED_UNIT ('INCH' → la
// LENGTH_MEASURE référencée donne le facteur, 25.4 quand la base du fichier est le mm).
function _pmiUnit(R){
  let convId = null, siPrefix = null;
  for(const [, r] of R){
    if(!r.t.includes('LENGTH_UNIT')) continue;
    if(r.t.includes('CONVERSION_BASED_UNIT')){ if(convId === null) convId = r; }
    else if(r.t.includes('SI_UNIT')){
      const m = r.s.match(/SI_UNIT\(\s*(\.[A-Z]+\.|\$)\s*,\s*\.METRE\./);
      if(m && siPrefix === null) siPrefix = m[1];
    }
  }
  if(convId){
    const name = (_p21Str(convId.s) || 'unit').toLowerCase();
    let scale = 1;
    for(const ref of _p21Refs(convId.s)){
      const rr = R.get(ref);
      if(rr && rr.s.indexOf('LENGTH_MEASURE(') !== -1){
        const m = rr.s.match(/LENGTH_MEASURE\((-?\d+\.?\d*(?:[Ee][+-]?\d+)?)\)/);
        if(m){ scale = parseFloat(m[1]); break; }
      }
    }
    return { scale, label: name };
  }
  // [FIX] Table complète de l'énumération si_prefix (ISO 10303-41) -- pas seulement
  // le sous-ensemble usuel en CAO mécanique. Un préfixe non reconnu retombait
  // silencieusement sur la même échelle que .MILLI. (1) -- dangereux si un fichier
  // exotique (modèle MEMS en .NANO., assemblage cartographique en .KILO.) passe par
  // là : au lieu de planter ou déformer, la valeur PMI affichée mentait en silence.
  // Désormais : log WARN + repli neutre (label brut, échelle 1 explicitement assumée)
  // au lieu d'un repli qui se fait passer pour du mm.
  const SC = {
    '.EXA.':1e21, '.PETA.':1e18, '.TERA.':1e15, '.GIGA.':1e12, '.MEGA.':1e9,
    '.KILO.':1e6, '.HECTO.':1e5, '.DECA.':1e4, '$':1000,
    '.DECI.':100, '.CENTI.':10, '.MILLI.':1, '.MICRO.':0.001,
    '.NANO.':1e-6, '.PICO.':1e-9, '.FEMTO.':1e-12, '.ATTO.':1e-15
  };
  const LB = {
    '.EXA.':'Em', '.PETA.':'Pm', '.TERA.':'Tm', '.GIGA.':'Gm', '.MEGA.':'Mm',
    '.KILO.':'km', '.HECTO.':'hm', '.DECA.':'dam', '$':'m',
    '.DECI.':'dm', '.CENTI.':'cm', '.MILLI.':'mm', '.MICRO.':'µm',
    '.NANO.':'nm', '.PICO.':'pm', '.FEMTO.':'fm', '.ATTO.':'am'
  };
  if(siPrefix !== null && !(siPrefix in SC)){
    nasLog('WARN', `PMI: unrecognized SI prefix (${siPrefix}) — assuming scale 1, PMI values possibly incorrect`);
  }
  return { scale: siPrefix in SC ? SC[siPrefix] : 1, label: LB[siPrefix] || (siPrefix || 'mm') };
}

// ── Lecteur de géométrie tessellée AP242 ─────────────────────────────────────
// COMPLEX_TRIANGULATED_FACE : (name, #coords, pnmax, normales, geom_link, pnindex,
// triangle_strips, triangle_fans). Les strips/fans indexent pnindex (local 1-based),
// pnindex indexe la COORDINATES_LIST partagée (1-based). Convention strips CAx-IF :
// parité alternée façon OpenGL — validée empiriquement par appariement d'arêtes
// opposées sur le solide NIST (mesh fermé → chaque arête doit apparaître 2× en sens
// inverses, sinon la parité est fausse).
function _pmiFaceTris(rec, out){
  const tok = _p21Split(_p21Args(rec.s));
  const clId = tok[1] && tok[1][0] === '#' ? parseInt(tok[1].slice(1)) : null;
  if(clId === null) return null;
  const pnRaw = (tok[5] || '').match(/\d+/g);
  const pn = pnRaw ? pnRaw.map(Number) : [];
  const map = li => (pn.length ? pn[li - 1] : li) - 1;   // → 0-based global CL
  const groups = t => (t || '').match(/\(([\d,\s]+)\)/g) || [];
  const pushTri = (a, b, c) => { if(a !== b && b !== c && a !== c) out.push(clId, a, b, c); };
  if(rec.t.includes('COMPLEX_TRIANGULATED_FACE')){
    for(const g of groups(tok[6])){ const s = g.match(/\d+/g).map(Number);
      for(let k = 2; k < s.length; k++){
        const a = map(s[k-2]), b = map(s[k-1]), c = map(s[k]);
        if(((k - 2) & 1) === 0) pushTri(a, b, c); else pushTri(b, a, c);
      } }
    for(const g of groups(tok[7])){ const f = g.match(/\d+/g).map(Number);
      for(let k = 2; k < f.length; k++) pushTri(map(f[0]), map(f[k-1]), map(f[k])); }
  } else { // TRIANGULATED_FACE : dernier arg = liste de triangles
    for(const g of groups(tok[6])){ const t3 = g.match(/\d+/g).map(Number);
      if(t3.length === 3) pushTri(map(t3[0]), map(t3[1]), map(t3[2])); }
  }
  return clId;
}

function _pmiTessMeshes(R, clCache, unitScale){
  const solidFaces = new Set(); const bodies = [];
  for(const [id, r] of R){
    if(r.t.includes('TESSELLATED_SOLID')){
      const tok = _p21Split(_p21Args(r.s));
      const faces = _p21Refs(tok[1] || '');
      faces.forEach(f => solidFaces.add(f));
      bodies.push({ name: _p21Str(r.s) || ('TessSolid#' + id), faces });
    }
  }
  for(const [id, r] of R){
    if(r.t.includes('TESSELLATED_SHELL')){
      const tok = _p21Split(_p21Args(r.s));
      const faces = _p21Refs(tok[1] || '').filter(f => !solidFaces.has(f));
      if(faces.length) bodies.push({ name: _p21Str(r.s) || ('TessShell#' + id), faces });
    }
  }
  const meshes = [];
  for(const b of bodies){
    const quad = [];        // (clId, a, b, c) par triangle
    for(const fid of b.faces){
      const fr = R.get(fid);
      if(fr && (fr.t.includes('COMPLEX_TRIANGULATED_FACE') || fr.t.includes('TRIANGULATED_FACE'))) _pmiFaceTris(fr, quad);
    }
    if(!quad.length) continue;
    const key2loc = new Map(); const pos = []; const idx = [];
    for(let q = 0; q < quad.length; q += 4){
      const clId = quad[q];
      const arr = clCache(clId);
      if(!arr) continue;
      for(let v = 1; v <= 3; v++){
        const gi = quad[q + v]; const k = clId + ':' + gi;
        let l = key2loc.get(k);
        if(l === undefined){
          l = pos.length / 3;
          pos.push(arr[gi*3] * unitScale, arr[gi*3+1] * unitScale, arr[gi*3+2] * unitScale);
          key2loc.set(k, l);
        }
        idx.push(l);
      }
    }
    if(!idx.length) continue;
    meshes.push({ name: b.name, color: null,
      attributes: { position: { array: new Float32Array(pos) } },
      index: { array: new Uint32Array(idx) } });
  }
  return meshes;
}

// ── PMI graphique ─────────────────────────────────────────────────────────────
function _pmiStyleColor(R, rec){
  let frontier = _p21Refs(rec.s).slice(0, 24);
  for(let d = 0; d < 3 && frontier.length; d++){
    const next = [];
    for(const ref of frontier){
      const rr = R.get(ref); if(!rr) continue;
      if(rr.t.includes('DRAUGHTING_PRE_DEFINED_COLOUR')){ const n = _p21Str(rr.s); if(n) return { css: n.toLowerCase() }; }
      if(rr.t.includes('COLOUR_RGB')){ const f = _p21Floats(rr.s); if(f.length >= 3) return { rgb: [f[0], f[1], f[2]] }; }
      next.push(..._p21Refs(rr.s));
    }
    frontier = next.slice(0, 200);
  }
  return null;
}

// ── Résolution d'un placement AXIS2_PLACEMENT_3D (repositionnement PMI) ──
// [FIX] Les annotations PMI tessellées (AP242) référencent souvent un
// REPOSITIONED_TESSELLATED_ITEM pointant vers un AXIS2_PLACEMENT_3D — la
// géométrie tessellée elle-même est exprimée dans un repère LOCAL (souvent
// plat, Z local ≈ 0, propre au "plan d'annotation") qui doit être replacé
// dans le repère monde de la pièce via ce placement. Ignorer ce placement
// fait s'écraser TOUTES les annotations d'un même plan sur une seule
// hauteur — confirmé empiriquement sur NIST CTC-01 (23/23 annotations à Y
// constant avant ce correctif, comparaison numérique bbox mesh vs bbox PMI).
function _pmiResolvePlacement(R, ref){
  const rec = ref !== null ? R.get(ref) : null;
  if(!rec || !rec.t.includes('AXIS2_PLACEMENT_3D')) return null;
  const tok = _p21Split(_p21Args(rec.s)); // [name, locRef, zDirRef, xDirRef]
  const locRef = tok[1] && tok[1][0] === '#' ? parseInt(tok[1].slice(1)) : null;
  const zRef   = tok[2] && tok[2][0] === '#' ? parseInt(tok[2].slice(1)) : null;
  const xRef   = tok[3] && tok[3][0] === '#' ? parseInt(tok[3].slice(1)) : null;
  const locRec = locRef !== null ? R.get(locRef) : null;
  if(!locRec) return null;
  const origin = _p21Floats(_p21Args(locRec.s));
  if(origin.length < 3) return null;
  const zRec = zRef !== null ? R.get(zRef) : null;
  const xRec = xRef !== null ? R.get(xRef) : null;
  let zAxis = zRec ? _p21Floats(_p21Args(zRec.s)) : [];
  let xAxis = xRec ? _p21Floats(_p21Args(xRec.s)) : [];
  if(zAxis.length < 3) zAxis = [0, 0, 1];   // directions optionnelles en EXPRESS — repli monde par défaut
  if(xAxis.length < 3) xAxis = [1, 0, 0];
  const norm  = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };
  const dot   = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const sub   = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
  const scl   = (a, s) => [a[0]*s, a[1]*s, a[2]*s];
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const zN = norm(zAxis);
  let xN = norm(sub(xAxis, scl(zN, dot(xAxis, zN)))); // orthogonalisation Gram-Schmidt de X vs Z
  const yN = cross(zN, xN); // convention STEP standard : Y = Z × X (repère direct)
  return { origin, xAxis: xN, yAxis: yN, zAxis: zN };
}
function _pmiApplyPlacement(p, x, y, z){
  if(!p) return [x, y, z];
  return [
    p.origin[0] + x*p.xAxis[0] + y*p.yAxis[0] + z*p.zAxis[0],
    p.origin[1] + x*p.xAxis[1] + y*p.yAxis[1] + z*p.zAxis[1],
    p.origin[2] + x*p.xAxis[2] + y*p.yAxis[2] + z*p.zAxis[2],
  ];
}

function _pmiGraphical(R, clCache, unitScale){
  const anns = [];
  for(const [id, r] of R){
    // Voie AP242 tessellée (CATIA V5/V6, NX récents)
    if(r.t.includes('TESSELLATED_ANNOTATION_OCCURRENCE')){
      const tok = _p21Split(_p21Args(r.s));
      const name = _p21Str(tok[0] || '') || ('PMI#' + id);
      const itemRef = tok[2] && tok[2][0] === '#' ? parseInt(tok[2].slice(1)) : null;
      const tgs = itemRef !== null ? R.get(itemRef) : null;
      const seg = [];
      if(tgs){
        // [FIX2] REPOSITIONED_TESSELLATED_ITEM est une FACETTE du type complexe
        // de tgs lui-même (tgs.t l'inclut, cf. parsing ligne ~1259 : entité
        // complexe body[0]==='(' → tous les noms de type du corps entier sont
        // capturés) — PAS une entité enfant séparément référencée. Sa référence
        // de placement s'extrait directement du texte brut de tgs, pas en
        // cherchant un enfant typé ainsi (erreur de la 1ère version du correctif
        // — silencieusement sans effet : placement toujours null, fallback
        // identité, symptôme indiscernable du bug d'origine).
        let placement = null;
        if(tgs.t.includes('REPOSITIONED_TESSELLATED_ITEM')){
          const m = tgs.s.match(/REPOSITIONED_TESSELLATED_ITEM\s*\(\s*(#\d+)\s*\)/);
          if(m){
            placement = _pmiResolvePlacement(R, parseInt(m[1].slice(1)));
            if(!placement) nasLog('WARN', `PMI "${name}": placement ${m[1]} referenced but unresolved (entity missing from R or unexpected type)`);
          }
        }
        const allRefs = _p21Refs(_p21Args(tgs.s));
        for(const cRef of allRefs){
          const tcs = R.get(cRef);
          if(!tcs || !tcs.t.includes('TESSELLATED_CURVE_SET')) continue;
          const t2 = _p21Split(_p21Args(tcs.s));
          const clId = t2[1] && t2[1][0] === '#' ? parseInt(t2[1].slice(1)) : null;
          const arr = clId !== null ? clCache(clId) : null;
          if(!arr) continue;
          for(const g of (t2[2] || '').match(/\(([\d,\s]+)\)/g) || []){
            const ids = g.match(/\d+/g).map(Number);
            for(let k = 1; k < ids.length; k++){
              const ia = (ids[k-1] - 1) * 3, ib = (ids[k] - 1) * 3;
              const pA = _pmiApplyPlacement(placement, arr[ia], arr[ia+1], arr[ia+2]);
              const pB = _pmiApplyPlacement(placement, arr[ib], arr[ib+1], arr[ib+2]);
              seg.push(pA[0]*unitScale, pA[1]*unitScale, pA[2]*unitScale,
                       pB[0]*unitScale, pB[1]*unitScale, pB[2]*unitScale);
            }
          }
        }
      }
      if(seg.length) anns.push({ name, color: _pmiStyleColor(R, r), seg: new Float32Array(seg) });
      continue;
    }
    // Voie polyline (ANNOTATION_CURVE_OCCURRENCE — SolidWorks, Creo, exports plus anciens)
    if(r.t.includes('ANNOTATION_CURVE_OCCURRENCE') || r.t.includes('ANNOTATION_FILL_AREA_OCCURRENCE')
       || (r.t.length === 1 && r.t[0] === 'ANNOTATION_OCCURRENCE')){
      const tok = _p21Split(_p21Args(r.s));
      const name = _p21Str(tok[0] || '') || ('PMI#' + id);
      const itemRef = tok[2] && tok[2][0] === '#' ? parseInt(tok[2].slice(1)) : null;
      const item = itemRef !== null ? R.get(itemRef) : null;
      const polyRefs = [];
      const harvest = rr => { for(const ref2 of _p21Refs(_p21Args(rr.s))){ const r3 = R.get(ref2); if(r3 && r3.t.includes('POLYLINE')) polyRefs.push(ref2); } };
      if(item){
        if(item.t.includes('POLYLINE')) polyRefs.push(itemRef);
        else { harvest(item);
          for(const ref of _p21Refs(item.s)){ const rr = R.get(ref);
            if(rr && (rr.t.includes('GEOMETRIC_CURVE_SET') || rr.t.includes('GEOMETRIC_SET') || rr.t.includes('ANNOTATION_FILL_AREA'))) harvest(rr); } }
      }
      const seg = [];
      for(const pRef of polyRefs){
        const pl = R.get(pRef); if(!pl) continue;
        let prev = null;
        for(const cpRef of _p21Refs(_p21Args(pl.s))){
          const cp = R.get(cpRef);
          const f = cp ? _p21Floats(_p21Args(cp.s)) : null;
          if(!f || f.length < 3){ prev = null; continue; }
          const P = [f[0]*unitScale, f[1]*unitScale, f[2]*unitScale];
          if(prev) seg.push(prev[0], prev[1], prev[2], P[0], P[1], P[2]);
          prev = P;
        }
      }
      if(seg.length) anns.push({ name, color: _pmiStyleColor(R, r), seg: new Float32Array(seg) });
    }
  }
  return anns;
}

// ── PMI sémantique ────────────────────────────────────────────────────────────
const _PMI_TOL_GENERIC = new Set(['GEOMETRIC_TOLERANCE','GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE',
  'GEOMETRIC_TOLERANCE_WITH_DEFINED_UNIT','GEOMETRIC_TOLERANCE_WITH_DEFINED_AREA_UNIT',
  'GEOMETRIC_TOLERANCE_WITH_MODIFIERS','GEOMETRIC_TOLERANCE_WITH_MAXIMUM_TOLERANCE',
  'MODIFIED_GEOMETRIC_TOLERANCE','UNEQUALLY_DISPOSED_GEOMETRIC_TOLERANCE']);

function _pmiSemantics(R, unitLabel){
  const out = []; const datumOf = new Map();
  for(const [id, r] of R){
    if(r.t.length === 1 && r.t[0] === 'DATUM'){
      const strs = _p21StrAll(r.s).filter(x => x.trim());
      if(strs.length) datumOf.set(id, strs[strs.length - 1]);
    }
  }
  for(const [id, r] of R){
    const isTol = r.t.some(t => t.endsWith('_TOLERANCE')) && !r.t.includes('PLUS_MINUS_TOLERANCE') && !r.t.includes('TOLERANCE_VALUE');
    if(!isTol) continue;
    const leaf = r.t.find(t => t.endsWith('_TOLERANCE') && !_PMI_TOL_GENERIC.has(t)) || 'GEOMETRIC_TOLERANCE';
    const kind = leaf.replace(/_TOLERANCE$/, '').replace(/_/g, ' ').toLowerCase();
    let val = null;
    for(const ref of _p21Refs(r.s)){
      const rr = R.get(ref);
      if(rr && rr.s.indexOf('LENGTH_MEASURE(') !== -1){
        const m = rr.s.match(/LENGTH_MEASURE\((-?\d+\.?\d*(?:[Ee][+-]?\d+)?)\)/);
        if(m){ val = parseFloat(m[1]); break; }
      }
    }
    const letters = new Set();
    let frontier = _p21Refs(r.s);
    for(let d = 0; d < 3 && frontier.length; d++){
      const next = [];
      for(const ref of frontier){
        if(datumOf.has(ref)){ letters.add(datumOf.get(ref)); continue; }
        const rr = R.get(ref);
        if(rr && rr.t.some(t => t.indexOf('DATUM') === 0)) next.push(..._p21Refs(rr.s));
      }
      frontier = next.slice(0, 400);
    }
    const nm = _p21Str(r.s);
    out.push({ kind: 'tol', label: (nm && nm.trim()) || kind, type: kind, value: val, unit: unitLabel, datums: [...letters].sort() });
  }
  for(const [, r] of R){
    if(!r.t.includes('DIMENSIONAL_CHARACTERISTIC_REPRESENTATION')) continue;
    let label = 'dimension', val = null, isDia = false;
    for(const ref of _p21Refs(r.s)){
      const rr = R.get(ref); if(!rr) continue;
      if(rr.t.includes('DIMENSIONAL_SIZE') || rr.t.includes('DIMENSIONAL_LOCATION')){
        const strs = _p21StrAll(rr.s).filter(x => x.trim());
        if(strs.length){ label = strs[strs.length - 1]; isDia = /diamet/i.test(label); }
      } else {
        for(const ref2 of _p21Refs(rr.s)){
          const r3 = R.get(ref2);
          if(r3 && val === null){
            const m = r3.s.match(/(?:POSITIVE_LENGTH_MEASURE|LENGTH_MEASURE)\((-?\d+\.?\d*(?:[Ee][+-]?\d+)?)\)/);
            if(m) val = parseFloat(m[1]);
          }
        }
      }
    }
    out.push({ kind: 'dim', label, type: 'dimension', value: val, unit: unitLabel, dia: isDia, datums: [] });
  }
  if(datumOf.size) out.push({ kind: 'datums', letters: [...new Set(datumOf.values())].sort() });
  return out;
}

// ── Scan principal ────────────────────────────────────────────────────────────
function _pmiScan(text, f){
  const t0 = performance.now();
  const W = new Set(['SI_UNIT', 'CONVERSION_BASED_UNIT', 'LENGTH_MEASURE_WITH_UNIT']);
  const add = a => a.forEach(t => W.add(t));
  if(f.hasTessGeo) add(['TESSELLATED_SOLID','TESSELLATED_SHELL','COMPLEX_TRIANGULATED_FACE','TRIANGULATED_FACE','COORDINATES_LIST']);
  if(f.hasTessAnn) add(['TESSELLATED_ANNOTATION_OCCURRENCE','TESSELLATED_GEOMETRIC_SET','TESSELLATED_CURVE_SET','COORDINATES_LIST','PRESENTATION_STYLE_ASSIGNMENT','CURVE_STYLE','DRAUGHTING_PRE_DEFINED_COLOUR','COLOUR_RGB','AXIS2_PLACEMENT_3D','CARTESIAN_POINT','DIRECTION']);
  if(f.hasPolyAnn) add(['ANNOTATION_CURVE_OCCURRENCE','ANNOTATION_OCCURRENCE','ANNOTATION_FILL_AREA_OCCURRENCE','ANNOTATION_FILL_AREA','GEOMETRIC_CURVE_SET','GEOMETRIC_SET','POLYLINE','CARTESIAN_POINT','PRESENTATION_STYLE_ASSIGNMENT','CURVE_STYLE','DRAUGHTING_PRE_DEFINED_COLOUR','COLOUR_RGB']);
  if(f.hasSem) add(['GEOMETRIC_TOLERANCE','DATUM','DATUM_SYSTEM','DATUM_REFERENCE_COMPARTMENT','DATUM_REFERENCE_ELEMENT','DATUM_FEATURE','DIMENSIONAL_CHARACTERISTIC_REPRESENTATION','SHAPE_DIMENSION_REPRESENTATION','DIMENSIONAL_SIZE','DIMENSIONAL_LOCATION','MEASURE_REPRESENTATION_ITEM','LENGTH_MEASURE_WITH_UNIT','PLUS_MINUS_TOLERANCE','TOLERANCE_VALUE']);
  const R = _p21Records(text, W, !!f.hasSem);
  const clMem = new Map();
  const clCache = id => {
    if(clMem.has(id)) return clMem.get(id);
    const r = R.get(id);
    let arr = null;
    if(r && r.t.includes('COORDINATES_LIST')){
      const tok = _p21Split(_p21Args(r.s));
      arr = new Float32Array(_p21Floats(tok[2] || ''));
    }
    clMem.set(id, arr); return arr;
  };
  const unit = _pmiUnit(R);
  const tessMeshes = f.hasTessGeo ? _pmiTessMeshes(R, clCache, unit.scale) : [];
  const annotations = (f.hasTessAnn || f.hasPolyAnn) ? _pmiGraphical(R, clCache, unit.scale) : [];
  const semantics = f.hasSem ? _pmiSemantics(R, unit.label) : [];
  nasLog('DBG', `PMI scan: ${R.size} record(s) kept, ${annotations.length} annotation(s), ` +
    `${tessMeshes.length} tessellated body(ies), ${semantics.length} semantic entry(ies) — ` +
    `unit ${unit.label} (×${unit.scale}) — ${Math.round(performance.now() - t0)}ms`);
  return { annotations, semantics, tessMeshes, unit };
}

// [FIX 28/09 — audit] Corps tessellés décodés en JS absents du résultat du lecteur.
// Présent = même nom, ou même boîte englobante (1 % de la taille + 0,01 mm) : les
// deux sont dans le repère STEP en mm (le recentrage global vient après).
function _stepTessMissing(meshes, tess){
  const bb = a => { let x0=Infinity,y0=Infinity,z0=Infinity,x1=-Infinity,y1=-Infinity,z1=-Infinity;
    for(let i = 0; i + 2 < a.length; i += 3){ const x=a[i], y=a[i+1], z=a[i+2];
      if(x<x0)x0=x; if(y<y0)y0=y; if(z<z0)z0=z; if(x>x1)x1=x; if(y>y1)y1=y; if(z>z1)z1=z; }
    return [x0,y0,z0,x1,y1,z1]; };
  const posOf = m => (m && m.attributes && m.attributes.position && m.attributes.position.array) || [];
  const have = (meshes || []).map(m => ({ name: (m && m.name) || '', b: bb(posOf(m)) }));
  const near = (a, b) => {
    const tol = 0.01 * Math.max(a[3]-a[0], a[4]-a[1], a[5]-a[2], 0) + 0.01;
    for(let k = 0; k < 6; k++) if(!(Math.abs(a[k] - b[k]) <= tol)) return false;
    return true;
  };
  return (tess || []).filter(t => {
    const n = t.name || '', tb = bb(posOf(t));
    return !have.some(h => (n && h.name === n) || near(h.b, tb));
  });
}

function _pmiScanIfRelevant(buffer, fname){
  if(fname && fname.indexOf('[chunk ') !== -1) return null;   // chunk Turbo : réfs coupées
  if(buffer.byteLength > 64 * 1024 * 1024){ nasLog('DBG', 'PMI scan skipped (>64 MB)'); return null; }
  const text = _bytesToLatin1Str(new Uint8Array(buffer));
  const flags = {
    hasTessAnn: text.indexOf('TESSELLATED_ANNOTATION_OCCURRENCE') !== -1,
    hasPolyAnn: text.indexOf('ANNOTATION_CURVE_OCCURRENCE') !== -1
             || text.indexOf('ANNOTATION_FILL_AREA_OCCURRENCE') !== -1
             || (text.indexOf('ANNOTATION_OCCURRENCE') !== -1 && text.indexOf('POLYLINE') !== -1),
    hasTessGeo: text.indexOf('TESSELLATED_SOLID') !== -1 || text.indexOf('TESSELLATED_SHELL') !== -1
             || text.indexOf('TRIANGULATED_FACE') !== -1,
    hasSem: text.indexOf('GEOMETRIC_TOLERANCE') !== -1 || text.indexOf('DIMENSIONAL_CHARACTERISTIC') !== -1
         || text.indexOf('DATUM') !== -1
  };
  if(!flags.hasTessAnn && !flags.hasPolyAnn && !flags.hasTessGeo && !flags.hasSem) return null;
  const res = _pmiScan(text, flags);
  // [FIX 28/09 — audit] Fichier écrit par NASSCAD (MEDUSA ou writer JS) : ses corps
  // tessellés sont en coordonnées monde, un produit = un corps nommé — ils peuvent
  // être complétés sans risque de doublon (cf. _stepTessMissing).
  if(res){
    const _hdEnd = text.indexOf('ENDSEC;');
    const _hd = text.slice(0, _hdEnd > 0 ? Math.min(_hdEnd, 8000) : 8000);
    res.nasscadWriter = /FILE_NAME\s*\([\s\S]*NASSCAD/i.test(_hd);
  }
  return res;
}

// ── Overlay Three.js + UI ─────────────────────────────────────────────────────
const _PMI_FAM_COLOR = { datum: 0xffd447, form: 0x4fc3f7, orientation: 0x4dd0e1,
  location: 0xff8a65, dimension: 0x81c784, text: 0xd0d0d0, other: 0xce93d8 };
const _PMI_CSS = { white: 0xf2f2f2, black: 0x202020, red: 0xff4040, green: 0x33cc55,
  blue: 0x4488ff, yellow: 0xffd447, cyan: 0x33cccc, magenta: 0xcc44cc };

function _pmiFamily(name){
  const n = (name || '').toLowerCase();
  if(/datum/.test(n)) return 'datum';
  if(/flat|straight|circular|cylindric|angular/.test(n)) return 'form';
  if(/parallel|perpendic|orient/.test(n)) return 'orientation';
  if(/position|profile|runout|concentr|symmetr|coaxial/.test(n)) return 'location';
  if(/size|diamet|radius|linear|dimension|angle|chamfer|thread/.test(n)) return 'dimension';
  if(/text|note|label/.test(n)) return 'text';
  return 'other';
}

function _pmiCommit(p, ox, oy, oz, label){
  if(p.annotations.length && typeof THREE !== 'undefined' && typeof scene !== 'undefined'){
    if(!_pmiRoot){ _pmiRoot = new THREE.Group(); _pmiRoot.name = 'PMI'; scene.add(_pmiRoot); }
    const sub = new THREE.Group(); sub.name = 'PMI:' + label; _pmiRoot.add(sub);
    // [NEW V4.4.0 05/07] Ancre du suivi : 1er corps de CET import. La géo des meshes
    // est bakée (mesh.position démarre à 0,0,0) et les segments PMI ont reçu le MÊME
    // offset global → copier le transform de l'ancre (pos+quat+scale) dans le sub
    // reproduit exactement tout déplacement/rotation/scale ultérieur. On ne parente
    // PAS au mesh : les LineSegments pollueraient Box3.setFromObject() partout
    // (gizmo, drag collision, align, élévation). Multi-corps : les annotations
    // suivent le 1er corps de l'import — limite v1 documentée dans le panneau.
    const _anchor = objs.find(o => o.stepGroupLabel === label) || null;
    _pmiState.subs.push({ sub, label, anchor: _anchor });
    const palette = new Set();
    p.annotations.forEach(a => { if(a.color) palette.add(a.color.css || String(a.color.rgb)); });
    const useFile = palette.size > 1;   // palette monochrome (NIST tout-blanc) → code famille
    for(const a of p.annotations){
      const arr = new Float32Array(a.seg.length);
      for(let i = 0; i < a.seg.length; i += 3){
        arr[i]   =  a.seg[i]   + ox;    // X → X      (même bascule que les meshes,
        arr[i+1] =  a.seg[i+2] + oy;    // Z → Y up    même offset global pass 2)
        arr[i+2] = -a.seg[i+1] + oz;    // -Y → Z
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const fam = _pmiFamily(a.name);
      let col = null;
      if(useFile && a.color) col = a.color.css !== undefined ? _PMI_CSS[a.color.css] : (a.color.rgb ? new THREE.Color(a.color.rgb[0], a.color.rgb[1], a.color.rgb[2]).getHex() : null);
      if(col === null || col === undefined) col = _PMI_FAM_COLOR[fam];
      const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: col }));
      line.userData.pmi = { name: a.name, fam };
      sub.add(line);
      _pmiState.items.push({ name: a.name, fam, line, imp: label });
    }
  }
  for(const s of p.semantics) _pmiState.sem.push(Object.assign({ imp: label }, s));
  _pmiEnsureUI();
  const nS = p.semantics.filter(s => s.kind !== 'datums').length;
  nasLog('OK', `PMI: ${p.annotations.length} graphical annotation(s) + ${nS} semantic(s) — [${label}] — panel via the PMI button`);
  _pmiRepaint();
}

function _pmiEnsureUI(){
  let pill = document.getElementById('pmi-pill');
  if(!pill){
    pill = document.createElement('button');
    pill.id = 'pmi-pill'; pill.title = 'PMI — annotations 3D (AP242 / MBD)';
    pill.style.cssText = 'font:600 11px system-ui;padding:3px 10px;border-radius:12px;border:1.5px solid #ffb300;background:rgba(255,179,0,.14);color:#ffb300;cursor:pointer;margin-left:6px';
    pill.onclick = _pmiTogglePanel;
    const host = document.getElementById('mem-gauge-wrap');
    if(host && host.parentElement) host.parentElement.insertBefore(pill, host);
    else { pill.style.cssText += ';position:fixed;right:12px;bottom:12px;z-index:2500'; document.body.appendChild(pill); }
  }
  pill.textContent = 'PMI ' + _pmiState.items.length;
  pill.style.display = '';
  _pmiBuildPanel();
}

function _pmiTogglePanel(){
  const m = document.getElementById('pmi-modal');
  if(m) m.style.display = m.style.display === 'flex' ? 'none' : 'flex';
}
function _pmiEsc(s){ return String(s).replace(/[<>&"]/g, c => '&#' + c.charCodeAt(0) + ';'); }
// [FIX 28/09 — audit] Appelait render(), qui n'existe pas en global (celui du
// sketcher vit dans son IIFE) : cocher/décocher une annotation ne redessinait rien
// avant le prochain mouvement de caméra. Le rendu est paresseux : on le demande.
function _pmiRepaint(){ try{ _camDirty = true; }catch(e){} }

// [NEW V4.4.0 05/07] Suivi des annotations : appelé chaque frame dans anim() (coût
// négligeable — copie de 10 floats par import). Copie pos+quat+scale de l'objet ancre
// vers le sous-groupe PMI, et ne set _camDirty QUE si le transform a réellement changé
// (epsilon 1e-9) pour ne pas casser le lazy render. Si l'ancre a été supprimée
// (mesh.parent null), tentative de re-résolution par stepGroupLabel — couvre le cycle
// delete→undo qui recrée un mesh neuf ; sinon l'overlay gèle sur son dernier transform.
function _pmiSync(){
  if(!_pmiState.subs.length) return;
  for(const e of _pmiState.subs){
    if(!e.anchor || !e.anchor.mesh || !e.anchor.mesh.parent){
      e.anchor = objs.find(o => o.stepGroupLabel === e.label && o.mesh && o.mesh.parent) || e.anchor;
      if(!e.anchor || !e.anchor.mesh || !e.anchor.mesh.parent) continue;   // gel
    }
    const m = e.anchor.mesh, s = e.sub;
    if(s.position.distanceToSquared(m.position) > 1e-18 ||
       Math.abs(1 - Math.abs(s.quaternion.dot(m.quaternion))) > 1e-9 ||
       s.scale.distanceToSquared(m.scale) > 1e-18){
      s.position.copy(m.position);
      s.quaternion.copy(m.quaternion);
      s.scale.copy(m.scale);
      _camDirty = true;
    }
  }
}

function _pmiBuildPanel(){
  let m = document.getElementById('pmi-modal');
  if(!m){
    m = document.createElement('div'); m.id = 'pmi-modal';
    m.style.cssText = 'display:none;position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.45);align-items:center;justify-content:center;';
    m.addEventListener('click', e => { if(e.target === m) m.style.display = 'none'; });
    document.body.appendChild(m);
  }
  const fams = {};
  _pmiState.items.forEach((it, ix) => { (fams[it.fam] = fams[it.fam] || []).push(ix); });
  let rows = '';
  for(const f of ['datum','form','orientation','location','dimension','text','other']){
    if(!fams[f]) continue;
    const col = '#' + _PMI_FAM_COLOR[f].toString(16).padStart(6, '0');
    rows += `<div style="margin:7px 0 2px;font-weight:700;font-size:11px;color:${col}">■ ${f.toUpperCase()} <span style="opacity:.55">(${fams[f].length})</span></div>`;
    for(const ix of fams[f]){
      const it = _pmiState.items[ix];
      rows += `<label style="display:flex;gap:6px;align-items:center;font-size:11.5px;cursor:pointer;padding:1px 0">` +
        `<input type="checkbox" ${it.line.visible ? 'checked' : ''} onchange="_pmiState.items[${ix}].line.visible=this.checked;_pmiRepaint()">` +
        `<span>${_pmiEsc(it.name)}</span></label>`;
    }
  }
  if(!rows) rows = '<div style="font-size:11px;opacity:.6">No graphic annotation in this file.</div>';
  let sem = '';
  const dat = _pmiState.sem.find(s => s.kind === 'datums');
  if(dat) sem += `<div style="font-size:11.5px;margin:2px 0">Datums : <b>${dat.letters.map(_pmiEsc).join(' · ')}</b></div>`;
  for(const s of _pmiState.sem){
    if(s.kind === 'datums') continue;
    const v = (s.value !== null && s.value !== undefined) ? ` — <b>${s.dia ? '⌀ ' : ''}${_pmiEsc(s.value)} ${_pmiEsc(s.unit || '')}</b>` : '';
    const d = s.datums && s.datums.length ? ` — datums [${s.datums.map(_pmiEsc).join(',')}]` : '';
    sem += `<div style="font-size:11.5px;padding:1px 0">${s.kind === 'tol' ? '⌖' : '↔'} ${_pmiEsc(s.label)}${v}${d}</div>`;
  }
  if(!sem) sem = `<div style="font-size:11px;opacity:.6">No semantic PMI (machine-readable) in this file — 'presentation-only' variant (e.g. NIST '-tg'). Files with GEOMETRIC_TOLERANCE / DATUM display here.</div>`;
  m.innerHTML = `<div class="vb-win" style="min-width:370px;max-width:470px;padding:0">
    <div class="vb-tbar"><span>📐 PMI — 3D Annotations (AP242 / MBD)</span></div>
    <div style="padding:10px 12px;max-height:70vh;overflow:auto">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <label style="display:flex;gap:6px;align-items:center;font-size:12px;cursor:pointer">
          <input type="checkbox" ${(!_pmiRoot || _pmiRoot.visible) ? 'checked' : ''} onchange="if(_pmiRoot){_pmiRoot.visible=this.checked;_pmiRepaint();}">
          <b>Show PMI overlay</b></label>
        <span style="flex:1"></span>
        <button style="font:600 11px system-ui;padding:2px 8px;cursor:pointer" onclick="_pmiClear()">✕ Clear</button>
        <button style="font:600 11px system-ui;padding:2px 8px;cursor:pointer" onclick="document.getElementById('pmi-modal').style.display='none'">Close</button>
      </div>
      ${rows}
      <div style="border-top:1px solid rgba(128,128,128,.35);margin:8px 0 6px"></div>
      <div style="font-weight:700;font-size:11px;margin-bottom:3px">SEMANTIC PMI (machine-readable)</div>
      ${sem}
      <div style="font-size:10px;opacity:.5;margin-top:8px">v1 limitations: overlay independent of exploded mode · annotations follow the 1st body of their import (separately-moved multi-body not supported) · PMI text = tessellated curves as-is.</div>
    </div></div>`;
}

function _pmiClear(){
  if(_pmiRoot){
    _pmiRoot.traverse(o => { if(o.isLineSegments){ o.geometry.dispose(); o.material.dispose(); } });
    if(_pmiRoot.parent) _pmiRoot.parent.remove(_pmiRoot);
    _pmiRoot = null;
  }
  _pmiState.items.length = 0; _pmiState.sem.length = 0; _pmiState.subs.length = 0;
  const pill = document.getElementById('pmi-pill'); if(pill) pill.style.display = 'none';
  const m = document.getElementById('pmi-modal'); if(m) m.style.display = 'none';
  _pmiRepaint();
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPORT IFC MEDUSA — optional native entry; default import is in ifc-import.js.
//
// Trois lignes de code, parce que tout le travail est ailleurs : MEDUSA lit
// l'IFC nativement (namespace nasifc) et rend le MEME buffer NSTP que pour un
// STEP. Tout ce qui suit — decodage, construction des maillages, couleurs par
// face, opacite, cache IndexedDB, arborescence — est strictement le chemin
// STEP, inchange.
//
// DEUX DIFFERENCES, et elles sont voulues :
//   - boosterOnly. occt-import-js ne sait PAS lire l'IFC : retomber sur le WASM
//     ne produirait qu'une erreur incomprehensible. Sans MEDUSA, on le dit.
//   - pas de decoupage Turbo. Le slicer traverse un graphe Part-21 depuis les
//     PRODUCT STEP ; les racines d'un IFC sont ailleurs. MEDUSA avale le
//     fichier entier de toute facon (10,5 Mo / 147 712 entites en 13 s).
async function importIFCMedusa(file) {
  nasFaceColorReset();
  if (!(await _detectBooster())) {
    throw new Error('IFC import needs the MEDUSA engine — start it and try again '
                  + '(unlike STEP there is no browser fallback: the WASM reader does not speak IFC)');
  }
  nasLog('OK', `IFC: ${file.name} (${(file.size/1024/1024).toFixed(1)} MB) — native MEDUSA reader`);
  return _importSTEPSingle(file, { boosterOnly: true, ifc: true });
}
try{ window.importIFCMedusa = importIFCMedusa; }catch(e){}

// ═══════════════════════════════════════════════════════════════════════════
// [29/09] STEP TURBO — lecture exacte d'un gros fichier sans MEDUSA.
//
// Le fichier est découpé par stepSliceAssembly (ci-dessus) en tranches qui
// portent chacune toute la structure d'assemblage et la géométrie d'une partie
// des pièces ; les tranches sont lues en parallèle par le pool de workers OCCT,
// puis leurs maillages passent UNE seule fois dans le pipeline d'import normal
// (_importSTEPSingle) : un seul centrage global, un seul groupe dans l'arbre,
// un seul cache de géométrie pour le fichier entier.
//
// Ce qui a été remplacé : chaque tranche était importée comme un fichier à part
// — recentrée sur SA propre boîte (les pièces de tranches différentes ne se
// retrouvaient donc pas à leur place relative), rangée dans son propre groupe
// « … [chunk k-N].step », puis dédoublonnée par boîte englobante. Mesuré le
// 29/09 sur Stealthburner_CW2 (26,7 Mo, lu par le même occt-import-js) : 684
// corps au lieu de 198 avant déduplication.
//
// Contrôlé le 29/09 avec le même occt-import-js et les réglages de NASSCAD :
// import en tranches = import entier, instance par instance (nom, couleur,
// position, triangle pour triangle) — Rocky_House 161/161 (6 tranches),
// as1-oc-214 et as1_pe_203 18/18 (une pièce par tranche). Stealthburner 198/198
// (même maillage à finesse égale ; en réglage normal, une de ses pièces gonfle
// la boîte d'OCCT et l'import entier maille tout à 15 mm près — en tranches,
// les pièces qui ne la côtoient pas sont maillées plus fin). Là où l'import
// entier échoue, le Turbo lit tout : Cruise_Assembly (42 Mo) 2 873 corps SANS
// UN triangle d'un bloc, tous maillés en tranches ; Scania-8x4 (295 Mo) 1 449
// corps, le compte de MEDUSA ; moteur Scania V8 (374 Mo) 1 295 corps, autant
// que la structure du fichier en déclare, 0 triangle d'un bloc.
// ═══════════════════════════════════════════════════════════════════════════

// Taille visée d'une tranche : ne dépend QUE du fichier (pas de la machine) —
// le même fichier est découpé pareil partout, donc maillé pareil partout.
function _stepTurboChunkTarget(fileBytes){
  return Math.min(32 * 1048576, Math.max(16 * 1048576, Math.ceil(fileBytes / 12)));
}

// Lecture d'une tranche sur le pool. Différence avec _readStepFileUncached :
// un worker dont la lecture a échoué est REMPLACÉ, pas réutilisé — un module
// WASM qui a manqué de mémoire (abort) reste inutilisable, et chaque tranche
// suivante qui tomberait dessus échouerait à son tour.
async function _stepTurboReadChunk(buffer, params){
  const slot = await _stepPoolAcquire();
  if(!slot){
    const occt = await _getOcct();
    try { return occt.ReadStepFile(new Uint8Array(buffer), params); }
    catch(e){ _occtInst = null; throw e; }
  }
  const id = ++_stepJobId;
  const bytes = buffer.byteLength;
  return new Promise((resolve, reject) => {
    const retire = () => { slot.dead = true; slot.ready = false; try { slot.worker.terminate(); } catch(e){ /* déjà arrêté */ } };
    const wdMs = Math.round((_STEP_WORKER_WATCHDOG_BASE || 25 * 60 * 1000)
      + Math.max(0, bytes - 50 * 1048576) / (50 * 1048576) * 60000);
    const tWdog = setTimeout(() => {
      slot.cbs.delete(id); retire();
      reject(new Error(`timeout after ${Math.round(wdMs / 60000)} min`));
    }, wdMs);
    slot.cbs.set(id, {
      resolve: r => { clearTimeout(tWdog); resolve(r); },
      reject:  e => { clearTimeout(tWdog); retire(); reject(e); }
    });
    slot.worker.postMessage({ type: 'read', id, buffer, params }, [buffer]);
  });
}

// Après un Turbo, les workers gardent le tas WASM de leur plus grosse tranche
// (une mémoire WebAssembly ne rétrécit jamais) : plusieurs Go immobilisés pour
// rien. Les workers libres sont arrêtés ; le pool les recrée à la demande.
function _stepPoolTrim(){
  for(const s of _stepPool){
    if(!s || s.dead || s.busy) continue;
    s.dead = true; s.ready = false;
    try { s.worker.terminate(); } catch(e){ /* déjà arrêté */ }
  }
}

// Un corps qui a des faces mais pas un triangle : le maillage a échoué (vu sur
// Cruise_Assembly lu d'un bloc : 2 873 corps, 0 triangle, sans aucune erreur).
function _stepMeshUntriangulated(m){
  const ix = m && m.index && m.index.array;
  return !(ix && ix.length) && !!(m && ((m.brep_faces && m.brep_faces.length) || (m.faces && m.faces.length)));
}
function _stepResultUntriangulated(res){
  const ms = res && res.meshes;
  if(!ms || !ms.length) return false;
  let faced = 0;
  for(const m of ms){
    const ix = m.index && m.index.array;
    if(ix && ix.length) return false;
    if(_stepMeshUntriangulated(m)) faced++;
  }
  return faced > 0;
}

// Ordre final des corps : chemin dans l'arbre d'assemblage (identique dans
// toutes les tranches), puis nom, puis position. Il ne dépend pas du découpage
// — les numéros « _N » des objets sont les mêmes d'une machine à l'autre.
function _stepTurboSortKeys(res){
  const path = new Array(res.meshes.length).fill('');
  const walk = (node, p, depth) => {
    if(!node || depth > 200) return;
    const q = p + '/' + (node.name || '');
    for(const mi of (node.meshes || [])) if(mi >= 0 && mi < path.length) path[mi] = q;
    for(const c of (node.children || [])) walk(c, q, depth + 1);
  };
  walk(res.root, '', 0);
  return res.meshes.map((m, i) => {
    const p = m.attributes && m.attributes.position && m.attributes.position.array;
    let cx = 0, cy = 0, cz = 0;
    if(p && p.length){
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for(let k = 0; k < p.length; k += 3){
        const x = p[k], y = p[k + 1], z = p[k + 2];
        if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; if(z < z0) z0 = z; if(z > z1) z1 = z;
      }
      cx = Math.round((x0 + x1) * 500) / 1000; cy = Math.round((y0 + y1) * 500) / 1000; cz = Math.round((z0 + z1) * 500) / 1000;
    }
    return { m, p: path[i], n: m.name || '', cx, cy, cz };
  });
}

// Coupe d'une tranche en échec : entre pièces tant qu'il y en a plusieurs ;
// dans une pièce seule, seulement si elle est découpable (des solides d'une
// même représentation, cf. stepSliceAssembly), deux solides au moins de chaque
// côté. Sinon null : la pièce est signalée, pas lue de travers.
function _stepTurboSplit(S, seeds){
  const us = S.unitsOfSeeds(seeds);
  if(us.length > 1){
    const first = new Set(us.slice(0, us.length >> 1));
    return [seeds.filter(s => first.has(S.seedUnit(s))), seeds.filter(s => !first.has(S.seedUnit(s)))];
  }
  if(us.length === 1 && S.unitSplittable(us[0]) && seeds.length >= 4){
    const h = seeds.length >> 1;
    return [seeds.slice(0, h), seeds.slice(h)];
  }
  return null;
}

// Décodage d'un gros fichier pour le Turbo. Au-delà de ~512 Mo, une chaîne
// JavaScript ne peut pas le contenir : on le dit, MEDUSA le lit sans ce passage.
function _stepDecodeBig(buffer, file){
  try { return _bytesToLatin1Str(new Uint8Array(buffer)); }
  catch(e){
    throw new Error(`${file.name} (${(file.size / 1048576).toFixed(0)} MB) is too large for the browser reader (${e.message}) — start MEDUSA to import it`);
  }
}

// Lit toutes les tranches du plan. Une tranche qui échoue par manque de mémoire
// (ou rendue sans un triangle) est coupée en deux et relue ; ce qui ne peut pas
// être lu est signalé par le nom de la pièce — jamais perdu en silence.
async function _stepTurboRead(S, params, fileName){
  const queue = S.plan.map((p, i) => ({ seeds: p.seeds, tag: String(i + 1) }));
  const planned = queue.length;
  const maxSplits = planned * 3 + 8;
  const got = [], failed = [];
  let inFlight = 0, done = 0, splits = 0, bodies = 0;
  const t0 = performance.now();
  const conc = Math.max(1, Math.min(_STEP_POOL_MAX, planned));   // un worker par tranche en vol, jamais plus que le pool
  const labels = seeds => {
    const us = S.unitsOfSeeds(seeds);
    return us.slice(0, 4).map(u => S.unitLabel(u)).join(', ') + (us.length > 4 ? `… (${us.length} parts)` : '');
  };
  const progress = () => showSpinner('STEP Turbo',
    `${fileName} — ${done}/${planned + splits} chunk(s) read, ${bodies} bod${bodies > 1 ? 'ies' : 'y'}…`,
    'indeterminate');
  async function loop(){
    for(;;){
      if(!queue.length){
        if(inFlight === 0) return;
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
      const job = queue.shift();
      inFlight++;
      const tj = performance.now();
      try {
        let bytes = _latin1StrToBytes(S.emitSeeds(job.seeds));
        const mb = (bytes.length / 1048576).toFixed(1);
        let res = await _stepTurboReadChunk(bytes.buffer, params);
        bytes = null;
        if(!res || !res.success) throw new Error('the reader returned no result');
        if(_stepResultUntriangulated(res)) throw new Error(`${res.meshes.length} bodies without a single triangle`);
        _srgbNormalizeMeshColors(res);
        const keys = _stepTurboSortKeys(res);
        for(const k of keys) if(k.m.index && k.m.index.array && k.m.index.array.length) got.push(k);
        done++; bodies += keys.length;
        nasLog('DBG', `STEP Turbo: chunk ${job.tag} (${mb} MB, ${job.seeds.length} bodies' geometry) read — `
          + `${res.meshes.length} mesh(es) in ${((performance.now() - tj) / 1000).toFixed(1)} s`);
      } catch(e){
        const msg = (e && e.message) || String(e);
        // Recoupe seulement quand une tranche plus petite a une chance de passer
        // (mémoire, maillage vide) — pas sur un délai dépassé ni une erreur qui
        // se reproduirait à l'identique — et jamais plus de maxSplits fois.
        const halves = (splits < maxSplits && /memory|abort|out of bounds|allocat|enlarge|OOM|crash|RangeError|single triangle|no result/i.test(msg))
          ? _stepTurboSplit(S, job.seeds) : null;
        if(halves){
          queue.unshift({ seeds: halves[0], tag: job.tag + 'a' }, { seeds: halves[1], tag: job.tag + 'b' });
          splits++;
          nasLog('WARN', `STEP Turbo: chunk ${job.tag} failed (${msg}) — split in two and read again`);
        } else {
          failed.push({ label: labels(job.seeds), msg, bodies: job.seeds.length });
          nasLog('ERROR', `STEP Turbo: « ${labels(job.seeds)} » could not be read (${msg})`);
        }
      } finally { inFlight--; }
      progress();
      await _breathe();
    }
  }
  progress();
  await Promise.all(Array.from({ length: conc }, loop));
  _stepPoolTrim();
  got.sort((a, b) => a.p < b.p ? -1 : a.p > b.p ? 1 : a.n < b.n ? -1 : a.n > b.n ? 1
    : (a.cx - b.cx) || (a.cy - b.cy) || (a.cz - b.cz));
  return { success: true, meshes: got.map(k => k.m),
    turbo: { chunks: done, planned, splits, failed, ms: Math.round(performance.now() - t0), workers: conc } };
}

// Découpe + lecture, appelé par _importSTEPSingle avec le texte latin1 du fichier.
async function _stepTurboImportRead(text, fileName, fileBytes, params, perf){
  showSpinner('STEP Turbo', `${fileName} — analyzing the assembly structure…`, 'indeterminate');
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));   // spinner peint avant le calcul synchrone
  const tS = performance.now();
  const target = _stepTurboChunkTarget(fileBytes);
  let S;
  try { S = stepSliceAssembly(text, target); }
  catch(e){
    // Structure non reconnue : lecture d'un bloc, comme avant le Turbo.
    nasLog('WARN', `STEP Turbo: slicing impossible (${e.message}) — the file is read in one go`);
    return _readStepFileUncached(_latin1StrToBytes(text).buffer, params).then(_srgbNormalizeMeshColors);
  }
  const I = S.info;
  _stepPerfMark(perf, 'Turbo slicing', performance.now() - tS,
    `${I.units} parts, ${I.seeds} bodies' geometry, ${S.plan.length} chunks`);
  nasLog('OK', `STEP Turbo: ${fileName} — ${I.units} part(s) spread over ${S.plan.length} chunk(s) of ≈${(target / 1048576).toFixed(target < 10 * 1048576 ? 1 : 0)} MB, `
    + `each carrying the whole assembly structure (${(I.skeletonBytes / 1024).toFixed(0)} KB): every instance is read once, `
    + `in place — sliced in ${((performance.now() - tS) / 1000).toFixed(1)} s`);
  const tR = performance.now();
  const res = await _stepTurboRead(S, params, fileName);
  S.release();
  const T = res.turbo;
  _stepPerfMark(perf, 'parsing (OCCT WASM, Turbo)', performance.now() - tR,
    `${T.chunks} chunks, ${res.meshes.length} bodies, workers ×${T.workers}`);
  nasLog('OK', `STEP Turbo: ${res.meshes.length} bodies read from ${T.chunks} chunk(s) in ${_fmtDur(T.ms)}`
    + (T.splits ? ` — ${T.splits} chunk(s) split and read again` : ''));
  if(T.failed.length){
    const names = T.failed.map(f => f.label).join(' ; ');
    nasLog('ERROR', `STEP Turbo: ${T.failed.length} body(ies) could not be read by the browser reader — ${names}`);
    try { _csgLog(`⚠ ${T.failed.length} body(ies) not imported — start MEDUSA to read them`); } catch(e){}
    _nasAlert(`⚠ STEP Turbo: ${T.failed.length} body(ies) could not be read by the browser reader:\n${names}\n\n`
      + `Everything else was imported. Start MEDUSA to read the whole file natively.`);
  }
  return res;
}

async function importSTEP(file) {
  nasFaceColorReset();   // [11/09] compteurs couleurs par face, remis a zero par import
  // [NEW V4.4.0 03/07] Normalisation conteneur AVANT la décision de slicing : un
  // .stpz de 30 MB peut cacher un Part 21 de 300 MB — la taille pertinente pour le
  // seuil Turbo est celle du payload décompressé, pas celle du conteneur.
  file = await _stepNormalizeFile(file);
  // [29/09] Au-delà du seuil : MEDUSA d'abord (fichier entier, natif), sinon
  // Turbo exact dans le navigateur — les deux décidés dans _importSTEPSingle,
  // APRÈS le cache de géométrie : un gros fichier déjà importé ressort du cache
  // sans être relu ni découpé. (Avant : le repli MEDUSA → découpage n'avait
  // jamais lieu — l'échec de MEDUSA était avalé par _importSTEPSingle, qui
  // affichait une erreur au lieu de passer au Turbo.)
  if (file.size <= _STEP_SLICE_THRESHOLD) return _importSTEPSingle(file);
  return _importSTEPSingle(file, { big: true });
}

async function _importSTEPSingle(file, _impOpts){
  showSpinner((_impOpts && _impOpts.ifc) ? 'Import IFC (MEDUSA)' : 'Import STEP (OCCT)', file.name);
  const t0 = performance.now();
  const _perf = _stepPerfNew(file.name); // [PERF 17/09] cf. _stepPerfReport() dans le finally
  const _stepGroupId = 'stepgrp_' + (++_stepGroupSeq);
  const _seenN = (_stepFilenameSeen.get(file.name) || 0) + 1;
  _stepFilenameSeen.set(file.name, _seenN);
  const _stepGroupLabel = _seenN > 1 ? `${file.name} (${_seenN})` : file.name;
  const _big = !!(_impOpts && _impOpts.big) && !(_impOpts && _impOpts.ifc);
  let _bigText = null, _turboInfo = null;
  try {
    let buffer = await file.arrayBuffer();
    // [NEW V4.2.7 19/06] Détection schéma STEP — diagnostic only, header ASCII en clair
    // (ISO 10303-21). N'influence rien pour l'instant — juste de la visibilité avant
    // d'éventuellement adapter la stratégie de repair par schéma/exportateur plus tard.
    let _stepSchema = '?';
    try {
      const _head = new TextDecoder('ascii').decode(new Uint8Array(buffer, 0, Math.min(4096, buffer.byteLength)));
      const _sm = _head.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
      if(_sm){
        const _proto = _sm[1].toUpperCase();
        // [NEW V4.4.0 03/07] Mapping élargi : les schémas ed2 (AP203e2 s'appelle
        // CONFIGURATION_CONTROL_3D_DESIGN_ED2_MIM_LF — l'ancien test CONFIG_CONTROL_DESIGN
        // ne le matchait pas), AP242 sans préfixe, et AP209 (analyse structurelle).
        if(_proto.includes('AP242') || _proto.includes('MANAGED_MODEL_BASED')) _stepSchema = 'AP242';
        else if(_proto.includes('AUTOMOTIVE_DESIGN')) _stepSchema = 'AP214';
        else if(_proto.includes('CONFIG_CONTROL_DESIGN') || _proto.includes('CONFIGURATION_CONTROL')) _stepSchema = 'AP203';
        else if(_proto.includes('STRUCTURAL_ANALYSIS_DESIGN')) _stepSchema = 'AP209';
        else _stepSchema = _proto.slice(0,40);
      }
    } catch(e){ /* diagnostic only — ne bloque jamais l'import */ }
    nasLog('OK', `STEP schema: ${_stepSchema} — ${file.name}`);
    // [NEW V4.4.0 03/07] Badge AP dans le titre du spinner — l'utilisateur voit ENFIN
    // quel protocole il importe au lieu d'un générique "(OCCT)".
    const _spTitle = 'Import STEP' + (_stepSchema !== '?' ? ' ' + _stepSchema : '') + ' (OCCT)';
    // ══════════════════════════════════════════════════════════════════════
    // [PERF 17/09] CACHE DE GÉOMÉTRIE FINALE — consulté AVANT tout le reste.
    // Le hash est calculé ici, une seule fois, puis resservi plus bas au cache
    // de parsing : deux SHA-256 sur le même buffer, ce serait une seconde
    // perdue sur un gros fichier pour deux résultats identiques.
    // ══════════════════════════════════════════════════════════════════════
    const _tHash0 = performance.now();
    const _hashHex = await _stepDigestHex(buffer);
    _stepPerfMark(_perf, 'file hash', performance.now() - _tHash0,
      `${(buffer.byteLength/1024/1024).toFixed(1)} MB`);
    // [17/09] En mode FreeCAD aucune réparation n'a lieu, MEDUSA présent ou non :
    // le drapeau doit dire ce qui se PASSE, pas ce qui serait possible.
    const _repairApplied = !_STEP_LEAN_IMPORT
      && ((await _detectBooster()) || _STEP_REPAIR_CLIENT_POOL);
    const _gk = _geoCacheKey(_hashHex, _repairApplied);
    if(_gk){
      const _tG0 = performance.now();
      const _gHit = await _geoCacheGet(_gk);
      _stepPerfMark(_perf, 'geometry cache lookup', performance.now() - _tG0, _gHit ? 'HIT' : 'miss');
      if(_gHit){
        try{
          const _tR0 = performance.now();
          const _dec = _nspgDecode(_gHit);
          // Le scan PMI reste nécessaire : l'overlay d'annotations n'est pas de
          // la géométrie de corps, il n'est donc pas dans le NSPG. Il est peu
          // coûteux (0,1 s pour 17 Mo) et se recale sur l'offset global stocké
          // dans l'entrée — c'est pour ça qu'on le stocke.
          _pmiPending = null;
          try { _pmiPending = _pmiScanIfRelevant(buffer, file.name); }
          catch(e){ nasLog('WARN', `PMI scan failed (${e.message}) — import continues without PMI`); }
          const _n = _geoCacheRestore(_dec, file, _stepGroupId, _stepGroupLabel);
          if(_pmiPending && (_pmiPending.annotations.length || _pmiPending.semantics.length)){
            try { _pmiCommit(_pmiPending, _dec.meta.gOx || 0, _dec.meta.gOy || 0, _dec.meta.gOz || 0, _stepGroupLabel); }
            catch(e){ nasLog('WARN', `PMI overlay failed (${e.message})`); }
          }
          _pmiPending = null;
          _stepPerfMark(_perf, 'geometry restore (cache)', performance.now() - _tR0, `${_n} bodies`);
          updProps(); updOList(); updStats();
          const _cms = Math.round(performance.now() - t0);
          if(!_stepTurboBatch){ _lastImportStats = { chunks: 1, ms: _cms, label: file.name }; updStats(); }
          const _cnm = _dec.meta.nonManifoldCount || 0;
          nasLog('OK', `⚡ STEP import from geometry cache: ${_n} mesh(es) — ${_cms} ms `
            + `(no parsing, no sewing, no repair, no smoothing)`
            + (_cnm ? ` — ⚠ ${_cnm} non-manifold` : ''));
          _csgLog(`✓ STEP imported (geometry cache): ${_n} mesh(es)`
            + (_cnm ? ` — ⚠ ${_cnm} non-manifold` : ''));
          nasFaceColorReport();
          return; // l'audit déclaration↔obtenu est sauté : il compare au résultat
                  // du LECTEUR, qui n'a pas tourné. Le dire plutôt que l'inventer.
        }catch(e){
          nasLog('WARN', `Geometry cache entry unreadable (${e.message}) — purged, falling back to a full import`);
          _stepCacheDelete(_gk);
        }
      }
    }
    // [NEW V4.4.0 03/07] Scan PMI + géométrie tessellée — impérativement AVANT le
    // transfert du buffer au Worker (postMessage transfer = ArrayBuffer détaché).
    _pmiPending = null;
    const _tPmi0 = performance.now();
    try { _pmiPending = _pmiScanIfRelevant(buffer, file.name); }
    catch(e){ nasLog('WARN', `PMI scan failed (${e.message}) — import continues without PMI`); }
    _stepPerfMark(_perf, 'PMI scan', performance.now() - _tPmi0);
    // [16/09] Ce que le fichier DÉCLARE, lu avant tout calcul géométrique — et
    // impérativement ici, avant que le transfert au Worker ne détache le buffer.
    // Sans ce relevé, « ⚠ non manifold » est une opinion sans référence ; avec
    // lui, c'est une contradiction chiffrée entre ce que le fichier affirme et
    // ce que l'import a produit. Mesuré : 0,1 s pour 17 Mo, 0,6 s pour 40 Mo —
    // négligeable devant les 28 s et 110 s des imports correspondants.
    _stepDeclared = null;
    _stepAlphaTable = null;
    // [29/09] Gros fichier sans MEDUSA : texte latin1 décodé UNE fois, servi à
    // la passe de déclaration ET au découpage Turbo (nasStepDeclared accepte une
    // chaîne). Avec MEDUSA rien n'est décodé ici : le buffer lui part tel quel.
    const _medusaForBig = _big && await _detectBooster();
    if(_big && !_medusaForBig){
      showSpinner('Import STEP', `${file.name} — reading ${(file.size / 1048576).toFixed(0)} MB…`, 'indeterminate');
      await _breathe();
      _bigText = _stepDecodeBig(buffer, file);
    }
    const _tDecl0 = performance.now();
    try { if(typeof nasStepDeclared === 'function') _stepDeclared = nasStepDeclared(_bigText || buffer); }
    catch(e){ nasLog('WARN', `STEP declaration scan failed (${e.message}) — import continue`); }
    _stepAlphaTable = _stepDeclared;
    if(_stepDeclared && _stepDeclared.styleAlpha){
      const _nA = Object.keys(_stepDeclared.styleAlpha).length;
      if(_nA) nasLog('OK', `STEP declares ${_nA} translucent colour(s) — applied to the bodies painted with them`
        + (_stepDeclared.styleAlphaAmbiguous ? `, ${_stepDeclared.styleAlphaAmbiguous} ambiguous one(s) left opaque` : ''));
    }
    _stepPerfMark(_perf, 'STEP declaration scan', performance.now() - _tDecl0);
    // [NEW V4.2.7p4 20/06] Parsing offloadé vers le Worker OCCT dédié si dispo (gros
    // fichiers multi-corps sans geler l'UI) — fallback to main-thread transparent sinon.
    if(file.size > 20*1024*1024)
      nasLog('DBG', `Large STEP file (${(file.size/1024/1024).toFixed(1)} MB) — import may take several minutes, UI non-blocking if Worker available`);
    // [NEW V4.2.7p4 20/06] Barre indéterminée pendant le parsing — AUCUN callback de
    // progression possible côté occt-import-js (vérifié dans son source : ReadStepFile
    // est un appel opaque, un seul résultat en sortie, rien entre les deux). Plutôt qu'un
    // % inventé, on confirme juste que c'est vivant : scanner + chrono générique du spinner
    // [NEW V4.4.0] (le mm:ss était auparavant recalculé à la main ici en doublon — supprimé
    // au profit du chrono générique showSpinner()/hideSpinner(), qui couvre aussi tous les
    // autres imports/opérations).
    // [NEW] Message différencié selon le chemin réel : si MEDUSA est détecté, la
    // progression EXISTE (barre TESSELLATION dans la fenêtre serveur + streaming des
    // corps dès la fin du parsing) — l'ancien libellé "opaque lib" devenait faux et
    // troublant. Le cas vraiment opaque (occt-import-js WASM, aucun callback exposé,
    // vérifié dans son source) ne subsiste que quand le serveur natif est absent.
    if(_boosterState){
      showSpinner(_spTitle, `${file.name} — MEDUSA: parsing file…`, 'indeterminate');
    }else{
      showSpinner(_spTitle, `${file.name} — parsing OCCT… (no progress % available — opaque lib)`, 'indeterminate');
    }
    let result;
    // [PERF 17/09] Déflexion et angle passés EXPLICITEMENT. Avant, seul
    // linearUnit était transmis : occt-import-js appliquait donc ses défauts
    // (ratio bbox 0.001 / 0.5 rad) sans que rien, côté NASSCAD, ne le dise ni
    // ne permette de le régler. Cf. _STEP_WASM_DEFLECTION pour le pourquoi du
    // nouveau défaut. MEDUSA ignore ces champs (il POSTe le buffer brut).
    const _rdParams = { linearUnit:'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection:  _STEP_WASM_DEFLECTION,
      angularDeflection: _STEP_WASM_ANGULAR,
      boosterOnly: !!(_impOpts && _impOpts.boosterOnly),
      ifc:         !!(_impOpts && _impOpts.ifc) };
    if(_big){
      // [NEW V4.7.1 → 29/09] Gros fichier : MEDUSA lit le fichier ENTIER s'il
      // est là (fidélité complète, validé 235 MB / 107k faces en ~113 s) ;
      // sinon, ou s'il échoue, Turbo exact dans le navigateur.
      if(_medusaForBig){
        nasLog('OK', `⚡ Turbo bypass: ${file.name} (${(file.size/1024/1024).toFixed(1)} MB) — whole file to native MEDUSA, zero slicing`);
        try { result = await _readStepFileOffloaded(buffer, Object.assign({}, _rdParams, { boosterOnly: true }), _perf, _hashHex); }
        catch(e){ result = null; nasLog('WARN', `Turbo bypass: MEDUSA failed (${e.message}) — STEP Turbo in the browser`); }
      }
      if(!result){
        if(!_bigText) _bigText = _stepDecodeBig(buffer, file);
        buffer = null;   // plus utile : le Turbo travaille sur le texte
        result = await _stepTurboImportRead(_bigText, file.name, file.size, _rdParams, _perf);
        _turboInfo = result.turbo;
      }
      _bigText = null;
    } else {
      // [29/09] Lecture d'un bloc ; si le lecteur WASM n'y arrive pas (mémoire
      // épuisée, ou corps rendus sans un triangle — Cruise_Assembly, 42 Mo), le
      // même fichier est relu en tranches par le Turbo au lieu d'échouer.
      const _isIfc = !!(_impOpts && _impOpts.ifc);
      try {
        result = await _readStepFileOffloaded(buffer, _rdParams, _perf, _hashHex);
      } catch(e){
        if(_isIfc || (_impOpts && _impOpts.boosterOnly)
           || !/memory|abort|out of bounds|allocat|enlarge|OOM|crash|RangeError/i.test(String(e && e.message))) throw e;
        nasLog('WARN', `STEP: the browser reader could not read ${file.name} in one go (${e.message}) — reading it again in slices (Turbo)`);
        result = null;
      }
      if(!_isIfc && result && _stepResultUntriangulated(result)){
        nasLog('WARN', `STEP: the reader returned ${result.meshes.length} bodies without a single triangle — reading ${file.name} again in slices (Turbo)`);
        result = null;
      }
      if(!result){
        const _sb = await _stepLoadTextBuffered(file);
        try { result = await _stepTurboImportRead(_sb.text, file.name, file.size, _rdParams, _perf); }
        finally { await _sb.cleanup(); }
        _turboInfo = result.turbo;
      }
    }
    if(!result.success || !result.meshes || !result.meshes.length){
      // [NEW V4.4.0 03/07] Fallback solide tessellé AP242 — occt-import-js ignore les
      // TESSELLATED_SOLID/SHELL (ReadStepFile → success:true, meshes:0, vérifié en Node
      // sur nist_ftc_08_asme1_ap242-e1-tg.stp). Le scanner PMI a déjà décodé les
      // COMPLEX_TRIANGULATED_FACE en pur JS → meshes synthétisés au format occt-import-js,
      // tout le pipeline aval (sewing, centrage, smooth, groupes) inchangé.
      if(_pmiPending && _pmiPending.tessMeshes && _pmiPending.tessMeshes.length){
        nasLog('OK', `STEP tessellated AP242: ${_pmiPending.tessMeshes.length} body(ies) decoded in pure JS (occt-import-js returned nothing)`);
        result = { success: true, meshes: _pmiPending.tessMeshes };
      } else
        throw new Error('No geometry found in the STEP file');
    } else if(_pmiPending && _pmiPending.tessMeshes && _pmiPending.tessMeshes.length){
      // [FIX 28/09 — audit] Fichier MIXTE (B-Rep + tessellé). occt-import-js et
      // OCCT < 7.7 rendent les corps B-Rep mais ignorent les TESSELLATED_SOLID :
      // nos propres exports AP242 (cylindres, cônes, résultats CSG) perdaient ces
      // corps sans un mot. Ceux que le lecteur n'a pas rendus sont complétés ici
      // depuis le décodage JS — pour un fichier NASSCAD seulement (coordonnées
      // monde, noms uniques) ; ailleurs on prévient au lieu de deviner.
      const _miss = _stepTessMissing(result.meshes, _pmiPending.tessMeshes);
      if(_miss.length){
        const _names = _miss.slice(0, 6).map(m => m.name || '?').join(', ') + (_miss.length > 6 ? '…' : '');
        if(_pmiPending.nasscadWriter){
          result = Object.assign({}, result, { meshes: result.meshes.concat(_miss) });
          nasLog('OK', `STEP tessellated AP242: ${_miss.length} body(ies) not returned by the reader — decoded in pure JS and added (${_names})`);
        } else {
          nasLog('WARN', `STEP: ${_miss.length} AP242 tessellated body(ies) not read by this reader (${_names}) — start MEDUSA (OCCT 7.7 or later) to import them`);
          try { _csgLog(`⚠ ${_miss.length} tessellated body(ies) not imported — start MEDUSA`); } catch(e){}
        }
      }
    }
    undoPush('import');
    // STEP Z-up → Three.js Y-up : X→X, Z→Y(up), -Y→Z
    // Structure occt-import-js : attributes.position.array (vertices) + index.array (indices)
    let nonManifoldCount = 0, meshCount = 0;
    if(!_ppSlot || !_ppSlot.ready) _initPPWorker(); // requis par postProcessCSGGeo (BFS smooth)
    // [FIX V4.2.7 19/06] Race condition découverte par Nass (premier import après chargement
    // de page) : _initPPWorker() ne fait que LANCER l'init du worker, sans attendre qu'il
    // poste 'ready'. Si le smooth BFS (postProcessCSGGeo, pass 2 plus bas) est atteint avant
    // que le worker ait fini de charger, _dispatchPPJob rejette immédiatement ("PP Worker not
    // ready") → fallback sur computeVertexNormals() plat → shading facetté ("acné"), alors que
    // rien n'est cassé dans le pipeline, le worker était juste pas encore prêt. Attente bornée
    // (poll 50ms, 5s max) — n'affecte que le tout premier import d'une session fraîche, les
    // imports suivants trouvent _ppSlot.ready déjà true et ne bouclent même pas une fois.
    if(_ppSlot && !_ppSlot.ready){
      const _ppWaitT0 = performance.now();
      await new Promise(resolve=>{
        const _iv = setInterval(()=>{
          if(!_ppSlot || _ppSlot.ready){ clearInterval(_iv); resolve(); }
        }, 50);
        setTimeout(()=>{ clearInterval(_iv); resolve(); }, 5000);
      });
      if(_ppSlot && !_ppSlot.ready)
        nasLog('WARN', `PP Worker still not ready after 5s — smooth BFS will fall back to flat`);
      else
        nasLog('DBG', `PP Worker ready after ${Math.round(performance.now()-_ppWaitT0)}ms wait (first import of session)`);
    }
    // [NEW 11/08] Bornes de phase chronometrees — cf. discussion perf Phase 2a
    // (concurrent depuis cette session) : sans ca, sewing (synchrone, non touche)
    // et repair (concurrent desormais) sont indissociables dans nasLog, aucune
    // ligne n'etant emise sur un repair REUSSI (seul l'echec logue). Meme
    // convention que [perf-csg] existant dans _workerCSG.
    const _tSewStart = performance.now();
    const _stepGeos = []; // pass 1 : collecte — centrage global en pass 2 (fix positions assemblage)
    const _p1Total = result.meshes.length;
    let _p1LastBreath = performance.now();
    let _p1i = 0;
    for(const m of result.meshes){
      _p1i++;
      // [NEW V4.2.7p4 20/06] Respiration périodique — pass 1 est 100% synchrone (sewing,
      // bbox, edge-check), sans ça 1000+ corps d'affilée = navigateur qui ne respire jamais
      // entre deux frames, même si techniquement non-bloquant au sens JS pur.
      if(performance.now() - _p1LastBreath > 16){
        showSpinner('NSTP → Three.js', `${file.name} — sewing ${_p1i}/${_p1Total}`, _p1i/_p1Total);
        await _breathe();
        _p1LastBreath = performance.now();
      }
      const posArr = m.attributes?.position?.array;
      const idxArr = m.index?.array;
      if(!posArr || !posArr.length || !idxArr || !idxArr.length) continue;
      // Transform vertices STEP Z-up → Three Y-up
      const verts = new Float32Array(posArr.length);
      for(let i=0; i<posArr.length; i+=3){
        verts[i]  = posArr[i];        // X→X
        verts[i+1]= posArr[i+2];      // Z→Y (up)
        verts[i+2]= -posArr[i+1];     // -Y→Z
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idxArr), 1));
      // ── [17/09] IMPORT LÉGER ─────────────────────────────────────────────
      // On garde ce qu'OCCT a produit : sa triangulation, son ordre de faces,
      // et ses normales quand il les fournit. Rien d'autre n'est touché.
      // Les normales subissent la MÊME bascule Z-up→Y-up que les sommets —
      // une normale est un vecteur, la rotation s'y applique à l'identique
      // (rotation pure, pas de mise à l'échelle : pas de matrice inverse
      // transposée à sortir).
      let isManifold = null;   // null = non évalué, cf. nasEnsureManifold côté host
      if(_STEP_LEAN_IMPORT){
        const _nSrc = m.attributes?.normal?.array;
        if(_nSrc && _nSrc.length === posArr.length){
          const _nrm = new Float32Array(_nSrc.length);
          for(let i=0; i<_nSrc.length; i+=3){
            _nrm[i]   = _nSrc[i];
            _nrm[i+1] = _nSrc[i+2];
            _nrm[i+2] = -_nSrc[i+1];
          }
          geo.setAttribute('normal', new THREE.BufferAttribute(_nrm, 3));
        }
      } else {
        // [CLEANUP V4.2.7 19/06] Injection normales OCCT SUPPRIMÉE — plus aucun consommateur
        // depuis le retrait du moyennage dans _weldAndCheckManifold (cf. ce fichier, plus haut).
        // Le lissage final vient exclusivement de postProcessCSGGeo (BFS, position+index).
        // Sewing adaptatif : 0.001mm → 0.01mm → 0.1mm
        // Couvre les gaps SolidWorks/Parasolid (>0.001mm) et la dérive Float32 grands assemblages.
        // Chaque retry repart du buffer original (le weld modifie geo en place).
        // Bbox protection : maxSewTol limité à minDim/3 — évite de coller les faces
        // opposées d'objets ultra-minces (ex: disque 0.01mm : tol=0.1mm les collapse).
        const _sP = new Float32Array(geo.attributes.position.array);
        const _sI = geo.index  ? new Uint32Array(geo.index.array)             : null;
        const _sN = geo.attributes.normal ? new Float32Array(geo.attributes.normal.array) : null;
        const _rG = () => {
          geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(_sP), 3));
          if(_sI) geo.setIndex(new THREE.BufferAttribute(new Uint32Array(_sI), 1));
          if(_sN) geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(_sN), 3));
        };
        // minDim = plus petite dimension de la bbox → plafond de la tol adaptative
        const _bb0 = new THREE.Box3().setFromBufferAttribute(geo.attributes.position);
        const _sz0 = new THREE.Vector3(); _bb0.getSize(_sz0);
        const _minDim = Math.min(_sz0.x, _sz0.y, _sz0.z);
        // maxSewTol : tol (1/2/3) max autorisée pour éviter le collapse
        // _minDim ≥ 0.3mm → tol jusqu'à 0.1mm ok  (maxSewTol=1)
        // _minDim ≥ 0.03mm → tol jusqu'à 0.01mm ok (maxSewTol=2)
        // _minDim < 0.03mm → pas de retry           (maxSewTol=3, tol=3 seulement)
        const _maxSewTol = _minDim >= 0.3 ? 1 : _minDim >= 0.03 ? 2 : 3;
        let _sTol = 3;
        isManifold = _weldAndCheckManifold(geo, 3);
        // [NEW] Breathe AVANT chaque retry, pas seulement entre meshes : sur un gros mesh
        // (centaines de milliers de vertices), _weldAndCheckManifold hache via toFixed()
        // — coûteux — et peut à elle seule dépasser largement les 16ms du throttle du haut
        // de boucle. Jusqu'à 3 passes d'affilée (tol 3→2→1) sans pause = le vrai responsable
        // des gels de plusieurs dizaines de secondes constatés (chrono spinner y compris —
        // il est calculé depuis performance.now(), donc jamais "faux", juste incapable de
        // se rafraîchir tant que le thread unique ne respire pas). Coupe le bloc en tranches.
        if(!isManifold && _sTol > _maxSewTol){ await _breathe(); _rG(); _sTol=2; isManifold = _weldAndCheckManifold(geo, 2); }
        if(!isManifold && _sTol > _maxSewTol){ await _breathe(); _rG(); _sTol=1; isManifold = _weldAndCheckManifold(geo, 1); }
        if(_sTol < 3) nasLog('DBG', `STEP sewing adaptatif tol=${_sTol} (${[,'0.1','0.01','0.001'][_sTol]}mm) — ${m.name||'?'} — minDim=${_minDim.toFixed(3)}mm`);
        // Skip micro-meshes non-manifold : annotations/GD&T AP242 parasites (< 20 tris)
        const _nTri = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
        if(!isManifold && _nTri < 20){
          nasLog('DBG', `STEP skip micro-mesh non-manifold : ${m.name||'?'} (${_nTri} tris)`);
          continue;
        }
        if(!isManifold) nonManifoldCount++;
        // [NEW V4.2.7 19/06] Diagnostic trous résiduels — cf. instrumentation _weldAndCheckManifold.
        // Mesure empirique avant de décider si un hole-filling (boundary-loop+triangulation) est
        // justifié : combien d'arêtes à nu, et où (bbox), une fois la cascade de sewing épuisée.
        if(!isManifold && geo._nakedEdges){
          const _bb=geo._gapBBox;
          nasLog('DBG', `STEP gap residual — ${m.name||'?'} : ${geo._nakedEdges} naked edge(s)`
            + (geo._overEdges?`, ${geo._overEdges} over-valenced edge(s)`:'')
            + ` — bbox [${_bb.min.map(v=>v.toFixed(4)).join(',')}] → [${_bb.max.map(v=>v.toFixed(4)).join(',')}]`);
        }
        // [NEW V4.2.7 19/06] Tentative de cap (boundary-loop + ear-clip planaire) — cf.
        // _capStepGaps. Best-effort : seules les boucles fermées quasi-planes sont comblées,
        // tout le reste reste inchangé (CSG désactivé comme aujourd'hui). Validé sur
        // boxy_with_cylindricity.stp (NIST AP214) avant ce patch.
        if(!isManifold && geo._nakedEdgePairs && geo._nakedEdgePairs.length){
          await _breathe(); // idem — _capStepGaps refait un _edgeManifoldCheck complet
          // [TEST CAP 16/09 — À REMETTRE EN ÉTAT] bouche-trou neutralisé.
          // On cherche à savoir si le « soudage en surface » des lumières vient d'ici :
          // _capStepGaps ferme toute boucle de bord quasi-plane, sans pouvoir distinguer
          // un jour laissé par la tessellation d'une ouverture voulue par le concepteur.
          // Retirer le `false &&` pour rétablir. Original : if(_capStepGaps(geo)){
          // [RESTAURÉ 17/09] le `false &&` du test du 16/09 est remplacé par un
          // interrupteur nommé : _STEP_CAP_GAPS = false refait le test sans patch.
          if(_STEP_CAP_GAPS && _capStepGaps(geo)){
            isManifold = true; nonManifoldCount--;
            nasLog('DBG', `STEP gap filled — ${m.name||'?'} : mesh now watertight`);
          }
        }
      }
      _stepGeos.push({ geo, mName: m.name, mColor: m.color, mFaces: m.faces, isManifold, mRef: m.ref });
    }
    // ── Pass 2 : centrage GLOBAL — une seule translation identique pour tous les corps.
    // Les vertices occt-import-js sont en coordonnées world STEP (Z-up, déjà converties Y-up).
    // L'ancien centrage individuel détruisait les positions relatives. Fix V4.2.7p2.
    if(_stepGeos.length){
      const _gBB = new THREE.Box3();
      _stepGeos.forEach(({geo}) => { geo.computeBoundingBox(); _gBB.union(geo.boundingBox); });
      const _gOx = -(_gBB.min.x + _gBB.max.x) * 0.5;
      const _gOy =  -_gBB.min.y;
      const _gOz = -(_gBB.min.z + _gBB.max.z) * 0.5;
      const _impObjs = [];

      nasLog('DBG', `[perf-step] sewing: ${(performance.now()-_tSewStart).toFixed(0)}ms — ${_stepGeos.length} body(ies)`);
      _stepPerfMark(_perf, 'sewing + manifold check', performance.now() - _tSewStart,
        `${_stepGeos.length} bodies (main thread)`);
      const _tRepairStart = performance.now();

      // ── Phase 2a : offset global + reparation manifold, PAR CORPS.
      // [11/08] Deux chemins desormais, meme logique que Phase 2b (smoothing) :
      // (1) rapide — _repairBatch, MEDUSA natif en un seul appel, thread par
      // coeur serveur ; (2) repli — pool client concurrent (session precedente,
      // ×_POOL_SIZE() en vol, cf. _p2Worker plus bas), inchangé, jamais retire.
      // Mesure Scania-Engine-V8-XT-Turbo (1297 corps) qui a motive (2) : pool
      // client = 234.6s. (1) vise a repasser sous le smoothing (17.5s, meme lot,
      // meme classe de probleme) — a confirmer par un run reel, pas suppose ici.
      const _p2Total = _stepGeos.length;
      const _repaired = new Array(_p2Total);

      // Translation globale : faite UNE fois ici (avant les deux chemins),
      // plutot que dans _p2Worker comme avant cette restructuration — evite
      // de la dupliquer entre chemin MEDUSA et chemin pool-client.
      for(const s of _stepGeos) s.geo.translate(_gOx, _gOy, _gOz);

      // [17/09] En mode FreeCAD on ne répare RIEN à l'import — pas même par
      // MEDUSA (33,8 s mesurées sur le Scania). FreeCAD n'a pas d'équivalent de
      // cette étape : sa réparation, quand elle a lieu, est une opération que
      // l'utilisateur demande. On tombe donc dans la branche « différé ».
      const _mrGeos = _STEP_LEAN_IMPORT ? null
                    : (_p2Total ? await _repairBatch(_stepGeos.map(s => s.geo)) : []);
      let _p2Path;
      if(_mrGeos){
        // Chemin MEDUSA reussi : re-check manifold par corps. Synchrone et
        // rapide (_edgeManifoldCheck est un comptage d'aretes JS, pas une
        // operation Manifold) — pas besoin de dispatch worker pour ca.
        _p2Path = 'medusa';
        for(let _i = 0; _i < _p2Total; _i++){
          const { mName, mColor, isManifold: _isManifold0 } = _stepGeos[_i];
          let isManifold = _isManifold0;
          const _geoRepaired = _mrGeos[_i];
          if(_geoRepaired.index){
            const _rc = _edgeManifoldCheck(_geoRepaired.index.array, _geoRepaired.attributes.position.array);
            if(_rc.manifold !== isManifold){
              if(_rc.manifold) nonManifoldCount--;
              isManifold = _rc.manifold;
            }
          }
          _repaired[_i] = { geoRepaired: _geoRepaired, mName, mColor, isManifold };
        }
        if(_p2Total) showSpinner('Import STEP (OCCT)', `${file.name} — repair ${_p2Total}/${_p2Total}`, 0.5);
      } else if(!_STEP_REPAIR_CLIENT_POOL){
        // ── [PERF 17/09] RÉPARATION DIFFÉRÉE — MEDUSA absent et pool client
        // désactivé (cf. _STEP_REPAIR_CLIENT_POOL pour la mesure qui motive ce
        // défaut). On garde la géométrie SOUDÉE telle quelle : c'est exactement
        // ce que la phase 2b fait déjà, sans discussion, pour tous les corps
        // multicolores (« la réparation existe pour rendre un corps utilisable
        // par le CSG, pas pour l'afficher »). Les corps restent marqués
        // non-manifold ; _manifoldRepair sera appelé par le CSG au moment où il
        // en aura réellement besoin.
        _p2Path = 'deferred';
        for(let _i = 0; _i < _p2Total; _i++){
          const { geo, mName, mColor, isManifold } = _stepGeos[_i];
          _repaired[_i] = { geoRepaired: geo, mName, mColor, isManifold };
        }
        if(_p2Total) nasLog('OK', `STEP repair deferred — ${_p2Total} bodies shown exactly as OCCT produced them `
          + `(repaired on demand, at the first CSG). Set `
          + (_STEP_LEAN_IMPORT ? `NASSCAD_STEP_TUNING.leanImport = false`
                               : `NASSCAD_STEP_TUNING.repairClientPool = true`)
          + ` to repair at import time like before.`);
      } else {
        // ── Repli : pool client concurrent — IDENTIQUE a la session precedente,
        // sauf geo.translate() retire (deja fait ci-dessus, une seule fois).
        // [NEW 11/08, session precedente] Etait sequentiel avant ca — "_manifoldRepair
        // reste sequentiel, hors scope de ce chantier" (commentaire d'origine,
        // chantier smoothing du 20/06). Dispatch pull-based : _p2Limit "workers
        // logiques" tirent sur un curseur partage (_p2Next) jusqu'a epuisement —
        // plafonne le nombre de paires vertsA/vertsB dupliquees en vol (cf.
        // _manifoldRepair) a _POOL_SIZE() plutot que les 1297 d'un coup. Ordre de
        // _repaired preserve par ECRITURE INDEXEE (pas push) — Phase 2c zippe
        // _repaired[_i] avec _smoothGeos[_i] par index, l'ordre d'arrivee (fin
        // de worker) n'est pas l'ordre de depart. Compteurs partages (_p2i,
        // nonManifoldCount) : lus/ecrits uniquement sur le thread principal (un
        // seul thread JS malgre le parallelisme worker), aucune race condition.
        _p2Path = `client-pool`;
        let _p2LastBreath = performance.now();
        let _p2i = 0;
        const _p2Limit = Math.max(1, _POOL_SIZE());
        let _p2Next = 0;
        async function _p2Worker(){
          while(_p2Next < _p2Total){
            const _myIdx = _p2Next++;
            const { geo, mName, mColor, isManifold: _isManifold0 } = _stepGeos[_myIdx];
            let isManifold = _isManifold0; // [FIX V4.2.7p4 20/06] était `const` via déstructuration —
            // réassigné plus bas (`isManifold = _rc.manifold`) → TypeError à chaque réparation
            // manifold réussie. Bug pré-existant, pas lié au offload Worker.
            // [FIX V4.2.7p] Winding-fix supprimé : normales moyennées post-sewing
            // invalides aux vertices de couture → triangles flippés à tort → babos
            // visuels + WASM "Not manifold". BFS smooth recalcule depuis les positions.
            // [NEW V4.2.7 19/06] Auto-union Manifold avant smooth — cf. _manifoldRepair.
            // [RELAX V4.2.7 19/06] Tenté désormais MÊME si isManifold===false (sur demande Nass,
            // "ne pas disabler, histoire de voir") — testé empiriquement (manifold-3d npm) qu'un
            // mesh non-manifold/auto-intersectant ne fait que lever 'Not manifold' en quelques ms,
            // module 100% réutilisable après, jamais de hang observé (chaos pur 5000 tris inclus).
            // _manifoldRepair a déjà son propre try/catch + fallback silencieux sur le geo d'origine
            // — gain potentiel : Manifold répare parfois des cas que notre check edge-count rejette
            // à tort. Réserve : non re-testé sur le manifold_worker.js RÉEL de Nass (vs npm) — si un
            // hang apparaît malgré tout, le watchdog (_wdogMs, 120s+) reste le filet de sécurité.
            const _geoRepaired = await _manifoldRepair(geo);
            // Re-check : Manifold peut avoir réparé un objet qu'on jugeait non-manifold (ou pas —
            // fallback silencieux = geo inchangé, le check retombe alors sur le même résultat).
            if(_geoRepaired.index){
              const _rc = _edgeManifoldCheck(_geoRepaired.index.array, _geoRepaired.attributes.position.array);
              if(_rc.manifold !== isManifold){
                if(_rc.manifold) nonManifoldCount--;
                isManifold = _rc.manifold;
              }
            }
            _repaired[_myIdx] = { geoRepaired: _geoRepaired, mName, mColor, isManifold };
            _p2i++;
            // [NEW V4.2.7p4 20/06] Idem pass 1 : les await ici se résolvent par microtask
            // (callback Worker) — une chaîne de microtasks peut affamer le rendu même si
            // chaque await "rend la main". Respiration explicite par macrotask en plus.
            if(performance.now() - _p2LastBreath > 16){
              showSpinner('Import STEP (OCCT)', `${file.name} — repair ${_p2i}/${_p2Total}`, (_p2i/_p2Total) * 0.5);
              await _breathe();
              _p2LastBreath = performance.now();
            }
          }
        }
        // [NEW, session precedente] _p2Limit instances concurrentes de _p2Worker,
        // chacune boucle jusqu'a epuisement du curseur partage _p2Next — equivalent
        // fonctionnel d'un pool de _p2Limit "threads logiques" cote main thread, le
        // vrai calcul restant dans les Web Workers (main thread jamais bloque).
        await Promise.all(Array.from({length: Math.min(_p2Limit, _p2Total)}, _p2Worker));
        if(_p2Total) showSpinner('Import STEP (OCCT)', `${file.name} — repair ${_p2Total}/${_p2Total}`, 0.5);
      }
      nasLog('DBG', `[perf-step] repair: ${(performance.now()-_tRepairStart).toFixed(0)}ms — ${_p2Total} body(ies), path=${_p2Path}, ${nonManifoldCount} still non-manifold`);
      _stepPerfMark(_perf, 'manifold repair', performance.now() - _tRepairStart,
        `path=${_p2Path}, ${nonManifoldCount} still non-manifold`);

      // ── Phase 2b : lissage BFS — UN SEUL appel batch (MEDUSA natif si dispo,
      // N corps en parallèle serveur ; repli séquentiel JS identique à l'ancien
      // comportement sinon, cf. _smoothBatch). C'est ICI que le goulot des
      // 1449 corps séquentiels disparaît. ──────────────────────────────────
      showSpinner('Import STEP (OCCT)', `${file.name} — smoothing ${_repaired.length} body(ies)…`, 0.5);
      await _breathe();
      // ── [27/08] Corps multicolores : on garde la géométrie NON réparée ──────
      // L'union Manifold reconstruit entièrement le maillage, donc l'ordre des
      // triangles, donc les plages d'index qui portent les couleurs par face.
      // Le soudage (_weldAndCheckManifold, remap de sommets uniquement), le
      // gap-fill (_capStepGaps, ajout en fin de buffer) et le lissage BFS
      // (out.idx[f*3+vi], face par face) préservent cet ordre — l'union est le
      // seul étage qui le détruit.
      //
      // On la saute donc pour ces corps. Ce n'est pas une régression : la
      // réparation existe pour rendre un corps utilisable par le CSG, pas pour
      // l'afficher. Un corps multicolore non étanche reste marqué non-manifold
      // et le CSG le réparera au moment où il en aura besoin — au prix de ses
      // couleurs par face à cet instant-là, ce qui est le bon arbitrage : on
      // n'abîme le rendu que quand l'utilisateur demande une booléenne.
      for(let _i = 0; _i < _p2Total; _i++){
        const _f = _stepGeos[_i] && _stepGeos[_i].mFaces;
        if(!_f || !_repaired[_i]) continue;
        _repaired[_i].mFaces      = _f;
        _repaired[_i].geoRepaired = _stepGeos[_i].geo;
      }

      // [17/09] Le lissage BFS n'existe que pour REMPLACER les normales qu'on
      // jetait. Quand la source les fournit — occt-import-js les calcule via
      // Poly_Triangulation::ComputeNormals, donc depuis la SURFACE et non depuis
      // les triangles — elles sont exactes, déjà là, et meilleures que toute
      // heuristique d'angle de crête. C'est exactement ce que fait FreeCAD.
      // Le chemin MEDUSA ne les transporte pas encore dans le NSTP : il garde
      // donc le lissage natif, qui coûte 1,5 s pour 1449 corps — trop peu cher
      // pour justifier une migration de protocole.
      const _tSmooth0 = performance.now();
      const _srcGeos = _repaired.map(r => r && r.geoRepaired);
      const _haveNormals = _STEP_LEAN_IMPORT && _srcGeos.length
        && _srcGeos.every(g => g && g.attributes && g.attributes.normal);
      const _smoothGeos = _haveNormals ? _srcGeos : await _smoothBatch(_srcGeos, 30);
      _stepPerfMark(_perf, _haveNormals ? 'smoothing (skipped — OCCT normals)' : 'BFS smoothing',
        performance.now() - _tSmooth0, `${_repaired.length} bodies`);
      const _tBuild0 = performance.now();

      // ── Phase 2c : construction des meshes + enregistrement objets NASSCAD
      // (logique métier inchangée, juste déplacée hors de la boucle repair) ──
      const _cacheBodies = []; // [PERF 17/09] matière du cache NSPG, cf. plus bas
      let _nColoured = 0;      // [18/09] corps dont la COULEUR vient du lecteur, pas de la palette
      for(let _i = 0; _i < _repaired.length; _i++){
        const { mName, mColor, isManifold, mFaces } = _repaired[_i];
        const geoSmooth = _smoothGeos[_i];
        objCnt++;
        // Couleur STEP (occt-import-js m.color {r,g,b,a} 0–1) si dispo, sinon palette COL[]
        //
        // [28/08 FIX — "hex.slice is not a function"] Cette ligne produisait un
        // NOMBRE (0xRRGGBB) alors que TOUS les autres chemins de creation d'objet
        // — primitives, palette COL[], step-xcaf.js, setCol() — mettent une
        // CHAINE '#rrggbb' dans o.color. Un seul champ, deux types selon que le
        // fichier STEP portait une couleur ou non.
        //
        // Consequence observee ce jour, sur le tout premier CSG lance sur un corps
        // STEP colore : _softenColor(o.color) fait hex.slice(1,3) et explose. Le
        // booleen avait pourtant reussi cote MEDUSA (30 verts, 56 tris, 0,6 ms) —
        // c'est la construction du mesh resultat, en aval, qui jetait tout.
        // Invisible jusqu'ici parce qu'aucun CSG n'avait encore ete lance sur un
        // import STEP : les primitives, elles, ont toujours eu une chaine.
        //
        // Deux endroits du code contournaient deja le probleme avec un
        // `typeof c.color==='string' ? ... : ...` — le symptome etait donc connu
        // sans que la cause le soit. On normalise ici, a la source, pour que
        // l'invariant "o.color est une chaine '#rrggbb'" soit enfin vrai partout.
        let col;
        if(mColor && mColor.r !== undefined){
          _nColoured++;
          const _cr=Math.round(mColor.r*255),_cg=Math.round(mColor.g*255),_cb=Math.round(mColor.b*255);
          col = '#' + (((_cr<<16)|(_cg<<8)|_cb) >>> 0).toString(16).padStart(6,'0');
        } else { col = COL[objCnt % COL.length]; }
        // [27/08] Couleurs par face — implémentation partagée avec step-xcaf.js.
        // [18/09] _stepAlphaOf : opacité déclarée par le fichier pour cette
        // teinte. Aucun lecteur (MEDUSA, occt-import-js, cache) ne transporte
        // d'alpha ; la table vient de la passe de déclaration, faite plus haut
        // sur le texte, et vaut 1 partout si le fichier n'a pas de transparence.
        const _faceMats = _applyFaceColors(geoSmooth, mFaces, mName, _stepAlphaOf);
        // [11/09] La couleur du CORPS doit s'accorder avec ce qui est peint.
        // _adoptBrepFaces et _xcafFaceColors le font déjà chacun de leur côté,
        // mais le chemin MEDUSA ne passe par NI l'un NI l'autre : la table de
        // faces arrive telle quelle dans le NSTP et o.color reste la couleur de
        // niveau SOLIDE du fichier. D'où un corps rendu gris acier avec une
        // pastille jaune #dddd0d dans l'Object List. Ici, c'est le seul point
        // par où passent les TROIS chemins.
        if(_faceMats){
          const _dom = _dominantFaceHex(mFaces);
          if(_dom !== null){
            const _domHex = '#' + _dom.toString(16).padStart(6,'0');
            if(_domHex !== col){
              nasLog('DBG', `[face-color] body colour aligned on the dominant face colour — ${mName||'?'} : ${col} -> ${_domHex}`);
              col = _domHex;
            }
          }
        }
        if(_faceMats){
          nasLog('DBG', `STEP per-face colors — ${mName||'?'} : ${mFaces.length} face(s), `
            + `${new Set(_faceMats.map(m=>m.color.getHex())).size} color(s), ${geoSmooth.groups.length} draw group(s)`);
        }
        // [19/09] L'opacite du LECTEUR l'emporte sur la table de declaration.
        // Le commentaire ci-dessus datait d'avant le 18/09 : MEDUSA transporte
        // desormais `a` dans le NSTP (SURFACE_STYLE_RENDERING cote STEP,
        // IfcSurfaceStyleRendering cote IFC). Et un IFC n'a PAS de passe de
        // declaration — elle lit du Part-21 STEP — donc sans cette ligne tout
        // le vitrage d'un batiment ressort opaque : mesure du 19/09, 206 corps
        // translucides dans le NSTP, 0 a l'ecran. La table reste le repli pour
        // les lecteurs qui ne disent rien (occt-import-js, vieux caches).
        const _alpha = (mColor && mColor.a !== undefined && mColor.a < 1) ? mColor.a
                     : (_stepAlphaOf ? _stepAlphaOf(col) : 1);
        const mat = _faceMats || new THREE.MeshPhongMaterial({color:col, shininess:8,
          specular:0x1a1a1a, side:THREE.DoubleSide, transparent:_alpha < 1, opacity:_alpha});
        const mesh = new THREE.Mesh(geoSmooth, mat); mesh.castShadow = true; scene.add(mesh);
        mesh.position.set(0, 0, 0); // positions baked dans la géo via offset global
        mesh.updateMatrixWorld(true);
        const name = (mName || file.name.replace(/\.[^.]+$/,'')) + '_' + objCnt;
        const obj  = {id:objCnt, name, type:'csg', mesh, color:col, isHole:false, isManifold,
          stepGroupId:_stepGroupId, stepGroupLabel:_stepGroupLabel};
        // [24/09] Lien vers le B-Rep EXACT que MEDUSA garde pour ce corps : à
        // l'export, tant que la géométrie n'a pas changé, c'est lui qui est
        // réécrit (taille et précision du fichier d'origine), pas ce maillage.
        const _ref = _stepGeos[_i] && _stepGeos[_i].mRef;
        if(_ref) obj._medusaRef = _stepExactRef(_ref, [_gOx, _gOy, _gOz], geoSmooth, col, file);
        objs.push(obj); _impObjs.push(obj); meshCount++;
        _cacheBodies.push({ name: mName, color: col, isManifold, geo: geoSmooth, faces: mFaces, ref: _ref });
      }
      _stepPerfMark(_perf, 'mesh build + scene', performance.now() - _tBuild0,
        `${_repaired.length} bodies`);
      // [18/09] Le fichier déclare-t-il des couleurs que le lecteur n'a pas
      // rendues ? Un modèle gris peut venir du fichier ou du lecteur, et jusqu'ici
      // rien ne permettait de trancher depuis l'écran. Mesuré : occt-import-js
      // (WASM, le repli quand MEDUSA n'est pas là) ne rend AUCUNE couleur de face
      // — `brep_faces[].color` vaut null même sur un fichier écrit par OCCT — et
      // sur Rocky_House il ne rend pas non plus les couleurs de corps. Le dire est
      // la moitié du travail ; l'autre moitié est de démarrer MEDUSA.
      if(_stepDeclared && meshCount){
        const _dc = _stepDeclared.counts || {};
        const _declStyles = (_dc.STYLED_ITEM || 0) + (_dc.OVER_RIDING_STYLED_ITEM || 0);
        const _declFaceStyles = _dc.OVER_RIDING_STYLED_ITEM || 0;
        if(_declStyles && !_nColoured)
          nasLog('WARN', `STEP colours: the file declares ${_declStyles.toLocaleString()} style(s) `
            + `but the reader returned none — every body is showing a palette colour. `
            + `MEDUSA (native) reads them; the browser fallback does not.`);
        else if(_declFaceStyles && !_cacheBodies.some(b => b.faces && b.faces.length))
          nasLog('WARN', `STEP colours: ${_declFaceStyles.toLocaleString()} per-face style(s) declared, `
            + `none returned by the reader — bodies are painted with their solid colour only.`);
      }
      selObjs = _impObjs;
      // [NEW V4.4.0 03/07] Overlay PMI — construit APRÈS le centrage global pass 2 :
      // les annotations subissent la MÊME bascule Z-up→Y-up et le MÊME offset commun
      // que les meshes, sinon elles flottent à côté de la pièce.
      if(_pmiPending && (_pmiPending.annotations.length || _pmiPending.semantics.length)){
        try { _pmiCommit(_pmiPending, _gOx, _gOy, _gOz, _stepGroupLabel); }
        catch(e){ nasLog('WARN', `PMI overlay failed (${e.message})`); }
      }
      _pmiPending = null;
      // [PERF 17/09] Écriture du cache de géométrie finale — DIFFÉRÉE d'une
      // macrotask : la scène doit s'afficher d'abord. L'encodage recopie les
      // buffers (quelques centaines de ms sur un gros assemblage), et rien ne
      // justifie de retarder le premier rendu de ce que l'utilisateur vient
      // d'attendre. Fire-and-forget : un échec ne casse rien, il coûte juste un
      // import complet la prochaine fois.
      // [29/09] Jamais un Turbo incomplet : ressorti du cache, il masquerait les
      // corps manquants même une fois MEDUSA démarré.
      if(_gk && _cacheBodies.length && !(_turboInfo && _turboInfo.failed && _turboInfo.failed.length)){
        const _lbl = file.name, _mGOx = _gOx, _mGOy = _gOy, _mGOz = _gOz;
        const _mNm = nonManifoldCount, _mPath = _p2Path;
        const _mAlpha = (_stepDeclared && _stepDeclared.styleAlpha
          && Object.keys(_stepDeclared.styleAlpha).length) ? _stepDeclared.styleAlpha : undefined;
        setTimeout(() => {
          try{
            const _t0e = performance.now();
            const _ab = _nspgEncode(_cacheBodies, { gOx:_mGOx, gOy:_mGOy, gOz:_mGOz,
              nonManifoldCount:_mNm, path:_mPath, deflection:_STEP_WASM_DEFLECTION,
              styleAlpha:_mAlpha });
            _geoCachePut(_gk, _ab, _lbl);
            nasLog('DBG', `[cache-geo] ${_lbl} — ${(_ab.byteLength/1024/1024).toFixed(1)} MB encoded `
              + `in ${Math.round(performance.now()-_t0e)} ms — the next import of this file `
              + `will be near-instant`);
          }catch(e){ nasLog('DBG', `[cache-geo] write skipped (${e.message})`); }
        }, 0);
      }
    }
    updProps(); updOList(); updStats();
    const ms = Math.round(performance.now()-t0);
    const kb = Math.round(file.size/1024);
    if(!_stepTurboBatch){ _lastImportStats = { chunks: _turboInfo ? _turboInfo.chunks : 1, ms, label: file.name }; updStats(); } // chrono stats panel (Turbo : nombre de tranches lues)
    // [19/09] Le meme code sert aux deux formats : dire lequel, plutot que
    // d'annoncer « STEP » a quelqu'un qui vient de deposer un IFC.
    const _fmt = (_impOpts && _impOpts.ifc) ? 'IFC (MEDUSA)' : 'STEP (OCCT)';
    nasLog('OK', `Import ${_fmt} : ${meshCount} mesh(es) — ${kb} KB — ${ms}ms`
      + (_turboInfo ? ` — Turbo, ${_turboInfo.chunks} chunk(s)` : '')
      + (nonManifoldCount ? ` — ⚠ ${nonManifoldCount} non-manifold (CSG disabled)` : ''));
    _csgLog(`✓ ${_fmt} imported: ${meshCount} mesh(es)`
      + (nonManifoldCount ? ` — ⚠ ${nonManifoldCount} non-manifold` : ''));
    nasFaceColorReport();   // [11/09] bilan couleurs par face — une ligne, toujours
    // [16/09] Confrontation déclaration ↔ obtenu. C'est ce qui a permis de
    // trancher : sur Rocky_House, le fichier déclare 143 solides tous fermés et
    // 10 corps ressortent ouverts — parce que 12 faces sur 8 285 n'ont produit
    // AUCUN triangle. Un trou de face manquante, pas un interstice : aucune
    // tolérance de couture ne peut le fermer, il n'y a rien en face.
    try {
      if(_stepDeclared && typeof nasStepAudit === 'function')
        nasStepAudit(_stepDeclared, result, { nonManifoldCount });
    } catch(e){ nasLog('WARN', `STEP audit failed (${e.message})`); }
  } catch(err){
    nasLog('ERROR', 'Import STEP : ' + err.message);
    _nasAlert('⚠ Import STEP failed:\n' + err.message);
  } finally { hideSpinner(); _stepPerfReport(_perf); }
}