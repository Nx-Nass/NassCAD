// ══════════════════════════════════════════════════════════════════════════
// step-import.js — module STEP import + PMI extrait du host NASSCAD
//
// Contient, dans l'ordre où ils apparaissaient dans l'original (bloc unique,
// volontairement NON fragmenté en plusieurs fichiers — trop d'inter-dépendances
// internes pour un découpage sûr) :
//   - Import STEP via occt-import-js (chargement OCCT WASM)
//   - Cache IndexedDB des résultats STEP parsés (_stepCache*)
//   - OCCT Worker pool dédié (offload du parsing hors thread principal)
//   - STEP Slicer (découpage en chunks pour très gros assemblages)
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
      nasLog('WARN', 'nasscad_occt_wasm.js companion introuvable — repli sur le fetch direct du .wasm');
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
let _stepCacheOff = false;  // panne IDB → cache désactivé pour la session, import inchangé

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
async function _stepCacheKey(buffer, params){
  if(_stepCacheOff) return null;
  // [26/08] NSTP3 → NSTP4 : les entrées mises en cache avant la correction
  // couleur contiennent du linéaire. Bump du salt = invalidation propre, sans
  // purge explicite (l'éviction LRU nettoie les anciennes entrées).
  const salt = '|' + ((params && params.linearUnit) || 'mm') + '|NSTP6';
  try{
    if(typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest){
      const h = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,'0')).join('') + salt;
    }
  }catch(e){ /* tombe sur FNV ci-dessous */ }
  try{
    const u8 = new Uint8Array(buffer);
    let h1 = 0x811c9dc5 | 0, h2 = 0x811c9dc5 | 0;
    for(let i = 0; i < u8.length; i++){ h1 ^= u8[i]; h1 = Math.imul(h1, 0x01000193); }
    for(let i = u8.length - 1; i >= 0; i--){ h2 ^= u8[i]; h2 = Math.imul(h2, 0x01000193); }
    return 'fnv_' + (h1 >>> 0).toString(16) + '_' + (h2 >>> 0).toString(16) +
           '_' + u8.length + salt;
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
    attributes: { position: { array:
      new Float32Array(arrayBuffer, binBase + m.posOffset, m.posCount) } },
    index: { array:
      new Uint32Array(arrayBuffer, binBase + m.idxOffset, m.idxCount) }
  }));
  return { success: true, meshes };
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

