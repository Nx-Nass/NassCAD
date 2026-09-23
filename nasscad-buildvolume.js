// ═══════════════════════════════════════════════════════════════════════════
// nasscad-buildvolume.js — matérialisation du volume d'impression (Nass, 23/09)
//
// Compagnon OPTIONNEL, chargé par <script src> comme nasscad-materials.js.
// Absent → le bouton de la boîte à outils ne fait rien, NASSCAD reste intact.
// Retirer la ligne <script> suffit à revenir exactement à l'état d'avant.
//
// CE QUE ÇA DESSINE
//   Une boîte aux dimensions du plateau de l'imprimante choisie, posée sur la
//   grille (elle suit la grille quand on la déplace). On ne montre QUE les deux
//   murs du fond — ceux qui sont derrière le modèle vu de la caméra — et ils
//   basculent tout seuls quand on tourne : rien ne passe jamais devant la pièce.
//   Plafond masqué par défaut. Le contour du plateau reste toujours visible.
//
// ALERTE DE DÉPASSEMENT
//   Si un objet sort du volume, le mur concerné passe en rouge et s'affiche
//   même s'il est côté caméra — c'est une alerte, elle doit se voir.
//
// LE « MONDE » (ajouté le 23/09 — ce que Nass voulait au départ)
//   Une grande pièce quadrillée — sol, murs, plafond — qui matérialise l'espace
//   autour du travail. Tant que la caméra est DANS la pièce, tout se dessine :
//   un mur est soit derrière la caméra, soit derrière le modèle, jamais entre
//   les deux. Si on recule assez pour sortir, seuls les murs du fond restent.
//   La taille s'adapte à la scène (1 m minimum, par paliers 1-2-5), maillage à
//   1/10 de la demi-largeur : une vis ou le Scania ont chacun une pièce à leur
//   échelle.
//
// REPÈRE : NASSCAD est Y-up. Imprimante X → scène X, imprimante Y (profondeur)
// → scène Z, imprimante Z (hauteur) → scène Y. Plateau centré sur l'origine de
// la grille, comme dans les slicers.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

