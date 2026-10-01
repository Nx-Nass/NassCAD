// ═══════════════════════════════════════════════════════════════════════════
// nasscad-materials.js — CAD material palette for NASSCAD V4.7.0
//
// ORIGIN. Extended from the « STEP — TYPICAL MATERIALS » section of the
// FreeCAD/STEP → Three.js colour correspondence table. The `step` floats are
// the sRGB values as written in the file; the hex are stored verbatim rather
// than recomputed (see why below), and are checked by nasscadMaterialSelfCheck().
//
// PURPOSE. A STEP import very often arrives with no colour: hundreds of
// identical grey bodies whose function and material are indistinguishable.
// These entries render a part in one click with an appearance that looks like
// its material rather than tinted plastic.
//
// ─── ON THE TWO DOCUMENTED PITFALLS OF THE TABLE ────────────────────────────
//
// 1. LINEAR vs sRGB. The floats below are the ones WRITTEN IN THE .STEP FILE
//    (so sRGB), not those returned by OCCT's Quantity_Color::Red()/Green()/
//    Blue(), which are LINEAR RGB since OCCT 7.5. Applying round(x*255) to
//    linear values yields a wrong colour with no error raised. See
//    occtColorToSRGB() in nasscad_medusa.cpp.
//
// 2. ROUNDING. The table was generated with Python's round(), which rounds
//    halves TO EVEN. A JS reimplementation with Math.round() (halves up)
//    diverges as soon as a product lands exactly on .5 — one case in the
//    palette, Glass: 0.70 × 255 = 178.5 → 178 (Python) vs 179 (Math.round).
//    Hence STORING the hex rather than recomputing them: no rounding at
//    runtime, so no rounding to get wrong. nasscadMaterialSelfCheck() reports
//    any divergence instead of hiding it.
//
// ─── ON RENDERING ────────────────────────────────────────────────────────────
//
// NASSCAD renders with THREE.MeshPhongMaterial (three.js r128): no metalness/
// roughness, but shininess + specular, which is enough to separate a metal
// from a plastic. The rule applied here is physical, not decorative:
//
//   • a METAL has a specular highlight OF THE METAL'S OWN COLOUR — that is why
//     a highlight on copper is orange, not white. specular = base colour ×
//     SPEC_METAL.
//   • a DIELECTRIC (plastic, rubber, glass, composite, wood, ceramic, stone)
//     has a WHITE/NEUTRAL specular highlight whatever its base colour.
// ═══════════════════════════════════════════════════════════════════════════

// Specular highlight intensity, by family. Metal reuses its own colour (0.78:
// a real metal does not reflect at 100%); dielectrics take a neutral grey whose
// intensity alone changes.
const NASSCAD_SPEC_METAL = 0.78;