async function _detectBooster(timeoutMs = 300){
  if(_boosterState !== null) return _boosterState;
  try{
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${_BOOSTER_URL}/ping`, { signal: ctrl.signal });
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
  if(_boosterState === false) _boosterState = null; // re-sonde : peut avoir demarre depuis
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
  if(_boosterState === false) _boosterState = null; // re-sonde : peut avoir demarre depuis
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
async function _readStepFileViaBoosterStream(buffer, params, onMesh){
  const res = await fetch(`${_BOOSTER_URL}/stepstream`, { method: 'POST', body: buffer });
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
async function _readStepFileViaBooster(buffer, params){
  const ctrl = new AbortController();
  const timeoutMs = Math.max(120000, Math.ceil(buffer.byteLength / (1024*1024)) * 3000); // 3s/Mo, plancher 2min
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try{
    res = await fetch(`${_BOOSTER_URL}/step`, { method: 'POST', body: buffer, signal: ctrl.signal });
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
    `      _occt = await occtimportjs({ wasmBinary: d.wasmBytes, locateFile: function(p){ return p; } });`,
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
    `      self.postMessage({type:'result', id, result});`,
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
      '(ex: python -m http.server) contourne ce genre de restriction.' : ''));
    if(idx === 0) _stepWorkerFailed = true;
    _stepPool[idx] = null;
    return null;
  }
}
// Transfert zero-copy du WASM déjà décodé (base64 inline ou XHR fallback, cf. _getOcct)
// vers UN worker du pool — celui-ci ne doit JAMAIS tenter de fetch() le .wasm lui-même
// (c'est exactement ce fetch qui posait problème sous file:// avant l'inlining base64).
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
function _applyFaceColors(geo, mFaces){
  if(!mFaces || mFaces.length < 2) return null;
  const _idxCount = geo.index ? geo.index.count : geo.attributes.position.count;
  const _mk = c => new THREE.MeshPhongMaterial({color:c, shininess:8, specular:0x1a1a1a, side:THREE.DoubleSide});
  const _mats = [], _byColor = new Map();
  let _covered = 0, _run = null;
  geo.clearGroups();
  for(const f of mFaces){
    const _fs = f[3];
    if(_fs >= _idxCount) continue;
    const _cnt = Math.min(f[4], _idxCount - _fs);
    if(_cnt <= 0) continue;
    const _hex = (Math.round(f[0]*255)<<16)|(Math.round(f[1]*255)<<8)|Math.round(f[2]*255);
    let _mi = _byColor.get(_hex);
    if(_mi === undefined){ _mi = _mats.length; _byColor.set(_hex, _mi); _mats.push(_mk(_hex)); }
    if(_run && _run.mi === _mi && _run.start + _run.count === _fs){ _run.count += _cnt; }
    else { if(_run) geo.addGroup(_run.start, _run.count, _run.mi); _run = { start:_fs, count:_cnt, mi:_mi }; }
    if(_fs + _cnt > _covered) _covered = _fs + _cnt;
  }
  if(_run) geo.addGroup(_run.start, _run.count, _run.mi);
  // Triangles ajoutés en aval par le gap-fill : ils tombent après la dernière
  // face. Sans ce rattrapage ils n'auraient aucun matériau et disparaîtraient.
  if(_mats.length && _covered < _idxCount) geo.addGroup(_covered, _idxCount - _covered, 0);
  if(!_mats.length){ geo.clearGroups(); return null; }
  geo.userData.faceRanges = mFaces;
  return _mats;
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
  if(!bf || !bf.length || (m.faces && m.faces.length)) return;
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
  if(!nStyled) return;                       // aucune couleur de face : le solide gouverne
  if(uniform){
    // Corps uniforme au niveau des faces : la face gagne contre le solide.
    m.color = { r: out[0][0], g: out[0][1], b: out[0][2] };
    return;                                  // un seul matériau, pas de groupes
  }
  if(out.length > 1) m.faces = out;
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
    catch(e){ nasLog('WARN', `brep_faces ignoré sur ${m.name||'?'} (${e.message})`); }
  }
  return result;
}

async function _readStepFileOffloaded(buffer, params){
  // [NEW V4.4.8] Booster Inside — cache navigateur consulté AVANT tout calcul.
  // Hash calculé ICI, en premier : plus bas, le buffer est détaché par le
  // postMessage transferable vers le Worker — il serait illisible après.
  const _ck = await _stepCacheKey(buffer, params);
  if(_ck){
    const _hit = await _stepCacheGet(_ck);
    if(_hit){
      const _t0 = performance.now();
      try{
        const _out = _nstpDecode(_hit, false);
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
      try{
        _bres = await _readStepFileViaBoosterStream(buffer, params, (mesh, n) => {
          // Progression RÉELLE, corps par corps, pendant que le natif calcule —
          // remplace le spinner "opaque lib" sans pourcentage.
          if(typeof showSpinner === 'function') showSpinner('MEDUSA (streaming)',
            `${n} body(ies) received…`, 'indeterminate');
        });
      }catch(_se){
        // Vieux serveur (pas de /stepstream), coupure en cours, erreur serveur :
        // le /step classique reste la voie sûre — comportement identique à avant.
        nasLog('DBG', `MEDUSA stream unavailable (${_se.message}) — falling back to classic /step`);
        _bres = await _readStepFileViaBooster(buffer, params);
      }
      nasLog('OK', `⚡ MEDUSA: ${_bres.meshes.length} bodies in ` +
        `${((performance.now()-_bt0)/1000).toFixed(2)}s — native parallel OCCT, no WASM`);
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
  const _res = _srgbNormalizeMeshColors(await _readStepFileUncached(buffer, params));
  if(_ck && _res && _res.success && _res.meshes && _res.meshes.length){
    _stepCachePut(_ck, _res); // fire-and-forget : encode NSTP + store + LRU
  }
  return _res;
}
async function _readStepFileUncached(buffer, params){
  const slot = await _stepPoolAcquire();
  if(!slot){
    nasLog('DBG', 'STEP parsing: main-thread path (Worker unavailable) — UI frozen during parsing');
    const occt = await _getOcct();
    return occt.ReadStepFile(new Uint8Array(buffer), params);
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
      reject:  (e)=>{ clearTimeout(tWdog); reject(e); }
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
    nasLog('DBG', 'STEP buffer tampon : OPFS indisponible — repli 100% RAM (ancien chemin)');
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
    nasLog('WARN', `STEP buffer tampon (OPFS) échoué (${e.message}) — repli 100% RAM`);
    if(root && opfsName){ try { await root.removeEntry(opfsName); } catch(_e){ /* rien à purger */ } }
    const buffer = await file.arrayBuffer();
    return { text: _bytesToLatin1Str(new Uint8Array(buffer)), cleanup: async () => {} };
  }
}

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
function stepSliceByComponentsAndSize(text, maxChunkBytes) {
  const dataIdx = text.indexOf('\nDATA;');
  if (dataIdx === -1) throw new Error('DATA section not found');
  
  const headerBlock = text.slice(0, dataIdx).trimEnd();
  const afterData = text.slice(dataIdx + 1);
  const endIdx = afterData.search(/ENDSEC;\s*END-ISO-10303-21;/);
  const dataBody = endIdx === -1 
    ? afterData.slice(afterData.indexOf(';') + 1) 
    : afterData.slice(afterData.indexOf(';') + 1, endIdx);
  
  // Parse entités
  const entities = new Map();
  {
    let i = 0;
    const n = dataBody.length;
    while (i < n) {
      while (i < n && /\s/.test(dataBody[i])) i++;
      if (i < n && dataBody[i] === '/' && dataBody[i + 1] === '*') {
        const end = dataBody.indexOf('*/', i + 2);
        i = (end === -1) ? n : end + 2;
        continue;
      }
      if (i >= n) break;
      let j = i;
      while (j < n && dataBody[j] !== '=') j++;
      if (j >= n) break;
      const id = parseInt(dataBody.slice(i, j).trim(), 10);
      i = j + 1;
      let k = j + 1, depth = 0, inStr = false;
      for (; k < n; k++) {
        const c = dataBody[k];
        if (inStr) { if (c === "'") inStr = false; continue; }
        if (c === "'") { inStr = true; continue; }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ';' && depth <= 0) break;
      }
      entities.set(id, dataBody.slice(j + 1, k));  // Exclure le '='
      i = k + 1;
    }
  }
  
  // Graphe de dépendances
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
  
  // Identifier les feuilles géométriques
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
  if (!leafRoots.length) throw new Error('No SHAPE_REPRESENTATION with geometry');
  
  const leafRootsSet = new Set(leafRoots);
  const STYLE_TYPES = new Set([
    'STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM', 'PRESENTATION_STYLE_ASSIGNMENT',
    'PRESENTATION_STYLE_BY_CONTEXT', 'SURFACE_STYLE_USAGE', 'SURFACE_SIDE_STYLE',
    'SURFACE_STYLE_FILL_AREA', 'SURFACE_STYLE_BOUNDARY', 'SURFACE_STYLE_PARAMETER_LINE',
    'FILL_AREA_STYLE', 'FILL_AREA_STYLE_COLOUR', 'COLOUR_RGB', 'COLOUR_SPECIFICATION',
    'CURVE_STYLE', 'CURVE_STYLE_FONT', 'MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION',
    'PRESENTATION_LAYER_ASSIGNMENT', 'DRAUGHTING_PRE_DEFINED_COLOUR'
  ]);
  const ROOT_TYPES = new Set(['PRODUCT_DEFINITION', 'PRODUCT', 'PRODUCT_DEFINITION_FORMATION']);
  const FANOUT_FREEZE_THRESHOLD = 80;
  
  function isOtherGeomLeaf(id, selfRoot) { return id !== selfRoot && leafRootsSet.has(id); }
  function fanoutOf(id) { return (reverse.get(id) || []).size + (forward.get(id) || []).size; }
  
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
          // [FIX couleur réactivée] Même logique que stepSliceBySize ci-dessus : noeud STYLE
          // conservé (couleur récupérée via closure() forward pur, plus bas) mais BFS gelé
          // ici — pas de push dans `next`, pour ne pas traverser un contexte de présentation
          // partagé comme pont vers la géométrie d'une autre pièce.
          if (STYLE_TYPES.has(entityType(rid))) continue;
          next.push(rid);
        }
      }
      frontier = next;
    }
    return found;
  }
  
  // Composants
  const pieceClosures = leafRoots.map(rootId => {
    const chainIds = chainFor(rootId);
    return closure([rootId, ...chainIds]);
  });
  
  // Bin packing
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
  
  return chunks;
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
    throw new Error('Local header ZIP invalide (offset ' + entry.lhOff + ')');
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

let _pmiPending = null;   // résultat du scan, consommé en fin d'import
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
  return _pmiScan(text, flags);
}

// ── Overlay Three.js + UI ─────────────────────────────────────────────────────
const _PMI_FAM_COLOR = { datum: 0xffd447, forme: 0x4fc3f7, orientation: 0x4dd0e1,
  localisation: 0xff8a65, dimension: 0x81c784, texte: 0xd0d0d0, autre: 0xce93d8 };
const _PMI_CSS = { white: 0xf2f2f2, black: 0x202020, red: 0xff4040, green: 0x33cc55,
  blue: 0x4488ff, yellow: 0xffd447, cyan: 0x33cccc, magenta: 0xcc44cc };

function _pmiFamily(name){
  const n = (name || '').toLowerCase();
  if(/datum/.test(n)) return 'datum';
  if(/flat|straight|circular|cylindric|angular/.test(n)) return 'forme';
  if(/parallel|perpendic|orient/.test(n)) return 'orientation';
  if(/position|profile|runout|concentr|symmetr|coaxial/.test(n)) return 'localisation';
  if(/size|diamet|radius|linear|dimension|angle|chamfer|thread/.test(n)) return 'dimension';
  if(/text|note|label/.test(n)) return 'texte';
  return 'autre';
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
function _pmiRepaint(){ try{ if(typeof render === 'function') render(); }catch(e){} }

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
  for(const f of ['datum','forme','orientation','localisation','dimension','texte','autre']){
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

async function importSTEP(file) {
  // [NEW V4.4.0 03/07] Normalisation conteneur AVANT la décision de slicing : un
  // .stpz de 30 MB peut cacher un Part 21 de 300 MB — la taille pertinente pour le
  // seuil Turbo est celle du payload décompressé, pas celle du conteneur.
  file = await _stepNormalizeFile(file);
  // Décision : slicer ou import direct
  if (file.size <= _STEP_SLICE_THRESHOLD) {
    return _importSTEPSingle(file);
  }
  // [NEW V4.7.1] TURBO BYPASS — Booster natif d'abord, sur le fichier ENTIER.
  // Le slicer JS traverse le graphe Part21 depuis les produits : les STYLED_ITEM
  // (couleurs) et la structure NAUO d'assemblage ne sont pas atteignables depuis
  // ces racines → chunks amputés → couleurs/noms perdus, fusion possible par
  // chunk. Le natif n'a aucun de ces problèmes : il avale le fichier entier avec
  // fidélité complète (validé : 235 MB / 107k faces en ~113s). Le slicing ne
  // garde de sens QUE comme repli quand le Booster est absent ou échoue —
  // auquel cas on retombe ici et le Turbo classique reprend, inchangé.
  if (await _detectBooster()) {
    nasLog('OK', `⚡ Turbo bypass: ${file.name} (${(file.size/1024/1024).toFixed(1)} MB) — whole file to native MEDUSA, zero slicing`);
    try {
      return await _importSTEPSingle(file, { boosterOnly: true });
    } catch (e) {
      nasLog('WARN', `Turbo bypass: MEDUSA failed (${e.message}) — falling back to classic slicing`);
    }
  }
  
  nasLog('DBG', 
    `STEP Turbo: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB) ` +
    `> threshold ${(_STEP_SLICE_THRESHOLD / 1024 / 1024).toFixed(0)}MB — ` +
    `smart slicing (components + size), adaptive chunk sizing`
  );
  
  const _turboT0 = performance.now(); // chrono total import STEP Turbo
  showSpinner('STEP Turbo', `${file.name} — buffering to disk…`, 'indeterminate');
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); // [FIX] Double rAF : garantit le paint du spinner avant le parsing synchrone lourd (freeze silencieux constaté sur Voron 235MB/1438 corps)
  // [NEW] Fichier tampon (OPFS) + relecture par fenêtres — cf. _stepLoadTextBuffered plus
  // haut. Remplace l'ancien `await file.arrayBuffer()` qui faisait vivre le fichier ENTIER
  // deux fois en RAM (bytes bruts + string latin1) pendant tout le slicing.
  const _stepBuf = await _stepLoadTextBuffered(file);
  showSpinner('STEP Turbo', `${file.name} — analyzing entity graph…`, 'indeterminate');

  // Pool navigateur — remonté AVANT le slicing : la taille de chunk adaptative en dépend.
  const concurrency = Math.max(_STEP_WORKER_POOL_SIZE, _STEP_POOL_MAX);

  // ── File-size-adaptive chunk sizing ──────────────────────────────────
  // [NEW 30/07 — validé terrain Voron 230MB : 11 chunks, ~5min gagnées vs cap machine]
  // _STEP_SLICE_CHUNK ne dépend que de la machine (RAM/heap) — un fichier juste
  // au-dessus du seuil sortait en 1-3 chunks pour 2-4 workers : rien à équilibrer.
  // Cible : ~3 chunks par worker (lisse la charge entre chunks hétérogènes, sans
  // exploser l'overhead OCCT par appel). Bornes : 24MB plancher (sous ça, l'overhead
  // fixe de ReadStepFile domine), _STEP_SLICE_CHUNK plafond (budget RAM machine,
  // jamais dépassé). Le slicer par composants traite ça comme un max souple — une
  // pièce unique plus grosse que le chunk reste entière (jamais coupée).
  const _CHUNKS_PER_WORKER = 3;
  const _idealChunk = Math.ceil(file.size / (concurrency * _CHUNKS_PER_WORKER));
  const _effChunk = Math.min(_STEP_SLICE_CHUNK, Math.max(24 * 1024 * 1024, _idealChunk));
  nasLog('DBG', `STEP Turbo: adaptive chunk size ${(_effChunk/1024/1024).toFixed(0)}MB ` +
    `(file ${(file.size/1024/1024).toFixed(0)}MB ÷ ${concurrency}×${_CHUNKS_PER_WORKER} targets, ` +
    `machine cap ${(_STEP_SLICE_CHUNK/1024/1024).toFixed(0)}MB)`);

  let chunks;
  try {
    chunks = stepSliceByComponentsAndSize(_stepBuf.text, _effChunk);
  } catch (err) {
    // FALLBACK #1 : Essayer l'ancienne méthode stepSliceBySize (stable)
    nasLog('WARN', `STEP Turbo slicer failed (${err.message}) — fallback to stepSliceBySize`);
    try {
      showSpinner('STEP Turbo', `${file.name} — fallback slicing simple…`, 'indeterminate');
      chunks = stepSliceBySize(_stepBuf.text, _effChunk);
      nasLog('OK', `STEP fallback: ${chunks.length} chunk(s) generated by stepSliceBySize`);
    } catch (err2) {
      // FALLBACK #2 : Import direct (UI peut geler sur gros fichiers)
      await _stepBuf.cleanup();
      hideSpinner();
      nasLog('ERROR', `STEP slicing failed entirely (${err2.message}) — direct import (risk of blocking on large file)`);
      return _importSTEPSingle(file);
    }
  }
  // Chunks (strings STEP indépendantes) construits : le fichier tampon disque et le texte
  // source ne servent plus à rien — purge immédiate, pas d'attente jusqu'à la fin de l'import.
  await _stepBuf.cleanup();

  nasLog('OK', `STEP Turbo: ${chunks.length} chunk(s) generated, ` +
    `workers ×${concurrency}, mode ` +
    `${concurrency > 1 ? 'PARALLEL ⚡⚡' : 'sequential ⚡'}`);
  
  const _allNewObjs = [];
  const _chunkErrors = [];
  const _before = objs.length;

  // ── FIFO worker-pool scheduler ────────────────────────────────────────
  // [NEW 30/07 — validé terrain] Remplace l'ancien dispatch par lots synchronisés
  // (Promise.all sur un batch de `concurrency` chunks : un chunk lent bloquait les
  // workers déjà libres du même lot). Ici : file FIFO unique (curseur _nextChunkIdx),
  // N "workers logiques" tournent en parallèle et repiochent le chunk suivant dès
  // qu'ils se libèrent — load balancing réel entre chunks hétérogènes (smart hybrid
  // chunking = chunks par composant, pas de taille garantie uniforme).
  let _nextChunkIdx = 0;
  let _doneChunks = 0;
  const _totalChunks = chunks.length;

  async function _runChunk(idx){
    const chunkNum = idx + 1;
    const bytes = _latin1StrToBytes(chunks[idx]);
    const chunkName = file.name.replace(/\.[^.]+$/, '') +
                      ` [chunk ${chunkNum}-${_totalChunks}].step`;
    const chunkFile = new File([bytes], chunkName, { type: 'text/plain' });

    nasLog('DBG',
      `STEP Turbo: dequeuing chunk ${chunkNum}/${_totalChunks} ` +
      `(${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);

    try {
      await _importSTEPSingle(chunkFile);
      nasLog('OK', `STEP Turbo: chunk ${chunkNum}/${_totalChunks} imported`);
    } catch (err) {
      const msg = `chunk ${chunkNum}/${_totalChunks}: ${err.message}`;
      nasLog('WARN', `STEP Turbo: ${msg}`);
      _chunkErrors.push(msg);
    }
    _doneChunks++;
    showSpinner('STEP Turbo',
      `Processing: ${_doneChunks}/${_totalChunks} chunks done…`,
      'indeterminate');
  }

  async function _fifoWorkerLoop(){
    // Incrément synchrone AVANT tout await → pas de race condition possible sur
    // _nextChunkIdx malgré les N boucles concurrentes (JS single-thread).
    while (_nextChunkIdx < _totalChunks){
      const idx = _nextChunkIdx++;
      await _runChunk(idx);
      await _breathe();
    }
  }

  _stepTurboBatch = true; // gate hideSpinner + stats par chunk (voir déclaration)
  try {
    showSpinner('STEP Turbo', `Processing: 0/${_totalChunks} chunks done…`, 'indeterminate');
    await _breathe();
    await Promise.all(
      Array.from({length: Math.min(concurrency, _totalChunks)}, () => _fifoWorkerLoop())
    );

    // Récupérer les objets importés
    for (let k = _before; k < objs.length; k++) {
      _allNewObjs.push(objs[k]);
    }

    // Déduplique robuste
    if (_allNewObjs.length) {
      showSpinner('STEP Turbo',
        `Deduplication — ${_allNewObjs.length} objects…`,
        'indeterminate');
      await _breathe();
      const _removed = _dedupOverlappingObjects(_allNewObjs);
      if (_removed) {
        nasLog('OK', `STEP Turbo: ${_removed} duplicate(s) removed`);
      }
    }
  } finally {
    // Fermeture GARANTIE : couvre aussi le cas "tous les chunks en erreur"
    // (_allNewObjs vide) où l'ancien code laissait le spinner bloqué à l'écran.
    // Le chrono affiché aura couru en continu depuis le premier showSpinner du
    // Turbo — temps réel total (validé terrain : 22m37s continus sur Voron).
    _stepTurboBatch = false;
    hideSpinner(true);
  }
  
  updProps();
  updOList();
  updStats();
  
  const summary = _chunkErrors.length 
    ? `${chunks.length} chunk(s), ${_chunkErrors.length} error(s)`
    : `${chunks.length} chunk(s)`;
  
  const _turboMs = Math.round(performance.now() - _turboT0);
  _lastImportStats = { chunks: chunks.length, ms: _turboMs, label: file.name };
  updStats();
  nasLog('OK', `STEP Turbo: import complete — ${summary} — ${_fmtDur(_turboMs)}`);
}

