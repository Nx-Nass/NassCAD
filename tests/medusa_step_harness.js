#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// medusa_step_harness.js — banc d'import STEP de MEDUSA, sans interface.
//
// Pour chaque fichier de tests/step/ :
//   1. POST /step au moteur (127.0.0.1), reponse NSTP v1 decodee comme le fait
//      _nstpDecode (step-import.js) ;
//   2. par corps, LE controle de NASSCAD, a l'identique : _weldAndCheckManifold
//      puis _edgeManifoldCheck. Ces deux fonctions ne sont PAS reecrites ici :
//      elles sont extraites telles quelles de NASSCAD_V4_7_0.htm et executees
//      avec le three.js r128 du depot. Si NASSCAD change son controle, le banc
//      change avec lui ;
//   3. deux lectures du meme corps :
//        raw    — le maillage NSTP tel que recu (bascule Z-up -> Y-up seulement),
//                 soude a tol=3 (0,001 mm) : ce que MEDUSA livre ;
//        client — la chaine complete de l'import (step-import.js, mode leger par
//                 defaut) : Z-up -> Y-up, translation globale de centrage,
//                 lissage natif POST /smooth (30 deg), puis nasEnsureManifold,
//                 c'est-a-dire _weldAndCheckManifold(copie, 3) — ce que NASSCAD
//                 affiche dans son badge « non manifold » ;
//   4. confrontation avec ce que le fichier DECLARE (step-declare.js).
//
// Usage :
//   node tests/medusa_step_harness.js [--engine <binaire>] [--port 8766]
//        [--url http://127.0.0.1:8765] [--dir tests/step] [--only <motif>]
//        [--label after] [--out res.json] [--md res.md] [--baseline before.json]
//        [--no-client] [--strict] [--no-regress] [--verbose] [--from run.json]
//
//   --engine   lance ce binaire sur --port (sinon : moteur deja demarre a --url)
//   --baseline compare a un resultat precedent (JSON produit par --out) :
//              tableau avant/apres dans --md
//   --strict   code de sortie 1 si un corps que son B-Rep declare ferme (champ
//              NSTP `brep`) sort avec une arete nue ou sur-partagee (lecture
//              client), ou si un fichier ne s'importe pas. Moteur plus ancien
//              sans `brep` : critere du fichier entier (step-declare.js).
//   --no-regress  avec --baseline : code de sortie 1 si un fichier recule
//              (plus de corps casses, d'aretes nues ou sur-partagees, brut ou
//              client ; nombre de corps different ; import en echec).
//   --from     relit un resultat deja enregistre (JSON de --out) au lieu de
//              lancer le moteur : tableau --md et controles seulement.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const THREE = require(path.join(ROOT, 'three.js'));
const { nasStepDeclared } = require(path.join(ROOT, 'step-declare.js'));

// ── Arguments ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = k => argv.includes(k);
const ENGINE = opt('--engine', null);
const PORT = +opt('--port', ENGINE ? 8766 : 8765);
const BASE = opt('--url', `http://127.0.0.1:${PORT}`);
const DIR = path.resolve(opt('--dir', path.join(__dirname, 'step')));
const ONLY = opt('--only', null);
const LABEL = opt('--label', 'run');
const OUT = opt('--out', null);
const MD = opt('--md', null);
const BASELINE = opt('--baseline', null);
const CLIENT = !flag('--no-client');
const STRICT = flag('--strict');
const NO_REGRESS = flag('--no-regress');
const FROM = opt('--from', null);
const VERBOSE = flag('--verbose');

// ── Le controle de NASSCAD, extrait du .htm ───────────────────────────────
// Une fonction de premier niveau commence par « function NOM( » en colonne 0
// et se ferme par « } » en colonne 0 : c'est la convention du fichier, et
// l'evaluation plus bas echoue bruyamment si elle cessait d'etre vraie.
function extractTopLevelFunction(src, name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`${name} not found in NASSCAD_V4_7_0.htm`);
  const end = src.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`end of ${name} not found`);
  return src.slice(start + 1, end + 2);
}
const HTM = fs.readFileSync(path.join(ROOT, 'NASSCAD_V4_7_0.htm'), 'utf8');
const nascad = vm.createContext({ THREE, Math, Map, Set, Int32Array, Uint32Array, Float32Array, Infinity });
vm.runInContext(extractTopLevelFunction(HTM, '_edgeManifoldCheck') + '\n'
              + extractTopLevelFunction(HTM, '_weldAndCheckManifold') + '\n'
              + 'this._weldAndCheckManifold = _weldAndCheckManifold;', nascad);