const NASSCAD_MATERIALS = [
  // id           name                       step .STEP (sRGB)       hex        family        shininess opacity
  { id:'alu',         name:'Aluminium',               step:[0.73,0.73,0.73], hex:0xBABABA, family:'metal', shininess: 60, opacity:1    },
  { id:'inox',        name:'Stainless steel',         step:[0.65,0.65,0.67], hex:0xA6A6AB, family:'metal', shininess: 90, opacity:1    },
  { id:'acier',       name:'Steel',                   step:[0.45,0.45,0.45], hex:0x737373, family:'metal', shininess: 25, opacity:1    },
  { id:'laiton',      name:'Brass',                   step:[0.83,0.68,0.21], hex:0xD4AD36, family:'metal', shininess: 85, opacity:1    },
  { id:'cuivre',      name:'Copper',                  step:[0.72,0.45,0.20], hex:0xB87333, family:'metal', shininess: 80, opacity:1    },
  { id:'or',          name:'Gold',                    step:[1.00,0.84,0.00], hex:0xFFD600, family:'metal', shininess:110, opacity:1    },
  { id:'titane',      name:'Titanium',                step:[0.60,0.60,0.65], hex:0x9999A6, family:'metal', shininess: 55, opacity:1    },
  { id:'bronze',      name:'Bronze',                  step:[0.55,0.47,0.33], hex:0x8C7854, family:'metal', shininess: 70, opacity:1    },
  { id:'chrome',      name:'Chrome',                  step:[0.85,0.87,0.90], hex:0xD9DEE6, family:'metal', shininess:120, opacity:1    },
  { id:'nickel',      name:'Nickel',                  step:[0.71,0.69,0.66], hex:0xB5B0A8, family:'metal', shininess: 85, opacity:1    },
  { id:'silver',      name:'Silver',                  step:[0.90,0.91,0.92], hex:0xE6E8EB, family:'metal', shininess:115, opacity:1    },
  { id:'zinc',        name:'Zinc',                    step:[0.78,0.80,0.82], hex:0xC7CCD1, family:'metal', shininess: 50, opacity:1    },
  { id:'castiron',    name:'Cast iron',               step:[0.28,0.28,0.31], hex:0x47474F, family:'metal', shininess: 20, opacity:1    },
  { id:'abs-noir',    name:'Black plastic',           step:[0.10,0.10,0.10], hex:0x1A1A1A, family:'plastic', shininess: 30, opacity:1    },
  { id:'abs-blanc',   name:'White plastic',           step:[0.95,0.95,0.95], hex:0xF2F2F2, family:'plastic', shininess: 35, opacity:1    },
  { id:'pla-grey',    name:'Grey plastic',            step:[0.55,0.55,0.55], hex:0x8C8C8C, family:'plastic', shininess: 32, opacity:1    },
  { id:'pl-red',      name:'Red plastic',             step:[0.80,0.15,0.13], hex:0xCC2621, family:'plastic', shininess: 34, opacity:1    },
  { id:'pl-blue',     name:'Blue plastic',            step:[0.13,0.33,0.72], hex:0x2154B8, family:'plastic', shininess: 34, opacity:1    },
  { id:'pl-green',    name:'Green plastic',           step:[0.18,0.55,0.28], hex:0x2E8C47, family:'plastic', shininess: 34, opacity:1    },
  { id:'pl-yellow',   name:'Yellow plastic',          step:[0.90,0.75,0.10], hex:0xE6BF1A, family:'plastic', shininess: 34, opacity:1    },
  { id:'pl-orange',   name:'Orange plastic',          step:[0.90,0.45,0.10], hex:0xE6731A, family:'plastic', shininess: 34, opacity:1    },
  { id:'nylon',       name:'Nylon (PA)',              step:[0.90,0.88,0.82], hex:0xE6E0D1, family:'plastic', shininess: 40, opacity:1    },
  { id:'pom',         name:'POM / Delrin',            step:[0.92,0.92,0.92], hex:0xEBEBEB, family:'plastic', shininess: 45, opacity:1    },
  { id:'pc',          name:'Polycarbonate',           step:[0.80,0.82,0.85], hex:0xCCD1D9, family:'plastic', shininess: 60, opacity:0.7 },
  { id:'pvc',         name:'PVC',                     step:[0.75,0.76,0.74], hex:0xBFC2BD, family:'plastic', shininess: 30, opacity:1    },
  { id:'pp',          name:'Polypropylene',           step:[0.86,0.86,0.84], hex:0xDBDBD6, family:'plastic', shininess: 28, opacity:1    },
  { id:'petg',        name:'PETG',                    step:[0.80,0.85,0.88], hex:0xCCD9E0, family:'plastic', shininess: 55, opacity:0.85 },
  { id:'caoutchouc',  name:'Rubber (black)',          step:[0.20,0.20,0.20], hex:0x333333, family:'rubber', shininess:  6, opacity:1    },
  { id:'silicone',    name:'Silicone',                step:[0.85,0.85,0.83], hex:0xD9D9D4, family:'rubber', shininess: 10, opacity:0.95 },
  { id:'sil-red',     name:'Silicone (red)',          step:[0.75,0.20,0.20], hex:0xBF3333, family:'rubber', shininess: 12, opacity:1    },
  { id:'tpu',         name:'TPU',                     step:[0.31,0.31,0.32], hex:0x4F4F52, family:'rubber', shininess: 14, opacity:1    },
  { id:'nbr',         name:'Nitrile (NBR)',           step:[0.12,0.14,0.16], hex:0x1F2429, family:'rubber', shininess:  8, opacity:1    },
  { id:'foam',        name:'Foam',                    step:[0.80,0.78,0.72], hex:0xCCC7B8, family:'rubber', shininess:  3, opacity:1    },
  { id:'carbone',     name:'Carbon fiber / CFRP',     step:[0.15,0.15,0.15], hex:0x262626, family:'composite', shininess: 45, opacity:1    },
  { id:'carbon-gl',   name:'Carbon fiber (gloss)',    step:[0.10,0.10,0.11], hex:0x1A1A1C, family:'composite', shininess: 90, opacity:1    },
  { id:'fiberglass',  name:'Fiberglass (GFRP)',       step:[0.85,0.85,0.80], hex:0xD9D9CC, family:'composite', shininess: 40, opacity:1    },
  { id:'kevlar',      name:'Kevlar / Aramid',         step:[0.80,0.68,0.15], hex:0xCCAD26, family:'composite', shininess: 35, opacity:1    },
  { id:'g10',         name:'G10 / FR4',               step:[0.45,0.55,0.31], hex:0x738C4F, family:'composite', shininess: 40, opacity:1    },
  { id:'verre',       name:'Glass',                   step:[0.70,0.85,0.90], hex:0xB2D9E6, family:'glass', shininess:100, opacity:0.35 },
  { id:'glass-clr',   name:'Clear glass',             step:[0.88,0.92,0.94], hex:0xE0EBF0, family:'glass', shininess:110, opacity:0.25 },
  { id:'glass-frs',   name:'Frosted glass',           step:[0.85,0.88,0.90], hex:0xD9E0E6, family:'glass', shininess: 40, opacity:0.55 },
  { id:'glass-grn',   name:'Tinted glass (green)',    step:[0.55,0.71,0.60], hex:0x8CB599, family:'glass', shininess:100, opacity:0.4 },
  { id:'glass-gry',   name:'Tinted glass (grey)',     step:[0.55,0.57,0.60], hex:0x8C9199, family:'glass', shininess:100, opacity:0.4 },
  { id:'acrylic',     name:'Acrylic (PMMA)',          step:[0.85,0.88,0.90], hex:0xD9E0E6, family:'glass', shininess: 90, opacity:0.5 },
  { id:'oak',         name:'Oak',                     step:[0.71,0.55,0.35], hex:0xB58C59, family:'wood', shininess: 12, opacity:1    },
  { id:'walnut',      name:'Walnut',                  step:[0.40,0.28,0.18], hex:0x66472E, family:'wood', shininess: 12, opacity:1    },
  { id:'pine',        name:'Pine',                    step:[0.82,0.68,0.45], hex:0xD1AD73, family:'wood', shininess: 10, opacity:1    },
  { id:'mdf',         name:'MDF',                     step:[0.72,0.60,0.44], hex:0xB89970, family:'wood', shininess:  6, opacity:1    },
  { id:'plywood',     name:'Plywood',                 step:[0.78,0.65,0.46], hex:0xC7A675, family:'wood', shininess:  8, opacity:1    },
  { id:'bamboo',      name:'Bamboo',                  step:[0.80,0.71,0.48], hex:0xCCB57A, family:'wood', shininess: 10, opacity:1    },
  { id:'cer-white',   name:'Ceramic (white)',         step:[0.93,0.93,0.90], hex:0xEDEDE6, family:'ceramic', shininess: 90, opacity:1    },
  { id:'porcelain',   name:'Porcelain',               step:[0.95,0.95,0.93], hex:0xF2F2ED, family:'ceramic', shininess:100, opacity:1    },
  { id:'cer-black',   name:'Ceramic (black)',         step:[0.12,0.12,0.13], hex:0x1F1F21, family:'ceramic', shininess: 85, opacity:1    },
  { id:'terracotta',  name:'Terracotta',              step:[0.75,0.40,0.28], hex:0xBF6647, family:'ceramic', shininess: 20, opacity:1    },
  { id:'marble',      name:'Marble',                  step:[0.90,0.90,0.87], hex:0xE6E6DE, family:'stone', shininess: 70, opacity:1    },
  { id:'granite',     name:'Granite',                 step:[0.45,0.45,0.47], hex:0x737378, family:'stone', shininess: 30, opacity:1    },
  { id:'concrete',    name:'Concrete',                step:[0.62,0.62,0.60], hex:0x9E9E99, family:'stone', shininess:  6, opacity:1    },
  { id:'slate',       name:'Slate',                   step:[0.25,0.27,0.31], hex:0x40454F, family:'stone', shininess: 10, opacity:1    },
];

