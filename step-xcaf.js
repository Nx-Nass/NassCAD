// ══════════════════════════════════════════════════════════════════════════
// step-xcaf.js — import STEP via XDE (STEPCAFControl_Reader) : assemblage,
// noms de pièces et couleurs réels, en s'appuyant sur le kernel OCCT DÉJÀ
// chargé pour Quick Fillet (_occt / opencascade.wasm.wasm) — aucune
// dépendance nouvelle, aucune recompilation.
//
// PROVENANCE — chaque brique ci-dessous a été validée empiriquement sur un
// fichier NIST réel (nist_ctc_01_asme1_ap242-e1.stp, CTC-01, PMI+GD&T) au
// cours d'une session de reverse-engineering du binaire WASM (17 sondes +
// désassemblage manuel des tables d'enregistrement embind) :
//
//   - Construction de document XDE (AsciiString_2 → ExtendedString_12 →
//     TDocStd_Document → Handle_TDocStd_Document_2)               [validé]
//   - STEPCAFControl_Reader_1 + ReadFile + Transfer_1              [validé]
//   - Parcours d'arbre (TDF_ChildIterator_1, IsAssembly/IsReference/
//     IsSimpleShape, GetReferredShape)                             [validé]
//   - Géométrie : XCAFDoc_ShapeTool.GetShape_2(label)               [validé]
//   - Couleur : GetColor_4/GetColor_7 + enum XCAFDoc_ColorType      [validé]
//   - Nom : FindAttribute_1(TDataStd_Name.GetID(), Handle_TDF_Attribute_1)
//     → raw.Get() → TCollection_AsciiString_13(ext, 0) → Value(i)   [validé]
//
//   - Transformation de composant (GetLocation → gp_Trsf → rotation/
//     translation) : implémentée d'après l'API OCCT documentée et la
//     présence confirmée des symboles dans le binaire (GetRotation_1,
//     TranslationPart), mais PAS testée empiriquement — le fichier NIST
//     utilisé n'avait pas de transformation non-identité significative à
//     vérifier. À valider sur un vrai assemblage multi-instances avant de
//     considérer ce point comme acquis.
//
//   - Extraction PMI/GD&T (dimensions complètes, classification datum/
//     tolérance géométrique, type de tolérance géométrique décodé) — voir
//     le commentaire détaillé de _xcafExtractPMI() pour la provenance et
//     les limites précises (notamment : valeur numérique d'une tolérance
//     géométrique non disponible dans ce build, classe non bindée).
//
//   - Affichage : la PMI extraite est poussée dans _pmiState.sem (panneau
//     PMI existant de NASSCAD, section sémantique — voir _xcafPushPMIToPanel
//     pour le détail du mapping et pourquoi les datums n'y sont pas inclus).
//
// Contrat de dépendances externes (host) :
//   scene, objs, selObjs, objCnt, THREE, undoPush, updProps, updOList,
//   updStats, nasLog, _nasAlert, showSpinner, hideSpinner, _findFreePos,
//   _breathe, computeCenterOfGravity, _weldAndCheckManifold, _capStepGaps,
//   _manifoldRepair, _edgeManifoldCheck, postProcessCSGGeo (même pipeline
//   de lissage que step-import.js : réparation Manifold WASM + angle de
//   crête 30° via le Postprocess Worker),
//   GeometryPool, updPoolStats, _lin2srgb (step-import.js, chargé avant ce
//   fichier — voir l'ordre des <script> dans le host), _occt (kernel OCCT chargé,
//   via _occtLoad() — même mécanisme que Quick Fillet, quick-fillet.js)
//   _pmiState, _pmiEnsureUI (panneau PMI existant — section sémantique)
// ══════════════════════════════════════════════════════════════════════════

// Petit helper partagé : certaines exceptions issues du WASM/embind ne sont
// pas de vrais objets Error JS (pas de .message) — notamment après un état
// perturbé côté kernel OCCT. Ce helper évite d'afficher littéralement
// "undefined" dans les logs/alertes dans ce cas.
function _xcafErrMsg(e){
  return (e && e.message) ? e.message : (e ? String(e) : 'exception sans message (probablement une exception WASM non convertie en Error JS)');
}

// ── Construction d'un document XDE frais (chemin validé) ──
function _xcafNewDocument(oc){
  const asciiFmt = new oc.TCollection_AsciiString_2('MDTV-XCAF');
  const extFmt = new oc.TCollection_ExtendedString_12(asciiFmt);
  const doc = new oc.TDocStd_Document(extFmt);
  const handleDoc = new oc.Handle_TDocStd_Document_2(doc);
  return {doc, handleDoc};
}

// ── Extraction du nom d'un label (chemin validé : Name attr -> AsciiString -> chars) ──
function _xcafGetName(oc, label, nameGuid){
  try{
    const outHandle = new oc.Handle_TDF_Attribute_1();
    const found = label.FindAttribute_1(nameGuid, outHandle);
    if(!found) return null;
    const raw = outHandle.get();
    const extNameObj = raw.Get();
    if(extNameObj.IsEmpty()) return null;
    const asciiVersion = new oc.TCollection_AsciiString_13(extNameObj, 0);
    const len = asciiVersion.Length();
    if(len === 0) return null;
    const chars = [];
    for(let i = 1; i <= len; i++){
      const v = asciiVersion.Value(i);
      chars.push(typeof v === 'number' ? String.fromCharCode(v) : String(v));
    }
    const str = chars.join('');
    return str || null;
  }catch(e){ return null; }
}