// [23/09 — Claude] Imprimantes les plus vendues (volumes constructeur, X × Y × Z mm).
// Les id existants sont conservés pour ne pas perdre le choix déjà mémorisé.
const BV_BRANDS = [
  { brand: 'Bambu Lab', items: [
    { id: 'bambu256',   name: 'X1 / P1 / P2S / A1',          x: 256, y: 256, z: 256 },
    { id: 'bambumini',  name: 'A1 mini',                     x: 180, y: 180, z: 180 },
    { id: 'bambuh2d',   name: 'H2D (single nozzle)',         x: 325, y: 320, z: 325 },
    { id: 'bambuh2s',   name: 'H2S',                         x: 340, y: 320, z: 340 },
  ]},
  { brand: 'Creality', items: [
    { id: 'ender3v1',   name: 'Ender-3 (V1) / Pro / V2',     x: 220, y: 220, z: 250 },
    { id: 'ender3neo',  name: 'Ender-3 Neo / V2 Neo',        x: 220, y: 220, z: 250 },
    { id: 'ender3s1',   name: 'Ender-3 S1 / S1 Pro',         x: 220, y: 220, z: 270 },
    { id: 'ender3v3se', name: 'Ender-3 V3 SE',               x: 220, y: 220, z: 250 },
    { id: 'ender3v3ke', name: 'Ender-3 V3 KE',               x: 220, y: 220, z: 240 },
    { id: 'ender3v3',   name: 'Ender-3 V3',                  x: 220, y: 220, z: 250 },
    { id: 'ender3maxn', name: 'Ender-3 Max Neo',             x: 300, y: 300, z: 320 },
    { id: 'k1c',        name: 'K1 / K1C',                    x: 220, y: 220, z: 250 },
    { id: 'k1max',      name: 'K1 Max',                      x: 300, y: 300, z: 300 },
    { id: 'crhi',       name: 'Hi',                          x: 260, y: 260, z: 300 },
    { id: 'k2',         name: 'K2',                          x: 260, y: 260, z: 260 },
    { id: 'k2pro',      name: 'K2 Pro',                      x: 300, y: 300, z: 300 },
    { id: 'k2plus',     name: 'K2 Plus',                     x: 350, y: 350, z: 350 },
  ]},
  { brand: 'Prusa', items: [
    { id: 'prusamk4',   name: 'MK4 / MK4S',                  x: 250, y: 210, z: 220 },
    { id: 'prusamk3',   name: 'i3 MK3S+',                    x: 250, y: 210, z: 210 },
    { id: 'prusacore',  name: 'CORE One',                    x: 250, y: 220, z: 270 },
    { id: 'prusamini',  name: 'MINI+',                       x: 180, y: 180, z: 180 },
    { id: 'prusaxl',    name: 'XL',                          x: 360, y: 360, z: 360 },
  ]},
  { brand: 'Elegoo', items: [
    { id: 'centauri',   name: 'Centauri Carbon',             x: 256, y: 256, z: 256 },
    { id: 'neptune4',   name: 'Neptune 4 / 4 Pro',           x: 225, y: 225, z: 265 },
  ]},
  { brand: 'Anycubic', items: [
    { id: 'kobra3',     name: 'Kobra 3',                     x: 250, y: 250, z: 260 },
    { id: 'kobras1',    name: 'Kobra S1',                    x: 250, y: 250, z: 250 },
  ]},
  { brand: 'Open source', items: [
    { id: 'voron350',   name: 'Voron 2.4 — 350',             x: 350, y: 350, z: 340 },
    { id: 'sovolsv08',  name: 'Sovol SV08',                  x: 350, y: 350, z: 345 },
  ]},
];
// Liste à plat (nom complet marque + modèle, pour le journal et l'infobulle).
const BV_PRESETS = BV_BRANDS.flatMap(b => b.items.map(p => Object.assign({}, p, { model: p.name, name: b.brand + ' ' + p.name })));
const BV_STEP = 10;           // pas du maillage des murs, en mm
const BV_KEY  = 'nasscad_buildvolume';

const _bv = {
  on: false, preset: 'bambu256', ceiling: false,     // [23/09] désactivés par défaut (Nass)
  world: false, wGroup: null, wFaces: {}, wS: 0, wDark: null, wSig: '', wExt: 0,
  group: null, walls: {}, plate: null, ceil: null,
  lastSig: '', over: { nx: 0, px: 0, nz: 0, pz: 0, py: 0 }, overSig: '',
  dark: null, ready: false,
};

function _bvLoad() {
  try {
    const s = JSON.parse(localStorage.getItem(BV_KEY) || 'null');
    if (s) { _bv.on = s.on === true; if (BV_PRESETS.some(p => p.id === s.preset)) _bv.preset = s.preset; _bv.ceiling = !!s.ceiling; _bv.world = s.world === true; }
  } catch (e) {}
}
function _bvSave() {
  try { localStorage.setItem(BV_KEY, JSON.stringify({ on: _bv.on, preset: _bv.preset, ceiling: _bv.ceiling, world: _bv.world })); } catch (e) {}
  _bvOffButton();
}