// Neutral specular intensity of dielectrics (0–1 on a grey).
const NASSCAD_SPEC_DIELECTRIC = {
  plastic:0.16, rubber:0.05, composite:0.12, glass:0.33,
  wood:0.05, ceramic:0.22, stone:0.10
};

const NASSCAD_MATERIALS_BY_ID = Object.fromEntries(NASSCAD_MATERIALS.map(m => [m.id, m]));

// ── Specular colour derived from the family (see rule at top of file) ────────
function nasscadSpecularOf(m){
  if(m.family === 'metal'){
    const r = ((m.hex >> 16) & 255), g = ((m.hex >> 8) & 255), b = (m.hex & 255);
    const k = NASSCAD_SPEC_METAL;
    return ((Math.round(r*k) << 16) | (Math.round(g*k) << 8) | Math.round(b*k));
  }
  const lvl = Math.round(255 * (NASSCAD_SPEC_DIELECTRIC[m.family] ?? 0.12));
  return (lvl << 16) | (lvl << 8) | lvl;
}

function nasscadHexString(hex){ return '#' + hex.toString(16).toUpperCase().padStart(6, '0'); }

// ── Self-check: do the stored hex match the .STEP floats? ────────────────────
// Recomputes with BOTH rounding conventions and reports divergences, rather
// than leaving a silent gap between the paper table and the code. Called once
// at startup; never fails, only logs.
function nasscadMaterialSelfCheck(){
  const half = [], mismatch = [];
  for(const m of NASSCAD_MATERIALS){
    const pyRound = v => { // halves to even, like Python's round()
      const f = Math.floor(v), d = v - f;
      if(d > 0.5) return f + 1;
      if(d < 0.5) return f;
      return (f % 2 === 0) ? f : f + 1;
    };
    const toHex = fn => m.step.reduce((acc, c) => (acc << 8) | fn(c * 255), 0) >>> 0;
    const hPy = toHex(pyRound), hJs = toHex(v => Math.round(v));
    if(hPy !== m.hex) mismatch.push(`${m.name}: table ${nasscadHexString(m.hex)} vs computed ${nasscadHexString(hPy)}`);
    if(hPy !== hJs)   half.push(`${m.name} (${nasscadHexString(hPy)} / ${nasscadHexString(hJs)})`);
  }
  if(typeof nasLog === 'function'){
    if(mismatch.length) nasLog('WARN', 'Materials — hex inconsistent with STEP floats: ' + mismatch.join(' · '));
    if(half.length)     nasLog('DBG',  'Materials — value exactly on .5, Python rounding kept: ' + half.join(' · '));
    nasLog('OK', `Materials palette: ${NASSCAD_MATERIALS.length} entries${mismatch.length ? ' — ' + mismatch.length + ' MISMATCH' : ' ✓'}`);
  }
  return { mismatch, half };
}