// ── Extraction de la couleur d'un label (chemin validé : priorité Surf > Gen > Curv) ──
function _xcafGetColor(oc, colorTool, label){
  const CT = oc.XCAFDoc_ColorType;
  if(!CT) return null;
  const priorities = [CT.XCAFDoc_ColorSurf, CT.XCAFDoc_ColorGen, CT.XCAFDoc_ColorCurv]
    .filter(v => v !== undefined);
  for(const ctVal of priorities){
    try{
      const col = new oc.Quantity_Color_1();
      const ok = colorTool.GetColor_4(label, ctVal, col);
      if(ok){
        // [26/08] Red()/Green()/Blue() rendent du RGB LINÉAIRE depuis OCCT 7.5
        // (le lecteur STEP convertit les COLOUR_RGB sRGB du fichier à l'import).
        // _lin2srgb (défini dans step-import.js) restitue les valeurs du fichier.
        // Vérifié sur un STEP écrit par OCCT : COLOUR_RGB('',1.,0.4,0.) → #FF6600,
        // alors que les accesseurs bruts donnaient (1, 0.132868, 0) → #FF2200.
        // Conversion faite en JS et non via Values(..., Quantity_TOC_sRGB) : le
        // binding embind de Values() prend trois réels par référence, ce que le
        // WASM n'expose pas de façon fiable — la courbe sRGB, elle, est exacte.
        const hex = '#' + [col.Red(), col.Green(), col.Blue()]
          .map(c => Math.round(_lin2srgb(Math.max(0,Math.min(1,c)))*255).toString(16).padStart(2,'0'))
          .join('');
        return hex;
      }
    }catch(e){ /* essaie la priorité suivante */ }
  }
  return null;
}

// ── Couleur PAR FACE (surcharge embind non validée — voir l'avertissement) ──
//
// PROVENANCE : contrairement a GetColor_4(label, type, color), marque [validé]
// plus haut, la surcharge prenant une TopoDS_Shape n'a PAS ete validee
// empiriquement — la numerotation embind est generee, non documentee, et ce
// fichier ne retient par principe que ce qui a ete verifie sur un fichier reel.
//
// Plutot que de deviner, on SONDE : au premier appel, on essaie les surcharges
// numerotees presentes sur le ColorTool avec une vraie face, et on retient la
// premiere qui repond sans lever. Le resultat est memorise pour la session.
// Si aucune ne repond, _xcafFaceColors renvoie { faces:null, uniformHex:null }
// et le chemin retombe EXACTEMENT sur le comportement actuel : une seule
// couleur par corps. Aucune regression possible, seulement un gain quand la
// sonde aboutit.
//
// [31/08] RESERVE, a lever avant de considerer ce chemin comme sur : une
// surcharge embind qui repond sans lever n'est pas forcement celle qui a la
// bonne SEMANTIQUE. La sonde ne verifie que l'absence d'exception et le type de
// retour, pas que la couleur rendue est celle de la face demandee. Tant que le
// numero n'a pas ete observe sur un import reel et compare a la valeur lue dans
// le Part21, ce chemin peut memoriser pour toute la session une surcharge qui
// rend des couleurs plausibles mais fausses — et le log dira "validé".
// Le chemin MEDUSA (nasscad_medusa.cpp), lui, appelle un GetColor documente.
//
// Le log 'XCAF per-face color overload' dit lequel a ete retenu — c'est cette
// ligne qui permettra de figer le numero une fois observe sur un vrai import.
let _xcafFaceColorFn = undefined; // undefined = pas encore sonde, null = aucune
function _xcafResolveFaceColorFn(oc, colorTool, sampleFace){
  if(_xcafFaceColorFn !== undefined) return _xcafFaceColorFn;
  _xcafFaceColorFn = null;
  const CT = oc.XCAFDoc_ColorType;
  if(!CT) return null;
  const ctVal = CT.XCAFDoc_ColorSurf;
  for(const name of ['GetColor_5','GetColor_7','GetColor_8','GetColor_6','GetColor_9','GetColor_4']){
    if(typeof colorTool[name] !== 'function') continue;
    try{
      const col = new oc.Quantity_Color_1();
      const r = colorTool[name](sampleFace, ctVal, col);
      if(typeof r === 'boolean'){ _xcafFaceColorFn = name; break; }
    }catch(e){ /* mauvaise surcharge : embind leve, on essaie la suivante */ }
  }
  nasLog('DBG', `XCAF per-face color overload: ${_xcafFaceColorFn || 'none found — per-body color only'}`);
  return _xcafFaceColorFn;
}

// Renvoie un tableau [r,g,b,start,count] par face — meme format que le champ
// `faces` de MEDUSA — ou null si le fichier ne pose pas au moins deux couleurs
// distinctes sur les faces de ce corps.
// [31/08] Retourne desormais un OBJET { faces, uniformHex } et non plus un
// tableau-ou-null. Motif : l'ancien contrat rendait null dans DEUX situations
// que rien ne distinguait ensuite — "aucune couleur de face" et "toutes les
// faces de la meme couleur". Dans le second cas l'appelant retombait sur la
// couleur du SOLIDE, alors que la regle OCCT dit l'inverse : dans
// XCAFPrs::CollectStyleSettings le style d'une sous-forme ecrase celui de son
// parent, et la couleur du solide ne vaut que pour les faces qui n'ont pas la
// leur. `uniformHex` porte donc la couleur commune des faces quand il y en a
// une, et l'appelant s'en sert pour REMPLACER la couleur du corps.
//
// Ce que ca corrige, mesure sur Scania-Engine-V8-XT-Turbo.step : 79 corps y
// sont monochromes au niveau des faces avec une couleur DIFFERENTE de celle de
// leur solide. 41 d'entre eux ont un solide jaune #DDDD0D et des faces grises
// ou orange — ils s'affichaient en jaune vif.
function _xcafFaceColors(oc, colorTool, faceShapes, fallbackHex){
  const NONE = { faces: null, uniformHex: null };
  if(!faceShapes || !faceShapes.length) return NONE;
  const fn = _xcafResolveFaceColorFn(oc, colorTool, faceShapes[0].face);
  if(!fn) return NONE;
  const CT = oc.XCAFDoc_ColorType;
  const types = [CT.XCAFDoc_ColorSurf, CT.XCAFDoc_ColorGen, CT.XCAFDoc_ColorCurv].filter(v => v !== undefined);
  const fb = [parseInt(fallbackHex.slice(1,3),16)/255, parseInt(fallbackHex.slice(3,5),16)/255, parseInt(fallbackHex.slice(5,7),16)/255];
  const out = []; const seen = new Set();
  let nStyled = 0;                 // faces portant reellement un style propre
  for(const fs of faceShapes){
    let rgb = null;
    for(const t of types){
      try{
        const col = new oc.Quantity_Color_1();
        if(colorTool[fn](fs.face, t, col)){
          // Meme conversion lineaire -> sRGB que _xcafGetColor : OCCT >= 7.5
          // stocke du lineaire, cf. le commentaire de cette fonction.
          rgb = [_lin2srgb(col.Red()), _lin2srgb(col.Green()), _lin2srgb(col.Blue())];
          break;
        }
      }catch(e){ /* face sans style : couleur du corps */ }
    }
    // [31/08] `seen` ne compte plus que les couleurs REELLEMENT posees sur une
    // face. Avant, la couleur de repli y entrait aussi : un corps dont une
    // seule face etait stylee passait pour "multicolore" (2 entrees dans seen)
    // alors qu'une seule face portait une vraie information.
    if(rgb){ nStyled++; seen.add((Math.round(rgb[0]*255)<<16)|(Math.round(rgb[1]*255)<<8)|Math.round(rgb[2]*255)); }
    else rgb = fb;
    out.push([rgb[0], rgb[1], rgb[2], fs.start, fs.count]);
  }
  if(!nStyled) return NONE;        // aucune couleur de face : le solide gouverne
  if(seen.size === 1 && nStyled === faceShapes.length){
    // Toutes les faces s'accordent sur une seule couleur : elle ecrase celle du
    // solide (regle OCCT). Un seul materiau suffit, aucun groupe a produire.
    const k = [...seen][0];
    return { faces: null, uniformHex: '#' + k.toString(16).padStart(6, '0') };
  }
  // Melange : couleurs distinctes, ou faces stylees et non stylees cote a cote.
  return { faces: out.length > 1 ? out : null, uniformHex: null };
}

