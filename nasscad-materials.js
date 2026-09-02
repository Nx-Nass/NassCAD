// ═══════════════════════════════════════════════════════════════════════════
// nasscad-materials.js — Palette de matériaux CAO pour NASSCAD V4.7.0
//
// ORIGINE. Section « STEP — MATÉRIAUX TYPIQUES » de la table de correspondance
// couleurs FreeCAD/STEP → Three.js. Les floats `step` sont EXACTEMENT ceux de
// la table ; les hex sont stockés en dur plutôt que recalculés (voir plus bas
// pourquoi), et vérifiables par nasscadMaterialSelfCheck().
//
// À QUOI ÇA SERT. Un import STEP arrive très souvent sans couleur : 1 295 corps
// gris identiques, dont on ne distingue plus ni la fonction ni la matière. Ces
// entrées rendent une pièce en un clic, avec un rendu qui ressemble à sa
// matière plutôt qu'à du plastique teinté.
//
// ─── SUR LES DEUX PIÈGES DOCUMENTÉS DE LA TABLE ────────────────────────────
//
// 1. LINÉAIRE vs sRGB. Les floats ci-dessous sont ceux ÉCRITS DANS LE FICHIER
//    .STEP (donc sRGB), pas ceux rendus par Quantity_Color::Red()/Green()/
//    Blue() d'OCCT, qui sont en RGB LINÉAIRE depuis OCCT 7.5. Appliquer
//    round(x*255) à du linéaire donne une couleur fausse sans lever d'erreur —
//    mesuré côté MEDUSA : COLOUR_RGB('',1.,0.4,0.) vaut #FF6600, mais .Red()
//    rend (1, 0.132868, 0) soit #FF2200. Voir occtColorToSRGB() dans
//    nasscad_medusa.cpp : c'est le seul point de sortie autorisé d'une couleur
//    OCCT, et il passe par Values(..., Quantity_TOC_sRGB).
//
// 2. ARRONDI. La table a été générée avec round() de Python, qui arrondit les
//    demis VERS LE PAIR. Une réimplémentation en JS avec Math.round() (demi
//    vers le haut) diverge dès qu'un produit tombe pile sur .5 — un seul cas
//    dans la palette, le Verre : 0.70 × 255 = 178,5 → 178 (Python) contre 179
//    (Math.round). D'où le choix de STOCKER les hex plutôt que de les
//    recalculer : aucun arrondi à l'exécution, donc aucun arrondi à se tromper.
//    nasscadMaterialSelfCheck() signale l'écart au lieu de le taire.
//
// ─── SUR LE RENDU ──────────────────────────────────────────────────────────
//
// NASSCAD rend en THREE.MeshPhongMaterial (three.js r128) : pas de metalness/
// roughness, mais shininess + specular, ce qui suffit largement à séparer un
// métal d'un plastique. La règle appliquée ici est physique, pas décorative :
//
//   • un MÉTAL a un reflet spéculaire DE LA COULEUR DU MÉTAL — c'est ce qui
//     fait qu'un reflet sur du cuivre est orangé et pas blanc. specular =
//     couleur de base × SPEC_METAL.
//   • un DIÉLECTRIQUE (plastique, caoutchouc, verre, composite) a un reflet
//     spéculaire BLANC/NEUTRE quelle que soit sa couleur de base.
//
// C'est exactement la distinction que le défaut de NASSCAD (shininess 8,
// specular 0x1a1a1a, gris neutre pour tout le monde) ne fait pas.
// ═══════════════════════════════════════════════════════════════════════════

// Intensité du reflet spéculaire, par famille. Le métal reprend sa propre
// couleur (0.78 : un métal réel ne réfléchit pas à 100 %) ; les diélectriques
// prennent un gris neutre dont seule l'intensité change.
const NASSCAD_SPEC_METAL = 0.78;

