// ═══════════════════════════════════════════════════════════════════════════
// NASSCAD 4.7.0 — BENCH PERFORMANCES (pour la section Performance de l'aide)
//
// MODE D'EMPLOI
//   1. Sauvegarde ton travail, puis Nouveau projet (la scène doit être VIDE).
//   2. Lance MEDUSA (Nasscad_Medusa_Engine_3.1.exe).
//   3. ⚡ Script → colle TOUT ce fichier → Ctrl+Entrée.
//   4. Ne touche plus à la souris jusqu'au résultat final (3 à 10 min).
//   5. Copie le bloc « RÉSULTATS » affiché à la fin et renvoie-le à Claude.
//
// v2 : les lignes « BENCH | … » sont aussi écrites dans le journal (Copy logs suffit).
// Les sphères des tests CSG sont décalées de 3 mm hors des plans X=0 / Z=0
// (contourne un défaut de soudure MEDUSA sur les coordonnées ≈ 0, cf. Claude 23/09).
// Le bouton Stop arrête proprement. Aucune donnée ne quitte ta machine.
// ═══════════════════════════════════════════════════════════════════════════
if (objs.length) throw new Error('Scène non vide — sauvegarde ton travail, fais Nouveau projet, puis relance.');
if (!(await _medusaProbe(3000))) throw new Error('MEDUSA ne répond pas — lance le moteur puis relance.');

const OUT = [];
const log = s => { scriptLog(s); OUT.push(s); try { (window._benchNl || nasLog)('OK', 'BENCH | ' + s); } catch (e) {} };
const pause = ms => new Promise(r => setTimeout(r, ms));
const frame = () => new Promise(r => requestAnimationFrame(r));
const fmt = ms => ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s';
const S0 = { csg: _csgQuality, res: _newPrimRes, th: camA.theta, ph: camA.phi, d: camA.dist, t: camT.clone() };
const gl = ren.getContext();
const _nl = window.nasLog;
window._benchNl = _nl;
let lastPass1 = null;

// Objet posé directement (sans undo ni recherche de place en spirale).
function mk(t, x, y, z) {
  objCnt++;
  const c = COL[objCnt % COL.length];
  const m = new THREE.Mesh(makeGeo(t, PS, _segViewLive()),
    new THREE.MeshPhongMaterial({ color: c, shininess: 8, specular: 0x1a1a1a, transparent: true, opacity: 1 }));
  m.castShadow = true;
  scene.add(m);
  m.position.set(x, y == null ? PS / 2 : y, z);
  m.updateMatrixWorld(true);
  const o = { id: objCnt, name: t + '_' + objCnt, type: t, mesh: m, color: c, isHole: false };
  if (t === 'sphere' || t === 'halfsphere') o.sphereRes = _newPrimRes;
  objs.push(o);
  return o;
}

// Vide la scène sans empiler d'undo (un snapshot de 2000 objets coûterait cher).
function clearAll() {
  for (const o of objs) {
    scene.remove(o.mesh);
    o.mesh.geometry.dispose();
    _matAll(o.mesh.material).forEach(m => m.dispose());
    _csgTree.delete(o.id);
    _bboxCache.delete(o.mesh);
    if (o._poolSlot != null && GeometryPool.initialized && typeof GeometryPool.free === 'function') {
      try { GeometryPool.free(o._poolSlot); } catch (e) {}
    }
  }
  objs = []; selObjs = [];
  updProps(); updOList(); updStats();
  _camDirty = true;
}

const verts = () => objs.reduce((s, o) => s + o.mesh.geometry.attributes.position.count, 0);
const heap = () => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB' : '?';

// Cadre toute la scène, puis mesure : rendu synchrone (médiane de 15) + orbite réelle 3 s.
async function measureView() {
  const bb = new THREE.Box3();
  objs.forEach(o => bb.expandByObject(o.mesh));
  bb.getCenter(camT);
  const r = bb.getSize(new THREE.Vector3()).length() / 2;
  camA.dist = r / Math.sin((cam.fov || 45) * Math.PI / 360) * 1.1;
  cam.far = Math.max(cam.far, camA.dist + r * 4);
  cam.updateProjectionMatrix(); updCam();
  for (let i = 0; i < 10; i++) { camA.theta += 0.01; updCam(); await frame(); }   // chauffe (shaders, envoi GPU)
  const ts = [], px = new Uint8Array(4);
  for (let i = 0; i < 15; i++) {
    camA.theta += 0.01; updCam();
    const t = performance.now();
    ren.render(scene, cam);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);                      // force la fin du rendu GPU
    ts.push(performance.now() - t);
    await frame();
  }
  ts.sort((a, b) => a - b);
  let n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 3000) { camA.theta += 0.01; updCam(); await frame(); n++; scriptCheckStop(); }
  return { ms: ts[7], fps: Math.round(n * 1000 / (performance.now() - t0)) };
}

async function csg(label, build, op, q) {
  scriptCheckStop();
  clearAll();
  setCsgQuality(q);
  lastPass1 = null;
  const sel = build();
  selObjs = sel; updProps(); updOList(true); updCSG();
  const inTris = sel.reduce((s, o) => { const g = makeGeoCSG(o); const n = g.index ? g.index.count / 3 : g.attributes.position.count / 3; g.dispose(); return s + n; }, 0);
  const t0 = performance.now();
  let err = null;
  try { await doCSG(op); } catch (e) { err = e; }
  const dt = performance.now() - t0;
  const ok = !err && !sel.some(o => objs.includes(o));
  const res = objs.at(-1);
  log(`CSG | ${label} | CSG⚡${q} | ~${Math.round(inTris / 1000)}k tri en entrée | `
    + (ok ? fmt(dt) : 'ÉCHEC ' + (err ? err.message : '(voir log)'))
    + (lastPass1 != null ? ` | aperçu ${fmt(lastPass1)}` : '')
    + (ok && res ? ` | résultat ${res.mesh.geometry.attributes.position.count} sommets` : ''));
  await pause(400);
}