// ── Transformation d'un composant référencé (API documentée, pas testée empiriquement) ──
function _xcafGetLocationTransform(oc, label){
  try{
    const loc = oc.XCAFDoc_ShapeTool.GetLocation(label);
    if(!loc || loc.IsIdentity()) return null;
    const trsf = loc.Transformation();
    const rot = trsf.GetRotation_1 ? trsf.GetRotation_1() : null;
    const tr = trsf.TranslationPart ? trsf.TranslationPart() : null;
    if(!tr) return null;
    return {
      position: {x: tr.X(), y: tr.Y(), z: tr.Z()},
      quaternion: rot ? {x: rot.X(), y: rot.Y(), z: rot.Z(), w: rot.W()} : null,
    };
  }catch(e){ return null; }
}

// ── Tessellation TopoDS_Shape -> THREE.BufferGeometry (même pipeline que Quick Fillet) ──
// [27/08] outFaceShapes (optionnel) : recoit, dans l'ordre du TopExp_Explorer,
// { face, start, count } pour chaque face triangulee — start/count en INDEX.
// C'est la meme information que le tableau `faces` produit par MEDUSA, donc le
// meme format de sortie pour les deux importeurs. Sans ce parametre, la
// fonction se comporte exactement comme avant.
function _xcafMeshShape(oc, shape, deflection, outFaceShapes){
  new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, 0.5, false);
  // Construction INDEXÉE dès la tessellation (et non un triangle-soup à plat) :
  // les sommets partagés entre faces adjacentes (mêmes coordonnées exactes,
  // OCCT triangule à partir de la même topologie B-Rep sous-jacente) sont
  // dédupliqués via une table de hachage plutôt que dupliqués triangle par
  // triangle. Sans ça, le nombre de sommets bruts explose (chaque arête
  // partagée compte une fois par face adjacente), et les étapes suivantes
  // du pipeline (soudure Manifold, lissage par angle de crête) doivent
  // traiter un volume de données bien plus gros que nécessaire — c'est ce
  // qui causait un ralentissement de plusieurs minutes sur une pièce
  // pourtant modeste (constaté empiriquement : ~170s au lieu de <1s).
  const posMap = new Map();   // "x,y,z" arrondi -> index dans positions[]
  const positions = [];       // sommets UNIQUES, à plat (x,y,z,x,y,z,...)
  const indices = [];         // triangles, par index de sommet unique

  function vKey(x,y,z){ return x.toFixed(5)+','+y.toFixed(5)+','+z.toFixed(5); }
  function addVertex(x,y,z){
    const key = vKey(x,y,z);
    let idx = posMap.get(key);
    if(idx === undefined){
      idx = positions.length / 3;
      positions.push(x,y,z);
      posMap.set(key, idx);
    }
    return idx;
  }

  const fex = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while(fex.More()){
    const face = oc.TopoDS.Face_1(fex.Current());
    const loc = new oc.TopLoc_Location_1();
    const triH = oc.BRep_Tool.Triangulation(face, loc);
    if(!triH.IsNull()){
      const _fStart = indices.length;
      const tri = triH.get(), trsf = loc.Transformation();
      const rev = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      const nv = tri.NbNodes(), nt = tri.NbTriangles();
      const localIdx = new Array(nv + 1); // 1-indexé comme OCCT, translate vers l'index global dédupliqué
      for(let i=1; i<=nv; i++){
        const p = tri.Node(i).Transformed(trsf);
        localIdx[i] = addVertex(p.X(), p.Y(), p.Z());
      }
      for(let i=1; i<=nt; i++){
        const t = tri.Triangle(i);
        let a=t.Value(1), b=t.Value(2), c=t.Value(3);
        if(rev){ const w=b; b=c; c=w; }
        indices.push(localIdx[a], localIdx[b], localIdx[c]);
      }
      if(outFaceShapes && indices.length > _fStart){
        outFaceShapes.push({ face, start: _fStart, count: indices.length - _fStart });
      }
    }
    fex.Next();
  }
  if(!indices.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

// ── Extraction PMI/GD&T — consolidation de 14 sondes de reverse-engineering ──
//
// PROVENANCE ET LIMITES (à lire avant de faire confiance aux données) :
//
//   - Dimensions (diamètre, distance, angle) + tolérances +/- : COMPLET et
//     VALIDÉ empiriquement — valeur, type, bornes de tolérance, tout extrait
//     via l'attribut XCAFDoc_Dimension → .GetObject() → objet riche.
//
//   - Classification datum / dimension / tolérance géométrique : COMPLET,
//     via DimTolTool.IsDatum/IsDimension/IsGeomTolerance.
//
//   - Type de tolérance géométrique (Flatness, Perpendicularity, etc.) :
//     décodé via une table de correspondance CONSTRUITE À LA MAIN (pas une
//     fonction OCCT) — le convertisseur officiel STEPCAFControl_GDTProperty
//     .GeomToleranceType existe comme nom de méthode statique mais n'est PAS
//     appelable dans ce build WASM ("is not a function"). La table ci-dessous
//     est la position (0-indexée) de chaque valeur dans l'énumération
//     XCAFDimTolObjects_GeomToleranceType telle qu'exposée par ce même build
//     — confirmée empiriquement : Flatness→7, Perpendicularity→9, correspond
//     exactement aux entiers bruts trouvés sur les labels testés.
//
//   - VALEUR NUMÉRIQUE d'une tolérance géométrique (ex: la largeur de zone
//     0.05mm d'une Flatness) : MUR CONFIRMÉ. La classe XCAFDoc_GeomTolerance
//     existe bien dans le binaire WASM (confirmé par recherche de strings)
//     mais n'a jamais été enregistrée via embind pour un accès JS — ce n'est
//     pas un nom à deviner, la classe est absente du binding, point final.
//     Balayage exhaustif effectué (79 classes candidates testées sur le
//     label lui-même ET sur ses 16 enfants) : aucun match autre que
//     TDataStd_Name (vide) et TDataStd_Integer (le type, déjà exploité).
//     → Pour cette donnée précise, s'appuyer sur le scanner PMI Part 21
//       existant de NASSCAD (parsing direct du texte STEP), qui la couvre
//       déjà. D'où le champ `value: null` ci-dessous, explicite plutôt que
//       silencieux.
//
//   - Lettre d'identification d'un datum (A, B, C...) : PAS extraite ici —
//     le nom générique récupéré est "DGT:Datum" (non informatif). Piste non
//     creusée faute de temps, pas confirmée impossible.
function _xcafExtractPMI(oc, doc){
  const GEOM_TOL_TYPES = [
    'None','Angularity','CircularRunout','CircularityOrRoundness','Coaxiality',
    'Concentricity','Cylindricity','Flatness','Parallelism','Perpendicularity',
    'Position','ProfileOfLine','ProfileOfSurface','Straightness','Symmetry','TotalRunout'
  ];

  function safe(fn){ try{ return fn(); }catch(e){ return undefined; } }

  const mainLabel = doc.Main();
  let dimTolTool, dgtsLabel;
  try{
    dimTolTool = oc.XCAFDoc_DocumentTool.DimTolTool(mainLabel).get();
    dgtsLabel = oc.XCAFDoc_DocumentTool.DGTsLabel(mainLabel);
  }catch(e){ return {entries:[], error: _xcafErrMsg(e)}; }

  const nameGuid = oc.TDataStd_Name.GetID();
  const dimensionGuid = oc.XCAFDoc_Dimension.GetID();
  const integerGuid = oc.TDataStd_Integer.GetID();

  function getName(lbl){
    try{
      const outHandle = new oc.Handle_TDF_Attribute_1();
      if(!lbl.FindAttribute_1(nameGuid, outHandle)) return null;
      const raw = outHandle.get();
      const ext = raw.Get();
      if(ext.IsEmpty()) return null;
      const ascii = new oc.TCollection_AsciiString_13(ext, 0);
      const len = ascii.Length();
      if(len === 0) return null;
      let s = '';
      for(let i=1;i<=len;i++){ const v = ascii.Value(i); s += typeof v==='number'?String.fromCharCode(v):String(v); }
      return s || null;
    }catch(e){ return null; }
  }

  const it = new oc.TDF_ChildIterator_1();
  it.Initialize(dgtsLabel, false);
  const entries = [];
  let idx = 0;
  const loopT0 = performance.now();

  while(it.More()){
    idx++;
    const entryT0 = performance.now();
    const lbl = it.Value();
    const name = getName(lbl);
    const tAfterName = performance.now();

    const isDatumResult = safe(() => dimTolTool.IsDatum(lbl));
    const tAfterIsDatum = performance.now();

    let kind = 'unknown';
    let tAfterIsDim = tAfterIsDatum, tAfterIsGeomTol = tAfterIsDatum, tAfterPayload = tAfterIsDatum;

    if(isDatumResult){
      kind = 'datum';
      entries.push({kind, name});
      tAfterPayload = performance.now();

    }else{
      const isDimResult = safe(() => dimTolTool.IsDimension(lbl));
      tAfterIsDim = performance.now();

      if(isDimResult){
        kind = 'dimension';
        const entry = {kind, name};
        try{
          const outHandle = new oc.Handle_TDF_Attribute_1();
          if(lbl.FindAttribute_1(dimensionGuid, outHandle)){
            const raw = outHandle.get();
            const objH = raw.GetObject();
            const obj = objH.get ? objH.get() : objH;
            entry.value = safe(() => obj.GetValue());
            entry.hasPlusMinusTol = safe(() => obj.IsDimWithPlusMinusTolerance());
            if(entry.hasPlusMinusTol){
              entry.upperTol = safe(() => obj.GetUpperTolValue());
              entry.lowerTol = safe(() => obj.GetLowerTolValue());
            }
            entry.nbDecimalPlaces = safe(() => obj.GetNbOfDecimalPlaces());
          }
        }catch(e){ entry.error = _xcafErrMsg(e); }
        entries.push(entry);
        tAfterPayload = performance.now();

      }else{
        const isGeomTolResult = safe(() => dimTolTool.IsGeomTolerance(lbl));
        tAfterIsGeomTol = performance.now();

        if(isGeomTolResult){
          kind = 'geomTolerance';
          // Le code de type (TDataStd_Integer) ne vit PAS sur ce label lui-
          // même mais sur l'un de ses enfants directs (validé empiriquement :
          // Flatness.1 → enfant[0], Perpendicularity.1 → enfant[0], sur le
          // fichier NIST CTC-01). On scanne tous les enfants directs plutôt
          // que de supposer l'index 0 pour rester robuste aux variations.
          let typeCode = null;
          try{
            const childIt = new oc.TDF_ChildIterator_1();
            childIt.Initialize(lbl, false);
            while(childIt.More() && typeCode === null){
              const child = childIt.Value();
              const outHandle = new oc.Handle_TDF_Attribute_1();
              if(child.FindAttribute_1(integerGuid, outHandle)){
                typeCode = outHandle.get().Get();
              }
              childIt.Next();
            }
          }catch(e){}
          entries.push({
            kind, name,
            type: (typeCode !== null && GEOM_TOL_TYPES[typeCode]) || null,
            typeCode,
            value: null, // non disponible dans ce build WASM — cf. commentaire de tête de fonction
          });
          tAfterPayload = performance.now();

        }else{
          entries.push({kind:'unknown', name});
          tAfterPayload = performance.now();
        }
      }
    }

    const entryTotal = tAfterPayload - entryT0;
    if(entryTotal > 50){
      // N'affiche en détail que les entrées anormalement lentes (>50ms) —
      // sinon 29 lignes de log à chaque import pour rien la plupart du temps.
      nasLog('DBG', `STEP-XCAF PMI: entrée[${idx}] (${kind}) LENTE — total=${entryTotal.toFixed(0)}ms `+
        `(name=${(tAfterName-entryT0).toFixed(0)}ms IsDatum=${(tAfterIsDatum-tAfterName).toFixed(0)}ms `+
        `IsDimension=${(tAfterIsDim-tAfterIsDatum).toFixed(0)}ms IsGeomTolerance=${(tAfterIsGeomTol-tAfterIsDim).toFixed(0)}ms `+
        `payload=${(tAfterPayload-tAfterIsGeomTol).toFixed(0)}ms)`);
    }

    it.Next();
  }

  nasLog('DBG', `STEP-XCAF PMI: loop over ${idx} entry(ies) done in ${(performance.now()-loopT0).toFixed(0)}ms`);
  return {entries};
}


// Retourne un tableau plat de {label, name, worldTransform} pour chaque
// forme simple atteinte, en accumulant les transformations le long du chemin.
//
// ⚠ DÉDUPLICATION : sur au moins un fichier réel testé (NIST CTC-01), les
// composants d'un assemblage-wrapper référencent les MÊMES labels que des
// racines déjà listées indépendamment sous ShapesLabel (occt-import-js/XDE
// enregistre parfois la même forme à la fois comme racine libre ET comme
// composant d'assemblage — pas une anomalie du fichier, un artefact de la
// façon dont OCCT structure certains modèles AP242 multi-représentation).
// `knownRootLabels` permet de sauter une référence qui pointe vers une
// racine déjà traitée séparément, pour ne pas importer la pièce deux fois.
function _xcafWalkTree(oc, label, nameGuid, depth, maxDepth, accTransform, out, knownRootLabels){
  if(depth > maxDepth){
    nasLog('WARN', `STEP-XCAF: assembly depth > ${maxDepth} — stopping descent (possible cycle?)`);
    return;
  }
  if(oc.XCAFDoc_ShapeTool.IsSimpleShape(label)){
    out.push({label, name: _xcafGetName(oc, label, nameGuid), transform: accTransform});
    return;
  }
  if(oc.XCAFDoc_ShapeTool.IsReference(label)){
    const refOut = new oc.TDF_Label();
    const ok = oc.XCAFDoc_ShapeTool.GetReferredShape(label, refOut);
    if(ok){
      if(knownRootLabels && knownRootLabels.some(r => r.IsEqual(refOut))){
        // Référence vers une racine déjà (ou bientôt) traitée indépendamment — on
        // saute pour éviter le doublon, cette racine sera walkée à son propre tour.
        return;
      }
      const localT = _xcafGetLocationTransform(oc, label);
      const combined = localT || accTransform; // best-effort : pas de composition matricielle complète ici
      _xcafWalkTree(oc, refOut, nameGuid, depth+1, maxDepth, combined, out, knownRootLabels);
    }
    return;
  }
  // Assemblage ou compound : descendre dans les enfants
  const it = new oc.TDF_ChildIterator_1();
  it.Initialize(label, false);
  while(it.More()){
    _xcafWalkTree(oc, it.Value(), nameGuid, depth+1, maxDepth, accTransform, out, knownRootLabels);
    it.Next();
  }
}

// ── Pont vers le panneau PMI existant (_pmiState.sem + _pmiEnsureUI) ──
//
// Le panneau PMI de NASSCAD a deux sections : .items (annotations graphiques
// 3D, liées à des courbes tessellées — hors de portée pour XDE, qui ne
// fournit que la donnée sémantique, pas la présentation graphique) et .sem
// (PMI sémantique pure : label/valeur/unité, zéro dépendance 3D — c'est
// exactement ce que _xcafExtractPMI produit). On ne pousse que dans .sem.
//
// On ne vide QUE .sem avant de pousser (pas .items ni .subs), pour ne pas
// effacer d'éventuelles annotations graphiques déjà affichées par un import
// STEP classique fait plus tôt dans la même session — les deux mondes
// coexistent, chacun dans sa section du même panneau.
function _xcafPushPMIToPanel(pmi){
  _pmiState.sem.length = 0;
  for(const e of pmi.entries){
    if(e.kind === 'dimension'){
      let label = e.name || 'dimension';
      if(e.hasPlusMinusTol){
        const up = e.upperTol, lo = e.lowerTol;
        label += ` (+${up}/-${lo})`;
      }
      _pmiState.sem.push({
        kind: 'dim',
        label,
        value: (e.value !== undefined) ? e.value : null,
        unit: 'mm',
        dia: /diameter|diamètre/i.test(e.name || ''),
        datums: [],
      });
    }else if(e.kind === 'geomTolerance'){
      _pmiState.sem.push({
        kind: 'tol',
        label: (e.type || 'tolérance géométrique') + (e.name ? ` (${e.name})` : ''),
        value: null, // non disponible via XDE dans ce build — cf. _xcafExtractPMI
        unit: '',
        datums: [],
      });
    }
    // Les entrées 'datum' ne sont volontairement PAS poussées ici : sans la
    // lettre d'identification réelle (A/B/C — jamais extraite, cf. limites
    // documentées dans _xcafExtractPMI), un datum générique "DGT:Datum" par
    // entrée n'apporterait rien d'utile dans ce panneau. Le compte total
    // reste visible via le résumé nasLog au moment de l'import.
  }
  if(typeof _pmiEnsureUI === 'function') _pmiEnsureUI();
}

// ── Point d'entrée principal ──
async function importSTEP_XCAF(file){
  // [FIX 20/08 — audit chir cardiaque] Plafond jamais câblé après la
  // simplification du routage automatique (cf. commentaire au-dessus de
  // _importSTEPUnified, plus bas dans ce fichier) : _STEP_XCAF_AUTO_MAX_BYTES
  // existe depuis le début (10 Mo, cf. sa propre déclaration/commentaire plus
  // bas) mais n'était plus vérifiée NULLE PART une fois le routage par taille
  // retiré de _importSTEPUnified. Cette fonction reste exposée sur window
  // pour un usage manuel/debug (cf. window.importSTEP_XCAF ci-dessous) — sans
  // cette garde, l'appeler à la main sur un gros fichier lance ReadFile puis
  // Transfer_1 en synchrone PUR sur le thread principal, aucun yield possible
  // entre les deux (cf. double rAF plus bas — protège seulement le PAINT du
  // spinner, pas le calcul lui-même) : gel de l'onglet GARANTI, pas juste
  // probable, sur un fichier assez gros. Le chemin automatique (importMesh →
  // _importSTEPUnified → importSTEP) n'est PAS concerné : protégé par
  // ailleurs, Worker dédié + watchdog scalable, cf. step-import.js.
  if(file.size > _STEP_XCAF_AUTO_MAX_BYTES){
    const mb = (file.size/1024/1024).toFixed(1), capMb = (_STEP_XCAF_AUTO_MAX_BYTES/1024/1024).toFixed(0);
    const msg = `file too large for the manual XDE path (${mb} MB > ${capMb} MB cap — synchronous, no Worker, no watchdog). Use the regular STEP import instead (Import → STEP) — it already handles any file size safely.`;
    nasLog('ERROR', `STEP-XCAF import: ${msg}`);
    _nasAlert(`⚠ Import STEP-XCAF: ${msg}`);
    return [];
  }
  if(!_occt){
    nasLog('WARN', 'STEP-XCAF : OCCT kernel not loaded — a fillet or a STEP-XCAF import triggers its loading (≈65 Mo, une fois par session)');
  }
  showSpinner('Import STEP (XCAF)', file.name, 'indeterminate');
  // [FIX 01/08] Double rAF : garantit que ce message est PEINT avant le bloc
  // synchrone plus bas (FS.writeFile → ReadFile → Transfer_1, aucun yield
  // possible entre les deux — même limite documentée que occt.ReadStepFile
  // côté pipeline classique). Sans ça, si le gel dure, l'utilisateur reste
  // visuellement bloqué sur l'ancien message générique "… — reading…" de
  // l'étage d'import commun, sans savoir que XDE a bien démarré.
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const t0 = performance.now();
  try{
    const oc = await _occtLoad();
    const {doc, handleDoc} = _xcafNewDocument(oc);

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const fsPath = '/test.stp'; // chemin simple, identique à celui des 17 sondes validées
    oc.FS.writeFile(fsPath, bytes);

    const reader = new oc.STEPCAFControl_Reader_1();
    reader.SetColorMode(true);
    reader.SetNameMode(true);
    reader.SetLayerMode(true);
    reader.SetGDTMode(true);
    const readStatus = reader.ReadFile(fsPath);
    const statusVal = (readStatus && typeof readStatus.value === 'number') ? readStatus.value : readStatus;
    nasLog('DBG', `STEP-XCAF: ReadFile status = ${JSON.stringify(statusVal)} (1=Done attendu)`);
    const nbRoots = reader.NbRootsForTransfer();
    nasLog('DBG', `STEP-XCAF: NbRootsForTransfer = ${nbRoots}`);
    if(nbRoots === 0) throw new Error(`STEP-XCAF: no root to transfer (ReadFile status=${JSON.stringify(statusVal)} — empty file, non reconnu, ou lecture échouée)`);
    const transferOk = reader.Transfer_1(handleDoc);
    if(!transferOk) throw new Error('STEP-XCAF: XDE transfer failed (Transfer_1 returned false)');

    try{ oc.FS.unlink(fsPath); }catch(e){ /* nettoyage best-effort */ }

    const mainLabel = doc.Main();
    const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(mainLabel).get();
    const colorTool = oc.XCAFDoc_DocumentTool.ColorTool(mainLabel).get();
    const shapesLabel = oc.XCAFDoc_DocumentTool.ShapesLabel(mainLabel);
    const nameGuid = oc.TDataStd_Name.GetID();

    const it = new oc.TDF_ChildIterator_1();
    it.Initialize(shapesLabel, false);
    const roots = [];
    while(it.More()){ roots.push(it.Value()); it.Next(); }

    const leaves = [];
    for(const rootLabel of roots){
      _xcafWalkTree(oc, rootLabel, nameGuid, 0, 32, null, leaves, roots);
    }

    if(!leaves.length) throw new Error('STEP-XCAF: no shape found after walking the tree'); // [FIX AUDIT 18/08] message garbled (mix FR/EN + apostrophe perdue)

    undoPush('import');
    const imported = [];
    let idx = 0;
    for(const leaf of leaves){
      idx++;
      if(idx % 5 === 0){
        showSpinner('Import STEP (XCAF)', `${file.name} — part ${idx}/${leaves.length}`, idx/leaves.length);
        await _breathe();
      }
      let shape;
      try{ shape = oc.XCAFDoc_ShapeTool.GetShape_2(leaf.label); }
      catch(e){ nasLog('WARN', `STEP-XCAF: part ${idx} has no usable geometry (${_xcafErrMsg(e)})`); continue; }
      if(!shape) continue;

      const _faceShapes = [];
      let geo = _xcafMeshShape(oc, shape, 0.1, _faceShapes);
      if(!geo){ nasLog('WARN', `STEP-XCAF: part ${idx} — empty triangulation`); continue; }

      let isManifold = _weldAndCheckManifold(geo, 3);
      if(!isManifold && geo._nakedEdgePairs && geo._nakedEdgePairs.length && _capStepGaps(geo)){
        isManifold = true;
      }
      // Même pipeline que step-import.js : réparation Manifold WASM puis lissage
      // par angle de crête (30°) via le Postprocess Worker — préserve les arêtes
      // vives (chanfreins, coins) tout en lissant les surfaces courbes. Un simple
      // computeVertexNormals() sur un maillage non indexé donnerait un rendu
      // facetté/en blocs (chaque triangle garde sa propre normale).
      // [27/08] Couleurs par face resolues AVANT toute reparation : l'union
      // Manifold reconstruit le maillage et detruirait les plages d'index. Le
      // soudage, le gap-fill et le lissage, eux, preservent l'ordre des
      // triangles — meme raisonnement et meme arbitrage que dans step-import.js.
      let _colorBody = _xcafGetColor(oc, colorTool, leaf.label) || '#8a8a8a';
      const _fc = _xcafFaceColors(oc, colorTool, _faceShapes, _colorBody);
      // [31/08] Regle OCCT : le style des faces ecrase celui du solide. Quand
      // toutes les faces s'accordent sur une couleur, c'est ELLE la couleur du
      // corps — pas celle que le fichier a posee sur le MANIFOLD_SOLID_BREP.
      if(_fc.uniformHex && _fc.uniformHex !== _colorBody){
        nasLog('DBG', `XCAF face color overrides solid color — part ${idx} : `
          + `${_colorBody} -> ${_fc.uniformHex}`);
        _colorBody = _fc.uniformHex;
      }
      const _mFaces = _fc.faces;

      if(!_mFaces){
        geo = await _manifoldRepair(geo);
        if(geo.index){
          const _rc = _edgeManifoldCheck(geo.index.array, geo.attributes.position.array);
          if(_rc.manifold !== isManifold) isManifold = _rc.manifold;
        }
      }
      geo = await postProcessCSGGeo(geo, 30);
      const cg = computeCenterOfGravity(geo);
      geo.translate(-cg.x, -cg.y, -cg.z);

      const color = _colorBody;
      // [26/08] _softenColor() retiré : c'est l'helper de rendu des RÉSULTATS CSG
      // (s *= 0.45, l *= 1.12 plafonné à 0.74). Appliqué à une couleur lue dans un
      // fichier STEP, il détruisait 55 % de la saturation et faisait diverger cet
      // importeur de celui de MEDUSA (step-import.js) sur le même fichier. Il reste
      // en place là où il a un sens, sur les résultats CSG (voir doCSG).
      const _col = color;
      // [27/08] Meme helper que step-import.js — une seule implementation des
      // couleurs par face pour les deux importeurs, par construction.
      const _faceMats = _applyFaceColors(geo, _mFaces);
      if(_faceMats){
        nasLog('DBG', `XCAF per-face colors — part ${idx} : ${_mFaces.length} face(s), `
          + `${new Set(_faceMats.map(m=>m.color.getHex())).size} color(s), ${geo.groups.length} draw group(s)`);
      }
      const mat = _faceMats || new THREE.MeshPhongMaterial({color:_col, shininess:8, specular:0x1a1a1a, side:THREE.DoubleSide});
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cg.x, cg.y, cg.z);
      mesh.castShadow = true;

      if(leaf.transform && leaf.transform.position){
        mesh.position.x += leaf.transform.position.x;
        mesh.position.y += leaf.transform.position.z;   // Z-up -> Y-up, cohérent avec le reste du pipeline STEP
        mesh.position.z += -leaf.transform.position.y;
        if(leaf.transform.quaternion){
          const q = leaf.transform.quaternion;
          mesh.quaternion.set(q.x, q.z, -q.y, q.w);       // même conversion d'axe appliquée au repère
        }
      }

      const fp = _findFreePos(mesh, Math.max(geo.boundingBox?.max.x||10, 10)+2);
      mesh.position.x += fp.x; mesh.position.z += fp.z;
      scene.add(mesh);
      objCnt++;
      const name = leaf.name || ('STEP_Part_' + objCnt);
      const ro = {id:objCnt, name, type:'csg', mesh, isHole:false, color:_col, isOcctResult:true, isManifold};
      if(GeometryPool.initialized){ ro._poolSlot = GeometryPool.geoStore(geo); }
      objs.push(ro);
      imported.push(ro);
    }

    if(GeometryPool.initialized) updPoolStats();
    selObjs = imported;
    updProps(); updOList(); updStats();

    // ── Extraction PMI (best-effort — un échec ici ne doit jamais faire
    // échouer l'import géométrique, déjà réussi à ce stade) ──
    let pmi = {entries:[]};
    try{
      pmi = _xcafExtractPMI(oc, doc);
      const nbDim = pmi.entries.filter(e=>e.kind==='dimension').length;
      const nbDatum = pmi.entries.filter(e=>e.kind==='datum').length;
      const nbGeomTol = pmi.entries.filter(e=>e.kind==='geomTolerance').length;
      if(pmi.entries.length){
        nasLog('OK', `STEP-XCAF PMI: ${nbDim} dimension(s), ${nbDatum} datum(s), ${nbGeomTol} tolérance(s) géométrique(s) (type seul, valeur via scanner PMI existant)`);
        _xcafPushPMIToPanel(pmi);
      }
    }catch(e){ nasLog('WARN', 'STEP-XCAF PMI: extraction échouée — '+_xcafErrMsg(e)); }

    hideSpinner();
    const dt = ((performance.now()-t0)/1000).toFixed(1);
    nasLog('OK', `STEP-XCAF: ${imported.length} part(s) imported — ${dt}s — ${file.name}`);
    imported.pmi = pmi; // attaché sur le tableau (non-cassant : .length/.forEach/etc. inchangés)
    return imported;
  }catch(err){
    hideSpinner();
    nasLog('ERROR', `STEP-XCAF import: ${_xcafErrMsg(err)}`);
    _nasAlert(`⚠ Import STEP-XCAF: ${_xcafErrMsg(err)}`);
    return [];
  }
}

