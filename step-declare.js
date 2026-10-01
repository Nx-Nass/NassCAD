// ════════ NASSCAD — lecture de la DÉCLARATION d'un fichier STEP ════════
//
// [16/09] Pourquoi ce module existe.
//
// Le badge « ⚠ non manifold » était une opinion : il naissait d'un comptage
// d'arêtes fait APRÈS maillage, sans rien à quoi le comparer. Quand il
// s'allumait, on ne savait pas si le fichier était douteux ou si NASSCAD avait
// abîmé quelque chose en chemin — et on a passé des heures à chercher du côté
// du fichier.
//
// Or un fichier STEP ne se contente pas de décrire une forme : il DÉCLARE sa
// topologie, en toutes lettres et en nombres entiers. Deux faces voisines
// pointent sur la MÊME entité EDGE_CURVE, par son numéro. Pas une distance,
// pas une tolérance — un entier. Un solide fermé écrit CLOSED_SHELL ; un
// solide ouvert écrit OPEN_SHELL. Il n'y a rien à deviner, il n'y a qu'à lire.
//
// Mesuré sur les fichiers de référence, avant tout calcul géométrique :
//
//   Scania Engine V8-XT (Autodesk Inventor 2018, 374 Mo)
//     248 MANIFOLD_SOLID_BREP + 6 BREP_WITH_VOIDS, 267 CLOSED_SHELL,
//     0 OPEN_SHELL, et 101 585 arêtes sur 101 585 référencées EXACTEMENT
//     deux fois. 100,000 %.
//
//   Rocky_House       141 solides, 0 OPEN_SHELL, 100,00 % des arêtes à 2
//   Cruise_Assembly   591 solides, 0 OPEN_SHELL, 100,00 % des arêtes à 2
//
// Autrement dit : ces fichiers déclarent des solides parfaitement fermés. Tout
// écart constaté à l'affichage est fabriqué entre la lecture et l'écran, et ce
// module sert à le dire au lieu de le soupçonner.
//
// Ce qu'il ne fait pas : il ne lit AUCUNE géométrie. Pas de surface, pas de
// courbe, pas de B-spline. Compter des entités et des références, c'est une
// passe de texte en flux ; recalculer les surfaces, ce serait réécrire un
// noyau, et OCCT est déjà là pour ça.

'use strict';

// ── Passe de lecture ───────────────────────────────────────────────────────
// Part 21 : une entité = « #id = TYPE(args) ; ». On découpe sur ';' en flux
// pour ne jamais matérialiser un fichier de 374 Mo en une seule chaîne de
// travail. Les chaînes STEP peuvent contenir un ';' entre apostrophes — on ne
// lit que des noms de types et des '#ref', donc un découpage naïf ne peut au
// pire que fabriquer un enregistrement qui ne matche pas le motif, jamais un
// faux comptage.
const _SD_REC = /#(\d+)\s*=\s*!?\s*([A-Z_0-9]+)\s*\(/;

// Types dont la seule présence change la lecture d'un fichier.
const _SD_WATCH = [
  'MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'CLOSED_SHELL', 'OPEN_SHELL',
  'SHELL_BASED_SURFACE_MODEL', 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION',
  'ADVANCED_FACE', 'FACE_SURFACE', 'EDGE_CURVE', 'ORIENTED_EDGE',
  'VERTEX_POINT', 'STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM', 'COLOUR_RGB',
  'PRESENTATION_STYLE_ASSIGNMENT', 'B_SPLINE_SURFACE_WITH_KNOTS',
];