// [23/09 — Claude] Bouton « tout débrayer » (à droite du bouton Build volume) :
// 1 clic = masque volume d'impression + grille monde (la grille de travail reste),
// 2e clic = remet ce qui était affiché. Rien d'affiché et rien à remettre = bouton grisé.
let _bvRestore = null;
function _bvOffButton() {
  const b = document.getElementById('tool-bvoff');
  if (!b) return;
  const shown = _bv.on || _bv.world;
  b.style.opacity = (shown || _bvRestore) ? '1' : '0.35';
  b.style.color = shown ? 'var(--danger)' : (_bvRestore ? 'var(--success)' : '');
  b.title = shown
    ? 'Hide build volume + world grid in one click (the work grid stays)'
    : (_bvRestore ? 'Show again: ' + [_bvRestore.on ? 'build volume' : '', _bvRestore.world ? 'world grid' : ''].filter(Boolean).join(' + ')
                  : 'Build volume and world grid are already hidden');
}
function buildVolumeAllOff() {
  if (_bv.on || _bv.world) {
    _bvRestore = { on: _bv.on, world: _bv.world };
    _bv.on = false; _bv.world = false;
    if (typeof nasLog === 'function') nasLog('OK', 'Build volume + world grid hidden (click again to restore)');
  } else if (_bvRestore) {
    _bv.on = _bvRestore.on; _bv.world = _bvRestore.world; _bvRestore = null;
    if (typeof nasLog === 'function') nasLog('OK', 'Build volume / world grid restored');
  } else return;
  _bvSave(); _bvBuild(); _wBuild();
  const dd = document.getElementById('bvdd');
  if (dd && dd.style.display === 'block') _bvMenuRender();
}
window.buildVolumeAllOff = buildVolumeAllOff;
const _bvPreset = () => BV_PRESETS.find(p => p.id === _bv.preset) || BV_PRESETS[0];
const _bvIsDark = () => document.documentElement.getAttribute('data-theme') === 'dark';

// Couleurs : même famille que la grille de NASSCAD, un cran plus discrètes.
function _bvColors() {
  const dk = _bvIsDark();
  return {
    line:  dk ? 0x4a6aa0 : 0x7d95b8, lineOp:  dk ? 0.38 : 0.45,
    edge:  dk ? 0x6f8fc8 : 0x5d7aa6, edgeOp:  dk ? 0.85 : 0.90,
    fill:  dk ? 0x2a3a5c : 0xc9d6ea, fillOp:  dk ? 0.10 : 0.12,
    alert: 0xe5484d,
  };
}

// Un mur = un maillage de lignes + un cadre + un voile très léger.
// a0/a1 : étendue sur le premier axe du mur, b0/b1 sur le second, plan à `c`.
function _bvWall(axis, c, a0, a1, b0, b1, col) {
  const g = new THREE.Group();
  const pt = (a, b) => axis === 'x' ? new THREE.Vector3(c, b, a)      // mur ⟂ X : a=Z, b=Y
                     : axis === 'z' ? new THREE.Vector3(a, b, c)      // mur ⟂ Z : a=X, b=Y
                                    : new THREE.Vector3(a, c, b);     // plafond ⟂ Y : a=X, b=Z
  const grid = [];
  for (let a = Math.ceil(a0 / BV_STEP) * BV_STEP; a <= a1 + 1e-6; a += BV_STEP) grid.push(pt(a, b0), pt(a, b1));
  for (let b = Math.ceil(b0 / BV_STEP) * BV_STEP; b <= b1 + 1e-6; b += BV_STEP) grid.push(pt(a0, b), pt(a1, b));
  const lm = new THREE.LineBasicMaterial({ color: col.line, transparent: true, opacity: col.lineOp, depthWrite: false });
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(grid), lm));
  const em = new THREE.LineBasicMaterial({ color: col.edge, transparent: true, opacity: col.edgeOp, depthWrite: false });
  g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([pt(a0, b0), pt(a1, b0), pt(a1, b1), pt(a0, b1)]), em));
  const fg = new THREE.BufferGeometry().setFromPoints([pt(a0, b0), pt(a1, b0), pt(a1, b1), pt(a0, b0), pt(a1, b1), pt(a0, b1)]);
  const fm = new THREE.MeshBasicMaterial({ color: col.fill, transparent: true, opacity: col.fillOp, side: THREE.DoubleSide, depthWrite: false });
  g.add(new THREE.Mesh(fg, fm));
  g.userData = { lm, em, fm };
  g.renderOrder = -1;
  return g;
}