const _weldAndCheckManifold = nascad._weldAndCheckManifold;

// nasEnsureManifold (NASSCAD_V4_7_0.htm) : controle sur une COPIE, tol=3.
function nasscadCheck(posF32, idxU32) {
  const tmp = new THREE.BufferGeometry();
  tmp.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posF32), 3));
  tmp.setIndex(new THREE.BufferAttribute(new Uint32Array(idxU32), 1));
  const manifold = _weldAndCheckManifold(tmp, 3);
  return { manifold, naked: tmp._nakedEdges, over: tmp._overEdges,
           weldedVerts: tmp.attributes.position.count };
}

// ── HTTP minimal (pas de fetch : ses 300 s de delai d'en-tetes coupent les
// gros assemblages) ────────────────────────────────────────────────────────
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: body ? { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } : {} },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '',
                                      body: Buffer.concat(chunks) }));
      });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── NSTP v1 : miroir de _nstpDecode ───────────────────────────────────────
function nstpDecode(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(ab);
  if (ab.byteLength < 16 || dv.getUint32(0, false) !== 0x4E535450) throw new Error('NSTP: invalid magic');
  if (dv.getUint32(4, true) !== 1) throw new Error('NSTP: unsupported version');
  const jsonLen = dv.getUint32(8, true), binLen = dv.getUint32(12, true);
  if (16 + jsonLen + binLen > ab.byteLength) throw new Error('NSTP: truncated');
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 16, jsonLen)));
  const bin = 16 + jsonLen;
  meta.meshes = (meta.meshes || []).map(m => ({
    name: m.name, faces: m.faces, brep: m.brep,
    pos: new Float32Array(ab, bin + m.posOffset, m.posCount),
    idx: new Uint32Array(ab, bin + m.idxOffset, m.idxCount),
  }));
  return meta;
}

// ── La chaine de step-import.js (mode leger) ──────────────────────────────
function toYup(pos) {
  const v = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) { v[i] = pos[i]; v[i + 1] = pos[i + 2]; v[i + 2] = -pos[i + 1]; }
  return v;
}

async function smoothBatch(geos, creaseDeg) {
  let total = 8;
  for (const g of geos) total += 8 + g.pos.byteLength + g.idx.byteLength;
  const req = Buffer.alloc(total);
  let o = 0;
  req.writeFloatLE(creaseDeg, o); o += 4;
  req.writeUInt32LE(geos.length, o); o += 4;
  for (const g of geos) {
    req.writeUInt32LE(g.pos.length / 3, o); o += 4;
    req.writeUInt32LE(g.idx.length / 3, o); o += 4;
    Buffer.from(g.pos.buffer, g.pos.byteOffset, g.pos.byteLength).copy(req, o); o += g.pos.byteLength;
    Buffer.from(g.idx.buffer, g.idx.byteOffset, g.idx.byteLength).copy(req, o); o += g.idx.byteLength;
  }
  const res = await request('POST', '/smooth', req);
  if (res.status !== 200 || res.type.includes('json')) throw new Error('/smooth: ' + res.body.toString().slice(0, 200));
  const ab = res.body.buffer.slice(res.body.byteOffset, res.body.byteOffset + res.body.byteLength);
  const jl = new DataView(ab).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 4, jl)));
  let r = 4 + jl;
  return meta.counts.map((cnt, i) => {
    const pos = new Float32Array(ab.slice(r, r + cnt * 12)); r += cnt * 12;
    r += cnt * 12;                                            // normales : sans effet sur le controle
    const n = meta.idxCounts[i];
    const idx = new Uint32Array(ab.slice(r, r + n * 4)); r += n * 4;
    return { pos, idx };
  });
}

// ── Un fichier ────────────────────────────────────────────────────────────
function tail(arr, n) { return arr.length > n ? arr.slice(arr.length - n) : arr; }