// ── Styles : la table teinte → opacité ─────────────────────────────────────
// [18/09] Un fichier STEP écrit sa transparence dans la même chaîne que sa
// couleur : SURFACE_STYLE_RENDERING_WITH_PROPERTIES porte un
// SURFACE_STYLE_TRANSPARENT(t), et l'opacité vaut 1 − t. Rien, dans NASSCAD,
// ne lisait cette valeur : ni MEDUSA, ni occt-import-js, ni le cache NSTP ne
// transportent d'alpha — un corps semi-transparent arrivait toujours opaque.
//
// Ce qu'on ne fait PAS ici : rattacher un style à un corps. Vérifié sur
// Rocky_House — le texte déclare 143 solides là où OCCT en instancie 161
// (pièces répétées), et seules 81 séquences de faces sur 143 coïncident : un
// appariement par rang peindrait les mauvaises faces. La chaîne d'entités,
// elle, dit sans ambiguïté QUELLE TEINTE est transparente. On construit donc
// une table teinte → opacité, et l'import s'en sert pour la couleur que le
// lecteur a réellement rendue, quel que soit le lecteur.
//
// Garde-fou : une teinte vue à la fois opaque et transparente est AMBIGUË et
// sort de la table. Mieux vaut ne rien changer que deviner.
const _SD_STYLE = new Set([
  'COLOUR_RGB', 'DRAUGHTING_PRE_DEFINED_COLOUR', 'SURFACE_STYLE_TRANSPARENT',
  'SURFACE_STYLE_RENDERING_WITH_PROPERTIES', 'FILL_AREA_STYLE_COLOUR', 'FILL_AREA_STYLE',
  'SURFACE_STYLE_FILL_AREA', 'SURFACE_SIDE_STYLE', 'SURFACE_STYLE_USAGE',
  'PRESENTATION_STYLE_ASSIGNMENT',
]);
// ISO 10303-46 : les seuls noms normalisés de draughting_pre_defined_colour.
const _SD_PREDEF = {
  red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], yellow: [1, 1, 0],
  magenta: [1, 0, 1], cyan: [0, 1, 1], black: [0, 0, 0], white: [1, 1, 1],
};
const _SD_HEX = c => '#' + ((Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8)
  | Math.round(c[2] * 255)).toString(16).padStart(6, '0');

function _sdResolveStyles(rec) {
  const rgbOf = new Map(), alphaOf = new Map();
  for (const [id, e] of rec) {
    if (e.t === 'COLOUR_RGB') { if (e.nums.length >= 3) rgbOf.set(id, e.nums.slice(-3)); }
    else if (e.t === 'DRAUGHTING_PRE_DEFINED_COLOUR') {
      const c = _SD_PREDEF[(e.str || '').toLowerCase()]; if (c) rgbOf.set(id, c);
    } else if (e.t === 'SURFACE_STYLE_TRANSPARENT') {
      if (e.nums.length) alphaOf.set(id, Math.max(0, Math.min(1, 1 - e.nums[0])));
    }
  }
  // Descente mémoïsée : couleurs et opacité atteignables depuis un noeud de style.
  const memo = new Map(), busy = new Set();
  function down(id, depth) {
    if (memo.has(id)) return memo.get(id);
    if (depth > 10 || !rec.has(id) || busy.has(id)) return { cols: [], a: 1 };
    busy.add(id);
    const cols = [], e = rec.get(id);
    let a = 1;
    if (rgbOf.has(id)) cols.push(rgbOf.get(id));
    if (alphaOf.has(id)) a = alphaOf.get(id);
    for (const r of e.refs) {
      const d = down(r, depth + 1);
      for (const c of d.cols) if (!cols.some(x => x[0] === c[0] && x[1] === c[1] && x[2] === c[2])) cols.push(c);
      if (d.a < a) a = d.a;
    }
    busy.delete(id);
    const out = { cols, a };
    memo.set(id, out);
    return out;
  }
  // Un PRESENTATION_STYLE_ASSIGNMENT = un style complet. S'il ne mène qu'à une
  // seule teinte, le couple (teinte, opacité) est sans ambiguïté.
  const tally = new Map();
  for (const [id, e] of rec) {
    if (e.t !== 'PRESENTATION_STYLE_ASSIGNMENT' && e.t !== 'SURFACE_STYLE_USAGE') continue;
    const d = down(id, 0);
    if (d.cols.length !== 1) continue;
    const h = _SD_HEX(d.cols[0]);
    if (!tally.has(h)) tally.set(h, new Set());
    tally.get(h).add(+d.a.toFixed(4));
  }
  const table = Object.create(null);
  let ambiguous = 0;
  for (const [h, set] of tally) {
    if (set.size !== 1) { if ([...set].some(a => a < 0.999)) ambiguous++; continue; }
    const a = [...set][0];
    if (a < 0.999) table[h] = a;
  }
  return { table, ambiguous };
}