async function _importSTEPSingle(file, _impOpts){
  showSpinner('Import STEP (OCCT)', file.name);
  const t0 = performance.now();
  const _stepGroupId = 'stepgrp_' + (++_stepGroupSeq);
  const _seenN = (_stepFilenameSeen.get(file.name) || 0) + 1;
  _stepFilenameSeen.set(file.name, _seenN);
  const _stepGroupLabel = _seenN > 1 ? `${file.name} (${_seenN})` : file.name;
  try {
    const buffer = await file.arrayBuffer();
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
    // [NEW V4.4.0 03/07] Scan PMI + géométrie tessellée — impérativement AVANT le
    // transfert du buffer au Worker (postMessage transfer = ArrayBuffer détaché).
    _pmiPending = null;
    try { _pmiPending = _pmiScanIfRelevant(buffer, file.name); }
    catch(e){ nasLog('WARN', `PMI scan failed (${e.message}) — import continue sans PMI`); }
    // [NEW V4.2.7p4 20/06] Parsing offloadé vers le Worker OCCT dédié si dispo (gros
    // fichiers multi-corps sans geler l'UI) — fallback to main-thread transparent sinon.
    if(buffer.byteLength > 20*1024*1024)
      nasLog('DBG', `Large STEP file (${(buffer.byteLength/1024/1024).toFixed(1)} MB) — import may take several minutes, UI non-blocking if Worker available`);
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
      showSpinner(_spTitle, `${file.name} — MEDUSA: parsing file… (detailed progress in the server window)`, 'indeterminate');
    }else{
      showSpinner(_spTitle, `${file.name} — parsing OCCT… (no progress % available — opaque lib)`, 'indeterminate');
    }
    let result;
    try {
      result = await _readStepFileOffloaded(buffer, { linearUnit:'millimeter',
        boosterOnly: !!(_impOpts && _impOpts.boosterOnly) });
    } finally {
      /* rien à nettoyer ici — le chrono est géré globalement par showSpinner/hideSpinner */
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
      let isManifold = _weldAndCheckManifold(geo, 3);
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
        if(_capStepGaps(geo)){
          isManifold = true; nonManifoldCount--;
          nasLog('DBG', `STEP gap filled — ${m.name||'?'} : mesh now watertight`);
        }
      }
      _stepGeos.push({ geo, mName: m.name, mColor: m.color, mFaces: m.faces, isManifold });
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

      const _mrGeos = _p2Total ? await _repairBatch(_stepGeos.map(s => s.geo)) : [];
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

      const _smoothGeos = await _smoothBatch(_repaired.map(r => r.geoRepaired), 30);

      // ── Phase 2c : construction des meshes + enregistrement objets NASSCAD
      // (logique métier inchangée, juste déplacée hors de la boucle repair) ──
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
          const _cr=Math.round(mColor.r*255),_cg=Math.round(mColor.g*255),_cb=Math.round(mColor.b*255);
          col = '#' + (((_cr<<16)|(_cg<<8)|_cb) >>> 0).toString(16).padStart(6,'0');
        } else { col = COL[objCnt % COL.length]; }
        // [27/08] Couleurs par face — implémentation partagée avec step-xcaf.js.
        const _faceMats = _applyFaceColors(geoSmooth, mFaces);
        if(_faceMats){
          nasLog('DBG', `STEP per-face colors — ${mName||'?'} : ${mFaces.length} face(s), `
            + `${new Set(_faceMats.map(m=>m.color.getHex())).size} color(s), ${geoSmooth.groups.length} draw group(s)`);
        }
        const mat = _faceMats || new THREE.MeshPhongMaterial({color:col, shininess:8, specular:0x1a1a1a, side:THREE.DoubleSide});
        const mesh = new THREE.Mesh(geoSmooth, mat); mesh.castShadow = true; scene.add(mesh);
        mesh.position.set(0, 0, 0); // positions baked dans la géo via offset global
        mesh.updateMatrixWorld(true);
        const name = (mName || file.name.replace(/\.[^.]+$/,'')) + '_' + objCnt;
        const obj  = {id:objCnt, name, type:'csg', mesh, color:col, isHole:false, isManifold,
          stepGroupId:_stepGroupId, stepGroupLabel:_stepGroupLabel};
        objs.push(obj); _impObjs.push(obj); meshCount++;
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
    }
    updProps(); updOList(); updStats();
    const ms = Math.round(performance.now()-t0);
    const kb = Math.round(file.size/1024);
    if(!_stepTurboBatch){ _lastImportStats = { chunks: 1, ms, label: file.name }; updStats(); } // chrono stats panel — gated en Turbo : le vrai total {chunks:N, ms:_turboMs} est écrit par importSTEP en fin de batch
    nasLog('OK', `Import STEP (OCCT) : ${meshCount} mesh(es) — ${kb} KB — ${ms}ms`
      + (nonManifoldCount ? ` — ⚠ ${nonManifoldCount} non-manifold (CSG disabled)` : ''));
    _csgLog(`✓ STEP imported (OCCT): ${meshCount} mesh(es)`
      + (nonManifoldCount ? ` — ⚠ ${nonManifoldCount} non-manifold` : ''));
  } catch(err){
    nasLog('ERROR', 'Import STEP : ' + err.message);
    _nasAlert('⚠ Import STEP failed:\n' + err.message);
  } finally { hideSpinner(); }
}