try {
  // ── Machine ──────────────────────────────────────────────────────────────
  let gpu = '?';
  try { const e = gl.getExtension('WEBGL_debug_renderer_info'); if (e) gpu = gl.getParameter(e.UNMASKED_RENDERER_WEBGL); } catch (e) {}
  let ping = {};
  try { ping = await (await fetch(_BOOSTER_URL + '/ping')).json(); } catch (e) {}
  log('=== RÉSULTATS BENCH NASSCAD ' + new Date().toISOString().slice(0, 16) + ' ===');
  log(`MACHINE | ${navigator.hardwareConcurrency} threads | RAM ${_machineInfo && _machineInfo.ramMB ? Math.round(_machineInfo.ramMB / 1024) + ' GB' : '?'} | GPU ${gpu} | écran ${screen.width}×${screen.height}@${devicePixelRatio}`);
  log(`NAV | ${(navigator.userAgent.match(/(Edg|Chrome|Firefox)\/[\d.]+/g) || [navigator.userAgent]).join(' ')}`);
  log(`MEDUSA | ${JSON.stringify(ping).slice(0, 200)}`);

  // Capte la durée de l'aperçu (passe 1 du CSG progressif) dans le log.
  window.nasLog = function (lvl, msg, ...rest) {
    try { const k = String(msg).match(/Pass 1 OK: (\d+)ms/); if (k) lastPass1 = +k[1]; } catch (e) {}
    return _nl.call(this, lvl, msg, ...rest);
  };

  // ── 1. Affichage ─────────────────────────────────────────────────────────
  const TIERS = [[500, 32], [1000, 32], [2000, 32], [1000, 64], [500, 128], [1000, 128], [2000, 128]];
  for (const [n, res] of TIERS) {
    scriptCheckStop();
    clearAll();
    setSphereResLive(res);
    const t0 = performance.now();
    const side = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) mk('sphere', (i % side) * 25, null, Math.floor(i / side) * 25);
    updOList(); updStats();
    const tb = performance.now() - t0;
    const m = await measureView();
    log(`VUE | ${n} sphères ×${res} | ${(verts() / 1e6).toFixed(2)} M sommets | création ${fmt(tb)} | rendu ${m.ms.toFixed(1)} ms/image | orbite ${m.fps} FPS | heap ${heap()}`);
    if (m.fps < 8) { log('VUE | paliers suivants sautés (orbite < 8 FPS)'); break; }
  }
  clearAll();
  setSphereResLive(32);

  // ── 2. Booléens (MEDUSA) ─────────────────────────────────────────────────
  await csg('cube − cylindre', () => {
    const a = mk('cube', 0, null, 0), b = mk('cylinder', 4, null, 0);
    b.mesh.scale.set(0.4, 1.2, 0.4); b.mesh.updateMatrixWorld(true); b.isHole = true;
    return [a, b];
  }, 'subtract', 128);
  const twoSpheres = () => [mk('sphere', 3, null, 3), mk('sphere', 13, null, 3)];
  await csg('sphère ∪ sphère', twoSpheres, 'union', 64);
  await csg('sphère ∪ sphère', twoSpheres, 'union', 128);
  await csg('sphère ∪ sphère', twoSpheres, 'union', 256);
  await csg('sphère ∪ sphère', twoSpheres, 'union', 512);
  await csg('plaque 200 mm − 100 trous ø5', () => {
    const p = mk('cube', 0, 5, 0); p.mesh.scale.set(10, 0.5, 10); p.mesh.updateMatrixWorld(true);
    const r = [p];
    for (let i = 0; i < 100; i++) {
      const c = mk('cylinder', -90 + (i % 10) * 20, 5, -90 + Math.floor(i / 10) * 20);
      c.mesh.scale.set(0.25, 1, 0.25); c.mesh.updateMatrixWorld(true); c.isHole = true;
      r.push(c);
    }
    return r;
  }, 'union', 128);
  await csg('union 100 sphères qui se chevauchent', () => {
    const r = []; for (let i = 0; i < 100; i++) r.push(mk('sphere', 3 + (i % 10) * 14, null, 3 + Math.floor(i / 10) * 14)); return r;
  }, 'union', 128);
  await csg('union 200 sphères disjointes', () => {
    const r = []; for (let i = 0; i < 200; i++) r.push(mk('sphere', 3 + (i % 15) * 25, null, 3 + Math.floor(i / 15) * 25)); return r;
  }, 'union', 128);

  log('=== FIN — copie tout ce bloc et envoie-le à Claude ===');
} finally {
  window.nasLog = _nl;
  delete window._benchNl;
  try { clearAll(); } catch (e) {}
  try { setCsgQuality(S0.csg); setSphereResLive(S0.res); } catch (e) {}
  camA.theta = S0.th; camA.phi = S0.ph; camA.dist = S0.d; camT.copy(S0.t); updCam();
}
return OUT.join('\n');
