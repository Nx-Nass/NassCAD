#!/usr/bin/env node
// Test de POST /csg?colors=1 (MEDUSA) : l'union garde la couleur de chaque
// element, face par face.
//
//   node tests/medusa_csg_colors_test.js --engine <binaire> [--port 8767]
//
// Trois cas, chacun a reponse exacte connue :
//   1. deux boites qui se chevauchent, une couleur chacune : les deux cles
//      reviennent, le volume est celui de l'union (1500 mm3) ;
//   2. une boite deja MULTICOLORE (face +X a part) unie a une boite qui depasse
//      de sa face -X : la cle de la face +X revient, et SEULEMENT sur des
//      triangles de x = 10 ;
//   3. sans ?colors=1 : pas de "triKeys", reponse au format d'avant.
// Code de sortie 1 au premier echec.
'use strict';
const http = require('http');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ENGINE = opt('--engine', null);
const PORT = +opt('--port', 8767);
if (!ENGINE) { console.error('usage: node tests/medusa_csg_colors_test.js --engine <binary> [--port 8767]'); process.exit(2); }

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
      headers: body ? { 'Content-Length': body.length } : {} }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(c) }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}

// Boite [x0,x1]x[y0,y1]x[z0,z1], 12 triangles orientes vers l'exterieur.
// faceKey(normale) -> cle de couleur de la face (plages contigues par face).
function box(x0, x1, y0, y1, z0, z1) {
  const v = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) v.push(x, y, z);
  const P = i => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const quads = [[0, 1, 3, 2, '-x'], [4, 6, 7, 5, '+x'], [0, 4, 5, 1, '-y'], [2, 3, 7, 6, '+y'], [0, 2, 6, 4, '-z'], [1, 5, 7, 3, '+z']];
  const idx = [], faces = [];
  for (const [a, b, cc, d, name] of quads) {
    for (const t of [[a, b, cc], [a, cc, d]]) {
      const [p, q, r] = t.map(P);
      const n = [(q[1] - p[1]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[1] - p[1]),
                 (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]),
                 (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])];
      const out = n[0] * (p[0] - c[0]) + n[1] * (p[1] - c[1]) + n[2] * (p[2] - c[2]);
      idx.push(...(out > 0 ? t : [t[0], t[2], t[1]]));
      faces.push(name);
    }
  }
  return { pos: new Float32Array(v), idx: new Uint32Array(idx), faces };
}

// Plages [premierTri, nbTri, cle] fusionnees quand deux triangles voisins ont la meme cle.
function ranges(faces, keyOf) {
  const r = [];
  faces.forEach((f, t) => {
    const k = keyOf(f);
    if (r.length && r[r.length - 1][2] === k && r[r.length - 1][0] + r[r.length - 1][1] === t) r[r.length - 1][1]++;
    else r.push([t, 1, k]);
  });
  return r;
}

function encode(meshes, colorRanges) {
  let size = 12;
  meshes.forEach((m, i) => { size += 8 + m.pos.byteLength + m.idx.byteLength + (colorRanges ? 4 + colorRanges[i].length * 12 : 0); });
  const b = Buffer.alloc(size); let o = 0;
  b.writeUInt32LE(0, o); o += 4; b.writeUInt32LE(meshes.length, o); o += 4; b.writeUInt32LE(1, o); o += 4;
  meshes.forEach((m, i) => {
    b.writeUInt32LE(m.pos.length / 3, o); o += 4; b.writeUInt32LE(m.idx.length / 3, o); o += 4;
    Buffer.from(m.pos.buffer).copy(b, o); o += m.pos.byteLength;
    Buffer.from(m.idx.buffer).copy(b, o); o += m.idx.byteLength;
    if (colorRanges) {
      b.writeUInt32LE(colorRanges[i].length, o); o += 4;
      for (const [s, n, k] of colorRanges[i]) { b.writeUInt32LE(s, o); b.writeUInt32LE(n, o + 4); b.writeUInt32LE(k, o + 8); o += 12; }
    }
  });
  return b;
}

