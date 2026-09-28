#!/usr/bin/env node
// Union qui garde les couleurs, cote NASSCAD : les fonctions du client
// (_csgColorRanges, _medusaCSG, _csgKeyGroups...) extraites TELLES QUELLES de
// NASSCAD_V4_7_0.htm, executees avec le three.js du depot contre un MEDUSA reel.
//
//   node tests/nasscad_csg_colors_client_test.js --engine <binaire> [--port 8768]
//
// Scene : un cube THREE.BoxGeometry 10 mm a SIX couleurs (une par face, comme
// un corps STEP multicolore : tableau de materiaux + geometry.groups) et un
// cube d'une seule couleur qui perce sa face +X. Attendu : les 7 teintes
// (l'anneau de la face +X laisse hors du cube uni reste rouge), chaque
// plage de geometry.groups d'une seule teinte, et, face a un MEDUSA sans
// "csgcolors", la requete d'avant sans couleurs.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ENGINE = opt('--engine', null);
const PORT = +opt('--port', 8768);
if (!ENGINE) { console.error('usage: node tests/nasscad_csg_colors_client_test.js --engine <binary> [--port 8768]'); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const THREE = require(path.join(ROOT, 'three.js'));
const HTM = fs.readFileSync(path.join(ROOT, 'NASSCAD_V4_7_0.htm'), 'utf8');
function fn(name) {            // fonction de premier niveau, « function NOM( » ... « \n}\n »
  let start = HTM.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = HTM.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in NASSCAD_V4_7_0.htm`);
  const end = HTM.indexOf('\n}\n', start);
  return HTM.slice(start + 1, end + 2);
}
const ctx = vm.createContext({
  THREE, Math, Map, Set, Array, Uint8Array, Uint32Array, Float32Array, ArrayBuffer, DataView, JSON, TextDecoder,
  fetch, AbortController, setTimeout, clearTimeout, Error,
  _BOOSTER_URL: `http://127.0.0.1:${PORT}`, _wdogBaseSec: 60, _medusaHasCsgColors: true,
  nasLog: () => {}, _medusaRequire: async () => true,
});
vm.runInContext(['_matAll', '_mat1', '_csgColorRanges', '_csgKeyGroups', '_medusaMeshParts',
                 '_medusaDecodeMeshResponse', '_medusaPost', '_medusaCSG'].map(fn).join('\n'), ctx);

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failures++;
}

// Comme le chemin natif de doCSG : geometrie d'affichage, transform monde bakee.
function toSend(o) {
  o.mesh.updateMatrixWorld(true);
  const g = o.mesh.geometry.clone();
  g.applyMatrix4(o.mesh.matrixWorld);
  return { verts: new Float32Array(g.attributes.position.array), idx: g.index ? new Uint32Array(g.index.array) : null };
}

async function main() {
  const child = spawn(ENGINE, [String(PORT)], { stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/ping`)).ok) break; } catch (e) { /* pas encore la */ }
      if (i > 100) throw new Error('engine did not start');
      await new Promise(r => setTimeout(r, 200));
    }
    const faceHex = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff];   // BoxGeometry : +x -x +y -y +z -z
    const A = { color: '#ff0000', mesh: new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10),
                faceHex.map(h => new THREE.MeshPhongMaterial({ color: h }))) };
    const B = { color: '#808080', mesh: new THREE.Mesh(new THREE.BoxGeometry(10, 8, 8), new THREE.MeshPhongMaterial({ color: 0x808080 })) };
    B.mesh.position.set(6, 0, 0);            // recouvre la face +X de A (x = 5)

    // Palette et plages, comme doCSG.
    const pal = [], palIdx = new Map();
    const keyOf = h => { let k = palIdx.get(h); if (k === undefined) { k = pal.length; pal.push(h); palIdx.set(h, k); } return k; };
    const ranges = [A, B].map(o => ctx._csgColorRanges(o, keyOf));
    check('palette: 6 face colours + 1 = 7', pal.length === 7, `${pal.length}`);
    check('multicolour body sends one range per face', ranges[0].length === 6 && ranges[0].every(r => r[1] === 2));

    const r = await ctx._medusaCSG('union', [toSend(A), toSend(B)], false, [], [], 'test', ranges);
    check('union is manifold', r.meta.manifold === true, `${r.meta.triCount} tris`);
    check('one key per triangle', r.keys && r.keys.length === r.meta.triCount);
    const seen = new Set(r.keys);
    check('all 7 colours survive', seen.size === 7, `${[...seen].map(k => pal[k].toString(16)).join(',')}`);
    // B (8 x 8) ne couvre que le centre de la face +X de A (10 x 10) : il en
    // reste un anneau rouge a x = 5, et rien de rouge dans la section de B.
    let redOk = true, redN = 0;
    for (let t = 0; t < r.keys.length; t++) {
      if (pal[r.keys[t]] !== 0xff0000) continue;
      redN++;
      let cy = 0, cz = 0;
      for (let c = 0; c < 3; c++) {
        const v = r.idx[t * 3 + c];
        if (Math.abs(r.verts[v * 3] - 5) > 1e-4) redOk = false;
        cy += r.verts[v * 3 + 1] / 3; cz += r.verts[v * 3 + 2] / 3;
      }
      if (Math.abs(cy) < 4 && Math.abs(cz) < 4) redOk = false;
    }
    check('red (+X face of A) only on the ring left outside B', redN > 0 && redOk, `${redN} tris`);

    const kg = ctx._csgKeyGroups(r.idx, r.keys);
    const covered = kg.groups.reduce((a, g) => a + g.count, 0);
    check('groups cover every triangle exactly once', covered === r.idx.length && kg.idx.length === r.idx.length);
    // Chaque plage ne contient QUE sa teinte : on retrouve la cle de chaque triangle trie.
    const keyOfTri = new Map();
    for (let t = 0; t < r.keys.length; t++) keyOfTri.set(`${r.idx[t * 3]},${r.idx[t * 3 + 1]},${r.idx[t * 3 + 2]}`, r.keys[t]);
    let pure = true;
    for (const g of kg.groups)
      for (let i = g.start; i < g.start + g.count; i += 3)
        if (keyOfTri.get(`${kg.idx[i]},${kg.idx[i + 1]},${kg.idx[i + 2]}`) !== g.key) pure = false;
    check('each group holds a single colour', pure, `${kg.groups.length} groups`);
    // La face -X de A (vert) est a x = -5, et seulement la.
    const green = kg.groups.find(g => pal[g.key] === 0x00ff00);
    let greenAtMinus5 = !!green;
    if (green) for (let i = green.start; i < green.start + green.count; i++) if (Math.abs(r.verts[kg.idx[i] * 3] + 5) > 1e-4) greenAtMinus5 = false;
    check('green (-X face of A) only at x = -5', greenAtMinus5);

    // MEDUSA sans le flag : requete d'avant, pas de cles.
    ctx._medusaHasCsgColors = false;
    const r0 = await ctx._medusaCSG('union', [toSend(A), toSend(B)], false, [], [], 'test', ranges);
    check('engine without csgcolors: plain /csg, no keys', r0.keys === null && r0.meta.triCount === r.meta.triCount);
  } finally {
    child.kill();
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
  process.exitCode = failures ? 1 : 0;
}
main().catch(e => { console.error(e); process.exit(2); });