// ── Apply to the selection ───────────────────────────────────────────────────
// Modelled on setCol(): same undo, and above all same handling of per-face
// colours — a multi-material STEP body is reduced to ONE material and its
// geometry groups are cleared, otherwise the new colour would stay invisible
// under the existing groups.
function applyNasscadMaterial(id){
  const m = NASSCAD_MATERIALS_BY_ID[id];
  if(!m) return;
  if(!selObjs.length){
    if(typeof _csgStatus === 'function') _csgStatus('⚠ Select an object first');
    return;
  }
  undoPush('material');
  const spec = nasscadSpecularOf(m);
  const hexStr = nasscadHexString(m.hex);
  selObjs.forEach(o => {
    const L = _matAll(o.mesh.material);
    if(L.length > 1){
      L.slice(1).forEach(x => x.dispose());
      o.mesh.material = L[0];
      if(o.mesh.geometry){ o.mesh.geometry.clearGroups(); delete o.mesh.geometry.userData.faceRanges; }
    }
    const mat = L[0];
    if(!mat) return;
    mat.color.setHex(m.hex);
    mat.specular.setHex(spec);
    mat.shininess = m.shininess;
    mat.opacity = m.opacity;
    mat.transparent = m.opacity < 1;
    mat.needsUpdate = true;
    o.color = hexStr;
    o.matId = m.id;   // remembered for the session (see persistence note)
  });
  _camDirty = true;
  if(typeof updProps === 'function') updProps();
  if(typeof nasLog === 'function')
    nasLog('OK', `Material "${m.name}" → ${selObjs.length} object(s) — ${hexStr}, shininess ${m.shininess}, specular ${nasscadHexString(spec)} (${m.family})`);
}

// ── Populate the Properties panel selector ───────────────────────────────────
// The list is built HERE and not in the HTML: the palette exists in a single
// place, adding a material does not require touching the HTM.
function nasscadBuildMaterialUI(){
  const sel = document.getElementById('p-mat');
  if(!sel) return;
  const fam = {
    metal:'Metals', plastic:'Plastics', rubber:'Elastomers', composite:'Composites',
    glass:'Glass', wood:'Wood', ceramic:'Ceramics', stone:'Stone'
  };
  sel.innerHTML = '<option value="">— material —</option>';
  for(const key of ['metal','plastic','rubber','composite','glass','wood','ceramic','stone']){
    const items = NASSCAD_MATERIALS.filter(m => m.family === key);
    if(!items.length) continue;
    const g = document.createElement('optgroup');
    g.label = fam[key] || key;
    for(const m of items){
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name;
      o.title = `${nasscadHexString(m.hex)} — STEP (${m.step.map(v => v.toFixed(2)).join(', ')}) — shininess ${m.shininess}`;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  nasscadMaterialSelfCheck();
}