function _sdHeaderField(head, key) {
  const i = head.indexOf(key);
  if (i < 0) return null;
  const seg = head.slice(i, i + 900);
  const m = seg.match(/'((?:[^']|'')*)'/g);
  return m ? m.map(s => s.slice(1, -1).replace(/''/g, "'")) : null;
}

// text : string | Uint8Array | ArrayBuffer
function nasStepDeclared(text, opts) {
  const o = opts || {};
  if (typeof text !== 'string') {
    const u8 = text instanceof Uint8Array ? text : new Uint8Array(text);
    text = new TextDecoder('utf-8', { fatal: false }).decode(u8);
  }
  const dataAt = text.indexOf('DATA;');
  const head = text.slice(0, dataAt < 0 ? Math.min(text.length, 4000) : dataAt);

  const out = {
    schema: null, originatingSystem: null, preprocessor: null, unit: null,
    counts: Object.create(null),
    solids: 0, shellsClosed: 0, shellsOpen: 0,
    edges: 0, edgeValence: Object.create(null),
    manifoldByDeclaration: null, warnings: [],
  };

  const sch = _sdHeaderField(head, 'FILE_SCHEMA');
  if (sch && sch.length) out.schema = sch[0];
  const nam = _sdHeaderField(head, 'FILE_NAME');
  if (nam) {
    // FILE_NAME(name, time_stamp, author, organization, preprocessor, originating, authorisation)
    out.preprocessor      = nam[4] || null;
    out.originatingSystem = nam[5] || null;
  }
  const um = text.match(/SI_UNIT\s*\(\s*\.([A-Z]+)\.\s*,\s*\.METRE\./);
  if (um) out.unit = um[1];
  else if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text.slice(dataAt, dataAt + 400000))) out.unit = 'INCH';

  // Valence : combien d'ORIENTED_EDGE pointent sur chaque EDGE_CURVE.
  // Un solide fermé 2-manifold en a EXACTEMENT deux par arête — c'est la
  // définition, et elle est vérifiable sans toucher à la géométrie.
  const edgeIds = new Set(), refs = new Map();
  const body = dataAt < 0 ? text : text.slice(dataAt + 5);
  // Entités de style retenues au vol : une poignée par fichier (Rocky_House en
  // compte 8 500 sur 1,2 million), donc rien à pré-dimensionner.
  const styleRec = new Map();

  let from = 0;
  for (;;) {
    const semi = body.indexOf(';', from);
    const chunk = semi < 0 ? body.slice(from) : body.slice(from, semi);
    if (chunk.length) {
      const m = _SD_REC.exec(chunk);
      if (m) {
        const type = m[2];
        out.counts[type] = (out.counts[type] || 0) + 1;
        if (_SD_STYLE.has(type)) {
          const args = chunk.slice(chunk.indexOf('(', m.index) + 1);
          const s = args.match(/'((?:[^']|'')*)'/);
          styleRec.set(+m[1], {
            t: type,
            refs: (args.match(/#(\d+)/g) || []).map(x => +x.slice(1)),
            nums: (args.replace(/'(?:[^']|'')*'/g, '').match(/-?\d+\.\d*(?:E[+-]?\d+)?/gi) || []).map(Number),
            str: s ? s[1].replace(/''/g, "'") : '',
          });
        }
        if (type === 'EDGE_CURVE') edgeIds.add(+m[1]);
        else if (type === 'ORIENTED_EDGE') {
          // Le dernier #ref d'un ORIENTED_EDGE est son EDGE_CURVE.
          let last = -1, r = /#(\d+)/g, mm;
          while ((mm = r.exec(chunk))) last = +mm[1];
          if (last > 0) refs.set(last, (refs.get(last) || 0) + 1);
        }
      }
    }
    if (semi < 0) break;
    from = semi + 1;
  }

  const C = out.counts;
  out.solids = (C.MANIFOLD_SOLID_BREP || 0) + (C.BREP_WITH_VOIDS || 0);
  out.shellsClosed = C.CLOSED_SHELL || 0;
  out.shellsOpen   = (C.OPEN_SHELL || 0) + (C.SHELL_BASED_SURFACE_MODEL || 0);
  out.edges = edgeIds.size;
  for (const id of edgeIds) {
    const n = refs.get(id) || 0;
    out.edgeValence[n] = (out.edgeValence[n] || 0) + 1;
  }
  const two = out.edgeValence[2] || 0;
  out.manifoldByDeclaration = out.edges > 0 && two === out.edges && out.shellsOpen === 0;

  if (!out.solids && !out.shellsOpen)
    out.warnings.push('no B-Rep solid declared — surface, point or purely structural file');
  for (const k of Object.keys(out.edgeValence)) {
    if (+k !== 2) out.warnings.push(`${out.edgeValence[k]} edge(s) referenced ${k} time(s) instead of 2 — the file itself is non-manifold here`);
  }
  if (out.shellsOpen) out.warnings.push(`${out.shellsOpen} open shell(s) declared — these bodies are NOT meant to be watertight`);
  // Table teinte → opacité. Vide dans l'immense majorité des fichiers (aucun
  // SURFACE_STYLE_TRANSPARENT) : dans ce cas l'import ne change rien du tout.
  try {
    const st = _sdResolveStyles(styleRec);
    out.styleAlpha = st.table;
    out.styleAlphaAmbiguous = st.ambiguous;
  } catch (e) {
    out.styleAlpha = Object.create(null); out.styleAlphaAmbiguous = 0;
    out.warnings.push('style scan failed (' + e.message + ') — transparency ignored');
  }
  if (!o.quiet) _sdLog(out);
  return out;
}