// Attaché explicitement à window : nécessaire pour survivre à un Run NassScript
// isolé (chaque Run s'exécute dans sa propre IIFE jetable — cf. runScript() dans
// nassscript.js, `new Function('return (async()=>{...})()')`). Redondant mais
// inoffensif lors d'une intégration normale via <script src="step-xcaf.js">.
window.importSTEP_XCAF = importSTEP_XCAF;

// ── Plafond de routage automatique vers XDE ─────────────────────────────
// [FIX 01/08 — régression identifiée sur Stealthburner_CW2_Assembly.step,
// 25,5 Mo, 142 NEXT_ASSEMBLY_USAGE_OCCURRENCE] `reader.ReadFile()` et
// `reader.Transfer_1()` (ci-dessus, importSTEP_XCAF) tournent en synchrone
// PUR sur le thread principal — aucun Worker, contrairement au pipeline
// classique (_readStepFileUncached, step-import.js : Worker dédié +
// watchdog scalable qui tue/relance proprement). Un `Promise.race` avec
// setTimeout ne protège RIEN ici : tant que ReadFile n'a pas rendu la main,
// aucun timer ne peut se déclencher (JS single-thread) — un vrai watchdog
// exigerait un Worker, pas encore fait pour XDE (kernel opencascade.wasm.wasm
// chargé aujourd'hui uniquement côté thread principal, cf. Quick Fillet).
// En attendant : plafond conservateur, XDE tenté seulement sous cette
// taille (validé empiriquement seulement sur le NIST CTC-01, petit fichier
// PMI). Au-dessus, on part directement sur le pipeline classique — Worker +
// watchdog déjà éprouvés, sans perte de fonctionnalité géométrique (juste
// pas de noms/couleurs/PMI XDE automatiques pour ces fichiers-là).
const _STEP_XCAF_AUTO_MAX_BYTES = 10 * 1024 * 1024; // 10 Mo — à relever une fois XDE déchargé dans un Worker

