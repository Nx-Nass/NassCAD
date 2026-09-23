// ═════════════════════════════════════════════════════════════════════════════
// EXPORT IFC4 TESSELE — ISO 16739
//
// L'import IFC utilise web-ifc dans le navigateur. L'export part de triangles
// que la scene a DEJA : les faire faire un aller-retour
// jusqu'au moteur ne rendrait pas un triangle de mieux, et rendrait l'export
// impossible moteur eteint. Il vit donc dans le navigateur, comme l'export STEP.
//
// IFC N'EST PAS UN AUTRE FORMAT DE FICHIER. C'est le MEME conteneur Part-21
// qu'un STEP (ISO 10303-21) avec un autre schema dedans. Tout ce que
// step-export.js sait deja faire — echappement \X2\, doublage des quotes, repli
// a 72 colonnes, ecriture des reels — s'applique tel quel, et c'est reutilise
// ici sans une ligne de copie.
//
// CE QUI EST ECRIT, et pourquoi cette forme :
//   IfcTriangulatedFaceSet, le maillage indexe natif d'IFC4. Un IfcFacetedBrep
//   ecrirait CHAQUE sommet de CHAQUE triangle comme une entite IfcCartesianPoint
//   propre : sur un corps de 100 000 triangles, 300 000 entites au lieu d'une
//   liste. Le meme modele passe de dizaines de Mo a quelques Mo.
//
//   La structure spatiale minimale que la norme impose — IfcProject, IfcSite,
//   IfcBuilding, IfcBuildingStorey, relies par des IfcRelAggregates, et les
//   corps accroches a l'etage par un IfcRelContainedInSpatialStructure. Un
//   fichier sans elle s'ouvre dans un visualiseur permissif et se fait refuser
//   partout ailleurs.
//
//   Les couleurs PAR FACE. Un corps a plusieurs materiaux sort en plusieurs
//   IfcTriangulatedFaceSet dans la MEME representation, chacun avec son
//   IfcStyledItem. C'est ce qui ferme la boucle : ce qui sort colorie par face
//   revient colorie par face a la relecture.
//
// LE PIEGE DES INDICES : CoordIndex d'IFC4 est indexe A PARTIR DE 1, pas de 0.
// Un decalage d'un cran ne plante rien — il decale toute la topologie d'un
// sommet, et le corps sort en confettis.
//
// ATTRIBUTS DERIVES : Part 21 reserve un emplacement note '*' pour chaque
// attribut DERIVE de la norme — IfcSIUnit.Dimensions,
// IfcGeometricRepresentationSubContext.CoordinateSpaceDimension et les trois
// suivants. Ils sont ecrits ici. Ne pas les confondre avec un parametre de
// trop : un validateur qui compte les parametres d'un constructeur et oublie
// les derives signale des erreurs qui n'existent pas.
// ═════════════════════════════════════════════════════════════════════════════