function _bvDispose() {
  if (!_bv.group) return;
  scene.remove(_bv.group);
  _bv.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  _bv.group = null; _bv.walls = {}; _bv.plate = null; _bv.ceil = null;
}

function _bvBuild() {
  _bvDispose();
  _bv.lastSig = ''; _bv.overSig = '';
  _bv.dark = _bvIsDark();
  if (!_bv.on) { _bvButton(); if (typeof _camDirty !== 'undefined') _camDirty = true; return; }
  const p = _bvPreset(), col = _bvColors();
  const hx = p.x / 2, hz = p.y / 2, H = p.z;
  const G = new THREE.Group();
  G.name = 'nasscad-buildvolume';
  _bv.walls.nx = _bvWall('x', -hx, -hz, hz, 0, H, col);   // mur gauche  (-X)
  _bv.walls.px = _bvWall('x',  hx, -hz, hz, 0, H, col);   // mur droit   (+X)
  _bv.walls.nz = _bvWall('z', -hz, -hx, hx, 0, H, col);   // mur arrière (-Z)
  _bv.walls.pz = _bvWall('z',  hz, -hx, hx, 0, H, col);   // mur avant   (+Z)
  _bv.ceil     = _bvWall('y',  H,  -hx, hx, -hz, hz, col); // plafond     (+Y)
  Object.values(_bv.walls).forEach(w => G.add(w));
  G.add(_bv.ceil);
  // Contour du plateau : toujours visible, léger relief au-dessus de la grille.
  const pm = new THREE.LineBasicMaterial({ color: col.edge, transparent: true, opacity: col.edgeOp, depthWrite: false });
  _bv.plate = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-hx, 0.05, -hz), new THREE.Vector3(hx, 0.05, -hz),
    new THREE.Vector3(hx, 0.05, hz), new THREE.Vector3(-hx, 0.05, hz)]), pm);
  G.add(_bv.plate);
  G.traverse(o => { o.castShadow = false; o.receiveShadow = false; o.raycast = () => {}; });
  _bv.group = G;
  scene.add(G);
  _bvButton();
  _bvTick(true);
}

// Recolore un mur : normal ou alerte.
function _bvTint(w, alert) {
  if (!w) return;
  const col = _bvColors(), u = w.userData;
  u.lm.color.setHex(alert ? col.alert : col.line); u.lm.opacity = alert ? 0.55 : col.lineOp;
  u.em.color.setHex(alert ? col.alert : col.edge); u.em.opacity = alert ? 1 : col.edgeOp;
  u.fm.color.setHex(alert ? col.alert : col.fill); u.fm.opacity = alert ? 0.14 : col.fillOp;
}

// Contrôle de dépassement — boîtes englobantes des objets (8 coins transformés),
// pas de parcours des sommets : reste instantané même sur 2000 objets.
const _bvC = new THREE.Vector3(), _bvBB = new THREE.Box3();
function _bvCheckOverflow() {
  const res = { nx: 0, px: 0, nz: 0, pz: 0, py: 0 };
  if (!_bv.on || !_bv.group || typeof objs === 'undefined' || !objs.length) return res;
  const p = _bvPreset(), o0 = _bv.group.position;
  const hx = p.x / 2, hz = p.y / 2, H = p.z, tol = 0.01;
  for (const o of objs) {
    const m = o && o.mesh; if (!m || !m.geometry || m.visible === false) continue;
    const g = m.geometry; if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox; if (!b) continue;
    m.updateMatrixWorld(); _bvBB.makeEmpty();
    for (let i = 0; i < 8; i++) {
      _bvC.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(m.matrixWorld);
      _bvBB.expandByPoint(_bvC);
    }
    res.nx = Math.max(res.nx, (-hx + o0.x) - _bvBB.min.x);
    res.px = Math.max(res.px, _bvBB.max.x - (hx + o0.x));
    res.nz = Math.max(res.nz, (-hz + o0.z) - _bvBB.min.z);
    res.pz = Math.max(res.pz, _bvBB.max.z - (hz + o0.z));
    res.py = Math.max(res.py, _bvBB.max.y - (H + o0.y));
  }
  for (const k in res) if (res[k] <= tol) res[k] = 0;
  return res;
}