// Opacité déclarée pour une teinte '#rrggbb', ou 1. La tolérance de ±1 par
// canal absorbe l'aller-retour sRGB ↔ linéaire du lecteur (OCCT convertit deux
// fois, l'arrondi 8 bits peut bouger d'une unité) ; elle n'est acceptée que si
// UNE seule entrée voisine existe, sinon on rend 1 et rien ne bouge.
function nasStepDeclaredAlpha(decl, hex) {
  const T = decl && decl.styleAlpha;
  if (!T || !hex) return 1;
  if (T[hex] !== undefined) return T[hex];
  const v = parseInt(hex.slice(1), 16);
  if (!isFinite(v)) return 1;
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  let hit = -1;
  for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
    if (!dr && !dg && !db) continue;
    const k = '#' + (((r + dr) << 16) | ((g + dg) << 8) | (b + db)).toString(16).padStart(6, '0');
    const a = T[k];
    if (a === undefined) continue;
    if (hit >= 0 && Math.abs(hit - a) > 1e-4) return 1;   // voisinage ambigu → on ne touche à rien
    hit = a;
  }
  return hit >= 0 ? hit : 1;
}

function _sdSummary(d) {
  const pct = d.edges ? (100 * (d.edgeValence[2] || 0) / d.edges) : 0;
  return `STEP declared: ${d.solids} solid(s), ${d.shellsClosed} closed shell(s), `
       + `${d.shellsOpen} open, ${(d.counts.ADVANCED_FACE || 0).toLocaleString()} face(s), `
       + `${d.edges.toLocaleString()} edge(s), ${pct.toFixed(2)}% shared by exactly 2 faces`
       + (d.originatingSystem ? ` — ${d.originatingSystem}` : '')
       + (d.schema ? ` [${d.schema.split(' ')[0].replace(/[{'"]/g, '')}]` : '');
}

function _sdLog(d) {
  if (typeof nasLog !== 'function') return;
  nasLog(d.manifoldByDeclaration ? 'OK' : 'WARN', _sdSummary(d));
  for (const w of d.warnings) nasLog('WARN', 'STEP declared: ' + w);
}