// Identifiant IFC : 22 caracteres, pas un UUID en clair. La norme empaquette les
// 128 bits en base 64 avec son propre alphabet — un octet donne les deux
// premiers caracteres, puis cinq groupes de trois octets donnent quatre
// caracteres chacun : 2 + 5x4 = 22.
const _IFC64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
function _ifcGuid(){
  const b = new Uint8Array(16);
  if(globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
  else for(let i=0;i<16;i++) b[i] = (Math.random()*256)|0;
  b[6] = (b[6] & 0x0f) | 0x40;                       // UUID version 4
  b[8] = (b[8] & 0x3f) | 0x80;                       // variante RFC 4122
  const chunk = (v, n) => { let s=''; for(let i=0;i<n;i++){ s = _IFC64[v % 64] + s; v = Math.floor(v/64); } return s; };
  let out = chunk(b[0], 2);
  for(let k=1;k<16;k+=3) out += chunk(b[k]*65536 + b[k+1]*256 + b[k+2], 4);
  return out;
}

globalThis._ifcExportConfig = globalThis._ifcExportConfig || {
  decimals:   6,      // decimales des coordonnees ecrites
  weldDigits: 6,      // decimales de la cle de soudure des sommets
  parametric: true,   // primitives en geometrie EXACTE (cf. plus bas)
  logStats:   true
};

// ═════════════════════════════════════════════════════════════════════════════
// GEOMETRIE PARAMETRIQUE — ce que FreeCAD fait avant de tesseller
//
// Son exportIFC.py essaie dans cet ordre : getExtrusionData() ->
// IfcExtrudedAreaSolid ; puis SERIALIZE -> brep ; et SEULEMENT en repli
// fcsolid.tessellate(). La raison n'est pas la taille du fichier, c'est que
// l'IFC sert a passer un modele a un autre logiciel de BIM : une boite ecrite
// en 12 triangles arrive comme 12 triangles, une boite ecrite en
// IfcExtrudedAreaSolid sur un IfcRectangleProfileDef arrive comme une boite,
// avec ses cotes, EDITABLE. C'est toute la difference entre exporter en IFC et
// exporter en STL.
//
// NASSCAD sait de quoi chaque corps est fait — so.type le dit. L'export STEP
// s'en sert deja pour les spheres (SPHERICAL_SURFACE analytique au lieu de
// 32 000 triangles) ; on applique ici le meme raisonnement a tout ce qui peut
// s'exprimer exactement.
//
// LES ORIGINES NE SONT PAS LES MEMES D'UNE PRIMITIVE A L'AUTRE, et ISO 16739
// est formel — verifie, pas suppose :
//   IfcRectangleProfileDef    centre du rectangle a l'origine
//   IfcSphere                 « the center of the sphere »
//   IfcRightCircularCone      « the center of the circular area being the
//                               bottom face », sommet a +Z
// Un profil extrude part de SON plan et monte vers +Z : le repere se pose donc
// a la BASE du corps, pas en son centre.
//
// GARDE-FOU : tout corps dont la mise a l'echelle rendrait la primitive fausse
// — un cylindre aplati en ellipse, une sphere en ellipsoide, un miroir —
// repart par le chemin tesselle. Mieux vaut des triangles justes qu'un cylindre
// qui n'en est pas un.
//
// TOUTES les entites ecrites ici ont ete verifiees contre la table du schema
// IFC4 telle que web-ifc 0.0.77 la porte : nombre de parametres exact pour
// IfcRectangleProfileDef, IfcRectangleHollowProfileDef, IfcCircleProfileDef,
// IfcCircleHollowProfileDef, IfcExtrudedAreaSolid, IfcSphere et
// IfcRightCircularCone. C'est le meme lecteur qui relit les fichiers a
// l'import : verifie par aller-retour, ce qui sort d'ici revient dans NASSCAD.
function _ifcParam(so){
  const cfg = globalThis._ifcExportConfig || {};
  if(cfg.parametric === false) return null;
  const t = so && so.type;
  if(!t || !so.mesh || !so.mesh.geometry) return null;
  if(['cube','cylinder','tube','hollowbox','sphere','cone'].indexOf(t) < 0) return null;

  const g = so.mesh.geometry;
  if(!g.boundingBox) g.computeBoundingBox();
  const bb = g.boundingBox;
  if(!bb) return null;
  so.mesh.updateMatrixWorld(true);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  so.mesh.matrixWorld.decompose(p, q, s);
  // Miroir : le determinant est negatif, la primitive sortirait retournee.
  if(s.x * s.y * s.z < 0) return null;
  const sx = Math.abs(s.x), sy = Math.abs(s.y), sz = Math.abs(s.z);
  const W = (bb.max.x - bb.min.x) * sx;   // etendue locale X, a l'echelle
  const H = (bb.max.y - bb.min.y) * sy;   // hauteur locale Y = axe d'extrusion
  const D = (bb.max.z - bb.min.z) * sz;
  if(!(W > 1e-6 && H > 1e-6 && D > 1e-6)) return null;
  if(![W,H,D].every(Number.isFinite)) return null;

  // centre de la boite englobante, en coordonnees monde
  const c = new THREE.Vector3((bb.max.x+bb.min.x)/2, (bb.max.y+bb.min.y)/2, (bb.max.z+bb.min.z)/2);
  const ctr = c.clone().applyMatrix4(so.mesh.matrixWorld);
  const up    = new THREE.Vector3(0,1,0).applyQuaternion(q).normalize();  // axe local Y
  const right = new THREE.Vector3(1,0,0).applyQuaternion(q).normalize();  // axe local X
  const base  = ctr.clone().addScaledVector(up, -H/2);
  if(![ctr.x,ctr.y,ctr.z,up.x,up.y,up.z,right.x,right.y,right.z].every(Number.isFinite)) return null;

  const round = Math.abs(W - D) / Math.max(W, D) < 1e-3;   // section circulaire ?
  const out = { W:W, H:H, D:D, ctr:ctr, base:base, up:up, right:right };

  if(t === 'cube')      { out.kind = 'rect';   return out; }
  if(t === 'hollowbox') {
    const ow = so.hboxOw, iw = so.hboxIw;
    if(!(ow > 0) || !(iw > 0) || iw >= ow) return null;
    // IfcRectangleHollowProfileDef n'a QU'UNE epaisseur de paroi. Une paroi
    // uniforme dans le repere local ne le reste apres mise a l'echelle que si
    // X et Z sont mis a la meme echelle — sinon la paroi vaut t*sx d'un cote et
    // t*sz de l'autre, et aucun IfcRectangleHollowProfileDef ne dit cela.
    // Mesure : sans ce garde-fou, +6,67 % de volume sur une boite creuse mise
    // a l'echelle (1, 1.7, 0.6).
    if(Math.abs(sx - sz) / Math.max(sx, sz) > 1e-3) return null;
    out.kind = 'rectHollow';
    out.wall = (W * (1 - iw/ow)) / 2;      // epaisseur de paroi, a l'echelle
    return out;
  }
  if(t === 'cylinder')  { if(!round) return null; out.kind = 'circ'; out.r = W/2; return out; }
  if(t === 'tube')      {
    if(!round) return null;
    const ro = so.tubeRo, ri = so.tubeRi;
    if(!(ro > 0) || !(ri > 0) || ri >= ro) return null;
    out.kind = 'circHollow'; out.r = W/2; out.wall = (W/2) * (1 - ri/ro);
    return out;
  }
  if(t === 'sphere')    {
    // une sphere mise a l'echelle non uniformement est un ellipsoide
    const m = Math.max(W,H,D);
    if(Math.abs(W-H)/m > 1e-3 || Math.abs(H-D)/m > 1e-3) return null;
    out.kind = 'sphere'; out.r = W/2; return out;
  }
  if(t === 'cone')      { if(!round) return null; out.kind = 'cone'; out.r = W/2; return out; }
  return null;
}

// ── Export ────────────────────────────────────────────────────────────────
// Meme forme que _expSTEPRun : Promise + double rAF pour que le spinner soit
// peint avant le travail synchrone, et _nasStepSave pour ecrire ou l'utilisateur
// a choisi. opts.fileHandle vient du clic (fenetre user-gesture), opts.returnText
// rend le texte sans telecharger.
async function _expIFCRun(objList, opts){
  opts = opts || {};
  const t0 = performance.now();
  const cfg = globalThis._ifcExportConfig || {};
  const precision = v => Number.isFinite(Number(v)) ? Math.max(1, Math.min(12, Math.round(Number(v)))) : 6;
  const DEC = precision(cfg.decimals == null ? 6 : cfg.decimals);
  const WD  = Math.min(DEC, precision(cfg.weldDigits == null ? 6 : cfg.weldDigits));
  const source = objList || objs;

  if(typeof _stepReal !== 'function' || typeof _stepStr !== 'function' ||
     typeof _stepFold !== 'function' || typeof _stepBake !== 'function')
    throw new Error('IFC export needs step-export.js (Part 21 writer) — not loaded');
  if(!opts.silent) showSpinner('Export IFC4','Tessellation…');

  // Await the paint before entering the try/finally, so every asynchronous
  // failure rejects the returned Promise and releases the spinner.
  try {
    const paint = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : cb => setTimeout(cb, 0);
    await new Promise(resolve => paint(resolve));
    await new Promise(resolve => paint(resolve));
    scene.updateMatrixWorld(true);
    const cv = (x,y,z)=>[x,-z,y];          // Three.js Y-up -> IFC Z-up
    const f  = v => _stepReal(v, DEC);
    // Cle de soudure : le zero negatif est ramene a '0.' — sinon deux sommets
    // distants de 2e-9 de part et d'autre de zero portent des cles differentes
    // et le maillage ne se referme pas.
    const q  = v => { const s=(+v).toFixed(WD); return (s.charCodeAt(0)===45 && +s===0) ? s.slice(1) : s; };
    _stepStr.truncated = 0;

    let id = 0; const L = [];
    const E = () => { id++; return id; };
    const W = (s) => { L.push('#'+id+' = '+s+';'); };
    const R = a => '('+a.map(i=>'#'+i).join(',')+')';
    const G = () => "'"+_ifcGuid()+"'";

    // ── En-tete du modele : proprietaire, unites, contexte ────────────────
    const now = new Date().toISOString().slice(0,19);
    const iPer = E(); W("IFCPERSON($,$,'NassLab',$,$,$,$,$)");
    const iOrg = E(); W("IFCORGANIZATION($,'NassLab',$,$,$)");
    const iPAO = E(); W("IFCPERSONANDORGANIZATION(#"+iPer+",#"+iOrg+",$)");
    const iApp = E(); W("IFCAPPLICATION(#"+iOrg+",'"+_stepStr(String(globalThis.NASSCAD_VERSION||'4.7.0'))+"','NASSCAD','NASSCAD')");
    const iOwn = E(); W("IFCOWNERHISTORY(#"+iPAO+",#"+iApp+",$,.ADDED.,$,$,$,"+Math.floor(Date.now()/1000)+")");

    // La scene est en millimetres, comme l'export STEP. On le DECLARE : un
    // fichier sans IfcUnitAssignment est lu en metres par defaut, soit un
    // facteur 1000 sur tout le modele.
    const iUL = E(); W("IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)");
    const iUA = E(); W("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)");
    const iUR = E(); W("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)");
    const iUV = E(); W("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)");
    const iUS = E(); W("IFCUNITASSIGNMENT("+R([iUL,iUA,iUR,iUV])+")");

    const iP0 = E(); W("IFCCARTESIANPOINT((0.,0.,0.))");
    const iDZ = E(); W("IFCDIRECTION((0.,0.,1.))");
    const iDX = E(); W("IFCDIRECTION((1.,0.,0.))");
    const iAX = E(); W("IFCAXIS2PLACEMENT3D(#"+iP0+",#"+iDZ+",#"+iDX+")");
    const iCTX= E(); W("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#"+iAX+",$)");
    // Le sous-contexte 'Body' : c'est lui que cherche tout lecteur pour savoir
    // quelle representation est la geometrie solide (par opposition a 'Axis',
    // 'FootPrint', 'Annotation').
    const iSUB= E(); W("IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#"+iCTX+",$,.MODEL_VIEW.,$)");

    // ── Structure spatiale ────────────────────────────────────────────────
    const iPlc = E(); W("IFCLOCALPLACEMENT($,#"+iAX+")");
    const iPrj = E(); W("IFCPROJECT("+G()+",#"+iOwn+",'NASSCAD Model',$,$,$,$,(#"+iCTX+"),#"+iUS+")");
    const iSite= E(); W("IFCSITE("+G()+",#"+iOwn+",'Site',$,$,#"+iPlc+",$,$,.ELEMENT.,$,$,$,$,$)");
    const iPlcB= E(); W("IFCLOCALPLACEMENT(#"+iPlc+",#"+iAX+")");
    const iBld = E(); W("IFCBUILDING("+G()+",#"+iOwn+",'Building',$,$,#"+iPlcB+",$,$,.ELEMENT.,$,$,$)");
    const iPlcS= E(); W("IFCLOCALPLACEMENT(#"+iPlcB+",#"+iAX+")");
    const iSto = E(); W("IFCBUILDINGSTOREY("+G()+",#"+iOwn+",'Storey',$,$,#"+iPlcS+",$,$,.ELEMENT.,0.)");
    E(); W("IFCRELAGGREGATES("+G()+",#"+iOwn+",$,$,#"+iPrj +",(#"+iSite+"))");
    E(); W("IFCRELAGGREGATES("+G()+",#"+iOwn+",$,$,#"+iSite+",(#"+iBld +"))");
    E(); W("IFCRELAGGREGATES("+G()+",#"+iOwn+",$,$,#"+iBld +",(#"+iSto +"))");

    // ── Styles, mis en cache par (teinte, alpha) ──────────────────────────
    // Chaine IFC4 : IfcColourRgb -> IfcSurfaceStyleRendering -> IfcSurfaceStyle,
    // pose sur l'item par un IfcStyledItem. IfcPresentationStyleAssignment est
    // deprecie depuis IFC4 : l'IfcSurfaceStyle va directement dans Styles.
    // La transparence d'IFC est l'INVERSE de l'opacite : 1 - alpha.
    const styleCache = new Map();
    const _style = (hex, a) => {
      const key = hex+'|'+a;
      if(styleCache.has(key)) return styleCache.get(key);
      const r = parseInt(hex.slice(0,2),16)/255;
      const g = parseInt(hex.slice(2,4),16)/255;
      const b = parseInt(hex.slice(4,6),16)/255;
      const iCol = E(); W("IFCCOLOURRGB($,"+_stepReal(r,6)+","+_stepReal(g,6)+","+_stepReal(b,6)+")");
      const tr = (a < 1) ? _stepReal(1-a,6) : '$';
      const iRen = E(); W("IFCSURFACESTYLERENDERING(#"+iCol+","+tr+",$,$,$,$,$,$,.NOTDEFINED.)");
      const iSty = E(); W("IFCSURFACESTYLE('"+_stepStr(hex)+"',.BOTH.,(#"+iRen+"))");
      styleCache.set(key, iSty);
      return iSty;
    };

    // ── Un corps ──────────────────────────────────────────────────────────
    // Soude les sommets sur la cle quantifiee, groupe les triangles par
    // materiau, et rend un IfcTriangulatedFaceSet par groupe.
    let nBody=0, nTris=0, nFaceSets=0, nStyled=0, nClosed=0, nOpen=0, nUnknown=0, nEmpty=0, nKeptRaw=0, nParam=0;
    // Au-dela de ce nombre de triangles, l'attribut Closed n'est pas calcule :
    // la table de parite des aretes couterait plus que tout le reste de
    // l'export. On ecrit alors '$' — « non renseigne » — et JAMAIS une valeur
    // supposee : un .T. faux ferait croire a un solide a tout lecteur en aval.
    const CLOSED_LIMIT = 300000;

    const elemIds = [];

    // Queue commune : ranger un ou plusieurs items dans une representation, en
    // faire un produit pose a l'etage. Partagee par le chemin parametrique et
    // le chemin tesselle — un seul endroit ou la structure produit est ecrite.
    const _emitProduct = (so, oi, items, repType) => {
      const nm = so.name || ('Body '+(oi+1));
      const iRep = E(); W("IFCSHAPEREPRESENTATION(#"+iSUB+",'Body','"+repType+"',"+R(items)+")");
      const iPDS = E(); W("IFCPRODUCTDEFINITIONSHAPE($,$,(#"+iRep+"))");
      // La geometrie est cuite en coordonnees monde : le placement de chaque
      // corps est l'identite, mais il doit EXISTER — un lecteur qui deplace une
      // piece a besoin d'un placement qui lui appartient.
      const iPlcE= E(); W("IFCLOCALPLACEMENT(#"+iPlcS+",#"+iAX+")");
      const iEl  = E(); W("IFCBUILDINGELEMENTPROXY("+G()+",#"+iOwn+",'"+_stepStr(nm)+"',$,$,#"+iPlcE+",#"+iPDS+",$,.NOTDEFINED.)");
      elemIds.push(iEl);
      nBody++;
    };

    source.forEach((so, oi) => {
      let geo;
      try {
      if(!so || !so.mesh){ nEmpty++; return; }

      // ── geometrie EXACTE quand le corps en est une ───────────────────────
      const par = _ifcParam(so);
      if(par){
        const st = { hex: _stepHexOf(so),
                     a: _stepAlpha(Array.isArray(so.mesh.material)?so.mesh.material[0]:so.mesh.material, so) };
        const AZ = cv(par.up.x,    par.up.y,    par.up.z);
        const AX = cv(par.right.x, par.right.y, par.right.z);
        const place = (P) => {
          const P3 = cv(P.x, P.y, P.z);
          const ip = E(); W("IFCCARTESIANPOINT(("+f(P3[0])+","+f(P3[1])+","+f(P3[2])+"))");
          const iz = E(); W("IFCDIRECTION(("+f(AZ[0])+","+f(AZ[1])+","+f(AZ[2])+"))");
          const ix = E(); W("IFCDIRECTION(("+f(AX[0])+","+f(AX[1])+","+f(AX[2])+"))");
          const ia = E(); W("IFCAXIS2PLACEMENT3D(#"+ip+",#"+iz+",#"+ix+")");
          return ia;
        };
        const extrude = (iProf) => {
          const iPl = place(par.base);
          const iS = E(); W("IFCEXTRUDEDAREASOLID(#"+iProf+",#"+iPl+",#"+iDZ+","+f(par.H)+")");
          return iS;
        };
        let item = 0, repType = 'SweptSolid';
        if(par.kind === 'rect'){
          const ip = E(); W("IFCRECTANGLEPROFILEDEF(.AREA.,$,$,"+f(par.W)+","+f(par.D)+")");
          item = extrude(ip);
        } else if(par.kind === 'rectHollow'){
          const ip = E(); W("IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,$,"+f(par.W)+","+f(par.D)+","+f(par.wall)+",$,$)");
          item = extrude(ip);
        } else if(par.kind === 'circ'){
          const ip = E(); W("IFCCIRCLEPROFILEDEF(.AREA.,$,$,"+f(par.r)+")");
          item = extrude(ip);
        } else if(par.kind === 'circHollow'){
          const ip = E(); W("IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,$,"+f(par.r)+","+f(par.wall)+")");
          item = extrude(ip);
        } else if(par.kind === 'cone'){
          // LE CONE PASSE PAR UNE REVOLUTION, PAS PAR IfcRightCircularCone.
          // Mesure sur web-ifc 0.0.77 : des quatre primitives CSG d'IFC4, il
          // ne rend que IfcSphere et IfcRightCircularCylinder ; IfcBlock et
          // IfcRightCircularCone ne rendent aucune geometrie, avec ou sans
          // enveloppe IfcCsgSolid. Un cone est exactement la revolution d'un
          // triangle rectangle autour de son cote vertical : geometrie EXACTE
          // dans le fichier, et 'SweptSolid' est le type de representation le
          // mieux supporte de toute la norme. Relu a +0,40 % — la seule
          // tessellation du lecteur.
          //
          // Le profil vit dans le plan XY de sa Position, et l'axe de
          // revolution doit etre DANS ce plan. On oriente donc Position pour
          // que son Y local porte l'axe du cone et son X local une direction
          // radiale : Z local = X ^ Y, soit AX ^ AZ.
          const cx = AX[1]*AZ[2]-AX[2]*AZ[1],
                cy = AX[2]*AZ[0]-AX[0]*AZ[2],
                cz = AX[0]*AZ[1]-AX[1]*AZ[0];
          const B3 = cv(par.base.x, par.base.y, par.base.z);
          const ip = E(); W("IFCCARTESIANPOINT(("+f(B3[0])+","+f(B3[1])+","+f(B3[2])+"))");
          const iz = E(); W("IFCDIRECTION(("+f(cx)+","+f(cy)+","+f(cz)+"))");
          const ix = E(); W("IFCDIRECTION(("+f(AX[0])+","+f(AX[1])+","+f(AX[2])+"))");
          const ipos = E(); W("IFCAXIS2PLACEMENT3D(#"+ip+",#"+iz+",#"+ix+")");
          const q1 = E(); W("IFCCARTESIANPOINT((0.,0.))");
          const q2 = E(); W("IFCCARTESIANPOINT(("+f(par.r)+",0.))");
          const q3 = E(); W("IFCCARTESIANPOINT((0.,"+f(par.H)+"))");
          const ipl = E(); W("IFCPOLYLINE((#"+q1+",#"+q2+",#"+q3+",#"+q1+"))");
          const ipr = E(); W("IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#"+ipl+")");
          const iao = E(); W("IFCCARTESIANPOINT((0.,0.,0.))");
          const iad = E(); W("IFCDIRECTION((0.,1.,0.))");   // Y local = axe du cone
          const iax = E(); W("IFCAXIS1PLACEMENT(#"+iao+",#"+iad+")");
          // Angle en RADIANS : l'en-tete declare IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)
          item = E(); W("IFCREVOLVEDAREASOLID(#"+ipr+",#"+ipos+",#"+iax+",6.283185307179586)");
          repType = 'SweptSolid';
        } else if(par.kind === 'sphere'){
          // SPHERE NUE, SANS ENVELOPPE IfcCsgSolid — et ce n'est pas un
          // raccourci. Mesure sur web-ifc 0.0.77, le lecteur que NASSCAD
          // embarque pour l'import : IfcCsgSolid(IfcSphere) ne rend AUCUNE
          // geometrie, tandis que la meme IfcSphere posee directement en item
          // est lue (r=10 relue a -1,60 %, soit la seule tessellation du
          // lecteur). Un export que le logiciel ne sait pas relire lui-meme
          // n'est pas un export.
          // La norme l'autorise explicitement : la fiche « Body CSG Geometry »
          // d'IFC4 ADD2 pose Items = IfcCsgSolid, puis ajoute « the Items
          // IfcBooleanResult and IfcPrimitive3D shall also be allowed for
          // compatibility with previous releases ».
          const isp = place(par.ctr);          // origine = CENTRE de la sphere
          item = E(); W("IFCSPHERE(#"+isp+","+f(par.r)+")");
          repType = 'CSG';
        }
        if(item){
          // _style() consomme des numeros d'entite : l'appeler AVANT E(), sinon
          // le E() ci-dessous est deja perime quand W() l'utilise et l'entite
          // sort sous un mauvais numero. La couleur partait a la poubelle.
          const iSty = _style(st.hex, st.a);
          E(); W("IFCSTYLEDITEM(#"+item+",(#"+iSty+"),$)");
          nStyled++;
          _emitProduct(so, oi, [item], repType);
          nParam++;
          return;   // geo n'a pas ete cuite : le finally n'a rien a liberer
        }
      }

      geo = _stepBake(so);
      const pos = geo && geo.attributes && geo.attributes.position;
      if(!pos || !pos.count){ nEmpty++; return; }
      const idx = geo.index ? geo.index.array : null;
      const triCount = (idx ? idx.length : pos.count) / 3;
      if(triCount < 1){ nEmpty++; return; }
      if(pos.itemSize !== 3 || !Number.isInteger(triCount))
        throw new Error('invalid triangle geometry');
      // Reject malformed data instead of letting the STEP real writer turn
      // NaN / Infinity into zero and silently deform a body.
      for(let v=0;v<pos.count;v++)
        if(!Number.isFinite(pos.getX(v)) || !Number.isFinite(pos.getY(v)) || !Number.isFinite(pos.getZ(v)))
          throw new Error('non-finite vertex coordinates');
      if(idx) for(const v of idx)
        if(!Number.isInteger(v) || v < 0 || v >= pos.count) throw new Error('triangle index outside vertex list');

      // materiau par triangle (groups de three.js), sinon un seul groupe
      const pal = (typeof _stepFacePalette === 'function') ? _stepFacePalette(so) : null;
      const base = { hex: _stepHexOf(so),
                     a: _stepAlpha(Array.isArray(so.mesh.material)?so.mesh.material[0]:so.mesh.material, so) };
      const matOf = new Int32Array(triCount);
      if(pal && geo.groups && geo.groups.length){
        for(const gr of geo.groups){
          const s = Math.max(0, Math.floor(gr.start/3)), e = Math.min(triCount, Math.floor((gr.start+gr.count)/3));
          for(let t=s;t<e;t++) matOf[t] = gr.materialIndex|0;
        }
      }

      // ── SOUDER OU NON : la question n'a pas de reponse unique ───────────
      // Un cube de Three.js porte 24 sommets pour 8 coins — ses faces sont
      // separees pour que les normales soient dures. Sans soudure, aucune arete
      // ne se paire et le cube sort « ouvert ».
      // Mais la chaine de reparation de MEDUSA DESOUDE volontairement les
      // contacts (unweldContacts) pour que deux pieces qui se touchent restent
      // deux pieces. Souder par coordonnees les recolle et fabrique des aretes a
      // quatre triangles.
      // Mesure sur AC20-Institute-Var-2 : souder sans discernement faisait
      // tomber 1054 corps fermes a 951. Les deux regles simples sont donc
      // fausses chacune dans un sens.
      // On ne choisit pas a priori : on construit les deux indexations et on
      // garde celle qui laisse le MOINS d'aretes mal appariees. A egalite, la
      // soudee — elle donne un fichier plus petit.
      const buildWelded = () => {
        const map = new Map(), px=[], py=[], pz=[], tri=new Int32Array(triCount*3);
        for(let t=0;t<triCount;t++) for(let e=0;e<3;e++){
          const vi = idx ? idx[t*3+e] : t*3+e;
          const c = cv(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
          const k = q(c[0])+','+q(c[1])+','+q(c[2]);
          let n = map.get(k);
          if(n === undefined){ px.push(c[0]); py.push(c[1]); pz.push(c[2]); n = px.length; map.set(k,n); }
          tri[t*3+e] = n;
        }
        return {px, py, pz, tri};
      };
      const buildRaw = () => {
        const n = pos.count, px=new Array(n), py=new Array(n), pz=new Array(n);
        for(let i=0;i<n;i++){ const c = cv(pos.getX(i), pos.getY(i), pos.getZ(i)); px[i]=c[0]; py[i]=c[1]; pz[i]=c[2]; }
        const tri = new Int32Array(triCount*3);
        for(let i=0;i<triCount*3;i++) tri[i] = idx[i] + 1;   // CoordIndex est 1-based
        return {px, py, pz, tri};
      };
      // Aretes mal appariees : tout ce qui n'est pas partage par exactement deux
      // triangles — bord libre comme jonction non-manifold.
      const badEdges = (tri) => {
        if(tri.length/3 > CLOSED_LIMIT) return -1;           // trop gros : on ne juge pas
        const par = new Map();
        for(let t=0;t<tri.length;t+=3){
          const v0=tri[t], v1=tri[t+1], v2=tri[t+2];
          if(v0===v1||v1===v2||v0===v2) continue;
          const pairs = [[v0,v1],[v1,v2],[v2,v0]];
          for(const [a,b] of pairs){
            // String keys remain exact beyond 2^21 vertices; multiplication
            // by 2^32 otherwise exceeds JavaScript's safe integer range.
            const k = a<b ? a+','+b : b+','+a;
            par.set(k, (par.get(k)||0)+1);
          }
        }
        let bad = 0;
        for(const c of par.values()) if(c!==2) bad++;
        return bad;
      };

      let build = buildWelded();
      let badW = badEdges(build.tri);
      if(idx && badW !== 0){
        const raw = buildRaw();
        const badR = badEdges(raw.tri);
        if(badR >= 0 && badW >= 0 && badR < badW){ build = raw; badW = badR; nKeptRaw++; }
      }
      const px = build.px, py = build.py, pz = build.pz, T = build.tri;

      const byMat = new Map();
      let degen = 0;
      for(let t=0;t<triCount;t++){
        const a = T[t*3], b = T[t*3+1], c = T[t*3+2];
        if(a===b || b===c || a===c){ degen++; continue; }   // triangle ecrase par la soudure
        const m = matOf[t];
        let arr = byMat.get(m);
        if(!arr){ arr = []; byMat.set(m, arr); }
        arr.push(a,b,c);
      }
      if(!px.length || !byMat.size){ nEmpty++; return; }

      // IfcCartesianPointList3D : UNE entite pour tout le nuage de points du
      // corps, partagee par tous ses jeux de faces.
      const coords = new Array(px.length);
      for(let i=0;i<px.length;i++) coords[i] = '('+f(px[i])+','+f(py[i])+','+f(pz[i])+')';
      // IFC4 has CoordList only. TagList (the second argument) is IFC4x3.
      const iPL = E(); W("IFCCARTESIANPOINTLIST3D(("+coords.join(',')+"))");

      const items = [];
      byMat.forEach((tri, m) => {
        // Closed : calcule quand c'est raisonnable, '$' sinon. Une arete
        // partagee par exactement deux triangles partout = coque fermee.
        let closed = '$';
        const nt = tri.length/3;
        // Un seul groupe : la topologie du groupe EST celle du corps, et
        // badEdges vient de la mesurer. Plusieurs groupes : chaque jeu de faces
        // n'est qu'un morceau de la peau, donc ouvert — et c'est exact, la
        // norme demande si CE jeu borne un volume, pas si le corps en borne un.
        const bad = (byMat.size === 1) ? badW : badEdges(tri);
        if(bad < 0) nUnknown++;
        else { closed = bad ? '.F.' : '.T.'; if(bad) nOpen++; else nClosed++; }

        const ci = new Array(nt);
        for(let t=0,k=0;t<tri.length;t+=3,k++) ci[k] = '('+tri[t]+','+tri[t+1]+','+tri[t+2]+')';
        const iFS = E(); W("IFCTRIANGULATEDFACESET(#"+iPL+",$,"+closed+",("+ci.join(',')+"),$)");
        items.push(iFS);
        nFaceSets++; nTris += nt;

        const st = (pal && pal[m]) ? pal[m] : base;
        const iSty = _style(st.hex, st.a);
        E(); W("IFCSTYLEDITEM(#"+iFS+",(#"+iSty+"),$)");
        nStyled++;
      });

      const nm = so.name || ('Body '+(oi+1));
      _emitProduct(so, oi, items, 'Tessellation');
      if(degen) nasLog('INFO','IFC export: '+nm+' — '+degen+' degenerate triangle(s) dropped by welding');
      } catch(e) {
        throw new Error('IFC export: '+((so && so.name)||('Body '+(oi+1)))+' — '+e.message);
      } finally {
        if(geo && geo.dispose) geo.dispose();
      }
    });

    if(!elemIds.length){
      nasLog('WARN','IFC export: nothing to write — no body carried triangles');
      return opts.returnText ? '' : undefined;
    }
    // C'est CETTE relation qui range les corps dans le modele. Sans elle, un
    // lecteur les trouve dans le fichier mais ne les montre dans aucun arbre.
    E(); W("IFCRELCONTAINEDINSPATIALSTRUCTURE("+G()+",#"+iOwn+",$,$,"+R(elemIds)+",#"+iSto+")");

    if(_stepStr.truncated)
      nasLog('WARN','IFC export: '+_stepStr.truncated+' name(s) shortened — ISO 10303-21 forbids lines over 256 characters and a string cannot be split');
    if(nUnknown)
      nasLog('INFO','IFC export: '+nUnknown+' face set(s) over '+CLOSED_LIMIT+' triangles — Closed left unset rather than guessed');
    if(nEmpty)
      nasLog('WARN','IFC export: '+nEmpty+' object(s) had no triangle and were skipped');
    if(nKeptRaw)
      nasLog('INFO','IFC export: '+nKeptRaw+' body(ies) kept their original vertex splitting — welding would have created non-manifold edges');

    const nObj = source.length;
    const ifc = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('"+_stepStr('ViewDefinition [ReferenceView_V1.2]')+"'),'2;1');",
      "FILE_NAME('model.ifc','"+now+"',('NassLab'),(''),'NASSCAD V"+(globalThis.NASSCAD_VERSION||'4.7.0')+"','NASSCAD V"+(globalThis.NASSCAD_VERSION||'4.7.0')+"','');",
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;','DATA;',
      '/* NASSCAD V'+(globalThis.NASSCAD_VERSION||'4.7.0')+' - nasscad.com - '+nObj+' objects - '+nBody+' elements - '+
        (nParam?nParam+' exact (SweptSolid/CSG) - ':'')+
        nFaceSets+' IfcTriangulatedFaceSet - '+nTris+' triangles - '+styleCache.size+' styles'+
        (nClosed?' - '+nClosed+' closed':'')+(nOpen?' / '+nOpen+' open':'')+
        ' - IFC4'+(nParam?' parametric + tessellated':' tessellated')+' */',
      ...L.map(s=>_stepFold(s,72)),
      'ENDSEC;','END-ISO-10303-21;',''
    ].join('\n');

    const kb = (ifc.length/1024).toFixed(1);
    if(opts.returnText) return ifc;
    if(cfg.logStats !== false)
      nasLog('OK','Export IFC4'+(nParam?' parametric+tessellated':' tessellated')+' — '+nObj+' obj — '+nBody+' elements'+
        (nParam?' — '+nParam+' exact':'')+' — '+nFaceSets+' face sets — '+
        nTris+' tris — '+styleCache.size+' styles'+(nClosed?' — '+nClosed+' closed':'')+(nOpen?' / '+nOpen+' open':'')+
        ' — '+kb+' KB — '+Math.round(performance.now()-t0)+'ms');
    await _nasStepSave('model.ifc', new Blob([ifc],{type:'application/x-step'}), opts.fileHandle||null);
  } finally {
    if(!opts.silent) hideSpinner();
  }
}

// Front-door. Le picker DOIT etre ouvert pendant le clic (fenetre user-gesture
// ~1 s), donc avant le calcul — meme contrainte que doStepExport().
async function expIFC(){
  if(!objs.length){ nasLog('WARN','Export IFC: nothing in the scene'); return; }
  let fh = null;
  if(window.showSaveFilePicker && !(window.electronAPI && window.electronAPI.isElectron)){
    try{
      fh = await window.showSaveFilePicker({
        suggestedName: 'model.ifc',
        types: [{description:'IFC (BIM)', accept:{'application/x-step':['.ifc']}}]
      });
    }catch(e){
      if(e && e.name === 'AbortError'){ nasLog('INFO','Export cancelled'); return; }
      fh = null;                                     // API refusee : repli download
    }
  }
  try { return await _expIFCRun(null, {fileHandle: fh}); }
  catch(e){ nasLog('ERROR', e && e.message ? e.message : String(e)); }
}