// Appelé à chaque image, mais ne touche la scène que si quelque chose change.
function _bvTick(force) {
  if (!_bv.on || !_bv.group || typeof cam === 'undefined') return;
  if (_bv.dark !== _bvIsDark()) { _bvBuild(); return; }          // thème basculé
  if (typeof _gridGroup !== 'undefined' && _gridGroup) {
    const gp = _gridGroup.position;
    if (!_bv.group.position.equals(gp)) { _bv.group.position.copy(gp); force = true; }
    _bv.group.visible = true;
  }
  const c = _bv.group.position;
  const cx = cam.position.x - c.x, cz = cam.position.z - c.z;
  const ov = _bv.over;
  // Murs du fond : celui qui est à l'opposé de la caméra sur chaque axe.
  const vis = {
    nx: cx >= 0 || ov.nx > 0, px: cx < 0 || ov.px > 0,
    nz: cz >= 0 || ov.nz > 0, pz: cz < 0 || ov.pz > 0,
  };
  const ceilVis = _bv.ceiling || ov.py > 0;
  const sig = [vis.nx, vis.px, vis.nz, vis.pz, ceilVis, ov.nx > 0, ov.px > 0, ov.nz > 0, ov.pz > 0, ov.py > 0].join('');
  if (!force && sig === _bv.lastSig) return;
  _bv.lastSig = sig;
  for (const k in _bv.walls) { _bv.walls[k].visible = vis[k]; _bvTint(_bv.walls[k], ov[k] > 0); }
  _bv.ceil.visible = ceilVis; _bvTint(_bv.ceil, ov.py > 0);
  if (typeof _camDirty !== 'undefined') _camDirty = true;
}

function _bvLoop() {
  try { _bvTick(false); } catch (e) {}
  try { _wTick(false); } catch (e) {}
  requestAnimationFrame(_bvLoop);
}

// Le contrôle de dépassement tourne à part, 2 fois par seconde — les objets ne
// bougent pas à chaque image, et le calcul n'a aucune raison d'être par frame.
function _bvWatch() {
  try {
    if (_bv.on && _bv.group) {
      const r = _bvCheckOverflow();
      const s = Object.keys(r).map(k => r[k] > 0 ? k + ':' + r[k].toFixed(1) : '').join('');
      if (s !== _bv.overSig) {
        const was = !!_bv.overSig;
        _bv.overSig = s; _bv.over = r;
        const names = { nx: 'left', px: 'right', nz: 'back', pz: 'front', py: 'top' };
        const parts = Object.keys(r).filter(k => r[k] > 0).map(k => names[k] + ' by ' + r[k].toFixed(1) + ' mm');
        if (typeof nasLog === 'function') {
          if (parts.length) nasLog('WARN', 'Build volume (' + _bvPreset().name + '): model exceeds ' + parts.join(', '));
          else if (was) nasLog('OK', 'Build volume: model fits in ' + _bvPreset().name);
        }
        _bvTick(true);
        _bvButton();
      }
    }
  } catch (e) {}
  setTimeout(_bvWatch, 500);
}


