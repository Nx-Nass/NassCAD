// ═══════════════════════════════════════════════════════════════════════════
// NASSCAD 4.7.0 — VÉRIFICATION des correctifs du 27/09/2026
//
//   1. Résolution des primitives conservée (projet, undo, duplicata, coller,
//      Explode, Re-run, édition tube) ; slider ◎ sans changement de cote
//   2. Magnétisme Y sur le DESSOUS de la pièce (flèches, Alt+↑/↓, Pos Y,
//      poignée de levage)
//   3. Alt+glisser = déplacement de VUE (les pièces ne bougent plus dans le monde)
//   4. (si MEDUSA tourne) CSG réel : union → flèches → projet → Explode
//
// MODE D'EMPLOI
//   1. Sauvegarde ton travail, puis Nouveau projet (la scène doit être VIDE).
//   2. Optionnel : lance MEDUSA pour la partie 4 (sinon elle est sautée).
//   3. ⚡ Script → colle TOUT ce fichier → Ctrl+Entrée.
//   4. Ne touche pas à la souris pendant ~10 s. Le bouton Stop arrête proprement.
//   5. Résultat : une ligne ✅ / ❌ par test, et le bilan à la fin. Les lignes
//      « VERIF | … » sont aussi dans le journal (Copy logs suffit).
//
// Rien n'est téléchargé ni envoyé : les sauvegardes de projet sont interceptées
// en mémoire. Tes réglages (snap, résolution, caméra, qualité CSG) sont remis
// en place à la fin, et la scène est laissée vide.
// ═══════════════════════════════════════════════════════════════════════════
if (objs.length) throw new Error('Scène non vide — sauvegarde ton travail, fais Nouveau projet, puis relance.');

const OUT = [];
let nOk = 0, nKo = 0;
const log = s => { scriptLog(s); OUT.push(s); try { nasLog('OK', 'VERIF | ' + s); } catch (e) {} };
const check = (name, cond, info) => {
  cond ? nOk++ : nKo++;
  log((cond ? '✅ ' : '❌ ') + name + (info ? '  [' + info + ']' : ''));
};

// ── État à restaurer ──────────────────────────────────────────────────────
const S0 = {
  snap, snapSz, snapIdx: _snapIdx, res: _newPrimRes, hole: isHoleMode, csg: _csgQuality,
  th: camA.theta, ph: camA.phi, d: camA.dist, t: camT.clone()
};
const _dl0 = window._nasDownload, _raf0 = window.requestAnimationFrame, _doCSG0 = window.doCSG;

// ── Outils ────────────────────────────────────────────────────────────────
const bottom = o => { o.mesh.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o.mesh).min.y; };
const dims = o => { const d = _localDim(o.mesh, true); return [d.x, d.y, d.z].map(n => n.toFixed(3)).join('×'); };
const sig = o => dims(o) + ' · ' + o.mesh.geometry.attributes.position.count + ' sommets';
const key = (k, alt) => onKey({ key: k, altKey: !!alt, ctrlKey: false, target: document.body, preventDefault() {} });
const setSnap = sz => { snap = sz > 0; if (sz > 0) snapSz = sz; };
// Sauvegarde projet interceptée : saveProject() → texte JSON, sans téléchargement.
function saveJson() {
  let j = null;
  window._nasDownload = (n, s) => { j = s; };
  window.requestAnimationFrame = cb => cb();
  try { saveProject(); } finally { window._nasDownload = _dl0; window.requestAnimationFrame = _raf0; }
  return j;
}
const reloadProject = () => _buildSceneFromData(JSON.parse(saveJson()));
const reloadUndo = () => _buildSceneFromData(JSON.parse(JSON.stringify(_journalData())), true);
const fresh = () => { _buildSceneFromData({ version: 4, objects: [] }); setSnap(0); setCameraView('reset'); };
function prim(t, res, dimY) {
  _newPrimRes = res; addPrimitive(t); _newPrimRes = S0.res;
  const o = objs[objs.length - 1]; selObjs = [o];
  ['x', 'y', 'z'].forEach(a => setDim(a, a === 'y' && dimY ? dimY : 20));
  return o;
}
const vp = ren.domElement, R0 = vp.getBoundingClientRect();
function altDrag(dx, dy, btn) {
  vp.dispatchEvent(new MouseEvent('mousedown', { button: btn || 0, altKey: true, clientX: R0.left + 200, clientY: R0.top + 200, bubbles: true }));
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: R0.left + 200 + dx, clientY: R0.top + 200 + dy, bubbles: true }));
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 1e-9);