async function csg(meshes, colorRanges) {
  const res = await request('POST', colorRanges ? '/csg?colors=1' : '/csg', encode(meshes, colorRanges));
  if (res.status !== 200 || res.type.includes('json')) throw new Error('/csg: ' + res.body.toString().slice(0, 200));
  const ab = res.body.buffer.slice(res.body.byteOffset, res.body.byteOffset + res.body.byteLength);
  const jl = new DataView(ab).getUint32(0, true);
  const meta = JSON.parse(Buffer.from(ab, 4, jl).toString());
  let o = 4 + jl;
  const pos = new Float32Array(ab.slice(o, o + meta.vertCount * 12)); o += meta.vertCount * 12;
  const idx = new Uint32Array(ab.slice(o, o + meta.triCount * 12)); o += meta.triCount * 12;
  const keys = meta.triKeys ? new Uint32Array(ab.slice(o, o + meta.triCount * 4)) : null;
  if (meta.triKeys) o += meta.triCount * 4;
  return { meta, pos, idx, keys, trailing: ab.byteLength - o };
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!cond) failures++;
}
const keySet = keys => [...new Set(keys)].sort((a, b) => a - b);

async function main() {
  const child = spawn(ENGINE, [String(PORT)], { stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) {
      try { const r = await request('GET', '/ping'); if (r.status === 200) { const j = JSON.parse(r.body); check('/ping announces csgcolors and meshRev', j.csgcolors === true && typeof j.meshRev === 'string', `meshRev=${j.meshRev}`); break; } } catch (e) { /* pas encore la */ }
      if (i > 100) throw new Error('engine did not start');
      await new Promise(r => setTimeout(r, 200));
    }

    // 1. Deux boites, une couleur chacune.
    const A = box(0, 10, 0, 10, 0, 10), B = box(5, 15, 0, 10, 0, 10);
    const r1 = await csg([A, B], [[[0, 12, 0]], [[0, 12, 1]]]);
    check('1. union is manifold', r1.meta.manifold === true, `${r1.meta.triCount} tris`);
    check('1. volume = 1500', Math.abs(r1.meta.volume - 1500) < 1e-3, `volume=${r1.meta.volume}`);
    check('1. one key per triangle, keys {0,1}', r1.keys && r1.keys.length === r1.meta.triCount && keySet(r1.keys).join() === '0,1',
      r1.keys ? `keys=${keySet(r1.keys)}` : 'no keys');
    check('1. response fully consumed', r1.trailing === 0);
    // Chaque cle reste sur la surface de SON element. Entre x = 5 et x = 10 les
    // faces haut/bas/avant/arriere de A et de B sont coplanaires : l'union garde
    // l'une ou l'autre, les deux sont justes — d'ou des bornes par boite.
    const xsOf = (r, k) => { const xs = []; r.keys.forEach((kk, t) => { if (kk === k) for (let c = 0; c < 3; c++) xs.push(r.pos[r.idx[t * 3 + c] * 3]); }); return xs; };
    check('1. key 0 stays on box A (0 <= x <= 10)', xsOf(r1, 0).every(x => x >= -1e-4 && x <= 10 + 1e-4));
    check('1. key 1 stays on box B (5 <= x <= 15)', xsOf(r1, 1).every(x => x >= 5 - 1e-4 && x <= 15 + 1e-4));
    check('1. the x = 0 face is A\'s, the x = 15 face is B\'s',
      xsOf(r1, 0).some(x => Math.abs(x) < 1e-4) && xsOf(r1, 1).some(x => Math.abs(x - 15) < 1e-4));

    // 2. Boite multicolore (face +X en cle 2) unie a une boite qui depasse de sa face -X.
    const C = box(0, 10, 0, 10, 0, 10), D = box(-5, 5, 2, 8, 2, 8);
    const r2 = await csg([C, D], [ranges(C.faces, f => (f === '+x' ? 2 : 0)), [[0, 12, 1]]]);
    check('2. union is manifold', r2.meta.manifold === true, `${r2.meta.triCount} tris`);
    check('2. keys {0,1,2} all present', r2.keys && keySet(r2.keys).join() === '0,1,2', r2.keys ? `keys=${keySet(r2.keys)}` : 'no keys');
    check('2. key 2 only on the +X face (x = 10)', xsOf(r2, 2).length > 0 && xsOf(r2, 2).every(x => Math.abs(x - 10) < 1e-4));
    check('2. key 1 only where D sticks out (x <= 0)', xsOf(r2, 1).every(x => x <= 1e-4));

    // 3. Sans ?colors=1 : format d'avant.
    const r3 = await csg([A, B], null);
    check('3. no triKeys without ?colors=1', !r3.meta.triKeys && r3.keys === null && r3.trailing === 0);
    check('3. same geometry as with colors', r3.meta.triCount > 0 && Math.abs(r3.meta.volume - r1.meta.volume) < 1e-6,
      `${r3.meta.triCount} vs ${r1.meta.triCount} tris`);
  } finally {
    child.kill();
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
  process.exitCode = failures ? 1 : 0;
}
main().catch(e => { console.error(e); process.exit(2); });