// ── LE MONDE : pièce quadrillée (sol, murs, plafond) ───────────────────────
function _wColors() {
  const dk = _bvIsDark();
  return { line: dk ? 0x3f5a88 : 0x8fa4c4, op: dk ? 0.30 : 0.38, edge: dk ? 0x5b78ae : 0x6f89b0, eop: dk ? 0.60 : 0.65 };
}
// Demi-largeur de la pièce : 1 m minimum, sinon 1.5 × l'étendue de la scène,
// arrondie au palier 1-2-5 supérieur (1 m, 2 m, 5 m, 10 m, 20 m…).
function _wSizeFor(ext) {
  const need = Math.max(1000, ext * 1.5);
  let d = Math.pow(10, Math.floor(Math.log10(need)));
  for (const k of [1, 2, 5, 10]) if (k * d >= need) return k * d;
  return 10 * d;
}
function _wFace(axis, c, a0, a1, b0, b1, step, col) {
  const pt = (a, b) => axis === 'x' ? new THREE.Vector3(c, b, a)
                     : axis === 'z' ? new THREE.Vector3(a, b, c)
                                    : new THREE.Vector3(a, c, b);
  const L = [];
  for (let a = a0; a <= a1 + 1e-6; a += step) L.push(pt(a, b0), pt(a, b1));
  for (let b = b0; b <= b1 + 1e-6; b += step) L.push(pt(a0, b), pt(a1, b));
  const g = new THREE.Group();
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(L),
    new THREE.LineBasicMaterial({ color: col.line, transparent: true, opacity: col.op, depthWrite: false })));
  g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([pt(a0, b0), pt(a1, b0), pt(a1, b1), pt(a0, b1)]),
    new THREE.LineBasicMaterial({ color: col.edge, transparent: true, opacity: col.eop, depthWrite: false })));
  g.renderOrder = -2;
  return g;
}
function _wDispose() {
  if (!_bv.wGroup) return;
  scene.remove(_bv.wGroup);
  _bv.wGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  _bv.wGroup = null; _bv.wFaces = {};
}
function _wBuild() {
  _wDispose();
  _bv.wSig = ''; _bv.wDark = _bvIsDark();
  if (!_bv.world) { if (typeof _camDirty !== 'undefined') _camDirty = true; return; }
  if (!_bv.wS) _bv.wS = _wSizeFor(_bv.wExt);
  const S = _bv.wS, H = S, st = S / 10, col = _wColors();
  const G = new THREE.Group(); G.name = 'nasscad-world';
  const F = _bv.wFaces;
  F.nx = _wFace('x', -S, -S, S, 0, H, st, col);   // mur gauche
  F.px = _wFace('x',  S, -S, S, 0, H, st, col);   // mur droit
  F.nz = _wFace('z', -S, -S, S, 0, H, st, col);   // mur du fond
  F.pz = _wFace('z',  S, -S, S, 0, H, st, col);   // mur avant
  F.py = _wFace('y',  H, -S, S, -S, S, st, col);  // plafond
  F.ny = _wFace('y', -0.3, -S, S, -S, S, st, col); // sol (sous la grille NASSCAD)
  Object.values(F).forEach(f => G.add(f));
  G.traverse(o => { o.castShadow = false; o.receiveShadow = false; o.raycast = () => {}; });
  _bv.wGroup = G; scene.add(G);
  _wTick(true);
}
// Règle unique : une face se dessine si la caméra est du côté INTÉRIEUR de son
// plan. Caméra dans la pièce → tout. Caméra sortie → seules les faces du fond.
function _wTick(force) {
  if (!_bv.world || !_bv.wGroup || typeof cam === 'undefined') return;
  if (_bv.wDark !== _bvIsDark()) { _wBuild(); return; }
  if (typeof _gridGroup !== 'undefined' && _gridGroup && !_bv.wGroup.position.equals(_gridGroup.position)) {
    _bv.wGroup.position.copy(_gridGroup.position); force = true;
  }
  const S = _bv.wS, c = _bv.wGroup.position;
  const x = cam.position.x - c.x, y = cam.position.y - c.y, z = cam.position.z - c.z;
  const v = { nx: x > -S, px: x < S, nz: z > -S, pz: z < S, py: y < S, ny: y > 0 };
  const sig = Object.values(v).join('');
  if (!force && sig === _bv.wSig) return;
  _bv.wSig = sig;
  for (const k in v) _bv.wFaces[k].visible = v[k];
  if (typeof _camDirty !== 'undefined') _camDirty = true;
}
// Étendue de la scène autour de l'origine de la grille (boîtes englobantes).
function _wExtent() {
  if (typeof objs === 'undefined' || !objs.length) return 0;
  const o0 = (typeof _gridGroup !== 'undefined' && _gridGroup) ? _gridGroup.position : new THREE.Vector3();
  let e = 0;
  for (const o of objs) {
    const m = o && o.mesh; if (!m || !m.geometry) continue;
    const g = m.geometry; if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox; if (!b) continue;
    m.updateMatrixWorld();
    for (let i = 0; i < 8; i++) {
      _bvC.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(m.matrixWorld).sub(o0);
      e = Math.max(e, Math.abs(_bvC.x), Math.abs(_bvC.z), _bvC.y);
    }
  }
  return e;
}
function _wWatch() {
  try {
    if (_bv.world) {
      _bv.wExt = _wExtent();
      const want = _wSizeFor(_bv.wExt);
      // Grandit dès qu'il faut ; ne rétrécit que si la scène tient dans le quart
      // de la pièce — pas de pièce qui « respire » à chaque petit déplacement.
      if (!_bv.wGroup || want > _bv.wS || want * 4 <= _bv.wS) {
        if (want !== _bv.wS || !_bv.wGroup) { _bv.wS = want; _wBuild(); }
      }
    }
  } catch (e) {}
  setTimeout(_wWatch, 700);
}