async function runFile(file) {
  const buf = fs.readFileSync(file);
  const declared = nasStepDeclared(buf, { quiet: true });
  const t0 = process.hrtime.bigint();
  const res = await request('POST', '/step', buf);
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  if (res.status !== 200 || res.type.includes('json'))
    return { file: path.basename(file), error: res.body.toString().slice(0, 300), declared: brief(declared) };
  const nstp = nstpDecode(res.body);

  const bodies = nstp.meshes.map(m => {
    const yup = toYup(m.pos);
    const raw = nasscadCheck(yup, m.idx);
    return { name: m.name, brep: m.brep, verts: m.pos.length / 3, tris: m.idx.length / 3,
             raw: { naked: raw.naked, over: raw.over, weldedVerts: raw.weldedVerts, manifold: raw.manifold },
             _yup: yup, _idx: m.idx };
  });

  let smoothMs = 0;
  if (CLIENT && bodies.length) {
    // Centrage global, exactement comme la passe 2 de step-import.js.
    const geos = bodies.map(b => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b._yup), 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(b._idx), 1));
      return g;
    });
    const gBB = new THREE.Box3();
    geos.forEach(g => { g.computeBoundingBox(); gBB.union(g.boundingBox); });
    const ox = -(gBB.min.x + gBB.max.x) * 0.5, oy = -gBB.min.y, oz = -(gBB.min.z + gBB.max.z) * 0.5;
    geos.forEach(g => g.translate(ox, oy, oz));
    const ts = process.hrtime.bigint();
    const sm = await smoothBatch(geos.map(g => ({ pos: g.attributes.position.array, idx: g.index.array })), 30);
    smoothMs = Number(process.hrtime.bigint() - ts) / 1e6;
    sm.forEach((s, i) => {
      const c = nasscadCheck(s.pos, s.idx);
      bodies[i].client = { naked: c.naked, over: c.over, weldedVerts: c.weldedVerts, manifold: c.manifold };
    });
  }
  for (const b of bodies) { delete b._yup; delete b._idx; }

  // Journal du moteur pour CE fichier : tout ce qui suit la derniere banniere.
  let weldLog = [];
  try {
    const lg = (await request('GET', '/log?n=20000')).body.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
    const lines = lg.split('\n');
    let from = 0;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes('[FILE]')) { from = i; break; }
    weldLog = lines.slice(from).filter(l => /\[WELD\]|\[WARN\]|REPAIR|MANIFOLD-RAW/.test(l));
  } catch (e) { /* journal facultatif */ }

  // `closed*` : les seuls corps que leur B-Rep declare fermes (champ NSTP
  // `brep`, MEDUSA >= 27/09). Un moteur plus ancien ne l'emet pas : null.
  const hasBrep = bodies.some(b => b.brep);
  const agg = (which) => {
    const a = { bodiesBroken: 0, naked: 0, over: 0, weldedVerts: 0,
                closedBodies: hasBrep ? 0 : null, closedBroken: hasBrep ? 0 : null,
                closedNaked: hasBrep ? 0 : null, closedOver: hasBrep ? 0 : null };
    for (const b of bodies) {
      const r = b[which]; if (!r) return null;
      if (!r.manifold) a.bodiesBroken++;
      a.naked += r.naked; a.over += r.over; a.weldedVerts += r.weldedVerts;
      if (b.brep === 'closed') {
        a.closedBodies++; a.closedNaked += r.naked; a.closedOver += r.over;
        if (!r.manifold) a.closedBroken++;
      }
    }
    return a;
  };
  return {
    file: path.basename(file), sizeKB: Math.round(buf.length / 1024),
    declared: brief(declared),
    bodies: bodies.length,
    verts: bodies.reduce((a, b) => a + b.verts, 0),
    tris: bodies.reduce((a, b) => a + b.tris, 0),
    stepMs: Math.round(wallMs), engineMs: Math.round(nstp.tessMs || 0), smoothMs: Math.round(smoothMs),
    weldMeta: nstp.metadata && nstp.metadata.weld,
    raw: agg('raw'), client: agg('client'),
    brep: hasBrep ? bodies.reduce((m, b) => (m[b.brep] = (m[b.brep] || 0) + 1, m), {}) : null,
    brokenBodies: bodies.filter(b => !b.raw.manifold || (b.client && !b.client.manifold)),
    weldLog: tail(weldLog, 400),
  };
}