// ── Confrontation déclaration ↔ import ─────────────────────────────────────
// Le point de tout l'exercice. `result` est la sortie d'occt-import-js (ou du
// protocole MEDUSA) : chaque corps y porte `brep_faces`, c'est-à-dire les
// plages de triangles produites PAR FACE. Cette information est déjà là, et
// elle n'était pas lue.
//
// Mesuré sur Rocky_House — le fichier déclare 0 coque ouverte, et pourtant
// 10 corps sur 161 sortent ouverts. En regardant `brep_faces` on voit
// pourquoi, et ce n'est pas un écart de tolérance :
//
//   Chair    58 faces déclarées, 57 triangulées  →  1 face MANQUANTE, 58 arêtes à nu
//   (×8 instances, exactement le même compte)
//   corps    1330 faces déclarées, 1326 triangulées → 4 manquantes, 141 à nu
//
// Le trou n'est donc pas un interstice entre deux parois : c'est une face que
// le mailleur n'a pas produite. AUCUNE tolérance de couture ne peut le fermer
// — il n'y a rien en face à quoi souder. L'ancienne échelle adaptative qui
// montait jusqu'à 0,1 mm ne pouvait structurellement pas réparer ce cas ; elle
// ne pouvait que coller entre elles des parois voisines ailleurs dans la pièce.
// C'est de là que venait la bavure de couleur.
function nasStepAudit(declared, result, opts) {
  const o = opts || {};
  const meshes = (result && result.meshes) || [];
  const rep = { bodies: meshes.length, empty: 0, facesDeclared: 0, facesMeshed: 0,
                bodiesWithMissingFaces: [], triangles: 0, contradictions: [] };

  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i];
    const ia = m && m.index && m.index.array;
    const n  = ia ? ia.length / 3 : 0;
    rep.triangles += n;
    if (!n) { rep.empty++; continue; }
    const bf = m.brep_faces || [];
    let meshed = 0;
    for (const f of bf) if (f && f.last >= f.first && f.last >= 0) meshed++;
    rep.facesDeclared += bf.length;
    rep.facesMeshed   += meshed;
    if (bf.length && meshed < bf.length)
      rep.bodiesWithMissingFaces.push({ index: i, name: m.name || '?', declared: bf.length, meshed, triangles: n });
  }

  // Les contradictions : ce que le fichier affirme contre ce qui est sorti.
  if (rep.empty === meshes.length && meshes.length)
    rep.contradictions.push(`EMPTY IMPORT: ${meshes.length} bodies returned, no triangle, while the file declares `
      + `${declared.solids} solid(s) and ${(declared.counts.ADVANCED_FACE || 0).toLocaleString()} face(s). `
      + `Tessellation failed without reporting it.`);
  else if (rep.empty)
    rep.contradictions.push(`${rep.empty} of ${meshes.length} bodies came back without any triangle.`);

  const missing = rep.facesDeclared - rep.facesMeshed;
  if (missing > 0)
    rep.contradictions.push(`${missing} of ${rep.facesDeclared.toLocaleString()} face(s) produced no triangle, `
      + `spread over ${rep.bodiesWithMissingFaces.length} bodies. Each missing face leaves a hole the shape of its own `
      + `outline: this is a MESHING defect, not a sewing defect — tightening or loosening the sewing will not change it.`);

  if (declared.manifoldByDeclaration && typeof o.nonManifoldCount === 'number' && o.nonManifoldCount > 0)
    rep.contradictions.push(`The file declares ${declared.solids} solid(s), all closed (100% of edges shared by `
      + `2 faces, no open shell), yet ${o.nonManifoldCount} bodies come out non-manifold. `
      + `The gap was introduced AFTER the file was read.`);

  if (typeof nasLog === 'function' && !o.quiet) {
    nasLog(rep.contradictions.length ? 'WARN' : 'OK',
      `STEP result: ${rep.bodies} bodies, ${rep.triangles.toLocaleString()} triangles, `
      + `${rep.facesMeshed.toLocaleString()}/${rep.facesDeclared.toLocaleString()} faces triangulated`);
    for (const ct of rep.contradictions) nasLog('WARN', '↯ ' + ct);
    for (const b of rep.bodiesWithMissingFaces.slice(0, 20))
      nasLog('DBG', `   ${b.name} — ${b.declared - b.meshed} of ${b.declared} face(s) not triangulated (${b.triangles} tris)`);
  }
  return rep;
}

const _sdApi = { nasStepDeclared, nasStepAudit, nasStepDeclaredAlpha, summary: _sdSummary };
if (typeof module !== 'undefined' && module.exports) module.exports = _sdApi;
if (typeof window !== 'undefined') {
  window.nasStepDeclared = nasStepDeclared;
  window.nasStepAudit    = nasStepAudit;
  window.nasStepDeclaredAlpha = nasStepDeclaredAlpha;
  window.NasStepDeclare  = _sdApi;
}