// ── Bouton + menu ───────────────────────────────────────────────────────────
function _bvButton() {
  _bvOffButton();
  const b = document.getElementById('tool-buildvol');
  if (!b) return;
  const p = _bvPreset(), bad = _bv.on && _bv.overSig;
  b.classList.toggle('active', _bv.on);
  b.style.opacity = _bv.on ? '1' : '0.35';
  b.style.color = bad ? 'var(--danger)' : '';
  b.title = 'Build volume — ' + (_bv.on ? p.name + ' (' + p.x + '×' + p.y + '×' + p.z + ' mm)' : 'hidden')
          + (bad ? ' — ⚠ model exceeds the volume' : '') + ' · click for printer / options';
}

function _bvMenuEl() {
  let dd = document.getElementById('bvdd');
  if (dd) return dd;
  dd = document.createElement('div');
  dd.id = 'bvdd';
  dd.className = 'vb-win';
  dd.style.cssText = 'position:absolute;display:none;z-index:300;background:var(--panel);border:1px solid var(--lo);'
    + 'border-radius:var(--radius-sm);box-shadow:0 4px 16px var(--shadow);overflow:auto;max-height:calc(100vh - 40px);width:660px;max-width:96vw;padding:2px';
  document.body.appendChild(dd);
  const st = document.createElement('style');
  st.textContent = '#bvdd .exi{padding:5px 10px}#bvdd .exi .bvd{margin-left:auto;padding-left:12px;color:var(--muted)}'
    + '#bvdd .exi.bvsel{font-weight:700;color:var(--accent)}#bvdd .exi:hover,#bvdd .exi:hover .bvd{color:#fff}';
  document.head.appendChild(st);
  document.addEventListener('click', e => {
    // composedPath et non closest : un clic dans le menu le re-rend (innerHTML),
    // la cible est alors détachée du DOM et closest() ne trouverait plus #bvdd.
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(dd) && !e.target.closest('#tool-buildvol')) dd.style.display = 'none';
  });
  return dd;
}