function brief(d) {
  return { solids: d.solids, closedShells: d.shellsClosed, openShells: d.shellsOpen,
           faces: d.counts.ADVANCED_FACE || 0, edges: d.edges, edgeValence: d.edgeValence,
           closedByDeclaration: d.manifoldByDeclaration, system: d.originatingSystem };
}

// ── Rendu ─────────────────────────────────────────────────────────────────
function mdTable(results, base) {
  const byName = new Map((base ? base.results : []).map(r => [r.file, r]));
  const L = [];
  const decl = r => r.declared.closedByDeclaration ? `closed (${r.declared.solids} solids)`
    : `${r.declared.solids} solids, ${r.declared.openShells} open` +
      (Object.keys(r.declared.edgeValence).some(k => k !== '2') ? ', valence≠2' : '');
  const cell = (a, k) => (a && a[k] !== undefined ? a[k] : '—');
  if (base) {
    L.push(`| File | Declared (file) | Bodies | Non-manifold bodies (before → after) | …of which B-rep closed (after) | Naked edges | Over-shared edges | Vertices | /step time ms |`);
    L.push(`|---|---|---:|---:|---:|---:|---:|---:|---:|`);
    for (const r of results) {
      if (r.error) { L.push(`| ${r.file} | ${decl(r)} | ERROR: ${r.error.slice(0, 80)} | | | | | | |`); continue; }
      const b = byName.get(r.file);
      const c = r.client || r.raw, bc = b ? (b.client || b.raw) : null;
      const arrow = (x, y) => (b ? `${x} → ${y}` : `${y}`);
      const cl = c.closedBodies === null ? '—' : `${c.closedBroken} / ${c.closedBodies}`;
      L.push(`| ${r.file} | ${decl(r)} | ${b ? `${b.bodies} → ` : ''}${r.bodies} | ${arrow(cell(bc, 'bodiesBroken'), c.bodiesBroken)} | ${cl} | `
        + `${arrow(cell(bc, 'naked'), c.naked)} | ${arrow(cell(bc, 'over'), c.over)} | `
        + `${arrow(b ? b.verts : '—', r.verts)} | ${arrow(b ? b.stepMs : '—', r.stepMs)} |`);
    }
  } else {
    L.push(`| File | Declared | Bodies | Verts | Tris | raw: broken / naked / over | client: broken / naked / over | /step ms | /smooth ms |`);
    L.push(`|---|---|---:|---:|---:|---|---|---:|---:|`);
    for (const r of results) {
      if (r.error) { L.push(`| ${r.file} | ${decl(r)} | ERROR: ${r.error.slice(0, 80)} | | | | | | |`); continue; }
      const f = a => a ? `${a.bodiesBroken} / ${a.naked} / ${a.over}` : '—';
      L.push(`| ${r.file} | ${decl(r)} | ${r.bodies} | ${r.verts} | ${r.tris} | ${f(r.raw)} | ${f(r.client)} | ${r.stepMs} | ${r.smoothMs} |`);
    }
  }
  return L.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────
async function waitPing(ms) {
  const until = Date.now() + ms;
  for (;;) {
    try { const r = await request('GET', '/ping'); if (r.status === 200) return JSON.parse(r.body.toString()); }
    catch (e) { /* pas encore la */ }
    if (Date.now() > until) throw new Error(`no engine answering at ${BASE}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

// Passe complete : chaque fichier de --dir poste au moteur, puis controle.
async function runAll() {
  const ping = await waitPing(ENGINE ? 20000 : 3000);
  console.log(`engine: ${JSON.stringify(ping)}`);
  const files = fs.readdirSync(DIR).filter(f => /\.(stp|step)$/i.test(f))
    .filter(f => !ONLY || f.includes(ONLY)).sort((a, b) => fs.statSync(path.join(DIR, a)).size - fs.statSync(path.join(DIR, b)).size);
  const results = [];
  for (const f of files) {
    process.stdout.write(`${f} ... `);
    let r;
    try { r = await runFile(path.join(DIR, f)); }
    catch (e) { r = { file: f, error: e.message, declared: brief(nasStepDeclared(fs.readFileSync(path.join(DIR, f)), { quiet: true })) }; }
    results.push(r);
    if (r.error) { console.log(`ERROR ${r.error}`); continue; }
    const c = r.client || r.raw;
    console.log(`${r.bodies} bodies, ${r.verts} verts, ${r.stepMs} ms | raw ${r.raw.bodiesBroken} broken `
      + `(${r.raw.naked} naked, ${r.raw.over} over)` + (r.client ? ` | client ${c.bodiesBroken} broken (${c.naked} naked, ${c.over} over)` : '')
      + (r.declared.closedByDeclaration ? ' | declared closed' : ' | NOT declared closed')
      + (r.brep ? ` | B-rep ${Object.entries(r.brep).map(([k, v]) => `${v} ${k}`).join(', ')}` : ''));
    if (VERBOSE) {
      for (const b of r.brokenBodies.slice(0, 30))
        console.log(`   ✗ ${b.name}${b.brep ? ` [${b.brep}]` : ''}: raw ${b.raw.naked}/${b.raw.over}` + (b.client ? `, client ${b.client.naked}/${b.client.over}` : '')
          + ` (${b.verts} v, ${b.tris} t)`);
      for (const l of r.weldLog.slice(0, 30)) console.log('   ' + l);
    }
  }
  return { label: LABEL, engine: ping, date: new Date().toISOString(), results };
}

async function main() {
  if (NO_REGRESS && !BASELINE) throw new Error('--no-regress needs --baseline <reference.json>');
  let child = null;
  if (ENGINE && !FROM) {
    child = spawn(ENGINE, [String(PORT)], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('exit', c => { if (c) console.error(`engine exited with code ${c}`); });
  }
  try {
    let report;
    if (FROM) {
      // Resultat deja enregistre : ni moteur, ni fichiers — seulement le
      // tableau et les controles (--strict, --no-regress) contre --baseline.
      report = JSON.parse(fs.readFileSync(FROM, 'utf8'));
      if (argv.includes('--label')) report.label = LABEL;
      if (ONLY) report.results = report.results.filter(r => r.file.includes(ONLY));
    } else report = await runAll();
    const results = report.results;
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
    const base = BASELINE ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
    const table = mdTable(results, base);
    if (MD) fs.writeFileSync(MD, table + '\n');
    console.log('\n' + table);
    if (STRICT) {
      const bad = results.filter(r => {
        if (r.error) return true;
        const c = r.client || r.raw;
        return c.closedBroken !== null ? c.closedBroken > 0 : (r.declared.closedByDeclaration && c.bodiesBroken > 0);
      });
      if (bad.length) { console.log(`\nSTRICT: ${bad.length} file(s) with a body declared closed that NASSCAD flags non-manifold (or an import error)`); process.exitCode = 1; }
    }
    if (NO_REGRESS) {
      // Cliquet : un fichier deja passe ne doit jamais reculer. Tout compteur
      // qui AUGMENTE par rapport a la reference (corps casses, aretes nues,
      // aretes sur-partagees, en lecture brute comme apres /smooth), un nombre
      // de corps qui change, un import qui echoue : regression.
      const byName = new Map(base.results.map(r => [r.file, r]));
      const regress = [];
      for (const r of results) {
        const b = byName.get(r.file);
        if (!b) continue;                                   // fichier nouveau : rien a comparer
        if (r.error) { if (!b.error) regress.push(`${r.file}: import failed (${r.error.slice(0, 60)})`); continue; }
        if (b.error) continue;
        if (r.bodies !== b.bodies) regress.push(`${r.file}: bodies ${b.bodies} -> ${r.bodies}`);
        for (const which of ['raw', 'client'])
          for (const k of ['bodiesBroken', 'naked', 'over'])
            if (r[which] && b[which] && r[which][k] > b[which][k]) regress.push(`${r.file}: ${which} ${k} ${b[which][k]} -> ${r[which][k]}`);
      }
      const missing = base.results.filter(b => !results.some(r => r.file === b.file)).length;
      if (regress.length) {
        console.log(`\nNO-REGRESS: ${regress.length} regression(s) against ${path.basename(BASELINE)}`);
        for (const l of regress) console.log('   ' + l);
        process.exitCode = 1;
      } else console.log(`\nNO-REGRESS: ok against ${path.basename(BASELINE)}` + (missing ? ` (${missing} reference file(s) not run)` : ''));
    }
  } finally {
    if (child) child.kill();
  }
}
main().catch(e => { console.error(e); process.exit(2); });