try {
  log('=== VÉRIFICATION NASSCAD — correctifs du 27/09 — ' + new Date().toISOString().slice(0, 16) + ' ===');

  // ════════ 1. RÉSOLUTION DES PRIMITIVES ════════════════════════════════════
  log('— 1. Résolution des primitives');
  const TYPES = ['cylinder', 'cone', 'tube', 'roofarc', 'halfsphere', 'sphere', 'cube'];
  const RES = [8, 12, 20, 28, 56, 128];
  for (const t of TYPES) {
    const bad = [];
    for (const res of RES) {
      scriptCheckStop();
      fresh();
      const o = prim(t, res);
      const ref = sig(o);
      reloadProject(); const a = sig(objs[0]);
      reloadUndo();    const b = sig(objs[0]);
      selObjs = [objs[0]]; dupSel();
      selObjs = [objs[0]]; copyObjs(); pasteObjs();
      reloadProject();
      const all = objs.map(sig);
      if (a !== ref || b !== ref || all.length !== 3 || all.some(x => x !== ref))
        bad.push(`res ${res}: ${ref} → projet ${a} / undo ${b} / copies ${all.join(' | ')}`);
    }
    check(`${t} : ${RES.length} résolutions → projet, undo, Ctrl+D, Ctrl+C/V`, !bad.length, bad.join(' ; '));
  }

  // Explode (arbre CSG simulé : un tube res 12 dans un nœud d'union)
  fresh();
  let tb = prim('tube', 12); const refTb = sig(tb);
  objCnt++;
  let fake = { id: objCnt, name: 'CSG_verif', type: 'csg', color: '#888888', isHole: false,
    mesh: new THREE.Mesh(tb.mesh.geometry.clone(), new THREE.MeshPhongMaterial()) };
  fake.mesh.position.copy(tb.mesh.position); scene.add(fake.mesh);
  _csgTree.set(fake.id, { op: 'union', cg: tb.mesh.position.toArray(), children: [{
    id: tb.id, name: tb.name, type: 'tube', color: tb.color, isHole: false, tubeRo: tb.tubeRo, tubeRi: tb.tubeRi,
    primRes: tb.primRes, p: tb.mesh.position.toArray(), r: [0, 0, 0], s: tb.mesh.scale.toArray(), opacity: 1, wireframe: false }] });
  scene.remove(tb.mesh); objs = [fake]; selObjs = [fake];
  explodeCSG();
  let ex = objs.find(o => o.type === 'tube');
  check('Explode : tube res 12 restauré à l\'identique', ex && sig(ex) === refTb && ex.primRes === 12, ex ? sig(ex) : 'aucun tube');

  // Re-run (le booléen lui-même est neutralisé : on vérifie la reconstruction des sources)
  fresh();
  let hs = prim('halfsphere', 20); const refHs = sig(hs);
  objCnt++;
  fake = { id: objCnt, name: 'CSG_verif', type: 'csg', color: '#888888', isHole: false,
    mesh: new THREE.Mesh(hs.mesh.geometry.clone(), new THREE.MeshPhongMaterial()) };
  scene.add(fake.mesh);
  _csgTree.set(fake.id, { op: 'union', children: [{
    id: hs.id, name: hs.name, type: 'halfsphere', color: hs.color, isHole: false, primRes: hs.primRes, sphereRes: hs.sphereRes,
    p: hs.mesh.position.toArray(), r: [0, 0, 0], s: hs.mesh.scale.toArray(), opacity: 1, wireframe: false }] });
  scene.remove(hs.mesh); objs = [fake]; selObjs = [fake];
  window.doCSG = async () => {};
  try { await rerunCSG(); } finally { window.doCSG = _doCSG0; }
  const rr = objs.find(o => o.type === 'halfsphere');
  check('Re-run : demi-sphère res 20 reconstruite à l\'identique', rr && sig(rr) === refHs && rr.primRes === 20, rr ? sig(rr) : 'aucune');

  // Édition d'un tube via son dialogue
  fresh();
  tb = prim('tube', 12); const v0 = tb.mesh.geometry.attributes.position.count;
  const tdlg = document.getElementById('tube-modal');
  tdlg._editObj = tb;
  document.getElementById('tube-dext').value = '30'; document.getElementById('tube-dint').value = '12';
  applyTubeDims(); tdlg._editObj = null;
  check('Édition tube (Ø30/Ø12) : résolution conservée', tb.mesh.geometry.attributes.position.count === v0,
    v0 + ' → ' + tb.mesh.geometry.attributes.position.count + ' sommets');

  // Slider ◎ sur une sphère / demi-sphère : la cote ne bouge pas, puis projet rechargé
  for (const [t, r0, r1] of [['halfsphere', 12, 32], ['halfsphere', 20, 56], ['sphere', 20, 56]]) {
    fresh();
    hs = prim(t, r0); selObjs = [hs];
    const d0 = dims(hs), y0 = bottom(hs);
    setSphereResLive(r1); clearTimeout(_sresRebuildT); _sresRebuild(hs, r1);
    const d1 = dims(hs), y1 = bottom(hs), refS = sig(hs);
    reloadProject();
    check(`${t} res ${r0} → slider ${r1} : cote et dessous conservés, projet rechargé à l'identique`,
      d1 === d0 && near(y1, y0, 1e-9) && sig(objs[0]) === refS && objs[0].sphereRes === r1,
      d0 + ' → ' + d1 + ' → ' + dims(objs[0]));
  }
  setSphereResLive(S0.res);

  // ════════ 2. MAGNÉTISME Y ═════════════════════════════════════════════════
  log('— 2. Magnétisme Y (le dessous de la pièce reste sur la grille)');
  for (const sz of SNAP_SIZES) {
    scriptCheckStop();
    fresh();
    const o = prim('cube', 32, 14.0241718);  // hauteur quelconque : centre à 7.012… du dessous
    setSnap(sz);
    for (const k of ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown']) key(k);
    const b1 = bottom(o);
    key('ArrowUp', true); key('ArrowUp', true); key('ArrowDown', true);
    const b2 = bottom(o);
    setTr('position', 'y', '2.3456'); const b3 = bottom(o);
    setTr('position', 'y', '0');      const b4 = bottom(o);
    const e3 = Math.round(2.3456 / sz) * sz;
    check(`pas ${sz} mm : flèches → 0 · Alt↑↑↓ → ${sz} · Pos Y 2.3456 → ${+e3.toFixed(3)} · Pos Y 0 → 0`,
      near(b1, 0) && near(b2, sz) && near(b3, e3) && near(b4, 0), [b1, b2, b3, b4].map(v => v.toFixed(4)).join(' / '));
  }
  // Descente : limite d'origine conservée (centre ≥ 0, donc mi-hauteur sous le plateau)
  fresh();
  let cb = prim('cube', 32); setSnap(1);
  for (let i = 0; i < 30; i++) key('ArrowDown', true);
  check('Alt↓ : s\'enfonce jusqu\'à mi-hauteur (comportement d\'origine)', near(bottom(cb), -10), 'dessous ' + bottom(cb).toFixed(3));
  // Poignée de levage
  setTr('position', 'y', '0'); selObjs = [cb];
  _hDrag = { type: 'ylift', startMX: 100, startMY: 300, startPosY: cb.mesh.position.y, worldPerPix: 0.05, _pushed: true };
  try {
    mMove({ clientX: R0.left + 100, clientY: R0.top + 300 - 73, preventDefault() {}, stopPropagation() {} });
    var l1 = bottom(cb);
    mMove({ clientX: R0.left + 100, clientY: R0.top + 300 + 1000, preventDefault() {}, stopPropagation() {} });
    var l2 = bottom(cb);
  } finally { _hDrag = null; }
  check('Poignée de levage : dessous sur le pas (3.65 → 4), descente jusqu\'à mi-hauteur', near(l1, 4) && near(l2, -10), l1.toFixed(3) + ' / ' + l2.toFixed(3));

  // ════════ 3. ALT+GLISSER = VUE ════════════════════════════════════════════
  log('— 3. Alt+glisser (déplacement de vue)');
  fresh();
  cb = prim('cube', 32);
  const p0 = cb.mesh.position.toArray().join(',');
  altDrag(40, -30); altDrag(-25, 15, 2);
  check('Pièces immobiles dans le monde, grille à l\'origine', cb.mesh.position.toArray().join(',') === p0 && _gridGroup.position.lengthSq() === 0 && _gridPan.lengthSq() > 0);
  check('Bouton Recenter actif', !document.getElementById('btn-grid-reset').disabled);
  toggleTheme(); toggleTheme();
  const cy = prim('cylinder', 32);
  check('Après Jour/Nuit + nouvelle pièce : tout est sur le plateau', near(bottom(cb), 0) && near(bottom(cy), 0) && _gridGroup.position.lengthSq() === 0);
  const camPanned = camT.toArray().join(',');
  reloadProject();
  check('Projet rouvert : même vue, pièces au sol, Recenter inactif', camT.toArray().join(',') === camPanned && objs.every(o => near(bottom(o), 0)) && _gridPan.lengthSq() === 0 && document.getElementById('btn-grid-reset').disabled);
  altDrag(0, -40); reloadUndo();
  check('Undo après Alt+glisser : pièces au sol, cumul remis à 0', objs.every(o => near(bottom(o), 0)) && _gridPan.lengthSq() === 0);
  altDrag(30, -20); _gridReset();
  check('Recenter : vue ramenée, bouton inactif', _gridPan.lengthSq() === 0 && document.getElementById('btn-grid-reset').disabled);

  // ════════ 4. CSG RÉEL (MEDUSA) ═════════════════════════════════════════════
  log('— 4. CSG réel avec MEDUSA');
  if (!(await _medusaProbe(2500))) {
    log('⏭  MEDUSA ne répond pas — partie 4 sautée (lance le moteur et relance le script pour la faire).');
  } else {
    fresh();
    setCsgQuality(64);  // courbe + CSG⚡64 → chemin progressif (aperçu puis passe 2)
    const a = prim('cube', 32, 7.8123);
    const b = prim('cylinder', 20, 12.3457);
    b.mesh.position.x = a.mesh.position.x + 8; b.mesh.position.z = a.mesh.position.z + 3;
    _invalidateBbox(b.mesh);
    selObjs = [a, b]; updProps(); updCSG();
    let err = null;
    try { await doCSG('union'); } catch (e) { err = e; }
    const U = objs[objs.length - 1];
    const okU = !err && U && U.type === 'csg' && objs.length === 1;
    check('Union cube ∪ cylindre créée', okU, err ? err.message : objs.length + ' objet(s)');
    if (okU) {
      const hU = _localDim(U.mesh, true).y;
      check('Résultat : posé au sol, hauteur 12.346', near(bottom(U), 0, 1e-4) && near(hU, 12.3457, 1e-3), 'dessous ' + bottom(U).toFixed(5) + ' · h ' + hU.toFixed(4));
      selObjs = [U]; setSnap(1);
      for (const k of ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown']) key(k);
      check('Résultat CSG + snap 1 mm + flèches : reste au sol', near(bottom(U), 0, 1e-4), 'dessous ' + bottom(U).toFixed(5) + ' (centre de gravité Y = ' + U.mesh.position.y.toFixed(4) + ')');
      setTr('position', 'y', '0');
      check('Résultat CSG : Pos Y = 0 le repose pile au sol', near(bottom(U), 0, 1e-4), 'dessous ' + bottom(U).toFixed(5));
      setSnap(0);
      const refU = sig(U);
      reloadProject();
      check('Résultat CSG : projet rechargé à l\'identique', sig(objs[0]) === refU && near(bottom(objs[0]), 0, 1e-4), refU + ' → ' + sig(objs[0]));
      selObjs = [objs[0]];
      explodeCSG();
      const cyl = objs.find(o => o.type === 'cylinder');
      check('Explode du résultat : cylindre res 20 rendu à 20×12.346×20', cyl && cyl.primRes === 20 && dims(cyl) === '20.000×12.346×20.000', cyl ? dims(cyl) + ' · primRes ' + cyl.primRes : 'aucun cylindre');
    }
  }

  log('=== BILAN : ' + nOk + ' OK · ' + nKo + ' ÉCHEC(S) ===');
} finally {
  window._nasDownload = _dl0; window.requestAnimationFrame = _raf0; window.doCSG = _doCSG0;
  _hDrag = null;
  try { fresh(); } catch (e) {}
  try { setCsgQuality(S0.csg); } catch (e) {}
  try { setSphereResLive(S0.res); } catch (e) {}
  snap = S0.snap; snapSz = S0.snapSz; _snapIdx = S0.snapIdx; isHoleMode = S0.hole;
  try { _syncSnapUI(); } catch (e) {}
  camA.theta = S0.th; camA.phi = S0.ph; camA.dist = S0.d; camT.copy(S0.t);
  _gridPan.set(0, 0, 0); _updateGridResetBtnState(); updCam();
  updProps(); updOList(); updStats();
}
return nKo ? '❌ ' + nKo + ' échec(s) sur ' + (nOk + nKo) + ' — copie le rapport ci-dessus et envoie-le à Claude'
           : '✅ ' + nOk + ' tests OK';