function _bvMenuRender() {
  const dd = _bvMenuEl();
  const row = (html, act, on) => `<div class="exi${on ? ' bvsel' : ''}" data-bv="${act}">${html}</div>`;
  let h = '<div style="padding:6px 14px 4px;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--accent)">Build volume — printer</div>';
  h += '<div style="columns:2;column-gap:4px;column-rule:1px solid var(--lo)">';
  for (const b of BV_BRANDS) {
    h += '<div style="break-inside:avoid;padding-bottom:4px"><div style="padding:5px 14px 2px;font-size:11px;font-weight:700;color:var(--muted)">' + b.brand + '</div>';
    for (const p of b.items)
      h += row(`${_bv.on && _bv.preset === p.id ? '●' : '○'}&nbsp; ${p.name} <span class="bvd">${p.x}×${p.y}×${p.z}</span>`, 'p:' + p.id, _bv.on && _bv.preset === p.id);
    h += '</div>';
  }
  h += '</div>';
  h += '<div style="height:1px;background:var(--lo);margin:3px 0"></div>';
  h += row(`${_bv.ceiling ? '☑' : '☐'}&nbsp; Show ceiling`, 'ceil', false);
  h += row(`${_bv.on ? '☐' : '☑'}&nbsp; Hide build volume`, 'off', !_bv.on);
  h += '<div style="height:1px;background:var(--lo);margin:3px 0"></div>';
  h += '<div style="padding:6px 14px 4px;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--accent)">World</div>';
  h += row(`${_bv.world ? '☑' : '☐'}&nbsp; World grid — floor, walls, ceiling <span class="bvd">${_bv.wS ? (_bv.wS * 2 / 1000) + ' m' : ''}</span>`, 'world', false);
  dd.innerHTML = h;
  dd.querySelectorAll('[data-bv]').forEach(el => el.onclick = () => {
    const a = el.dataset.bv;
    _bvRestore = null;
    if (a.startsWith('p:')) { _bv.preset = a.slice(2); _bv.on = true; }
    else if (a === 'ceil') { _bv.ceiling = !_bv.ceiling; }
    else if (a === 'off') { _bv.on = !_bv.on; }
    else if (a === 'world') { _bv.world = !_bv.world; _bvSave(); _wBuild(); _bvMenuRender();
      if (typeof nasLog === 'function') nasLog('OK', _bv.world ? 'World grid on' : 'World grid hidden'); return; }
    _bvSave(); _bvBuild(); _bvMenuRender();
    if (typeof nasLog === 'function')
      nasLog('OK', _bv.on ? 'Build volume: ' + _bvPreset().name + ' (' + _bvPreset().x + '×' + _bvPreset().y + '×' + _bvPreset().z + ' mm)' : 'Build volume hidden');
  });
}

// Point d'entrée du bouton de la boîte à outils.
function buildVolumeMenu(btn) {
  const dd = _bvMenuEl();
  if (dd.style.display === 'block') { dd.style.display = 'none'; return; }
  _bvMenuRender();
  dd.style.display = 'block';
  const r = btn.getBoundingClientRect();
  let left = r.right + 4, top = r.top;
  const w = dd.offsetWidth;
  if (left + w > window.innerWidth) left = Math.max(0, r.left - w - 4);
  if (top + dd.offsetHeight > window.innerHeight) top = Math.max(28, window.innerHeight - dd.offsetHeight - 8);
  dd.style.left = left + 'px'; dd.style.top = top + 'px';
}
window.buildVolumeMenu = buildVolumeMenu;

// ── Démarrage : attendre que la scène existe (init() tourne au load) ────────
(function _bvStart() {
  _bvLoad();
  const go = () => {
    if (typeof scene === 'undefined' || !scene || typeof cam === 'undefined' || !cam) { setTimeout(go, 200); return; }
    _bvBuild();
    _bv.wExt = _wExtent(); _bv.wS = _wSizeFor(_bv.wExt); _wBuild();
    setTimeout(_wWatch, 700);
    _bv.ready = true;
    requestAnimationFrame(_bvLoop);
    setTimeout(_bvWatch, 500);
  };
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
})();