// ══════════════════════════════════════════════════════════════════════════
// _importSTEPUnified — point d'entrée UNIQUE pour tout import STEP.
//
// [AUDIT 20/08] Le paragraphe qui suit décrit le routage automatique PAR
// TAILLE tel qu'il existait AVANT la simplification documentée par le
// commentaire [NEW] à l'intérieur de la fonction juste en dessous — conservé
// tel quel pour l'historique (explique pourquoi l'auto-routing XDE a été
// tenté puis abandonné : perte de fonctionnalité Turbo/découpage sur les gros
// assemblages), mais NE DÉCRIT PLUS le comportement actuel. Concrètement :
// _importSTEPUnified ignore désormais totalement _STEP_XCAF_AUTO_MAX_BYTES et
// part toujours sur le pipeline classique (importSTEP). La constante elle-
// même reste utilisée ailleurs (garde de taille dans importSTEP_XCAF,
// cf. plus haut dans ce fichier) — pas du code mort, juste plus l'usage
// décrit ci-dessous.
//
// Historique — routage automatique entre les deux pipelines plutôt que de
// laisser l'utilisateur choisir manuellement (source de confusion constatée :
// le pipeline XDE n'a aucun support de découpage/Turbo, essayé une fois sur
// le Voron 235 Mo/1438 corps sans succès, alors que le pipeline classique
// gère ce fichier — juste plus lentement, 18-19 min).
//
// Critère de routage (HISTORIQUE, plus actif) : _STEP_XCAF_AUTO_MAX_BYTES
// (10 Mo, cf. commentaire ci-dessus — PAS _STEP_SLICE_THRESHOLD, qui gouverne
// le Turbo du pipeline classique et n'a aucun rapport avec la sûreté du
// thread principal côté XDE) — sous ce seuil, XDE était tenté en premier
// (données plus riches : couleurs/noms/dimensions/PMI réels par pièce), avec
// repli AUTOMATIQUE (juste un WARN en log) vers le pipeline classique si XDE
// ÉCHOUAIT — return false/exception, PAS s'il restait bloqué en cours de
// route (aucun filet possible dans ce cas, cf. plus haut). Au-dessus du
// seuil, on partait directement sur le pipeline classique (XDE non protégé à
// cette échelle).
async function _importSTEPUnified(file){
  // [NEW] Routage unifié simplifié : TOUS les fichiers partent sur le pipeline
  // classique (MEDUSA natif si détecté, sinon Worker WASM). Le détour XDE
  // automatique pour les ≤10 Mo est retiré : depuis que MEDUSA extrait les
  // couleurs PAR SOLIDE via l'arbre XCAF natif (validé 198/198 sur le
  // Stealthburner, là où le XDE navigateur et occt-import-js en rataient),
  // le XDE main-thread n'apporte plus de données supplémentaires — il ne
  // reste que ses inconvénients : synchrone, sans Worker, sans watchdog,
  // gel d'UI possible sans aucun filet. importSTEP_XCAF reste exposé sur
  // window pour un usage manuel/debug si besoin.
  return importSTEP(file);
}
// [FIX AUDIT 18/08] Nom corrigé : window.importSTEP_Unified (sans underscore initial,
// underscore parasite avant Unified) ne correspond à AUCUN appelant — le seul site
// d'appel réel (NASSCAD_V4_7_0_DEV.htm, importMesh) utilise _importSTEPUnified(f), le
// nom exact de la fonction ci-dessus. En contexte page normale, la déclaration
// "async function _importSTEPUnified" suffit déjà (hissée sur window automatiquement) ;
// c'est justement dans le cas qui motive cette ligne — un Run NassScript isolé (IIFE
// sans accès au window réel pour ses déclarations top-level) — que l'ancien nom, erroné,
// ne réparait rien : le filet de sécurité était silencieusement inopérant.
window._importSTEPUnified = _importSTEPUnified; // même raison que window.importSTEP_XCAF ci-dessus