const NASSCAD_MATERIALS = [
  // id            libellé              floats .STEP (sRGB)      hex        famille       shininess  opacité
  { id:'alu',        name:'Aluminium brut',  step:[0.73,0.73,0.73], hex:0xBABABA, family:'metal',      shininess:60,  opacity:1    },
  { id:'inox',       name:'Acier inox',      step:[0.65,0.65,0.67], hex:0xA6A6AB, family:'metal',      shininess:90,  opacity:1    },
  { id:'acier',      name:'Acier brut',      step:[0.45,0.45,0.45], hex:0x737373, family:'metal',      shininess:25,  opacity:1    },
  { id:'laiton',     name:'Laiton',          step:[0.83,0.68,0.21], hex:0xD4AD36, family:'metal',      shininess:85,  opacity:1    },
  { id:'cuivre',     name:'Cuivre',          step:[0.72,0.45,0.20], hex:0xB87333, family:'metal',      shininess:80,  opacity:1    },
  { id:'or',         name:'Or',              step:[1.00,0.84,0.00], hex:0xFFD600, family:'metal',      shininess:110, opacity:1    },
  { id:'titane',     name:'Titane',          step:[0.60,0.60,0.65], hex:0x9999A6, family:'metal',      shininess:55,  opacity:1    },
  { id:'abs-noir',   name:'Plastique noir',  step:[0.10,0.10,0.10], hex:0x1A1A1A, family:'plastic',    shininess:30,  opacity:1    },
  { id:'abs-blanc',  name:'Plastique blanc', step:[0.95,0.95,0.95], hex:0xF2F2F2, family:'plastic',    shininess:35,  opacity:1    },
  { id:'caoutchouc', name:'Caoutchouc',      step:[0.20,0.20,0.20], hex:0x333333, family:'rubber',     shininess:6,   opacity:1    },
  { id:'carbone',    name:'Carbone / CFRP',  step:[0.15,0.15,0.15], hex:0x262626, family:'composite',  shininess:45,  opacity:1    },
  { id:'verre',      name:'Verre',           step:[0.70,0.85,0.90], hex:0xB2D9E6, family:'glass',      shininess:100, opacity:0.35 },
];

// Intensité du spéculaire neutre des diélectriques (0–1 sur un gris).
const NASSCAD_SPEC_DIELECTRIC = { plastic:0.16, rubber:0.05, composite:0.12, glass:0.33 };

const NASSCAD_MATERIALS_BY_ID = Object.fromEntries(NASSCAD_MATERIALS.map(m => [m.id, m]));

// ── Couleur spéculaire dérivée de la famille (cf. règle en tête de fichier) ──
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

// ── Auto-contrôle : les hex stockés correspondent-ils aux floats .STEP ? ─────
// Recalcule avec les DEUX conventions d'arrondi et rapporte les divergences,
// plutôt que de laisser un écart silencieux entre la table papier et le code.
// Appelé une fois au démarrage ; n'échoue jamais, se contente de logger.
function nasscadMaterialSelfCheck(){
  const half = [], mismatch = [];
  for(const m of NASSCAD_MATERIALS){
    const pyRound = v => { // demi vers le pair, comme round() de Python
      const f = Math.floor(v), d = v - f;
      if(d > 0.5) return f + 1;
      if(d < 0.5) return f;
      return (f % 2 === 0) ? f : f + 1;
    };
    const toHex = fn => m.step.reduce((acc, c) => (acc << 8) | fn(c * 255), 0) >>> 0;
    const hPy = toHex(pyRound), hJs = toHex(v => Math.round(v));
    if(hPy !== m.hex) mismatch.push(`${m.name}: table ${nasscadHexString(m.hex)} vs calcul ${nasscadHexString(hPy)}`);
    if(hPy !== hJs)   half.push(`${m.name} (${nasscadHexString(hPy)} / ${nasscadHexString(hJs)})`);
  }
  if(typeof nasLog === 'function'){
    if(mismatch.length) nasLog('WARN', 'Matériaux — hex incohérent avec les floats STEP : ' + mismatch.join(' · '));
    if(half.length)     nasLog('DBG',  'Matériaux — valeur pile sur .5, arrondi Python retenu : ' + half.join(' · '));
    nasLog('OK', `Palette matériaux : ${NASSCAD_MATERIALS.length} entrées${mismatch.length ? ' — ' + mismatch.length + ' ÉCART' : ' ✓'}`);
  }
  return { mismatch, half };
}

// ── Application à la sélection ──────────────────────────────────────────────
// Calqué sur setCol() : même undo, et surtout même traitement des couleurs par
// face — un corps STEP multi-matériaux est ramené à UN seul matériau et ses
// groupes de géométrie sont effacés, sinon la nouvelle couleur resterait
// invisible sous les groupes existants.
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
    o.matId = m.id;   // mémorisé pour la session (voir la note de persistance)
  });
  _camDirty = true;
  if(typeof updProps === 'function') updProps();
  if(typeof nasLog === 'function')
    nasLog('OK', `Matériau « ${m.name} » → ${selObjs.length} objet(s) — ${hexStr}, shininess ${m.shininess}, spéculaire ${nasscadHexString(spec)} (${m.family})`);
}

// ── Remplissage du sélecteur du panneau Properties ─────────────────────────
// La liste est construite ICI et pas dans le HTML : la palette n'existe qu'à
// un seul endroit, ajouter une matière ne demande pas de toucher au HTM.
function nasscadBuildMaterialUI(){
  const sel = document.getElementById('p-mat');
  if(!sel) return;
  const fam = { metal:'Métaux', plastic:'Plastiques', rubber:'Élastomères', composite:'Composites', glass:'Verres' };
  sel.innerHTML = '<option value="">— matériau —</option>';
  for(const key of ['metal','plastic','rubber','composite','glass']){
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
